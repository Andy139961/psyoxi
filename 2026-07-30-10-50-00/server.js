'use strict';

/**
 * 跨网多人打仗游戏 - 后端服务器
 * 纯 Node.js 实现（HTTP 静态服务 + 极简 WebSocket 服务），无外部依赖。
 *
 * 特性：
 *  - 开房间：生成 8 位房间号；选房间：输入房间号加入
 *  - 2~7 人，人满提示；房主到入房顺序决定回合顺序
 *  - 开局每人 50000 元；做生意/收税赚钱；买不同兵种（血量/攻击/价格不同）
 *  - 回合制：每人每轮 3 个动作，之后轮到下一家
 *  - 地图：每个玩家一个同等大小的省，省含郡，郡含县；可缩放/平移（不计动作、不影响他人）
 *  - 占领：进攻相邻省，兵力(攻击力之和)大于守方即可占领，双方消耗士兵
 *  - 拥有 10 个省可结算：按 钱 → 省数 → 士兵数 排名
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------------------
// 游戏配置
// ---------------------------------------------------------------------------
const SOLDIER_TYPES = {
  militia:  { name: '民兵', hp: 50,  atk: 10, price: 1000 },
  infantry: { name: '步兵', hp: 100, atk: 25, price: 2500 },
  cavalry:  { name: '骑兵', hp: 130, atk: 45, price: 4500 },
  archer:   { name: '弓兵', hp: 80,  atk: 30, price: 3000 },
  heavy:    { name: '重甲', hp: 220, atk: 40, price: 6500 },
};
const START_MONEY = 50000;
const ACTIONS_PER_TURN = 3;
const WIN_POINTS = 50;            // 积分达到 50 可发起计分
const POINTS_PER_SIEGE = 2;       // 每次攻城成功 +2 积分
const EXCHANGE_COST = 10000;      // 换积分花费
const EXCHANGE_POINTS = 3;        // 换积分所得
const START_GRACE_MS = 30000;     // 房主点开始后，宽限 30s 仍可进房，之后才真正开局

// 玩家颜色（与前端 common.js 保持一致）
const PALETTE = ['#ff8c42', '#4aa3ff', '#8fe3a0', '#e36aa0', '#e3c76a', '#9a7bff', '#5ad6c8'];
function colorIndexOf(order) { return PALETTE[order % PALETTE.length]; }

const PROVINCE_NAMES = [
  '冀州','兖州','青州','徐州','扬州','荆州','豫州','益州','雍州','凉州',
  '并州','交州','幽州','司隶','江州','湘州','闽州','赣州','皖州','浙州',
  '鲁州','燕州','秦州','蜀州','吴州','越州','朔州','营州','平州','宁州',
  '广州','桂州','黔州','滇州','陇州','河州','汾州','潞州','海州','云州',
];

const PREF_SUFFIX = ['东郡','西郡','南郡','北郡','中郡','上郡','下郡','左郡','右郡'];
const COUNTY_SUFFIX = ['阳','阴','平','安','宁','兴','和','靖','泰','昌','康','定','丰','乐','嘉'];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function emptyGarrison() { const g = {}; for (const k in SOLDIER_TYPES) g[k] = 0; return g; }
function power(g) { let p = 0; for (const t in g) p += g[t] * SOLDIER_TYPES[t].atk; return p; }
function headcount(g) { let n = 0; for (const t in g) n += g[t]; return n; }

// 按攻击力从高到低消耗兵力（amount 为需消耗的攻击力值）
function consumePower(g, amount) {
  const order = Object.keys(SOLDIER_TYPES).sort((a, b) => SOLDIER_TYPES[b].atk - SOLDIER_TYPES[a].atk);
  let remaining = amount;
  for (const t of order) {
    while (g[t] > 0 && remaining > 0) {
      g[t]--;
      remaining -= SOLDIER_TYPES[t].atk;
    }
    if (remaining <= 0) break;
  }
  return g;
}

function genRoomId(rooms) {
  let id;
  do { id = String(randInt(10000000, 99999999)); } while (rooms.has(id));
  return id;
}

function genPlayerId() { return crypto.randomBytes(6).toString('hex'); }

// ---------------------------------------------------------------------------
// 地图生成
// ---------------------------------------------------------------------------
function generateMap(playerIds) {
  const cols = 7, rows = 5;
  const cell = 120;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        c, r,
        x: c * cell + 80 + randInt(-30, 30),
        y: r * cell + 80 + randInt(-30, 30),
      });
    }
  }
  // 最远点采样选起始省，保证彼此不挨在一起
  const starts = [cells[randInt(0, cells.length - 1)]];
  while (starts.length < playerIds.length) {
    let best = null, bestD = -1;
    for (const cell of cells) {
      if (starts.includes(cell)) continue;
      let minD = Infinity;
      for (const s of starts) {
        const d = Math.hypot(cell.x - s.x, cell.y - s.y);
        if (d < minD) minD = d;
      }
      if (minD > bestD) { bestD = minD; best = cell; }
    }
    starts.push(best);
  }

  const provinces = [];
  let nameIdx = 0;
  cells.forEach((cell, i) => {
    const isStart = starts.includes(cell);
    const startIdx = isStart ? starts.indexOf(cell) : -1;
    const owner = isStart ? playerIds[startIdx] : null;
    const name = PROVINCE_NAMES[nameIdx % PROVINCE_NAMES.length] + (nameIdx >= PROVINCE_NAMES.length ? (Math.floor(nameIdx / PROVINCE_NAMES.length) + 1) : '');
    nameIdx++;

    const prefectures = [];
    const pCount = randInt(2, 4);
    for (let p = 0; p < pCount; p++) {
      const counties = [];
      const cCount = randInt(2, 4);
      for (let c = 0; c < cCount; c++) {
        counties.push({
          id: `p${i}_pf${p}_c${c}`,
          name: COUNTY_SUFFIX[randInt(0, COUNTY_SUFFIX.length - 1)] + '县',
          owner: owner,
          garrison: emptyGarrison(),
        });
      }
      prefectures.push({
        id: `p${i}_pf${p}`,
        name: PREF_SUFFIX[randInt(0, PREF_SUFFIX.length - 1)],
        owner: owner,
        garrison: emptyGarrison(),
        counties,
      });
    }

    provinces.push({
      id: `p${i}`,
      name,
      x: cell.x,
      y: cell.y,
      owner: owner,
      garrison: isStart
        ? Object.assign(emptyGarrison(), { militia: 30 })
        : Object.assign(emptyGarrison(), { militia: randInt(12, 40) }),
      prefectures,
      adj: [],
    });
  });

  // 计算相邻（距离阈值）
  const TH = 165;
  for (let a = 0; a < provinces.length; a++) {
    for (let b = a + 1; b < provinces.length; b++) {
      const d = Math.hypot(provinces[a].x - provinces[b].x, provinces[a].y - provinces[b].y);
      if (d < TH) {
        provinces[a].adj.push(provinces[b].id);
        provinces[b].adj.push(provinces[a].id);
      }
    }
  }
  return { provinces };
}

// ---------------------------------------------------------------------------
// 房间 / 游戏状态
// ---------------------------------------------------------------------------
const rooms = new Map();

function makePlayer(id, name, isHost) {
  return { id, name: name || '玩家', isHost, money: 0, points: 0, connected: true, socket: null, order: 0 };
}

function provincesOwnedBy(room, pid) {
  if (!room.map) return 0;
  return room.map.provinces.filter(p => p.owner === pid).length;
}
function totalSoldiersOf(room, pid) {
  if (!room.map) return 0;
  let n = 0;
  for (const p of room.map.provinces) if (p.owner === pid) n += headcount(p.garrison);
  return n;
}

function setSubOwners(province, owner) {
  for (const pf of province.prefectures) {
    pf.owner = owner;
    for (const c of pf.counties) c.owner = owner;
  }
}

function publicState(room) {
  const players = room.order.map(pid => {
    const p = room.players.get(pid);
    return {
      id: p.id, name: p.name, order: p.order, isHost: p.isHost,
      connected: p.connected, money: p.money, points: p.points,
      provincesOwned: provincesOwnedBy(room, p.id),
      soldiers: totalSoldiersOf(room, p.id),
    };
  });
  return {
    roomId: room.id,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    gameState: room.gameState,
    startAt: room.startAt || null,
    players,
    currentPlayerId: room.currentPlayerId,
    actionsLeft: room.actionsLeft,
    turnOrder: room.order,
    winnerEligible: room.winnerEligible,
    map: room.map,
    log: room.log.slice(-40),
    soldierTypes: SOLDIER_TYPES,
  };
}

function broadcast(room) {
  const state = publicState(room);
  for (const pid of room.order) {
    const p = room.players.get(pid);
    if (p.socket && p.connected) sendFrame(p.socket, JSON.stringify({ type: 'state', state }));
  }
}

// 解散房间：通知所有在线玩家后删除
function cancelRoom(room, reason) {
  if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
  const payload = JSON.stringify({ type: 'roomCancelled', message: reason || '房间已解散' });
  for (const pid of room.order) {
    const p = room.players.get(pid);
    if (p.socket && p.connected) sendFrame(p.socket, payload);
  }
  rooms.delete(room.id);
}

// 真正开局：生成地图、发钱、设定回合顺序。仅在 starting 状态下由倒计时或房主“立即开始”触发
function actuallyStart(room) {
  if (room.gameState !== 'starting') return;
  if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
  if (room.order.length < 2) {
    // 宽限期内人数掉到不足，取消开局、回到大厅
    room.gameState = 'lobby';
    room.startAt = null;
    logMsg(room, '人数不足 2 人，开局取消，回到大厅。');
    broadcast(room);
    return;
  }
  room.map = generateMap(room.order);
  for (const pid of room.order) {
    const p = room.players.get(pid);
    p.money = START_MONEY;
    p.points = 0;
    p.order = room.order.indexOf(pid);
  }
  room.gameState = 'playing';
  room.startAt = null;
  room.turnIndex = 0;
  room.currentPlayerId = room.order[0];
  room.actionsLeft = ACTIONS_PER_TURN;
  room.winnerEligible = false;
  logMsg(room, '游戏开始！每人初始资金 ¥50000，每轮 3 个动作。攻城成功 +2 积分，¥10000 换 3 积分，积分满 50 可发起计分。');
  broadcast(room);
}

// 大厅阶段非房主离开：将其移出房间
function removePlayerFromRoom(room, player) {
  room.players.delete(player.id);
  room.order = room.order.filter(id => id !== player.id);
  room.order.forEach((id, i) => { room.players.get(id).order = i; });
  if (room.order.length === 0) { rooms.delete(room.id); return; }
  logMsg(room, `${player.name} 离开了房间`);
  broadcast(room);
}

function logMsg(room, msg) {
  room.log.push(msg);
  if (room.log.length > 200) room.log.shift();
}

function checkWinnerEligible(room) {
  for (const pid of room.order) {
    if (room.players.get(pid).points >= WIN_POINTS) { room.winnerEligible = true; return; }
  }
}

function advanceTurn(room) {
  // 找到下一个已连接的玩家
  let idx = room.turnIndex;
  for (let i = 0; i < room.order.length; i++) {
    idx = (idx + 1) % room.order.length;
    const p = room.players.get(room.order[idx]);
    if (p.connected) { room.turnIndex = idx; room.currentPlayerId = room.order[idx]; room.actionsLeft = ACTIONS_PER_TURN; return; }
  }
}

// ---------------------------------------------------------------------------
// 动作处理
// ---------------------------------------------------------------------------
function handleAction(room, player, action) {
  if (room.gameState !== 'playing') return { error: '游戏未在进行中' };
  if (room.currentPlayerId !== player.id) return { error: '还没轮到你' };
  if (room.actionsLeft <= 0) return { error: '本回合动作已用完' };

  const a = action || {};
  let used = true;

  if (a.type === 'business') {
    const inc = randInt(2000, 6000);
    player.money += inc;
    logMsg(room, `${player.name} 做生意赚得 ¥${inc}`);
  } else if (a.type === 'tax') {
    const owned = provincesOwnedBy(room, player.id);
    const inc = 600 * owned + 500;
    player.money += inc;
    logMsg(room, `${player.name} 收税获得 ¥${inc}（${owned} 个省）`);
  } else if (a.type === 'buy') {
    const prov = room.map.provinces.find(p => p.id === a.provinceId);
    if (!prov || prov.owner !== player.id) return { error: '只能向自己的省驻兵' };
    const st = SOLDIER_TYPES[a.soldierType];
    const count = Math.max(1, Math.floor(a.count || 1));
    if (!st) return { error: '未知兵种' };
    const cost = st.price * count;
    if (player.money < cost) return { error: '钱不够' };
    player.money -= cost;
    prov.garrison[a.soldierType] += count;
    logMsg(room, `${player.name} 在 ${prov.name} 购买 ${st.name}×${count}`);
  } else if (a.type === 'move') {
    const from = room.map.provinces.find(p => p.id === a.fromId);
    const to = room.map.provinces.find(p => p.id === a.toId);
    if (!from || !to) return { error: '省份不存在' };
    if (from.owner !== player.id || to.owner !== player.id) return { error: '只能调动到自己拥有的省' };
    const count = Math.max(1, Math.floor(a.count || 1));
    const avail = headcount(from.garrison);
    if (count > avail) return { error: '该省兵力不足' };
    // 按攻击力从低到高搬运，保留高价值兵种
    const order = Object.keys(SOLDIER_TYPES).sort((x, y) => SOLDIER_TYPES[x].atk - SOLDIER_TYPES[y].atk);
    let left = count;
    for (const t of order) {
      while (from.garrison[t] > 0 && left > 0) { from.garrison[t]--; to.garrison[t]++; left--; }
      if (left <= 0) break;
    }
    logMsg(room, `${player.name} 从 ${from.name} 调动 ${count} 兵到 ${to.name}`);
  } else if (a.type === 'attack') {
    const from = room.map.provinces.find(p => p.id === a.fromId);
    const to = room.map.provinces.find(p => p.id === a.toId);
    if (!from || !to) return { error: '省份不存在' };
    if (from.owner !== player.id) return { error: '只能从自己的省出兵' };
    if (to.owner === player.id) return { error: '不能进攻自己的省' };
    if (!from.adj.includes(to.id)) return { error: '目标省不相邻' };
    const A = power(from.garrison);
    const D = power(to.garrison);
    const attackers = Object.assign(emptyGarrison(), from.garrison);
    from.garrison = emptyGarrison();
    if (A > D) {
      consumePower(attackers, D);
      const oldOwner = to.owner;
      to.owner = player.id;
      to.garrison = attackers;
      setSubOwners(to, player.id);
      player.points += POINTS_PER_SIEGE;
      logMsg(room, `${player.name} 从 ${from.name} 攻占 ${to.name}（原守军${oldOwner ? '玩家' : '中立'}），+${POINTS_PER_SIEGE} 积分`);
    } else {
      consumePower(to.garrison, A);
      logMsg(room, `${player.name} 进攻 ${to.name} 失败，双方损耗兵力`);
    }
  } else if (a.type === 'exchange') {
    if (player.money < EXCHANGE_COST) return { error: `钱不够（需 ¥${EXCHANGE_COST}）` };
    player.money -= EXCHANGE_COST;
    player.points += EXCHANGE_POINTS;
    logMsg(room, `${player.name} 花费 ¥${EXCHANGE_COST} 兑换 ${EXCHANGE_POINTS} 积分`);
  } else if (a.type === 'endTurn') {
    used = false; // 结束回合不算消耗
  } else {
    return { error: '未知动作' };
  }

  if (used) room.actionsLeft--;
  if (room.actionsLeft <= 0) advanceTurn(room);
  checkWinnerEligible(room);
  return null;
}

function settle(room) {
  const ranked = room.order.map(pid => {
    const p = room.players.get(pid);
    return {
      id: p.id, name: p.name, money: p.money,
      provincesOwned: provincesOwnedBy(room, pid),
      soldiers: totalSoldiersOf(room, pid),
    };
  });
  ranked.sort((a, b) => b.points - a.points || b.money - a.money || b.provincesOwned - a.provincesOwned || b.soldiers - a.soldiers);
  // 并列名次
  let rank = 0, prev = null;
  ranked.forEach((r, i) => {
    const key = `${r.money}|${r.provincesOwned}|${r.soldiers}`;
    if (key !== prev) { rank = i + 1; prev = key; }
    r.rank = rank;
  });
  room.gameState = 'ended';
  return ranked;
}

// ---------------------------------------------------------------------------
// 极简 WebSocket 服务
// ---------------------------------------------------------------------------
function sendFrame(socket, data) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81; // FIN + text
  try { socket.write(Buffer.concat([header, payload])); } catch (e) { /* ignore */ }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  const room = socket.__room;

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); offset = 10; }
      let mask;
      if (masked) { if (buf.length < offset + 4) break; mask = buf.slice(offset, offset + 4); offset += 4; }
      if (buf.length < offset + len) break;
      let payload = buf.slice(offset, offset + len);
      if (masked) { for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
      buf = buf.slice(offset + len);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) { // ping -> pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        socket.write(pong);
        continue;
      }
      if (opcode === 0x1) {
        try { onMessage(socket, payload.toString('utf8')); } catch (e) { console.error('msg err', e); }
      }
    }
  });

  socket.on('close', () => onClose(socket));
  socket.on('error', () => onClose(socket));
}

function onClose(socket) {
  const room = socket.__room;
  const player = socket.__player;
  if (!room || !player) return;
  player.connected = false;
  player.socket = null;
  logMsg(room, `${player.name} 掉线`);
  // 大厅 / 开局倒计时阶段房主掉线：宽限 10s，未重连则直接解散房间
  if ((room.gameState === 'lobby' || room.gameState === 'starting') && room.hostId === player.id) {
    player.cleanupTimer = setTimeout(() => {
      if (player.connected || !rooms.has(room.id)) return;
      cancelRoom(room, `${player.name}（房主）掉线，房间已解散`);
    }, 10000);
    broadcast(room);
    return;
  }
  // 其余情况：房主掉线则转移给其他在线玩家
  if (room.hostId === player.id && room.gameState !== 'ended' && room.gameState !== 'starting') {
    const next = room.order.find(id => id !== player.id && room.players.get(id).connected);
    if (next) { room.hostId = next; room.players.get(next).isHost = true; logMsg(room, `${room.players.get(next).name} 成为新房主`); }
  }
  // lobby / 开局倒计时阶段：断开 30s 仍未重连则移出房间（释放名额）
  if ((room.gameState === 'lobby' || room.gameState === 'starting') && !player.cleanupTimer) {
    player.cleanupTimer = setTimeout(() => {
      if (player.connected || !rooms.has(room.id)) return;
      room.players.delete(player.id);
      room.order = room.order.filter(id => id !== player.id);
      room.order.forEach((id, i) => { room.players.get(id).order = i; });
      if (room.hostId === player.id && room.order.length) {
        room.hostId = room.order[0]; room.players.get(room.order[0]).isHost = true;
      }
      logMsg(room, `${player.name} 离开房间`);
      broadcast(room);
    }, 30000);
  }
  // playing 阶段：当前玩家掉线，延迟 15s 未重连才推进回合（避免刷新/切页误伤）
  if (room.gameState === 'playing' && room.currentPlayerId === player.id && !player.cleanupTimer) {
    player.cleanupTimer = setTimeout(() => {
      if (player.connected || !rooms.has(room.id)) return;
      advanceTurn(room);
      broadcast(room);
    }, 15000);
  }
  broadcast(room);
}

function onMessage(socket, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }

  // 建房 / 选房：此时 socket 尚未绑定 room/player，需优先处理
  if (msg.type === 'createRoom') {
    const max = Math.min(7, Math.max(2, Math.floor(msg.maxPlayers || 2)));
    const id = genRoomId(rooms);
    const pid = genPlayerId();
    const pl = makePlayer(pid, msg.playerName, true);
    pl.socket = socket;
    const newRoom = {
      id, maxPlayers: max, hostId: pid, gameState: 'lobby',
      players: new Map([[pid, pl]]), order: [pid],
      turnIndex: 0, currentPlayerId: pid, actionsLeft: ACTIONS_PER_TURN,
      map: null, log: [], winnerEligible: false, startAt: null, startTimer: null,
    };
    rooms.set(id, newRoom);
    socket.__room = newRoom; socket.__player = pl;
    sendFrame(socket, JSON.stringify({ type: 'roomCreated', roomId: id, playerId: pid, state: publicState(newRoom) }));
    return;
  }

  if (msg.type === 'joinRoom') {
    const r = rooms.get(String(msg.roomId || '').trim());
    if (!r) { sendFrame(socket, JSON.stringify({ type: 'error', message: '该房间不存在' })); return; }
    if (r.gameState !== 'lobby' && r.gameState !== 'starting') { sendFrame(socket, JSON.stringify({ type: 'error', message: '游戏已开始，无法加入' })); return; }
    if (r.order.length >= r.maxPlayers) { sendFrame(socket, JSON.stringify({ type: 'error', message: '人满了' })); return; }
    const pid = genPlayerId();
    const pl = makePlayer(pid, msg.playerName, false);
    pl.socket = socket; pl.order = r.order.length;
    r.players.set(pid, pl);
    r.order.push(pid);
    socket.__room = r; socket.__player = pl;
    sendFrame(socket, JSON.stringify({ type: 'joined', roomId: r.id, playerId: pid, state: publicState(r) }));
    broadcast(r);
    return;
  }

  // 重连：多页跳转 / 刷新后，用 roomId + playerId 恢复同一玩家身份
  if (msg.type === 'rejoin') {
    const r = rooms.get(String(msg.roomId || '').trim());
    if (!r) { sendFrame(socket, JSON.stringify({ type: 'error', message: '该房间不存在或已结束' })); return; }
    const pid = String(msg.playerId || '').trim();
    const pl = r.players.get(pid);
    if (!pl) {
      // 兜底：lobby/starting 且未满，作为新玩家加入
      if ((r.gameState === 'lobby' || r.gameState === 'starting') && r.order.length < r.maxPlayers) {
        const np = makePlayer(genPlayerId(), msg.playerName || '玩家', false);
        np.socket = socket; np.order = r.order.length;
        r.players.set(np.id, np); r.order.push(np.id);
        socket.__room = r; socket.__player = np;
        sendFrame(socket, JSON.stringify({ type: 'joined', roomId: r.id, playerId: np.id, state: publicState(r) }));
        broadcast(r);
      } else {
        sendFrame(socket, JSON.stringify({ type: 'error', message: '无法重新加入该房间' }));
      }
      return;
    }
    // 恢复已有玩家
    pl.socket = socket; pl.connected = true;
    if (pl.cleanupTimer) { clearTimeout(pl.cleanupTimer); pl.cleanupTimer = null; }
    socket.__room = r; socket.__player = pl;
    logMsg(r, `${pl.name} 重新连入`);
    sendFrame(socket, JSON.stringify({ type: 'rejoined', playerId: pid, state: publicState(r) }));
    broadcast(r);
    return;
  }

  // 以下消息需要已绑定的 room / player
  const room = socket.__room;
  const player = socket.__player;
  if (!room || !player) return;

  // 聊天：所有玩家可发消息，消息会广播给房间内所有人（前端渲染为弹幕）
  if (msg.type === 'chat') {
    let text = String(msg.text || '').trim().slice(0, 120);
    if (!text) return;
    const payload = JSON.stringify({
      type: 'chat',
      name: player.name,
      color: colorIndexOf(player.order),
      text,
      ts: Date.now(),
    });
    for (const pid of room.order) {
      const p = room.players.get(pid);
      if (p.socket && p.connected) sendFrame(p.socket, payload);
    }
    return;
  }

  // 离开房间：房主离开则解散整个房间
  if (msg.type === 'leaveRoom') {
    if (player.isHost) {
      cancelRoom(room, `${player.name}（房主）已退出，房间已解散`);
    } else if (room.gameState === 'lobby' || room.gameState === 'starting') {
      removePlayerFromRoom(room, player);
    } else {
      // 对战中非房主离开：标记离线，游戏继续
      player.connected = false; player.socket = null;
      logMsg(room, `${player.name} 离开了游戏`);
      broadcast(room);
    }
    return;
  }

  if (msg.type === 'startGame') {
    if (!player.isHost) { sendFrame(socket, JSON.stringify({ type: 'error', message: '只有房主可以开始' })); return; }
    // 已处于倒计时状态：房主再次点击 = 立即开始
    if (room.gameState === 'starting') {
      clearTimeout(room.startTimer);
      actuallyStart(room);
      return;
    }
    if (room.gameState !== 'lobby') return;
    if (room.order.length < 2) { sendFrame(socket, JSON.stringify({ type: 'error', message: '至少需要 2 人' })); return; }
    // 进入“开局倒计时”状态：宽限期内迟到玩家仍可加入
    room.gameState = 'starting';
    room.startAt = Date.now() + START_GRACE_MS;
    logMsg(room, `房主发起开局，${Math.round(START_GRACE_MS / 1000)} 秒内仍可加入，倒计时结束正式开始。`);
    room.startTimer = setTimeout(() => actuallyStart(room), START_GRACE_MS);
    broadcast(room);
    return;
  }

  if (msg.type === 'action') {
    const err = handleAction(room, player, msg.action);
    if (err) { sendFrame(socket, JSON.stringify({ type: 'error', message: err.error })); return; }
    broadcast(room);
    return;
  }

  if (msg.type === 'settle') {
    if (!room.winnerEligible) { sendFrame(socket, JSON.stringify({ type: 'error', message: '尚无人积分达到 50，不能结算' })); return; }
    const ranked = settle(room);
    for (const pid of room.order) {
      const p = room.players.get(pid);
      if (p.socket) sendFrame(p.socket, JSON.stringify({ type: 'gameOver', rankings: ranked }));
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// HTTP 静态服务
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, `http://${req.headers.host}`).pathname; } catch (e) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => handleUpgrade(req, socket));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`战争游戏服务器已启动: http://0.0.0.0:${PORT}`);
});

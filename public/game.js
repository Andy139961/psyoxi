'use strict';

// ===========================================================================
// 对战页：地图 / 行动 / 详情 / 战报 / 结算
// ===========================================================================
const U = window.U;
const { $, colorOf, power, headcount, toast, cam } = U;
let selectedId = null;
let mapInit = false;

function provById(id) { return state.map.provinces.find(p => p.id === id); }
function myProvinces() { return state.map.provinces.filter(p => p.owner === myId); }

// ---- 网络回调 ----
function onRoom(msg) { state = msg.state; SOLDIER_TYPES = state.soldierTypes || {}; renderGame(); }
function onState(msg) {
  state = msg.state;
  SOLDIER_TYPES = state.soldierTypes || SOLDIER_TYPES;
  if (state.gameState === 'lobby') { location.href = 'lobby.html'; return; }
  renderGame();
}
function onError(message) { toast(message); }
function onGameOver(msg) { showRanking(msg.rankings); }
function onChat(msg) { appendChat(msg.name, msg.color, msg.text); spawnDanmaku(msg.name, msg.color, msg.text); }
function onRoomCancelled(msg) {
  Session.clear();
  alert(msg.message || '房间已解散');
  location.href = 'index.html';
}

// ---- 渲染 ----
function renderGame() {
  const me = state.players.find(p => p.id === myId);
  const cur = state.players.find(p => p.id === state.currentPlayerId);
  $('turn-player').textContent = cur ? `轮到：${cur.name}` : '—';
  $('turn-player').style.color = cur ? colorOf(cur.id) : '#ffd479';
  $('turn-actions').textContent = `动作 ${state.actionsLeft}/3`;
  $('my-money').textContent = me ? me.money : 0;
  $('my-points').textContent = me ? me.points : 0;
  $('my-prov').textContent = me ? me.provincesOwned : 0;
  $('my-sold').textContent = me ? me.soldiers : 0;

  const myTurn = state.gameState === 'playing' && state.currentPlayerId === myId;
  document.querySelectorAll('.act-btn').forEach(b => { b.disabled = !myTurn; });
  $('btn-settle').classList.toggle('hidden', !state.winnerEligible);

  renderDetail();
  renderLog();
  if (!mapInit) { fitMap(); mapInit = true; }
  drawMap();
}

function renderLog() {
  const box = $('log');
  box.innerHTML = '';
  (state.log || []).forEach(line => {
    const d = document.createElement('div');
    d.textContent = line;
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
}

function renderDetail() {
  const box = $('detail');
  if (!selectedId) { box.innerHTML = '<p class="muted">点击地图上的省份查看详情。</p>'; return; }
  const p = provById(selectedId);
  if (!p) { box.innerHTML = '<p class="muted">—</p>'; return; }
  const ownerName = p.owner ? (state.players.find(x => x.id === p.owner) || {}).name : '中立';
  const ownedByMe = p.owner === myId;
  const tagColor = colorOf(p.owner);
  let army = '';
  for (const t in p.garrison) if (p.garrison[t] > 0) army += `${SOLDIER_TYPES[t] ? SOLDIER_TYPES[t].name : t}×${p.garrison[t]} `;
  const pw = power(p.garrison);
  let pf = '';
  p.prefectures.forEach(pr => {
    const sub = pr.counties.map(c => `${c.name}${c.owner === myId ? '★' : ''}`).join('、');
    pf += `<div class="sub">· ${pr.name}（${pr.counties.length}县）：${sub}</div>`;
  });

  let actions = '';
  if (ownedByMe) {
    actions = `<button class="mini" onclick="UI.buy('${p.id}')">买兵</button>
               <button class="mini" onclick="UI.move('${p.id}')">调动</button>
               <button class="mini" onclick="UI.attack('${p.id}')">进攻邻省</button>`;
  } else {
    const adjMine = myProvinces().filter(m => m.adj.includes(p.id));
    if (adjMine.length) actions = `<button class="mini" onclick="UI.attack('${p.id}')">从此进攻</button>`;
  }

  box.innerHTML = `
    <h3>${p.name}</h3>
    <div class="sub">归属：<span class="own-tag" style="background:${tagColor};color:#1b2430">${ownerName}</span></div>
    <div class="army-line">兵力(攻击力)：${pw} ｜ 驻军：${army || '无'}</div>
    <div class="sub" style="margin-top:8px">下辖 ${p.prefectures.length} 郡：</div>
    ${pf}
    <div>${actions}</div>`;
}

// ---- Canvas 地图 ----
function setupCanvas() {
  const cv = $('map');
  const wrap = cv.parentElement;
  cv.width = wrap.clientWidth;
  cv.height = wrap.clientHeight;
}
function fitMap() {
  setupCanvas();
  const ps = state.map.provinces;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ps.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
  const cv = $('map');
  const w = maxX - minX, h = maxY - minY;
  const s = Math.min(cv.width / (w + 200), cv.height / (h + 200));
  cam.scale = Math.max(0.4, Math.min(2, s));
  cam.x = cv.width / 2 - ((minX + maxX) / 2) * cam.scale;
  cam.y = cv.height / 2 - ((minY + maxY) / 2) * cam.scale;
}

function drawMap() {
  const cv = $('map');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const R = 34 * cam.scale;
  ctx.strokeStyle = 'rgba(120,140,160,.18)';
  ctx.lineWidth = 1;
  state.map.provinces.forEach(p => {
    const sx = p.x * cam.scale + cam.x, sy = p.y * cam.scale + cam.y;
    p.adj.forEach(nid => {
      const n = provById(nid); if (!n || n.id < p.id) return;
      const nx = n.x * cam.scale + cam.x, ny = n.y * cam.scale + cam.y;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(nx, ny); ctx.stroke();
    });
  });
  state.map.provinces.forEach(p => {
    const sx = p.x * cam.scale + cam.x, sy = p.y * cam.scale + cam.y;
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(p.owner);
    ctx.globalAlpha = p.owner ? 0.85 : 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = (selectedId === p.id) ? 4 : 2;
    ctx.strokeStyle = (selectedId === p.id) ? '#fff' : '#0d141c';
    ctx.stroke();
    ctx.fillStyle = '#0d141c';
    ctx.font = `${Math.max(11, 13 * cam.scale)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.name, sx, sy);
    if (headcount(p.garrison) > 0) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(9, 10 * cam.scale)}px sans-serif`;
      ctx.fillText('⚔' + headcount(p.garrison), sx, sy + R * 0.62);
    }
  });
}

function canvasPos(e) {
  const cv = $('map');
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function initMapEvents() {
  const cv = $('map');
  let dragging = false, moved = false, last = null;
  cv.addEventListener('mousedown', (e) => { dragging = true; moved = false; last = canvasPos(e); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const p = canvasPos(e);
    const dx = p.x - last.x, dy = p.y - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    cam.x += dx; cam.y += dy; last = p;
    if (state && state.map) drawMap();
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragging) return; dragging = false;
    if (!moved && state && state.map) {
      const p = canvasPos(e);
      const R = 34 * cam.scale;
      let hit = null;
      for (const prov of state.map.provinces) {
        const sx = prov.x * cam.scale + cam.x, sy = prov.y * cam.scale + cam.y;
        if (Math.hypot(sx - p.x, sy - p.y) < R) { hit = prov; break; }
      }
      selectedId = hit ? hit.id : null;
      renderDetail(); drawMap();
    }
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state || !state.map) return;
    const p = canvasPos(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.max(0.3, Math.min(3, cam.scale * factor));
    const wx = (p.x - cam.x) / cam.scale, wy = (p.y - cam.y) / cam.scale;
    cam.scale = ns;
    cam.x = p.x - wx * ns; cam.y = p.y - wy * ns;
    drawMap();
  }, { passive: false });
  window.addEventListener('resize', () => { if (state && state.map) { setupCanvas(); drawMap(); } });
}

// ---- 动作 ----
function doAction(action) { Net.send({ type: 'action', action }); }

const UI = {
  buy(provId) {
    provId = provId || selectedId;
    const p = provId && provById(provId);
    if (!p || p.owner !== myId) { toast('请选择你自己的省'); return; }
    const me = state.players.find(x => x.id === myId);
    let opts = '';
    for (const t in SOLDIER_TYPES) opts += `<option value="${t}">${SOLDIER_TYPES[t].name}（攻${SOLDIER_TYPES[t].atk}/血${SOLDIER_TYPES[t].hp}） ¥${SOLDIER_TYPES[t].price}</option>`;
    openModal(`
      <h3>买士兵 → ${p.name}</h3>
      <label>兵种<select id="m-type">${opts}</select></label>
      <label>数量<input id="m-count" type="number" min="1" value="1" /></label>
      <div class="row"><button class="opt" onclick="UI._buyConfirm('${p.id}')">确认购买</button></div>
      <p class="muted" style="margin-top:8px">你的资金：¥${me.money}</p>`);
  },
  _buyConfirm(provId) {
    const t = $('m-type').value, c = Math.max(1, parseInt($('m-count').value) || 1);
    doAction({ type: 'buy', provinceId: provId, soldierType: t, count: c });
    closeModal();
  },
  move(srcId) {
    srcId = srcId || selectedId;
    const src = srcId && provById(srcId);
    if (!src || src.owner !== myId) { toast('请选择你自己的省作为出发省'); return; }
    const mine = myProvinces().filter(m => m.id !== srcId);
    if (!mine.length) { toast('没有其他可调动的省'); return; }
    let opts = mine.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    openModal(`
      <h3>调动士兵：从 ${src.name}</h3>
      <label>目标省<select id="m-dest">${opts}</select></label>
      <label>数量（最多 ${headcount(src.garrison)}）<input id="m-count" type="number" min="1" value="1" /></label>
      <div class="row"><button class="opt" onclick="UI._moveConfirm('${srcId}')">确认调动</button></div>`);
  },
  _moveConfirm(srcId) {
    const to = $('m-dest').value, c = Math.max(1, parseInt($('m-count').value) || 1);
    doAction({ type: 'move', fromId: srcId, toId: to, count: c });
    closeModal();
  },
  attack(selId) {
    selId = selId || selectedId;
    let pairs = [];
    state.map.provinces.forEach(p => {
      if (p.owner !== myId) return;
      p.adj.forEach(nid => {
        const n = provById(nid);
        if (n && n.owner !== myId) pairs.push({ from: p, to: n });
      });
    });
    if (selId) pairs = pairs.filter(pr => pr.from.id === selId || pr.to.id === selId);
    if (!pairs.length) { toast('没有可进攻的目标（需与你的省相邻）'); return; }
    let html = '<h3>进攻 / 占领</h3>';
    pairs.forEach((pr) => {
      html += `<button class="opt" onclick="UI._attackConfirm('${pr.from.id}','${pr.to.id}')">
        从 ${pr.from.name} 攻 ${pr.to.name}（我方 ${power(pr.from.garrison)} vs 守军 ${power(pr.to.garrison)}）</button>`;
    });
    openModal(html);
  },
  _attackConfirm(fromId, toId) {
    doAction({ type: 'attack', fromId, toId });
    closeModal();
  },
};
window.UI = UI;

// ---- 聊天 / 弹幕 ----
const CHAT_MAX = 60;
function appendChat(name, color, text) {
  const box = $('chat-history');
  const line = document.createElement('div');
  line.className = 'chat-line';
  const who = document.createElement('span');
  who.className = 'who';
  who.style.color = color || '#ffd479';
  who.textContent = name + '：';
  line.appendChild(who);
  line.appendChild(document.createTextNode(text)); // textContent 防 XSS
  box.appendChild(line);
  while (box.children.length > CHAT_MAX) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function spawnDanmaku(name, color, text) {
  const layer = $('danmaku-layer');
  const el = document.createElement('div');
  el.className = 'danmaku-item';
  const who = document.createElement('span');
  who.style.color = color || '#ffd479';
  who.textContent = name + '：';
  el.appendChild(who);
  el.appendChild(document.createTextNode(text));
  const top = 60 + Math.random() * (window.innerHeight - 160);
  el.style.top = top + 'px';
  const dur = 7 + Math.random() * 4; // 7~11 秒
  el.style.animation = `danmaku-fly ${dur}s linear forwards`;
  layer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}
function openModal(html) { $('modal-content').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); }

function showRanking(rankings) {
  let html = '<h3>最终计分排名</h3><div class="rank-list">';
  rankings.forEach(r => {
    html += `<div class="rank-row"><span class="rk">${r.rank}</span>
      <span class="nm">${r.name}</span>
      <span class="sc">⭐${r.points} 分 ｜ 💰${r.money} ｜ 🏯${r.provincesOwned}省 ｜ ⚔${r.soldiers}兵</span></div>`;
  });
  html += '</div>';
  openModal(html);
}

// ---- 事件绑定 ----
function bindUI() {
  document.querySelectorAll('.act-btn').forEach(b => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'business') doAction({ type: 'business' });
      else if (act === 'tax') doAction({ type: 'tax' });
      else if (act === 'exchange') doAction({ type: 'exchange' });
      else if (act === 'endTurn') doAction({ type: 'endTurn' });
      else if (act === 'buy') UI.buy();
      else if (act === 'move') UI.move();
      else if (act === 'attack') UI.attack();
    };
  });
  $('btn-settle').onclick = () => {
    if (!confirm('确认发起计分？游戏将结束并按积分排名。')) return;
    Net.send({ type: 'settle' });
  };
  $('btn-leave-game').onclick = () => {
    const me = state && state.players && state.players.find(p => p.id === myId);
    const warn = (me && me.isHost) ? '你是房主，退出将解散整个房间，确定吗？' : '确定退出对战吗？';
    if (!confirm(warn)) return;
    Net.send({ type: 'leaveRoom' });
    Session.clear();
    location.href = 'index.html';
  };
  $('modal-close').onclick = closeModal;
  const bar = $('chat-bar');
  if (bar) bar.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = (input.value || '').trim();
    if (!text) return;
    Net.send({ type: 'chat', text });
    input.value = '';
    input.blur();
  });
}

window.addEventListener('load', () => {
  bindUI();
  initMapEvents();
  const s = Session.load();
  if (!s || !s.roomId || !s.playerId) {
    // 直接打开对战页但无会话 → 回大厅
    location.href = 'lobby.html';
    return;
  }
  Net.connect({ onRoom, onState, onError, onGameOver, onChat, onRoomCancelled });
});

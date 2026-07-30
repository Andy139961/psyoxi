'use strict';

// 大厅页逻辑：建房 / 选房 / 大厅列表 / 开局跳转
const U = window.U;

function showJoin() { $('join-card').classList.remove('hidden'); $('lobby-card').classList.add('hidden'); }
function showLobby() { $('join-card').classList.add('hidden'); $('lobby-card').classList.remove('hidden'); }

function onRoom(msg) {
  const st = msg.state;
  $('lobby-roomid').textContent = st.roomId;
  renderLobby(st);
  showLobby();
  // 建房成功：弹出醒目的房间号
  if (msg.type === 'roomCreated') showRoomPop(st.roomId);
  else if (msg.type === 'joined') U.toast('已加入房间 ' + st.roomId);
  // 重连时发现旧对局仍在进行/刚结束，先问用户是否继续，避免自动跳页
  if (msg.type === 'rejoined' && (st.gameState === 'playing' || st.gameState === 'ended')) {
    showResumePop(st.roomId);
  }
}

function showRoomPop(rid) {
  $('pop-roomnum').textContent = rid;
  $('room-pop').classList.remove('hidden');
}
function showResumePop(rid) {
  $('resume-roomnum').textContent = rid;
  $('resume-pop').classList.remove('hidden');
}
function hideResumePop() {
  $('resume-pop').classList.add('hidden');
}

function onState(msg) {
  const st = msg.state;
  if (st.gameState === 'playing') {
    // 房主点击开始后会收到 playing 状态 → 跳转对战页
    location.href = 'game.html';
    return;
  }
  renderLobby(st);
}

function onError(message) { U.toast(message); }

function onRoomCancelled(msg) {
  Session.clear();
  U.toast(msg.message || '房间已解散');
  setTimeout(() => { location.href = 'index.html'; }, 900);
}

function renderLobby(st) {
  state = st;
  const list = $('lobby-players');
  list.innerHTML = '';
  st.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const me = p.id === myId;
    row.innerHTML = `<span>${p.name}${me ? '（你）' : ''} ${p.connected ? '' : '<i class="off">离线</i>'}</span>
      <span class="order">第 ${p.order + 1} 位</span>
      ${p.isHost ? '<span class="badge">房主</span>' : ''}`;
    list.appendChild(row);
  });
  const me = st.players.find(p => p.id === myId);
  const host = !!(me && me.isHost);
  $('btn-begin').classList.toggle('hidden', !host);
  if (st.gameState === 'starting') {
    $('btn-begin').textContent = '立即开始';
    startCountdown(st.startAt);
    $('lobby-tip').textContent = `开局倒计时中，迟到玩家仍可加入！人数 ${st.players.length}/${st.maxPlayers}`;
  } else {
    $('btn-begin').textContent = '开始对战';
    stopCountdown();
    $('lobby-count').classList.add('hidden');
    $('lobby-tip').textContent = `人数 ${st.players.length}/${st.maxPlayers} · 房主开房后开始，回合按房主到入房顺序`;
  }
}

let countTimer = null;
function startCountdown(startAt) {
  stopCountdown();
  const tick = () => {
    const left = Math.max(0, Math.ceil((startAt - Date.now()) / 1000));
    $('lobby-count').classList.remove('hidden');
    $('lobby-count').textContent = `⏳ 距正式开局还有 ${left} 秒，仍可加入`;
    if (left <= 0) stopCountdown();
  };
  tick();
  countTimer = setInterval(tick, 500);
}
function stopCountdown() { if (countTimer) { clearInterval(countTimer); countTimer = null; } }

function bindUI() {
  $('tab-create').onclick = () => { $('tab-create').classList.add('active'); $('tab-join').classList.remove('active'); $('panel-create').classList.remove('hidden'); $('panel-joinroom').classList.add('hidden'); };
  $('tab-join').onclick = () => { $('tab-join').classList.add('active'); $('tab-create').classList.remove('active'); $('panel-joinroom').classList.remove('hidden'); $('panel-create').classList.add('hidden'); };

  $('btn-create').onclick = () => {
    const name = $('create-name').value.trim() || '房主';
    const max = parseInt($('create-max').value);
    Net.send({ type: 'createRoom', playerName: name, maxPlayers: max });
  };
  $('btn-join').onclick = () => {
    const name = $('join-name').value.trim() || '玩家';
    const rid = $('join-room').value.trim();
    if (rid.length !== 8 || !/^\d+$/.test(rid)) { U.toast('请输入 8 位数字房间号'); return; }
    Net.send({ type: 'joinRoom', playerName: name, roomId: rid });
  };

  $('btn-begin').onclick = () => Net.send({ type: 'startGame' });
  $('btn-leave').onclick = () => {
    const me = state && state.players.find(p => p.id === myId);
    const warn = (me && me.isHost) ? '你是房主，离开将解散整个房间，确定吗？' : '确定离开房间吗？';
    if (!confirm(warn)) return;
    Net.send({ type: 'leaveRoom' });
    Session.clear();
    location.href = 'index.html';
  };
  $('btn-copy').onclick = () => {
    const rid = $('lobby-roomid').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(rid).then(() => U.toast('已复制房间号')); else U.toast(rid);
  };
  $('pop-copy').onclick = () => {
    const rid = $('pop-roomnum').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(rid).then(() => U.toast('已复制房间号')); else U.toast(rid);
  };
  $('pop-close').onclick = () => $('room-pop').classList.add('hidden');

  $('resume-continue').onclick = () => { hideResumePop(); location.href = 'game.html'; };
  $('resume-leave').onclick = () => {
    hideResumePop();
    Session.clear();
    showJoin();
    U.toast('已离开旧对局，可以开新房间或加入其他房间');
  };
}

window.addEventListener('load', () => {
  bindUI();
  // 若已有会话先展示大厅骨架，连接后 rejoin 会刷新
  const s = Session.load();
  if (s && s.roomId && s.playerId) showLobby();
  Net.connect({ onRoom, onState, onError, onRoomCancelled });
});

'use strict';

// ===========================================================================
// 通用模块：WebSocket（含自动重连）、房间会话、工具函数
// 供 index / lobby / game 三个页面共用。
// ===========================================================================

const PALETTE = ['#ff8c42', '#4aa3ff', '#8fe3a0', '#e36aa0', '#e3c76a', '#9a7bff', '#5ad6c8'];

// ---- 全局共享状态 ----
let ws = null;
let myId = null;
let state = null;
let SOLDIER_TYPES = {};
const cam = { scale: 1, x: 0, y: 0 };
let _handlers = {};

// ---- 工具 ----
function $(id) { return document.getElementById(id); }
function colorOf(pid) {
  if (!pid) return '#5a6b7a';
  const p = state && state.players.find(x => x.id === pid);
  if (!p) return '#5a6b7a';
  return PALETTE[p.order % PALETTE.length];
}
function power(g) { let s = 0; for (const t in g) s += g[t] * (SOLDIER_TYPES[t] ? SOLDIER_TYPES[t].atk : 0); return s; }
function headcount(g) { let n = 0; for (const t in g) n += g[t]; return n; }

function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast hidden'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---- 会话（sessionStorage 记录房号 / 玩家ID / 昵称）----
const Session = {
  save(roomId, playerId, name) {
    try { sessionStorage.setItem('zgame', JSON.stringify({ roomId, playerId, name })); } catch (e) {}
  },
  load() {
    try { return JSON.parse(sessionStorage.getItem('zgame') || 'null'); } catch (e) { return null; }
  },
  clear() {
    try { sessionStorage.removeItem('zgame'); } catch (e) {}
  },
};

// ---- WebSocket 连接（含自动重连）----
function connect(handlers) {
  _handlers = handlers || {};
  const host = location.host || 'localhost:3000';
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + host;
  ws = new WebSocket(url);
  ws.onopen = () => {
    if (_handlers.onOpen) _handlers.onOpen();
    // 若已有会话，自动重连回房间
    const s = Session.load();
    if (s && s.roomId && s.playerId) {
      send({ type: 'rejoin', roomId: s.roomId, playerId: s.playerId, playerName: s.name });
    }
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleServer(msg);
  };
  ws.onclose = () => { if (_handlers.onClose) _handlers.onClose(); };
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function handleServer(msg) {
  if (msg.type === 'roomCreated' || msg.type === 'joined') {
    myId = msg.playerId;
    state = msg.state;
    Session.save(msg.roomId, msg.playerId, (state.players.find(p => p.id === myId) || {}).name);
    if (_handlers.onRoom) _handlers.onRoom(msg);
  } else if (msg.type === 'rejoined') {
    myId = msg.playerId;
    state = msg.state;
    if (_handlers.onRoom) _handlers.onRoom(msg);
  } else if (msg.type === 'error') {
    if (_handlers.onError) _handlers.onError(msg.message); else toast(msg.message);
  } else if (msg.type === 'state') {
    state = msg.state;
    SOLDIER_TYPES = state.soldierTypes || SOLDIER_TYPES;
    if (_handlers.onState) _handlers.onState(msg);
  } else if (msg.type === 'gameOver') {
    if (_handlers.onGameOver) _handlers.onGameOver(msg);
  } else if (msg.type === 'chat') {
    if (_handlers.onChat) _handlers.onChat(msg);
  } else if (msg.type === 'roomCancelled') {
    if (_handlers.onRoomCancelled) _handlers.onRoomCancelled(msg);
  }
}

// 暴露到全局（各页面内联脚本使用）
window.Net = { connect, send, get ws() { return ws; }, get state() { return state; }, get myId() { return myId; }, get SOLDIER_TYPES() { return SOLDIER_TYPES; } };
window.Session = Session;
window.U = { $, colorOf, power, headcount, toast, cam };

// ─── Zone.io — client ─────────────────────────────────────────────────────────
'use strict';

const socket = io();

// ─── Session state ────────────────────────────────────────────────────────────
let myId      = null;
let players   = {};
let grid      = null;
let gridSize  = 100;
let zone      = { cx: 50, cy: 50, radius: 70 };
let isRanked  = true;
let isTeam    = false;
let zoneCountdown  = 30;
let zoneIntervalId = null;

// ─── Canvas / camera ─────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
const CELL   = 16;
let cam = { x: 0, y: 0 };

// ─── Colour helpers ───────────────────────────────────────────────────────────
// A stable palette for up to 24 team IDs (solo players each get a unique ID).
const PALETTE = [
  '#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63',
  '#00bcd4','#ff5722','#8bc34a','#673ab7',
  '#ff6b81','#70a1ff','#7bed9f','#ffa502',
  '#a29bfe','#00cec9','#fd79a8','#fdcb6e',
  '#6c5ce7','#00b894','#d63031','#0984e3',
];

function tColor(id) {
  return PALETTE[(id - 1) % PALETTE.length] || '#aaa';
}
function tTerrColor(id) {
  // Darker version of base colour
  const c = tColor(id);
  return c + '99'; // semi-transparent over dark bg – let CSS engine handle it
}

// Pre-compute darker territory fill using canvas context
const _terrCache = {};
function terrFill(id) {
  if (_terrCache[id]) return _terrCache[id];
  const base = tColor(id);
  // Darken by blending with black at ~55%
  const r = parseInt(base.slice(1,3),16);
  const g = parseInt(base.slice(3,5),16);
  const b = parseInt(base.slice(5,7),16);
  const dr = Math.round(r * 0.45).toString(16).padStart(2,'0');
  const dg = Math.round(g * 0.45).toString(16).padStart(2,'0');
  const db = Math.round(b * 0.45).toString(16).padStart(2,'0');
  _terrCache[id] = `#${dr}${dg}${db}`;
  return _terrCache[id];
}
const _trailCache = {};
function trailFill(id) {
  if (_trailCache[id]) return _trailCache[id];
  const base = tColor(id);
  const r = parseInt(base.slice(1,3),16);
  const g = parseInt(base.slice(3,5),16);
  const b = parseInt(base.slice(5,7),16);
  const lr = Math.min(255, Math.round(r * 1.3)).toString(16).padStart(2,'0');
  const lg = Math.min(255, Math.round(g * 1.3)).toString(16).padStart(2,'0');
  const lb = Math.min(255, Math.round(b * 1.3)).toString(16).padStart(2,'0');
  _trailCache[id] = `#${lr}${lg}${lb}`;
  return _trailCache[id];
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const loginScreen   = document.getElementById('loginScreen');
const modeScreen    = document.getElementById('modeScreen');
const gameScreen    = document.getElementById('gameScreen');
const nameInput     = document.getElementById('nameInput');
const nextBtn       = document.getElementById('nextBtn');
const backBtn       = document.getElementById('backBtn');
const modeGreeting  = document.getElementById('modeGreeting');
const modeCards     = document.querySelectorAll('.mode-card');
const eloDisplay    = document.getElementById('eloDisplay');
const teamDisplay   = document.getElementById('teamDisplay');
const modeBadge     = document.getElementById('modeBadge');
const zoneTimerVal  = document.getElementById('zoneTimerVal');
const lbRows        = document.getElementById('lbRows');
const waitingOverlay  = document.getElementById('waitingOverlay');
const waitingTeamName = document.getElementById('waitingTeamName');
const waitingRoomLabel= document.getElementById('waitingRoomLabel');
const deathOverlay  = document.getElementById('deathOverlay');
const deathMsg      = document.getElementById('deathMsg');

let playerName = '';

// ─── Screen flow ──────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

nextBtn.addEventListener('click', () => {
  playerName = nameInput.value.trim() || `P${Math.floor(Math.random() * 999)}`;
  modeGreeting.textContent = `Hello, ${playerName}!`;
  showScreen('modeScreen');
});
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nextBtn.click(); });

backBtn.addEventListener('click', () => showScreen('loginScreen'));

// ─── Mode card selection ──────────────────────────────────────────────────────
modeCards.forEach(card => {
  card.addEventListener('click', () => {
    const mode   = card.dataset.mode;
    const ranked = card.dataset.ranked === 'true';
    socket.emit('join', { name: playerName, mode, ranked });
  });
});

// ─── Resize ───────────────────────────────────────────────────────────────────
function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Input ────────────────────────────────────────────────────────────────────
let lastDir = 'right';
function sendDir(dir) {
  if (!myId || !players[myId]?.alive) return;
  if (dir === lastDir) return;
  lastDir = dir;
  socket.emit('direction', dir);
}

window.addEventListener('keydown', e => {
  switch (e.key) {
    case 'ArrowUp':    case 'w': case 'W': sendDir('up');    break;
    case 'ArrowDown':  case 's': case 'S': sendDir('down');  break;
    case 'ArrowLeft':  case 'a': case 'A': sendDir('left');  break;
    case 'ArrowRight': case 'd': case 'D': sendDir('right'); break;
  }
});

document.querySelectorAll('.dp-btn').forEach(btn => {
  btn.addEventListener('touchstart', e => { e.preventDefault(); sendDir(btn.dataset.dir); }, { passive: false });
  btn.addEventListener('click', () => sendDir(btn.dataset.dir));
});

let swipeX = 0, swipeY = 0;
canvas.addEventListener('touchstart', e => { swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY; }, { passive: true });
canvas.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  if (Math.abs(dx) > 20 || Math.abs(dy) > 20)
    sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
}, { passive: true });

// ─── Zone countdown ───────────────────────────────────────────────────────────
function startZoneCountdown(ms) {
  clearInterval(zoneIntervalId);
  zoneCountdown = Math.round(ms / 1000);
  zoneTimerVal.textContent = zoneCountdown;
  zoneIntervalId = setInterval(() => {
    zoneCountdown = Math.max(0, zoneCountdown - 1);
    zoneTimerVal.textContent = zoneCountdown;
  }, 1000);
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
const TEAM_NAMES_TEAM_MODE = { 1: 'Red', 2: 'Blue', 3: 'Green', 4: 'Gold' };

function updateHUD() {
  const me = players[myId];
  if (!me) return;

  if (isRanked) {
    eloDisplay.textContent = `ELO: ${me.elo}`;
    eloDisplay.style.display = '';
  } else {
    eloDisplay.style.display = 'none';
  }

  const teamLabel = isTeam
    ? (TEAM_NAMES_TEAM_MODE[me.team] || `Team ${me.team}`)
    : 'Solo';
  teamDisplay.textContent  = `${teamLabel}`;
  teamDisplay.style.color  = tColor(me.team);
}

function setupModeBadge() {
  modeBadge.textContent = isRanked ? '⚡ RANKED' : '🎮 CHILL';
  modeBadge.className   = `mode-hud-badge ${isRanked ? 'ranked' : 'chill'}`;
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────
function updateLeaderboard() {
  const teamCells = {};
  for (let i = 0; i < grid.length; i++) {
    const t = grid[i];
    if (t > 0) teamCells[t] = (teamCells[t] || 0) + 1;
  }

  const list = Object.values(players)
    .filter(p => p.alive && !p.waiting)
    .map(p => ({ ...p, cells: teamCells[p.team] || 0 }))
    .sort((a, b) => b.cells - a.cells || b.elo - a.elo)
    .slice(0, 8);

  lbRows.innerHTML = list.map((p, i) => `
    <div class="lb-row${p.id === myId ? ' is-me' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-dot" style="background:${tColor(p.team)}"></span>
      <span class="lb-name" style="color:${tColor(p.team)}">${esc(p.name)}</span>
      <span class="lb-cells">${p.cells}</span>
      ${isRanked ? `<span class="lb-elo">${p.elo}</span>` : ''}
    </div>`).join('');
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('init', data => {
  myId      = data.playerId;
  gridSize  = data.gridSize;
  grid      = new Uint8Array(data.grid);
  players   = data.players;
  zone      = data.zone;
  isRanked  = data.isRanked;
  isTeam    = data.isTeam;

  // Center camera
  const me = players[myId];
  if (me && me.alive) {
    cam.x = me.x * CELL - canvas.width  / 2 + CELL / 2;
    cam.y = me.y * CELL - canvas.height / 2 + CELL / 2;
  }

  // Apply chill body class
  document.body.classList.toggle('chill-mode', !isRanked);

  startZoneCountdown(data.timeToShrink);
  setupModeBadge();
  showScreen('gameScreen');
  requestAnimationFrame(renderLoop);

  if (data.waitingForTeammate) {
    // Show waiting overlay
    const teamName = TEAM_NAMES_TEAM_MODE[me?.team] || `Team ${me?.team}`;
    const roomLabel = data.isRanked ? 'Team 2v2 Ranked' : 'Team 2v2 Chill';
    waitingTeamName.textContent  = teamName;
    waitingRoomLabel.textContent = roomLabel;
    waitingOverlay.classList.remove('hidden');
  }

  updateHUD();
});

socket.on('tick', data => {
  players = data.players;
  zone    = data.zone;
  for (const { i, t } of data.dirty) grid[i] = t;
  startZoneCountdown(data.timeToShrink);
  updateHUD();
  updateLeaderboard();
});

socket.on('zoneUpdate', data => {
  zone = data.zone;
  startZoneCountdown(data.timeToShrink);
});

socket.on('playerJoined', p => { players[p.id] = p; });
socket.on('playerLeft',   d => { delete players[d.id]; });

socket.on('teammateJoined', data => {
  waitingOverlay.classList.add('hidden');
  // Small toast notification
  showToast(`🛡 ${data.name} joined your team!`, tColor(players[myId]?.team || 1));
  lastDir = 'right';
});

socket.on('died', data => {
  const eloText = isRanked ? `  ELO: ${data.elo}` : '';
  deathMsg.textContent = data.killedBy === 'zone'
    ? `Eliminated by the safe-zone!${eloText}`
    : `Eliminated by ${data.killedBy}!${eloText}`;
  deathOverlay.classList.remove('hidden');
  lastDir = 'right';
});

socket.on('respawned', () => {
  deathOverlay.classList.add('hidden');
});

// ─── Toast notification ───────────────────────────────────────────────────────
function showToast(msg, color = '#3498db') {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', top: '80px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.85)', border: `1px solid ${color}`,
    color: '#fff', padding: '10px 20px', borderRadius: '30px',
    fontSize: '14px', fontWeight: '600', zIndex: '300',
    transition: 'opacity .4s', opacity: '1', whiteSpace: 'nowrap',
    boxShadow: `0 0 14px ${color}55`,
  });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2500);
}

// ─── Camera ───────────────────────────────────────────────────────────────────
function updateCamera() {
  const me = players[myId];
  if (!me || !me.alive) return;
  const tx = me.x * CELL - canvas.width  / 2 + CELL / 2;
  const ty = me.y * CELL - canvas.height / 2 + CELL / 2;
  cam.x += (tx - cam.x) * 0.12;
  cam.y += (ty - cam.y) * 0.12;
}

// ─── Minimap ─────────────────────────────────────────────────────────────────
const miniCanvas = document.createElement('canvas');
const miniCtx    = miniCanvas.getContext('2d');
const MINI       = 150;
miniCanvas.width = miniCanvas.height = MINI;

function drawMinimap(W, H) {
  const PAD = 10, cpx = MINI / gridSize;
  const ox = W - MINI - PAD, oy = H - MINI - PAD;

  const imgData = miniCtx.createImageData(MINI, MINI);
  const d = imgData.data;
  for (let k = 0; k < d.length; k += 4) { d[k]=14; d[k+1]=16; d[k+2]=38; d[k+3]=200; }

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const t = grid[gy * gridSize + gx];
      if (!t) continue;
      const col = tColor(t);
      const r = parseInt(col.slice(1,3),16);
      const g = parseInt(col.slice(3,5),16);
      const b = parseInt(col.slice(5,7),16);
      const mx = Math.floor(gx * cpx), my = Math.floor(gy * cpx);
      const mw = Math.max(1, Math.ceil(cpx)), mh = Math.max(1, Math.ceil(cpx));
      for (let dy = 0; dy < mh; dy++) for (let dx = 0; dx < mw; dx++) {
        const px = mx+dx, py = my+dy;
        if (px >= MINI || py >= MINI) continue;
        const k = (py * MINI + px) * 4;
        d[k]=r; d[k+1]=g; d[k+2]=b; d[k+3]=220;
      }
    }
  }
  miniCtx.putImageData(imgData, 0, 0);

  if (zone.radius > 0) {
    miniCtx.strokeStyle = '#e74c3c'; miniCtx.lineWidth = 1;
    miniCtx.beginPath();
    miniCtx.arc(zone.cx * cpx, zone.cy * cpx, zone.radius * cpx, 0, Math.PI*2);
    miniCtx.stroke();
  }

  for (const p of Object.values(players)) {
    if (!p.alive || p.waiting) continue;
    miniCtx.fillStyle = tColor(p.team);
    miniCtx.beginPath();
    miniCtx.arc(p.x * cpx, p.y * cpx, p.id === myId ? 3 : 2, 0, Math.PI*2);
    miniCtx.fill();
    if (p.id === myId) {
      miniCtx.strokeStyle = '#fff'; miniCtx.lineWidth = 1; miniCtx.stroke();
    }
  }

  ctx.drawImage(miniCanvas, ox, oy);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
  ctx.strokeRect(ox, oy, MINI, MINI);
}

// ─── Main render ─────────────────────────────────────────────────────────────
function renderLoop() { updateCamera(); drawFrame(); requestAnimationFrame(renderLoop); }

function drawFrame() {
  const W = canvas.width, H = canvas.height;

  ctx.save();
  ctx.translate(-cam.x, -cam.y);

  const x0 = Math.max(0, Math.floor(cam.x / CELL) - 1);
  const y0 = Math.max(0, Math.floor(cam.y / CELL) - 1);
  const x1 = Math.min(gridSize, Math.ceil((cam.x + W) / CELL) + 2);
  const y1 = Math.min(gridSize, Math.ceil((cam.y + H) / CELL) + 2);

  // Background
  ctx.fillStyle = '#0e1026';
  ctx.fillRect(0, 0, gridSize * CELL, gridSize * CELL);

  // Territory
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = grid[y * gridSize + x];
      if (t > 0) {
        ctx.fillStyle = terrFill(t);
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.025)'; ctx.lineWidth = 0.5;
  for (let x = x0; x <= x1; x++) {
    ctx.beginPath(); ctx.moveTo(x*CELL, y0*CELL); ctx.lineTo(x*CELL, y1*CELL); ctx.stroke();
  }
  for (let y = y0; y <= y1; y++) {
    ctx.beginPath(); ctx.moveTo(x0*CELL, y*CELL); ctx.lineTo(x1*CELL, y*CELL); ctx.stroke();
  }

  // Trails
  for (const p of Object.values(players)) {
    if (!p.alive || !p.trail?.length || p.waiting) continue;
    ctx.fillStyle = trailFill(p.team);
    for (const c of p.trail) {
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      ctx.fillRect(c.x * CELL + 3, c.y * CELL + 3, CELL - 6, CELL - 6);
    }
  }

  // Players
  for (const p of Object.values(players)) {
    if (!p.alive || p.waiting) continue;
    const px = p.x * CELL + CELL / 2;
    const py = p.y * CELL + CELL / 2;
    const r  = CELL / 2 - 1;

    ctx.shadowColor = tColor(p.team);
    ctx.shadowBlur  = p.id === myId ? 14 : 6;
    ctx.fillStyle   = tColor(p.team);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();

    if (p.id === myId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.shadowBlur = 0;

    // Name tag
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(p.name, px, py - r - 2);

    // Team buddy indicator (team mode)
    if (isTeam && p.id !== myId && players[myId] && p.team === players[myId].team) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '8px Arial'; ctx.textBaseline = 'top';
      ctx.fillText('ally', px, py + r + 2);
    }
  }

  // Zone – danger overlay outside zone
  const zx = zone.cx * CELL, zy = zone.cy * CELL, zr = zone.radius * CELL;
  if (zr > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, gridSize * CELL, gridSize * CELL);
    ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(180,0,0,0.2)';
    ctx.fill('evenodd');
    ctx.restore();

    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 3;
    ctx.setLineDash([12, 6]);
    ctx.beginPath(); ctx.arc(zx, zy, zr, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Map border
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, gridSize * CELL, gridSize * CELL);

  ctx.restore();

  drawMinimap(W, H);
}

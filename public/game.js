// ─── Zone.io – client ─────────────────────────────────────────────────────────
'use strict';

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let myId = null;
let players = {};
let grid = null;          // Uint8Array flat, row-major
let gridSize = 100;
let zone = { cx: 50, cy: 50, radius: 70 };
let teams = {};
let connected = false;

// ─── Canvas / camera ─────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
const CELL   = 16;   // px per grid cell

let cam = { x: 0, y: 0 };   // world-space top-left pixel of viewport

// ─── ELO countdown ───────────────────────────────────────────────────────────
let zoneCountdown = 30;
let zoneIntervalId = null;

// ─── Team palette ─────────────────────────────────────────────────────────────
const T_BASE  = { 1: '#e74c3c', 2: '#3498db', 3: '#2ecc71', 4: '#f39c12' };
const T_TERR  = { 1: '#8b1a14', 2: '#0e4d7a', 3: '#136843', 4: '#7d5008' };
const T_TRAIL = { 1: '#ff7675', 2: '#74b9ff', 3: '#55efc4', 4: '#fdcb6e' };

function tColor(team)      { return T_BASE[team]  || '#888'; }
function tTerrColor(team)  { return T_TERR[team]  || '#333'; }
function tTrailColor(team) { return T_TRAIL[team] || '#aaa'; }

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const loginScreen  = document.getElementById('loginScreen');
const gameScreen   = document.getElementById('gameScreen');
const nameInput    = document.getElementById('nameInput');
const playBtn      = document.getElementById('playBtn');
const eloDisplay   = document.getElementById('eloDisplay');
const teamDisplay  = document.getElementById('teamDisplay');
const zoneTimerVal = document.getElementById('zoneTimerVal');
const lbRows       = document.getElementById('lbRows');
const deathOverlay = document.getElementById('deathOverlay');
const deathMsg     = document.getElementById('deathMsg');

// ─── Resize ───────────────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Input ────────────────────────────────────────────────────────────────────
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
let lastDir = 'right';

function sendDir(dir) {
  if (!myId || !players[myId]?.alive) return;
  if (dir === lastDir) return;
  lastDir = dir;
  socket.emit('direction', dir);
}

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowUp':  case 'w': case 'W': sendDir('up');    break;
    case 'ArrowDown':case 's': case 'S': sendDir('down');  break;
    case 'ArrowLeft':case 'a': case 'A': sendDir('left');  break;
    case 'ArrowRight':case 'd':case 'D': sendDir('right'); break;
  }
});

// Mobile D-pad
document.querySelectorAll('.dp-btn').forEach(btn => {
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    sendDir(btn.dataset.dir);
  }, { passive: false });
  btn.addEventListener('click', () => sendDir(btn.dataset.dir));
});

// Swipe fallback
let swipeX = 0, swipeY = 0;
canvas.addEventListener('touchstart', (e) => {
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
}, { passive: true });
canvas.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
    if (Math.abs(dx) > Math.abs(dy)) sendDir(dx > 0 ? 'right' : 'left');
    else                              sendDir(dy > 0 ? 'down'  : 'up');
  }
}, { passive: true });

// ─── Zone countdown ───────────────────────────────────────────────────────────
function startZoneCountdown(msRemaining) {
  clearInterval(zoneIntervalId);
  zoneCountdown = Math.round(msRemaining / 1000);
  zoneTimerVal.textContent = zoneCountdown;
  zoneIntervalId = setInterval(() => {
    zoneCountdown--;
    if (zoneCountdown < 0) zoneCountdown = 0;
    zoneTimerVal.textContent = zoneCountdown;
  }, 1000);
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
function updateLeaderboard() {
  // Count territory per team from local grid copy
  const teamCells = {};
  for (let i = 0; i < grid.length; i++) {
    const t = grid[i];
    if (t > 0) teamCells[t] = (teamCells[t] || 0) + 1;
  }

  const list = Object.values(players)
    .filter(p => p.alive)
    .map(p => ({ ...p, cells: teamCells[p.team] || 0 }))
    .sort((a, b) => b.cells - a.cells || b.elo - a.elo)
    .slice(0, 8);

  lbRows.innerHTML = list.map((p, i) => `
    <div class="lb-row${p.id === myId ? ' is-me' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-dot" style="background:${tColor(p.team)}"></span>
      <span class="lb-name" style="color:${tColor(p.team)}">${escHtml(p.name)}</span>
      <span class="lb-cells">${p.cells}</span>
      <span class="lb-elo">${p.elo}</span>
    </div>`).join('');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── HUD helpers ─────────────────────────────────────────────────────────────
function updateHUD() {
  const me = players[myId];
  if (!me) return;
  eloDisplay.textContent  = `ELO: ${me.elo}`;
  teamDisplay.textContent = `Team: ${teams[me.team]?.name || me.team}`;
  teamDisplay.style.color = tColor(me.team);
}

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('init', (data) => {
  myId     = data.playerId;
  gridSize = data.gridSize;
  grid     = new Uint8Array(data.grid);
  players  = data.players;
  zone     = data.zone;
  teams    = data.teams;

  // Center camera on own player immediately
  const me = players[myId];
  if (me) {
    cam.x = me.x * CELL - canvas.width  / 2 + CELL / 2;
    cam.y = me.y * CELL - canvas.height / 2 + CELL / 2;
  }

  startZoneCountdown(data.timeToShrink);
  updateHUD();

  loginScreen.classList.remove('active');
  gameScreen.classList.add('active');

  requestAnimationFrame(renderLoop);
});

socket.on('tick', (data) => {
  players = data.players;
  zone    = data.zone;

  for (const { i, t } of data.dirty) grid[i] = t;

  startZoneCountdown(data.timeToShrink);
  updateHUD();
  updateLeaderboard();
});

socket.on('zoneUpdate', (data) => {
  zone = data.zone;
  startZoneCountdown(data.timeToShrink);
});

socket.on('playerJoined', (p) => { players[p.id] = p; });
socket.on('playerLeft',   (d) => { delete players[d.id]; });

socket.on('died', (data) => {
  deathMsg.textContent = data.killedBy === 'zone'
    ? `Eliminated by the safe-zone collapse! ELO: ${data.elo}`
    : `Eliminated by ${data.killedBy}! ELO: ${data.elo}`;
  deathOverlay.classList.remove('hidden');
  lastDir = 'right';
});

socket.on('respawned', () => {
  deathOverlay.classList.add('hidden');
});

// ─── Play button ──────────────────────────────────────────────────────────────
function joinGame() {
  const name = nameInput.value.trim();
  socket.emit('join', { name });
}
playBtn.addEventListener('click', joinGame);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });

// ─── Render loop ──────────────────────────────────────────────────────────────
function renderLoop() {
  updateCamera();
  drawFrame();
  requestAnimationFrame(renderLoop);
}

function updateCamera() {
  const me = players[myId];
  if (!me || !me.alive) return;
  const tx = me.x * CELL - canvas.width  / 2 + CELL / 2;
  const ty = me.y * CELL - canvas.height / 2 + CELL / 2;
  cam.x += (tx - cam.x) * 0.12;
  cam.y += (ty - cam.y) * 0.12;
}

// Pre-built off-screen minimap canvas
const miniCanvas = document.createElement('canvas');
const miniCtx    = miniCanvas.getContext('2d');
const MINI_SIZE  = 150;
miniCanvas.width = miniCanvas.height = MINI_SIZE;
let miniDirty = true;   // set true when grid changes

function drawFrame() {
  const W = canvas.width, H = canvas.height;

  // ── world transform ──
  ctx.save();
  ctx.translate(-cam.x, -cam.y);

  const viewX0 = Math.max(0, Math.floor(cam.x / CELL) - 1);
  const viewY0 = Math.max(0, Math.floor(cam.y / CELL) - 1);
  const viewX1 = Math.min(gridSize, Math.ceil((cam.x + W) / CELL) + 2);
  const viewY1 = Math.min(gridSize, Math.ceil((cam.y + H) / CELL) + 2);

  // Background
  ctx.fillStyle = '#0e1026';
  ctx.fillRect(0, 0, gridSize * CELL, gridSize * CELL);

  // Territory
  for (let y = viewY0; y < viewY1; y++) {
    for (let x = viewX0; x < viewX1; x++) {
      const t = grid[y * gridSize + x];
      if (t > 0) {
        ctx.fillStyle = tTerrColor(t);
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }

  // Subtle grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 0.5;
  for (let x = viewX0; x <= viewX1; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, viewY0 * CELL);
    ctx.lineTo(x * CELL, viewY1 * CELL);
    ctx.stroke();
  }
  for (let y = viewY0; y <= viewY1; y++) {
    ctx.beginPath();
    ctx.moveTo(viewX0 * CELL, y * CELL);
    ctx.lineTo(viewX1 * CELL, y * CELL);
    ctx.stroke();
  }

  // Trails
  for (const p of Object.values(players)) {
    if (!p.alive || !p.trail.length) continue;
    ctx.fillStyle = tTrailColor(p.team);
    for (const c of p.trail) {
      if (c.x < viewX0 || c.x > viewX1 || c.y < viewY0 || c.y > viewY1) continue;
      ctx.fillRect(c.x * CELL + 3, c.y * CELL + 3, CELL - 6, CELL - 6);
    }
  }

  // Players
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const px = p.x * CELL + CELL / 2;
    const py = p.y * CELL + CELL / 2;
    const r  = CELL / 2 - 1;

    ctx.shadowColor = tColor(p.team);
    ctx.shadowBlur  = p.id === myId ? 14 : 6;

    ctx.fillStyle = tColor(p.team);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    if (p.id === myId) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Name tag
    ctx.fillStyle   = '#fff';
    ctx.font        = 'bold 9px Arial';
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.name, px, py - r - 2);
  }

  // ── Zone ──
  const zx = zone.cx * CELL;
  const zy = zone.cy * CELL;
  const zr = zone.radius * CELL;

  if (zr > 0) {
    // Danger overlay outside zone
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, gridSize * CELL, gridSize * CELL);
    ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(180,0,0,0.22)';
    ctx.fill('evenodd');
    ctx.restore();

    // Zone border
    ctx.strokeStyle = '#e74c3c';
    ctx.lineWidth   = 3;
    ctx.setLineDash([12, 6]);
    ctx.beginPath();
    ctx.arc(zx, zy, zr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Map outer border
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth   = 4;
  ctx.strokeRect(0, 0, gridSize * CELL, gridSize * CELL);

  ctx.restore(); // end world transform

  // ── Minimap ──
  drawMinimap(W, H);
}

// ─── Minimap ──────────────────────────────────────────────────────────────────
function drawMinimap(W, H) {
  const PAD  = 10;
  const SIZE = MINI_SIZE;
  const ox   = W - SIZE - PAD;
  const oy   = H - SIZE - PAD;
  const cpx  = SIZE / gridSize; // cell px on minimap

  // Rebuild minimap image when grid changes
  const imgData = miniCtx.createImageData(SIZE, SIZE);
  const d = imgData.data;

  // Background
  for (let k = 0; k < d.length; k += 4) {
    d[k]=14; d[k+1]=16; d[k+2]=38; d[k+3]=200;
  }

  // Territory
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const t = grid[gy * gridSize + gx];
      if (!t) continue;
      const col = tColor(t);
      const r = parseInt(col.slice(1,3),16);
      const g = parseInt(col.slice(3,5),16);
      const b = parseInt(col.slice(5,7),16);

      const mx  = Math.floor(gx * cpx);
      const my  = Math.floor(gy * cpx);
      const mw  = Math.max(1, Math.ceil(cpx));
      const mh  = Math.max(1, Math.ceil(cpx));
      for (let dy = 0; dy < mh; dy++) {
        for (let dx = 0; dx < mw; dx++) {
          const px = mx + dx, py = my + dy;
          if (px >= SIZE || py >= SIZE) continue;
          const k = (py * SIZE + px) * 4;
          d[k]=r; d[k+1]=g; d[k+2]=b; d[k+3]=220;
        }
      }
    }
  }

  miniCtx.putImageData(imgData, 0, 0);

  // Zone circle on minimap
  if (zone.radius > 0) {
    miniCtx.strokeStyle = '#e74c3c';
    miniCtx.lineWidth   = 1;
    miniCtx.beginPath();
    miniCtx.arc(zone.cx * cpx, zone.cy * cpx, zone.radius * cpx, 0, Math.PI * 2);
    miniCtx.stroke();
  }

  // Player dots on minimap
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const mx2 = p.x * cpx;
    const my2 = p.y * cpx;
    miniCtx.fillStyle = tColor(p.team);
    miniCtx.beginPath();
    miniCtx.arc(mx2, my2, p.id === myId ? 3 : 2, 0, Math.PI * 2);
    miniCtx.fill();
    if (p.id === myId) {
      miniCtx.strokeStyle = '#fff';
      miniCtx.lineWidth   = 1;
      miniCtx.stroke();
    }
  }

  // Blit minimap
  ctx.drawImage(miniCanvas, ox, oy);

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(ox, oy, SIZE, SIZE);
}

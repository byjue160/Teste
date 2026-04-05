// ─── Zone.io — client ─────────────────────────────────────────────────────────
'use strict';

const socket = io();

// ─── Solo colour palette (must match server whitelist) ────────────────────────
const SOLO_COLORS = [
  { hex: '#e74c3c', name: 'Rouge'      },
  { hex: '#3498db', name: 'Bleu'       },
  { hex: '#2ecc71', name: 'Vert'       },
  { hex: '#f1c40f', name: 'Or'         },
  { hex: '#9b59b6', name: 'Violet'     },
  { hex: '#e67e22', name: 'Orange'     },
  { hex: '#e91e63', name: 'Rose'       },
  { hex: '#00bcd4', name: 'Cyan'       },
  { hex: '#ecf0f1', name: 'Blanc'      },
  { hex: '#636e72', name: 'Noir'       },
  { hex: '#a8e63d', name: 'Lime'       },
  { hex: '#1abc9c', name: 'Turquoise'  },
];
let selectedColor = SOLO_COLORS[0].hex; // default: Rouge

// ─── Session state ────────────────────────────────────────────────────────────
let myId     = null;
let players  = {};
let grid     = null;
let gridSize = 100;
let zone     = { cx: 50, cy: 50, radius: 70 };
let isRanked = true;
let isTeam   = false;
let zoneCountdown  = 30;
let zoneIntervalId = null;

// ─── Spectate state ───────────────────────────────────────────────────────────
let isSpectating = false;
let spectateId   = null;
let lastMode     = null;  // { mode, ranked, color } — for "Play Again"

// teamColorMap: teamId → hex color (built from player state each tick)
const teamColorMap = {};

// ─── Derived colour cache ──────────────────────────────────────────────────────
const _terrCache  = {};
const _trailCache = {};

function invalidateColorCache(teamId) {
  delete _terrCache[teamId]; delete _trailCache[teamId];
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}
function rgbToHex(r,g,b) {
  return '#' + [r,g,b].map(v=>Math.min(255,Math.max(0,v)).toString(16).padStart(2,'0')).join('');
}

function setTeamColor(teamId, hex) {
  if (teamColorMap[teamId] === hex) return;
  teamColorMap[teamId] = hex;
  invalidateColorCache(teamId);
}

function tColor(id) { return teamColorMap[id] || '#aaa'; }

function terrFill(id) {
  if (_terrCache[id]) return _terrCache[id];
  const [r,g,b] = hexToRgb(teamColorMap[id] || '#aaa');
  _terrCache[id] = rgbToHex(Math.round(r*.42), Math.round(g*.42), Math.round(b*.42));
  return _terrCache[id];
}
function trailFill(id) {
  if (_trailCache[id]) return _trailCache[id];
  const [r,g,b] = hexToRgb(teamColorMap[id] || '#aaa');
  _trailCache[id] = rgbToHex(Math.min(255,Math.round(r*1.35)), Math.min(255,Math.round(g*1.35)), Math.min(255,Math.round(b*1.35)));
  return _trailCache[id];
}

function absorbPlayers(pMap) {
  for (const p of Object.values(pMap)) setTeamColor(p.team, p.color);
  players = pMap;
}

// ─── Canvas / camera ─────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
const CELL   = 16;
let cam = { x: 0, y: 0 };

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const loginScreen   = document.getElementById('loginScreen');
const modeScreen    = document.getElementById('modeScreen');
const lobbyScreen   = document.getElementById('lobbyScreen');
const gameScreen    = document.getElementById('gameScreen');
const nameInput     = document.getElementById('nameInput');
const nextBtn       = document.getElementById('nextBtn');
const backBtn       = document.getElementById('backBtn');
const lobbyBackBtn  = document.getElementById('lobbyBackBtn');
const modeGreeting  = document.getElementById('modeGreeting');
const colorPalette  = document.getElementById('colorPalette');
const eloDisplay    = document.getElementById('eloDisplay');
const teamDisplay   = document.getElementById('teamDisplay');
const modeBadge     = document.getElementById('modeBadge');
const zoneTimerVal  = document.getElementById('zoneTimerVal');
const lbRows        = document.getElementById('lbRows');
const deathOverlay  = document.getElementById('deathOverlay');
const deathMsg      = document.getElementById('deathMsg');
// Lobby DOM
const lobbyTitle    = document.getElementById('lobbyTitle');
const lobbySubtitle = document.getElementById('lobbySubtitle');
const lobbyStatus   = document.getElementById('lobbyStatus');
const readyBtn      = document.getElementById('readyBtn');
let playerReady     = false;
let myLobbyTeam     = null; // 1–4 or null
let playerName      = '';
let pendingRanked   = true; // ranked flag when entering lobby

// ─── Colour picker setup ──────────────────────────────────────────────────────
(function buildPalette() {
  SOLO_COLORS.forEach(({ hex, name }) => {
    const sw = document.createElement('button');
    sw.className = 'color-swatch' + (hex === selectedColor ? ' selected' : '');
    sw.style.background = hex;
    sw.title = name;
    sw.setAttribute('aria-label', name);
    sw.addEventListener('click', () => {
      selectedColor = hex;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
    colorPalette.appendChild(sw);
  });
})();

// ─── Screen helpers ───────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Leaderboard button ───────────────────────────────────────────────────────
document.getElementById('lbBtn').addEventListener('click', () => {
  const name = nameInput.value.trim();
  const url = name ? `/leaderboard?name=${encodeURIComponent(name)}` : '/leaderboard';
  window.open(url, '_blank');
});

// ─── Login → Mode ─────────────────────────────────────────────────────────────
nextBtn.addEventListener('click', () => {
  playerName = nameInput.value.trim() || `P${Math.floor(Math.random()*999)}`;
  modeGreeting.textContent = `Hello, ${playerName}!`;
  showScreen('modeScreen');
});
nameInput.addEventListener('keydown', e => { if (e.key==='Enter') nextBtn.click(); });
backBtn.addEventListener('click', () => showScreen('loginScreen'));

// ─── Mode cards ───────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    const mode   = card.dataset.mode;
    const ranked = card.dataset.ranked === 'true';
    lastMode = { mode, ranked, color: selectedColor };
    if (mode === 'solo') {
      socket.emit('join', { name: playerName, mode: 'solo', ranked, color: selectedColor });
    } else {
      // Team → lobby
      pendingRanked = ranked;
      socket.emit('joinLobby', { name: playerName, ranked });
    }
  });
});

// ─── Lobby back ───────────────────────────────────────────────────────────────
lobbyBackBtn.addEventListener('click', () => {
  socket.emit('leaveLobby');   // best-effort
  myLobbyTeam = null; playerReady = false;
  showScreen('modeScreen');
});

// ─── Lobby join-team buttons ──────────────────────────────────────────────────
document.querySelectorAll('.lobby-join-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const team = parseInt(btn.dataset.team, 10);
    socket.emit('chooseTeam', { team });
    myLobbyTeam = team;
    playerReady = false;
    readyBtn.classList.remove('is-ready');
    readyBtn.textContent = 'READY';
    readyBtn.disabled = false;
    updateLobbyButtonStates(null); // will be refreshed on lobbyUpdate
  });
});

// ─── Lobby ready button ───────────────────────────────────────────────────────
readyBtn.addEventListener('click', () => {
  if (readyBtn.disabled || !myLobbyTeam) return;
  playerReady = !playerReady;
  socket.emit('setReady', { ready: playerReady });
  readyBtn.classList.toggle('is-ready', playerReady);
  readyBtn.textContent = playerReady ? 'CANCEL READY' : 'READY';
});

// ─── Lobby rendering ──────────────────────────────────────────────────────────
const TEAM_DEF_CLIENT = {
  1: { name: 'Red',   color: '#e74c3c' },
  2: { name: 'Blue',  color: '#3498db' },
  3: { name: 'Green', color: '#2ecc71' },
  4: { name: 'Gold',  color: '#f1c40f' },
};

function renderLobby(teams) {
  for (let t = 1; t <= 4; t++) {
    const members  = teams[t] || [];
    const countEl  = document.getElementById(`lobbyCount${t}`);
    const listEl   = document.getElementById(`lobbyMembers${t}`);
    const joinBtn  = document.querySelector(`.lobby-join-btn[data-team="${t}"]`);
    const colEl    = document.getElementById(`lobbyTeamCol${t}`);

    if (countEl) countEl.textContent = `${members.length}/2`;

    if (listEl) {
      listEl.innerHTML = members.map(m => `
        <li class="lobby-member-item${m.id === myId ? ' is-me' : ''}">
          <span class="lobby-member-dot" style="background:${TEAM_DEF_CLIENT[t].color}"></span>
          <span>${esc(m.name)}${m.id === myId ? ' (you)' : ''}</span>
          <span class="lobby-member-check ${m.ready ? 'ready' : 'not-ready'}">${m.ready ? '✓' : '○'}</span>
        </li>`).join('');
    }

    const full = members.length >= 2;
    const isMyTeam = t === myLobbyTeam;

    if (joinBtn) {
      // Disable if full and not my team
      joinBtn.disabled = full && !isMyTeam;
      joinBtn.classList.toggle('current-team', isMyTeam);
      joinBtn.textContent = isMyTeam ? `✓ ${TEAM_DEF_CLIENT[t].name}` : `Join ${TEAM_DEF_CLIENT[t].name}`;
    }
    if (colEl) colEl.classList.toggle('active', isMyTeam);
  }

  // Status message
  if (!myLobbyTeam) {
    lobbyStatus.textContent = 'Select a team to continue';
    readyBtn.disabled = true;
  } else {
    // Count fully ready teams
    const readyTeams = [1,2,3,4].filter(t => {
      const m = teams[t] || [];
      return m.length > 0 && m.every(p => p.ready);
    }).length;
    const needed = Math.max(0, 2 - readyTeams);
    lobbyStatus.textContent = needed > 0
      ? `Waiting for ${needed} more team${needed>1?'s':''} to be ready…`
      : 'Starting soon…';
  }
}

function updateLobbyButtonStates(teams) {
  if (!teams) return;
  for (let t = 1; t <= 4; t++) {
    const members = teams[t] || [];
    const joinBtn = document.querySelector(`.lobby-join-btn[data-team="${t}"]`);
    if (joinBtn) joinBtn.disabled = members.length >= 2 && t !== myLobbyTeam;
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────
let lastDir = 'right';
function sendDir(dir) {
  if (!myId || !players[myId]?.alive || isSpectating) return;
  if (dir === lastDir) return;
  lastDir = dir; socket.emit('direction', dir);
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
  btn.addEventListener('touchstart', e => { e.preventDefault(); sendDir(btn.dataset.dir); }, { passive:false });
  btn.addEventListener('click', () => sendDir(btn.dataset.dir));
});
let sx=0, sy=0;
canvas.addEventListener('touchstart', e => { sx=e.touches[0].clientX; sy=e.touches[0].clientY; }, {passive:true});
canvas.addEventListener('touchend', e => {
  const dx=e.changedTouches[0].clientX-sx, dy=e.changedTouches[0].clientY-sy;
  if (Math.abs(dx)>20||Math.abs(dy)>20)
    sendDir(Math.abs(dx)>Math.abs(dy) ? (dx>0?'right':'left') : (dy>0?'down':'up'));
}, {passive:true});

// ─── Zone countdown ───────────────────────────────────────────────────────────
function startZoneCountdown(ms) {
  clearInterval(zoneIntervalId);
  zoneCountdown = Math.round(ms/1000);
  zoneTimerVal.textContent = zoneCountdown;
  zoneIntervalId = setInterval(() => { zoneCountdown=Math.max(0,zoneCountdown-1); zoneTimerVal.textContent=zoneCountdown; }, 1000);
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
function updateHUD() {
  const me = players[myId];
  if (!me) return;
  eloDisplay.style.display = isRanked ? '' : 'none';
  if (isRanked) eloDisplay.textContent = `ELO: ${me.elo}`;
  const teamName = isTeam ? (TEAM_DEF_CLIENT[me.team]?.name || `Team ${me.team}`) : 'Solo';
  teamDisplay.textContent = teamName;
  teamDisplay.style.color = tColor(me.team);
}
function setupModeBadge() {
  modeBadge.textContent = isRanked ? '⚡ RANKED' : '🎮 CHILL';
  modeBadge.className   = `mode-hud-badge ${isRanked ? 'ranked' : 'chill'}`;
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────
function updateLeaderboard() {
  const tc = {};
  for (let i=0; i<grid.length; i++) { const t=grid[i]; if(t>0) tc[t]=(tc[t]||0)+1; }
  const list = Object.values(players)
    .filter(p => p.alive && !p.waiting)
    .map(p => ({...p, cells: tc[p.team]||0}))
    .sort((a,b) => b.cells-a.cells || b.elo-a.elo)
    .slice(0,8);
  lbRows.innerHTML = list.map((p,i) => `
    <div class="lb-row${p.id===myId?' is-me':''}">
      <span class="lb-rank">${i+1}</span>
      <span class="lb-dot" style="background:${tColor(p.team)};box-shadow:0 0 4px ${tColor(p.team)}88"></span>
      <span class="lb-name" style="color:${tColor(p.team)}">${esc(p.name)}</span>
      <span class="lb-cells">${p.cells}</span>
      ${isRanked?`<span class="lb-elo">${p.elo}</span>`:''}
    </div>`).join('');
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── Spectate helpers ─────────────────────────────────────────────────────────
function updateSpectateHUD() {
  const p = players[spectateId];
  if (!p) return;
  document.getElementById('spectateName').textContent = p.name;
  const eloEl = document.getElementById('spectateEloVal');
  if (isRanked) { eloEl.textContent = `ELO ${p.elo}`; eloEl.style.display = ''; }
  else eloEl.style.display = 'none';
}

function enterSpectate() {
  isSpectating = true;
  document.getElementById('deathOverlay').classList.add('hidden');
  const alive = Object.values(players).filter(p => p.alive && !p.waiting);
  if (alive.length) spectateId = alive[0].id;
  document.getElementById('spectateHUD').classList.remove('hidden');
  updateSpectateHUD();
}

// ─── Leave-to-menu ────────────────────────────────────────────────────────────
function leaveToMenu() {
  socket.emit('leaveGame');
  myId = null; players = {}; grid = null;
  isSpectating = false; spectateId = null;
  clearInterval(zoneIntervalId);
  ['deathOverlay','victoryOverlay','gameEndOverlay'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('spectateHUD').classList.add('hidden');
  showScreen('modeScreen');
}

// Click on canvas → cycle spectate target
canvas.addEventListener('click', () => {
  if (!isSpectating) return;
  const alive = Object.values(players).filter(p => p.alive && !p.waiting);
  if (!alive.length) return;
  const idx  = alive.findIndex(p => p.id === spectateId);
  spectateId = alive[(idx + 1) % alive.length].id;
  updateSpectateHUD();
});

// ─── Overlay button wiring ────────────────────────────────────────────────────
document.getElementById('spectateBtn')   .addEventListener('click', enterSpectate);
document.getElementById('deathMenuBtn')  .addEventListener('click', leaveToMenu);
document.getElementById('spectateMenuBtn').addEventListener('click', leaveToMenu);
document.getElementById('victoryMenuBtn').addEventListener('click', leaveToMenu);
document.getElementById('gameEndMenuBtn').addEventListener('click', leaveToMenu);
document.getElementById('replayBtn').addEventListener('click', () => {
  socket.emit('leaveGame');
  myId = null; players = {}; grid = null;
  isSpectating = false; spectateId = null;
  clearInterval(zoneIntervalId);
  document.getElementById('victoryOverlay').classList.add('hidden');
  document.getElementById('spectateHUD').classList.add('hidden');
  if (lastMode?.mode === 'solo') {
    socket.emit('join', { name: playerName, mode: 'solo', ranked: lastMode.ranked, color: lastMode.color });
  } else if (lastMode?.mode === 'team') {
    socket.emit('joinLobby', { name: playerName, ranked: lastMode.ranked });
  } else {
    showScreen('modeScreen');
  }
});

// ─── Socket events ────────────────────────────────────────────────────────────

// Solo game init
socket.on('init', data => {
  myId     = data.playerId;
  gridSize = data.gridSize;
  grid     = new Uint8Array(data.grid);
  isRanked = data.isRanked;
  isTeam   = data.isTeam;
  zone     = data.zone;

  absorbPlayers(data.players);

  const me = players[myId];
  if (me) { cam.x = me.x*CELL - canvas.width/2 + CELL/2; cam.y = me.y*CELL - canvas.height/2 + CELL/2; }

  document.body.classList.toggle('chill-mode', !isRanked);
  startZoneCountdown(data.timeToShrink);
  setupModeBadge();

  // Transition from lobby or mode screen → game
  myLobbyTeam = null; playerReady = false;
  showScreen('gameScreen');
  if (!gameLoopRunning) { gameLoopRunning = true; requestAnimationFrame(renderLoop); }

  updateHUD(); updateLeaderboard();
});

// Lobby events
socket.on('lobbyJoined', data => {
  myId = socket.id; // needed for "is-me" highlight in lobby
  lobbyTitle.textContent   = data.isRanked ? 'Team Lobby — Ranked' : 'Team Lobby — Chill';
  lobbySubtitle.textContent = 'Pick your team, then click READY';
  readyBtn.disabled = true; readyBtn.textContent = 'READY'; readyBtn.classList.remove('is-ready');
  playerReady = false; myLobbyTeam = null;
  renderLobby(data.teams);
  showScreen('lobbyScreen');
});

socket.on('lobbyUpdate', data => {
  if (!lobbyScreen.classList.contains('active')) return;
  renderLobby(data.teams);
});

socket.on('tick', data => {
  absorbPlayers(data.players);
  zone = data.zone;
  for (const {i,t} of data.dirty) grid[i] = t;
  startZoneCountdown(data.timeToShrink);
  updateHUD(); updateLeaderboard();
});
socket.on('zoneUpdate', data => { zone = data.zone; startZoneCountdown(data.timeToShrink); });
socket.on('playerJoined', p => { setTeamColor(p.team, p.color); players[p.id] = p; });
socket.on('playerLeft',   d => { delete players[d.id]; });
socket.on('died', data => {
  // Description line
  deathMsg.textContent = data.killedBy === 'zone'
    ? 'Eliminated by the safe zone'
    : `Eliminated by ${data.killedBy}`;

  // ELO stat
  const eloWrap = document.getElementById('deathEloWrap');
  const eloEl   = document.getElementById('deathEloChange');
  if (data.ranked && data.eloChange !== undefined) {
    const delta = data.eloChange;
    eloEl.textContent  = delta >= 0 ? `+${delta}` : `${delta}`;
    eloEl.className    = 'stat-val ' + (delta >= 0 ? 'pos' : 'neg');
    eloWrap.style.display = '';
  } else {
    eloWrap.style.display = 'none';
  }

  document.getElementById('deathRank').textContent  = `#${data.rank}/${data.totalPlayers}`;
  document.getElementById('deathKills').textContent = data.kills;

  deathOverlay.classList.remove('hidden');
  lastDir = 'right';
});

socket.on('gameOver', data => {
  clearInterval(zoneIntervalId);
  const wasSpectating = isSpectating;
  isSpectating = false;
  document.getElementById('spectateHUD').classList.add('hidden');

  if (data.won) {
    document.getElementById('victoryKills').textContent = data.kills;
    document.getElementById('victoryTerr').textContent  = data.territory || 0;
    const eloWrapV = document.getElementById('victoryEloWrap');
    const eloValV  = document.getElementById('victoryEloVal');
    if (isRanked) {
      eloValV.textContent   = data.elo;
      eloWrapV.style.display = '';
    } else {
      eloWrapV.style.display = 'none';
    }
    const eloGained = data.elo - (players[myId]?.startElo ?? data.elo);
    document.getElementById('victoryMsg').textContent =
      isRanked && eloGained > 0 ? `+${eloGained} ELO this match` : '';
    document.getElementById('deathOverlay').classList.add('hidden');
    document.getElementById('victoryOverlay').classList.remove('hidden');
  } else if (wasSpectating) {
    const winner = Object.values(players).find(p => p.alive && !p.waiting);
    document.getElementById('gameEndMsg').textContent =
      winner ? `${winner.name} wins the match!` : 'Match ended.';
    document.getElementById('gameEndOverlay').classList.remove('hidden');
  }
  // If the death screen is showing they can still press MENU
});

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, color='#3498db') {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position:'fixed', top:'80px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(0,0,0,0.85)', border:`1px solid ${color}`, color:'#fff',
    padding:'10px 20px', borderRadius:'30px', fontSize:'14px', fontWeight:'600',
    zIndex:'300', opacity:'1', transition:'opacity .4s', whiteSpace:'nowrap',
    boxShadow:`0 0 14px ${color}55`,
  });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),400); }, 2500);
}

// ─── Camera ───────────────────────────────────────────────────────────────────
function updateCamera() {
  let target = null;
  if (isSpectating) {
    // Auto-switch to an alive player if current target died
    if (!players[spectateId]?.alive) {
      const next = Object.values(players).find(p => p.alive && !p.waiting);
      if (next) { spectateId = next.id; updateSpectateHUD(); }
    }
    target = players[spectateId];
  } else {
    const me = players[myId];
    if (me?.alive) target = me;
  }
  if (!target) return;
  cam.x += (target.x*CELL - canvas.width/2  + CELL/2 - cam.x) * 0.12;
  cam.y += (target.y*CELL - canvas.height/2 + CELL/2 - cam.y) * 0.12;
}

// ─── Minimap ─────────────────────────────────────────────────────────────────
const miniCanvas = document.createElement('canvas');
const miniCtx    = miniCanvas.getContext('2d');
const MINI = 150;
miniCanvas.width = miniCanvas.height = MINI;

function drawMinimap(W, H) {
  const PAD=10, cpx=MINI/gridSize, ox=W-MINI-PAD, oy=H-MINI-PAD;
  const imgData = miniCtx.createImageData(MINI,MINI);
  const d = imgData.data;
  for (let k=0;k<d.length;k+=4) { d[k]=14;d[k+1]=16;d[k+2]=38;d[k+3]=200; }
  for (let gy=0;gy<gridSize;gy++) for (let gx=0;gx<gridSize;gx++) {
    const t = grid[gy*gridSize+gx]; if (!t) continue;
    const col = tColor(t);
    const [r,g,b] = hexToRgb(col);
    const mx=Math.floor(gx*cpx), my=Math.floor(gy*cpx);
    const mw=Math.max(1,Math.ceil(cpx)), mh=Math.max(1,Math.ceil(cpx));
    for (let dy=0;dy<mh;dy++) for (let dx=0;dx<mw;dx++) {
      const px=mx+dx,py=my+dy; if(px>=MINI||py>=MINI) continue;
      const k=(py*MINI+px)*4; d[k]=r;d[k+1]=g;d[k+2]=b;d[k+3]=220;
    }
  }
  miniCtx.putImageData(imgData,0,0);
  if (zone.radius>0) {
    miniCtx.strokeStyle='#e74c3c'; miniCtx.lineWidth=1;
    miniCtx.beginPath(); miniCtx.arc(zone.cx*cpx,zone.cy*cpx,zone.radius*cpx,0,Math.PI*2); miniCtx.stroke();
  }
  for (const p of Object.values(players)) {
    if (!p.alive||p.waiting) continue;
    miniCtx.fillStyle = tColor(p.team);
    miniCtx.beginPath(); miniCtx.arc(p.x*cpx,p.y*cpx,p.id===myId?3:2,0,Math.PI*2); miniCtx.fill();
    if (p.id===myId) { miniCtx.strokeStyle='#fff'; miniCtx.lineWidth=1; miniCtx.stroke(); }
  }
  ctx.drawImage(miniCanvas,ox,oy);
  ctx.strokeStyle='rgba(255,255,255,0.35)'; ctx.lineWidth=1; ctx.strokeRect(ox,oy,MINI,MINI);
}

// ─── Render loop ─────────────────────────────────────────────────────────────
let gameLoopRunning = false;
function renderLoop() { updateCamera(); drawFrame(); requestAnimationFrame(renderLoop); }

function drawFrame() {
  if (!grid) return;
  const W=canvas.width, H=canvas.height;
  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  const x0=Math.max(0,Math.floor(cam.x/CELL)-1), y0=Math.max(0,Math.floor(cam.y/CELL)-1);
  const x1=Math.min(gridSize,Math.ceil((cam.x+W)/CELL)+2), y1=Math.min(gridSize,Math.ceil((cam.y+H)/CELL)+2);

  ctx.fillStyle='#0e1026';
  ctx.fillRect(0,0,gridSize*CELL,gridSize*CELL);

  // Territory
  for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) {
    const t=grid[y*gridSize+x]; if(!t) continue;
    ctx.fillStyle=terrFill(t); ctx.fillRect(x*CELL,y*CELL,CELL,CELL);
  }

  // Grid lines
  ctx.strokeStyle='rgba(255,255,255,0.025)'; ctx.lineWidth=0.5;
  for (let x=x0;x<=x1;x++) { ctx.beginPath(); ctx.moveTo(x*CELL,y0*CELL); ctx.lineTo(x*CELL,y1*CELL); ctx.stroke(); }
  for (let y=y0;y<=y1;y++) { ctx.beginPath(); ctx.moveTo(x0*CELL,y*CELL); ctx.lineTo(x1*CELL,y*CELL); ctx.stroke(); }

  // Trails
  for (const p of Object.values(players)) {
    if (!p.alive||!p.trail?.length||p.waiting) continue;
    ctx.fillStyle=trailFill(p.team);
    for (const c of p.trail) {
      if(c.x<x0||c.x>x1||c.y<y0||c.y>y1) continue;
      ctx.fillRect(c.x*CELL+3,c.y*CELL+3,CELL-6,CELL-6);
    }
  }

  // Players
  for (const p of Object.values(players)) {
    if (!p.alive||p.waiting) continue;
    const px=p.x*CELL+CELL/2, py=p.y*CELL+CELL/2, r=CELL/2-1;
    const col=tColor(p.team);
    ctx.shadowColor=col; ctx.shadowBlur=p.id===myId?14:6;
    ctx.fillStyle=col; ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2); ctx.fill();
    if (p.id===myId) { ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke(); }
    ctx.shadowBlur=0;
    ctx.fillStyle='#fff'; ctx.font='bold 9px Arial'; ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillText(p.name,px,py-r-2);
    if (isTeam&&p.id!==myId&&players[myId]&&p.team===players[myId].team) {
      ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.font='8px Arial'; ctx.textBaseline='top';
      ctx.fillText('ally',px,py+r+2);
    }
  }

  // Zone overlay
  const zx=zone.cx*CELL, zy=zone.cy*CELL, zr=zone.radius*CELL;
  if (zr>0) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0,0,gridSize*CELL,gridSize*CELL); ctx.arc(zx,zy,zr,0,Math.PI*2,true);
    ctx.fillStyle='rgba(180,0,0,0.2)'; ctx.fill('evenodd'); ctx.restore();
    ctx.strokeStyle='#e74c3c'; ctx.lineWidth=3; ctx.setLineDash([12,6]);
    ctx.beginPath(); ctx.arc(zx,zy,zr,0,Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=4;
  ctx.strokeRect(0,0,gridSize*CELL,gridSize*CELL);
  ctx.restore();
  drawMinimap(W,H);
}

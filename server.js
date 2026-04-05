const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs   = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// Leaderboard page route
app.get('/leaderboard', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'))
);

// ─── Constants ────────────────────────────────────────────────────────────────
const GRID_SIZE = 100;
const TICK_MS = 100;
const ZONE_SHRINK_INTERVAL = 30000;
const START_HALF = 2;
const SPAWN_INVINCIBILITY_MS = 3000;
const MIN_TRAIL_FOR_SELF_KILL = 5;
const MAX_TEAM_SIZE = 2;

// Fixed team definitions (team mode only)
const TEAM_DEF = {
  1: { name: 'Red',   color: '#e74c3c' },
  2: { name: 'Blue',  color: '#3498db' },
  3: { name: 'Green', color: '#2ecc71' },
  4: { name: 'Gold',  color: '#f1c40f' },
};

// Valid solo colours (whitelisted hex values clients may send)
const SOLO_COLORS = new Set([
  '#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#e67e22',
  '#e91e63','#00bcd4','#ecf0f1','#636e72','#a8e63d','#1abc9c',
]);
const SOLO_COLOR_DEFAULT = '#e74c3c';

const ZONE_PHASES = [
  Math.round(GRID_SIZE * 0.70), Math.round(GRID_SIZE * 0.55),
  Math.round(GRID_SIZE * 0.42), Math.round(GRID_SIZE * 0.30),
  Math.round(GRID_SIZE * 0.18), Math.round(GRID_SIZE * 0.08), 0,
];

const SPAWN_ANCHORS_TEAM = {
  1: { x: 15, y: 15 }, 2: { x: 84, y: 84 },
  3: { x: 84, y: 15 }, 4: { x: 15, y: 84 },
};

// ─── Persistent ELO / stats store ────────────────────────────────────────────
// Shape: { [playerName]: { elo: number, wins: number, games: number } }
// wins  = total kills,  games = total deaths (zone or player)
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'elo.json');
let eloStore = {};

function loadEloData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) eloStore = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`ELO data loaded (${Object.keys(eloStore).length} players)`);
  } catch (e) { console.error('ELO load error:', e.message); }
}

function saveEloData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(eloStore, null, 2));
  } catch (e) { console.error('ELO save error:', e.message); }
}

function getPlayerData(name) {
  if (!eloStore[name]) eloStore[name] = { elo: 1000, wins: 0, games: 0 };
  return eloStore[name];
}

function getTop100() {
  return Object.entries(eloStore)
    .filter(([, d]) => d.games > 0 || d.wins > 0 || d.elo !== 1000)
    .map(([name, d]) => ({ name, elo: d.elo ?? 1000, wins: d.wins ?? 0, games: d.games ?? 0 }))
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins)
    .slice(0, 100);
}

const LB_ROOM = 'lb-viewers';
function broadcastLeaderboard() {
  io.to(LB_ROOM).emit('leaderboardUpdate', getTop100());
}

loadEloData();
setInterval(saveEloData, 60_000); // persist every minute

// ─── Room factory ─────────────────────────────────────────────────────────────
// roomId = 'solo-ranked' | 'solo-chill' | 'team-ranked' | 'team-chill'
const rooms = new Map();

function createRoom(roomId) {
  const [mode, rank] = roomId.split('-');
  const isTeam = mode === 'team';
  return {
    id: roomId, isTeam, isRanked: rank === 'ranked',
    // 'lobby' phase for team rooms (players pick team + ready up before game starts)
    // solo rooms always stay in 'game' phase
    phase: isTeam ? 'lobby' : 'game',
    lobby: {
      // socketId → { id, name, team (1-4|null), ready, color }
      players: {},
    },
    grid: new Uint8Array(GRID_SIZE * GRID_SIZE),
    dirtySet: new Set(),
    zone: { cx: GRID_SIZE / 2, cy: GRID_SIZE / 2, radius: ZONE_PHASES[0] },
    zonePhaseIdx: 0, nextShrinkAt: null, gameStartedAt: null,
    players: {},      // active game players
    nextTeamId: 1,    // counter for unique solo team IDs
    gameOver: false,
    peakPlayers: 0,
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
  return rooms.get(roomId);
}

// ─── Grid helpers ─────────────────────────────────────────────────────────────
const gc = (room, x, y) => {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return -1;
  return room.grid[y * GRID_SIZE + x];
};
const sc = (room, x, y, t) => {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
  const i = y * GRID_SIZE + x;
  if (room.grid[i] !== t) { room.grid[i] = t; room.dirtySet.add(i); }
};

function isInZone(room, x, y) {
  if (room.zone.radius <= 0) return true;
  const dx = (x + 0.5) - room.zone.cx, dy = (y + 0.5) - room.zone.cy;
  return dx * dx + dy * dy <= room.zone.radius * room.zone.radius;
}
function isProtected(player) {
  return Date.now() - player.spawnedAt < SPAWN_INVINCIBILITY_MS;
}
function isEnemy(room, a, b) {
  if (a.id === b.id || !b.alive || b.waiting) return false;
  return a.team !== b.team;
}

// ─── Spawn ────────────────────────────────────────────────────────────────────
function getSpawnPos(room, team) {
  const anchor = room.isTeam
    ? (SPAWN_ANCHORS_TEAM[team] || { x: 50, y: 50 })
    : { x: 10 + Math.floor(Math.random() * 80), y: 10 + Math.floor(Math.random() * 80) };
  const jitter = () => room.isTeam ? Math.floor(Math.random() * 10) - 5 : 0;
  let x = anchor.x + jitter(), y = anchor.y + jitter();
  const safeR = Math.max(0, room.zone.radius - START_HALF - 2);
  if (safeR > 0) {
    const dx = (x + 0.5) - room.zone.cx, dy = (y + 0.5) - room.zone.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > safeR) {
      x = Math.round(room.zone.cx + dx * (safeR / dist) - 0.5);
      y = Math.round(room.zone.cy + dy * (safeR / dist) - 0.5);
    }
  } else { x = Math.round(room.zone.cx); y = Math.round(room.zone.cy); }
  return {
    x: Math.min(GRID_SIZE - START_HALF - 2, Math.max(START_HALF + 1, x)),
    y: Math.min(GRID_SIZE - START_HALF - 2, Math.max(START_HALF + 1, y)),
  };
}
function giveStartingTerritory(room, player) {
  for (let dy = -START_HALF; dy <= START_HALF; dy++)
    for (let dx = -START_HALF; dx <= START_HALF; dx++)
      sc(room, player.x + dx, player.y + dy, player.team);
}
function spawnPlayer(room, player) {
  const pos = getSpawnPos(room, player.team);
  Object.assign(player, { x: pos.x, y: pos.y, direction: 'right', nextDir: 'right',
    trail: [], inTerritory: true, alive: true, waiting: false, spawnedAt: Date.now() });
  giveStartingTerritory(room, player);
}

// ─── Territory capture ────────────────────────────────────────────────────────
function captureTerritory(room, player) {
  if (!player.trail.length) return;
  const team = player.team;
  const temp = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const outside = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < room.grid.length; i++) if (room.grid[i] === team) temp[i] = 1;
  for (const c of player.trail) temp[c.y * GRID_SIZE + c.x] = 2;
  const queue = [];
  const enq = (i) => { if (!outside[i] && temp[i] === 0) { outside[i] = 1; queue.push(i); } };
  for (let x = 0; x < GRID_SIZE; x++) { enq(x); enq((GRID_SIZE-1)*GRID_SIZE+x); }
  for (let y = 1; y < GRID_SIZE-1; y++) { enq(y*GRID_SIZE); enq(y*GRID_SIZE+GRID_SIZE-1); }
  while (queue.length) {
    const idx = queue.pop(), cy = (idx/GRID_SIZE)|0, cx = idx%GRID_SIZE;
    if (cx > 0) enq(idx-1); if (cx < GRID_SIZE-1) enq(idx+1);
    if (cy > 0) enq(idx-GRID_SIZE); if (cy < GRID_SIZE-1) enq(idx+GRID_SIZE);
  }
  for (let i = 0; i < GRID_SIZE*GRID_SIZE; i++) {
    if (temp[i] === 2 || (temp[i] === 0 && !outside[i])) {
      if (temp[i] === 0 && !outside[i] && room.grid[i] !== team) {
        const cx = i%GRID_SIZE, cy = (i/GRID_SIZE)|0;
        for (const p of Object.values(room.players))
          if (isEnemy(room, player, p) && p.x === cx && p.y === cy) killPlayer(room, p, player);
      }
      if (room.grid[i] !== team) { room.grid[i] = team; room.dirtySet.add(i); }
    }
  }
  player.trail = []; player.inTerritory = true;
}

// ─── Kill (no respawn — Battle Royale) ───────────────────────────────────────
function killPlayer(room, player, killer) {
  if (!player.alive) return;
  player.trail = []; player.alive = false;

  const hasTeammate = Object.values(room.players).some(
    p => p.id !== player.id && p.team === player.team && p.alive
  );
  if (!hasTeammate) {
    for (let i = 0; i < room.grid.length; i++)
      if (room.grid[i] === player.team) { room.grid[i] = 0; room.dirtySet.add(i); }
  }

  // Rank = number of players still alive after this death + 1
  const aliveAfter = Object.values(room.players).filter(p => p.alive && !p.waiting).length;
  const total      = Object.keys(room.players).length;
  player.finalRank = aliveAfter + 1;

  let eloChange = 0;
  if (room.isRanked) {
    const vData  = getPlayerData(player.name);
    vData.games++;
    eloChange    = -Math.min(20, vData.elo);
    vData.elo    = Math.max(0, vData.elo - 20);
    player.elo   = vData.elo;
    if (killer && killer.id !== player.id) {
      const kData  = getPlayerData(killer.name);
      kData.wins++;
      kData.elo   += 25;
      killer.elo   = kData.elo;
      killer.kills = (killer.kills || 0) + 1;
    }
    saveEloData();
    broadcastLeaderboard();
  } else if (killer && killer.id !== player.id) {
    killer.kills = (killer.kills || 0) + 1;
  }

  io.to(player.id).emit('died', {
    killedBy: killer ? killer.name : 'zone',
    elo: player.elo, eloChange,
    kills: player.kills || 0,
    rank: player.finalRank,
    totalPlayers: total,
    ranked: room.isRanked,
  });

  // Check if the match is now over
  checkWinCondition(room);
}

// ─── Win condition ────────────────────────────────────────────────────────────
function checkWinCondition(room) {
  if (room.gameOver) return;
  const total = Object.keys(room.players).length;
  if (total < 2) return; // single-player room — no winner declared
  const alive = Object.values(room.players).filter(p => p.alive && !p.waiting);

  let ended = false;
  if (room.isTeam) {
    const aliveTeams = new Set(alive.map(p => p.team));
    ended = aliveTeams.size <= 1;
  } else {
    ended = alive.length <= 1;
  }
  if (!ended) return;

  room.gameOver = true;
  // Count territory for winners (snapshot at game end)
  const tc = {};
  for (let i = 0; i < room.grid.length; i++) { const t = room.grid[i]; if (t) tc[t] = (tc[t]||0)+1; }

  for (const p of Object.values(room.players)) {
    const won = alive.some(a => a.id === p.id);
    io.to(p.id).emit('gameOver', {
      won,
      kills: p.kills || 0,
      elo: p.elo,
      territory: tc[p.team] || 0,
      totalPlayers: total,
    });
  }
  // Wipe the room after a grace period so a fresh game can start
  setTimeout(() => rooms.delete(room.id), 10_000);
}

// ─── Zone shrink ──────────────────────────────────────────────────────────────
function tryShrinkZone(room) {
  const now = Date.now();
  if (!room.nextShrinkAt || now < room.nextShrinkAt) return;
  const alive = Object.values(room.players).filter(p => p.alive && !p.waiting).length;
  if (alive < 2 || !room.gameStartedAt || now - room.gameStartedAt < ZONE_SHRINK_INTERVAL) {
    room.nextShrinkAt = now + ZONE_SHRINK_INTERVAL;
    io.to(room.id).emit('zoneUpdate', { zone: room.zone, timeToShrink: ZONE_SHRINK_INTERVAL }); return;
  }
  room.zonePhaseIdx = Math.min(room.zonePhaseIdx + 1, ZONE_PHASES.length - 1);
  room.zone.radius = ZONE_PHASES[room.zonePhaseIdx];
  room.nextShrinkAt = now + ZONE_SHRINK_INTERVAL;
  for (const p of Object.values(room.players))
    if (p.alive && !isProtected(p) && !isInZone(room, p.x, p.y)) killPlayer(room, p, null);
  io.to(room.id).emit('zoneUpdate', { zone: room.zone, timeToShrink: ZONE_SHRINK_INTERVAL });
}

// ─── Game tick ────────────────────────────────────────────────────────────────
const OPP = { up:'down', down:'up', left:'right', right:'left' };

function gameTick() { for (const r of rooms.values()) if (r.phase === 'game') tickRoom(r); }

function tickRoom(room) {
  if (room.gameOver) return;
  room.dirtySet.clear();
  tryShrinkZone(room);
  for (const player of Object.values(room.players)) {
    if (!player.alive || player.waiting) continue;
    const inv = isProtected(player);
    if (player.nextDir !== OPP[player.direction]) player.direction = player.nextDir;
    let nx = player.x, ny = player.y;
    if (player.direction==='up') ny--; if (player.direction==='down') ny++;
    if (player.direction==='left') nx--; if (player.direction==='right') nx++;
    if (nx<0||nx>=GRID_SIZE||ny<0||ny>=GRID_SIZE) { if(!inv) killPlayer(room,player,null); continue; }
    if (!inv && !isInZone(room,nx,ny)) { killPlayer(room,player,null); continue; }
    if (!inv && player.trail.length >= MIN_TRAIL_FOR_SELF_KILL)
      if (player.trail.some(c=>c.x===nx&&c.y===ny)) { killPlayer(room,player,null); continue; }
    for (const o of Object.values(room.players))
      if (isEnemy(room,player,o) && o.trail.some(c=>c.x===nx&&c.y===ny)) killPlayer(room,o,player);
    if (!player.alive) continue;
    player.x = nx; player.y = ny;
    const ownCell = gc(room,nx,ny) === player.team;
    if (ownCell) {
      if (!player.inTerritory && player.trail.length > 0) captureTerritory(room, player);
      player.inTerritory = true;
    } else {
      player.inTerritory = false;
      if (!player.trail.some(c=>c.x===nx&&c.y===ny)) player.trail.push({x:nx,y:ny});
      if (!inv) for (const o of Object.values(room.players))
        if (isEnemy(room,player,o) && o.x===nx && o.y===ny) { killPlayer(room,player,o); break; }
    }
  }
  const pStates = {};
  for (const [id,p] of Object.entries(room.players))
    pStates[id] = { id:p.id,name:p.name,team:p.team,color:p.color,
      x:p.x,y:p.y,direction:p.direction,trail:p.trail,alive:p.alive,waiting:p.waiting,elo:p.elo };
  const dirty = [];
  for (const idx of room.dirtySet) dirty.push({i:idx,t:room.grid[idx]});
  io.to(room.id).emit('tick', {
    players: pStates, dirty, zone: room.zone,
    timeToShrink: room.nextShrinkAt ? Math.max(0, room.nextShrinkAt - Date.now()) : ZONE_SHRINK_INTERVAL,
  });
}

// ─── Lobby helpers ────────────────────────────────────────────────────────────
function lobbySnapshot(room) {
  const teams = { 1:[], 2:[], 3:[], 4:[] };
  for (const p of Object.values(room.lobby.players)) {
    if (p.team && teams[p.team]) teams[p.team].push({ id:p.id, name:p.name, ready:p.ready });
  }
  return { teams, teamDef: TEAM_DEF };
}

function broadcastLobbyUpdate(room) {
  io.to(room.id).emit('lobbyUpdate', lobbySnapshot(room));
}

function checkLobbyReady(room) {
  // ≥2 teams where ALL players in that team have clicked ready and team has ≥1 player
  const teamsReady = [1,2,3,4].filter(t => {
    const members = Object.values(room.lobby.players).filter(p => p.team === t);
    return members.length > 0 && members.every(p => p.ready);
  });
  return teamsReady.length >= 2;
}

function startGameFromLobby(room) {
  room.phase = 'game';
  // Spawn all lobby players that have a team
  for (const lp of Object.values(room.lobby.players)) {
    if (!lp.team) continue;
    const startEloLp = getPlayerData(lp.name).elo;
    const gamePlayer = {
      id: lp.id, name: lp.name,
      team: lp.team,
      color: TEAM_DEF[lp.team].color,
      elo: startEloLp, startElo: startEloLp, kills: 0, finalRank: 0,
      x:0, y:0, direction:'right', nextDir:'right',
      trail:[], alive:false, waiting:false, inTerritory:true, spawnedAt:0,
      roomId: room.id,
    };
    room.players[lp.id] = gamePlayer;
    spawnPlayer(room, gamePlayer);
  }
  room.gameStartedAt = Date.now();
  room.nextShrinkAt  = room.gameStartedAt + ZONE_SHRINK_INTERVAL;
  room.peakPlayers   = Object.keys(room.players).length;
  // Send individual init to each lobby player
  for (const lp of Object.values(room.lobby.players)) {
    const sock = io.sockets.sockets.get(lp.id);
    if (!sock) continue;
    const pStates = Object.fromEntries(
      Object.entries(room.players).map(([id,p]) => [id,{
        id:p.id,name:p.name,team:p.team,color:p.color,
        x:p.x,y:p.y,direction:p.direction,trail:p.trail,alive:p.alive,waiting:p.waiting,elo:p.elo,
      }])
    );
    sock.emit('init', {
      playerId: lp.id, grid: Array.from(room.grid), gridSize: GRID_SIZE,
      players: pStates, zone: room.zone, timeToShrink: ZONE_SHRINK_INTERVAL,
      roomId: room.id, isTeam: true, isRanked: room.isRanked, waitingForTeammate: false,
    });
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('+ connected:', socket.id);
  let playerRoomId = null;
  let playerPhase  = null; // 'lobby' | 'game'

  // ── Solo: direct join ──────────────────────────────────────────────────────
  socket.on('join', ({ name, mode, ranked, color }) => {
    const safeName  = (name||'').trim().slice(0,15) || `P${Math.floor(Math.random()*999)}`;
    const isRanked  = ranked === true;
    const roomId    = `solo-${isRanked?'ranked':'chill'}`;
    playerRoomId    = roomId; playerPhase = 'game';
    const room      = getRoom(roomId);
    socket.join(roomId);
    // Unique team ID per solo player (for distinct territory colour)
    const team = room.nextTeamId;
    room.nextTeamId = (room.nextTeamId % 254) + 1;
    // Validate colour
    const safeColor = SOLO_COLORS.has(color) ? color : SOLO_COLOR_DEFAULT;
    const startElo = getPlayerData(safeName).elo;
    const player = {
      id: socket.id, name: safeName, team, color: safeColor,
      elo: startElo, startElo, kills: 0, finalRank: 0,
      x:0, y:0, direction:'right', nextDir:'right',
      trail:[], alive:false, waiting:false, inTerritory:true, spawnedAt:0, roomId,
    };
    room.players[socket.id] = player;
    spawnPlayer(room, player);
    room.peakPlayers = Math.max(room.peakPlayers, Object.keys(room.players).length);
    if (!room.gameStartedAt) { room.gameStartedAt = Date.now(); room.nextShrinkAt = room.gameStartedAt + ZONE_SHRINK_INTERVAL; }
    const pStates = Object.fromEntries(Object.entries(room.players).map(([id,p])=>[id,{
      id:p.id,name:p.name,team:p.team,color:p.color,
      x:p.x,y:p.y,direction:p.direction,trail:p.trail,alive:p.alive,waiting:p.waiting,elo:p.elo,
    }]));
    socket.emit('init', { playerId:socket.id, grid:Array.from(room.grid), gridSize:GRID_SIZE,
      players:pStates, zone:room.zone,
      timeToShrink: room.nextShrinkAt ? Math.max(0,room.nextShrinkAt-Date.now()) : ZONE_SHRINK_INTERVAL,
      roomId, isTeam:false, isRanked, waitingForTeammate:false });
    socket.broadcast.to(roomId).emit('playerJoined', {
      id:socket.id,name:safeName,team,color:safeColor,x:player.x,y:player.y,
      trail:[],alive:true,waiting:false,elo:player.elo });
  });

  // ── Team: join lobby ───────────────────────────────────────────────────────
  socket.on('joinLobby', ({ name, ranked }) => {
    const safeName = (name||'').trim().slice(0,15) || `P${Math.floor(Math.random()*999)}`;
    const isRanked = ranked === true;
    const roomId   = `team-${isRanked?'ranked':'chill'}`;
    playerRoomId   = roomId; playerPhase = 'lobby';
    const room     = getRoom(roomId);
    socket.join(roomId);
    // If game already running, re-enter lobby for next round (player waits)
    room.lobby.players[socket.id] = { id:socket.id, name:safeName, team:null, ready:false, color:null };
    socket.emit('lobbyJoined', { ...lobbySnapshot(room), teamDef:TEAM_DEF, isRanked,
      elo: getPlayerData(safeName).elo });
    broadcastLobbyUpdate(room);
  });

  // ── Team: choose team ──────────────────────────────────────────────────────
  socket.on('chooseTeam', ({ team }) => {
    if (!playerRoomId || playerPhase !== 'lobby') return;
    const room = rooms.get(playerRoomId);
    const lp   = room?.lobby.players[socket.id];
    if (!lp || !TEAM_DEF[team]) return;
    // Count current members in that team
    const count = Object.values(room.lobby.players).filter(p => p.team === team).length;
    if (count >= MAX_TEAM_SIZE) return; // full
    lp.team  = team;
    lp.color = TEAM_DEF[team].color;
    lp.ready = false; // reset ready on team change
    broadcastLobbyUpdate(room);
  });

  // ── Team: toggle ready ─────────────────────────────────────────────────────
  socket.on('setReady', ({ ready }) => {
    if (!playerRoomId || playerPhase !== 'lobby') return;
    const room = rooms.get(playerRoomId);
    const lp   = room?.lobby.players[socket.id];
    if (!lp || !lp.team) return;
    lp.ready = !!ready;
    if (room.phase === 'lobby' && checkLobbyReady(room)) {
      startGameFromLobby(room);
    } else {
      broadcastLobbyUpdate(room);
    }
  });

  // ── Direction ──────────────────────────────────────────────────────────────
  socket.on('direction', dir => {
    const valid = ['up','down','left','right'];
    if (!valid.includes(dir) || !playerRoomId || playerPhase !== 'game') return;
    const room   = rooms.get(playerRoomId);
    if (!room || room.gameOver) return;
    const player = room.players[socket.id];
    if (player?.alive && !player.waiting) player.nextDir = dir;
  });

  // ── Leave game (dead / spectating → back to menu) ─────────────────────────
  socket.on('leaveGame', () => {
    if (!playerRoomId) return;
    const room = rooms.get(playerRoomId);
    if (room) {
      const player = room.players[socket.id];
      if (player) {
        // Kill if still alive (e.g. rage-quit)
        if (player.alive && !room.gameOver) killPlayer(room, player, null);
        else if (room.isRanked) { getPlayerData(player.name).elo = player.elo; saveEloData(); }
        const hasTeammate = Object.values(room.players).some(
          p => p.id !== socket.id && p.team === player.team && p.alive
        );
        if (!hasTeammate) {
          for (let i = 0; i < room.grid.length; i++)
            if (room.grid[i] === player.team) { room.grid[i] = 0; room.dirtySet.add(i); }
        }
        delete room.players[socket.id];
        io.to(room.id).emit('playerLeft', { id: socket.id });
      }
      if (room.lobby?.players[socket.id]) {
        delete room.lobby.players[socket.id];
        broadcastLobbyUpdate(room);
      }
      socket.leave(room.id);
    }
    playerRoomId = null; playerPhase = null;
  });

  // ── Leaderboard room ───────────────────────────────────────────────────────
  socket.on('joinLeaderboard', () => {
    socket.join(LB_ROOM);
    socket.emit('leaderboardUpdate', getTop100());
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('- disconnected:', socket.id);
    if (!playerRoomId) return;
    const room = rooms.get(playerRoomId);
    if (!room) return;
    // Remove from lobby if present
    if (room.lobby.players[socket.id]) {
      delete room.lobby.players[socket.id];
      broadcastLobbyUpdate(room);
    }
    // Remove from game if present
    const player = room.players[socket.id];
    if (player) {
      if (room.isRanked) { getPlayerData(player.name).elo = player.elo; saveEloData(); }
      const hasTeammate = Object.values(room.players).some(
        p => p.id !== socket.id && p.team === player.team && p.alive
      );
      if (!hasTeammate) {
        for (let i = 0; i < room.grid.length; i++)
          if (room.grid[i] === player.team) { room.grid[i] = 0; room.dirtySet.add(i); }
      }
      delete room.players[socket.id];
      io.to(room.id).emit('playerLeft', { id: socket.id });
    }
  });
});

setInterval(gameTick, TICK_MS);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Zone.io running on http://localhost:${PORT}`));

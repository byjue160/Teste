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

// ─── Admin routes (password-protected) ───────────────────────────────────────
function adminAuth(req, res) {
  const pass = req.query.password || req.headers['x-admin-password'];
  if (pass !== ADMIN_PASS) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

app.get('/admin/bans', (req, res) => {
  if (!adminAuth(req, res)) return;
  const now  = Date.now();
  const list = Object.entries(banStore).map(([ip, e]) => ({
    ip,
    kickCount:   e.kickCount || 0,
    isBanned:    !!(e.bannedUntil && now < e.bannedUntil),
    bannedUntil: e.bannedUntil ? new Date(e.bannedUntil).toISOString() : null,
    recentKicks: (e.kicks || []).slice(-5),
  })).sort((a, b) => b.kickCount - a.kickCount);
  res.json({ total: list.length, activeBans: list.filter(x => x.isBanned).length, list });
});

app.post('/admin/unban', express.json(), (req, res) => {
  if (!adminAuth(req, res)) return;
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  if (banStore[ip]) { banStore[ip].bannedUntil = null; banStore[ip].kickCount = 0; saveBans(); }
  res.json({ ok: true, ip });
});

// ─── Constants ────────────────────────────────────────────────────────────────
const GRID_SIZE   = 200;
const TICK_MS     = 100;
const START_HALF  = 2;
const SPAWN_INVINCIBILITY_MS   = 3000;
const MIN_TRAIL_FOR_SELF_KILL  = 5;
const MAX_TEAM_SIZE  = 2;
const MAX_PLAYERS    = 10;   // per room
const LOBBY_CD_MS    = 10000; // 10 s countdown before game starts
// ELO deltas
const KILL_ELO            = 10;
const DEATH_NO_KILL_ELO   = -10; // only applied if player has 0 kills
const PLACEMENT_BONUS     = [50, 30, 15, 5, 0]; // 1st, 2nd, 3rd, 4th, 5th+

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

const SPAWN_ANCHORS_TEAM = {
  1: { x: 30,  y: 30  }, 2: { x: 170, y: 170 },
  3: { x: 170, y: 30  }, 4: { x: 30,  y: 170 },
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

// ─── Security / Anti-cheat ────────────────────────────────────────────────────
const BAN_FILE       = path.join(DATA_DIR, 'bans.json');
const ADMIN_PASS     = process.env.ADMIN_PASSWORD || 'zone-admin-secret';
const RATE_LIMIT_MAX = 60;   // max Socket.io messages per second per socket
const KICK_MAX       = 3;    // kicks before 1-hour ban

// banStore: { [ip]: { kickCount, bannedUntil, kicks:[{name,reason,ts}] } }
let banStore = {};

function loadBans() {
  try {
    if (fs.existsSync(BAN_FILE)) banStore = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    console.log(`Ban data loaded (${Object.keys(banStore).length} IPs)`);
  } catch(e) { console.error('Ban load error:', e.message); }
}
function saveBans() {
  try { fs.writeFileSync(BAN_FILE, JSON.stringify(banStore, null, 2)); }
  catch(e) { console.error('Ban save error:', e.message); }
}

function getIp(socket) {
  return (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || socket.handshake.address || 'unknown';
}

function isIpBanned(ip) {
  const e = banStore[ip];
  if (!e?.bannedUntil) return false;
  if (Date.now() < e.bannedUntil) return true;
  e.bannedUntil = null; e.kickCount = 0; saveBans(); // expired
  return false;
}

function kickSocket(socket, reason, name = '?') {
  const ip = getIp(socket);
  const ts = new Date().toISOString();
  console.warn(`[KICK] ${ts} ip=${ip} name=${name} reason="${reason}"`);

  const e = banStore[ip] || { kickCount: 0, bannedUntil: null, kicks: [] };
  e.kicks.push({ name, reason, ts });
  if (e.kicks.length > 50) e.kicks = e.kicks.slice(-50);
  e.kickCount = (e.kickCount || 0) + 1;

  if (e.kickCount >= KICK_MAX) {
    e.bannedUntil = Date.now() + 3_600_000; // 1 h
    console.warn(`[BAN]  ${ts} ip=${ip} banned 1 h (kick #${e.kickCount})`);
    socket.emit('kicked', { reason, banned: true, until: e.bannedUntil });
  } else {
    socket.emit('kicked', { reason, banned: false });
  }
  banStore[ip] = e; saveBans();
  socket.disconnect(true);
}

// Name sanitisation: strip HTML/injection chars, control chars, max 15 chars
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[<>&"'`\\]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim().slice(0, 15);
}

loadBans();
setInterval(saveBans, 60_000);

// ─── Room factory ─────────────────────────────────────────────────────────────
// modeBase = 'solo-ranked' | 'solo-chill' | 'team-ranked' | 'team-chill'
// roomId   = modeBase + '-' + roomNumber  e.g. 'solo-ranked-1'
const rooms = new Map();
const roomCounters = { 'solo-ranked': 0, 'solo-chill': 0, 'team-ranked': 0, 'team-chill': 0 };

function createRoom(modeBase, roomNum) {
  const [mode, rank] = modeBase.split('-');
  const isTeam = mode === 'team';
  const roomId = `${modeBase}-${roomNum}`;
  return {
    id: roomId, modeBase, roomNum, isTeam, isRanked: rank === 'ranked',
    phase: 'lobby',   // ALL modes start in lobby now
    lobby: {
      players: {},          // socketId → { id, name, team, ready, color }
      countdownAt: null,    // ms timestamp when game will auto-start
      lastCdBroadcast: 0,
    },
    grid: new Uint8Array(GRID_SIZE * GRID_SIZE),
    dirtySet: new Set(),
    gameStartedAt: null,
    players: {},      // active game players
    nextTeamId: 1,    // counter for unique solo team IDs (1-254)
    gameOver: false,
    peakPlayers: 0,
    lastEmptyAt: null, // for 30 s empty-room cleanup
  };
}

/** Find a lobby-phase room with space, or create a new one. */
function findOrCreateRoom(modeBase) {
  for (const room of rooms.values()) {
    if (room.modeBase === modeBase && room.phase === 'lobby') {
      if (Object.keys(room.lobby.players).length < MAX_PLAYERS) return room;
    }
  }
  if (!(modeBase in roomCounters)) roomCounters[modeBase] = 0;
  const num = ++roomCounters[modeBase];
  const room = createRoom(modeBase, num);
  rooms.set(room.id, room);
  return room;
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

function isProtected(player) {
  return Date.now() - player.spawnedAt < SPAWN_INVINCIBILITY_MS;
}
function isEnemy(room, a, b) {
  if (a.id === b.id || !b.alive || b.waiting) return false;
  return a.team !== b.team;
}

// ─── Spawn ────────────────────────────────────────────────────────────────────
function getSpawnPos(room, team) {
  const margin = START_HALF + 2;
  if (room.isTeam) {
    const anchor = SPAWN_ANCHORS_TEAM[team] || { x: 100, y: 100 };
    const jitter = Math.floor(Math.random() * 10) - 5;
    return {
      x: Math.min(GRID_SIZE - margin, Math.max(margin, anchor.x + jitter)),
      y: Math.min(GRID_SIZE - margin, Math.max(margin, anchor.y + jitter)),
    };
  }
  return {
    x: margin + Math.floor(Math.random() * (GRID_SIZE - 2 * margin)),
    y: margin + Math.floor(Math.random() * (GRID_SIZE - 2 * margin)),
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

// ─── Kill — Battle Royale (no respawn ever) ───────────────────────────────────
function killPlayer(room, player, killer) {
  if (!player.alive) return;

  // Mark dead immediately — nothing else in this codebase resets alive to true
  player.trail      = [];
  player.alive      = false;
  player.spectating = true;   // server-side spectator flag

  const hasTeammate = Object.values(room.players).some(
    p => p.id !== player.id && p.team === player.team && p.alive
  );
  if (!hasTeammate) {
    for (let i = 0; i < room.grid.length; i++)
      if (room.grid[i] === player.team) { room.grid[i] = 0; room.dirtySet.add(i); }
  }

  // Rank = surviving players after this death + 1
  const aliveAfter = Object.values(room.players).filter(p => p.alive && !p.waiting).length;
  const total      = Object.keys(room.players).length;
  player.finalRank = aliveAfter + 1;

  let eloChange = 0;
  if (room.isRanked) {
    const vData = getPlayerData(player.name);
    vData.games++;
    // Death penalty only if the player scored 0 kills this match
    if ((player.kills || 0) === 0) {
      eloChange  = -Math.min(-DEATH_NO_KILL_ELO, vData.elo);
      vData.elo  = Math.max(0, vData.elo + DEATH_NO_KILL_ELO);
    }
    player.elo = vData.elo;
    if (killer && killer.id !== player.id) {
      const kData  = getPlayerData(killer.name);
      kData.wins++;
      kData.elo   += KILL_ELO;
      killer.elo   = kData.elo;
      killer.kills = (killer.kills || 0) + 1;
    }
    saveEloData();
    broadcastLeaderboard();
  } else if (killer && killer.id !== player.id) {
    killer.kills = (killer.kills || 0) + 1;
  }

  // "playerDied" — explicit BR death event (never confused with old "died")
  io.to(player.id).emit('playerDied', {
    killer:       killer ? killer.name : 'zone',
    eloChange,
    finalRank:    player.finalRank,
    totalPlayers: total,
    kills:        player.kills || 0,
    ranked:       room.isRanked,
  });

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

  // Set rank 1 for all surviving players
  for (const p of alive) p.finalRank = 1;

  // Apply placement bonuses (ranked only)
  if (room.isRanked) {
    for (const p of Object.values(room.players)) {
      const idx   = Math.min((p.finalRank || 1) - 1, PLACEMENT_BONUS.length - 1);
      const bonus = PLACEMENT_BONUS[idx] || 0;
      if (bonus > 0) {
        const pData = getPlayerData(p.name);
        pData.elo  += bonus;
        p.elo       = pData.elo;
      }
    }
    saveEloData();
    broadcastLeaderboard();
  }

  // Count territory for stats
  const tc = {};
  for (let i = 0; i < room.grid.length; i++) { const t = room.grid[i]; if (t) tc[t] = (tc[t]||0)+1; }

  for (const p of Object.values(room.players)) {
    const won = alive.some(a => a.id === p.id);
    const pIdx   = Math.min((p.finalRank || 1) - 1, PLACEMENT_BONUS.length - 1);
    io.to(p.id).emit('gameOver', {
      won,
      kills: p.kills || 0,
      elo: p.elo,
      territory: tc[p.team] || 0,
      totalPlayers: total,
      finalRank: p.finalRank || 1,
      placementBonus: room.isRanked ? (PLACEMENT_BONUS[pIdx] || 0) : 0,
    });
  }
  // Wipe the room after a grace period
  setTimeout(() => rooms.delete(room.id), 10_000);
}

// ─── Game tick ────────────────────────────────────────────────────────────────
const OPP = { up:'down', down:'up', left:'right', right:'left' };

function gameTick() {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.phase === 'game') {
      tickRoom(r);
    } else if (r.phase === 'lobby') {
      checkLobbyCountdown(r, now);
      // Cleanup: delete empty rooms after 30 s
      const empty = Object.keys(r.lobby.players).length === 0;
      if (empty) {
        if (!r.lastEmptyAt) r.lastEmptyAt = now;
        else if (now - r.lastEmptyAt > 30_000) rooms.delete(r.id);
      } else {
        r.lastEmptyAt = null;
      }
    }
  }
}

function tickRoom(room) {
  if (room.gameOver) return;
  room.dirtySet.clear();
  for (const player of Object.values(room.players)) {
    if (!player.alive || player.waiting) continue;
    const inv = isProtected(player);
    if (player.nextDir !== OPP[player.direction]) player.direction = player.nextDir;
    let nx = player.x, ny = player.y;
    if (player.direction==='up') ny--; if (player.direction==='down') ny++;
    if (player.direction==='left') nx--; if (player.direction==='right') nx++;
    if (nx<0||nx>=GRID_SIZE||ny<0||ny>=GRID_SIZE) { if(!inv) killPlayer(room,player,null); continue; }
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
  io.to(room.id).emit('tick', { players: pStates, dirty });
}

// ─── Lobby helpers ────────────────────────────────────────────────────────────
function lobbySnapshot(room) {
  const count = Object.keys(room.lobby.players).length;
  const timeLeft = room.lobby.countdownAt ? Math.max(0, room.lobby.countdownAt - Date.now()) : null;
  if (room.isTeam) {
    const teams = { 1:[], 2:[], 3:[], 4:[] };
    for (const p of Object.values(room.lobby.players)) {
      if (p.team && teams[p.team]) teams[p.team].push({ id:p.id, name:p.name, ready:p.ready });
    }
    return { teams, teamDef: TEAM_DEF, roomNum: room.roomNum, playerCount: count,
             maxPlayers: MAX_PLAYERS, countdownMs: timeLeft, isTeam: true };
  }
  // Solo: flat player list
  const soloPlayers = Object.values(room.lobby.players).map(p => ({ id:p.id, name:p.name }));
  return { soloPlayers, roomNum: room.roomNum, playerCount: count,
           maxPlayers: MAX_PLAYERS, countdownMs: timeLeft, isTeam: false };
}

function broadcastLobbyUpdate(room) {
  io.to(room.id).emit('lobbyUpdate', lobbySnapshot(room));
}

function checkLobbyReady(room) {
  // Team mode: ≥2 teams where ALL players in that team have clicked ready
  const teamsReady = [1,2,3,4].filter(t => {
    const members = Object.values(room.lobby.players).filter(p => p.team === t);
    return members.length > 0 && members.every(p => p.ready);
  });
  return teamsReady.length >= 2;
}

function checkLobbyCountdown(room, now) {
  const count = Object.keys(room.lobby.players).length;
  if (count < 2) {
    if (room.lobby.countdownAt !== null) {
      room.lobby.countdownAt = null;
      broadcastLobbyUpdate(room);
    }
    return;
  }
  if (!room.lobby.countdownAt) {
    room.lobby.countdownAt = now + LOBBY_CD_MS;
    broadcastLobbyUpdate(room);
  } else if (now >= room.lobby.countdownAt) {
    startGameFromLobby(room);
  } else {
    // Broadcast countdown update every ~500 ms
    if (now - room.lobby.lastCdBroadcast > 500) {
      room.lobby.lastCdBroadcast = now;
      broadcastLobbyUpdate(room);
    }
  }
}

function startGameFromLobby(room) {
  room.phase = 'game';
  room.gameStartedAt = Date.now();

  for (const lp of Object.values(room.lobby.players)) {
    let teamId, color;
    if (room.isTeam) {
      if (!lp.team) continue; // must have chosen a team
      teamId = lp.team;
      color  = TEAM_DEF[teamId].color;
    } else {
      // Solo: assign a unique team ID so each player has distinct territory colour
      teamId = room.nextTeamId;
      room.nextTeamId = (room.nextTeamId % 254) + 1;
      color = lp.color || SOLO_COLOR_DEFAULT;
    }
    const startElo = getPlayerData(lp.name).elo;
    const gamePlayer = {
      id: lp.id, name: lp.name, team: teamId, color,
      elo: startElo, startElo, kills: 0, finalRank: 0, spectating: false,
      x:0, y:0, direction:'right', nextDir:'right',
      trail:[], alive:false, waiting:false, inTerritory:true, spawnedAt:0, roomId: room.id,
    };
    room.players[lp.id] = gamePlayer;
    spawnPlayer(room, gamePlayer);
  }
  room.peakPlayers = Object.keys(room.players).length;

  const pStates = Object.fromEntries(Object.entries(room.players).map(([id,p]) => [id, {
    id:p.id, name:p.name, team:p.team, color:p.color,
    x:p.x, y:p.y, direction:p.direction, trail:p.trail, alive:p.alive, waiting:p.waiting, elo:p.elo,
  }]));

  for (const lp of Object.values(room.lobby.players)) {
    if (room.isTeam && !lp.team) continue;
    const sock = io.sockets.sockets.get(lp.id);
    if (!sock) continue;
    sock.emit('init', {
      playerId: lp.id, grid: Array.from(room.grid), gridSize: GRID_SIZE,
      players: pStates, roomId: room.id, roomNum: room.roomNum,
      isTeam: room.isTeam, isRanked: room.isRanked, waitingForTeammate: false,
    });
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  const ip = getIp(socket);

  // ── Reject banned IPs immediately ──────────────────────────────────────────
  if (isIpBanned(ip)) {
    const ban = banStore[ip];
    socket.emit('kicked', { reason: 'Temporarily banned.', banned: true, until: ban.bannedUntil });
    socket.disconnect(true);
    return;
  }

  console.log('+ connected:', socket.id, ip);
  let playerRoomId  = null;
  let playerPhase   = null;   // 'lobby' | 'game'
  let playerNameStr = '?';    // for kick-log context

  // ── Rate-limiter wrapper (max RATE_LIMIT_MAX msgs/sec) ─────────────────────
  const rl = { count: 0, reset: Date.now() + 1000 };
  function on(event, handler) {
    socket.on(event, (...args) => {
      const now = Date.now();
      if (now >= rl.reset) { rl.count = 1; rl.reset = now + 1000; }
      else if (++rl.count > RATE_LIMIT_MAX) {
        kickSocket(socket, `Rate limit exceeded on '${event}'`, playerNameStr);
        return;
      }
      try { handler(...args); }
      catch(e) { console.error(`[Handler:${event}]`, e.message); }
    });
  }

  // ── Join lobby (all modes — solo and team both go through lobby) ──────────
  on('joinLobby', (data) => {
    if (!data || typeof data !== 'object') return;
    const safeName  = sanitizeName(data.name) || `P${Math.floor(Math.random()*999)}`;
    const isRanked  = data.ranked === true;
    const modeBase  = `${data.mode === 'team' ? 'team' : 'solo'}-${isRanked?'ranked':'chill'}`;
    const safeColor = SOLO_COLORS.has(data.color) ? data.color : SOLO_COLOR_DEFAULT;
    const room      = findOrCreateRoom(modeBase);
    playerRoomId = room.id; playerPhase = 'lobby'; playerNameStr = safeName;
    socket.join(room.id);
    room.lobby.players[socket.id] = { id:socket.id, name:safeName, team:null, ready:false, color:safeColor };
    socket.emit('lobbyJoined', { ...lobbySnapshot(room), teamDef:TEAM_DEF, isRanked,
      elo: getPlayerData(safeName).elo });
    broadcastLobbyUpdate(room);
  });

  // ── Team: choose team ──────────────────────────────────────────────────────
  on('chooseTeam', (data) => {
    if (!data || typeof data !== 'object') return;
    const team = data.team;
    // Strict validation: must be integer 1-4
    if (!Number.isInteger(team) || team < 1 || team > 4) return;
    if (!playerRoomId || playerPhase !== 'lobby') return;
    const room = rooms.get(playerRoomId);
    const lp   = room?.lobby.players[socket.id];
    if (!lp || !TEAM_DEF[team]) return;
    const count = Object.values(room.lobby.players).filter(p => p.team === team).length;
    if (count >= MAX_TEAM_SIZE) return;
    lp.team  = team;
    lp.color = TEAM_DEF[team].color;
    lp.ready = false;
    broadcastLobbyUpdate(room);
  });

  // ── Team: toggle ready ─────────────────────────────────────────────────────
  on('setReady', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!playerRoomId || playerPhase !== 'lobby') return;
    const room = rooms.get(playerRoomId);
    if (!room || !room.isTeam) return; // ready button only for team mode
    const lp = room.lobby.players[socket.id];
    if (!lp || !lp.team) return;
    lp.ready = data.ready === true;
    if (room.phase === 'lobby' && checkLobbyReady(room)) {
      startGameFromLobby(room);
    } else {
      broadcastLobbyUpdate(room);
    }
  });

  // ── Direction ──────────────────────────────────────────────────────────────
  on('direction', (dir) => {
    if (typeof dir !== 'string') return;
    const valid = ['up','down','left','right'];
    if (!valid.includes(dir) || !playerRoomId || playerPhase !== 'game') return;
    const room = rooms.get(playerRoomId);
    if (!room || room.gameOver) return;
    const player = room.players[socket.id];
    if (player?.alive && !player.waiting) player.nextDir = dir;
  });

  /** Shared cleanup: remove this socket from whatever room it's in. */
  function leaveRoom() {
    if (!playerRoomId) return;
    const room = rooms.get(playerRoomId);
    if (room) {
      // Game-phase cleanup
      const player = room.players[socket.id];
      if (player) {
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
      // Lobby-phase cleanup
      if (room.lobby?.players[socket.id]) {
        delete room.lobby.players[socket.id];
        // Cancel countdown if too few players remain
        if (Object.keys(room.lobby.players).length < 2) room.lobby.countdownAt = null;
        broadcastLobbyUpdate(room);
      }
      socket.leave(room.id);
    }
    playerRoomId = null; playerPhase = null;
  }

  // ── Leave lobby (back button while in lobby) ────────────────────────────────
  on('leaveLobby', leaveRoom);

  // ── Leave game / return to menu ────────────────────────────────────────────
  on('leaveGame',    leaveRoom);
  on('returnToMenu', leaveRoom);

  // ── Leaderboard room ───────────────────────────────────────────────────────
  on('joinLeaderboard', () => {
    socket.join(LB_ROOM);
    socket.emit('leaderboardUpdate', getTop100());
  });

  // ── Security alert from client (DOM injection detected) ───────────────────
  on('securityAlert', (data) => {
    if (!data || typeof data !== 'object') return;
    console.warn(`[SECURITY] ip=${ip} name=${playerNameStr} type=${data.type || '?'} detail=${String(data.detail || '').slice(0,80)}`);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('- disconnected:', socket.id, ip);
    leaveRoom();
  });
});

setInterval(gameTick, TICK_MS);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Zone.io running on http://localhost:${PORT}`));

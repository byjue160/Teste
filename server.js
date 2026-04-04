const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const GRID_SIZE = 100;
const TICK_MS = 100;
const ZONE_SHRINK_INTERVAL = 30000;
const RESPAWN_DELAY = 3000;
const START_HALF = 2;
const SPAWN_INVINCIBILITY_MS = 3000;
const MIN_TRAIL_FOR_SELF_KILL = 5;

// In solo mode: each player gets a unique team ID from a per-room counter (1–254).
// This prevents territory sharing between unrelated solo players.
// In team mode: teams 1–4, max 2 players per team, shared territory.

const TEAM_COLORS = {
  1: '#e74c3c', 2: '#3498db', 3: '#2ecc71',  4: '#f39c12',
  5: '#9b59b6', 6: '#1abc9c', 7: '#e67e22',  8: '#e91e63',
  9: '#00bcd4', 10:'#ff5722', 11:'#8bc34a',  12:'#673ab7',
};

function teamColor(id) {
  const keys = Object.keys(TEAM_COLORS);
  return TEAM_COLORS[id] || TEAM_COLORS[((id - 1) % keys.length) + 1] || '#aaa';
}

// Zone phases – radius in grid cells
const ZONE_PHASES = [
  Math.round(GRID_SIZE * 0.70),
  Math.round(GRID_SIZE * 0.55),
  Math.round(GRID_SIZE * 0.42),
  Math.round(GRID_SIZE * 0.30),
  Math.round(GRID_SIZE * 0.18),
  Math.round(GRID_SIZE * 0.08),
  0,
];

// Spawn anchors (team mode uses 1–4)
const SPAWN_ANCHORS_TEAM = {
  1: { x: 15, y: 15 },
  2: { x: 84, y: 84 },
  3: { x: 84, y: 15 },
  4: { x: 15, y: 84 },
};

// ─── ELO store (global, persists by name across sessions) ─────────────────────
const eloStore = {};

// ─── Room factory ─────────────────────────────────────────────────────────────
// roomId = 'solo-ranked' | 'solo-chill' | 'team-ranked' | 'team-chill'
const rooms = new Map();

function createRoom(roomId) {
  const [mode, rank] = roomId.split('-');
  return {
    id: roomId,
    isTeam:   mode === 'team',
    isRanked: rank === 'ranked',
    grid:         new Uint8Array(GRID_SIZE * GRID_SIZE),
    dirtySet:     new Set(),
    zone:         { cx: GRID_SIZE / 2, cy: GRID_SIZE / 2, radius: ZONE_PHASES[0] },
    zonePhaseIdx: 0,
    nextShrinkAt: null,   // null until first active player
    gameStartedAt: null,
    players:      {},     // socketId → player
    nextTeamId:   1,      // counter for solo unique team IDs
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
  if (room.zone.radius <= 0) return true; // fully collapsed → treat as safe
  const dx = (x + 0.5) - room.zone.cx;
  const dy = (y + 0.5) - room.zone.cy;
  return dx * dx + dy * dy <= room.zone.radius * room.zone.radius;
}

function isProtected(player) {
  return Date.now() - player.spawnedAt < SPAWN_INVINCIBILITY_MS;
}

// ─── Team assignment ──────────────────────────────────────────────────────────
function assignTeam(room) {
  if (!room.isTeam) {
    // Solo: unique colour per player (wraps at 254 to stay in Uint8 range)
    const id = room.nextTeamId;
    room.nextTeamId = (room.nextTeamId % 254) + 1;
    return id;
  }
  // Team 2v2: balance teams 1–4, max 2 per team
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of Object.values(room.players)) {
    if (counts[p.team] !== undefined) counts[p.team]++;
  }
  let best = 1;
  for (let t = 2; t <= 4; t++) {
    if (counts[t] < counts[best]) best = t;
  }
  return best;
}

// ─── Spawn ────────────────────────────────────────────────────────────────────
function getSpawnPos(room, team) {
  // Use anchor only in team mode; solo players scatter more
  const anchor = room.isTeam
    ? (SPAWN_ANCHORS_TEAM[team] || { x: 50, y: 50 })
    : { x: 10 + Math.floor(Math.random() * 80), y: 10 + Math.floor(Math.random() * 80) };

  const jitter = () => Math.floor(Math.random() * 10) - 5;
  let x = anchor.x + (room.isTeam ? jitter() : 0);
  let y = anchor.y + (room.isTeam ? jitter() : 0);

  // Clamp inside zone with margin for 5×5 territory block
  const safeR = Math.max(0, room.zone.radius - START_HALF - 2);
  if (safeR > 0) {
    const dx = (x + 0.5) - room.zone.cx;
    const dy = (y + 0.5) - room.zone.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > safeR) {
      const scale = safeR / dist;
      x = Math.round(room.zone.cx + dx * scale - 0.5);
      y = Math.round(room.zone.cy + dy * scale - 0.5);
    }
  } else {
    x = Math.round(room.zone.cx);
    y = Math.round(room.zone.cy);
  }

  x = Math.min(GRID_SIZE - START_HALF - 2, Math.max(START_HALF + 1, x));
  y = Math.min(GRID_SIZE - START_HALF - 2, Math.max(START_HALF + 1, y));
  return { x, y };
}

function giveStartingTerritory(room, player) {
  for (let dy = -START_HALF; dy <= START_HALF; dy++)
    for (let dx = -START_HALF; dx <= START_HALF; dx++)
      sc(room, player.x + dx, player.y + dy, player.team);
}

function spawnPlayer(room, player) {
  const pos = getSpawnPos(room, player.team);
  player.x = pos.x;
  player.y = pos.y;
  player.direction  = 'right';
  player.nextDir    = 'right';
  player.trail      = [];
  player.inTerritory = true;
  player.alive      = true;
  player.waiting    = false;
  player.spawnedAt  = Date.now();
  giveStartingTerritory(room, player);
}

// ─── Territory capture ────────────────────────────────────────────────────────
function captureTerritory(room, player) {
  if (!player.trail.length) return;
  const team = player.team;

  const temp    = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const outside = new Uint8Array(GRID_SIZE * GRID_SIZE);

  for (let i = 0; i < room.grid.length; i++)
    if (room.grid[i] === team) temp[i] = 1;
  for (const c of player.trail)
    temp[c.y * GRID_SIZE + c.x] = 2;

  const queue = [];
  const enq = (idx) => {
    if (!outside[idx] && temp[idx] === 0) { outside[idx] = 1; queue.push(idx); }
  };
  for (let x = 0; x < GRID_SIZE; x++) {
    enq(x); enq((GRID_SIZE - 1) * GRID_SIZE + x);
  }
  for (let y = 1; y < GRID_SIZE - 1; y++) {
    enq(y * GRID_SIZE); enq(y * GRID_SIZE + GRID_SIZE - 1);
  }
  while (queue.length) {
    const idx = queue.pop();
    const cy = (idx / GRID_SIZE) | 0, cx = idx % GRID_SIZE;
    if (cx > 0)           enq(idx - 1);
    if (cx < GRID_SIZE-1) enq(idx + 1);
    if (cy > 0)           enq(idx - GRID_SIZE);
    if (cy < GRID_SIZE-1) enq(idx + GRID_SIZE);
  }

  for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
    if (temp[i] === 2 || (temp[i] === 0 && !outside[i])) {
      if (temp[i] === 0 && !outside[i] && room.grid[i] !== team) {
        const cx = i % GRID_SIZE, cy = (i / GRID_SIZE) | 0;
        for (const p of Object.values(room.players))
          if (isEnemy(room, player, p) && p.alive && p.x === cx && p.y === cy)
            killPlayer(room, p, player);
      }
      if (room.grid[i] !== team) { room.grid[i] = team; room.dirtySet.add(i); }
    }
  }
  player.trail = [];
  player.inTerritory = true;
}

// ─── Enemy detection (respects solo/team rules) ───────────────────────────────
function isEnemy(room, a, b) {
  if (a.id === b.id) return false;
  if (!b.alive || b.waiting) return false;
  // In team mode, same team = friendly. In solo, each has unique team so always enemy.
  return a.team !== b.team;
}

// ─── Kill / respawn ───────────────────────────────────────────────────────────
function killPlayer(room, player, killer) {
  if (!player.alive) return;

  player.trail = [];
  player.alive = false;

  // Erase territory only when no living teammate remains
  const hasLivingTeammate = Object.values(room.players).some(
    p => p.id !== player.id && p.team === player.team && p.alive
  );
  if (!hasLivingTeammate) {
    for (let i = 0; i < room.grid.length; i++) {
      if (room.grid[i] === player.team) { room.grid[i] = 0; room.dirtySet.add(i); }
    }
  }

  // ELO only in ranked rooms
  if (room.isRanked) {
    player.elo = Math.max(0, player.elo - 20);
    eloStore[player.name] = player.elo;
    if (killer && killer.id !== player.id) {
      killer.elo += 25;
      eloStore[killer.name] = killer.elo;
    }
  }

  io.to(player.id).emit('died', {
    killedBy: killer ? killer.name : 'zone',
    elo:      player.elo,
    ranked:   room.isRanked,
  });

  setTimeout(() => {
    if (room.players[player.id]) {
      spawnPlayer(room, player);
      io.to(player.id).emit('respawned');
    }
  }, RESPAWN_DELAY);
}

// ─── Zone shrink (checked each tick) ─────────────────────────────────────────
function tryShrinkZone(room) {
  const now = Date.now();
  if (room.nextShrinkAt === null || now < room.nextShrinkAt) return;

  const activePlayers = Object.values(room.players).filter(p => p.alive && !p.waiting).length;

  // Conditions: ≥2 active players AND game has been running ≥30 s
  if (activePlayers < 2 || !room.gameStartedAt || now - room.gameStartedAt < ZONE_SHRINK_INTERVAL) {
    room.nextShrinkAt = now + ZONE_SHRINK_INTERVAL;
    io.to(room.id).emit('zoneUpdate', { zone: room.zone, timeToShrink: ZONE_SHRINK_INTERVAL });
    return;
  }

  room.zonePhaseIdx = Math.min(room.zonePhaseIdx + 1, ZONE_PHASES.length - 1);
  room.zone.radius  = ZONE_PHASES[room.zonePhaseIdx];
  room.nextShrinkAt = now + ZONE_SHRINK_INTERVAL;

  for (const p of Object.values(room.players))
    if (p.alive && !isProtected(p) && !isInZone(room, p.x, p.y))
      killPlayer(room, p, null);

  io.to(room.id).emit('zoneUpdate', { zone: room.zone, timeToShrink: ZONE_SHRINK_INTERVAL });
}

// ─── Game tick ────────────────────────────────────────────────────────────────
function gameTick() {
  for (const room of rooms.values()) tickRoom(room);
}

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function tickRoom(room) {
  room.dirtySet.clear();
  tryShrinkZone(room);

  for (const player of Object.values(room.players)) {
    if (!player.alive || player.waiting) continue;

    const inv = isProtected(player);

    if (player.nextDir !== OPPOSITE[player.direction]) player.direction = player.nextDir;

    let nx = player.x, ny = player.y;
    if (player.direction === 'up')    ny--;
    if (player.direction === 'down')  ny++;
    if (player.direction === 'left')  nx--;
    if (player.direction === 'right') nx++;

    // Wall death (invincibility doesn't bypass walls)
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
      if (!inv) killPlayer(room, player, null);
      continue;
    }

    // Zone death
    if (!inv && !isInZone(room, nx, ny)) {
      killPlayer(room, player, null);
      continue;
    }

    // Self-trail death (only when trail is long enough)
    if (!inv && player.trail.length >= MIN_TRAIL_FOR_SELF_KILL) {
      if (player.trail.some(c => c.x === nx && c.y === ny)) {
        killPlayer(room, player, null);
        continue;
      }
    }

    // Cut an enemy's trail → enemy dies
    for (const other of Object.values(room.players)) {
      if (!isEnemy(room, player, other)) continue;
      if (other.trail.some(c => c.x === nx && c.y === ny)) {
        killPlayer(room, other, player);
      }
    }
    if (!player.alive) continue;

    player.x = nx;
    player.y = ny;

    const ownCell = gc(room, nx, ny) === player.team;

    if (ownCell) {
      if (!player.inTerritory && player.trail.length > 0) captureTerritory(room, player);
      player.inTerritory = true;
    } else {
      player.inTerritory = false;
      if (!player.trail.some(c => c.x === nx && c.y === ny))
        player.trail.push({ x: nx, y: ny });

      // Head-on head: enemy already at this cell
      if (!inv) {
        for (const other of Object.values(room.players)) {
          if (!isEnemy(room, player, other)) continue;
          if (other.x === nx && other.y === ny) { killPlayer(room, player, other); break; }
        }
      }
    }
  }

  // Broadcast
  const pStates = {};
  for (const [id, p] of Object.entries(room.players)) {
    pStates[id] = {
      id: p.id, name: p.name, team: p.team,
      x: p.x, y: p.y, direction: p.direction,
      trail: p.trail, alive: p.alive, waiting: p.waiting, elo: p.elo,
    };
  }
  const dirty = [];
  for (const idx of room.dirtySet) dirty.push({ i: idx, t: room.grid[idx] });

  io.to(room.id).emit('tick', {
    players: pStates,
    dirty,
    zone: room.zone,
    timeToShrink: room.nextShrinkAt
      ? Math.max(0, room.nextShrinkAt - Date.now())
      : ZONE_SHRINK_INTERVAL,
  });
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('+ connected:', socket.id);
  let playerRoomId = null; // track which room this socket is in

  socket.on('join', ({ name, mode, ranked }) => {
    const safeName  = (name  || '').trim().slice(0, 15) || `P${Math.floor(Math.random() * 999)}`;
    const isTeam    = mode   === 'team';
    const isRanked  = ranked === true;
    const roomId    = `${isTeam ? 'team' : 'solo'}-${isRanked ? 'ranked' : 'chill'}`;

    playerRoomId = roomId;
    const room = getRoom(roomId);
    socket.join(roomId);

    const team = assignTeam(room);
    const elo  = eloStore[safeName] || 1000;

    const player = {
      id: socket.id, name: safeName, team, elo,
      x: 0, y: 0,
      direction: 'right', nextDir: 'right',
      trail: [], alive: false, waiting: false,
      inTerritory: true, spawnedAt: 0,
      roomId,
    };
    room.players[socket.id] = player;

    // ── Team-mode: wait for teammate ──
    let waitingForTeammate = false;
    if (isTeam) {
      const sameTeam = Object.values(room.players).filter(
        p => p.id !== socket.id && p.team === team
      );
      if (sameTeam.length === 0) {
        // First of this team → wait
        player.waiting = true;
        player.alive   = false;
        waitingForTeammate = true;
      } else {
        // Has at least one partner → wake up any waiting teammate
        for (const tm of sameTeam) {
          if (tm.waiting) {
            tm.waiting = false;
            spawnPlayer(room, tm);
            io.to(tm.id).emit('teammateJoined', { name: safeName });
          }
        }
      }
    }

    if (!waitingForTeammate) {
      spawnPlayer(room, player);
      if (!room.gameStartedAt) {
        room.gameStartedAt = Date.now();
        room.nextShrinkAt  = room.gameStartedAt + ZONE_SHRINK_INTERVAL;
      }
    }

    // Full initial state
    socket.emit('init', {
      playerId: socket.id,
      grid:     Array.from(room.grid),
      gridSize: GRID_SIZE,
      players:  Object.fromEntries(
        Object.entries(room.players).map(([id, p]) => [id, {
          id: p.id, name: p.name, team: p.team,
          x: p.x, y: p.y, direction: p.direction,
          trail: p.trail, alive: p.alive, waiting: p.waiting, elo: p.elo,
        }])
      ),
      zone:     room.zone,
      timeToShrink: room.nextShrinkAt
        ? Math.max(0, room.nextShrinkAt - Date.now())
        : ZONE_SHRINK_INTERVAL,
      roomId, isTeam, isRanked,
      waitingForTeammate,
    });

    socket.broadcast.to(roomId).emit('playerJoined', {
      id: socket.id, name: safeName, team,
      x: player.x, y: player.y,
      trail: [], alive: !waitingForTeammate, waiting: waitingForTeammate, elo,
    });
  });

  socket.on('direction', (dir) => {
    if (!playerRoomId) return;
    const valid = ['up', 'down', 'left', 'right'];
    if (!valid.includes(dir)) return;
    const room   = rooms.get(playerRoomId);
    const player = room?.players[socket.id];
    if (player?.alive && !player.waiting) player.nextDir = dir;
  });

  socket.on('disconnect', () => {
    console.log('- disconnected:', socket.id);
    if (!playerRoomId) return;
    const room   = rooms.get(playerRoomId);
    const player = room?.players[socket.id];
    if (!player) return;

    if (room.isRanked) eloStore[player.name] = player.elo;

    const hasLivingTeammate = Object.values(room.players).some(
      p => p.id !== socket.id && p.team === player.team && p.alive
    );
    if (!hasLivingTeammate) {
      for (let i = 0; i < room.grid.length; i++) {
        if (room.grid[i] === player.team) { room.grid[i] = 0; room.dirtySet.add(i); }
      }
    }

    delete room.players[socket.id];
    io.to(room.id).emit('playerLeft', { id: socket.id });
  });
});

// ─── Start loop ───────────────────────────────────────────────────────────────
setInterval(gameTick, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Zone.io running on http://localhost:${PORT}`));

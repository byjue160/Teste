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
const TICK_MS = 100;           // 10 ticks/sec
const ZONE_SHRINK_INTERVAL = 30000; // 30 s
const RESPAWN_DELAY = 3000;
const START_HALF = 2;          // half-size of starting 5×5 territory

const TEAMS = {
  1: { name: 'Red',   color: '#e74c3c' },
  2: { name: 'Blue',  color: '#3498db' },
  3: { name: 'Green', color: '#2ecc71' },
  4: { name: 'Gold',  color: '#f39c12' },
};

// Spawn anchors per team (grid coords)
const SPAWN_ANCHORS = {
  1: { x: 15, y: 15 },
  2: { x: 84, y: 84 },
  3: { x: 84, y: 15 },
  4: { x: 15, y: 84 },
};

// Zone phases – each phase is the new radius (in grid cells)
const ZONE_PHASES = [
  Math.round(GRID_SIZE * 0.70),
  Math.round(GRID_SIZE * 0.55),
  Math.round(GRID_SIZE * 0.42),
  Math.round(GRID_SIZE * 0.30),
  Math.round(GRID_SIZE * 0.18),
  Math.round(GRID_SIZE * 0.08),
  0,
];

// ─── Game State ───────────────────────────────────────────────────────────────
let grid = new Uint8Array(GRID_SIZE * GRID_SIZE); // 0 = neutral, 1-4 = team
let dirtySet = new Set();

let zone = { cx: GRID_SIZE / 2, cy: GRID_SIZE / 2, radius: ZONE_PHASES[0] };
let zonePhaseIdx = 0;
let nextShrinkAt = Date.now() + ZONE_SHRINK_INTERVAL;

let players = {};    // socketId → player
let eloStore = {};   // name → ELO (persists across respawns)

// ─── Grid helpers ─────────────────────────────────────────────────────────────
function getCell(x, y) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return -1;
  return grid[y * GRID_SIZE + x];
}

function setCell(x, y, team) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
  const idx = y * GRID_SIZE + x;
  if (grid[idx] !== team) {
    grid[idx] = team;
    dirtySet.add(idx);
  }
}

function isInZone(x, y) {
  if (zone.radius <= 0) return false;
  const dx = (x + 0.5) - zone.cx;
  const dy = (y + 0.5) - zone.cy;
  return dx * dx + dy * dy <= zone.radius * zone.radius;
}

// ─── Team assignment ──────────────────────────────────────────────────────────
function assignTeam() {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of Object.values(players)) counts[p.team]++;
  let best = 1;
  for (let t = 2; t <= 4; t++) {
    if (counts[t] < counts[best]) best = t;
  }
  return best;
}

// ─── Spawn ────────────────────────────────────────────────────────────────────
function getSpawnPos(team) {
  const anchor = SPAWN_ANCHORS[team] || { x: 50, y: 50 };
  const jitter = () => Math.floor(Math.random() * 10) - 5;
  const x = Math.min(GRID_SIZE - START_HALF - 2, Math.max(START_HALF + 1, anchor.x + jitter()));
  const y = Math.min(GRID_SIZE - START_HALF - 2, Math.max(START_HALF + 1, anchor.y + jitter()));
  return { x, y };
}

function giveStartingTerritory(player) {
  for (let dy = -START_HALF; dy <= START_HALF; dy++) {
    for (let dx = -START_HALF; dx <= START_HALF; dx++) {
      setCell(player.x + dx, player.y + dy, player.team);
    }
  }
}

function spawnPlayer(player) {
  const pos = getSpawnPos(player.team);
  player.x = pos.x;
  player.y = pos.y;
  player.direction = 'right';
  player.nextDir = 'right';
  player.trail = [];
  player.inTerritory = true;
  player.alive = true;
  giveStartingTerritory(player);
}

// ─── Territory capture ────────────────────────────────────────────────────────
function captureTerritory(player) {
  if (player.trail.length === 0) return;

  const team = player.team;
  // Build a temp map: 0 = passable (not owned, not trail), 1 = owned, 2 = trail
  const temp = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === team) temp[i] = 1;
  }
  for (const c of player.trail) {
    temp[c.y * GRID_SIZE + c.x] = 2;
  }

  // Flood-fill from all 4 borders marking "outside" passable cells
  const outside = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const queue = [];

  const enqueue = (idx) => {
    if (!outside[idx] && temp[idx] === 0) {
      outside[idx] = 1;
      queue.push(idx);
    }
  };

  for (let x = 0; x < GRID_SIZE; x++) {
    enqueue(x);
    enqueue((GRID_SIZE - 1) * GRID_SIZE + x);
  }
  for (let y = 1; y < GRID_SIZE - 1; y++) {
    enqueue(y * GRID_SIZE);
    enqueue(y * GRID_SIZE + GRID_SIZE - 1);
  }

  while (queue.length > 0) {
    const idx = queue.pop();
    const cy = Math.floor(idx / GRID_SIZE);
    const cx = idx % GRID_SIZE;
    if (cx > 0)            enqueue(idx - 1);
    if (cx < GRID_SIZE-1)  enqueue(idx + 1);
    if (cy > 0)            enqueue(idx - GRID_SIZE);
    if (cy < GRID_SIZE-1)  enqueue(idx + GRID_SIZE);
  }

  // Capture enclosed cells + trail cells
  for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
    if (temp[i] === 2 || (temp[i] === 0 && !outside[i])) {
      // Kill any enemy whose head is on a newly captured cell
      if (temp[i] === 0 && !outside[i] && grid[i] !== team) {
        const cx = i % GRID_SIZE;
        const cy = Math.floor(i / GRID_SIZE);
        for (const p of Object.values(players)) {
          if (p.team !== team && p.alive && p.x === cx && p.y === cy) {
            killPlayer(p, player);
          }
        }
      }
      if (grid[i] !== team) {
        grid[i] = team;
        dirtySet.add(i);
      }
    }
  }

  player.trail = [];
  player.inTerritory = true;
}

// ─── Kill / respawn ───────────────────────────────────────────────────────────
function killPlayer(player, killer) {
  if (!player.alive) return;

  player.trail = [];
  player.alive = false;

  // Erase territory only if no living teammate remains
  const teammates = Object.values(players).filter(
    p => p.id !== player.id && p.team === player.team && p.alive
  );
  if (teammates.length === 0) {
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === player.team) {
        grid[i] = 0;
        dirtySet.add(i);
      }
    }
  }

  // ELO
  player.elo = Math.max(0, player.elo - 20);
  eloStore[player.name] = player.elo;
  if (killer) {
    killer.elo += 25;
    eloStore[killer.name] = killer.elo;
  }

  io.to(player.id).emit('died', {
    killedBy: killer ? killer.name : 'zone',
    elo: player.elo,
  });

  // Respawn after delay
  setTimeout(() => {
    if (players[player.id]) {
      spawnPlayer(player);
      io.to(player.id).emit('respawned');
    }
  }, RESPAWN_DELAY);
}

// ─── Game tick ────────────────────────────────────────────────────────────────
function gameTick() {
  dirtySet.clear();

  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  for (const player of Object.values(players)) {
    if (!player.alive) continue;

    // Apply queued direction (disallow 180°)
    if (player.nextDir !== OPPOSITE[player.direction]) {
      player.direction = player.nextDir;
    }

    // Compute new position
    let nx = player.x, ny = player.y;
    if (player.direction === 'up')    ny--;
    if (player.direction === 'down')  ny++;
    if (player.direction === 'left')  nx--;
    if (player.direction === 'right') nx++;

    // Wall death
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
      killPlayer(player, null);
      continue;
    }

    // Zone death
    if (!isInZone(nx, ny)) {
      killPlayer(player, null);
      continue;
    }

    // Self-trail death
    if (player.trail.some(c => c.x === nx && c.y === ny)) {
      killPlayer(player, null);
      continue;
    }

    // Enemy-trail death (check if we hit another player's trail)
    let hitEnemy = false;
    for (const other of Object.values(players)) {
      if (other.id === player.id || !other.alive || other.team === player.team) continue;
      if (other.trail.some(c => c.x === nx && c.y === ny)) {
        killPlayer(other, player); // we cut their trail → they die
      }
    }
    if (!player.alive) continue;

    // Move
    player.x = nx;
    player.y = ny;

    const cellTeam = getCell(nx, ny);
    const ownCell = cellTeam === player.team;

    if (ownCell) {
      if (!player.inTerritory && player.trail.length > 0) {
        captureTerritory(player);
      }
      player.inTerritory = true;
    } else {
      player.inTerritory = false;
      if (!player.trail.some(c => c.x === nx && c.y === ny)) {
        player.trail.push({ x: nx, y: ny });
      }

      // Check if an enemy's head just landed on our freshly added trail cell
      for (const other of Object.values(players)) {
        if (other.id === player.id || !other.alive || other.team === player.team) continue;
        if (other.x === nx && other.y === ny) {
          killPlayer(player, other);
          break;
        }
      }
    }
  }

  // Build serialisable player map
  const pStates = {};
  for (const [id, p] of Object.entries(players)) {
    pStates[id] = {
      id: p.id, name: p.name, team: p.team,
      x: p.x, y: p.y,
      direction: p.direction,
      trail: p.trail,
      alive: p.alive,
      elo: p.elo,
    };
  }

  // Delta grid
  const dirty = [];
  for (const idx of dirtySet) {
    dirty.push({ i: idx, t: grid[idx] });
  }

  io.emit('tick', {
    players: pStates,
    dirty,
    zone,
    timeToShrink: Math.max(0, nextShrinkAt - Date.now()),
  });
}

// ─── Zone shrink ──────────────────────────────────────────────────────────────
function shrinkZone() {
  zonePhaseIdx = Math.min(zonePhaseIdx + 1, ZONE_PHASES.length - 1);
  zone.radius = ZONE_PHASES[zonePhaseIdx];
  nextShrinkAt = Date.now() + ZONE_SHRINK_INTERVAL;

  // Kill everyone outside
  for (const p of Object.values(players)) {
    if (p.alive && !isInZone(p.x, p.y)) killPlayer(p, null);
  }

  io.emit('zoneUpdate', { zone, timeToShrink: ZONE_SHRINK_INTERVAL });
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('+ connected:', socket.id);

  socket.on('join', ({ name }) => {
    const safeName = (name || '').trim().slice(0, 15) || `P${Math.floor(Math.random() * 999)}`;
    const team = assignTeam();
    const elo = eloStore[safeName] || 1000;

    const player = {
      id: socket.id,
      name: safeName,
      team,
      elo,
      x: 0, y: 0,
      direction: 'right',
      nextDir: 'right',
      trail: [],
      alive: false,
      inTerritory: true,
    };

    players[socket.id] = player;
    spawnPlayer(player);

    // Full initial state
    socket.emit('init', {
      playerId: socket.id,
      grid: Array.from(grid),
      gridSize: GRID_SIZE,
      teams: TEAMS,
      players: Object.fromEntries(
        Object.entries(players).map(([id, p]) => [id, {
          id: p.id, name: p.name, team: p.team,
          x: p.x, y: p.y, direction: p.direction,
          trail: p.trail, alive: p.alive, elo: p.elo,
        }])
      ),
      zone,
      timeToShrink: Math.max(0, nextShrinkAt - Date.now()),
    });

    socket.broadcast.emit('playerJoined', {
      id: socket.id, name: safeName, team,
      x: player.x, y: player.y,
      trail: [], alive: true, elo,
    });
  });

  socket.on('direction', (dir) => {
    const valid = ['up', 'down', 'left', 'right'];
    if (valid.includes(dir) && players[socket.id]?.alive) {
      players[socket.id].nextDir = dir;
    }
  });

  socket.on('disconnect', () => {
    console.log('- disconnected:', socket.id);
    const player = players[socket.id];
    if (!player) return;

    eloStore[player.name] = player.elo;

    // Remove territory if last of team
    const teammates = Object.values(players).filter(
      p => p.id !== socket.id && p.team === player.team && p.alive
    );
    if (teammates.length === 0) {
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === player.team) {
          grid[i] = 0;
          dirtySet.add(i);
        }
      }
    }

    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

// ─── Start loops ──────────────────────────────────────────────────────────────
setInterval(gameTick, TICK_MS);
setInterval(shrinkZone, ZONE_SHRINK_INTERVAL);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Zone.io running on http://localhost:${PORT}`);
});

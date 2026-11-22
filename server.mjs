// server.mjs — authoritative server for the tactical FPS POC.
//
// Serves the static client (public/) plus Three.js from local node_modules
// (no CDN, so the game works on a LAN without internet), and runs the
// WebSocket game server on the same port.
//
// The server is authoritative for: match/round state, the round timer,
// health, ammo, score and win conditions. Solo mode is a per-player flag:
// a solo player explores the map alone, outside any match, and can neither
// shoot nor be shot. Clients simulate their own movement and send position
// updates; the server relays snapshots.
// Shooting: the client raycasts locally and sends a shot claim; the server
// validates it (shooter alive, target alive, different teams, ammo left,
// round active, fire-rate plausible) and applies damage.
//
// This is a POC: validation is about keeping the game coherent, not about
// stopping a determined cheater.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SPAWNS, objectiveContains } from './public/map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8020);
// Tunable through env for the headless test; defaults are the game spec.
const ROUND_MS = Number(process.env.ROUND_MS || 5 * 60 * 1000);
const INTERMISSION_MS = Number(process.env.INTERMISSION_MS || 10 * 1000);
const RELOAD_MS = 3500;
const WIN_SCORE = 3;
const MAX_PER_TEAM = 6;
const FIRE_INTERVAL_MS = 90; // server-side plausibility floor (~11 shots/sec max)
const TICK_MS = 66; // ~15 snapshots per second
// Damage falloff by distance (shooter to target, metres):
//   close (<= 15 m): 100 damage — 1 hit kills
//   medium (15–50 m): 50 damage — 2 hits kill
//   long (> 50 m): 34 damage — 3 hits kill (34 x 3 = 102 >= 100)
const DAMAGE_CLOSE = 100;
const DAMAGE_MEDIUM = 50;
const DAMAGE_LONG = 34;
const RANGE_CLOSE_M = 15;
const RANGE_MEDIUM_M = 50;

function damageForDistance(d) {
  if (d <= RANGE_CLOSE_M) return DAMAGE_CLOSE;
  if (d <= RANGE_MEDIUM_M) return DAMAGE_MEDIUM;
  return DAMAGE_LONG;
}
const MAG_SIZE = 29;
const MAG_COUNT = 6; // 1 loaded + 5 spare

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
// Teams are 'A' and 'B' in the lobby. The host picks which team attacks;
// roles stay fixed for the whole match. Score is tracked per team.

const players = new Map(); // id -> player object
let nextId = 1;
let hostId = null;
let attackersTeam = 'A';
let phase = 'lobby'; // 'lobby' | 'playing' | 'intermission' | 'ended'
let round = 0;
let score = { A: 0, B: 0 };
let roundEndsAt = 0;
let intermissionEndsAt = 0;
let roundWinner = null; // 'A' | 'B' | null
let roundReason = ''; // 'elimination' | 'objective' | 'timeout'
let matchWinner = null;

function teamOf(p) {
  return p.team;
}

function roleOf(team) {
  return team === attackersTeam ? 'attackers' : 'defenders';
}

function playersOf(team) {
  return [...players.values()]
    .filter((p) => p.team === team)
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

function commanderOf(team) {
  const list = playersOf(team);
  return list.length ? list[0] : null;
}

function aliveOf(team) {
  return playersOf(team).filter((p) => p.alive);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === 1) p.ws.send(text);
  }
}

// Full state snapshot: everything except live positions (those come in the
// 15 Hz snapshot). Sent on joins, team changes and phase transitions.
function publicState() {
  return {
    t: 'state',
    phase,
    round,
    score: { ...score },
    attackersTeam,
    roundEndsAt,
    intermissionEndsAt,
    roundWinner,
    roundReason,
    matchWinner,
    hostId,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      solo: p.solo,
      role: p.solo ? null : roleOf(p.team),
      commander: !p.solo && commanderOf(p.team)?.id === p.id,
      host: p.id === hostId,
      alive: p.alive,
      health: p.health,
      inMag: p.inMag,
      mags: p.mags,
      reloading: Date.now() < p.reloadingUntil,
    })),
  };
}

function broadcastState() {
  broadcast(publicState());
}

function snapshot() {
  const now = Date.now();
  return {
    t: 'snapshot',
    phase,
    round,
    score: { ...score },
    timeLeftMs: phase === 'playing' ? Math.max(0, roundEndsAt - now) : 0,
    intermissionLeftMs: phase === 'intermission' ? Math.max(0, intermissionEndsAt - now) : 0,
    players: [...players.values()].map((p) => ({
      id: p.id,
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      yaw: p.yaw,
      pitch: p.pitch,
      alive: p.alive,
      health: p.health,
      inMag: p.inMag,
      mags: p.mags,
      reloading: now < p.reloadingUntil,
    })),
  };
}

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

function resetPlayerForRound(p) {
  const role = roleOf(p.team);
  const mates = playersOf(p.team);
  const index = mates.findIndex((m) => m.id === p.id);
  const spawn = SPAWNS[role][Math.min(index, SPAWNS[role].length - 1)];
  p.alive = true;
  p.health = 100;
  p.inMag = MAG_SIZE;
  p.mags = MAG_COUNT - 1; // spares; one mag is loaded
  p.reloadingUntil = 0;
  p.lastShotAt = 0;
  p.pos = { x: spawn.x, y: 0, z: spawn.z };
  p.yaw = spawn.yaw;
  p.pitch = 0;
}

function startRound(n) {
  // If a team emptied out during the intermission, abandon the match.
  if (playersOf('A').length === 0 || playersOf('B').length === 0) {
    phase = 'lobby';
    round = 0;
    score = { A: 0, B: 0 };
    matchWinner = null;
    roundWinner = null;
    roundReason = '';
    broadcastState();
    return;
  }
  round = n;
  phase = 'playing';
  roundWinner = null;
  roundReason = '';
  for (const p of players.values()) {
    if (p.solo) continue; // solo players keep exploring, untouched by rounds
    resetPlayerForRound(p);
  }
  roundEndsAt = Date.now() + ROUND_MS;
  broadcastState();
  broadcast({ t: 'roundStart', round });
}

function startMatch() {
  score = { A: 0, B: 0 };
  matchWinner = null;
  startRound(1);
}

function endRound(winnerTeam, reason) {
  if (phase !== 'playing') return;
  score[winnerTeam] += 1;
  roundWinner = winnerTeam;
  roundReason = reason;
  broadcast({ t: 'roundEnd', winner: winnerTeam, reason, score: { ...score } });
  if (score[winnerTeam] >= WIN_SCORE) {
    phase = 'ended';
    matchWinner = winnerTeam;
    broadcast({ t: 'matchEnd', winner: winnerTeam, score: { ...score } });
  } else {
    phase = 'intermission';
    intermissionEndsAt = Date.now() + INTERMISSION_MS;
  }
  broadcastState();
}

// After a kill or a disconnect: if a team has no living players left while
// the other team still has at least one, the round is over.
function checkElimination() {
  if (phase !== 'playing') return;
  const aAlive = aliveOf('A').length;
  const bAlive = aliveOf('B').length;
  const aTotal = playersOf('A').length;
  const bTotal = playersOf('B').length;
  if (aTotal > 0 && aAlive === 0 && bAlive > 0) endRound('B', 'elimination');
  else if (bTotal > 0 && bAlive === 0 && aAlive > 0) endRound('A', 'elimination');
  else if (aTotal === 0 && bTotal > 0) endRound('B', 'elimination');
  else if (bTotal === 0 && aTotal > 0) endRound('A', 'elimination');
}

// ---------------------------------------------------------------------------
// Tick: snapshot broadcast, reload completion, timer, intermission
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();

  // Complete reloads.
  for (const p of players.values()) {
    if (p.reloadingUntil && now >= p.reloadingUntil) {
      p.reloadingUntil = 0;
      if (p.alive && (phase === 'playing' || p.solo) && p.mags > 0) {
        p.mags -= 1;
        p.inMag = MAG_SIZE;
        broadcast({ t: 'reloaded', playerId: p.id, inMag: p.inMag, mags: p.mags });
      }
    }
  }

  if (phase === 'playing' && now >= roundEndsAt) {
    // Time expired: the defenders survived.
    const defendersTeam = attackersTeam === 'A' ? 'B' : 'A';
    endRound(defendersTeam, 'timeout');
  } else if (phase === 'intermission' && now >= intermissionEndsAt) {
    startRound(round + 1);
  }

  if (players.size > 0) broadcast(snapshot());
}, TICK_MS);

// ---------------------------------------------------------------------------
// WebSocket message handling
// ---------------------------------------------------------------------------

function handleJoin(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 16) || `Player${ws._pid}`;
  let team = msg.team;
  if (team !== 'A' && team !== 'B') {
    // Auto-assign to the smaller team (A on a tie).
    team = playersOf('A').length <= playersOf('B').length ? 'A' : 'B';
  }
  if (playersOf(team).length >= MAX_PER_TEAM) {
    const other = team === 'A' ? 'B' : 'A';
    if (playersOf(other).length >= MAX_PER_TEAM) {
      send(ws, { t: 'error', message: 'Room is full (12 players max).' });
      return;
    }
    team = other;
  }
  const p = {
    id: ws._pid,
    ws,
    name,
    team,
    solo: false,
    joinedAt: Date.now(),
    alive: phase !== 'playing', // late joiners spectate until the next round
    health: 100,
    inMag: MAG_SIZE,
    mags: MAG_COUNT - 1,
    reloadingUntil: 0,
    lastShotAt: 0,
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
  };
  // Give a lobby position so the player has a sane default if the match
  // starts while they are idle; startRound overwrites it anyway.
  const role = roleOf(team);
  const spawn = SPAWNS[role][playersOf(team).length % SPAWNS[role].length];
  p.pos = { x: spawn.x, y: 0, z: spawn.z };
  p.yaw = spawn.yaw;
  players.set(p.id, p);
  if (hostId === null) hostId = p.id;
  send(ws, { t: 'joined', id: p.id });
  broadcastState();
}

// Solo mode: a lone player exploring the map. They have no team, are never
// the host, are never part of a match, cannot be shot and cannot shoot
// anyone. The room stays in whatever phase it is in.
function handleSolo(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 16) || `Player${ws._pid}`;
  const spawn = SPAWNS.attackers[0];
  const p = {
    id: ws._pid,
    ws,
    name,
    team: null,
    solo: true,
    joinedAt: Date.now(),
    alive: true,
    health: 100,
    inMag: MAG_SIZE,
    mags: MAG_COUNT - 1,
    reloadingUntil: 0,
    lastShotAt: 0,
    pos: { x: spawn.x, y: 0, z: spawn.z },
    yaw: spawn.yaw,
    pitch: 0,
  };
  players.set(p.id, p);
  send(ws, { t: 'soloJoined', id: p.id, spawn: { x: spawn.x, y: 0, z: spawn.z, yaw: spawn.yaw } });
  broadcastState();
}

function handleMessage(ws, msg) {
  const p = players.get(ws._pid);
  switch (msg.t) {
    case 'join': {
      if (p) return; // already joined
      handleJoin(ws, msg);
      return;
    }
    case 'solo': {
      if (p) return; // already joined
      handleSolo(ws, msg);
      return;
    }
    default:
      break;
  }
  if (!p) return; // must join first
  switch (msg.t) {
    case 'switchTeam': {
      if (p.solo || phase !== 'lobby') return;
      const target = msg.team === 'A' || msg.team === 'B' ? msg.team : null;
      if (!target || target === p.team) return;
      if (playersOf(target).length >= MAX_PER_TEAM) {
        send(ws, { t: 'error', message: 'That team is full.' });
        return;
      }
      p.team = target;
      broadcastState();
      break;
    }
    case 'setAttackers': {
      if (p.solo || phase !== 'lobby' || p.id !== hostId) return;
      if (msg.team === 'A' || msg.team === 'B') {
        attackersTeam = msg.team;
        broadcastState();
      }
      break;
    }
    case 'start': {
      if (p.solo || phase !== 'lobby' || p.id !== hostId) return;
      // Asymmetric splits are allowed: at least 1 player per side.
      if (playersOf('A').length < 1 || playersOf('B').length < 1) {
        send(ws, { t: 'error', message: 'Need at least 1 player on each team to start.' });
        return;
      }
      startMatch();
      break;
    }
    case 'move': {
      const x = Number(msg.x);
      const z = Number(msg.z);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y)) return;
      // Clamp to the map so a bad client cannot teleport across the world.
      p.pos.x = Math.max(-18, Math.min(18, x));
      p.pos.z = Math.max(-62, Math.min(62, z));
      p.pos.y = Math.max(0, Math.min(3, y));
      if (Number.isFinite(msg.yaw)) p.yaw = Number(msg.yaw);
      if (Number.isFinite(msg.pitch)) p.pitch = Number(msg.pitch);
      // Objective check: a living attacker inside the zone wins the round.
      if (phase === 'playing' && p.alive && !p.solo && roleOf(p.team) === 'attackers') {
        if (objectiveContains(p.pos.x, p.pos.z)) endRound(p.team, 'objective');
      }
      break;
    }
    case 'shot': {
      const now = Date.now();
      if ((phase !== 'playing' && !p.solo) || !p.alive) return;
      if (now < p.reloadingUntil) return;
      if (p.inMag <= 0) return; // out of ammo in this mag: must reload
      if (now - p.lastShotAt < FIRE_INTERVAL_MS) return;
      p.lastShotAt = now;
      p.inMag -= 1;
      let hit = false;
      let killed = false;
      let targetHealth = null;
      let damage = 0;
      let distance = null;
      // Solo shots never hit anyone; solo players can never be hit.
      const target = p.solo ? null : (msg.targetId != null ? players.get(Number(msg.targetId)) : null);
      // Friendly fire is ON: any living player except yourself can be hit.
      if (target && target.alive && target.id !== p.id && !target.solo) {
        hit = true;
        const dx = target.pos.x - p.pos.x;
        const dy = target.pos.y - p.pos.y;
        const dz = target.pos.z - p.pos.z;
        distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        damage = damageForDistance(distance);
        target.health -= damage;
        if (target.health <= 0) {
          target.health = 0;
          target.alive = false;
          target.reloadingUntil = 0;
          killed = true;
        }
        targetHealth = target.health;
      }
      broadcast({
        t: 'shot',
        shooterId: p.id,
        targetId: target ? target.id : null,
        hit,
        friendlyFire: hit ? target.team === p.team : false,
        damage,
        distance: distance == null ? null : Math.round(distance * 10) / 10,
        targetHealth,
        killed,
        inMag: p.inMag,
        mags: p.mags,
      });
      if (killed) {
        broadcastState();
        checkElimination();
      }
      break;
    }
    case 'reload': {
      const now = Date.now();
      if ((phase !== 'playing' && !p.solo) || !p.alive) return;
      if (now < p.reloadingUntil) return;
      if (p.mags <= 0 || p.inMag >= MAG_SIZE) return;
      p.reloadingUntil = now + RELOAD_MS;
      broadcast({ t: 'reloadStart', playerId: p.id, reloadMs: RELOAD_MS });
      break;
    }
    case 'leaveSolo': {
      if (!p.solo) return;
      removePlayer(p);
      send(ws, { t: 'soloLeft' });
      break;
    }
    case 'rematch': {
      if (p.solo || phase !== 'ended' || p.id !== hostId) return;
      if (msg.swap) attackersTeam = attackersTeam === 'A' ? 'B' : 'A';
      startMatch();
      break;
    }
    default:
      break;
  }
}

// Shared by disconnects and leaveSolo: drop the player from the room,
// migrate the host to the earliest-joined remaining team player (solo
// players are never host), and re-check the round state.
function removePlayer(p) {
  players.delete(p.id);
  if (players.size === 0) {
    // Room is empty: reset to a fresh lobby for the next group.
    hostId = null;
    attackersTeam = 'A';
    phase = 'lobby';
    round = 0;
    score = { A: 0, B: 0 };
    roundWinner = null;
    roundReason = '';
    matchWinner = null;
    return;
  }
  if (hostId === p.id) {
    const remaining = [...players.values()]
      .filter((q) => !q.solo)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    hostId = remaining.length ? remaining[0].id : null;
  }
  broadcastState();
  checkElimination();
}

function handleDisconnect(ws) {
  const p = players.get(ws._pid);
  if (!p) return;
  removePlayer(p);
}

// ---------------------------------------------------------------------------
// HTTP: static files + Three.js from node_modules (no CDN at runtime)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    let filePath;
    if (pathname.startsWith('/three/')) {
      // Three.js ships as several files: three.module.js imports
      // three.core.js (and the WebGPU build imports three.tsl.js), so the
      // whole build directory must be served, not just the one file.
      const rel = path.normalize(pathname.slice('/three/'.length)).replace(/^(\.\.[/\\])+/, '');
      filePath = path.join(__dirname, 'node_modules', 'three', 'build', rel);
      if (!filePath.startsWith(path.join(__dirname, 'node_modules', 'three', 'build'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    } else {
      // Static files from public/, guarded against path traversal.
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      filePath = path.join(__dirname, 'public', safe);
      if (!filePath.startsWith(path.join(__dirname, 'public'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch {
    res.writeHead(400);
    res.end('Bad request');
  }
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws._pid = nextId++;
  send(ws, { t: 'welcome', id: ws._pid });
  ws.on('message', (raw) => {
    try {
      handleMessage(ws, JSON.parse(String(raw)));
    } catch {
      // Ignore malformed messages.
    }
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tactical POC server running at http://localhost:${PORT}`);
  console.log(`Phones on the same WiFi: open http://<this-computer-LAN-IP>:${PORT}`);
});

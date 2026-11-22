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
import { SPAWNS, spawnLayout, objectiveContains } from './public/map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8020);
// Tunable through env for the headless test; defaults are the game spec.
const ROUND_MS = Number(process.env.ROUND_MS || 5 * 60 * 1000);
// Objective capture: an attacker must hold the zone for CAPTURE_MS to win
// the round. Reaching the zone used to end the round instantly, so a
// straight sprint (90 m at 5 m/s) won rounds in ~20 s with no fight — and
// with no visible marker, rounds seemed to end "for no reason". Hold time
// is 30 s per Lior's call (22/11/2026).
const CAPTURE_MS = Number(process.env.CAPTURE_MS || 30000);
// No intermission timer: the next round starts only when a player presses
// CONTINUE (see the 'continue' message). The intermission lasts until then.
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
// Every connected socket, joined or just waiting in the lobby: state
// snapshots go to all of them, so a player waiting for a match to end
// sees the phase change and the join buttons re-enable. Game events
// (broadcast) still go to joined players only.
const sockets = new Set();
// Team players who disconnected mid-match may rejoin within the grace
// window (same callsign + team) instead of being blocked as newcomers.
// Entries: { name, team, until }.
const recentDisconnects = [];
const REJOIN_GRACE_MS = 5 * 60 * 1000;
// Heartbeat: a client pings every 10 s; a player silent longer than the
// timeout is treated as disconnected (ghost cleanup). Tunable through
// env for the headless test.
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 90000);
const HEARTBEAT_SWEEP_MS = Number(process.env.HEARTBEAT_SWEEP_MS || 10000);
// Silence after which a same-identity record counts as a ghost for a
// takeover (see findGhost): live clients ping every 10 s, so 15 s of
// silence means a frozen or dead tab.
const GHOST_SILENCE_MS = Number(process.env.GHOST_SILENCE_MS || 15000);
let nextId = 1;
let hostId = null;
let attackersTeam = 'A';
let phase = 'lobby'; // 'lobby' | 'playing' | 'intermission' | 'ended'
let round = 0;
let score = { A: 0, B: 0 };
let roundEndsAt = 0;
let roundWinner = null; // 'A' | 'B' | null
let roundReason = ''; // 'elimination' | 'objective' | 'timeout'
let matchWinner = null;
// Objective-capture progress this round: milliseconds accumulated while at
// least one living attacker stands inside the zone. Resets the moment the
// zone is empty, on round start, and on round end.
let captureMs = 0;
// Current round's spawn layout: each team drew a random side of the street
// (see spawnLayout in map.js). The objective is the defenders' spawn centre.
let layout = spawnLayout(-1, 1);

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

function freshStats() {
  return { shots: 0, hits: 0, kills: 0, deaths: 0, teamkills: 0, damage: 0, captures: 0 };
}

// End-of-match leaderboard: team players only (solo players never play),
// sorted by kills, then damage. Players who left mid-match are gone from
// the room, so their stats are lost with them.
function matchStats() {
  return [...players.values()]
    .filter((p) => !p.solo)
    .map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      role: roleOf(p.team),
      shots: p.stats.shots,
      hits: p.stats.hits,
      kills: p.stats.kills,
      deaths: p.stats.deaths,
      teamkills: p.stats.teamkills,
      damage: p.stats.damage,
      captures: p.stats.captures,
      accuracy: p.stats.shots > 0 ? Math.round((p.stats.hits / p.stats.shots) * 100) : null,
    }))
    .sort((a, b) => b.kills - a.kills || b.damage - a.damage || a.name.localeCompare(b.name));
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
    objective: { ...layout.objective },
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
  // State goes to every connected socket, including players waiting in
  // the lobby for a match to end — they need the phase to know when
  // joining opens again.
  const text = JSON.stringify(publicState());
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(text);
  }
}

function snapshotPlayerList(now) {
  const list = [...players.values()].map((p) => ({
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
    crouch: !!p.crouch,
    aiming: !!p.aiming,
  }));
  // The NPC rides the snapshot (never the state): clients render it like
  // any other player, but it never appears in the lobby or the counts.
  if (npc) {
    list.push({
      id: NPC_ID,
      x: NPC_POS.x,
      y: 0,
      z: NPC_POS.z,
      yaw: npc.yaw,
      pitch: 0,
      alive: true,
      health: 100,
      inMag: MAG_SIZE,
      mags: MAG_COUNT - 1,
      reloading: false,
      crouch: false,
      aiming: npc.aiming,
      npc: true,
      name: NPC_NAME,
      team: 'B',
    });
  }
  return list;
}

function snapshot() {
  const now = Date.now();
  return {
    t: 'snapshot',
    phase,
    round,
    score: { ...score },
    timeLeftMs: phase === 'playing' ? Math.max(0, roundEndsAt - now) : 0,
    captureProgress: phase === 'playing' ? Math.min(1, captureMs / CAPTURE_MS) : 0,
    players: snapshotPlayerList(now),
  };
}

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

function resetPlayerForRound(p) {
  const role = roleOf(p.team);
  const mates = playersOf(p.team);
  const index = mates.findIndex((m) => m.id === p.id);
  const spawn = layout[role][Math.min(index, layout[role].length - 1)];
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
  captureMs = 0;
  // Fresh random spawn sides for this round: each team independently draws
  // west (-1) or east (+1) — 4 combinations. The objective moves with the
  // defenders' spawn.
  const side = () => (Math.random() < 0.5 ? -1 : 1);
  layout = spawnLayout(side(), side());
  for (const p of players.values()) {
    if (p.solo) continue; // solo players keep exploring, untouched by rounds
    resetPlayerForRound(p);
  }
  roundEndsAt = Date.now() + ROUND_MS;
  broadcastState();
  broadcast({ t: 'roundStart', round, objective: { ...layout.objective } });
}

function startMatch() {
  score = { A: 0, B: 0 };
  matchWinner = null;
  for (const p of players.values()) p.stats = freshStats();
  startRound(1);
}

function endRound(winnerTeam, reason) {
  if (phase !== 'playing') return;
  score[winnerTeam] += 1;
  roundWinner = winnerTeam;
  roundReason = reason;
  captureMs = 0;
  broadcast({ t: 'roundEnd', winner: winnerTeam, reason, score: { ...score } });
  if (score[winnerTeam] >= WIN_SCORE) {
    phase = 'ended';
    matchWinner = winnerTeam;
    broadcast({ t: 'matchEnd', winner: winnerTeam, score: { ...score }, stats: matchStats() });
  } else {
    // Intermission: the next round starts only when a player presses
    // CONTINUE — there is no auto-advance timer.
    phase = 'intermission';
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
// Solo defender NPC: a target dummy that shoots at solo players so they can
// see a muzzle flash from the outside and hear remote shots. It is NOT a
// player: it lives outside the players map, never joins a match, cannot be
// hit, and its shots never damage anyone. It exists only while the room is
// in the lobby phase and at least one solo player is present. Position is
// overridable via NPC_X / NPC_Z (screenshot runs put it in front of the
// solo spawn).
// ---------------------------------------------------------------------------
const NPC_ID = -1; // player ids start at 1 (nextId), so -1 can never collide
const NPC_NAME = 'Dummy';
const NPC_POS = {
  x: Number(process.env.NPC_X ?? 0),
  z: Number(process.env.NPC_Z ?? 40),
};
const NPC_RANGE = 30; // opens fire within 30 m
const NPC_BURST = 3; // shots per burst
const NPC_BURST_INTERVAL_MS = 120; // inside a burst
const NPC_BURST_PAUSE_MS = 1200; // between bursts
let npc = null; // { yaw, aiming, burstLeft, nextShotAt } or null

function updateNpc(now) {
  const solos = [...players.values()].filter((p) => p.solo && p.alive);
  if (phase !== 'lobby' || solos.length === 0) {
    npc = null;
    return;
  }
  if (!npc) npc = { yaw: 0, aiming: false, burstLeft: 0, nextShotAt: 0 };
  let target = null;
  let best = Infinity;
  for (const p of solos) {
    const d = Math.hypot(p.pos.x - NPC_POS.x, p.pos.z - NPC_POS.z);
    if (d < best) { best = d; target = p; }
  }
  if (!target || best > NPC_RANGE) {
    npc.aiming = false;
    npc.burstLeft = 0;
    return;
  }
  npc.aiming = true;
  npc.yaw = Math.atan2(-(target.pos.x - NPC_POS.x), -(target.pos.z - NPC_POS.z));
  if (npc.burstLeft > 0 && now >= npc.nextShotAt) {
    npc.burstLeft -= 1;
    npc.nextShotAt = now + NPC_BURST_INTERVAL_MS;
    // Same 'shot' event a real player produces, so the NPC's fire goes
    // through the exact same client path (flash + sound). It never hits.
    broadcast({
      t: 'shot',
      shooterId: NPC_ID,
      targetId: null,
      hit: false,
      friendlyFire: false,
      damage: 0,
      distance: Math.round(best * 10) / 10,
      targetHealth: null,
      killed: false,
      inMag: MAG_SIZE,
      mags: MAG_COUNT - 1,
    });
    if (npc.burstLeft === 0) npc.nextShotAt = now + NPC_BURST_PAUSE_MS;
  } else if (npc.burstLeft === 0 && now >= npc.nextShotAt) {
    npc.burstLeft = NPC_BURST;
    npc.nextShotAt = now;
  }
}

// ---------------------------------------------------------------------------
// Tick: snapshot broadcast, reload completion, round timer.
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

  // Objective capture: while at least one living attacker stands inside
  // the zone, the hold timer runs; it resets the moment the zone is
  // empty (the capturer left, or died). Completing the hold wins the
  // round — reaching the zone is no longer an instant win.
  if (phase === 'playing') {
    const cappers = [...players.values()].filter(
      (p) => !p.solo && p.alive && roleOf(p.team) === 'attackers'
        && objectiveContains(p.pos.x, p.pos.z, layout.objective),
    );
    if (cappers.length > 0) {
      captureMs += TICK_MS;
      if (captureMs >= CAPTURE_MS) {
        for (const c of cappers) c.stats.captures += 1;
        endRound(attackersTeam, 'objective');
      }
    } else {
      captureMs = 0;
    }
  }

  if (phase === 'playing' && now >= roundEndsAt) {
    // Time expired: the defenders survived.
    const defendersTeam = attackersTeam === 'A' ? 'B' : 'A';
    endRound(defendersTeam, 'timeout');
  }

  updateNpc(now);
  if (players.size > 0) broadcast(snapshot());
}, TICK_MS);

// ---------------------------------------------------------------------------
// WebSocket message handling
// ---------------------------------------------------------------------------

// A same-identity player record whose connection is dead (socket not
// open) or has been silent long enough that no live client could be
// behind it: live clients ping every 10 s and send moves constantly
// while playing, so GHOST_SILENCE_MS of silence means a frozen or dead
// tab. An active same-name player is NEVER a ghost — two humans may
// share a callsign, and a live one is protected.
function findGhost(name, team, solo) {
  for (const p of players.values()) {
    if (p.name !== name || p.solo !== solo) continue;
    if (!solo && p.team !== team) continue;
    if (p.ws.readyState !== 1) return p;
    if (Date.now() - p.ws._lastSeenAt > GHOST_SILENCE_MS) return p;
  }
  return null;
}

// Remove a ghost record and close its dead socket, so the frozen client
// notices (onclose → auto-reconnect) instead of sitting on a dead
// connection. No grace entry: the player is back on the new connection.
function takeOver(p) {
  removePlayer(p);
  try { p.ws.terminate(); } catch { /* already closed */ }
}

// Any player record from the same tab session (the client sends one
// stable session id per tab). Same tab = same human, whatever the
// callsign or team — so a rejoin takes it over rather than duplicating.
// A missing session id (old clients) never matches.
function findSessionRecord(sessionId) {
  if (!sessionId) return null;
  for (const p of players.values()) {
    if (p.sessionId === sessionId) return p;
  }
  return null;
}

// Remove every record this join would duplicate: a same-identity ghost
// and/or any record from the same tab session. Called after the join
// gate passes, so a rejected join never removes anything.
function takeOverDuplicates(name, team, sessionId, solo) {
  const ghost = findGhost(name, team, solo);
  if (ghost) takeOver(ghost);
  const sessionRecord = findSessionRecord(sessionId);
  if (sessionRecord) takeOver(sessionRecord);
}

function handleJoin(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 16) || `Player${ws._pid}`;
  const sessionId = String(msg.session || '').slice(0, 64) || null;
  let team = msg.team;
  if (team !== 'A' && team !== 'B') {
    // Auto-assign to the smaller team (A on a tie).
    team = playersOf('A').length <= playersOf('B').length ? 'A' : 'B';
  }
  // No mid-match joins: once a match has started (playing, or the
  // intermission between rounds), newcomers wait in the lobby until the
  // match ends. Joins open again in 'ended' (for the rematch) and in
  // 'lobby'. Exception: a team player who disconnected mid-match may
  // rejoin within the grace window (same callsign + team) — or take over
  // their own ghost record, or their own tab-session record, if the old
  // connection went silent before the sweep removed it (a frozen tab
  // that came back on a new connection).
  if (phase === 'playing' || phase === 'intermission') {
    const now = Date.now();
    for (let i = recentDisconnects.length - 1; i >= 0; i--) {
      if (recentDisconnects[i].until <= now) recentDisconnects.splice(i, 1);
    }
    const idx = recentDisconnects.findIndex((r) => r.name === name && r.team === team);
    const ghost = findGhost(name, team, false);
    const sessionRecord = findSessionRecord(sessionId);
    const sessionMatch = !!sessionRecord && !sessionRecord.solo && sessionRecord.team === team;
    if (idx === -1 && !ghost && !sessionMatch) {
      send(ws, { t: 'error', message: 'A match is in progress — you can join when it ends.' });
      return;
    }
    if (idx !== -1) recentDisconnects.splice(idx, 1); // one rejoin per disconnect
    takeOverDuplicates(name, team, sessionId, false);
  } else {
    // Lobby / ended: no gate, but still never duplicate a ghost or a
    // record from the same tab session.
    takeOverDuplicates(name, team, sessionId, false);
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
    sessionId,
    joinedAt: Date.now(),
    alive: phase !== 'playing', // late joiners spectate until the next round
    health: 100,
    inMag: MAG_SIZE,
    mags: MAG_COUNT - 1,
    reloadingUntil: 0,
    lastShotAt: 0,
    stats: freshStats(),
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    crouch: false, // stance flags, relayed to snapshots so other
    aiming: false, // players see the pose (kneel / aim)
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
  const sessionId = String(msg.session || '').slice(0, 64) || null;
  takeOverDuplicates(name, null, sessionId, true);
  const spawn = SPAWNS.attackers[0];
  const p = {
    id: ws._pid,
    ws,
    name,
    team: null,
    solo: true,
    sessionId,
    joinedAt: Date.now(),
    alive: true,
    health: 100,
    inMag: MAG_SIZE,
    mags: MAG_COUNT - 1,
    reloadingUntil: 0,
    lastShotAt: 0,
    stats: freshStats(),
    pos: { x: spawn.x, y: 0, z: spawn.z },
    yaw: spawn.yaw,
    pitch: 0,
    crouch: false,
    aiming: false,
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
    case 'ping': {
      // Heartbeat: liveness is already recorded by the message handler
      // (ws._lastSeenAt); nothing else to do.
      break;
    }
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
    case 'clearRoom': {
      // Host only, lobby only: kick every other player (teams and solo)
      // so a new game starts clean. Each kicked client gets a 'kicked'
      // message first (it clears its saved join, so the auto-reconnect
      // does not rejoin), then the socket is closed. The host stays.
      if (p.solo || phase !== 'lobby' || p.id !== hostId) return;
      for (const other of [...players.values()]) {
        if (other.id === p.id) continue;
        send(other.ws, { t: 'kicked', reason: 'The host cleared the room. Rejoin to play.' });
        setTimeout(() => { try { other.ws.close(); } catch { /* already closed */ } }, 150);
      }
      break;
    }
    case 'start': {
      // Any joined player may start (1v1 is enough); only the attackers
      // pick stays host-only.
      if (p.solo || phase !== 'lobby') return;
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
      // Stance flags (pose relay): only accept real booleans.
      if (typeof msg.crouch === 'boolean') p.crouch = msg.crouch;
      if (typeof msg.aiming === 'boolean') p.aiming = msg.aiming;
      // No objective check here: capture is tick-based (see the tick
      // loop) — entering the zone starts a hold timer instead of
      // ending the round instantly.
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
      p.stats.shots += 1;
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
        p.stats.hits += 1;
        p.stats.damage += damage;
        target.health -= damage;
        if (target.health <= 0) {
          target.health = 0;
          target.alive = false;
          target.reloadingUntil = 0;
          killed = true;
          p.stats.kills += 1;
          if (target.team === p.team) p.stats.teamkills += 1;
          target.stats.deaths += 1;
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
    case 'continue': {
      // Any joined player may press CONTINUE during an intermission;
      // the first press starts the next round. (Solo players are not
      // part of the match, so they cannot.)
      if (p.solo || phase !== 'intermission') return;
      startRound(round + 1);
      break;
    }
    case 'rematch': {
      if (p.solo || phase !== 'ended') return;
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
    captureMs = 0;
    layout = spawnLayout(-1, 1);
    // No match left to rejoin: drop stale grace entries so they cannot
    // admit anyone into a later match.
    recentDisconnects.length = 0;
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
  // A team player who drops mid-match may rejoin within the grace
  // window (same callsign + team); without this, a network blip would
  // lock them out until the match ends.
  if (!p.solo && (phase === 'playing' || phase === 'intermission')) {
    recentDisconnects.push({ name: p.name, team: p.team, until: Date.now() + REJOIN_GRACE_MS });
    if (recentDisconnects.length > 48) recentDisconnects.splice(0, recentDisconnects.length - 48);
  }
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
  ws._lastSeenAt = Date.now();
  sockets.add(ws);
  send(ws, { t: 'welcome', id: ws._pid });
  // Send the current state immediately, so a player who opens the page
  // mid-match sees the wait message at once instead of only after the
  // next phase change.
  send(ws, publicState());
  ws.on('message', (raw) => {
    // Liveness: any message (move, shot, ping) proves the client is alive.
    ws._lastSeenAt = Date.now();
    try {
      handleMessage(ws, JSON.parse(String(raw)));
    } catch {
      // Ignore malformed messages.
    }
  });
  ws.on('close', () => { sockets.delete(ws); handleDisconnect(ws); });
  ws.on('error', () => { sockets.delete(ws); handleDisconnect(ws); });
});

// Ghost sweep: a socket that stopped sending (crashed tab, dead
// connection) is removed like a disconnect — mid-match players get the
// rejoin grace entry, so coming back within 5 minutes still works — and
// the dead socket is terminated so the client notices and reconnects.
setInterval(() => {
  const now = Date.now();
  for (const p of [...players.values()]) {
    if (now - p.ws._lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      handleDisconnect(p.ws);
      try { p.ws.terminate(); } catch { /* already closed */ }
    }
  }
  for (const ws of [...sockets]) {
    if (!players.has(ws._pid) && now - ws._lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      sockets.delete(ws);
      try { ws.terminate(); } catch { /* already closed */ }
    }
  }
}, HEARTBEAT_SWEEP_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tactical POC server running at http://localhost:${PORT}`);
  console.log(`Phones on the same WiFi: open http://<this-computer-LAN-IP>:${PORT}`);
});

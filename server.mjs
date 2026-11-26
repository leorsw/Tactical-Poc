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
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SPAWNS, spawnLayout, objectiveContains, HOUSES, hasLineOfSight, visualBoxes, EYE_HEIGHT } from './public/map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8020);
// Tunable through env for the headless test; defaults are the game spec.
const ROUND_MS = Number(process.env.ROUND_MS || 5 * 60 * 1000);
// Round length the admin set in the lobby (setRoundDuration, minutes,
// 1–30); starts at the env default and applies from the next round.
let roundDurationMs = ROUND_MS;
// Defense prep time (Lior, 25/11/2026): at the start of every round the
// attackers wait at spawn for PREP_MS while the defenders get into
// position. The 5:00 round clock starts only after prep ends. No one
// shoots during prep — otherwise defenders could rush the frozen
// attackers before the round starts.
const PREP_MS = Number(process.env.PREP_MS || 20000);
// Objective capture: an attacker must hold the zone for CAPTURE_MS to win
// the round. Reaching the zone used to end the round instantly, so a
// straight sprint (90 m at 5 m/s) won rounds in ~20 s with no fight — and
// with no visible marker, rounds seemed to end "for no reason". Hold time
// is 30 s per Lior's call (22/11/2026).
const CAPTURE_MS = Number(process.env.CAPTURE_MS || 30000);
// No intermission timer: the next round starts only when a player presses
// CONTINUE (see the 'continue' message). The intermission lasts until then.
// Classes (Lior, 25/11/2026). Rifleman is the default. Marksman: x3 scope
// (ADS FOV 29), 1 shot/sec, an ADS hit kills at any range, hip fire like
// a rifleman. Machine gunner: full-auto, 120-round mags x 3, 5 s reload;
// standing it only hits within 15 m and takes 3 hits to kill; kneeling
// it shoots like a rifleman (normal distance table).
const CLASSES = {
  rifleman: { magSize: 29, magCount: 6, reloadMs: 3500, fireIntervalMs: 100, auto: false },
  marksman: { magSize: 29, magCount: 6, reloadMs: 3500, fireIntervalMs: 1000, auto: false },
  gunner: { magSize: 120, magCount: 3, reloadMs: 5000, fireIntervalMs: 100, auto: true },
};
const classStats = (cls) => CLASSES[cls] || CLASSES.rifleman;
const WIN_SCORE = 3;
// Admin interface (Lior, 25/11/2026): whoever knows this code becomes
// the admin — edits player names, assigns teams and classes, decides
// whether grenades are allowed, and (once an admin exists) is the ONLY
// one who can start the match (or continue / rematch). With no admin
// in the room the lobby works as before — anyone may start, the host
// assigns classes and toggles grenades. Change the code here, or set
// the ADMIN_CODE env var. Default '1357' — change it before sharing
// the game with strangers.
const ADMIN_CODE = process.env.ADMIN_CODE || '1357';
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

// Damage for one shot, by the shooter's class and stance. Returns 0 when
// the shot cannot hit at all (standing gunner past 15 m). Used for
// players and for solo players shooting NPCs.
function damageForShot(shooter, distance) {
  if (shooter.cls === 'marksman' && shooter.aiming) return DAMAGE_CLOSE; // ADS hit kills at any range
  if (shooter.cls === 'gunner' && !shooter.crouch) {
    if (distance > RANGE_CLOSE_M) return 0; // standing: close range only
    return DAMAGE_LONG; // 34 — 3 hits to kill
  }
  return damageForDistance(distance);
}
const MAG_SIZE = 29;
const MAG_COUNT = 6; // 1 loaded + 5 spare

// Grenades (Lior, 25/11/2026): 2 per player per round. Press -> 3 s
// arming on the client (icon fills bottom-up), then the throw: a small
// arc to 10 m. A second 3 s fuse runs from the throw until the explosion.
// The blast eliminates everyone within 4 m who has a direct line of
// sight from the explosion — walls block it; teammates and the thrower
// himself are hurt too (friendly fire). Solo grenades hurt NPCs only,
// like solo shots (they never hit players).
const GRENADE_COUNT = 2;
const GRENADE_RANGE_M = 10;
const GRENADE_PEAK_M = 1.2; // arc height above the straight line
const GRENADE_FLIGHT_MS = 1000; // 10 m arc at a steady throw
const GRENADE_FUSE_MS = 3000; // from the throw until the explosion
const GRENADE_BLAST_R = 4;
let grenades = []; // live grenades: {id, throwerId, throwAt, flightMs, dist, dir, from, to, landed, exploded}
let nextGrenadeId = 1;
let grenadesAllowed = true; // admin switch (setGrenadesAllowed) — on by default

// Expiring invite links (Lior, 26/11/2026 — for the testing period):
// the admin creates a shareable link that admits entry for one hour.
// INVITE_TTL_MS is a test hook (the headless suite shortens it to prove
// expiry); production is 1 hour. Direct entry without a link stays open
// (Lior is still deliberating about the existing link) — the expiry
// controls the shared link, not the plain URL.
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS || 3600000);
const invites = new Map(); // code -> { code, expiresAt, createdBy }

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
// Teams are 'A' and 'B' in the lobby. The host picks which team attacks;
// roles stay fixed for the whole match. Score is tracked per team.

const players = new Map(); // id -> player object
// Bird's-eye spectators (Lior, 26/11/2026): the admin watches from above
// with no figure. Negative ids, far from player ids (>= 1) and NPC ids
// (-1..-10), so a spectator is never mistaken for a player.
const spectators = new Map(); // id -> { id, ws, name, admin }
let nextSpectatorId = -1000;
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
let prepEndsAt = 0;
let prepEnabled = false; // prep time is off by default (Lior, 26/11/2026) — the admin or any team player can enable it (setPrepEnabled)
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

// Admin (Lior, 25/11/2026): the admin rules apply only once someone
// has entered the code. With no admin in the room, the lobby works
// exactly as before — anyone may start, the host assigns classes and
// toggles grenades.
function adminPresent() {
  // A spectating admin still counts: while they watch from above, the
  // lobby must not fall back to "anyone may start".
  return [...players.values()].some((q) => q.admin)
    || [...spectators.values()].some((q) => q.admin);
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
  // Spectators watch the match too (shots, grenades, round events).
  for (const s of spectators.values()) {
    if (s.ws.readyState === 1) s.ws.send(text);
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
    attackersSpawn: { ...layout.attackersSpawn },
    roundWinner,
    roundReason,
    matchWinner,
    hostId,
    grenadesAllowed,
    prepEnabled,
    roundDurationMin: roundDurationMs / 60000,
    adminSpectating: [...spectators.values()].some((q) => q.admin),
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      solo: p.solo,
      admin: !!p.admin,
      role: p.solo ? null : roleOf(p.team),
      commander: !p.solo && commanderOf(p.team)?.id === p.id,
      host: p.id === hostId,
      cls: p.cls || 'rifleman',
      alive: p.alive,
      health: p.health,
      inMag: p.inMag,
      mags: p.mags,
      grenades: p.grenades ?? 0,
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
    grenades: p.grenades ?? 0,
    reloading: now < p.reloadingUntil,
    crouch: !!p.crouch,
    aiming: !!p.aiming,
  }));
  // The NPCs ride the snapshot (never the state): clients render them
  // like any other player, but they never appear in the lobby or the
  // counts. An NPC's alive flag is its up/down state: a solo kill puts
  // it down for good — it never gets back up (no revive; the set is
  // re-drawn only when the next solo session starts).
  for (const n of npcs) {
    list.push({
      id: n.id,
      x: n.x,
      y: n.y,
      z: n.z,
      yaw: n.yaw,
      pitch: 0,
      alive: n.health > 0,
      health: n.health,
      inMag: MAG_SIZE,
      mags: MAG_COUNT - 1,
      reloading: false,
      crouch: false,
      aiming: n.aiming,
      npc: true,
      name: n.name,
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
    prepActive: phase === 'playing' && now < prepEndsAt,
    prepMsLeft: phase === 'playing' ? Math.max(0, prepEndsAt - now) : 0,
    captureProgress: phase === 'playing' ? Math.min(1, captureMs / CAPTURE_MS) : 0,
    players: snapshotPlayerList(now),
    grenades: liveGrenadeList(now),
  };
}

// Live grenade positions for the snapshot: the arc while flying, the
// landing point once it is down. Clients render the meshes from this.
function liveGrenadeList(now) {
  return grenades.filter((g) => !g.exploded).map((g) => {
    const pos = grenadePos(g, now);
    return { id: g.id, x: pos.x, y: pos.y, z: pos.z };
  });
}

// Where a grenade is at a moment: the arc while flying (progress t along
// its flight), the landing point once it is down.
function grenadePos(g, now) {
  if (g.landed) return { x: g.to.x, y: g.to.y, z: g.to.z };
  const t = Math.min(1, (now - g.throwAt) / g.flightMs);
  const d = g.dist * t;
  return {
    x: g.from.x + g.dir.x * d,
    y: g.from.y + (g.to.y - g.from.y) * t + 4 * GRENADE_PEAK_M * t * (1 - t),
    z: g.from.z + g.dir.z * d,
  };
}

function pointInBox(p, b) {
  return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && p.z >= b.z0 && p.z <= b.z1;
}

// Simulate the throw's arc against the map's solid boxes (walls with
// real window/door gaps, slabs, roofs). Returns the landing point and
// the horizontal flight distance. A wall hit ends the arc early — the
// grenade falls to the floor just before the wall. A window or doorway
// gap lets it through. The landing floor is always the thrower's floor:
// the arc cannot cross a slab.
function simulateThrow(p) {
  const dir = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
  const from = { x: p.pos.x, y: p.pos.y + 1.4, z: p.pos.z }; // hand height
  const landY = p.pos.y;
  // The thin ground-floor slabs (y 0..0.02) are floors, not walls — the
  // arc ends exactly on them, so they must not count as a wall hit.
  const boxes = visualBoxes().filter((b) => b.y1 - b.y0 >= 0.1);
  const STEP = 0.25; // smaller than any wall thickness (0.3), so no crossing is skipped
  let prev = { ...from };
  for (let d = STEP; d <= GRENADE_RANGE_M; d += STEP) {
    const t = d / GRENADE_RANGE_M;
    const pt = {
      x: from.x + dir.x * d,
      y: from.y + (landY - from.y) * t + 4 * GRENADE_PEAK_M * t * (1 - t),
      z: from.z + dir.z * d,
    };
    if (boxes.some((b) => pointInBox(pt, b))) {
      return { to: { x: prev.x, y: landY, z: prev.z }, dist: d - STEP, dir };
    }
    prev = pt;
  }
  return {
    to: { x: from.x + dir.x * GRENADE_RANGE_M, y: landY, z: from.z + dir.z * GRENADE_RANGE_M },
    dist: GRENADE_RANGE_M,
    dir,
  };
}

// The fuse ran out: the blast eliminates everyone within 4 m who has a
// direct line of sight from the explosion — walls block it. Teammates
// and the thrower himself are hurt (friendly fire). A solo thrower's
// grenade hurts NPCs only, like solo shots. After the round ends the
// blast is visual only (no victims) — the round is already decided.
function explodeGrenade(g) {
  g.exploded = true;
  const ex = { x: g.to.x, y: g.to.y + 0.2, z: g.to.z };
  const victims = [];
  const thrower = players.get(g.throwerId);
  const counts = phase === 'playing' || (thrower && thrower.solo);
  if (counts && thrower && !thrower.solo) {
    for (const p of [...players.values()]) {
      if (!p.alive || p.solo) continue;
      const d = Math.hypot(p.pos.x - ex.x, p.pos.y - ex.y, p.pos.z - ex.z);
      if (d > GRENADE_BLAST_R) continue;
      if (!hasLineOfSight(ex.x, ex.y, ex.z, p.pos.x, p.pos.y + 1.2, p.pos.z)) continue;
      p.health = 0;
      p.alive = false;
      p.reloadingUntil = 0;
      p.stats.deaths += 1;
      thrower.stats.kills += 1;
      if (thrower.team && p.team === thrower.team) thrower.stats.teamkills += 1;
      victims.push(p.id);
    }
  }
  if (counts && thrower && thrower.solo) {
    for (const n of npcs) {
      if (n.health <= 0) continue;
      const d = Math.hypot(n.x - ex.x, n.y - ex.y, n.z - ex.z);
      if (d > GRENADE_BLAST_R) continue;
      if (!hasLineOfSight(ex.x, ex.y, ex.z, n.x, n.y + 1.2, n.z)) continue;
      n.health = 0;
      n.aiming = false;
      n.burstLeft = 0;
      victims.push(n.id);
    }
  }
  broadcast({ t: 'grenadeExploded', id: g.id, throwerId: g.throwerId, x: g.to.x, y: g.to.y, z: g.to.z, victims });
  if (victims.some((id) => id > 0)) {
    broadcastState();
    checkElimination();
  }
}

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

function resetPlayerForRound(p) {
  const role = roleOf(p.team);
  const mates = playersOf(p.team);
  const index = mates.findIndex((m) => m.id === p.id);
  const spawn = layout[role][Math.min(index, layout[role].length - 1)];
  const cs = classStats(p.cls);
  p.alive = true;
  p.health = 100;
  p.inMag = cs.magSize;
  p.mags = cs.magCount - 1; // spares; one mag is loaded
  p.grenades = grenadesAllowed ? GRENADE_COUNT : 0;
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
  // With prep off the round clock starts now, not at prepEndsAt (0) —
  // roundEndsAt is an epoch timestamp, and 0 + ROUND_MS is long past.
  prepEndsAt = prepEnabled ? Date.now() + PREP_MS : 0;
  roundEndsAt = (prepEndsAt || Date.now()) + roundDurationMs;
  broadcastState();
  broadcast({ t: 'roundStart', round, objective: { ...layout.objective }, attackersSpawn: { ...layout.attackersSpawn } });
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
// Solo NPCs: 10 target figures scattered along the street — some in
// ground-floor windows, some on the second floor (visible through the
// upper windows) — so a solo player can see muzzle flashes from the
// outside and hear remote shots, and has targets to shoot at. They are
// NOT players: they live outside the players map and never join a match,
// and their shots never damage anyone. Solo players CAN shoot them: same
// distance damage as a player, and enough hits put one down for good —
// it stays down until the solo session ends (no revive, unlike the old
// single Dummy). They exist only while the room is in the lobby phase
// and at least one solo player is present; the set is drawn when the
// first solo player arrives and re-drawn when the next solo player
// arrives after the room emptied of solo players.
//
// An NPC only opens fire when it can SEE its target: within 30 m AND a
// clear line of sight from its eye to the target's torso (map.js
// hasLineOfSight — rays pass through window openings and doorways, not
// through solid wall). Line of sight is checked once per burst: a burst
// that has started runs to completion even if the target ducks behind
// cover mid-burst. Without line of sight (or out of range) the NPC
// stops aiming and faces the street again — it never tracks a target
// through a wall.
//
// Positions: window spots — just inside a house's street wall, at a
// window centre (x = side * 6.8, z = house centre +/- 3.5), ground floor
// (y = 0) or second floor (y = 3). The draw takes from all four buckets
// (west/east x ground/upper) so the set always spans both sides of the
// street and both floors. NPC_SEED pins the draw (screenshot runs);
// otherwise it is random on every solo session.
// ---------------------------------------------------------------------------
const NPC_COUNT = 10;
const NPC_IDS = Array.from({ length: NPC_COUNT }, (_, i) => -(i + 1)); // -1..-10; player ids start at 1 (nextId), so these can never collide
const NPC_RANGE = 30; // opens fire within 30 m
const NPC_TARGET_HEIGHT = 1.2; // torso height above the target's feet — the point an NPC must see
const NPC_BURST = 3; // shots per burst
const NPC_BURST_INTERVAL_MS = 120; // inside a burst
const NPC_BURST_PAUSE_MS = 1200; // between bursts
let npcs = []; // [{ id, name, x, y, z, yaw, aiming, burstLeft, nextShotAt, health }] or []

// The yaw an NPC faces when it is not engaging: out of its window,
// towards the street. Forward = (-sin(yaw), 0, -cos(yaw)).
function streetYaw(n) {
  return n.x < 0 ? -Math.PI / 2 : Math.PI / 2;
}

// mulberry32: a tiny seeded PRNG so NPC_SEED draws are reproducible.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawNpcSet() {
  // Candidate window spots, bucketed by side and floor.
  const buckets = { westGround: [], westUpper: [], eastGround: [], eastUpper: [] };
  for (const h of HOUSES) {
    for (const wz of [h.cz - 3.5, h.cz + 3.5]) {
      const spot = { x: h.side * 6.8, z: wz };
      for (const y of [0, 3]) {
        const bucket = (h.side < 0 ? 'west' : 'east') + (y === 0 ? 'Ground' : 'Upper');
        buckets[bucket].push({ ...spot, y });
      }
    }
  }
  const seedEnv = process.env.NPC_SEED;
  const rand = seedEnv != null && seedEnv !== ''
    ? seededRandom([...seedEnv].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))
    : Math.random;
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  // Round-robin across the four buckets (3, 3, 2, 2): the set always
  // spans both sides of the street and both floors.
  const takes = { westGround: 3, westUpper: 3, eastGround: 2, eastUpper: 2 };
  const spots = [];
  for (const [bucket, take] of Object.entries(takes)) {
    spots.push(...shuffle(buckets[bucket]).slice(0, take));
  }
  return spots.map((s, i) => ({
    id: NPC_IDS[i],
    name: `NPC ${i + 1}`,
    x: s.x,
    y: s.y,
    z: s.z,
    // Face the street (out of the window).
    yaw: streetYaw({ x: s.x }),
    aiming: false,
    burstLeft: 0,
    burstsFired: 0, // counts started bursts; every 3rd lands a hit (below)
    nextShotAt: 0,
    health: 100,
  }));
}

function updateNpcs(now) {
  const solos = [...players.values()].filter((p) => p.solo && p.alive);
  if (phase !== 'lobby' || solos.length === 0) {
    npcs = [];
    return;
  }
  if (npcs.length === 0) npcs = drawNpcSet();
  for (const n of npcs) {
    // Down: shot by a solo player. It lies still — no aiming, no fire —
    // for good; the set is re-drawn only when the next solo session
    // starts (see above).
    if (n.health <= 0) {
      n.aiming = false;
      continue;
    }
    let target = null;
    let best = Infinity;
    for (const p of solos) {
      const d = Math.hypot(p.pos.x - n.x, p.pos.z - n.z);
      if (d < best) { best = d; target = p; }
    }
    // Out of range: stop engaging and face the street again.
    if (!target || best > NPC_RANGE) {
      n.aiming = false;
      n.burstLeft = 0;
      n.yaw = streetYaw(n);
      continue;
    }
    // In range: line of sight decides whether the NPC engages at all.
    // Checked once per burst — a burst that has started (burstLeft > 0)
    // runs to completion even if the target ducks behind cover.
    if (n.burstLeft === 0 && !hasLineOfSight(
      n.x, n.y + EYE_HEIGHT, n.z,
      target.pos.x, target.pos.y + NPC_TARGET_HEIGHT, target.pos.z,
    )) {
      n.aiming = false;
      n.yaw = streetYaw(n);
      continue;
    }
    n.aiming = true;
    n.yaw = Math.atan2(-(target.pos.x - n.x), -(target.pos.z - n.z));
    if (n.burstLeft > 0 && now >= n.nextShotAt) {
      n.burstLeft -= 1;
      n.nextShotAt = now + NPC_BURST_INTERVAL_MS;
      // Same 'shot' event a real player produces, so the NPC's fire goes
      // through the exact same client path (flash + sound). It never hits.
      broadcast({
        t: 'shot',
        shooterId: n.id,
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
      if (n.burstLeft === 0) n.nextShotAt = now + NPC_BURST_PAUSE_MS;
      // Solo NPC hits (Lior, 25/11/2026): every 3rd burst lands one hit —
      // the middle shot of the burst. The target's screen reddens, with no
      // health loss and no elimination. Deterministic, so it is testable.
      if (n.hitBurst && n.burstLeft === 1) {
        send(target.ws, { t: 'npcHit', npcId: n.id });
      }
    } else if (n.burstLeft === 0 && now >= n.nextShotAt) {
      n.burstLeft = NPC_BURST;
      n.nextShotAt = now;
      n.burstsFired += 1;
      n.hitBurst = n.burstsFired % 3 === 0;
    }
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
        p.inMag = classStats(p.cls).magSize;
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

  updateNpcs(now);

  // Grenades: while a grenade is still flying, a living player in its
  // path drops it on the spot to the floor. When the 3 s fuse runs out
  // it explodes (visual only after the round ends).
  for (const g of [...grenades]) {
    if (g.exploded) continue;
    if (!g.landed) {
      if (now < g.throwAt + g.flightMs) {
        const pos = grenadePos(g, now);
        const hitPlayer = [...players.values()].find((q) => q.alive && q.id !== g.throwerId
          && Math.hypot(q.pos.x - pos.x, q.pos.z - pos.z) < 0.5
          && pos.y >= q.pos.y && pos.y <= q.pos.y + 1.7);
        if (hitPlayer) {
          g.to = { x: pos.x, y: g.to.y, z: pos.z };
          g.landed = true;
        }
      } else {
        g.landed = true;
      }
    }
    if (now >= g.throwAt + GRENADE_FUSE_MS) {
      explodeGrenade(g);
      grenades = grenades.filter((h) => h.id !== g.id);
    }
  }

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
  // Class: the join may name one (rifleman is the default); the admin can
  // change it later with setClass, and solo players choose their own.
  const cls = CLASSES[msg.cls] ? msg.cls : 'rifleman';
  const cs = classStats(cls);
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
    admin: false, // set by the 'admin' message (correct code)
    alive: phase !== 'playing', // late joiners spectate until the next round
    health: 100,
    cls,
    inMag: cs.magSize,
    mags: cs.magCount - 1,
    grenades: grenadesAllowed ? GRENADE_COUNT : 0,
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
  send(ws, { t: 'joined', id: p.id, cls: p.cls });
  broadcastState();
}

// Solo mode: a lone player exploring the map. They have no team, are never
// the host, are never part of a match, cannot be shot and cannot shoot
// anyone. The room stays in whatever phase it is in.
function handleSolo(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 16) || `Player${ws._pid}`;
  const sessionId = String(msg.session || '').slice(0, 64) || null;
  takeOverDuplicates(name, null, sessionId, true);
  // Same-name solo players are the same person in two tabs: solo has no
  // teams, so two humans never need the same callsign there (the phantom
  // figure in solo was exactly this — an idle second tab). Kick-takeover
  // any remaining (active) same-name solo record: the kicked tab gets the
  // notice and does NOT rejoin (its saved join is cleared), so the tabs
  // can't ping-pong the record back and forth. Team players keep the
  // existing protection (an active same-name player is never taken over).
  for (const p of [...players.values()]) {
    if (p.solo && p.name === name) {
      send(p.ws, { t: 'kicked', reason: 'You joined solo in another tab.' });
      removePlayer(p);
      // Graceful close after a beat, like clear-room, so the message flushes.
      setTimeout(() => { try { p.ws.close(); } catch { /* already closed */ } }, 150);
    }
  }
  const spawn = SPAWNS.attackers[0];
  // Solo players choose their own class (Lior, 25/11/2026) — the join
  // may name one, rifleman is the default, and setClass changes it later.
  // They also choose whether to add grenades to their solo mode
  // (Lior, 25/11/2026): the join may carry grenades:false, on is the
  // default. The admin's grenades switch still governs the room.
  const cls = CLASSES[msg.cls] ? msg.cls : 'rifleman';
  const cs = classStats(cls);
  const p = {
    id: ws._pid,
    ws,
    name,
    team: null,
    solo: true,
    sessionId,
    joinedAt: Date.now(),
    admin: false, // a solo player may hold the code too, but the admin
    // controls (start / rename / setTeam) only apply to the match
    alive: true,
    health: 100,
    cls,
    inMag: cs.magSize,
    mags: cs.magCount - 1,
    grenades: grenadesAllowed && msg.grenades !== false ? GRENADE_COUNT : 0,
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
  send(ws, { t: 'soloJoined', id: p.id, cls: p.cls, spawn: { x: spawn.x, y: 0, z: spawn.z, yaw: spawn.yaw } });
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
    case 'checkInvite': {
      // Anyone may ask whether an invite link is still good (it arrives
      // with the page load, before joining). Expired codes are pruned.
      const code = String(msg.code || '');
      const rec = invites.get(code);
      const valid = !!rec && Date.now() < rec.expiresAt;
      if (rec && !valid) invites.delete(code);
      send(ws, { t: 'inviteStatus', code, valid, expiresAt: valid ? rec.expiresAt : null });
      return;
    }
    default:
      break;
  }
  // Spectators (bird's-eye admin view): no figure, no shots, no moves —
  // only the admin controls (start / continue / rematch) and leaving.
  // Only an admin can hold a spectator record (see case 'spectate'), so
  // no admin gate is needed here.
  const spec = spectators.get(ws._pid);
  if (spec && !p) {
    switch (msg.t) {
      case 'ping':
        break;
      case 'leaveSpectate': {
        spectators.delete(ws._pid);
        send(ws, { t: 'spectateLeft' });
        broadcastState();
        break;
      }
      case 'start': {
        if (phase !== 'lobby') return;
        if (playersOf('A').length < 1 || playersOf('B').length < 1) {
          send(ws, { t: 'error', message: 'Need at least 1 player on each team to start.' });
          return;
        }
        startMatch();
        break;
      }
      case 'continue': {
        if (phase !== 'intermission') return;
        startRound(round + 1);
        break;
      }
      case 'rematch': {
        if (phase !== 'ended') return;
        startMatch();
        break;
      }
      default:
        break; // spectators cannot shoot, move, or throw
    }
    return;
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
    case 'admin': {
      // Become the admin by entering the code (Lior, 25/11/2026).
      // The admin edits names, assigns teams and classes, decides on
      // grenades, and is the only one who can start / continue / rematch.
      // If the admin leaves, anyone else can enter the code and take over.
      if (msg.code !== ADMIN_CODE) {
        send(ws, { t: 'error', message: 'Wrong admin code.' });
        return;
      }
      p.admin = true;
      send(ws, { t: 'adminOk' });
      broadcastState();
      break;
    }
    case 'spectate': {
      // The admin leaves the match and watches from above (Lior,
      // 26/11/2026): no figure, no weapon, no shots — bird's-eye view.
      // The player record goes through the normal leave path (grace,
      // host migration, elimination check); the spectator record keeps
      // the admin flag, so the lobby still knows an admin exists.
      if (p.solo || !p.admin) return;
      const name = p.name;
      removePlayer(p);
      const id = nextSpectatorId--;
      spectators.set(id, { id, ws, name, admin: true });
      ws._pid = id;
      send(ws, { t: 'spectateJoined', id });
      broadcastState();
      break;
    }
    case 'createInvite': {
      // The admin makes a shareable link that admits entry for one hour
      // (Lior, 26/11/2026 — for the testing period). The code is random
      // (8 URL-safe chars); the link is origin/?invite=<code>. Expired
      // codes are pruned on creation so the map never grows.
      if (p.solo || !p.admin) return;
      for (const [c, r] of invites) if (Date.now() >= r.expiresAt) invites.delete(c);
      const code = randomBytes(6).toString('base64url');
      const expiresAt = Date.now() + INVITE_TTL_MS;
      invites.set(code, { code, expiresAt, createdBy: p.id });
      send(ws, { t: 'inviteCreated', code, expiresAt });
      break;
    }
    case 'rename': {
      // Admin only, team players only: rename a player (1-16 chars).
      // The on-body name patches rebuild from the new name.
      if (p.solo || !p.admin) return;
      const target = players.get(Number(msg.playerId));
      if (!target || target.solo) return;
      const name = String(msg.name || '').trim().slice(0, 16);
      if (!name) return;
      target.name = name;
      broadcastState();
      break;
    }
    case 'setTeam': {
      // Admin only, lobby only: move a team player to the other team.
      // Class and ammo stay; the start check (1 per team) still applies.
      if (p.solo || !p.admin || phase !== 'lobby') return;
      const target = players.get(Number(msg.playerId));
      if (!target || target.solo) return;
      if (msg.team !== 'A' && msg.team !== 'B') return;
      target.team = msg.team;
      broadcastState();
      break;
    }
    case 'setClass': {
      // Change a player's class (Lior, 25/11/2026). When an admin
      // exists, only the admin assigns a team player's class; with no
      // admin, the host does (the old rule). A solo player may always
      // change their own. Ammo resets to the new class's loadout.
      const cls = msg.cls;
      if (!CLASSES[cls]) return;
      const target = msg.playerId != null ? players.get(Number(msg.playerId)) : p;
      if (!target) return;
      const canAssign = adminPresent() ? p.admin : p.id === hostId;
      if (target.id !== p.id) {
        if (p.solo || !canAssign || target.solo) return;
      } else if (!p.solo && !canAssign) {
        return; // a team player may not change their own class
      }
      target.cls = cls;
      const tcs = classStats(cls);
      target.inMag = tcs.magSize;
      target.mags = tcs.magCount - 1;
      target.reloadingUntil = 0;
      broadcastState();
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
      // Only the admin may start — but only once an admin exists
      // (Lior, 25/11/2026). With no admin, anyone may start, as before.
      if (p.solo || phase !== 'lobby') return;
      if (adminPresent() && !p.admin) {
        send(ws, { t: 'error', message: 'Only the admin can start the match.' });
        return;
      }
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
      // Defense prep time: attackers wait at spawn — their position is
      // frozen, but they may still look around (yaw/pitch/stance apply).
      const prepFrozen = phase === 'playing' && !p.solo
        && roleOf(p.team) === 'attackers' && Date.now() < prepEndsAt;
      if (!prepFrozen) {
        // Clamp to the map so a bad client cannot teleport across the world.
        p.pos.x = Math.max(-18, Math.min(18, x));
        p.pos.z = Math.max(-62, Math.min(62, z));
        p.pos.y = Math.max(0, Math.min(3, y));
      }
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
      if (phase === 'playing' && !p.solo && now < prepEndsAt) return; // no shooting during prep
      if (now < p.reloadingUntil) return;
      if (p.inMag <= 0) return; // out of ammo in this mag: must reload
      // The shot carries the shooter's aiming state (the client sends
      // it with every shot); the move handler keeps it fresh between
      // shots. Aiming matters twice: the marksman's 1 shot/sec gate
      // applies only while aiming — from the hip he fires at the
      // rifleman's rate (Lior, 26/11/2026) — and ADS damage (below).
      if (typeof msg.aiming === 'boolean') p.aiming = msg.aiming;
      // Per-class fire rate — the server enforces it, not just the
      // client. The 90 ms floor is the plausibility floor for the
      // fastest class.
      let intervalMs = classStats(p.cls).fireIntervalMs;
      if (p.cls === 'marksman' && !p.aiming) intervalMs = classStats('rifleman').fireIntervalMs;
      if (now - p.lastShotAt < Math.max(FIRE_INTERVAL_MS, intervalMs)) return;
      p.lastShotAt = now;
      p.inMag -= 1;
      p.stats.shots += 1;
      let hit = false;
      let killed = false;
      let targetHealth = null;
      let damage = 0;
      let distance = null;
      // Solo shots never hit players; solo players can never be hit.
      const target = p.solo ? null : (msg.targetId != null ? players.get(Number(msg.targetId)) : null);
      // The broadcast echoes the claimed target whenever it resolved —
      // even on a miss (a solo, dead or own target) — so the shooter can
      // tell what the shot was aimed at. An NPC hit reports the NPC's
      // own (negative) id.
      let shotTargetId = target ? target.id : null;
      // Friendly fire is ON: any living player except yourself can be hit.
      if (target && target.alive && target.id !== p.id && !target.solo) {
        const dx = target.pos.x - p.pos.x;
        const dy = target.pos.y - p.pos.y;
        const dz = target.pos.z - p.pos.z;
        distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        damage = damageForShot(p, distance);
        if (damage <= 0) {
          // Class rule: the shot cannot hit at this range (standing
          // gunner past 15 m) — a miss, no damage, no hit credit.
        } else {
          hit = true;
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
      }
      // Solo players can shoot the NPCs: same distance damage as a
      // player. Enough hits put one down for good (no revive; the set
      // is re-drawn only when the next solo session starts). Not a
      // match kill: no state broadcast, no elimination check, no kill
      // credit. An NPC hit reports its own (negative) id.
      const npcHit = p.solo ? npcs.find((n) => n.id === Number(msg.targetId)) : null;
      if (npcHit && npcHit.health > 0) {
        const dx = npcHit.x - p.pos.x;
        const dy = npcHit.y - p.pos.y;
        const dz = npcHit.z - p.pos.z;
        distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        damage = damageForShot(p, distance);
        if (damage <= 0) {
          // Class rule: the shot cannot hit at this range — a miss.
          shotTargetId = npcHit.id;
        } else {
          hit = true;
          shotTargetId = npcHit.id;
          p.stats.hits += 1;
          p.stats.damage += damage;
          npcHit.health -= damage;
          if (npcHit.health <= 0) {
            npcHit.health = 0;
            npcHit.aiming = false;
            npcHit.burstLeft = 0;
            killed = true;
          }
          targetHealth = npcHit.health;
        }
      }
      // The wall/floor impact point is the shooter's raycast result —
      // trusted like positions. It is echoed so other players see the
      // hit (26/11/2026) and hear it when it lands near them.
      let impact = null;
      if (msg.impact && Number.isFinite(msg.impact.x) && Number.isFinite(msg.impact.y) && Number.isFinite(msg.impact.z)) {
        impact = {
          x: Math.round(msg.impact.x * 10) / 10,
          y: Math.round(msg.impact.y * 10) / 10,
          z: Math.round(msg.impact.z * 10) / 10,
        };
      }
      broadcast({
        t: 'shot',
        shooterId: p.id,
        targetId: shotTargetId,
        hit,
        friendlyFire: hit && target ? target.team === p.team : false,
        damage,
        distance: distance == null ? null : Math.round(distance * 10) / 10,
        targetHealth,
        killed,
        inMag: p.inMag,
        mags: p.mags,
        impact,
      });
      // A real player kill can end the round; an NPC down cannot.
      if (killed && target) {
        broadcastState();
        checkElimination();
      }
      break;
    }
    case 'reload': {
      const now = Date.now();
      if ((phase !== 'playing' && !p.solo) || !p.alive) return;
      if (now < p.reloadingUntil) return;
      const cs = classStats(p.cls);
      if (p.mags <= 0 || p.inMag >= cs.magSize) return;
      p.reloadingUntil = now + cs.reloadMs;
      broadcast({ t: 'reloadStart', playerId: p.id, reloadMs: cs.reloadMs });
      break;
    }
    case 'throwGrenade': {
      // The client's 3 s arming already ran (icon fill); this is the
      // throw itself. One grenade, an arc to 10 m (or the wall before
      // it), a 3 s fuse from here. No throwing during prep — like shots.
      const now = Date.now();
      if (!grenadesAllowed) return;
      if ((phase !== 'playing' && !p.solo) || !p.alive) return;
      if (phase === 'playing' && !p.solo && now < prepEndsAt) return;
      if ((p.grenades ?? 0) <= 0) return;
      p.grenades -= 1;
      const sim = simulateThrow(p);
      const g = {
        id: nextGrenadeId++,
        throwerId: p.id,
        throwAt: now,
        flightMs: Math.round(GRENADE_FLIGHT_MS * (sim.dist / GRENADE_RANGE_M)),
        dist: sim.dist,
        dir: sim.dir,
        from: { x: p.pos.x, y: p.pos.y + 1.4, z: p.pos.z },
        to: sim.to,
        landed: false,
        exploded: false,
      };
      grenades.push(g);
      broadcast({ t: 'grenadeThrown', id: g.id, throwerId: p.id, from: g.from, to: g.to, flightMs: g.flightMs });
      broadcastState(); // the grenade count changed
      break;
    }
    case 'setGrenadesAllowed': {
      // Grenades on/off for the room. When an admin exists, only the
      // admin toggles it; with no admin, the host does (the old rule).
      // Players keep their current counts; the throw itself is gated
      // on the flag, and the next round reset deals none out while off.
      if (p.solo) return;
      if (adminPresent() ? !p.admin : p.id !== hostId) return;
      grenadesAllowed = msg.allowed === true;
      broadcastState();
      break;
    }
    case 'setPrepEnabled': {
      // Prep time on/off for the room. Off by default; the admin or ANY
      // team player can toggle it (Lior, 26/11/2026) — unlike grenades,
      // this one is not gated on the admin/host. Applies from the next
      // round (a running round keeps its own prepEndsAt).
      if (p.solo) return;
      prepEnabled = msg.enabled === true;
      broadcastState();
      break;
    }
    case 'setRoundDuration': {
      // Round length in minutes, set by the admin in the lobby
      // (Lior, 26/11/2026). Applies from the next round — a running
      // round keeps its own roundEndsAt. When an admin exists, only
      // the admin sets it; with no admin, the host does (the grenades
      // rule). Clamped to 1–30 minutes.
      if (p.solo) return;
      if (adminPresent() ? !p.admin : p.id !== hostId) return;
      const mins = Number(msg.minutes);
      if (!Number.isFinite(mins)) return;
      roundDurationMs = Math.min(30, Math.max(1, Math.round(mins))) * 60 * 1000;
      broadcastState();
      break;
    }
    case 'leaveSolo': {
      if (!p.solo) return;
      removePlayer(p);
      send(ws, { t: 'soloLeft' });
      break;
    }
    case 'leave': {
      // A team player leaving deliberately (EXIT button): same as a
      // disconnect — a mid-match leave opens the 5-minute grace window,
      // so a mistaken tap is not fatal (rejoin as a spectator until the
      // next round). Solo players use leaveSolo.
      if (p.solo) return;
      handleDisconnect(ws);
      send(ws, { t: 'left' });
      break;
    }
    case 'continue': {
      // Only the admin presses CONTINUE during an intermission — but
      // only once an admin exists (Lior, 25/11/2026); with no admin,
      // anyone may press it, as before. (Solo players are not part of
      // the match, so they cannot.)
      if (p.solo || phase !== 'intermission') return;
      if (adminPresent() && !p.admin) return;
      startRound(round + 1);
      break;
    }
    case 'rematch': {
      if (p.solo || phase !== 'ended') return;
      if (adminPresent() && !p.admin) return;
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
  // The NPC set lives only while at least one solo player is present.
  // Clear it eagerly here — not just on the next tick in updateNpcs —
  // or a solo rejoin landing before that tick resurrects the stale set
  // (a downed NPC would still be down). A same-name tab takeover also
  // clears it; the set is re-drawn fresh on the next tick.
  if (![...players.values()].some((q) => q.solo)) npcs = [];
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
    // Broadcast the reset: without this, unjoined watchers (and the
    // exit-run observer) keep the stale pre-reset state forever —
    // every other removePlayer path broadcasts below.
    broadcastState();
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
  // A spectator leaving (tab closed, socket dead) just disappears from
  // the watch list; the lobby's admin flag follows via broadcastState.
  const spec = spectators.get(ws._pid);
  if (spec) {
    spectators.delete(ws._pid);
    broadcastState();
    return;
  }
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
    // Cache policy (23/11/2026 — the launch white screen): iOS discards
    // background tabs, so every return to the game re-downloaded ~750 KB.
    // Three.js only changes on a dependency upgrade and its URL carries
    // ?v=<version>, so it can be cached immutably for a year. App files
    // change on every deploy: revalidate with Last-Modified (cheap 304).
    const isThree = pathname.startsWith('/three/');
    fs.stat(filePath, (statErr, stat) => {
      if (statErr) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (isThree) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      } else {
        headers['Cache-Control'] = 'no-cache';
        headers['Last-Modified'] = stat.mtime.toUTCString();
        const since = req.headers['if-modified-since'];
        if (since && Date.parse(since) >= Math.floor(stat.mtime.getTime() / 1000) * 1000) {
          res.writeHead(304);
          res.end();
          return;
        }
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, headers);
        res.end(data);
      });
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

// headless-test.mjs — scripted end-to-end test of the game server.
//
// Spawns the real server on port 8021 with a short round timer, connects
// fake WebSocket clients, and plays through:
//   Scenario 1 (2v2): elimination round win, then an objective round win,
//     then a reload cycle — verifying round resets between rounds.
//   Scenario 2 (1v2): asymmetric teams — starting with 1 player on a side
//     must succeed (but starting with an empty team must fail).
//   Scenario 3 (solo): one player explores alone — no team, room stays in
//     lobby, shooting and reload work, nobody can shoot them or be shot by
//     them, a match can start alongside, and leaving solo mid-match does
//     NOT let them join a team until the match ends (no mid-match joins).
//   Scenario 4 (clear room): a non-host clearRoom is ignored; the host's
//     clearRoom sends 'kicked' to every other player (teams and solo),
//     closes their sockets, and leaves the host alone in the lobby.
//   Scenario 5 (no mid-match joins): a newcomer joining during a match is
//     rejected with an error and the room stays unchanged; the waiter still
//     receives state snapshots; a disconnected match player may rejoin
//     within the grace window (same callsign + team) and spectates until
//     the next round.
//   Scenario 6 (heartbeat): a player who stops pinging mid-match is swept
//     from the room within the timeout and their socket is terminated;
//     they may rejoin within the grace window like a clean disconnect.
//     (Every scenario runs with a 3 s heartbeat timeout, so clients that
//     keep pinging prove they are never swept.)
//   Scenario 7 (capture hold + match stats): entering the objective zone
//     does NOT end the round instantly — leaving before the hold time
//     resets the capture; holding for the full time wins the round by
//     objective. A full 1v1 match to 3-0 ends with a matchEnd carrying
//     per-player stats (kills, deaths, shots, hits, accuracy, damage,
//     teamkills, captures), sorted by kills then damage.
//   Scenario 8 (ghost + session takeover): a player whose tab froze
//     (silent, socket open) comes back on a new connection BEFORE the
//     heartbeat sweep removes the old record — the rejoin takes over
//     the ghost instead of duplicating the player (lobby and mid-match),
//     the ghost's socket is terminated, and an ACTIVE same-name player
//     is protected (mid-match same-name join is rejected). A rejoin
//     from the SAME tab session takes over immediately, with no
//     silence wait at all.
//   Scenario 9 (stance flags): crouch / aiming sent in a move show up
//     in the next snapshots for every other client, clearing them
//     clears the relay, and non-boolean junk is ignored. (The poses
//     themselves are client-side; this covers the wire only.)
//   Scenario 10 (solo NPCs): while a solo player is in the lobby, 10
//     NPC targets appear in snapshots (never in state) — ids -1..-10,
//     spread over both sides of the street and both floors, in windows.
//     They fire 3-shot bursts at a solo player within 30 m (shots never
//     hit, aim pose on), stop when they leave range, and vanish when the
//     last solo player leaves.
//   Scenario 11 (solo same-name takeover): two solo players with the
//     same callsign are the same person in two tabs — the second join
//     kick-takeovers the first (the kicked tab gets 'kicked' and its
//     socket closes, so it can't rejoin and ping-pong). Solo players
//     with different names coexist untouched.
//   Scenario 12 (solo NPC shoot-down): a solo shot at another player
//     still never hits; distance damage on NPCs (1 hit <= 15 m, 2 hits
//     15-50 m, 3 hits > 50 m); a downed NPC stays down — no revive —
//     and stops firing, and shots at it do not hit.
//   Scenario 13 (deliberate team leave): a 1v1 match, one player sends
//     'leave' mid-match — the leaver gets 'left', the other team wins
//     the round by elimination, the leaver is gone from the state, and
//     they may rejoin within the grace window (same callsign + team).
//     A solo player sending 'leave' is ignored (solo uses leaveSolo).
//   Scenario 14 (solo NPC reset + harmless fire): NPC shots never
//     damage the solo player (health stays 100 through bursts); leaving
//     solo and rejoining re-draws the set — all 10 NPCs alive again at
//     full health, including one shot down before leaving.
//
// Run: node test/headless-test.mjs  (or: npm test)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { SPAWNS } from '../public/map.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8021;
const URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait until fn() returns truthy (or timeout). Returns the truthy value.
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await sleep(50);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.id = null;
    this.ws = new WebSocket(URL);
    this.ws.on('error', () => { /* connection errors surface as ready() timeouts */ });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      this.inbox.push(msg);
      if (msg.t === 'welcome') this.id = msg.id;
    });
    // Heartbeat like the real client (1 s here — the test server runs a
    // 3 s timeout). Guarded on readyState so a server-closed socket
    // (kicked / swept) does not throw.
    this.pingTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.send({ t: 'ping' });
    }, 1000);
  }

  // Stop the heartbeat (simulates a dead connection for the ghost test).
  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  async ready() {
    await waitFor(() => this.ws.readyState === WebSocket.OPEN && this.id != null, 5000, `${this.name} connect`);
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  find(type, pred) {
    return this.inbox.find((m) => m.t === type && (!pred || pred(m)));
  }

  findLast(type, pred) {
    const list = this.inbox.filter((m) => m.t === type && (!pred || pred(m)));
    return list[list.length - 1];
  }

  async waitFor(type, pred, timeoutMs = 8000) {
    return waitFor(() => this.find(type, pred), timeoutMs, `${this.name} waits for ${type}`);
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws.close();
  }
}

async function waitForServerUp() {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.status === 200) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error('timeout waiting for server HTTP up');
    await sleep(100);
  }
}

async function main() {
  console.log('starting server on port', PORT);
  const server = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ROUND_MS: '60000', CAPTURE_MS: '600', HEARTBEAT_TIMEOUT_MS: '3000', HEARTBEAT_SWEEP_MS: '1000', GHOST_SILENCE_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d; });
  server.stderr.on('data', (d) => { serverOutput += d; });
  const stopServer = () => {
    try { server.kill('SIGTERM'); } catch { /* already dead */ }
  };
  process.on('exit', stopServer);

  try {
    await waitForServerUp(server);
    console.log('ok - server is up and serves / with 200');

    // ------------------------------------------------ scenario 1: 2v2
    const a1 = new Client('A1');
    const a2 = new Client('A2');
    const b1 = new Client('B1');
    const b2 = new Client('B2');
    for (const c of [a1, a2, b1, b2]) await c.ready();
    a1.send({ t: 'join', name: 'A1', team: 'A' });
    a2.send({ t: 'join', name: 'A2', team: 'A' });
    b1.send({ t: 'join', name: 'B1', team: 'B' });
    b2.send({ t: 'join', name: 'B2', team: 'B' });
    await a1.waitFor('state', (m) => m.players.length === 4);
    console.log('ok - 4 clients joined 2v2');

    // Host (first joiner = A1) picks attackers and starts.
    a1.send({ t: 'setAttackers', team: 'A' });
    a1.send({ t: 'start' });
    const r1 = await a1.waitFor('roundStart', (m) => m.round === 1);
    await a1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - match started, round 1 playing, A attacks');
    assert.ok(r1.objective, 'roundStart should carry the objective');
    assert.ok(Math.abs(r1.objective.x) === 11 && r1.objective.z === 45,
      `objective must be a defenders spawn centre, got ${JSON.stringify(r1.objective)}`);
    console.log('ok - round 1 objective is a defenders spawn centre (random side draw)');

    // Everyone sends movement updates from their spawn points.
    const sendMoves = () => {
      a1.send({ t: 'move', x: SPAWNS.attackers[0].x, y: 0, z: SPAWNS.attackers[0].z, yaw: Math.PI, pitch: 0 });
      a2.send({ t: 'move', x: SPAWNS.attackers[1].x, y: 0, z: SPAWNS.attackers[1].z, yaw: Math.PI, pitch: 0 });
      b1.send({ t: 'move', x: SPAWNS.defenders[0].x, y: 0, z: SPAWNS.defenders[0].z, yaw: 0, pitch: 0 });
      b2.send({ t: 'move', x: SPAWNS.defenders[1].x, y: 0, z: SPAWNS.defenders[1].z, yaw: 0, pitch: 0 });
    };
    sendMoves();
    await sleep(300);
    sendMoves();

    // Damage falloff: close range (<=15 m) kills in 1 hit, medium (15-50 m)
    // in 2 hits. A1 moves to 5 m from B1 (close), then to 30 m from B2.
    const shootOnce = async (shooter, target) => {
      shooter.send({ t: 'shot', targetId: target.id });
      await sleep(150);
    };
    a1.send({ t: 'move', x: -5, y: 0, z: 50, yaw: 0, pitch: 0 });
    await sleep(150);
    await shootOnce(a1, b1);
    const kill1 = a1.find('shot', (m) => m.targetId === b1.id && m.killed);
    assert.ok(kill1, 'B1 should be dead after 1 close-range hit');
    assert.equal(kill1.damage, 100);
    console.log('ok - close range (5 m): 1 hit kills (100 damage)');
    a1.send({ t: 'move', x: -3, y: 0, z: 25, yaw: 0, pitch: 0 });
    await sleep(150);
    await shootOnce(a1, b2);
    const mid1 = a1.find('shot', (m) => m.targetId === b2.id && !m.killed);
    assert.ok(mid1, 'first medium-range hit should land without killing');
    assert.equal(mid1.damage, 50);
    assert.equal(mid1.targetHealth, 50);
    await shootOnce(a1, b2);
    console.log('ok - medium range (30 m): 2 hits kill (50 damage each)');
    const round1End = await a1.waitFor('roundEnd', (m) => m.winner === 'A' && m.reason === 'elimination');
    assert.equal(round1End.score.A, 1);
    console.log('ok - round 1 ends: attackers win by elimination, score 1-0');

    // Round 2 must NOT start on its own: the intermission waits for a
    // player to press CONTINUE. Attackers then win by reaching THIS
    // round's objective (it moves with each round's side draw).
    await sleep(1500);
    assert.equal(a1.find('roundStart', (m) => m.round === 2), undefined,
      'round 2 must not start without CONTINUE');
    console.log('ok - round 2 does not start by itself during the intermission');
    a1.send({ t: 'continue' });
    const r2 = await a1.waitFor('roundStart', (m) => m.round === 2);
    console.log('ok - round 2 starts after CONTINUE (positions/ammo reset)');
    assert.ok(r2.objective && Math.abs(r2.objective.x) === 11 && r2.objective.z === 45,
      `round 2 objective must be a defenders spawn centre, got ${JSON.stringify(r2.objective)}`);
    a2.send({ t: 'move', x: r2.objective.x, y: 0, z: r2.objective.z, yaw: 0, pitch: 0 });
    const round2End = await a1.waitFor('roundEnd', (m) => m.winner === 'A' && m.reason === 'objective');
    assert.equal(round2End.score.A, 2);
    console.log('ok - round 2 ends: attackers win by reaching the objective, score 2-0');

    a1.send({ t: 'continue' });
    await a1.waitFor('roundStart', (m) => m.round === 3);
    console.log('ok - round 3 started after CONTINUE');

    // Long range (>50 m): A1 shoots B1 from spawn to spawn (~110 m).
    // 3 hits of 34 damage to kill.
    a1.send({ t: 'move', x: -5, y: 0, z: -55, yaw: 0, pitch: 0 });
    await sleep(150);
    await shootOnce(a1, b1);
    const long1 = a1.findLast('shot', (m) => m.targetId === b1.id && !m.killed);
    assert.ok(long1, 'first long-range hit should land without killing');
    assert.equal(long1.damage, 34);
    assert.equal(long1.targetHealth, 66);
    await shootOnce(a1, b1);
    const long2 = a1.findLast('shot', (m) => m.targetId === b1.id && !m.killed);
    assert.equal(long2.damage, 34);
    assert.equal(long2.targetHealth, 32);
    await shootOnce(a1, b1);
    const longKill = a1.findLast('shot', (m) => m.targetId === b1.id && m.killed);
    assert.ok(longKill, 'B1 should be dead after 3 long-range hits');
    assert.equal(longKill.damage, 34);
    console.log('ok - long range (110 m): 3 hits kill (34 damage each)');

    // Friendly fire: move A2 next to A1 first (spawn sides are drawn
    // randomly each round, so A2 may be on the far side of the street),
    // then A1 shoots teammate A2 once — A2 must die.
    a2.send({ t: 'move', x: -5, y: 0, z: -50, yaw: 0, pitch: 0 });
    await sleep(150);
    a1.send({ t: 'shot', targetId: a2.id });
    const tk = await a1.waitFor('shot', (m) => m.targetId === a2.id && m.killed, 5000);
    assert.equal(tk.friendlyFire, true);
    console.log('ok - friendly fire: 1 teammate hit kills (flagged as teamkill)');

    // Reload cycle: A1 fired 2 shots in round 1, so after the round-2 reset
    // the mag is full again. Fire once, reload, expect a full mag and one
    // fewer spare after ~3.5s.
    a1.send({ t: 'shot', targetId: null });
    await sleep(150);
    a1.send({ t: 'reload' });
    await a1.waitFor('reloadStart', (m) => m.playerId === a1.id);
    const reloaded = await a1.waitFor('reloaded', (m) => m.playerId === a1.id, 6000);
    assert.equal(reloaded.inMag, 29);
    assert.equal(reloaded.mags, 4);
    console.log('ok - reload takes ~3.5s and refills the mag (29 rounds, 4 spares left)');

    // No auto-reload: empty the mag completely, wait past the reload time,
    // and confirm no reload happened on its own.
    const reloadedBefore = a1.inbox.filter((m) => m.t === 'reloaded' && m.playerId === a1.id).length;
    for (let i = 0; i < 29; i++) {
      a1.send({ t: 'shot', targetId: null });
      await sleep(110);
    }
    await sleep(4500);
    const reloadedAfter = a1.inbox.filter((m) => m.t === 'reloaded' && m.playerId === a1.id).length;
    assert.equal(reloadedAfter, reloadedBefore, 'no auto-reload may happen');
    const lastShot = a1.findLast('shot', (m) => m.shooterId === a1.id);
    assert.equal(lastShot.inMag, 0);
    console.log('ok - no auto-reload: mag stays empty until the reload button is pressed');

    for (const c of [a1, a2, b1, b2]) c.close();
    await sleep(600); // let the server notice the empty room and reset

    // ------------------------------------------------ scenario 2: 1v2
    const c1 = new Client('C1');
    await c1.ready();
    c1.send({ t: 'join', name: 'C1', team: 'A' });
    await c1.waitFor('joined');
    // Starting with an empty enemy team must fail.
    c1.send({ t: 'start' });
    const err = await c1.waitFor('error', (m) => /each team/.test(m.message));
    assert.ok(err, 'expected an error when starting with an empty team');
    console.log('ok - start is rejected with an empty team');

    const d1 = new Client('D1');
    const d2 = new Client('D2');
    for (const c of [d1, d2]) await c.ready();
    d1.send({ t: 'join', name: 'D1', team: 'B' });
    d2.send({ t: 'join', name: 'D2', team: 'B' });
    await c1.waitFor('state', (m) => m.players.length === 3);
    d1.send({ t: 'start' }); // D1 is not the host; any player may start
    await c1.waitFor('roundStart', (m) => m.round === 1);
    console.log('ok - asymmetric 1v2 match starts fine (non-host start)');

    for (const c of [c1, d1, d2]) c.close();
    await sleep(600); // let the server notice the empty room and reset

    // ------------------------------------------------ scenario 3: solo mode
    const s = new Client('Solo');
    await s.ready();
    s.send({ t: 'solo', name: 'Solo' });
    const soloJoined = await s.waitFor('soloJoined');
    assert.ok(soloJoined.spawn, 'soloJoined should carry a spawn point');
    console.log('ok - solo player enters solo mode with a spawn point');
    const soloState = await s.waitFor('state', (m) => m.players.some((p) => p.id === s.id && p.solo === true));
    assert.equal(soloState.phase, 'lobby', 'room stays in lobby while someone plays solo');
    assert.equal(soloState.players.find((p) => p.id === s.id).team, null);
    console.log('ok - solo player listed as solo with no team, room stays in lobby');

    // Solo shooting consumes ammo but never hits; reload works.
    s.send({ t: 'shot', targetId: null });
    const soloShot = await s.waitFor('shot', (m) => m.shooterId === s.id);
    assert.equal(soloShot.hit, false);
    assert.equal(soloShot.inMag, 28);
    console.log('ok - solo shot fires (28 rounds left) and hits nothing');
    s.send({ t: 'reload' });
    await s.waitFor('reloadStart', (m) => m.playerId === s.id);
    const soloReloaded = await s.waitFor('reloaded', (m) => m.playerId === s.id, 6000);
    assert.equal(soloReloaded.inMag, 29);
    assert.equal(soloReloaded.mags, 4);
    console.log('ok - solo reload works (29 rounds, 4 spares left)');

    // A match can start while someone is solo, and the solo player is
    // untouched by it: team players cannot hit them, they cannot hit back.
    const j1 = new Client('J1');
    const k1 = new Client('K1');
    await j1.ready();
    await k1.ready();
    j1.send({ t: 'join', name: 'J1', team: 'A' });
    k1.send({ t: 'join', name: 'K1', team: 'B' });
    await j1.waitFor('state', (m) => m.players.length === 3);
    j1.send({ t: 'start' });
    await j1.waitFor('roundStart', (m) => m.round === 1);
    console.log('ok - match starts with a solo player in the room (solo is never host)');
    j1.send({ t: 'shot', targetId: s.id });
    const missOnSolo = await j1.waitFor('shot', (m) => m.shooterId === j1.id && m.targetId === s.id);
    assert.equal(missOnSolo.hit, false);
    const shotsBefore = s.inbox.filter((m) => m.t === 'shot' && m.shooterId === s.id).length;
    s.send({ t: 'shot', targetId: j1.id });
    const soloMiss = await waitFor(
      () => s.inbox.filter((m) => m.t === 'shot' && m.shooterId === s.id)[shotsBefore],
      5000,
      'solo shot at a team player',
    );
    assert.equal(soloMiss.hit, false);
    assert.equal(soloMiss.targetId, null);
    console.log('ok - solo player cannot be shot and cannot shoot others');
    const snap = await s.waitFor('snapshot', (m) => m.players.some((p) => p.id === s.id));
    const soloSnap = snap.players.find((p) => p.id === s.id);
    assert.equal(soloSnap.alive, true);
    assert.equal(soloSnap.health, 100);
    console.log('ok - solo player survives the round reset untouched');

    // Leave solo mid-match: the player is out of the room, but joining
    // a team is blocked until the match ends (no mid-match joins).
    s.send({ t: 'leaveSolo' });
    await s.waitFor('soloLeft');
    // A remaining player confirms the solo player is gone (the leaver's
    // own inbox also holds a stale empty-room state from connect time).
    await j1.waitFor('state', (m) => !m.players.some((p) => p.id === s.id));
    console.log('ok - leaving solo removes the player from the room');
    s.send({ t: 'join', name: 'Solo', team: 'A' });
    const soloJoinErr = await s.waitFor('error', (m) => /in progress/.test(m.message || ''));
    assert.ok(soloJoinErr);
    await sleep(300);
    assert.equal(j1.findLast('state').players.length, 2, 'ex-solo player must not join a team mid-match');
    console.log('ok - after leaving solo mid-match, joining a team is blocked until the match ends');

    for (const c of [s, j1, k1]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 4: clear room
    const h1 = new Client('H1');
    const h2 = new Client('H2');
    const o1 = new Client('O1');
    const s4 = new Client('S4');
    for (const c of [h1, h2, o1, s4]) await c.ready();
    h1.send({ t: 'join', name: 'H1', team: 'A' });
    h2.send({ t: 'join', name: 'H2', team: 'A' });
    o1.send({ t: 'join', name: 'O1', team: 'B' });
    s4.send({ t: 'solo', name: 'S4' });
    await h1.waitFor('state', (m) => m.players.length === 4);
    console.log('ok - 4 clients joined for the clear-room test (host + teammate + opponent + solo)');
    // Non-host clearRoom is ignored.
    o1.send({ t: 'clearRoom' });
    await sleep(500);
    assert.equal(h1.findLast('state').players.length, 4, 'non-host clearRoom must be ignored');
    console.log('ok - non-host clearRoom is ignored');
    // Host clears: everyone else gets 'kicked' and their socket closes.
    h1.send({ t: 'clearRoom' });
    await h2.waitFor('kicked');
    await o1.waitFor('kicked');
    await s4.waitFor('kicked');
    await waitFor(() => h2.ws.readyState === WebSocket.CLOSED, 5000, 'H2 socket closed');
    await waitFor(() => o1.ws.readyState === WebSocket.CLOSED, 5000, 'O1 socket closed');
    await waitFor(() => s4.ws.readyState === WebSocket.CLOSED, 5000, 'S4 socket closed');
    const cleared = await waitFor(
      () => {
        const last = h1.findLast('state');
        return last && last.players.length === 1 ? last : null;
      },
      5000,
      'room cleared down to the host',
    );
    assert.equal(cleared.players[0].name, 'H1');
    assert.equal(cleared.phase, 'lobby');
    console.log('ok - host clearRoom kicks everyone else; host stays alone in the lobby');

    h1.close();
    await sleep(300);

    // ------------------------------------------------ scenario 5: no mid-match joins
    const m1 = new Client('M1');
    const m1b = new Client('M1b');
    const m2 = new Client('M2');
    const m2b = new Client('M2b');
    const late = new Client('Late');
    for (const c of [m1, m1b, m2, m2b, late]) await c.ready();
    m1.send({ t: 'join', name: 'M1', team: 'A' });
    m1b.send({ t: 'join', name: 'M1b', team: 'A' });
    m2.send({ t: 'join', name: 'M2', team: 'B' });
    m2b.send({ t: 'join', name: 'M2b', team: 'B' });
    await m1.waitFor('state', (m) => m.players.length === 4);
    m1.send({ t: 'start' });
    await m1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - 2v2 match started for the no-mid-match-join test');
    // A newcomer cannot join mid-match: the server rejects with an
    // error and the room stays at 4 players.
    late.send({ t: 'join', name: 'Late', team: 'A' });
    const joinErr = await late.waitFor('error', (m) => /in progress/.test(m.message || ''));
    assert.ok(joinErr);
    await sleep(300);
    assert.equal(m1.findLast('state').players.length, 4, 'late joiner must not enter the room mid-match');
    console.log('ok - newcomer join is rejected mid-match');
    // The waiter still receives state snapshots, so the lobby can show
    // the wait message and re-enable joining when the match ends.
    assert.ok(late.find('state', (m) => m.phase === 'playing'), 'waiter must receive state snapshots');
    console.log('ok - waiter receives state snapshots while unjoined');
    // A disconnected match player may rejoin within the grace window
    // (same callsign + team) — and spectates until the next round.
    m2.close();
    await waitFor(() => {
      const last = m1.findLast('state');
      return last && last.players.length === 3 ? last : null;
    }, 5000, 'disconnect reflected in state');
    const m2c = new Client('M2c');
    await m2c.ready();
    m2c.send({ t: 'join', name: 'M2', team: 'B' });
    await waitFor(() => {
      const last = m1.findLast('state');
      return last && last.players.length === 4 ? last : null;
    }, 5000, 'rejoined player back in the room');
    await sleep(300); // let a post-rejoin snapshot arrive
    const rejoinSnap = m1.findLast('snapshot');
    const rejoined = rejoinSnap.players.find((p) => p.id === m2c.id);
    assert.ok(rejoined, 'rejoined player must appear in snapshots');
    assert.equal(rejoined.alive, false, 'mid-match rejoiner spectates until the next round');
    console.log('ok - disconnected match player rejoins within the grace window and spectates');

    for (const c of [m1, m1b, m2b, m2c, late]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 6: heartbeat / ghost sweep
    const g1 = new Client('G1');
    const g2 = new Client('G2');
    const g3 = new Client('G3');
    const g4 = new Client('G4');
    for (const c of [g1, g2, g3, g4]) await c.ready();
    g1.send({ t: 'join', name: 'G1', team: 'A' });
    g2.send({ t: 'join', name: 'G2', team: 'A' });
    g3.send({ t: 'join', name: 'G3', team: 'B' });
    g4.send({ t: 'join', name: 'G4', team: 'B' });
    await g1.waitFor('state', (m) => m.players.length === 4);
    g1.send({ t: 'start' });
    await g1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - 2v2 match started for the heartbeat test');
    // G3 goes silent (dead connection): the sweep removes them within
    // the timeout, and their socket is terminated.
    g3.stopPing();
    await waitFor(() => {
      const last = g1.findLast('state');
      return last && last.players.length === 3 ? last : null;
    }, 10000, 'silent player swept from the room');
    await waitFor(() => g3.ws.readyState === WebSocket.CLOSED, 5000, 'ghost socket terminated');
    console.log('ok - silent player is swept from the room and their socket is terminated');
    // The swept player may rejoin within the grace window (same
    // callsign + team) — the unclean disconnect behaves like a clean one.
    const g3b = new Client('G3b');
    await g3b.ready();
    g3b.send({ t: 'join', name: 'G3', team: 'B' });
    await waitFor(() => {
      const last = g1.findLast('state');
      return last && last.players.length === 4 ? last : null;
    }, 5000, 'swept player rejoined within the grace window');
    console.log('ok - swept player rejoins within the grace window');

    for (const c of [g1, g2, g4, g3b]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 7: capture hold + match stats
    const e1 = new Client('E1');
    const f1 = new Client('F1');
    for (const c of [e1, f1]) await c.ready();
    e1.send({ t: 'join', name: 'E1', team: 'A' });
    f1.send({ t: 'join', name: 'F1', team: 'B' });
    await e1.waitFor('state', (m) => m.players.length === 2);
    e1.send({ t: 'setAttackers', team: 'A' });
    e1.send({ t: 'start' });
    const q1 = await e1.waitFor('roundStart', (m) => m.round === 1);
    await e1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - 1v1 match started for the capture/stats test');

    // Round 1: E1 kills F1 from 5 m (close range, 1 hit). E1 stands 5.8 m
    // from the objective centre — outside the zone, so no capture starts.
    e1.send({ t: 'move', x: q1.objective.x - 3, y: 0, z: 40, yaw: 0, pitch: 0 });
    await sleep(150);
    e1.send({ t: 'shot', targetId: f1.id });
    const q1End = await e1.waitFor('roundEnd', (m) => m.reason === 'elimination' && m.score.A === 1);
    assert.ok(q1End);
    console.log('ok - round 1 ends by elimination (1-0), no accidental capture');

    // Round 2: entering the zone must NOT end the round instantly.
    e1.send({ t: 'continue' });
    const q2 = await e1.waitFor('roundStart', (m) => m.round === 2);
    const roundEndsBefore = e1.inbox.filter((m) => m.t === 'roundEnd').length;
    e1.send({ t: 'move', x: q2.objective.x, y: 0, z: q2.objective.z, yaw: 0, pitch: 0 });
    await sleep(300); // half the 600 ms hold time
    e1.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }); // leave early
    await sleep(900); // past the hold time — the round must still be live
    assert.equal(
      e1.inbox.filter((m) => m.t === 'roundEnd').length, roundEndsBefore,
      'leaving the zone before the hold completes must not end the round',
    );
    console.log('ok - entering the zone and leaving early does not end the round');
    // Re-enter and hold the full time: the round ends by objective.
    e1.send({ t: 'move', x: q2.objective.x, y: 0, z: q2.objective.z, yaw: 0, pitch: 0 });
    const q2End = await e1.waitFor('roundEnd', (m) => m.winner === 'A' && m.reason === 'objective');
    assert.equal(q2End.score.A, 2);
    console.log('ok - holding the zone for the full time wins the round by objective (2-0)');

    // Round 3: E1 kills F1 again — match ends 3-0 with a stats board.
    e1.send({ t: 'continue' });
    const q3 = await e1.waitFor('roundStart', (m) => m.round === 3);
    e1.send({ t: 'move', x: q3.objective.x - 3, y: 0, z: 40, yaw: 0, pitch: 0 });
    await sleep(150);
    e1.send({ t: 'shot', targetId: f1.id });
    const matchEnd = await e1.waitFor('matchEnd', (m) => m.winner === 'A' && m.score.A === 3);
    assert.ok(Array.isArray(matchEnd.stats), 'matchEnd must carry a stats array');
    assert.equal(matchEnd.stats.length, 2, 'stats cover both match players');
    const [first, second] = matchEnd.stats;
    assert.equal(first.name, 'E1', 'stats are sorted by kills, best first');
    assert.deepEqual(
      { kills: first.kills, deaths: first.deaths, shots: first.shots, hits: first.hits,
        accuracy: first.accuracy, damage: first.damage, teamkills: first.teamkills, captures: first.captures },
      { kills: 2, deaths: 0, shots: 2, hits: 2, accuracy: 100, damage: 200, teamkills: 0, captures: 1 },
    );
    assert.deepEqual(
      { kills: second.kills, deaths: second.deaths, shots: second.shots, hits: second.hits,
        accuracy: second.accuracy, damage: second.damage, teamkills: second.teamkills, captures: second.captures },
      { kills: 0, deaths: 2, shots: 0, hits: 0, accuracy: null, damage: 0, teamkills: 0, captures: 0 },
    );
    console.log('ok - match ends 3-0 with a correct per-player stats board');

    for (const c of [e1, f1]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 8: ghost + session takeover
    // Part A — same tab session: s1 joins, freezes, and s2 (same session
    // id, as if the same tab reconnected) joins IMMEDIATELY — the
    // takeover fires at once, with no silence wait.
    const s1 = new Client('S1');
    const s2 = new Client('S1b');
    for (const c of [s1, s2]) await c.ready();
    s1.send({ t: 'join', name: 'Ses', team: 'A', session: 'sess-1' });
    await s1.waitFor('joined');
    s1.stopPing(); // frozen tab — but the takeover must not wait for silence
    s2.send({ t: 'join', name: 'Ses', team: 'A', session: 'sess-1' });
    await s2.waitFor('joined');
    const st8a = await s2.waitFor('state', (m) =>
      m.players.filter((p) => p.name === 'Ses').length === 1 &&
      m.players.some((p) => p.name === 'Ses' && p.id === s2.id));
    assert.equal(st8a.players.length, 1, 'room holds exactly Ses(new)');
    console.log('ok - same-session rejoin takes over immediately (no silence wait)');
    await waitFor(() => s1.ws.readyState === WebSocket.CLOSED, 5000, 'session ghost socket terminated');
    for (const c of [s1, s2]) c.close();
    await sleep(300); // room empties and resets to a fresh lobby

    // Part B — ghost takeover (no session id: a different tab, or an old
    // client): the rejoin takes over only after the silence threshold.
    const t1 = new Client('Ghost');
    const u1 = new Client('H1');
    for (const c of [t1, u1]) await c.ready();
    t1.send({ t: 'join', name: 'Ghost', team: 'A' });
    u1.send({ t: 'join', name: 'H1', team: 'B' });
    await t1.waitFor('state', (m) => m.players.length === 2);
    // T1 freezes: stops pinging, socket stays open (backgrounded tab).
    t1.stopPing();
    await sleep(1800); // past the 1500 ms ghost silence, before the 3 s sweep
    const t2 = new Client('Ghost');
    await t2.ready();
    t2.send({ t: 'join', name: 'Ghost', team: 'A' });
    await t2.waitFor('joined');
    const st8 = await u1.waitFor('state', (m) =>
      m.players.filter((p) => p.name === 'Ghost').length === 1 &&
      m.players.some((p) => p.name === 'Ghost' && p.id === t2.id));
    assert.equal(st8.players.length, 2, 'room holds exactly Ghost(new) + H1');
    console.log('ok - lobby rejoin takes over the silent ghost (no duplication)');
    // The ghost's socket is terminated: the frozen client notices.
    await waitFor(() => t1.ws.readyState === WebSocket.CLOSED, 5000, 'ghost socket terminated');
    console.log('ok - ghost socket terminated on takeover');

    // Mid-match: same takeover, and an ACTIVE same-name player is protected.
    // A second attacker keeps the round alive when the ghost is removed
    // (otherwise the takeover itself would end the round by elimination).
    const t5 = new Client('A2');
    await t5.ready();
    t5.send({ t: 'join', name: 'A2', team: 'A' });
    await t5.waitFor('joined');
    await u1.waitFor('state', (m) => m.players.length === 3);
    t2.send({ t: 'start' });
    await t2.waitFor('roundStart', (m) => m.round === 1);
    await t2.waitFor('state', (m) => m.phase === 'playing');
    const t3 = new Client('Ghost');
    await t3.ready();
    t3.send({ t: 'join', name: 'Ghost', team: 'A' });
    const rej = await t3.waitFor('error', (m) => /in progress/.test(m.message));
    assert.ok(rej);
    console.log('ok - same-name join rejected while the original is active');
    // T2 freezes mid-match; the rejoin takes over the ghost and spectates.
    t2.stopPing();
    await sleep(1800);
    const t4 = new Client('Ghost');
    await t4.ready();
    t4.send({ t: 'join', name: 'Ghost', team: 'A' });
    await t4.waitFor('joined');
    const st8b = await u1.waitFor('state', (m) =>
      m.players.filter((p) => p.name === 'Ghost').length === 1 &&
      m.players.some((p) => p.name === 'Ghost' && p.id === t4.id && p.alive === false));
    assert.ok(st8b);
    console.log('ok - mid-match rejoin takes over the ghost and spectates until the next round');

    for (const c of [t1, t2, t3, t4, t5, u1]) c.close();
    await sleep(300);

    // Scenario 9 — stance flags (crouch / aiming) relay through snapshots.
    // The inbox is cleared before each step so waitFor can only match a
    // snapshot sent AFTER the move (find() returns the first match).
    const v1 = new Client('Poser');
    const v2 = new Client('Watcher');
    for (const c of [v1, v2]) await c.ready();
    v1.send({ t: 'join', name: 'Poser', team: 'A' });
    v2.send({ t: 'join', name: 'Watcher', team: 'B' });
    await v1.waitFor('state', (m) => m.players.length === 2);
    const snap0 = await v2.waitFor('snapshot', (m) =>
      m.players.some((p) => p.id === v1.id && p.crouch === false && p.aiming === false));
    assert.ok(snap0);
    v2.inbox.length = 0;
    v1.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: true, aiming: true });
    const snap1 = await v2.waitFor('snapshot', (m) =>
      m.players.some((p) => p.id === v1.id && p.crouch === true && p.aiming === true));
    assert.ok(snap1);
    console.log('ok - crouch/aiming flags relay in snapshots');
    v2.inbox.length = 0;
    v1.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: false, aiming: false });
    const snap2 = await v2.waitFor('snapshot', (m) =>
      m.players.some((p) => p.id === v1.id && p.crouch === false && p.aiming === false));
    assert.ok(snap2);
    console.log('ok - clearing the flags clears the relay');
    // Non-boolean junk is ignored, not stored.
    v2.inbox.length = 0;
    v1.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 'yes' });
    await sleep(300);
    const last = v2.findLast('snapshot', (m) => m.players.some((p) => p.id === v1.id));
    assert.ok(last, 'a snapshot arrived after the junk move');
    assert.equal(last.players.find((p) => p.id === v1.id).crouch, false);
    console.log('ok - non-boolean stance values are ignored');
    for (const c of [v1, v2]) c.close();
    await sleep(300);

    // Scenario 10 — solo NPCs. w1 (team A, lobby) observes the
    // snapshots; n1 is the solo player the NPCs shoot at.
    const w1 = new Client('Observer');
    await w1.ready();
    w1.send({ t: 'join', name: 'Observer', team: 'A' });
    await w1.waitFor('state', (m) => m.players.length === 1);
    await sleep(500);
    const noNpcYet = w1.findLast('snapshot');
    assert.ok(noNpcYet && !noNpcYet.players.some((p) => p.npc === true),
      'no NPCs before any solo player is present');
    console.log('ok - no NPCs while nobody plays solo');
    const n1 = new Client('NpcSolo');
    await n1.ready();
    n1.send({ t: 'solo', name: 'NpcSolo' });
    await n1.waitFor('soloJoined');
    const npcSnap = await w1.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true).length === 10);
    const npcs = npcSnap.players.filter((p) => p.npc === true);
    // Ids -1..-10, names NPC 1..NPC 10, team B, all alive at full health.
    assert.deepEqual(npcs.map((p) => p.id).sort((a, b) => a - b),
      [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1]);
    assert.deepEqual(npcs.map((p) => p.name).sort(),
      ['NPC 1', 'NPC 10', 'NPC 2', 'NPC 3', 'NPC 4', 'NPC 5', 'NPC 6', 'NPC 7', 'NPC 8', 'NPC 9']);
    assert.ok(npcs.every((p) => p.team === 'B' && p.alive === true && p.health === 100));
    assert.ok(npcs.every((p) => typeof p.aiming === 'boolean'));
    // (No aiming=false assertion here: the solo spawn sits within 30 m
    // of the nearest NPCs, so some of them are already engaging.)
    // Window spots: just inside a street wall, at a window centre,
    // ground floor (y=0) or second floor (y=3); spread over both sides
    // of the street and both floors.
    const windowZ = [-35.5, -28.5, -19.5, -12.5, -3.5, 3.5, 12.5, 19.5, 28.5, 35.5];
    assert.ok(npcs.every((p) => Math.abs(Math.abs(p.x) - 6.8) < 0.01 && (p.y === 0 || p.y === 3) && windowZ.includes(p.z)),
      `NPC positions must be window spots, got ${JSON.stringify(npcs.map((p) => [p.x, p.y, p.z]))}`);
    assert.ok(npcs.filter((p) => p.x < 0).length >= 3 && npcs.filter((p) => p.x > 0).length >= 3,
      'NPCs must span both sides of the street');
    assert.ok(npcs.filter((p) => p.y === 0).length >= 3 && npcs.filter((p) => p.y === 3).length >= 3,
      'NPCs must span both floors');
    console.log('ok - 10 NPCs appear in snapshots once a solo player is present (window spots, both sides/floors)');
    const st = w1.findLast('state');
    assert.ok(st && !st.players.some((p) => p.id < 0), 'NPCs must not appear in state');
    console.log('ok - NPCs never appear in state');
    // Walk next to one NPC (street centre, same z): it opens fire.
    const target = npcs[0];
    n1.send({ t: 'move', x: 0, y: 0, z: target.z, yaw: 0, pitch: 0 });
    const npcShot = await n1.waitFor('shot', (m) => m.shooterId === target.id, 5000);
    assert.equal(npcShot.hit, false);
    assert.equal(npcShot.killed, false);
    assert.equal(npcShot.targetId, null);
    console.log('ok - NPC opens fire within range (shots never hit)');
    await sleep(2000);
    const burstCount = n1.inbox.filter((m) => m.t === 'shot' && m.shooterId === target.id).length;
    assert.ok(burstCount >= 3, `expected a full burst, got ${burstCount} NPC shots`);
    const aimSnap = w1.findLast('snapshot', (m) => m.players.some((p) => p.npc === true));
    assert.equal(aimSnap.players.find((p) => p.id === target.id).aiming, true);
    console.log('ok - NPC fires bursts and shows the aim pose while engaging');
    // Walk away from THAT npc: 35 m along the street puts the player
    // out of its 30 m range (other NPCs nearby may keep firing — only
    // this one's shots are counted).
    const far = npcs.find((p) => Math.abs(p.z) >= 28.5);
    n1.send({ t: 'move', x: 0, y: 0, z: far.z, yaw: 0, pitch: 0 });
    await n1.waitFor('shot', (m) => m.shooterId === far.id, 5000);
    const farShotsBefore = n1.inbox.filter((m) => m.t === 'shot' && m.shooterId === far.id).length;
    const awayZ = far.z >= 0 ? far.z - 35 : far.z + 35;
    n1.send({ t: 'move', x: 0, y: 0, z: awayZ, yaw: 0, pitch: 0 });
    await sleep(2500);
    const farShotsAfter = n1.inbox.filter((m) => m.t === 'shot' && m.shooterId === far.id).length;
    assert.equal(farShotsAfter, farShotsBefore, 'NPC must stop firing out of range');
    console.log('ok - NPC holds fire again once the solo player leaves its range');
    // Leave solo: the NPCs vanish from snapshots (the observer stays
    // joined, so snapshots keep flowing).
    n1.send({ t: 'leaveSolo' });
    await n1.waitFor('soloLeft');
    const goneSnap = await w1.waitFor('snapshot', (m) =>
      !m.players.some((p) => p.npc === true), 5000);
    assert.ok(goneSnap);
    console.log('ok - NPCs vanish from snapshots when the last solo player leaves');
    for (const c of [n1, w1]) c.close();
    await sleep(300);

    // Scenario 11 — solo same-name takeover. Two tabs, same callsign:
    // the second solo join kick-takeovers the first (an active record —
    // not a ghost, not the same session), and the kicked tab's socket
    // closes so it can't rejoin and ping-pong.
    const y1 = new Client('Sam-tab1');
    await y1.ready();
    y1.send({ t: 'solo', name: 'Sam', session: 'solo-tab-1' });
    await y1.waitFor('soloJoined');
    const y2 = new Client('Sam-tab2');
    await y2.ready();
    y2.send({ t: 'solo', name: 'Sam', session: 'solo-tab-2' });
    await y2.waitFor('soloJoined');
    const kick = await y1.waitFor('kicked', (m) => /another tab/.test(m.reason || ''), 5000);
    assert.ok(kick, 'first tab should be kicked with the another-tab reason');
    console.log('ok - second same-name solo join kicks the first tab');
    await waitFor(() => y1.ws.readyState === WebSocket.CLOSED, 5000, 'kicked solo socket closed');
    console.log('ok - kicked solo socket closes (no rejoin ping-pong)');
    const oneSam = await y2.waitFor('state', (m) =>
      m.players.filter((p) => p.solo && p.name === 'Sam').length === 1 &&
      m.players.some((p) => p.id === y2.id), 5000);
    assert.equal(oneSam.players.find((p) => p.solo && p.name === 'Sam').id, y2.id);
    console.log('ok - exactly one Sam remains, the second tab');
    // A different callsign is untouched: two solo players coexist.
    const y3 = new Client('Alex');
    await y3.ready();
    y3.send({ t: 'solo', name: 'Alex', session: 'solo-tab-3' });
    await y3.waitFor('soloJoined');
    const both = await y2.waitFor('state', (m) =>
      m.players.filter((p) => p.solo).length === 2, 5000);
    assert.ok(both.players.some((p) => p.solo && p.name === 'Alex'));
    assert.ok(both.players.some((p) => p.solo && p.name === 'Sam'));
    console.log('ok - different-name solo players coexist');
    for (const c of [y1, y2, y3]) c.close();
    await sleep(300);

    // Scenario 12 — solo players can shoot the NPCs down: distance
    // damage (1 hit <= 15 m, 2 hits 15-50 m, 3 hits > 50 m). A downed
    // NPC stays down — no revive — stops firing, and shots at it do
    // not hit. Solo shots at players still never hit.
    const shooter = new Client('NpcShooter');
    await shooter.ready();
    shooter.send({ t: 'solo', name: 'NpcShooter' });
    await shooter.waitFor('soloJoined');
    const bystander = new Client('NpcBystander');
    await bystander.ready();
    bystander.send({ t: 'solo', name: 'NpcBystander' });
    await bystander.waitFor('soloJoined');
    // Read the NPC set from a snapshot (the observer closed; the
    // shooter sees the same snapshots).
    const setSnap = await shooter.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true).length === 10);
    const set = setSnap.players.filter((p) => p.npc === true);
    const dist3d = (npc, x, z) =>
      Math.sqrt((npc.x - x) ** 2 + npc.y ** 2 + (npc.z - z) ** 2);
    // A solo shot at another player still never hits.
    shooter.send({ t: 'move', x: 0, y: 0, z: 30, yaw: 0, pitch: 0 });
    await sleep(300);
    shooter.inbox.length = 0;
    shooter.send({ t: 'shot', targetId: bystander.id });
    const noHit = await shooter.waitFor('shot', (m) => m.shooterId === shooter.id, 5000);
    assert.equal(noHit.hit, false);
    assert.equal(noHit.targetId, null);
    console.log('ok - solo shot at a player still never hits');
    // Close range: stand on the street at the NPC's window (3D distance
    // ~7 m) — one hit kills (<= 15 m, 100 damage).
    const close = set[0];
    shooter.send({ t: 'move', x: 0, y: 0, z: close.z, yaw: 0, pitch: 0 });
    await sleep(300);
    assert.ok(dist3d(close, 0, close.z) <= 15, 'close-range setup must be within 15 m');
    shooter.inbox.length = 0;
    shooter.send({ t: 'shot', targetId: close.id });
    const down = await shooter.waitFor('shot', (m) => m.shooterId === shooter.id && m.targetId === close.id, 5000);
    assert.equal(down.hit, true);
    assert.equal(down.killed, true);
    assert.equal(down.damage, 100);
    assert.equal(down.targetHealth, 0);
    assert.equal(down.friendlyFire, false);
    console.log('ok - one close-range solo hit puts the NPC down (100 damage)');
    const downSnap = await shooter.waitFor('snapshot', (m) =>
      m.players.some((p) => p.npc === true && p.id === close.id && p.alive === false && p.health === 0), 5000);
    assert.equal(downSnap.players.find((p) => p.id === close.id).aiming, false);
    console.log('ok - downed NPC shows alive=false, health=0, not aiming');
    // While down, further shots do not hit it.
    await sleep(150);
    shooter.inbox.length = 0;
    shooter.send({ t: 'shot', targetId: close.id });
    const downShot = await shooter.waitFor('shot', (m) => m.shooterId === shooter.id, 5000);
    assert.equal(downShot.hit, false);
    console.log('ok - shots at the downed NPC do not hit');
    // No revive: well past the old down time it is still down, and it
    // has not fired since going down.
    const closeShotsBefore = shooter.inbox.filter((m) => m.t === 'shot' && m.shooterId === close.id).length;
    await sleep(2500);
    const stillDown = shooter.findLast('snapshot', (m) =>
      m.players.some((p) => p.id === close.id));
    assert.ok(stillDown && stillDown.players.find((p) => p.id === close.id).alive === false
      && stillDown.players.find((p) => p.id === close.id).health === 0,
      'downed NPC must stay down (no revive)');
    assert.equal(shooter.inbox.filter((m) => m.t === 'shot' && m.shooterId === close.id).length,
      closeShotsBefore, 'downed NPC must not fire');
    console.log('ok - downed NPC stays down after 2.5 s+ and never fires again');
    // Medium range (15-50 m): 20 m along the street — 50 damage, 2 hits.
    const medium = set.find((p) => p.id !== close.id);
    const medZ = medium.z + 20 <= 60 ? medium.z + 20 : medium.z - 20;
    shooter.send({ t: 'move', x: 0, y: 0, z: medZ, yaw: 0, pitch: 0 });
    await sleep(300);
    const medDist = dist3d(medium, 0, medZ);
    assert.ok(medDist > 15 && medDist <= 50, `medium setup must be 15-50 m, got ${medDist.toFixed(1)}`);
    shooter.inbox.length = 0;
    shooter.send({ t: 'shot', targetId: medium.id });
    const med1 = await shooter.waitFor('shot', (m) => m.shooterId === shooter.id && m.targetId === medium.id, 5000);
    assert.equal(med1.hit, true);
    assert.equal(med1.killed, false);
    assert.equal(med1.damage, 50);
    assert.equal(med1.targetHealth, 50);
    await sleep(150);
    shooter.inbox.length = 0;
    shooter.send({ t: 'shot', targetId: medium.id });
    const med2 = await shooter.waitFor('shot', (m) => m.shooterId === shooter.id && m.targetId === medium.id, 5000);
    assert.equal(med2.killed, true);
    assert.equal(med2.targetHealth, 0);
    console.log('ok - medium range takes 2 hits (50 damage each)');
    // Long range (> 50 m): 55 m along the street — 34 damage, 3 hits.
    const farNpc = set.find((p) => p.id !== close.id && p.id !== medium.id && p.z >= 0);
    const farZ = farNpc.z - 55;
    shooter.send({ t: 'move', x: 0, y: 0, z: farZ, yaw: 0, pitch: 0 });
    await sleep(300);
    const farDist = dist3d(farNpc, 0, farZ);
    assert.ok(farDist > 50, `long setup must be > 50 m, got ${farDist.toFixed(1)}`);
    const farHealth = [];
    for (let i = 0; i < 3; i++) {
      shooter.inbox.length = 0;
      shooter.send({ t: 'shot', targetId: farNpc.id });
      const s = await shooter.waitFor('shot', (m) => m.shooterId === shooter.id && m.targetId === farNpc.id, 5000);
      assert.equal(s.hit, true);
      assert.equal(s.damage, 34);
      farHealth.push(s.targetHealth);
      assert.equal(s.killed, i === 2);
      await sleep(150);
    }
    assert.deepEqual(farHealth, [66, 32, 0]);
    console.log('ok - long range takes 3 hits (34 damage each)');
    for (const c of [shooter, bystander]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 13: deliberate team leave
    // A 1v1 match; one player leaves mid-match (EXIT button). The
    // leaver gets 'left', the other team wins the round by elimination,
    // and the leaver may rejoin within the grace window. A solo player
    // sending 'leave' is ignored.
    const l1 = new Client('Leaver');
    const l2 = new Client('Stayer');
    for (const c of [l1, l2]) await c.ready();
    l1.send({ t: 'join', name: 'Leaver', team: 'A' });
    l2.send({ t: 'join', name: 'Stayer', team: 'B' });
    await l1.waitFor('state', (m) => m.players.length === 2);
    l1.send({ t: 'start' });
    await l1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - 1v1 match started for the leave test');
    const ls = new Client('LeaveSolo');
    await ls.ready();
    ls.send({ t: 'solo', name: 'LeaveSolo' });
    await ls.waitFor('soloJoined');
    ls.inbox.length = 0;
    ls.send({ t: 'leave' });
    await sleep(300);
    assert.equal(ls.inbox.filter((m) => m.t === 'left').length, 0, 'solo leave must be ignored');
    const stillThere = l1.findLast('state');
    assert.ok(stillThere && stillThere.players.some((p) => p.solo && p.name === 'LeaveSolo'));
    console.log('ok - leave from a solo player is ignored');
    l1.send({ t: 'leave' });
    const left = await l1.waitFor('left', () => true, 5000);
    assert.ok(left);
    console.log('ok - leaver gets the left reply');
    const leaveRoundEnd = await l2.waitFor('roundEnd', (m) => m.winner === 'B' && m.reason === 'elimination', 5000);
    assert.ok(leaveRoundEnd);
    console.log('ok - round ends by elimination, the other team wins');
    await waitFor(() => {
      const last = l2.findLast('state');
      return last && last.players.length === 2 && !last.players.some((p) => p.name === 'Leaver') ? last : null;
    }, 5000, 'leaver removed from the state');
    console.log('ok - leaver removed from the state (solo observer stays)');
    const l1b = new Client('Leaver-again');
    await l1b.ready();
    l1b.send({ t: 'join', name: 'Leaver', team: 'A' });
    await waitFor(() => {
      const last = l2.findLast('state');
      return last && last.players.some((p) => p.name === 'Leaver' && p.team === 'A') ? last : null;
    }, 5000, 'leaver rejoined within the grace window');
    console.log('ok - leaver rejoins within the grace window');
    for (const c of [l1, l2, ls, l1b]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 14: NPC fire
    // never damages the solo player, and leaving solo + rejoining
    // re-draws the NPC set (all 10 alive again at full health).
    // ro observes snapshots throughout: a client that left solo stops
    // receiving them (broadcasts go to players only).
    const ro = new Client('ResetObserver');
    await ro.ready();
    ro.send({ t: 'join', name: 'ResetObserver', team: 'A' });
    await ro.waitFor('state', (m) => m.players.length === 1);
    const rs1 = new Client('ResetSolo');
    await rs1.ready();
    rs1.send({ t: 'solo', name: 'ResetSolo' });
    await rs1.waitFor('soloJoined');
    const rSnap = await rs1.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true).length === 10);
    const rNpcs = rSnap.players.filter((p) => p.npc === true);
    // Stand next to one NPC for a few seconds: it fires bursts at the
    // player, but none of them hit and the player's health stays 100.
    const rTarget = rNpcs[0];
    rs1.send({ t: 'move', x: 0, y: 0, z: rTarget.z, yaw: 0, pitch: 0 });
    await rs1.waitFor('shot', (m) => m.shooterId === rTarget.id, 5000);
    await sleep(2500);
    const npcShots = rs1.inbox.filter((m) => m.t === 'shot' && m.shooterId < 0);
    assert.ok(npcShots.length >= 3, `expected NPC bursts, got ${npcShots.length} shots`);
    assert.ok(npcShots.every((s) => s.hit === false && s.killed === false && s.targetId === null),
      'NPC shots must never hit');
    const rHealth = rs1.findLast('snapshot', (m) => m.players.some((p) => p.id === rs1.id));
    assert.equal(rHealth.players.find((p) => p.id === rs1.id).health, 100);
    console.log('ok - NPC bursts never damage the solo player (health stays 100)');
    // Shoot one NPC down, then leave solo.
    rs1.inbox.length = 0;
    rs1.send({ t: 'shot', targetId: rTarget.id });
    const rDown = await rs1.waitFor('shot', (m) => m.shooterId === rs1.id && m.targetId === rTarget.id, 5000);
    assert.equal(rDown.killed, true);
    rs1.send({ t: 'leaveSolo' });
    await rs1.waitFor('soloLeft');
    const rGone = await ro.waitFor('snapshot', (m) =>
      !m.players.some((p) => p.npc === true), 5000);
    assert.ok(rGone);
    console.log('ok - NPC shot down, then the set vanishes on leaving solo');
    // Rejoin solo: a fresh set — all 10 alive at full health, including
    // the one shot down before leaving.
    rs1.send({ t: 'solo', name: 'ResetSolo' });
    await rs1.waitFor('soloJoined');
    const rSnap2 = await rs1.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true && p.alive === true && p.health === 100).length === 10);
    assert.ok(rSnap2);
    assert.equal(rSnap2.players.find((p) => p.id === rTarget.id).alive, true);
    assert.equal(rSnap2.players.find((p) => p.id === rTarget.id).health, 100);
    console.log('ok - rejoining solo re-draws the set: all 10 NPCs alive at full health');
    for (const c of [rs1, ro]) c.close();
    await sleep(300);

    console.log('HEADLESS TEST PASSED');
  } catch (err) {
    console.error('HEADLESS TEST FAILED:', err.message);
    console.error('--- server output ---');
    console.error(serverOutput);
    stopServer();
    process.exit(1);
  }
  stopServer();
  process.exit(0);
}

main();

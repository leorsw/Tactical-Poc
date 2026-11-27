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
//     15-50 m, 3 hits > 50 m); a downed NPC lies still for 2 s and stops
//     firing, then is replaced at a free window spot (Lior, 26/11/2026);
//     shots at it while down do not hit.
//   Scenario 13 (deliberate team leave): a 1v1 match, one player sends
//     'leave' mid-match — the leaver gets 'left', the other team wins
//     the round by elimination, the leaver is gone from the state, and
//     they may rejoin within the grace window (same callsign + team).
//     A solo player sending 'leave' is ignored (solo uses leaveSolo).
//   Scenario 14 (solo NPC reset + harmless fire): NPC shots never
//     damage the solo player (health stays 100 through bursts); leaving
//     solo and rejoining re-draws the set — all 10 NPCs alive again at
//     full health, including one shot down before leaving.
//   Scenario 15 (NPC line of sight): an NPC only opens fire when it can
//     see the solo player (within 30 m AND a clear ray through a window
//     or doorway). Behind a house the NPCs hold fire, stop aiming and
//     face the street again; a burst that started before the player
//     ducked behind cover runs to completion, and fire resumes once
//     line of sight returns.
//   Scenario 16 (solo NPC hits): every 3rd NPC burst lands one hit
//     (its middle shot) — an 'npcHit' event to the target only, and
//     the player's health stays 100, alive stays true.
//   Scenario 17 (defense prep time): at the start of a round the
//     attackers wait at spawn (moves ignored, no shooting) while the
//     defenders move freely; after prep ends the attackers move again.
//     PREP_MS=5000 in this test (20 s in the game).
//   Scenario 18 (classes): marksman — ADS kills at any range and fires
//     1 shot/sec while aiming; from the hip he fires at the rifleman's
//     rate (Lior, 26/11/2026) and hip fire is the normal table; gunner —
//     standing, hits only within 15 m (34, 3 hits to kill); crouched,
//     the normal table (50 at 15-50 m); reload 5 s. setClass: the host
//     assigns any team player (ammo resets to the new loadout); a
//     non-host team player may not change their own class; a solo join
//     carries the chosen class and its loadout.
//   Scenario 19 (grenades): 2 per round; the throw flies a 10 m arc;
//     a wall stops the arc (lands before the wall, shorter flight);
//     the blast kills within 4 m with line of sight, and a wall between
//     the blast and the target blocks it; the count drops per throw and
//     a third throw with none left is ignored; the live grenade rides
//     the snapshot.
//   Scenario 20 (grenades, continued): the arc passes through a window
//     and kills inside the house; a throw at a nearby wall kills the
//     thrower himself (friendly fire); the solo grenade toggle (off =
//     0 grenades, on = 2); grenades reset to 2 on the next round.
//   Scenario 21 (admin): with no admin in the room the lobby works as
//     before (anyone starts, the host assigns classes); once someone
//     enters the code, only the admin starts / continues, renames, moves
//     teams, assigns classes, and toggles grenades; a wrong code and a
//     non-admin attempt are rejected; setTeam is lobby-only.
//   Scenario 22 (wall impacts): a shot carrying an impact point has it
//     echoed in the broadcast (rounded to 1 decimal); a shot without
//     one broadcasts impact null; a malformed impact is dropped, not
//     echoed.
//   Scenario 23 (admin spectator): only the admin may spectate; the
//     spectator leaves the player list (no figure for anyone), keeps the
//     admin flag (state.adminSpectating), can start the match from above
//     while a non-admin start stays rejected, receives snapshots, cannot
//     shoot, and returns to the lobby on leaveSpectate.
//   Scenario 24 (expiring invite links): only the admin creates one
//     (random 8-char code, expires ~INVITE_TTL_MS out); checkInvite says
//     valid for a live code and invalid for a bogus one; after the TTL
//     passes the same code reports invalid.
//   Scenario 25 (round duration): the admin sets the round length in
//     minutes from the lobby (state.roundDurationMin); a non-admin set
//     is ignored; the next round runs the new clock (2 min here, the
//     test env runs ROUND_MS=60000).
//   Scenario 26 (solo NPC respawn): a downed NPC is replaced after
//     2 s at a free window spot (Lior, 26/11/2026) — same id, full
//     health, different spot, still 10 NPCs — and the replacement can
//     itself be shot down again.
//
// Run: node test/headless-test.mjs  (or: npm test)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { SPAWNS } from '../public/map.js';
import * as mapMod from '../public/map.js'; // getLayout presence check for the dual-map scenarios

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8021;
const URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Defense prep time is a toggle, off by default (26/11/2026): scenarios
// that play right after a start must wait it out first — but only when it
// is enabled. The inbox is cleared before each wait so a stale lobby
// snapshot (which also carries prepActive === false) cannot satisfy the
// wait early.
async function waitPrepEnd(c) {
  const st = c.findLast('state', () => true);
  if (st && st.prepEnabled === false) return; // prep off: nothing to wait out
  c.inbox.length = 0;
  await c.waitFor('snapshot', (m) => m.prepActive === true, 10000);
  c.inbox.length = 0;
  await c.waitFor('snapshot', (m) => m.prepActive === false, 10000);
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

  // Admin (Lior, 25/11/2026): enter the code and wait for adminOk.
  // Only the admin can start / continue / rematch, rename, set teams,
  // assign classes, or toggle grenades.
  async becomeAdmin(code = 'test-code') {
    this.send({ t: 'admin', code });
    await this.waitFor('adminOk', () => true, 5000);
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
    env: { ...process.env, PORT: String(PORT), ROUND_MS: '60000', CAPTURE_MS: '600', PREP_MS: '5000', HEARTBEAT_TIMEOUT_MS: '3000', HEARTBEAT_SWEEP_MS: '1000', GHOST_SILENCE_MS: '1500', ADMIN_CODE: 'test-code', INVITE_TTL_MS: '1500' },
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
    await a1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    a1.send({ t: 'start' });
    const r1 = await a1.waitFor('roundStart', (m) => m.round === 1);
    await a1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - match started, round 1 playing, A attacks');
    await waitPrepEnd(a1); // prep: attackers wait, no shooting yet
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
    await waitPrepEnd(a1); // prep runs at the start of every round
    assert.ok(r2.objective && Math.abs(r2.objective.x) === 11 && r2.objective.z === 45,
      `round 2 objective must be a defenders spawn centre, got ${JSON.stringify(r2.objective)}`);
    a2.send({ t: 'move', x: r2.objective.x, y: 0, z: r2.objective.z, yaw: 0, pitch: 0 });
    const round2End = await a1.waitFor('roundEnd', (m) => m.winner === 'A' && m.reason === 'objective');
    assert.equal(round2End.score.A, 2);
    console.log('ok - round 2 ends: attackers win by reaching the objective, score 2-0');

    a1.send({ t: 'continue' });
    await a1.waitFor('roundStart', (m) => m.round === 3);
    console.log('ok - round 3 started after CONTINUE');
    await waitPrepEnd(a1); // prep runs at the start of every round

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
    await c1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
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
    await d1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    d1.send({ t: 'start' }); // D1 is not the host — the admin (not the host) starts
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
    await j1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    j1.send({ t: 'start' });
    await j1.waitFor('roundStart', (m) => m.round === 1);
    console.log('ok - match starts with a solo player in the room (solo is never host)');
    await waitPrepEnd(j1); // prep: no shooting yet
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
    await m1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
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
    await g1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
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
    await e1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    e1.send({ t: 'start' });
    const q1 = await e1.waitFor('roundStart', (m) => m.round === 1);
    await e1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - 1v1 match started for the capture/stats test');
    await waitPrepEnd(e1); // prep: attackers wait, no shooting yet

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
    await waitPrepEnd(e1); // prep runs at the start of every round
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
    await waitPrepEnd(e1); // prep runs at the start of every round
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
    await t2.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
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
    // NPC lies still for 2 s and stops firing, then is replaced at a
    // free window spot (Lior, 26/11/2026); shots at it while down do
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
    const killAt = Date.now(); // the kill event just arrived; the server stamped downAt a few ms earlier
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
    // Respawn (Lior, 26/11/2026): the downed NPC lies still for 2 s —
    // still down and silent at ~1.2 s — then vanishes and a fresh NPC
    // appears at a free window spot: same id, full health, a different
    // spot, still 10 NPCs in total.
    const closeShotsBefore = shooter.inbox.filter((m) => m.t === 'shot' && m.shooterId === close.id).length;
    await sleep(900);
    const stillDown = shooter.findLast('snapshot', (m) =>
      m.players.some((p) => p.id === close.id));
    assert.ok(stillDown && stillDown.players.find((p) => p.id === close.id).alive === false
      && stillDown.players.find((p) => p.id === close.id).health === 0,
      'downed NPC must still be down before the 2 s respawn');
    assert.equal(shooter.inbox.filter((m) => m.t === 'shot' && m.shooterId === close.id).length,
      closeShotsBefore, 'downed NPC must not fire while down');
    console.log('ok - downed NPC still down and silent at ~1.2 s');
    shooter.inbox.length = 0;
    const respawnSnap = await shooter.waitFor('snapshot', (m) => {
      const n = m.players.find((p) => p.npc === true && p.id === close.id);
      return n && n.alive === true && n.health === 100
        && (n.x !== close.x || n.y !== close.y || n.z !== close.z);
    }, 5000);
    const respawned = respawnSnap.players.find((p) => p.id === close.id);
    const respawnMs = Date.now() - killAt;
    assert.ok(respawnMs >= 1700 && respawnMs <= 5000,
      `respawn must land ~2 s after the kill, took ${respawnMs} ms`);
    const respawnSet = respawnSnap.players.filter((p) => p.npc === true);
    assert.equal(respawnSet.length, 10, 'still 10 NPCs after the respawn');
    assert.ok(!respawnSet.some((p) => p.id !== close.id
      && p.x === respawned.x && p.y === respawned.y && p.z === respawned.z),
      'no other NPC shares the respawn spot');
    assert.ok(Math.abs(Math.abs(respawned.x) - 6.8) < 0.01 && (respawned.y === 0 || respawned.y === 3),
      `respawn spot must be a window spot, got ${respawned.x},${respawned.y},${respawned.z}`);
    console.log(`ok - NPC respawns after ~2 s at a new free window spot (${respawnMs} ms)`);
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
    await l1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
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

    // ------------------------------------------------ scenario 15: NPC
    // line of sight — an NPC only opens fire when it can see the solo
    // player (within 30 m AND a clear ray through a window or doorway).
    // Behind a house the NPCs hold fire and face the street; a burst
    // that started before the player ducked behind cover runs to
    // completion.
    const lo = new Client('LosObserver');
    await lo.ready();
    lo.send({ t: 'join', name: 'LosObserver', team: 'A' });
    await lo.waitFor('state', (m) => m.players.length === 1);
    const ls1 = new Client('LosSolo');
    await ls1.ready();
    ls1.send({ t: 'solo', name: 'LosSolo' });
    await ls1.waitFor('soloJoined');
    const lSnap = await ls1.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true).length === 10);
    const lNpcs = lSnap.players.filter((p) => p.npc === true);
    // A ground-floor NPC (eye 1.6, same height as the player's torso
    // ray — the cleanest LoS case) and the street in front of its window.
    const lTarget = lNpcs.find((p) => p.y === 0);
    ls1.send({ t: 'move', x: 0, y: 0, z: lTarget.z, yaw: 0, pitch: 0 });
    await ls1.waitFor('shot', (m) => m.shooterId === lTarget.id, 5000);
    console.log('ok - NPC fires at a solo player it can see (street, clear LoS)');
    // Let the in-flight burst finish, then catch the NEXT burst's first
    // shot and duck behind the NPC's house in the same instant.
    await sleep(600);
    ls1.inbox.length = 0;
    await ls1.waitFor('shot', (m) => m.shooterId === lTarget.id, 5000);
    ls1.inbox.length = 0; // drop shot 1 of the burst; shots 2-3 must follow
    const behindX = lTarget.x < 0 ? -17 : 17;
    // Duck OFF the window line: the NPC sits at a window centre
    // (z = cz +/- 3.5) and the back wall has windows at exactly those
    // z values (item 10), so ducking at the same z keeps line of sight
    // straight through the back window. +1.75 m along the wall puts the
    // player in the solid band between the back windows (verified:
    // hasLineOfSight is false there), restoring the "behind cover"
    // premise of this test.
    ls1.send({ t: 'move', x: behindX, y: 0, z: lTarget.z + 1.75, yaw: 0, pitch: 0 });
    await sleep(2500);
    const midBurst = ls1.inbox.filter((m) => m.t === 'shot' && m.shooterId === lTarget.id).length;
    assert.equal(midBurst, 2, `burst must complete after LoS breaks, got ${midBurst} more shots`);
    console.log('ok - a started burst runs to completion after line of sight breaks');
    // Behind the house, no NPC anywhere can see the player: total
    // silence, no aiming, every NPC facing the street again.
    ls1.inbox.length = 0;
    await sleep(2500);
    const hiddenShots = ls1.inbox.filter((m) => m.t === 'shot' && m.shooterId < 0).length;
    assert.equal(hiddenShots, 0, `no NPC may fire without line of sight, got ${hiddenShots} shots`);
    const hiddenSnap = lo.findLast('snapshot', (m) => m.players.some((p) => p.npc === true));
    const hiddenNpcs = hiddenSnap.players.filter((p) => p.npc === true);
    assert.ok(hiddenNpcs.every((p) => p.aiming === false), 'no NPC aims without line of sight');
    assert.ok(hiddenNpcs.every((p) => Math.abs(p.yaw - (p.x < 0 ? -Math.PI / 2 : Math.PI / 2)) < 0.01),
      'every NPC faces the street again without line of sight');
    console.log('ok - behind a house: no NPC fire, no aiming, all face the street');
    // Step back onto the street: the NPC opens fire again.
    ls1.send({ t: 'move', x: 0, y: 0, z: lTarget.z, yaw: 0, pitch: 0 });
    await ls1.waitFor('shot', (m) => m.shooterId === lTarget.id, 5000);
    console.log('ok - NPC resumes fire once line of sight returns');
    for (const c of [ls1, lo]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 16: solo NPC
    // hits redden the screen without damage (Lior, 25/11/2026). Every 3rd
    // NPC burst lands one hit (its middle shot); the server sends an
    // 'npcHit' event to the target only. Health must stay 100, alive true.
    const hitSolo = new Client('NpcHitSolo');
    await hitSolo.ready();
    hitSolo.send({ t: 'solo', name: 'NpcHitSolo' });
    await hitSolo.waitFor('soloJoined');
    const hitSnap = await hitSolo.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true).length === 10);
    const hitSet = hitSnap.players.filter((p) => p.npc === true);
    const ground = hitSet.find((p) => p.y === 0);
    hitSolo.send({ t: 'move', x: 0, y: 0, z: ground.z, yaw: 0, pitch: 0 });
    await sleep(300);
    hitSolo.inbox.length = 0;
    const hit = await hitSolo.waitFor('npcHit', (m) => m.npcId === ground.id, 20000);
    assert.ok(hit, 'expected an npcHit from the ground-floor NPC');
    console.log('ok - NPC hit arrives (3rd burst, middle shot)');
    await sleep(300);
    const afterSnap = hitSolo.findLast('snapshot', (m) =>
      m.players.some((p) => p.id === hitSolo.id));
    const me = afterSnap.players.find((p) => p.id === hitSolo.id);
    assert.equal(me.health, 100, 'an NPC hit must not reduce health');
    assert.equal(me.alive, true, 'an NPC hit must not eliminate');
    console.log('ok - health stays 100, player stays alive after the NPC hit');
    hitSolo.close();
    await sleep(300);

    // ------------------------------------------------ scenario 17: defense
    // prep time (Lior, 25/11/2026; toggle, off by default, 26/11/2026).
    // At the start of a round the attackers wait at spawn (moves ignored,
    // no shooting) while the defenders move freely; after prep ends the
    // attackers move again. First the toggle itself: off by default, any
    // team player may enable it.
    const p1 = new Client('PrepAtk');
    const p2 = new Client('PrepDef');
    for (const c of [p1, p2]) await c.ready();
    p1.send({ t: 'join', name: 'PrepAtk', team: 'A' });
    p2.send({ t: 'join', name: 'PrepDef', team: 'B' });
    const prepSt0 = await p1.waitFor('state', (m) => m.players.length === 2);
    assert.equal(prepSt0.prepEnabled, false, 'prep time is off by default');
    console.log('ok - prep time is off by default');
    p2.send({ t: 'setPrepEnabled', enabled: true }); // a non-admin player enables it
    const prepSt1 = await p1.waitFor('state', (m) => m.prepEnabled === true, 5000);
    assert.equal(prepSt1.prepEnabled, true, 'any team player may enable prep time');
    console.log('ok - any team player may enable prep time');
    await p1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    p1.send({ t: 'start' });
    const playing = await p1.waitFor('state', (m) => m.phase === 'playing');
    const atkTeam = playing.attackersTeam;
    const atk = atkTeam === 'A' ? p1 : p2;
    const def = atkTeam === 'A' ? p2 : p1;
    const prepSnap = await atk.waitFor('snapshot', (m) => m.prepActive === true, 5000);
    assert.ok(prepSnap.prepMsLeft > 0 && prepSnap.prepMsLeft <= 5000,
      `prep countdown must run, got ${prepSnap.prepMsLeft}`);
    console.log('ok - snapshot shows prepActive with a countdown');
    const atkSpawn = prepSnap.players.find((p) => p.id === atk.id);
    atk.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    await sleep(400);
    const frozen = atk.findLast('snapshot', (m) => m.players.some((p) => p.id === atk.id));
    const atkNow = frozen.players.find((p) => p.id === atk.id);
    assert.deepEqual([atkNow.x, atkNow.z], [atkSpawn.x, atkSpawn.z],
      'attacker must not move during prep');
    console.log('ok - attacker frozen at spawn during prep');
    atk.inbox.length = 0;
    atk.send({ t: 'shot', targetId: def.id });
    await sleep(400);
    assert.equal(atk.inbox.filter((m) => m.t === 'shot' && m.shooterId === atk.id).length, 0,
      'no shooting during prep');
    console.log('ok - attacker shot during prep is ignored');
    const defSpawn = prepSnap.players.find((p) => p.id === def.id);
    def.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    await sleep(400);
    const defMoved = def.findLast('snapshot', (m) => m.players.some((p) => p.id === def.id));
    const defNow = defMoved.players.find((p) => p.id === def.id);
    assert.ok(Math.hypot(defNow.x - defSpawn.x, defNow.z - defSpawn.z) > 1,
      'defender must move freely during prep');
    console.log('ok - defender moves freely during prep');
    await atk.waitFor('snapshot', (m) => m.prepActive === false, 8000);
    atk.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    await sleep(400);
    const freed = atk.findLast('snapshot', (m) => m.players.some((p) => p.id === atk.id));
    const atkFree = freed.players.find((p) => p.id === atk.id);
    assert.ok(Math.hypot(atkFree.x - atkSpawn.x, atkFree.z - atkSpawn.z) > 1,
      'attacker must move after prep ends');
    console.log('ok - attacker moves again after prep ends');
    for (const c of [p1, p2]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 18: classes
    // (Lior, 25/11/2026). Marksman: ADS kills at any range, hip fire is
    // the normal table, 1 shot/sec. Gunner: standing, hits only within
    // 15 m (34, 3 hits to kill); crouched, the normal table. Reload 5 s.
    const cm = new Client('ClsMark');
    const cg = new Client('ClsGun');
    for (const c of [cm, cg]) await c.ready();
    cm.send({ t: 'join', name: 'ClsMark', team: 'A' });
    cg.send({ t: 'join', name: 'ClsGun', team: 'B' });
    const clsBoth = await cm.waitFor('state', (m) => m.players.length === 2);
    const st1 = clsBoth.players.find((p) => p.id === cm.id);
    const st2 = clsBoth.players.find((p) => p.id === cg.id);
    assert.equal(st1.cls, 'rifleman', 'team join defaults to rifleman');
    assert.equal(st2.cls, 'rifleman', 'team join defaults to rifleman');
    assert.equal(st1.inMag, 29, 'rifleman loads 29 in the mag');
    assert.equal(st1.mags, 5, 'rifleman loads 5 spare mags');
    console.log('ok - team joins default to rifleman, 29 in mag, 5 spares');
    // The admin (not the host) assigns classes — cm enters the code first.
    await cm.becomeAdmin();
    // Admin assigns the gunner class to the other player.
    cm.send({ t: 'setClass', playerId: cg.id, cls: 'gunner' });
    await cm.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === cg.id);
      return p && p.cls === 'gunner';
    });
    const gunState = cm.findLast('state', (m) => m.players.some((q) => q.id === cg.id && q.cls === 'gunner'));
    const gunP = gunState.players.find((q) => q.id === cg.id);
    assert.equal(gunP.inMag, 120, 'gunner loads 120 in the mag');
    assert.equal(gunP.mags, 2, 'gunner loads 2 spare mags');
    console.log('ok - admin setClass makes the gunner, ammo resets to 120 + 2');
    // A non-admin team player may not change their own class.
    cg.send({ t: 'setClass', cls: 'marksman' });
    await sleep(400);
    const stillGun = cm.findLast('state', (m) => m.players.some((q) => q.id === cg.id));
    assert.equal(stillGun.players.find((q) => q.id === cg.id).cls, 'gunner',
      'a non-admin self-setClass must be ignored');
    console.log('ok - non-admin self-setClass is ignored');
    // The admin changes their own class to marksman.
    cm.send({ t: 'setClass', playerId: cm.id, cls: 'marksman' });
    await cm.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === cm.id);
      return p && p.cls === 'marksman';
    });
    console.log('ok - host changes their own class to marksman');
    // Solo join carries the chosen class and its loadout.
    const cs = new Client('ClsSolo');
    await cs.ready();
    cs.send({ t: 'solo', name: 'ClsSolo', cls: 'gunner' });
    const sj = await cs.waitFor('soloJoined');
    assert.equal(sj.cls, 'gunner', 'soloJoined carries the chosen class');
    const clsSoloSnap = await cs.waitFor('snapshot', (m) => {
      const p = m.players.find((q) => q.id === cs.id);
      return p && p.inMag === 120;
    });
    const soloP = clsSoloSnap.players.find((q) => q.id === cs.id);
    assert.equal(soloP.mags, 2, 'solo gunner loads 2 spare mags');
    console.log('ok - solo join with cls gunner: soloJoined + 120 in mag, 2 spares');
    cs.send({ t: 'leaveSolo' });
    await cs.waitFor('soloLeft');
    cs.close();
    await sleep(300);
    // Start the match and play the class rules at controlled distances
    // (street centre, both at y 0 — distance is the z gap).
    await cm.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    cm.send({ t: 'start' });
    await waitPrepEnd(cm);
    const place = async (c, x, z, extra = {}) => {
      c.send({ t: 'move', x, y: 0, z, yaw: 0, pitch: 0, ...extra });
    };
    const shotBy = async (shooter, targetId) => {
      shooter.inbox.length = 0;
      shooter.send({ t: 'shot', targetId });
      return shooter.waitFor('shot', (m) => m.shooterId === shooter.id, 5000);
    };
    // Marksman hip fire at 56 m: normal table, 34 damage — and from
    // the hip he fires at the rifleman's rate, so two shots 200 ms
    // apart both land (Lior, 26/11/2026).
    await place(cm, 0, -28, { aiming: false });
    await place(cg, 0, 28);
    await sleep(400);
    cm.inbox.length = 0;
    cm.send({ t: 'shot', targetId: cg.id });
    await sleep(200);
    cm.send({ t: 'shot', targetId: cg.id });
    await sleep(500);
    const hipShots = cm.inbox.filter((m) => m.t === 'shot' && m.shooterId === cm.id);
    assert.equal(hipShots.length, 2, `marksman hip fire rate is the rifleman's, got ${hipShots.length} shots`);
    assert.equal(hipShots[0].hit, true, 'marksman hip fire at 56 m must hit');
    assert.equal(hipShots[0].damage, 34, 'marksman hip fire past 50 m is 34');
    assert.equal(hipShots[0].targetHealth, 66, 'target health 100 - 34');
    assert.equal(hipShots[1].damage, 34, 'marksman 2nd hip shot at 56 m is 34');
    assert.equal(hipShots[1].targetHealth, 32, 'target health 66 - 34');
    console.log('ok - marksman hip fire at 56 m: 34 damage, twice in 200 ms');
    // Gunner standing at 30 m: out of reach, a miss — no damage.
    await place(cm, 0, -15, { aiming: false });
    await place(cg, 0, 15, { crouch: false });
    await sleep(400);
    const miss = await shotBy(cg, cm.id);
    assert.equal(miss.hit, false, 'standing gunner past 15 m must miss');
    assert.equal(miss.damage, 0, 'standing gunner past 15 m deals no damage');
    // shotBy cleared the inbox; wait for a fresh snapshot before
    // reading the target's health.
    const stillFull = await cg.waitFor('snapshot', (m) => m.players.some((q) => q.id === cm.id), 5000);
    assert.equal(stillFull.players.find((q) => q.id === cm.id).health, 100,
      'a missed shot leaves health at 100');
    console.log('ok - gunner standing at 30 m misses, no damage');
    // Gunner standing at 10 m: 34 damage, 3 hits to kill.
    await place(cm, 0, -5);
    await place(cg, 0, 5);
    await sleep(400);
    const closeShot = await shotBy(cg, cm.id);
    assert.equal(closeShot.hit, true, 'standing gunner within 15 m must hit');
    assert.equal(closeShot.damage, 34, 'standing gunner within 15 m deals 34');
    assert.equal(closeShot.targetHealth, 66, 'target health 100 - 34');
    console.log('ok - gunner standing at 10 m: 34 damage');
    // Gunner crouched at 30 m: normal table, 50 damage.
    await place(cm, 0, -15);
    await place(cg, 0, 15, { crouch: true });
    await sleep(400);
    const crouched = await shotBy(cg, cm.id);
    assert.equal(crouched.hit, true, 'crouched gunner at 30 m must hit');
    assert.equal(crouched.damage, 50, 'crouched gunner at 15-50 m deals 50');
    assert.equal(crouched.targetHealth, 16, 'target health 66 - 50');
    console.log('ok - gunner crouched at 30 m: 50 damage (normal table)');
    // Gunner reload takes 5 s (reloadStart carries the class time).
    cg.send({ t: 'reload' });
    const rs = await cg.waitFor('reloadStart', (m) => m.playerId === cg.id, 5000);
    assert.equal(rs.reloadMs, 5000, 'gunner reload is 5000 ms');
    console.log('ok - gunner reloadStart carries reloadMs 5000');
    // Marksman ADS at 56 m: one hit kills at any range — and the
    // 1 shot/sec gate still holds while aiming, so a second shot
    // 200 ms later is dropped.
    await place(cm, 0, -28, { aiming: true });
    await place(cg, 0, 28);
    await sleep(1500); // clear of the marksman's 1 s gate
    cm.inbox.length = 0;
    cm.send({ t: 'shot', targetId: cg.id });
    await sleep(200);
    cm.send({ t: 'shot', targetId: cg.id });
    await sleep(500);
    const adsShots = cm.inbox.filter((m) => m.t === 'shot' && m.shooterId === cm.id);
    assert.equal(adsShots.length, 1, `marksman ADS fire rate is 1/sec, got ${adsShots.length} shots`);
    const ads = adsShots[0];
    assert.equal(ads.hit, true, 'marksman ADS at 56 m must hit');
    assert.equal(ads.damage, 100, 'marksman ADS kills at any range');
    assert.equal(ads.killed, true, 'marksman ADS at 56 m kills');
    assert.equal(ads.targetHealth, 0, 'target health 0 after the ADS kill');
    console.log('ok - marksman ADS at 56 m: 100 damage, kill; 2nd shot inside 1 s dropped');
    for (const c of [cm, cg]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 19: grenades
    // (Lior, 25/11/2026). 2 per round; a 10 m arc; a wall stops the arc
    // (lands before the wall); the blast kills within 4 m with line of
    // sight, a wall blocks it; the count drops per throw.
    const gr1 = new Client('GrenA');
    const gr2 = new Client('GrenB');
    for (const c of [gr1, gr2]) await c.ready();
    gr1.send({ t: 'join', name: 'GrenA', team: 'A' });
    gr2.send({ t: 'join', name: 'GrenB', team: 'B' });
    await gr1.waitFor('snapshot', (m) => {
      const a = m.players.find((q) => q.id === gr1.id);
      const b = m.players.find((q) => q.id === gr2.id);
      return a && b && a.grenades === 2 && b.grenades === 2;
    });
    console.log('ok - both players start the round with 2 grenades');
    await gr1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    gr1.send({ t: 'start' });
    await waitPrepEnd(gr1);
    const throwBy = async (shooter) => {
      shooter.inbox.length = 0;
      shooter.send({ t: 'throwGrenade' });
      return shooter.waitFor('grenadeThrown', (m) => m.throwerId === shooter.id, 5000);
    };
    const explode = async (watcher, timeoutMs = 6000) => {
      return watcher.waitFor('grenadeExploded', () => true, timeoutMs);
    };
    // Throw 1: into the wall — the arc stops before it (the house at
    // cz 0, z -1.5 is a solid band, not a window or a door).
    gr1.send({ t: 'move', x: 0, y: 0, z: -1.5, yaw: -Math.PI / 2, pitch: 0 });
    await sleep(400);
    const th1 = await throwBy(gr1);
    assert.ok(th1.flightMs >= 400 && th1.flightMs < 1000,
      `a wall-shortened throw flies less than 10 m, got flightMs ${th1.flightMs}`);
    const live1 = await gr1.waitFor('snapshot', (m) => (m.grenades || []).length === 1, 5000);
    assert.equal(live1.grenades.length, 1, 'the live grenade rides the snapshot');
    const ex1 = await explode(gr1);
    assert.ok(ex1.x > 4 && ex1.x < 6, `the grenade lands before the wall, got x ${ex1.x}`);
    assert.equal(ex1.y, 0, 'the grenade lands on the ground floor');
    assert.deepEqual(ex1.victims, [], 'nobody is near the wall throw');
    const oneLeft = await gr1.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === gr1.id);
      return p && p.grenades === 1;
    });
    assert.equal(oneLeft.players.find((q) => q.id === gr1.id).grenades, 1, 'one grenade left');
    console.log('ok - wall stops the arc (lands before it, short flight), count 2 -> 1');
    // Throw 2: the blast 3 m away, but the house wall stands between
    // the explosion and the target — line of sight blocks it.
    gr1.send({ t: 'move', x: 4, y: 0, z: 5, yaw: Math.PI, pitch: 0 });
    gr2.send({ t: 'move', x: 7, y: 0, z: 15, yaw: 0, pitch: 0 });
    await sleep(400);
    await throwBy(gr1);
    const ex2 = await explode(gr1);
    assert.ok(Math.abs(ex2.x - 4) < 0.1 && Math.abs(ex2.z - 15) < 0.1, 'the blast lands at (4, 15)');
    assert.deepEqual(ex2.victims, [], 'a wall between blast and target blocks the kill');
    const g2Alive = await gr2.waitFor('snapshot', (m) => m.players.some((q) => q.id === gr2.id));
    assert.equal(g2Alive.players.find((q) => q.id === gr2.id).health, 100, 'the sheltered player stays at 100');
    console.log('ok - wall blocks the blast: target 3 m away survives at 100');
    // A third throw with none left is ignored.
    gr1.inbox.length = 0;
    gr1.send({ t: 'throwGrenade' });
    await sleep(600);
    assert.equal(gr1.inbox.filter((m) => m.t === 'grenadeThrown' && m.throwerId === gr1.id).length, 0,
      'a throw with 0 grenades must be ignored');
    console.log('ok - a throw with 0 grenades is ignored');
    // Throw 3: open air — the target stands on the landing point.
    gr2.send({ t: 'move', x: 0, y: 0, z: 5, yaw: Math.PI, pitch: 0 });
    gr1.send({ t: 'move', x: 0, y: 0, z: 15, yaw: 0, pitch: 0 });
    await sleep(400);
    await throwBy(gr2);
    const ex3 = await explode(gr2);
    assert.ok(ex3.victims.includes(gr1.id), 'the blast kills the target on the landing point');
    const dead = await gr2.waitFor('snapshot', (m) => {
      const p = m.players.find((q) => q.id === gr1.id);
      return p && !p.alive;
    });
    assert.equal(dead.players.find((q) => q.id === gr1.id).health, 0, 'the victim is at 0 health');
    console.log('ok - open-air blast kills the target on the landing point');
    for (const c of [gr1, gr2]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 20: grenades,
    // continued — window pass-through, thrower self-damage, solo toggle.
    const sOff = new Client('GrenSoloOff');
    await sOff.ready();
    sOff.send({ t: 'solo', name: 'GrenSoloOff', grenades: false });
    await sOff.waitFor('soloJoined');
    const offSnap = await sOff.waitFor('snapshot', (m) => {
      const p = m.players.find((q) => q.id === sOff.id);
      return p && p.grenades === 0;
    });
    assert.equal(offSnap.players.find((q) => q.id === sOff.id).grenades, 0, 'solo with grenades off has 0');
    console.log('ok - solo join with grenades off: 0 grenades');
    sOff.send({ t: 'leaveSolo' });
    await sOff.waitFor('soloLeft');
    sOff.close();
    await sleep(300);
    const sOn = new Client('GrenSoloOn');
    await sOn.ready();
    sOn.send({ t: 'solo', name: 'GrenSoloOn', grenades: true });
    await sOn.waitFor('soloJoined');
    const onSnap = await sOn.waitFor('snapshot', (m) => {
      const p = m.players.find((q) => q.id === sOn.id);
      return p && p.grenades === 2;
    });
    assert.equal(onSnap.players.find((q) => q.id === sOn.id).grenades, 2, 'solo with grenades on has 2');
    console.log('ok - solo join with grenades on: 2 grenades');
    sOn.send({ t: 'leaveSolo' });
    await sOn.waitFor('soloLeft');
    sOn.close();
    await sleep(300);
    const wn1 = new Client('GrenWinA');
    const w2 = new Client('GrenWinB');
    for (const c of [wn1, w2]) await c.ready();
    wn1.send({ t: 'join', name: 'GrenWinA', team: 'A' });
    w2.send({ t: 'join', name: 'GrenWinB', team: 'B' });
    // Wait for both joins to land before starting — sending 'start'
    // immediately after the joins races the second join and the start
    // is rejected (no player on team B yet).
    await wn1.waitFor('state', (m) => m.players.length === 2);
    await wn1.becomeAdmin(); // only the admin starts (Lior, 25/11/2026)
    wn1.send({ t: 'start' });
    await waitPrepEnd(wn1);
    // Window: the arc at z 3.5 passes the ground-floor window and
    // lands inside the house; the target 2 m inside dies.
    wn1.send({ t: 'move', x: 0, y: 0, z: 3.5, yaw: -Math.PI / 2, pitch: 0 });
    w2.send({ t: 'move', x: 12, y: 0, z: 3.5, yaw: 0, pitch: 0 });
    await sleep(400);
    wn1.inbox.length = 0;
    wn1.send({ t: 'throwGrenade' });
    await wn1.waitFor('grenadeThrown', (m) => m.throwerId === wn1.id, 5000);
    const exW = await wn1.waitFor('grenadeExploded', () => true, 6000);
    assert.ok(exW.x > 6, `the grenade passes the window and lands inside, got x ${exW.x}`);
    assert.ok(exW.victims.includes(w2.id), 'the blast kills inside the house');
    console.log('ok - grenade through the window kills inside the house');
    // Round 2: grenades reset to 2, and a throw at a nearby wall kills
    // the thrower himself (friendly fire, 2.5 m from the blast).
    wn1.send({ t: 'continue' });
    await waitPrepEnd(wn1);
    const reset = await wn1.waitFor('snapshot', (m) => {
      const p = m.players.find((q) => q.id === wn1.id);
      return p && p.grenades === 2 && p.alive;
    });
    assert.equal(reset.players.find((q) => q.id === wn1.id).grenades, 2, 'grenades reset to 2 on the next round');
    console.log('ok - grenades reset to 2 on the next round');
    wn1.send({ t: 'move', x: 3, y: 0, z: -1.5, yaw: -Math.PI / 2, pitch: 0 });
    await sleep(400);
    wn1.inbox.length = 0;
    wn1.send({ t: 'throwGrenade' });
    await wn1.waitFor('grenadeThrown', (m) => m.throwerId === wn1.id, 5000);
    const exS = await wn1.waitFor('grenadeExploded', () => true, 6000);
    assert.ok(exS.victims.includes(wn1.id), 'the thrower dies to his own wall throw');
    console.log('ok - thrower dies to his own blast (friendly fire)');
    for (const c of [wn1, w2]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 21: admin
    // (Lior, 25/11/2026). With NO admin in the room, the lobby works as
    // before — anyone may start, the host assigns classes. Once someone
    // enters the code, only the admin starts / continues, renames, moves
    // teams, assigns classes, and toggles grenades.
    // No admin yet: the host assigns a class and anyone may start.
    const na1 = new Client('NoAdmA');
    const na2 = new Client('NoAdmB');
    for (const c of [na1, na2]) await c.ready();
    na1.send({ t: 'join', name: 'NoAdmA', team: 'A' });
    na2.send({ t: 'join', name: 'NoAdmB', team: 'B' });
    await na1.waitFor('state', (m) => m.players.length === 2);
    na1.send({ t: 'setClass', playerId: na2.id, cls: 'gunner' });
    const naGun = await na1.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === na2.id);
      return p && p.cls === 'gunner';
    });
    assert.equal(naGun.players.find((q) => q.id === na2.id).inMag, 120, 'with no admin, the host assigns the gunner');
    console.log('ok - with no admin, the host assigns a class');
    na2.send({ t: 'setClass', playerId: na1.id, cls: 'gunner' });
    await sleep(400);
    const naStill = na1.findLast('state', (m) => m.players.some((q) => q.id === na1.id));
    assert.equal(naStill.players.find((q) => q.id === na1.id).cls, 'rifleman', 'with no admin, a non-host setClass is ignored');
    console.log('ok - with no admin, a non-host setClass is ignored');
    na1.send({ t: 'start' });
    await na1.waitFor('roundStart', (m) => m.round === 1, 5000);
    console.log('ok - with no admin, anyone may start the match');
    for (const c of [na1, na2]) c.close();
    await sleep(600); // let the server notice the empty room and reset
    // An admin exists now: ad1 enters the code first.
    const ad1 = new Client('AdmA');
    const ad2 = new Client('AdmB');
    for (const c of [ad1, ad2]) await c.ready();
    ad1.send({ t: 'join', name: 'AdmA', team: 'A' });
    ad2.send({ t: 'join', name: 'AdmB', team: 'B' });
    await ad1.waitFor('state', (m) => m.players.length === 2);
    await ad1.becomeAdmin();
    const adminState = await ad1.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === ad1.id);
      return p && p.admin === true;
    });
    assert.equal(adminState.players.find((q) => q.id === ad1.id).admin, true, 'ad1 is the admin');
    console.log('ok - correct code makes the admin (state shows admin true)');
    // A non-admin start is rejected.
    ad2.inbox.length = 0;
    ad2.send({ t: 'start' });
    const noAdminErr = await ad2.waitFor('error', (m) => /Only the admin/.test(m.message), 5000);
    assert.ok(noAdminErr, 'a non-admin start must be rejected');
    console.log('ok - non-admin start is rejected');
    // A wrong code is rejected.
    ad2.inbox.length = 0;
    ad2.send({ t: 'admin', code: 'wrong-code' });
    const wrongCodeErr = await ad2.waitFor('error', (m) => /Wrong admin code/.test(m.message), 5000);
    assert.ok(wrongCodeErr, 'a wrong admin code must be rejected');
    console.log('ok - wrong admin code is rejected');
    // A non-admin cannot assign a class.
    ad2.send({ t: 'setClass', playerId: ad1.id, cls: 'gunner' });
    await sleep(400);
    const stillRifle = await ad1.waitFor('state', (m) => m.players.some((q) => q.id === ad1.id));
    assert.equal(stillRifle.players.find((q) => q.id === ad1.id).cls, 'rifleman', 'a non-admin setClass is ignored');
    console.log('ok - non-admin setClass is ignored');
    // The admin assigns a class, renames, and moves a team.
    ad1.send({ t: 'setClass', playerId: ad2.id, cls: 'gunner' });
    const gunnerState = await ad1.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === ad2.id);
      return p && p.cls === 'gunner';
    });
    assert.equal(gunnerState.players.find((q) => q.id === ad2.id).inMag, 120, 'the admin-assigned gunner loads 120');
    console.log('ok - admin setClass works (gunner, 120 in mag)');
    ad1.send({ t: 'rename', playerId: ad2.id, name: 'RenamedB' });
    const renamed = await ad1.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === ad2.id);
      return p && p.name === 'RenamedB';
    });
    assert.equal(renamed.players.find((q) => q.id === ad2.id).name, 'RenamedB', 'the admin rename lands');
    console.log('ok - admin rename works');
    // An empty rename is ignored (no new state; the latest one still
    // carries the renamed name — findLast, not the oldest state).
    ad1.send({ t: 'rename', playerId: ad2.id, name: '   ' });
    await sleep(400);
    const stillNamed = ad1.findLast('state', (m) => m.players.some((q) => q.id === ad2.id));
    assert.equal(stillNamed.players.find((q) => q.id === ad2.id).name, 'RenamedB', 'an empty rename is ignored');
    console.log('ok - empty rename is ignored');
    // Move ad2 to team A: now B is empty, so the start fails on teams.
    ad1.send({ t: 'setTeam', playerId: ad2.id, team: 'A' });
    await ad1.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === ad2.id);
      return p && p.team === 'A';
    });
    console.log('ok - admin setTeam moves a player');
    ad1.inbox.length = 0;
    ad1.send({ t: 'start' });
    const teamErr = await ad1.waitFor('error', (m) => /each team/.test(m.message), 5000);
    assert.ok(teamErr, 'starting with an empty team must fail');
    console.log('ok - start still fails with an empty team (after the move)');
    ad1.send({ t: 'setTeam', playerId: ad2.id, team: 'B' });
    await ad1.waitFor('state', (m) => {
      const p = m.players.find((q) => q.id === ad2.id);
      return p && p.team === 'B';
    });
    // Grenades toggle: the admin turns them off, the state shows it.
    ad1.send({ t: 'setGrenadesAllowed', allowed: false });
    const grenOff = await ad1.waitFor('state', (m) => m.grenadesAllowed === false);
    assert.equal(grenOff.grenadesAllowed, false, 'grenades off in the state');
    console.log('ok - admin grenades toggle works (state shows off)');
    ad1.send({ t: 'setGrenadesAllowed', allowed: true });
    // The admin starts the match.
    ad1.send({ t: 'start' });
    await waitPrepEnd(ad1);
    console.log('ok - admin start works, match begins');
    // A non-admin continue is ignored: the round ends, the intermission
    // waits, and only the admin's continue starts round 2.
    ad2.send({ t: 'move', x: 0, y: 0, z: 28, yaw: 0, pitch: 0 });
    ad1.send({ t: 'move', x: 0, y: 0, z: -28, yaw: 0, pitch: 0 });
    await sleep(400);
    for (let i = 0; i < 3; i++) {
      ad1.send({ t: 'shot', targetId: ad2.id });
      await sleep(250);
    }
    await ad1.waitFor('snapshot', (m) => {
      const p = m.players.find((q) => q.id === ad2.id);
      return p && !p.alive;
    });
    ad2.inbox.length = 0;
    ad2.send({ t: 'continue' });
    await sleep(600);
    assert.equal(ad2.inbox.filter((m) => m.t === 'roundStart').length, 0, 'a non-admin continue must not start the next round');
    console.log('ok - non-admin continue is ignored');
    ad1.send({ t: 'continue' });
    await ad1.waitFor('roundStart', (m) => m.round === 2, 5000);
    console.log('ok - admin continue starts round 2');
    // setTeam mid-match is ignored (latest state still shows team B).
    ad1.send({ t: 'setTeam', playerId: ad2.id, team: 'A' });
    await sleep(400);
    const stillB = ad1.findLast('state', (m) => m.players.some((q) => q.id === ad2.id));
    assert.equal(stillB.players.find((q) => q.id === ad2.id).team, 'B', 'setTeam mid-match is ignored');
    console.log('ok - setTeam mid-match is ignored');
    for (const c of [ad1, ad2]) c.close();
    await sleep(300);

    // Scenario 22 (wall impacts): the impact point rides the shot.
    const im1 = new Client('ImpOne');
    const im2 = new Client('ImpTwo');
    for (const c of [im1, im2]) await c.ready();
    im1.send({ t: 'join', name: 'ImpOne', team: 'A' });
    im2.send({ t: 'join', name: 'ImpTwo', team: 'B' });
    await im1.waitFor('state', (m) => m.players.length === 2);
    await im1.becomeAdmin();
    im1.send({ t: 'start' });
    await waitPrepEnd(im1);
    im2.inbox.length = 0;
    im1.send({ t: 'shot', targetId: null, impact: { x: 1.24, y: 0.87, z: -3.33 } });
    const echo = await im2.waitFor('shot', (m) => m.shooterId === im1.id && m.impact != null);
    assert.deepEqual(echo.impact, { x: 1.2, y: 0.9, z: -3.3 }, 'impact is echoed, rounded to 1 decimal');
    console.log('ok - impact point is echoed in the shot broadcast');
    await sleep(200);
    im2.inbox.length = 0;
    im1.send({ t: 'shot', targetId: null });
    const noImpact = await im2.waitFor('shot', (m) => m.shooterId === im1.id);
    assert.equal(noImpact.impact, null, 'a shot without an impact broadcasts null');
    console.log('ok - shot without impact broadcasts null');
    await sleep(200);
    im2.inbox.length = 0;
    im1.send({ t: 'shot', targetId: null, impact: { x: 'a', y: null, z: {} } });
    const badImpact = await im2.waitFor('shot', (m) => m.shooterId === im1.id);
    assert.equal(badImpact.impact, null, 'a malformed impact is dropped');
    console.log('ok - malformed impact is dropped');
    for (const c of [im1, im2]) c.close();
    await sleep(300);

    // Scenario 23 (admin spectator, bird's-eye).
    const sp1 = new Client('SpecAdmin');
    const sp2 = new Client('SpecMate');
    const sp3 = new Client('SpecFoe');
    for (const c of [sp1, sp2, sp3]) await c.ready();
    sp1.send({ t: 'join', name: 'SpecAdmin', team: 'A' });
    sp2.send({ t: 'join', name: 'SpecMate', team: 'A' });
    sp3.send({ t: 'join', name: 'SpecFoe', team: 'B' });
    await sp1.waitFor('state', (m) => m.players.length === 3);
    await sp1.becomeAdmin();
    // A non-admin cannot spectate.
    sp2.inbox.length = 0;
    sp2.send({ t: 'spectate' });
    await sleep(500);
    assert.equal(sp2.inbox.filter((m) => m.t === 'spectateJoined').length, 0, 'a non-admin spectate is ignored');
    console.log('ok - non-admin spectate is ignored');
    // The admin spectates: leaves the player list, keeps the admin flag.
    sp1.send({ t: 'spectate' });
    const joined = await sp1.waitFor('spectateJoined', () => true);
    assert.ok(joined.id < 0, 'the spectator id is negative (not a player id)');
    const specState = await sp1.waitFor('state', (m) => m.adminSpectating === true);
    assert.equal(specState.players.length, 2, 'the spectator is no longer a player');
    assert.ok(!specState.players.some((q) => q.name === 'SpecAdmin'), 'no figure for the spectator');
    console.log('ok - admin spectates, leaves the player list, keeps the admin flag');
    // A non-admin start stays rejected while the admin spectates.
    sp3.inbox.length = 0;
    sp3.send({ t: 'start' });
    await sleep(400);
    assert.ok(sp3.inbox.some((m) => m.t === 'error' && /Only the admin/.test(m.message)), 'start is still admin-only');
    console.log('ok - start stays admin-only while the admin spectates');
    // The spectating admin starts the match from above.
    sp1.send({ t: 'start' });
    await sp2.waitFor('roundStart', (m) => m.round === 1, 5000);
    console.log('ok - spectating admin starts the match');
    // The spectator receives snapshots (bird's-eye view data).
    await sp1.waitFor('snapshot', (m) => m.players.length === 2, 5000);
    console.log('ok - spectator receives snapshots');
    // The spectator cannot shoot.
    sp2.inbox.length = 0;
    sp1.send({ t: 'shot', targetId: sp3.id });
    await sleep(500);
    assert.equal(sp2.inbox.filter((m) => m.t === 'shot' && m.shooterId === joined.id).length, 0, 'a spectator shot is ignored');
    console.log('ok - spectator cannot shoot');
    // Leaving spectator mode returns to the lobby, admin flag clears.
    // (Clear the inbox first: waitFor returns the OLDEST match, and an
    // old pre-spectate state also has adminSpectating false.)
    sp1.inbox.length = 0;
    sp1.send({ t: 'leaveSpectate' });
    await sp1.waitFor('spectateLeft', () => true);
    const afterLeave = await sp1.waitFor('state', (m) => m.adminSpectating === false);
    assert.equal(afterLeave.players.length, 2, 'the room still has its two players');
    console.log('ok - leaveSpectate returns to the lobby');
    for (const c of [sp1, sp2, sp3]) c.close();
    await sleep(300);

    // Scenario 24 (expiring invite links).
    const iv1 = new Client('InvAdmin');
    const iv2 = new Client('InvGuest');
    for (const c of [iv1, iv2]) await c.ready();
    iv1.send({ t: 'join', name: 'InvAdmin', team: 'A' });
    iv2.send({ t: 'join', name: 'InvGuest', team: 'B' });
    await iv1.waitFor('state', (m) => m.players.length === 2);
    await iv1.becomeAdmin();
    // A non-admin cannot create an invite.
    iv2.inbox.length = 0;
    iv2.send({ t: 'createInvite' });
    await sleep(500);
    assert.equal(iv2.inbox.filter((m) => m.t === 'inviteCreated').length, 0, 'a non-admin createInvite is ignored');
    console.log('ok - non-admin createInvite is ignored');
    // The admin creates one: random 8-char code, expiry ~TTL out.
    iv1.send({ t: 'createInvite' });
    const created = await iv1.waitFor('inviteCreated', () => true);
    assert.equal(typeof created.code, 'string', 'an invite code is returned');
    assert.equal(created.code.length, 8, 'the code is 8 chars');
    assert.ok(created.expiresAt > Date.now() && created.expiresAt <= Date.now() + 1500, 'the invite expires ~TTL out');
    console.log('ok - admin creates an invite link');
    // A live code checks valid; a bogus one does not.
    iv1.send({ t: 'checkInvite', code: created.code });
    const live = await iv1.waitFor('inviteStatus', (m) => m.code === created.code);
    assert.equal(live.valid, true, 'a live invite checks valid');
    console.log('ok - live invite checks valid');
    iv2.send({ t: 'checkInvite', code: 'bogus123' });
    const bogus = await iv2.waitFor('inviteStatus', (m) => m.code === 'bogus123');
    assert.equal(bogus.valid, false, 'a bogus invite checks invalid');
    console.log('ok - bogus invite checks invalid');
    // After the TTL passes, the same code reports invalid.
    await sleep(1800);
    iv1.send({ t: 'checkInvite', code: created.code });
    const stale = await iv1.waitFor('inviteStatus', (m) => m.code === created.code && m.valid === false);
    assert.equal(stale.valid, false, 'an expired invite checks invalid');
    console.log('ok - expired invite checks invalid');
    for (const c of [iv1, iv2]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 25: round duration
    // (Lior, 26/11/2026). The admin sets the round length in minutes
    // from the lobby; it applies from the next round. A non-admin's
    // set is ignored. The test env runs ROUND_MS=60000 (1 min), so
    // setting 2 must stretch the clock to ~120 s.
    const rd1 = new Client('RdAdmin');
    const rd2 = new Client('RdMate');
    for (const c of [rd1, rd2]) await c.ready();
    rd1.send({ t: 'join', name: 'RdAdmin', team: 'A' });
    rd2.send({ t: 'join', name: 'RdMate', team: 'B' });
    await rd1.waitFor('state', (m) => m.players.length === 2);
    await rd1.becomeAdmin();
    const rdDefault = await rd1.waitFor('state', (m) => m.roundDurationMin != null);
    assert.equal(rdDefault.roundDurationMin, 1, 'default round length is the env ROUND_MS (1 min)');
    console.log('ok - default round length is 1 min (env)');
    rd2.send({ t: 'setRoundDuration', minutes: 5 });
    await sleep(400);
    const rdStill = rd1.findLast('state', (m) => m.roundDurationMin != null);
    assert.equal(rdStill.roundDurationMin, 1, 'a non-admin setRoundDuration is ignored');
    console.log('ok - non-admin setRoundDuration is ignored');
    rd1.send({ t: 'setRoundDuration', minutes: 2 });
    const rdSet = await rd1.waitFor('state', (m) => m.roundDurationMin === 2);
    assert.equal(rdSet.roundDurationMin, 2, 'admin setRoundDuration to 2 min');
    console.log('ok - admin sets the round length to 2 min');
    // Prep is a shared toggle — an earlier scenario may have left it
    // on, which would put the 2 min clock after a 5 s prep. Turn it
    // off so the clock reads ~120 s from the start.
    rd1.send({ t: 'setPrepEnabled', enabled: false });
    await rd1.waitFor('state', (m) => m.prepEnabled === false);
    rd1.send({ t: 'start' });
    await rd1.waitFor('roundStart', (m) => m.round === 1, 5000);
    await waitPrepEnd(rd1);
    const rdSnap = await rd1.waitFor('snapshot', (m) => m.phase === 'playing' && m.timeLeftMs > 0, 5000);
    assert.ok(rdSnap.timeLeftMs > 115000 && rdSnap.timeLeftMs <= 120000,
      `round clock is ~120 s, got ${rdSnap.timeLeftMs} ms`);
    console.log('ok - round with admin-set 2 min runs a ~120 s clock');
    for (const c of [rd1, rd2]) c.close();
    await sleep(300);

    // Scenario 26 — solo NPC respawn: the replacement is a live target.
    const resp = new Client('RespawnShooter');
    await resp.ready();
    resp.send({ t: 'solo', name: 'RespawnShooter' });
    await resp.waitFor('soloJoined');
    const rSetSnap = await resp.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true).length === 10);
    const rSet = rSetSnap.players.filter((p) => p.npc === true);
    const victim = rSet[0];
    resp.send({ t: 'move', x: 0, y: 0, z: victim.z, yaw: 0, pitch: 0 });
    await sleep(300);
    resp.inbox.length = 0;
    resp.send({ t: 'shot', targetId: victim.id });
    const rKill = await resp.waitFor('shot', (m) => m.shooterId === resp.id && m.targetId === victim.id, 5000);
    assert.equal(rKill.killed, true);
    const rKillAt = Date.now();
    // Wait for the replacement (same id, alive, new spot).
    resp.inbox.length = 0;
    const rRespawnSnap = await resp.waitFor('snapshot', (m) => {
      const n = m.players.find((p) => p.npc === true && p.id === victim.id);
      return n && n.alive === true && n.health === 100
        && (n.x !== victim.x || n.y !== victim.y || n.z !== victim.z);
    }, 5000);
    const rMs = Date.now() - rKillAt;
    assert.ok(rMs >= 1700 && rMs <= 5000, `replacement must arrive ~2 s after the kill, took ${rMs} ms`);
    const replacement = rRespawnSnap.players.find((p) => p.id === victim.id);
    // The replacement is itself a live target: walk to its window and
    // shoot it down again.
    resp.send({ t: 'move', x: 0, y: 0, z: replacement.z, yaw: 0, pitch: 0 });
    await sleep(300);
    resp.inbox.length = 0;
    resp.send({ t: 'shot', targetId: replacement.id });
    const rKill2 = await resp.waitFor('shot', (m) => m.shooterId === resp.id && m.targetId === replacement.id, 5000);
    assert.equal(rKill2.killed, true);
    assert.equal(rKill2.targetHealth, 0);
    console.log(`ok - respawned NPC is a live target and goes down again (${rMs} ms)`);
    resp.close();
    await sleep(300);

    // ------------------------------------------------ scenario 27: admin
    // code before join (v41, item 5). Entering the code on an unjoined
    // connection stores a pending-admin flag; the join applies it and
    // sends adminOk, and an admin-gated action then works. A wrong
    // pre-join code grants nothing.
    const ab1 = new Client('AbAdmin');
    const ab2 = new Client('AbMate');
    for (const c of [ab1, ab2]) await c.ready();
    ab1.send({ t: 'admin', code: 'wrong-code' });
    const abWrong = await ab1.waitFor('error', (m) => /Wrong admin code/.test(m.message || ''));
    assert.ok(abWrong, 'a wrong pre-join code is rejected');
    ab1.send({ t: 'join', name: 'AbAdmin', team: 'A' });
    await ab1.waitFor('joined');
    await sleep(300);
    const abNotAdmin = ab1.findLast('state');
    assert.equal(abNotAdmin.players.find((p) => p.id === ab1.id).admin, false, 'a wrong code must not make the joiner admin');
    console.log('ok - wrong admin code before join is rejected and grants nothing');
    ab2.send({ t: 'admin', code: 'test-code' });
    await ab2.waitFor('adminOk');
    ab2.inbox.length = 0;
    ab2.send({ t: 'join', name: 'AbMate', team: 'B' });
    await ab2.waitFor('joined');
    await ab2.waitFor('adminOk'); // second adminOk, on join
    const abAdminState = await ab2.waitFor('state', (m) => m.players.some((p) => p.id === ab2.id && p.admin === true));
    assert.ok(abAdminState.players.find((p) => p.id === ab2.id).admin, 'the pre-join admin applies on join');
    ab2.send({ t: 'setRoundDuration', minutes: 3 });
    const abSet = await ab2.waitFor('state', (m) => m.roundDurationMin === 3);
    assert.equal(abSet.roundDurationMin, 3, 'the pre-join admin can use admin-gated actions');
    console.log('ok - admin code before join applies on join (adminOk + gated action works)');
    ab2.send({ t: 'setRoundDuration', minutes: 1 }); // leave the clock as the suite found it
    await ab2.waitFor('state', (m) => m.roundDurationMin === 1);
    for (const c of [ab1, ab2]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 28: missile
    // class (v41, item 12). The missile soldier ("טילן" in the UI)
    // fires a rifleman-equivalent rifle, carries 0 grenades and 2
    // missiles per round; charging shows a missile flag in snapshots;
    // the blast kills through walls (no line of sight) and spends a
    // munition; a third fire with none left is rejected.
    const mi = new Client('MissileSolo');
    await mi.ready();
    mi.send({ t: 'solo', name: 'MissileSolo', cls: 'missile' });
    await mi.waitFor('soloJoined');
    const miState = await mi.waitFor('state', (m) => m.players.some((p) => p.id === mi.id));
    const miEntry = miState.players.find((p) => p.id === mi.id);
    assert.equal(miEntry.cls, 'missile', 'solo join carries the missile class');
    assert.equal(miEntry.missiles, 2, 'missile soldier starts with 2 munitions');
    assert.equal(miEntry.grenades, 0, 'missile soldier carries no grenades');
    console.log('ok - missile class joins solo with 2 munitions and 0 grenades');
    const miSnap0 = await mi.waitFor('snapshot', (m) => m.players.filter((p) => p.npc === true).length === 10);
    const miVictim = miSnap0.players.filter((p) => p.npc === true).find((p) => p.y === 0);
    // Charge: the snapshot carries missile:true on the shooter.
    mi.send({ t: 'missileCharge', on: true });
    const miCharged = await mi.waitFor('snapshot', (m) => {
      const me = m.players.find((p) => p.id === mi.id);
      return me && me.missile === true;
    }, 5000);
    assert.ok(miCharged, 'charging shows the missile flag in snapshots');
    console.log('ok - missile charge flag appears in snapshots');
    // Fire at a point 1.3 m street-side of the NPC: the NPC sits just
    // inside its house wall, so the wall stands between the impact and
    // the victim — a grenade there would be blocked, the missile is not.
    const miImpact = {
      x: Math.round((miVictim.x < 0 ? miVictim.x + 1.3 : miVictim.x - 1.3) * 10) / 10,
      y: 0,
      z: miVictim.z,
    };
    mi.send({ t: 'missile', impact: miImpact });
    const miBlast = await mi.waitFor('missileBlast', (m) => m.shooterId === mi.id, 5000);
    assert.ok(miBlast.victims.some((v) => v.id === miVictim.id && v.killed),
      'the blast kills the NPC through the wall');
    assert.deepEqual([miBlast.impact.x, miBlast.impact.y, miBlast.impact.z],
      [miImpact.x, miImpact.y, miImpact.z], 'the blast echoes the impact point');
    const miState2 = await mi.waitFor('state', (m) => {
      const e = m.players.find((p) => p.id === mi.id);
      return e && e.missiles === 1;
    });
    assert.equal(miState2.players.find((p) => p.id === mi.id).missiles, 1, 'munitions drop to 1 after the first fire');
    console.log('ok - missile blast kills through a wall, munitions drop to 1');
    // The charge flag clears on fire.
    mi.inbox.length = 0;
    const miSnapAfter = await mi.waitFor('snapshot', (m) => {
      const me = m.players.find((p) => p.id === mi.id);
      return me && me.missile !== true;
    }, 5000);
    assert.ok(miSnapAfter, 'the charge flag clears after firing');
    // Second fire: another NPC goes down, munitions hit 0.
    const miSnap1 = await mi.waitFor('snapshot', (m) =>
      m.players.filter((p) => p.npc === true && p.alive === true).length >= 9);
    const miVictim2 = miSnap1.players.filter((p) => p.npc === true && p.alive === true && p.id !== miVictim.id)
      .find((p) => p.y === 0);
    const miImpact2 = {
      x: Math.round((miVictim2.x < 0 ? miVictim2.x + 1.3 : miVictim2.x - 1.3) * 10) / 10,
      y: 0,
      z: miVictim2.z,
    };
    mi.send({ t: 'missileCharge', on: true });
    await mi.waitFor('snapshot', (m) => m.players.find((p) => p.id === mi.id)?.missile === true, 5000);
    mi.send({ t: 'missile', impact: miImpact2 });
    const miBlast2 = await mi.waitFor('missileBlast', (m) => m.shooterId === mi.id
      && m.victims.some((v) => v.id === miVictim2.id), 5000);
    assert.ok(miBlast2.victims.some((v) => v.id === miVictim2.id && v.killed), 'the second blast kills its NPC');
    await mi.waitFor('state', (m) => m.players.find((p) => p.id === mi.id)?.missiles === 0, 5000);
    // Third fire with none left is rejected: no blast at all.
    mi.inbox.length = 0;
    mi.send({ t: 'missile', impact: miImpact2 });
    await sleep(600);
    assert.equal(mi.inbox.filter((m) => m.t === 'missileBlast').length, 0, 'a third fire with no munitions is rejected');
    console.log('ok - second fire spends the last munition; a third fire is rejected');
    mi.close();
    await sleep(300);

    // ------------------------------------------------ scenario 29: spectator
    // one-tap rejoin (v41, item 18). A spectator sends 'join' straight
    // from the spectator view — no leaveSpectate first — and is a
    // player again (fresh positive id, admin flag kept, no spectator
    // record left behind).
    const rj1 = new Client('RejoinAdmin');
    const rj2 = new Client('RejoinMate');
    const rj3 = new Client('RejoinFoe');
    for (const c of [rj1, rj2, rj3]) await c.ready();
    rj1.send({ t: 'join', name: 'RejoinAdmin', team: 'A' });
    rj2.send({ t: 'join', name: 'RejoinMate', team: 'A' });
    rj3.send({ t: 'join', name: 'RejoinFoe', team: 'B' });
    await rj1.waitFor('state', (m) => m.players.length === 3);
    await rj1.becomeAdmin();
    rj1.send({ t: 'spectate' });
    const rjSpec = await rj1.waitFor('spectateJoined', () => true);
    assert.ok(rjSpec.id < 0, 'the spectator id is negative');
    await rj1.waitFor('state', (m) => m.adminSpectating === true);
    rj1.inbox.length = 0;
    rj1.send({ t: 'join', name: 'RejoinAdmin', team: 'A' });
    const rjJoined = await rj1.waitFor('joined', () => true, 5000);
    assert.ok(rjJoined.id > 0, 'the rejoined player gets a fresh positive id');
    rj1.id = rjJoined.id; // the Client id was the welcome id; the rejoin id is new
    const rjState = await rj1.waitFor('state', (m) => m.players.length === 3 && m.adminSpectating === false);
    assert.ok(rjState.players.some((p) => p.id === rjJoined.id && p.name === 'RejoinAdmin' && p.admin === true),
      'the rejoining spectator is a player again — and still the admin');
    console.log('ok - spectator rejoins with one join (fresh player id, admin kept, no spectator record)');
    for (const c of [rj1, rj2, rj3]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 30: mid-match
    // spectate (v41, item 19). Allowed only when the admin's team has
    // >= 2 players; the last player on a team is rejected with
    // spectate_last_player; and a team emptying because its last
    // living player spectated does NOT forfeit the round.
    const ms1 = new Client('MsAdmin');
    const ms2 = new Client('MsMate');
    const ms3 = new Client('MsFoe');
    for (const c of [ms1, ms2, ms3]) await c.ready();
    ms1.send({ t: 'join', name: 'MsAdmin', team: 'A' });
    ms2.send({ t: 'join', name: 'MsMate', team: 'A' });
    ms3.send({ t: 'join', name: 'MsFoe', team: 'B' });
    await ms1.waitFor('state', (m) => m.players.length === 3);
    await ms1.becomeAdmin();
    ms1.send({ t: 'setPrepEnabled', enabled: false });
    await ms1.waitFor('state', (m) => m.prepEnabled === false);
    ms1.send({ t: 'start' });
    await ms1.waitFor('roundStart', (m) => m.round === 1);
    await waitPrepEnd(ms1);
    // The foe kills the admin's teammate, so the admin is the last
    // living player on A (the dead mate is still a player record, so
    // the team still counts 2 players and spectate is allowed).
    ms2.send({ t: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    ms3.send({ t: 'move', x: 2, y: 0, z: 0, yaw: 0, pitch: 0 });
    await sleep(300);
    ms3.send({ t: 'shot', targetId: ms2.id });
    const msKill = await ms3.waitFor('shot', (m) => m.targetId === ms2.id && m.killed, 5000);
    assert.ok(msKill, 'the foe kills the admin\'s teammate');
    assert.equal(msKill.damage, 100, 'close-range kill');
    // Admin spectates: allowed (2 players on A), and the round does
    // NOT end — a team emptying by spectate is not a forfeit.
    ms1.send({ t: 'spectate' });
    await ms1.waitFor('spectateJoined', () => true);
    const msSpecState = await ms1.waitFor('state', (m) => m.adminSpectating === true);
    assert.equal(msSpecState.players.length, 2, 'spectating admin leaves the player list mid-match');
    assert.equal(msSpecState.phase, 'playing', 'the round keeps playing');
    await sleep(800);
    assert.equal(ms1.inbox.filter((m) => m.t === 'roundEnd').length, 0,
      'no round end when the last living player spectates');
    console.log('ok - mid-match spectate allowed with 2 on the team; no forfeit when the team empties by spectate');
    for (const c of [ms1, ms2, ms3]) c.close();
    await sleep(600);
    // Second match: the admin alone on A is the last player — spectate
    // is rejected with spectate_last_player and the admin stays put.
    const mr1 = new Client('MrAdmin');
    const mr2 = new Client('MrFoe');
    const mr3 = new Client('MrFoe2');
    for (const c of [mr1, mr2, mr3]) await c.ready();
    mr1.send({ t: 'join', name: 'MrAdmin', team: 'A' });
    mr2.send({ t: 'join', name: 'MrFoe', team: 'B' });
    mr3.send({ t: 'join', name: 'MrFoe2', team: 'B' });
    await mr1.waitFor('state', (m) => m.players.length === 3);
    await mr1.becomeAdmin();
    mr1.send({ t: 'setPrepEnabled', enabled: false });
    await mr1.waitFor('state', (m) => m.prepEnabled === false);
    mr1.send({ t: 'start' });
    await mr1.waitFor('roundStart', (m) => m.round === 1);
    await waitPrepEnd(mr1);
    mr1.inbox.length = 0;
    mr1.send({ t: 'spectate' });
    const mrReject = await mr1.waitFor('error', (m) => m.code === 'spectate_last_player', 5000);
    assert.ok(mrReject, 'last-player spectate is rejected with spectate_last_player');
    await sleep(400);
    assert.equal(mr1.inbox.filter((m) => m.t === 'spectateJoined').length, 0, 'no spectateJoined on rejection');
    const mrAfter = mr2.findLast('state');
    assert.ok(mrAfter.players.some((p) => p.id === mr1.id), 'the rejected admin stays a player');
    assert.equal(mrAfter.phase, 'playing', 'the round keeps playing after the rejection');
    assert.equal(mrAfter.adminSpectating, false, 'nobody is spectating after the rejection');
    console.log('ok - last player on the team cannot spectate mid-match (spectate_last_player)');
    for (const c of [mr1, mr2, mr3]) c.close();
    await sleep(600);

    // ------------------------------------------------ scenario 31: dual maps
    // (v41, item 23). The room map is 'small' by default; only the
    // admin may change it, lobby only; the state carries the map.
    assert.equal(typeof mapMod.getLayout, 'function', 'map.js must export getLayout for the dual-map scenarios');
    const mp1 = new Client('MapAdmin');
    const mp2 = new Client('MapMate');
    const mp3 = new Client('MapFoe');
    for (const c of [mp1, mp2, mp3]) await c.ready();
    mp1.send({ t: 'join', name: 'MapAdmin', team: 'A' });
    mp2.send({ t: 'join', name: 'MapMate', team: 'A' });
    mp3.send({ t: 'join', name: 'MapFoe', team: 'B' });
    await mp1.waitFor('state', (m) => m.players.length === 3);
    await mp1.becomeAdmin();
    const mpDefault = await mp1.waitFor('state', (m) => m.map != null);
    assert.equal(mpDefault.map, 'small', 'default map is small');
    console.log('ok - default map is small (state.map)');
    mp2.send({ t: 'setMap', map: 'large' });
    await sleep(400);
    assert.equal(mp1.findLast('state').map, 'small', 'a non-admin setMap is ignored');
    console.log('ok - non-admin setMap is ignored');
    mp1.send({ t: 'setMap', map: 'large' });
    const mpLarge = await mp1.waitFor('state', (m) => m.map === 'large');
    assert.equal(mpLarge.map, 'large', 'admin setMap to large');
    assert.ok(mpLarge.objective, 'state carries the large-map objective');
    console.log('ok - admin sets the map to large; state carries map + objective');
    mp1.send({ t: 'setPrepEnabled', enabled: false });
    await mp1.waitFor('state', (m) => m.prepEnabled === false);
    mp1.send({ t: 'start' });
    await mp1.waitFor('roundStart', (m) => m.round === 1);
    await waitPrepEnd(mp1);
    mp1.send({ t: 'setMap', map: 'small' });
    await sleep(400);
    assert.equal(mp1.findLast('state').map, 'large', 'a mid-match setMap is ignored');
    console.log('ok - mid-match setMap is ignored');
    for (const c of [mp1, mp2, mp3]) c.close();
    await sleep(600);

    // ------------------------------------------------ scenario 32: tall-building
    // capture (v41, item 24, large map only). With building 8 set, the
    // defenders spawn in the tall building and the objective sits on
    // its third floor (yMin 6): an attacker at ground level inside the
    // footprint does NOT progress the capture; at y >= 6 the hold runs
    // and wins the round by objective.
    const tc1 = new Client('TallAtk');
    const tc2 = new Client('TallDef');
    for (const c of [tc1, tc2]) await c.ready();
    tc1.send({ t: 'join', name: 'TallAtk', team: 'A' });
    tc2.send({ t: 'join', name: 'TallDef', team: 'B' });
    await tc1.waitFor('state', (m) => m.players.length === 2);
    await tc1.becomeAdmin();
    tc1.send({ t: 'setAttackers', team: 'A' });
    tc1.send({ t: 'setMap', map: 'large' });
    await tc1.waitFor('state', (m) => m.map === 'large');
    tc1.send({ t: 'setDefSpawn', building: 8 });
    const tcSet = await tc1.waitFor('state', (m) => m.defSpawn === 8);
    assert.ok(tcSet.objective && tcSet.objective.yMin === 6,
      `tall objective carries yMin 6, got ${JSON.stringify(tcSet.objective)}`);
    console.log('ok - tall-building spawn set (building 8, objective yMin 6)');
    tc1.send({ t: 'setPrepEnabled', enabled: false });
    await tc1.waitFor('state', (m) => m.prepEnabled === false);
    tc1.send({ t: 'start' });
    const tcR1 = await tc1.waitFor('roundStart', (m) => m.round === 1);
    await waitPrepEnd(tc1);
    assert.ok(tcR1.objective && tcR1.objective.yMin === 6, 'roundStart carries the tall objective');
    const obj = tcR1.objective;
    // Ground level inside the footprint: no capture progress.
    tc1.send({ t: 'move', x: obj.x, y: 0, z: obj.z, yaw: 0, pitch: 0 });
    await sleep(1500);
    const tcGround = tc1.findLast('snapshot', (m) => m.phase === 'playing');
    assert.ok(tcGround && tcGround.captureProgress === 0,
      `ground-level hold must not progress the capture, got ${tcGround && tcGround.captureProgress}`);
    assert.equal(tc1.inbox.filter((m) => m.t === 'roundEnd').length, 0, 'no round end from ground level');
    console.log('ok - attacker at ground level inside the footprint does not progress the capture');
    // At y >= yMin the hold runs and wins the round (CAPTURE_MS=600 here).
    tc1.inbox.length = 0;
    tc1.send({ t: 'move', x: obj.x, y: 6, z: obj.z, yaw: 0, pitch: 0 });
    const tcEnd = await tc1.waitFor('roundEnd', (m) => m.winner === 'A' && m.reason === 'objective', 5000);
    assert.equal(tcEnd.score.A, 1, 'the tall capture wins the round for the attackers');
    console.log('ok - attacker at y >= yMin captures and wins the round by objective');
    for (const c of [tc1, tc2]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 33: admin
    // leave + rejoin keeps admin (v41, item 17 fix, 27/11/2026). A player
    // who logs in WHILE JOINED got p.admin but no pending flag, and the
    // client never re-sent the code on a manual rejoin — so leaving and
    // rejoining silently dropped the admin permission (the admin panel
    // never came back). Both halves fixed: the joined admin case keeps
    // the pending flag on the connection, and sendJoin re-sends the
    // stored code before the join.
    const lv1 = new Client('LvAdmin');
    const lv2 = new Client('LvFoe');
    for (const c of [lv1, lv2]) await c.ready();
    lv1.send({ t: 'join', name: 'LvAdmin', team: 'A' });
    lv2.send({ t: 'join', name: 'LvFoe', team: 'B' });
    await lv1.waitFor('state', (m) => m.players.length === 2);
    await lv1.becomeAdmin();
    lv1.send({ t: 'leave' });
    await lv1.waitFor('left', () => true, 5000);
    lv1.send({ t: 'join', name: 'LvAdmin', team: 'A' });
    await lv1.waitFor('joined', () => true, 5000);
    const lvState = await lv1.waitFor('state', (m) => m.players.some((p) => p.name === 'LvAdmin' && p.admin === true), 5000);
    assert.ok(lvState.players.some((p) => p.name === 'LvAdmin' && p.admin === true),
      'the rejoined player is admin again');
    // And the permission really works: a gated action goes through.
    lv1.send({ t: 'setPrepEnabled', enabled: false });
    await lv1.waitFor('state', (m) => m.prepEnabled === false, 5000);
    console.log('ok - admin leaves and rejoins on the same connection and stays admin');
    for (const c of [lv1, lv2]) c.close();
    await sleep(300);

    // ------------------------------------------------ scenario 34: joined
    // carries the team spawn (camera spawn race, 27/11/2026). Before the
    // fix the team `joined` message carried no spawn, so the client's
    // local position stayed at the (0, -55) default until the first
    // round-change snapshot snapped it — a player whose snapshot arrived
    // late spawned at the default. Now the spawn rides `joined`, like
    // soloJoined already did. The check is state-independent (the room
    // may still be on the large map with a tall spawn from scenario 32):
    // the spawn must exist, must not be the client default, and must
    // match the server's own record in the next snapshot.
    const js1 = new Client('Js1');
    const js2 = new Client('Js2');
    for (const c of [js1, js2]) await c.ready();
    js1.send({ t: 'join', name: 'Js1', team: 'A' });
    js2.send({ t: 'join', name: 'Js2', team: 'B' });
    const js1Joined = await js1.waitFor('joined', () => true, 5000);
    const js2Joined = await js2.waitFor('joined', () => true, 5000);
    for (const [c, j] of [[js1, js1Joined], [js2, js2Joined]]) {
      assert.ok(j.spawn && typeof j.spawn.x === 'number' && typeof j.spawn.y === 'number'
        && typeof j.spawn.z === 'number' && typeof j.spawn.yaw === 'number',
        `${c.name}: joined must carry a spawn point, got ${JSON.stringify(j.spawn)}`);
      assert.ok(!(j.spawn.x === 0 && j.spawn.z === -55),
        `${c.name}: joined spawn must not be the (0, -55) client default, got ${JSON.stringify(j.spawn)}`);
    }
    // The spawn the server sent is the spawn it assigned: the next
    // snapshot must show the player at exactly that spot.
    const jSnap = await js1.waitFor('snapshot', (m) => m.players.some((p) => p.id === js1.id), 5000);
    const jMe = jSnap.players.find((p) => p.id === js1.id);
    assert.equal(jMe.x, js1Joined.spawn.x, 'snapshot x must match the joined spawn');
    assert.equal(jMe.z, js1Joined.spawn.z, 'snapshot z must match the joined spawn');
    assert.equal(jMe.yaw, js1Joined.spawn.yaw, 'snapshot yaw must match the joined spawn');
    console.log('ok - team joined carries the team spawn (not the (0, -55) default), matching the snapshot');
    for (const c of [js1, js2]) c.close();
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

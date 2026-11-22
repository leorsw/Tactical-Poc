// headless-test.mjs — scripted end-to-end test of the game server.
//
// Spawns the real server on port 8021 with a short intermission, connects
// fake WebSocket clients, and plays through:
//   Scenario 1 (2v2): elimination round win, then an objective round win,
//     then a reload cycle — verifying round resets between rounds.
//   Scenario 2 (1v2): asymmetric teams — starting with 1 player on a side
//     must succeed (but starting with an empty team must fail).
//   Scenario 3 (solo): one player explores alone — no team, room stays in
//     lobby, shooting and reload work, nobody can shoot them or be shot by
//     them, a match can start alongside, and leaving solo frees them to
//     join a team.
//
// Run: node test/headless-test.mjs  (or: npm test)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { SPAWNS, OBJECTIVE } from '../public/map.js';

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
    env: { ...process.env, PORT: String(PORT), ROUND_MS: '60000', INTERMISSION_MS: '1000' },
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
    await a1.waitFor('roundStart', (m) => m.round === 1);
    await a1.waitFor('state', (m) => m.phase === 'playing');
    console.log('ok - match started, round 1 playing, A attacks');

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

    // Round 2 starts after the 1s intermission; attackers win by objective.
    await a1.waitFor('roundStart', (m) => m.round === 2);
    console.log('ok - round 2 started after intermission (positions/ammo reset)');
    a2.send({ t: 'move', x: OBJECTIVE.x, y: 0, z: OBJECTIVE.z, yaw: 0, pitch: 0 });
    const round2End = await a1.waitFor('roundEnd', (m) => m.winner === 'A' && m.reason === 'objective');
    assert.equal(round2End.score.A, 2);
    console.log('ok - round 2 ends: attackers win by reaching the objective, score 2-0');

    await a1.waitFor('roundStart', (m) => m.round === 3);
    console.log('ok - round 3 started');

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

    // Friendly fire: A1 shoots teammate A2 once — A2 must die.
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

    // Leave solo and re-join as a team player.
    s.send({ t: 'leaveSolo' });
    await s.waitFor('soloLeft');
    // The room broadcast after removal goes only to players still in the
    // room, so a remaining player confirms the solo player is gone.
    await j1.waitFor('state', (m) => !m.players.some((p) => p.id === s.id));
    console.log('ok - leaving solo removes the player from the room');
    s.send({ t: 'join', name: 'Solo', team: 'A' });
    await s.waitFor('joined');
    console.log('ok - after leaving solo, joining a team works');

    for (const c of [s, j1, k1]) c.close();
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

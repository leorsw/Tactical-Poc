// main.js — game client for the tactical FPS POC.
//
// Vanilla Three.js (no build step). The client simulates local movement,
// raycasts shots locally and sends claims to the server, which validates
// them. HUD, minimap, lobby and spectating all live here.

import * as THREE from 'three';
import {
  HOUSES,
  OBJECTIVE,
  SPAWNS,
  visualBoxes,
  stairRamps,
  floorHeightAt,
  resolveCollision,
  EYE_HEIGHT,
} from './map.js';
import { Controls } from './controls.js';
import { GameSocket } from './net.js';
import { Sfx } from './audio.js';

const SPEED = 5; // m/s
const FIRE_INTERVAL = 100; // ms between shots (~10/sec)
const MOVE_SEND_MS = 66;
const TEAM_COLORS = { attackers: 0x2b6cff, defenders: 0xe53333 };
const TEAM_CSS = { attackers: '#2b6cff', defenders: '#e53333' };

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const lobbyEl = $('lobby');
const gameEl = $('game');
const connectStatus = $('connectStatus');
const joinBox = $('joinBox');
const teamsBox = $('teamsBox');
const nameInput = $('nameInput');
const teamAList = $('teamAList');
const teamBList = $('teamBList');
const roleAEl = $('roleA');
const roleBEl = $('roleB');
const teamHint = $('teamHint');
const hostControls = $('hostControls');
const startBtn = $('startBtn');
const startHint = $('startHint');
const waitHost = $('waitHost');
const scoreBox = $('scoreBox');
const timerEl = $('timer');
const aliveBox = $('aliveBox');
const roundInfo = $('roundInfo');
const healthFill = $('healthFill');
const healthText = $('healthText');
const ammoText = $('ammoText');
const reloadBar = $('reloadBar');
const reloadFill = $('reloadFill');
const reloadText = $('reloadText');
const killfeedEl = $('killfeed');
const crosshairEl = $('crosshair');
const hitmarkerEl = $('hitmarker');
const damageFlashEl = $('damageFlash');
const bannerEl = $('banner');
const spectateBar = $('spectateBar');
const lockHint = $('lockHint');
const exitSoloBtn = $('exitSoloBtn');
const endScreen = $('endScreen');
const endTitle = $('endTitle');
const endScore = $('endScore');
const endHostBtns = $('endHostBtns');
const endWait = $('endWait');
const minimapCanvas = $('minimap');
const mmCtx = minimapCanvas.getContext('2d');

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------
const socket = new GameSocket();
const sfx = new Sfx();
const controls = new Controls({ onReload: () => tryReload() });

let myId = null;
let joined = false;
let solo = false;
let myTeam = null;
let isHost = false;
let meta = new Map(); // playerId -> {name, team, role, commander, host}
let snapPlayers = new Map(); // playerId -> latest snapshot entry
let game = {
  phase: 'lobby',
  round: 0,
  score: { A: 0, B: 0 },
  attackersTeam: 'A',
  timeLeftMs: 0,
  intermissionLeftMs: 0,
};
let lastRoundSeen = 0;
let myAlive = true;
let myHealth = 100;
let myInMag = 29;
let myMags = 5;
let reloading = false;
let reloadEndsAt = 0;
let lastFireAt = 0;
let lastMoveSent = 0;

// Local player transform (authoritative copy lives on the server; the client
// simulates movement and the server relays it to everyone else).
const local = { x: 0, y: 0, z: -55, yaw: Math.PI, pitch: 0 };

// Spectating.
let spectateTarget = null; // player id

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
let renderer = null;
let scene = null;
let camera = null;
let raycaster = null;
const shootTargets = []; // meshes bullets can hit (walls, ground, players)
const playerMeshes = new Map(); // playerId -> THREE.Group
let threeReady = false;

function initThree() {
  if (threeReady) return;
  threeReady = true;
  const container = $('scene-container');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x87b5d6);
  container.appendChild(renderer.domElement);
  renderer.domElement.addEventListener('click', onCanvasClick);
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x87b5d6, 90, 180);
  camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 300);
  camera.rotation.order = 'YXZ';
  raycaster = new THREE.Raycaster();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(30, 60, 20);
  scene.add(sun);

  // Ground + street.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220),
    new THREE.MeshLambertMaterial({ color: 0x77825f })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  shootTargets.push(ground);

  const street = new THREE.Mesh(
    new THREE.PlaneGeometry(12.6, 126),
    new THREE.MeshLambertMaterial({ color: 0x555555 })
  );
  street.rotation.x = -Math.PI / 2;
  street.position.y = 0;
  scene.add(street);
  shootTargets.push(street);

  // Houses (walls with door/window gaps, slabs, roofs).
  const materials = {};
  for (const b of visualBoxes()) {
    if (!materials[b.color]) {
      materials[b.color] = new THREE.MeshLambertMaterial({ color: b.color });
    }
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    const d = b.z1 - b.z0;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials[b.color]);
    mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
    scene.add(mesh);
    shootTargets.push(mesh);
  }

  // Stair ramps.
  const stairMat = new THREE.MeshLambertMaterial({ color: 0x8f8f8f });
  for (const s of stairRamps()) {
    const slant = Math.hypot(s.run, s.rise);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.width, 0.25, slant), stairMat);
    mesh.position.set(s.cx, s.rise / 2 - 0.1, s.cz);
    mesh.rotation.x = -Math.atan2(s.rise, s.run); // ascends towards +z
    scene.add(mesh);
    shootTargets.push(mesh);
  }

  // Objective: pillar of light + floor ring at the defenders' end.
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(OBJECTIVE.r, OBJECTIVE.r, 30, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffcc00, transparent: true, opacity: 0.14,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  pillar.position.set(OBJECTIVE.x, 15, OBJECTIVE.z);
  scene.add(pillar);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(OBJECTIVE.r - 0.4, OBJECTIVE.r + 0.2, 40),
    new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(OBJECTIVE.x, 0.03, OBJECTIVE.z);
  scene.add(ring);

  // Spawn zone markers.
  const mkSpawn = (z, color) => {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(3, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(0, 0.02, z);
    scene.add(disc);
  };
  mkSpawn(SPAWNS.attackers[0].z, TEAM_COLORS.attackers);
  mkSpawn(SPAWNS.defenders[0].z, TEAM_COLORS.defenders);

  controls.attach(renderer.domElement, {
    joyZone: $('joyZone'),
    joyBase: $('joyBase'),
    joyKnob: $('joyKnob'),
    lookZone: $('lookZone'),
    fireBtn: $('fireBtn'),
    reloadBtn: $('reloadBtn'),
  });
  if (controls.isTouch) document.body.classList.add('touch');
  $('lookZone').addEventListener('click', () => {
    // On mobile, tapping the look area while spectating cycles the target.
    if (!myAlive && game.phase === 'playing') cycleSpectate();
  });

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
  window.addEventListener('blur', () => {
    controls.keys.clear();
    controls.firing = false;
  });

  requestAnimationFrame(loop);
}

function makeNameSprite(name, colorCss) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, 256, 56);
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colorCss;
  ctx.fillText(name.slice(0, 16), 128, 30);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(2.4, 0.53, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function getPlayerMesh(id) {
  if (playerMeshes.has(id)) return playerMeshes.get(id);
  const m = meta.get(id) || {};
  const color = TEAM_COLORS[m.role] || 0x888888;
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.85, 4, 10), bodyMat);
  body.position.y = 0.85;
  body.userData.playerId = id;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), bodyMat);
  head.position.y = 1.62;
  head.userData.playerId = id;
  group.add(head);
  // Simple gun box so the facing direction reads at a glance.
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.7), new THREE.MeshLambertMaterial({ color: 0x222222 }));
  gun.position.set(0.25, 1.25, -0.45);
  group.add(gun);
  const tag = makeNameSprite(m.name || '?', TEAM_CSS[m.role] || '#ffffff');
  tag.position.y = 2.15;
  group.add(tag);
  group.userData.bodyMat = bodyMat;
  group.userData.tag = tag;
  group.userData.tagName = m.name || '?';
  scene.add(group);
  playerMeshes.set(id, group);
  shootTargets.push(body, head);
  return group;
}

function removePlayerMesh(id) {
  const g = playerMeshes.get(id);
  if (!g) return;
  scene.remove(g);
  playerMeshes.delete(id);
  for (let i = shootTargets.length - 1; i >= 0; i--) {
    if (shootTargets[i].userData.playerId === id) shootTargets.splice(i, 1);
  }
}

function refreshMeshColors() {
  for (const [id, g] of playerMeshes) {
    const m = meta.get(id) || {};
    const color = TEAM_COLORS[m.role] || 0x888888;
    g.userData.bodyMat.color.setHex(color);
    if (g.userData.tagName !== (m.name || '?')) {
      // Name changed (shouldn't happen) — rebuild the tag.
      g.remove(g.userData.tag);
      const tag = makeNameSprite(m.name || '?', TEAM_CSS[m.role] || '#ffffff');
      tag.position.y = 2.15;
      g.add(tag);
      g.userData.tag = tag;
      g.userData.tagName = m.name || '?';
    }
  }
}

// ---------------------------------------------------------------------------
// Lobby UI
// ---------------------------------------------------------------------------

function renderLobby(state) {
  const byTeam = { A: [], B: [] };
  let soloCount = 0;
  for (const p of state.players) {
    if (p.solo) {
      soloCount++;
      continue;
    }
    byTeam[p.team].push(p);
  }
  const renderList = (el, list) => {
    el.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      const tags = [];
      if (p.commander) tags.push('COMMANDER');
      if (p.host) tags.push('HOST');
      li.textContent = p.name + (p.id === myId ? ' (you)' : '');
      if (tags.length) {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = tags.join(' · ');
        li.appendChild(span);
      }
      el.appendChild(li);
    }
    if (!list.length) {
      const li = document.createElement('li');
      li.textContent = '— empty —';
      li.style.color = '#777';
      el.appendChild(li);
    }
  };
  renderList(teamAList, byTeam.A);
  renderList(teamBList, byTeam.B);

  const setRole = (el, team) => {
    const isAtk = state.attackersTeam === team;
    el.textContent = isAtk ? 'ATTACKERS' : 'DEFENDERS';
    el.className = 'role ' + (isAtk ? 'atk' : 'def');
  };
  setRole(roleAEl, 'A');
  setRole(roleBEl, 'B');

  const aCount = byTeam.A.length;
  const bCount = byTeam.B.length;
  if (aCount === 1 || bCount === 1) {
    teamHint.textContent = 'Heads up: 2+ players per team is recommended for a good test, but you can start with 1vX.';
  } else {
    teamHint.textContent = `${aCount} vs ${bCount} — asymmetric splits are allowed.`;
  }
  if (soloCount > 0) {
    teamHint.textContent += ` ${soloCount} player${soloCount > 1 ? 's' : ''} exploring in solo mode.`;
  }

  const me = state.players.find((p) => p.id === myId);
  isHost = !!me && state.hostId === myId;
  hostControls.classList.toggle('hidden', !isHost);
  waitHost.classList.toggle('hidden', isHost);
  $('atkA').classList.toggle('activeChoice', state.attackersTeam === 'A');
  $('atkB').classList.toggle('activeChoice', state.attackersTeam === 'B');
  const canStart = aCount >= 1 && bCount >= 1;
  startBtn.disabled = !canStart;
  startHint.textContent = canStart
    ? 'First to 3 round wins takes the match.'
    : 'Need at least 1 player on each team to start.';
}

function showScreen(name) {
  lobbyEl.classList.toggle('hidden', name !== 'lobby');
  gameEl.classList.toggle('hidden', name !== 'game');
  if (name === 'game') initThree();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function roleLabel(team) {
  return game.attackersTeam === team ? 'ATK' : 'DEF';
}

function updateHUD() {
  // Score + timer + alive counts.
  if (solo) {
    scoreBox.textContent = 'SOLO MODE';
    timerEl.textContent = '—';
    aliveBox.textContent = '—';
    roundInfo.textContent = 'Explore the map — move, shoot, reload';
  } else {
    scoreBox.textContent = `${roleLabel('A')} ${game.score.A} — ${game.score.B} ${roleLabel('B')}`;
    if (game.phase === 'playing') {
      timerEl.textContent = fmtTime(game.timeLeftMs);
    } else if (game.phase === 'intermission') {
      timerEl.textContent = `Next round ${Math.ceil(game.intermissionLeftMs / 1000)}s`;
    } else {
      timerEl.textContent = '—';
    }
    let atkAlive = 0;
    let defAlive = 0;
    for (const [id, s] of snapPlayers) {
      const m = meta.get(id);
      if (!m || !s.alive) continue;
      if (m.role === 'attackers') atkAlive++;
      else defAlive++;
    }
    aliveBox.textContent = `ATK alive ${atkAlive} · DEF alive ${defAlive}`;
    roundInfo.textContent = game.phase === 'playing' || game.phase === 'intermission'
      ? `Round ${game.round} — first to 3`
      : '';
  }

  // Health + ammo (mine).
  healthFill.style.width = `${myHealth}%`;
  healthFill.style.background = myHealth > 50 ? '#4caf50' : myHealth > 25 ? '#ffb340' : '#e53333';
  healthText.textContent = myHealth;
  if (myInMag === 0 && myMags === 0) {
    ammoText.textContent = 'NO AMMO';
    ammoText.style.color = '#e53333';
  } else {
    ammoText.textContent = `${myInMag} | ${myMags} mags`;
    ammoText.style.color = myInMag === 0 ? '#ffb340' : '';
  }

  // Reload progress.
  if (reloading) {
    reloadText.classList.remove('hidden');
    const total = 3500;
    const left = Math.max(0, reloadEndsAt - performance.now());
    reloadFill.style.width = `${(1 - left / total) * 100}%`;
    if (left <= 0) reloading = false;
  } else {
    reloadText.classList.add('hidden');
    reloadFill.style.width = '0%';
  }

  // Lock hint (desktop, alive, in game, not locked).
  const inGame = game.phase === 'playing' || solo;
  const showLockHint = !controls.isTouch && myAlive && inGame && !controls.locked;
  lockHint.classList.toggle('hidden', !showLockHint);
  crosshairEl.classList.toggle('hidden', !myAlive || !inGame);

  // Spectate bar.
  if (!myAlive && game.phase === 'playing') {
    const target = spectateTarget != null ? meta.get(spectateTarget) : null;
    spectateBar.textContent = target
      ? `ELIMINATED — spectating ${target.name} (click / tap to cycle)`
      : 'ELIMINATED — no living teammates to spectate';
    spectateBar.classList.remove('hidden');
  } else {
    spectateBar.classList.add('hidden');
  }
}

function addKillfeed(text) {
  const div = document.createElement('div');
  div.textContent = text;
  killfeedEl.appendChild(div);
  while (killfeedEl.children.length > 5) killfeedEl.removeChild(killfeedEl.firstChild);
  setTimeout(() => div.remove(), 6000);
}

function showHitmarker(kill) {
  hitmarkerEl.classList.toggle('kill', !!kill);
  hitmarkerEl.classList.remove('hidden');
  clearTimeout(showHitmarker._t);
  showHitmarker._t = setTimeout(() => hitmarkerEl.classList.add('hidden'), 130);
}

let damageFlashTimer = null;
function showDamageFlash() {
  damageFlashEl.classList.add('on');
  clearTimeout(damageFlashTimer);
  damageFlashTimer = setTimeout(() => damageFlashEl.classList.remove('on'), 3000);
}

let bannerTimer = null;
function showBanner(text, ms = 4000) {
  bannerEl.textContent = text;
  bannerEl.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

function drawMinimap() {
  const W = 150;
  const H = 150;
  mmCtx.clearRect(0, 0, W, H);
  mmCtx.fillStyle = 'rgba(15,17,20,0.9)';
  mmCtx.fillRect(0, 0, W, H);
  const mx = (x) => ((x + 18) / 36) * W;
  const mz = (z) => ((z + 62) / 124) * H;
  // Street.
  mmCtx.fillStyle = '#3a3a3a';
  mmCtx.fillRect(mx(-6), 0, mx(6) - mx(-6), H);
  // Houses.
  mmCtx.fillStyle = '#777';
  for (const h of HOUSES) {
    mmCtx.fillRect(mx(h.x0), mz(h.z0), mx(h.x1) - mx(h.x0), mz(h.z1) - mz(h.z0));
  }
  // Objective diamond.
  mmCtx.fillStyle = '#ffcc00';
  const ox = mx(OBJECTIVE.x);
  const oy = mz(OBJECTIVE.z);
  mmCtx.beginPath();
  mmCtx.moveTo(ox, oy - 6);
  mmCtx.lineTo(ox + 5, oy);
  mmCtx.lineTo(ox, oy + 6);
  mmCtx.lineTo(ox - 5, oy);
  mmCtx.closePath();
  mmCtx.fill();
  // Teammates (alive only) + self arrow.
  for (const [id, s] of snapPlayers) {
    if (!s.alive) continue;
    const m = meta.get(id);
    if (!m || m.team !== myTeam) continue;
    const px = mx(s.x);
    const py = mz(s.z);
    if (id === myId) {
      const fx = -Math.sin(s.yaw);
      const fz = -Math.cos(s.yaw);
      const ang = Math.atan2(fz, fx);
      mmCtx.fillStyle = '#ffffff';
      mmCtx.beginPath();
      mmCtx.moveTo(px + Math.cos(ang) * 7, py + Math.sin(ang) * 7);
      mmCtx.lineTo(px + Math.cos(ang + 2.5) * 5, py + Math.sin(ang + 2.5) * 5);
      mmCtx.lineTo(px + Math.cos(ang - 2.5) * 5, py + Math.sin(ang - 2.5) * 5);
      mmCtx.closePath();
      mmCtx.fill();
    } else {
      mmCtx.fillStyle = TEAM_CSS[m.role];
      mmCtx.beginPath();
      mmCtx.arc(px, py, 3.5, 0, Math.PI * 2);
      mmCtx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// Spectating
// ---------------------------------------------------------------------------

function livingTeammates() {
  const list = [];
  for (const [id, s] of snapPlayers) {
    if (id === myId) continue;
    const m = meta.get(id);
    if (m && m.team === myTeam && s.alive) list.push(id);
  }
  return list;
}

function cycleSpectate() {
  const mates = livingTeammates();
  if (!mates.length) {
    spectateTarget = null;
    return;
  }
  const idx = mates.indexOf(spectateTarget);
  spectateTarget = mates[(idx + 1) % mates.length];
}

// ---------------------------------------------------------------------------
// Shooting / reload
// ---------------------------------------------------------------------------

function tryFire(now) {
  if (!myAlive || (game.phase !== 'playing' && !solo)) return;
  if (reloading || myInMag <= 0) return;
  if (now - lastFireAt < FIRE_INTERVAL) return;
  lastFireAt = now;

  // Hitscan from the camera centre with a small random spread.
  raycaster.setFromCamera(
    { x: (Math.random() - 0.5) * 0.02, y: (Math.random() - 0.5) * 0.02 },
    camera
  );
  const hits = raycaster.intersectObjects(shootTargets, false);
  let targetId = null;
  if (hits.length > 0) {
    const first = hits[0].object;
    if (first.userData.playerId != null) targetId = first.userData.playerId;
  }
  socket.send({ t: 'shot', targetId });
  sfx.shoot();
}

function tryReload() {
  if (!myAlive || (game.phase !== 'playing' && !solo)) return;
  if (reloading || myMags <= 0 || myInMag >= 29) return;
  socket.send({ t: 'reload' });
}

function onCanvasClick() {
  sfx.ensure();
  if (game.phase !== 'playing' && !solo) return;
  if (!myAlive) {
    cycleSpectate();
    return;
  }
  controls.requestLock();
}

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------

let connected = false;
socket.onOpen = () => {
  connected = true;
  connectStatus.textContent = 'Connected.';
  joinBox.classList.remove('hidden');
};
socket.onClose = () => {
  connectStatus.textContent = 'Disconnected from the server. Reload the page to reconnect.';
};

socket.on('welcome', (msg) => {
  myId = msg.id;
});

socket.on('joined', (msg) => {
  myId = msg.id;
  joined = true;
  joinBox.classList.add('hidden');
  teamsBox.classList.remove('hidden');
});

socket.on('soloJoined', (msg) => {
  myId = msg.id;
  joined = true;
  solo = true;
  myTeam = null;
  if (msg.spawn) {
    local.x = msg.spawn.x;
    local.y = msg.spawn.y;
    local.z = msg.spawn.z;
    local.yaw = msg.spawn.yaw;
    local.pitch = 0;
  }
  myAlive = true;
  myHealth = 100;
  myInMag = 29;
  myMags = 5;
  joinBox.classList.add('hidden');
  teamsBox.classList.add('hidden');
  exitSoloBtn.classList.remove('hidden');
  showScreen('game');
  showBanner('SOLO MODE\nExplore the map — move, shoot, reload', 4000);
});

socket.on('soloLeft', () => {
  solo = false;
  joined = false;
  myTeam = null;
  myAlive = true;
  myHealth = 100;
  myInMag = 29;
  myMags = 5;
  exitSoloBtn.classList.add('hidden');
  teamsBox.classList.add('hidden');
  joinBox.classList.remove('hidden');
  showScreen('lobby');
});

socket.on('error', (msg) => {
  teamHint.textContent = msg.message || 'Error';
  connectStatus.textContent = msg.message || 'Error';
});

socket.on('state', (msg) => {
  game.phase = msg.phase;
  game.round = msg.round;
  game.score = msg.score;
  game.attackersTeam = msg.attackersTeam;
  meta = new Map(msg.players.map((p) => [p.id, p]));
  const me = meta.get(myId);
  if (me) myTeam = me.team;
  refreshMeshColors();
  // Drop meshes for players who left.
  for (const id of [...playerMeshes.keys()]) {
    if (!meta.has(id)) removePlayerMesh(id);
  }
  if (!joined) return;
  if (solo) return; // stay in the solo game view; the room may be in lobby phase
  renderLobby(msg);
  if (msg.phase === 'lobby') {
    showScreen('lobby');
    endScreen.classList.add('hidden');
  } else {
    showScreen('game');
  }
});

socket.on('snapshot', (msg) => {
  game.phase = msg.phase;
  game.round = msg.round;
  game.score = msg.score;
  game.timeLeftMs = msg.timeLeftMs;
  game.intermissionLeftMs = msg.intermissionLeftMs;
  snapPlayers = new Map(msg.players.map((p) => [p.id, p]));

  const me = snapPlayers.get(myId);
  if (me) {
    const wasAlive = myAlive;
    myAlive = me.alive;
    myHealth = me.health;
    myInMag = me.inMag;
    myMags = me.mags;
    // Snap local position on round change (server-assigned spawn).
    if (msg.round !== lastRoundSeen) {
      lastRoundSeen = msg.round;
      local.x = me.x;
      local.y = me.y;
      local.z = me.z;
      local.yaw = me.yaw;
      local.pitch = me.pitch;
      spectateTarget = null;
      controls.exitLock();
    }
    if (wasAlive && !myAlive) {
      // Just eliminated: pick a teammate to spectate.
      spectateTarget = livingTeammates()[0] ?? null;
      controls.exitLock();
      controls.firing = false;
    }
    if (!wasAlive && myAlive) spectateTarget = null;
  }
  // Validate the spectate target is still alive.
  if (spectateTarget != null) {
    const t = snapPlayers.get(spectateTarget);
    if (!t || !t.alive) spectateTarget = livingTeammates()[0] ?? null;
  }
});

socket.on('shot', (msg) => {
  if (solo) return; // solo shots never hit; match shots stay out of the solo HUD
  if (msg.shooterId === myId && msg.hit) {
    showHitmarker(msg.killed);
    sfx.hit();
  }
  if (msg.targetId === myId && msg.hit && !msg.killed) {
    showDamageFlash();
  }
  if (msg.killed) {
    const shooter = meta.get(msg.shooterId)?.name || '?';
    const victim = meta.get(msg.targetId)?.name || '?';
    addKillfeed(msg.friendlyFire ? `${shooter} ▸ ${victim} (TEAMKILL)` : `${shooter} ▸ ${victim}`);
  }
});

socket.on('reloadStart', (msg) => {
  if (msg.playerId === myId) {
    reloading = true;
    reloadEndsAt = performance.now() + msg.reloadMs;
  }
});

socket.on('reloaded', (msg) => {
  if (msg.playerId === myId) reloading = false;
});

socket.on('roundStart', (msg) => {
  if (solo) return;
  endScreen.classList.add('hidden');
  showBanner(`ROUND ${msg.round}`, 2500);
});

socket.on('roundEnd', (msg) => {
  if (solo) return;
  const winnerRole = game.attackersTeam === msg.winner ? 'ATTACKERS' : 'DEFENDERS';
  const teamLetter = msg.winner;
  const reasonText =
    msg.reason === 'elimination'
      ? 'eliminated the enemy team'
      : msg.reason === 'objective'
        ? 'reached the objective'
        : 'survived the round';
  showBanner(
    `${winnerRole} (Team ${teamLetter}) WIN THE ROUND\n${reasonText}\nScore: ${msg.score.A} — ${msg.score.B}`,
    6000
  );
});

socket.on('matchEnd', (msg) => {
  if (solo) return;
  const winnerRole = game.attackersTeam === msg.winner ? 'ATTACKERS' : 'DEFENDERS';
  endTitle.textContent = `${winnerRole} (Team ${msg.winner}) WIN THE MATCH`;
  endScore.textContent = `Final score: Team A ${msg.score.A} — ${msg.score.B} Team B`;
  endHostBtns.classList.toggle('hidden', !isHost);
  endWait.classList.toggle('hidden', isHost);
  endScreen.classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Lobby buttons
// ---------------------------------------------------------------------------

function join(team) {
  sfx.ensure();
  const name = nameInput.value.trim() || `Player${myId ?? ''}`;
  socket.send({ t: 'join', name, team });
}

$('joinA').addEventListener('click', () => join('A'));
$('joinB').addEventListener('click', () => join('B'));
$('joinAuto').addEventListener('click', () => join(null));
$('soloBtn').addEventListener('click', () => {
  sfx.ensure();
  const name = nameInput.value.trim() || `Player${myId ?? ''}`;
  socket.send({ t: 'solo', name });
});
exitSoloBtn.addEventListener('click', () => socket.send({ t: 'leaveSolo' }));
$('switchBtn').addEventListener('click', () => {
  socket.send({ t: 'switchTeam', team: myTeam === 'A' ? 'B' : 'A' });
});
$('atkA').addEventListener('click', () => socket.send({ t: 'setAttackers', team: 'A' }));
$('atkB').addEventListener('click', () => socket.send({ t: 'setAttackers', team: 'B' }));
$('startBtn').addEventListener('click', () => socket.send({ t: 'start' }));
$('rematchBtn').addEventListener('click', () => socket.send({ t: 'rematch', swap: false }));
$('swapBtn').addEventListener('click', () => socket.send({ t: 'rematch', swap: true }));
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join(null);
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let lastMinimapDraw = 0;

function loop() {
  requestAnimationFrame(loop);
  if (!threeReady) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();

  // Remote players: create/update meshes, interpolate towards snapshots.
  for (const [id, s] of snapPlayers) {
    if (id === myId) continue;
    if (!s.alive) {
      const g = playerMeshes.get(id);
      if (g) g.visible = false;
      continue;
    }
    const g = getPlayerMesh(id);
    g.visible = true;
    const k = 1 - Math.exp(-dt * 12);
    g.position.x += (s.x - g.position.x) * k;
    g.position.y += (s.y - g.position.y) * k;
    g.position.z += (s.z - g.position.z) * k;
    // Shortest-arc yaw interpolation.
    let dyaw = s.yaw - g.rotation.y;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    g.rotation.y += dyaw * k;
  }

  if ((game.phase === 'playing' || solo) && myAlive) {
    // Look.
    const look = controls.takeLook();
    local.yaw -= look.dx * 0.0023;
    local.pitch -= look.dy * 0.0023;
    local.pitch = Math.max(-1.45, Math.min(1.45, local.pitch));

    // Move.
    const move = controls.getMove();
    const sin = Math.sin(local.yaw);
    const cos = Math.cos(local.yaw);
    const fx = -sin;
    const fz = -cos;
    const rx = cos;
    const rz = -sin;
    let vx = fx * move.z + rx * move.x;
    let vz = fz * move.z + rz * move.x;
    const len = Math.hypot(vx, vz);
    if (len > 0) {
      vx = (vx / len) * SPEED * Math.min(1, len);
      vz = (vz / len) * SPEED * Math.min(1, len);
    }
    let nx = local.x + vx * dt;
    let nz = local.z + vz * dt;
    const resolved = resolveCollision(nx, nz, local.y);
    nx = resolved.x;
    nz = resolved.z;
    local.x = nx;
    local.z = nz;
    local.y = floorHeightAt(nx, nz, local.y);

    camera.position.set(local.x, local.y + EYE_HEIGHT, local.z);
    camera.rotation.set(local.pitch, local.yaw, 0);

    // Fire while holding.
    if (controls.firing) tryFire(now);

    // Send movement ~15/sec.
    if (now - lastMoveSent >= MOVE_SEND_MS) {
      lastMoveSent = now;
      socket.send({ t: 'move', x: local.x, y: local.y, z: local.z, yaw: local.yaw, pitch: local.pitch });
    }
  } else if (game.phase === 'playing' && !myAlive) {
    // Spectate: chase camera behind a living teammate.
    const target = spectateTarget != null ? snapPlayers.get(spectateTarget) : null;
    if (target) {
      const backX = Math.sin(target.yaw);
      const backZ = Math.cos(target.yaw);
      camera.position.set(target.x + backX * 4.5, target.y + 2.6, target.z + backZ * 4.5);
      camera.lookAt(target.x, target.y + 1.4, target.z);
    } else {
      camera.position.set(0, 40, 0);
      camera.lookAt(0, 0, 0);
    }
  } else {
    // Lobby / intermission / ended: elevated view of the street.
    camera.position.set(0, 42, -20);
    camera.lookAt(0, 0, 10);
  }

  // HUD + minimap at ~10 Hz (cheap enough to run every frame for the HUD).
  updateHUD();
  if (now - lastMinimapDraw > 100) {
    lastMinimapDraw = now;
    drawMinimap();
  }

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.__tacticalBooted = true;
socket.connect();
// If the server never answers, say so instead of hanging silently.
setTimeout(() => {
  if (!connected && connectStatus.textContent.startsWith('Connecting')) {
    connectStatus.textContent = 'Cannot reach the game server. Is the "npm start" window still open? If yes, reload this page.';
    connectStatus.style.color = '#ff8080';
  }
}, 5000);

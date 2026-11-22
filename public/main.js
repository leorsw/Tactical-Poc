// main.js — game client for the tactical FPS POC.
//
// Vanilla Three.js (no build step). The client simulates local movement,
// raycasts shots locally and sends claims to the server, which validates
// them. HUD, minimap, lobby and spectating all live here.

import * as THREE from 'three';
import {
  HOUSES,
  GROUND_WINDOWS,
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
const teamAHeader = $('teamAHeader');
const teamBHeader = $('teamBHeader');
const joinAEl = $('joinA');
const joinBEl = $('joinB');
const teamHint = $('teamHint');
const hostControls = $('hostControls');
const startBtn = $('startBtn');
const clearRoomBtn = $('clearRoomBtn');
const kickNotice = $('kickNotice');
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
const hitmarkerEl = $('hitmarker');
const damageFlashEl = $('damageFlash');
const bannerEl = $('banner');
const continueBtn = $('continueBtn');
const downOverlay = $('downOverlay');
const downSub = $('downSub');
const spectateBar = $('spectateBar');
const lockHint = $('lockHint');
const exitSoloBtn = $('exitSoloBtn');
const endScreen = $('endScreen');
const endTitle = $('endTitle');
const endScore = $('endScore');
const endHostBtns = $('endHostBtns');
const endWait = $('endWait');
const mapBtn = $('mapBtn');
const fsBtn = $('fsBtn');
const climbBtn = $('climbBtn');
const mapOverlay = $('mapOverlay');
const mapCloseBtn = $('mapCloseBtn');
const connBanner = $('connBanner');
const fsHelp = $('fsHelp');
const fsHelpClose = $('fsHelpClose');
const mapCanvas = $('mapCanvas');
const mapCtx = mapCanvas.getContext('2d');

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------
const socket = new GameSocket();
const sfx = new Sfx();
const controls = new Controls({
  onReload: () => tryReload(),
  onMap: () => toggleMap(),
  onFullscreen: () => toggleFullscreen(),
  onClimb: () => tryClimb(),
});

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
};
let currentObjective = null; // {x, z, r} — the defenders' spawn centre this round
let lastRoundSeen = 0;
let myAlive = true;
let myHealth = 100;
let myInMag = 29;
let myMags = 5;
let reloading = false;
let reloadEndsAt = 0;
let currentWindow = null; // ground-floor window in climb range, if any
let lastFireAt = 0;
let lastMoveSent = 0;
// YOU'RE DOWN: on elimination the player sees a 3-second overlay before
// switching to spectate (or to the round/match-end UI, if the round ended).
// downUntil is a performance.now() timestamp (0 = not down). Round/match-end
// events arriving during those 3 seconds are held and shown when it ends.
let downUntil = 0;
let pendingRoundEnd = null;
let pendingMatchEnd = null;
// True when the shot message says my death was a teamkill. The shot and
// the snapshot can arrive in either order, so the flag is set by the shot
// handler and consumed by the death branch (or applied at once if the
// overlay is already up).
let killedByFriendlyFire = false;
let aimBlend = 0; // 0 = rifle lowered at the hip, 1 = aimed down the sights
let recoil = 0; // 0..1, decays after each shot
let flashUntil = 0; // performance.now() timestamp: muzzle flash visible until
let mapOpen = false;

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
// First-person rifle viewmodel (a child of the camera) + muzzle flash.
let rifle = null;
let flashMesh = null;
let impactMarker = null;

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
  scene.add(camera); // the first-person rifle is a child of the camera
  buildViewmodel();

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

  // No ground markings in the 3D world: the objective (the defenders'
  // spawn X) is shown on the map only — see drawMap.

  controls.attach(renderer.domElement, {
    joyZone: $('joyZone'),
    joyBase: $('joyBase'),
    joyKnob: $('joyKnob'),
    lookZone: $('lookZone'),
    fireBtn: $('fireBtn'),
    reloadBtn: $('reloadBtn'),
    aimBtn: $('aimBtn'),
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

// First-person rifle: abstract boxes, readable as a rifle. The barrel axis
// is the group's local -Z; the sight line sits ~0.13 above it, so the
// aimed pose puts the sights on the camera axis.
function buildViewmodel() {
  const gunmetal = new THREE.MeshLambertMaterial({ color: 0x1c1c1e });
  const gripMat = new THREE.MeshLambertMaterial({ color: 0x3a332a });
  const g = new THREE.Group();
  const add = (w, h, d, x, y, z, mat, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || gunmetal);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    g.add(m);
    return m;
  };
  add(0.07, 0.11, 0.42, 0, 0, 0); // receiver
  add(0.05, 0.05, 0.34, 0, 0.01, -0.36); // handguard
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.22, 8), gunmetal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.6);
  g.add(barrel);
  add(0.06, 0.16, 0.09, 0, -0.12, -0.05, gripMat, 0.15); // magazine
  add(0.06, 0.09, 0.14, 0, -0.01, 0.24); // stock (short: stays in front of the near plane)
  add(0.05, 0.12, 0.07, 0, -0.11, 0.14, gripMat, -0.3); // pistol grip
  // Reflex sight: a rounded-square housing with a red dot. The dot sits on
  // the sight line (local y = 0.13), so it lands on the screen centre when
  // aiming. The iron sights are gone.
  add(0.03, 0.035, 0.05, 0, 0.07, -0.08, gunmetal); // riser mount
  const roundedRect = (w, r) => {
    const s = new THREE.Path();
    s.moveTo(-w + r, -w);
    s.lineTo(w - r, -w);
    s.absarc(w - r, -w + r, r, -Math.PI / 2, 0, false);
    s.lineTo(w, w - r);
    s.absarc(w - r, w - r, r, 0, Math.PI / 2, false);
    s.lineTo(-w + r, w);
    s.absarc(-w + r, w - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(-w, -w + r);
    s.absarc(-w + r, -w + r, r, Math.PI, Math.PI * 1.5, false);
    return s;
  };
  const sightShape = new THREE.Shape(roundedRect(0.05, 0.02).getPoints(24));
  sightShape.holes.push(roundedRect(0.035, 0.012));
  const housing = new THREE.Mesh(
    new THREE.ExtrudeGeometry(sightShape, { depth: 0.025, bevelEnabled: false }),
    gunmetal
  );
  housing.position.set(0, 0.13, -0.095);
  g.add(housing);
  // Glass pane (subtle) + the red dot at the centre of the window.
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.07, 0.07),
    new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
  );
  glass.position.set(0, 0.13, -0.082);
  g.add(glass);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 16),
    new THREE.MeshBasicMaterial({ color: 0xff2222 })
  );
  dot.position.set(0, 0.13, -0.08);
  g.add(dot);
  // Muzzle flash: two crossed additive planes at the barrel tip.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffc933, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  flashMesh = new THREE.Group();
  const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), flashMat);
  const f2 = f1.clone();
  f2.rotation.z = Math.PI / 2;
  flashMesh.add(f1, f2);
  flashMesh.position.set(0, 0.01, -0.74);
  flashMesh.visible = false;
  g.add(flashMesh);
  // Hip pose (lowered): bottom-right of the view, muzzle down.
  g.position.set(0.3, -0.28, -0.5);
  g.rotation.set(-0.3, -0.12, 0);
  camera.add(g);
  rifle = g;

  // Impact marker: a small bright sphere shown briefly where a shot lands.
  impactMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95 })
  );
  impactMarker.visible = false;
  scene.add(impactMarker);
}

// Rifle poses. Hip = lowered at the hip, muzzle down. ADS = raised so the
// sight line sits on the camera axis. The stock stays in front of the
// camera near plane in both poses.
const HIP_POS = { x: 0.3, y: -0.28, z: -0.5 };
const HIP_ROT = { x: -0.3, y: -0.12, z: 0 };
const ADS_POS = { x: 0, y: -0.13, z: -0.5 };
const ADS_ROT = { x: 0, y: 0, z: 0 };

function updateViewmodel(dt, now) {
  if (!rifle) return;
  const inGame = (game.phase === 'playing' || solo) && myAlive;
  rifle.visible = inGame;
  if (!inGame) {
    aimBlend = 0;
    if (Math.abs(camera.fov - 75) > 0.05) {
      camera.fov = 75;
      camera.updateProjectionMatrix();
    }
    return;
  }
  const wantAim = controls.aiming && !reloading ? 1 : 0;
  aimBlend += (wantAim - aimBlend) * (1 - Math.exp(-dt * 10));
  recoil *= Math.exp(-dt * 9);
  rifle.position.set(
    HIP_POS.x + (ADS_POS.x - HIP_POS.x) * aimBlend,
    HIP_POS.y + (ADS_POS.y - HIP_POS.y) * aimBlend,
    HIP_POS.z + (ADS_POS.z - HIP_POS.z) * aimBlend + recoil * 0.07
  );
  rifle.rotation.set(
    HIP_ROT.x + (ADS_ROT.x - HIP_ROT.x) * aimBlend + recoil * 0.09,
    HIP_ROT.y + (ADS_ROT.y - HIP_ROT.y) * aimBlend,
    HIP_ROT.z + (ADS_ROT.z - HIP_ROT.z) * aimBlend
  );
  // Aiming narrows the field of view slightly.
  const targetFov = 75 - aimBlend * 20;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 10));
    camera.updateProjectionMatrix();
  }
  if (flashMesh && flashMesh.visible && now > flashUntil) flashMesh.visible = false;
  if (impactMarker && impactMarker.visible) {
    const age = now - (impactMarker.userData.bornAt || 0);
    if (age > 180) {
      impactMarker.visible = false;
    } else {
      impactMarker.material.opacity = 0.95 * (1 - age / 180);
    }
  }
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
  // depthTest stays on (default): a tag behind a wall is hidden by the
  // wall, like everything else. (depthTest:false made tags visible
  // through walls.)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  sprite.scale.set(2.4, 0.53, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function getPlayerMesh(id) {
  if (playerMeshes.has(id)) return playerMeshes.get(id);
  const m = meta.get(id) || {};
  const group = new THREE.Group();
  // The figure is fully black; the team shows only in the floating name tag.
  const black = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const darker = new THREE.MeshLambertMaterial({ color: 0x080808 });
  const gunmetal = new THREE.MeshLambertMaterial({ color: 0x1c1c1e });
  const add = (w, h, d, x, y, z, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  // A limb segment stretched exactly between two joints.
  const limb = (from, to, w, d, mat) => {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), mat);
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    group.add(mesh);
    return mesh;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // Legs + boots.
  add(0.17, 0.55, 0.2, -0.11, 0.28, 0, black);
  add(0.17, 0.55, 0.2, 0.11, 0.28, 0, black);
  add(0.18, 0.1, 0.32, -0.11, 0.05, -0.04, darker);
  add(0.18, 0.1, 0.32, 0.11, 0.05, -0.04, darker);
  // Torso (hittable) + vest with pouches.
  const torso = add(0.52, 0.62, 0.3, 0, 0.86, 0, black);
  torso.userData.playerId = id;
  add(0.42, 0.45, 0.06, 0, 0.88, -0.17, darker);
  add(0.12, 0.14, 0.05, -0.12, 0.82, -0.21, darker);
  add(0.12, 0.14, 0.05, 0.12, 0.82, -0.21, darker);
  // Arms: two segments each, reaching forward to hold the rifle.
  // Left hand ends under the forend; right hand ends on the pistol grip.
  limb(V(-0.3, 1.12, 0), V(-0.12, 0.98, -0.28), 0.13, 0.15, black);
  limb(V(-0.12, 0.98, -0.28), V(0.06, 0.96, -0.58), 0.11, 0.13, black);
  limb(V(0.3, 1.12, 0), V(0.28, 0.95, -0.12), 0.13, 0.15, black);
  limb(V(0.28, 0.95, -0.12), V(0.1, 0.98, -0.3), 0.11, 0.13, black);
  // Hands gripping the rifle.
  add(0.09, 0.09, 0.12, 0.06, 0.96, -0.58, darker);
  add(0.09, 0.09, 0.12, 0.1, 0.98, -0.3, darker);
  // Head (hittable, black balaclava) + helmet.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), black);
  head.position.y = 1.42;
  head.userData.playerId = id;
  group.add(head);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), darker);
  helmet.position.y = 1.46;
  group.add(helmet);
  // Rifle: receiver, barrel, magazine, stock — held forward, stock at the
  // shoulder, muzzle ahead.
  const rifleMesh = new THREE.Group();
  const rAdd = (w, h, d, x, y, z, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    rifleMesh.add(mesh);
    return mesh;
  };
  rAdd(0.07, 0.1, 0.45, 0, 0, 0, gunmetal); // receiver
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 8), gunmetal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.36);
  rifleMesh.add(barrel);
  rAdd(0.05, 0.16, 0.08, 0, -0.11, -0.02, darker); // magazine
  rAdd(0.06, 0.09, 0.16, 0, 0, 0.28, darker); // stock
  rifleMesh.position.set(0.08, 1.04, -0.3);
  rifleMesh.rotation.x = 0.05;
  group.add(rifleMesh);
  const tag = makeNameSprite(m.name || '?', TEAM_CSS[m.role] || '#ffffff');
  tag.position.y = 2.0;
  group.add(tag);
  group.userData.bodyMat = black;
  group.userData.tag = tag;
  group.userData.tagName = m.name || '?';
  group.userData.tagRole = m.role;
  scene.add(group);
  playerMeshes.set(id, group);
  shootTargets.push(torso, head);
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
    // Bodies stay black; only the name tag follows the team color, so it
    // is rebuilt when the name or the team changes.
    if (g.userData.tagName !== (m.name || '?') || g.userData.tagRole !== m.role) {
      g.remove(g.userData.tag);
      const tag = makeNameSprite(m.name || '?', TEAM_CSS[m.role] || '#ffffff');
      tag.position.y = 2.0;
      g.add(tag);
      g.userData.tag = tag;
      g.userData.tagName = m.name || '?';
      g.userData.tagRole = m.role;
    }
  }
}

// ---------------------------------------------------------------------------
// Lobby UI
// ---------------------------------------------------------------------------

// Team columns and join buttons are labelled by ROLE (ATTACKERS /
// DEFENDERS), following the host's attackers pick. Called from the state
// handler — before the joined check — so players who have not joined yet
// also see the correct join-button labels.
function updateRoleLabels(attackersTeam) {
  const setHeader = (el, team) => {
    const isAtk = attackersTeam === team;
    el.textContent = isAtk ? 'ATTACKERS' : 'DEFENDERS';
    el.className = isAtk ? 'atk' : 'def';
  };
  setHeader(teamAHeader, 'A');
  setHeader(teamBHeader, 'B');
  joinAEl.textContent = attackersTeam === 'A' ? 'Join Attackers' : 'Join Defenders';
  joinBEl.textContent = attackersTeam === 'B' ? 'Join Attackers' : 'Join Defenders';
}

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

  const aCount = byTeam.A.length;
  const bCount = byTeam.B.length;
  if (aCount === 1 || bCount === 1) {
    teamHint.textContent = '1 player per team is enough to start — 2+ per team is recommended for a good test.';
  } else {
    teamHint.textContent = `${aCount} vs ${bCount} — asymmetric splits are allowed.`;
  }
  if (soloCount > 0) {
    teamHint.textContent += ` ${soloCount} player${soloCount > 1 ? 's' : ''} exploring in solo mode.`;
  }

  const me = state.players.find((p) => p.id === myId);
  isHost = !!me && state.hostId === myId;
  hostControls.classList.toggle('hidden', !isHost);
  waitHost.classList.add('hidden'); // anyone can start now — no waiting
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
  if (name === 'lobby' && mapOpen) {
    mapOpen = false;
    mapOverlay.classList.add('hidden');
  }
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
      timerEl.textContent = 'Intermission';
    } else {
      timerEl.textContent = '—';
    }
    let atkAlive = 0;
    let defAlive = 0;
    for (const [id, s] of snapPlayers) {
      const m = meta.get(id);
      if (!m || !s.alive || m.solo) continue; // solo players are not on a team
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

  // Spectate bar (only once the 3-second YOU'RE DOWN is over).
  if (!myAlive && game.phase === 'playing' && !downUntil) {
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
// ms = null keeps the banner up until another banner replaces it (used for
// the round-end result, which stays until CONTINUE starts the next round).
function showBanner(text, ms = 4000) {
  bannerEl.textContent = text;
  bannerEl.classList.remove('hidden');
  clearTimeout(bannerTimer);
  if (ms != null) bannerTimer = setTimeout(() => bannerEl.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------------------
// On-demand map: street, houses and the objective only. No player markers
// of any kind, by design — the map shows terrain, not live positions.
// The objective is the defenders' spawn X (red), shown on the map only —
// never as a ground mark in the 3D world. It is labelled by the viewer's
// role: attackers see "לכבוש" (capture), defenders "להגן" (defend), solo
// players see the X without a label. The map is drawn when opened, and
// redrawn on round start (the objective moves with each round's draw).
// ---------------------------------------------------------------------------

function drawMap() {
  const W = mapCanvas.width;
  const H = mapCanvas.height;
  mapCtx.clearRect(0, 0, W, H);
  mapCtx.fillStyle = '#101216';
  mapCtx.fillRect(0, 0, W, H);
  const mx = (x) => ((x + 18) / 36) * W;
  const mz = (z) => ((z + 62) / 124) * H;
  // Street.
  mapCtx.fillStyle = '#3a3a3a';
  mapCtx.fillRect(mx(-6), 0, mx(6) - mx(-6), H);
  // Houses.
  mapCtx.fillStyle = '#777';
  for (const h of HOUSES) {
    mapCtx.fillRect(mx(h.x0), mz(h.z0), mx(h.x1) - mx(h.x0), mz(h.z1) - mz(h.z0));
  }
  // Objective: the defenders' spawn X only (red). The attackers' spawn
  // is not marked anywhere.
  const drawX = (wx, wz, color) => {
    const x = mx(wx);
    const y = mz(wz);
    mapCtx.strokeStyle = color;
    mapCtx.lineWidth = 3;
    mapCtx.beginPath();
    mapCtx.moveTo(x - 7, y - 7);
    mapCtx.lineTo(x + 7, y + 7);
    mapCtx.moveTo(x + 7, y - 7);
    mapCtx.lineTo(x - 7, y + 7);
    mapCtx.stroke();
  };
  if (currentObjective) {
    drawX(currentObjective.x, currentObjective.z, TEAM_CSS.defenders);
    let label = null;
    if (!solo && myTeam) label = myTeam === game.attackersTeam ? 'לכבוש' : 'להגן';
    if (label) {
      const lx = mx(currentObjective.x);
      const ly = mz(currentObjective.z) + 26;
      mapCtx.font = `bold ${Math.round(W / 26)}px system-ui, sans-serif`;
      mapCtx.textAlign = 'center';
      mapCtx.lineWidth = 4;
      mapCtx.strokeStyle = '#101216';
      mapCtx.strokeText(label, lx, ly);
      mapCtx.fillStyle = '#ffffff';
      mapCtx.fillText(label, lx, ly);
    }
  }
  // North (attackers' end) marker.
  mapCtx.fillStyle = '#cfd4da';
  mapCtx.font = `bold ${Math.round(W / 22)}px system-ui, sans-serif`;
  mapCtx.textAlign = 'center';
  mapCtx.fillText('N ↑', W / 2, W / 18);
}

function toggleMap() {
  if (gameEl.classList.contains('hidden')) return; // lobby: no map
  mapOpen = !mapOpen;
  mapOverlay.classList.toggle('hidden', !mapOpen);
  if (mapOpen) drawMap();
}

function toggleFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const p = exit && exit.call(document);
    if (p && p.catch) p.catch(() => {});
    return;
  }
  if (req) {
    const p = req.call(el);
    if (p && p.catch) p.catch(() => { fsHelp.classList.remove('hidden'); });
  } else {
    // No Fullscreen API (iPhone Safari): only Add to Home Screen works.
    fsHelp.classList.remove('hidden');
  }
}
const onFsChange = () => {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  fsBtn.textContent = fs ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

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
// Window climbing (ground floor only): vault through a nearby window,
// either direction — outside in or inside out.
// ---------------------------------------------------------------------------

// Find a ground-floor window close enough to vault through: within 1.5 m
// of the wall plane and inside the window opening along the wall.
function nearbyWindow() {
  if (local.y > 0.5) return null;
  for (const w of GROUND_WINDOWS) {
    if (w.axis === 'x') {
      if (Math.abs(local.x - w.plane) < 1.5 && Math.abs(local.z - w.center) <= w.half) return w;
    } else {
      if (Math.abs(local.z - w.plane) < 1.5 && Math.abs(local.x - w.center) <= w.half) return w;
    }
  }
  return null;
}

function tryClimb() {
  const w = currentWindow;
  if (!w) return;
  // Vault to 0.75 m past the wall plane, same spot along the wall.
  if (w.axis === 'x') local.x = w.plane + (local.x < w.plane ? 0.75 : -0.75);
  else local.z = w.plane + (local.z < w.plane ? 0.75 : -0.75);
  const fixed = resolveCollision(local.x, local.z, local.y);
  local.x = fixed.x;
  local.z = fixed.z;
  // The next move message (<=66 ms away) tells the server the new position.
}

// Shooting / reload
// ---------------------------------------------------------------------------

function tryFire(now) {
  if (!myAlive || (game.phase !== 'playing' && !solo)) return;
  if (mapOpen || reloading || myInMag <= 0) return;
  if (now - lastFireAt < FIRE_INTERVAL) return;
  lastFireAt = now;

  // Hitscan from the camera centre. Spread is wide from the hip and tight
  // when aiming down the sights.
  const spread = aimBlend > 0.5 ? 0.003 : 0.02;
  raycaster.setFromCamera(
    { x: (Math.random() - 0.5) * spread, y: (Math.random() - 0.5) * spread },
    camera
  );
  const hits = raycaster.intersectObjects(shootTargets, false);
  let targetId = null;
  if (hits.length > 0) {
    const first = hits[0].object;
    if (first.userData.playerId != null) {
      targetId = first.userData.playerId;
    } else {
      // Visible impact where the bullet lands.
      impactMarker.position.copy(hits[0].point);
      impactMarker.visible = true;
      impactMarker.material.opacity = 0.95;
      impactMarker.userData.bornAt = now;
    }
  }
  socket.send({ t: 'shot', targetId });
  sfx.shoot();
  // Firing feedback: the rifle kicks and the muzzle flashes.
  recoil = 1;
  flashUntil = now + 90;
  if (flashMesh) {
    flashMesh.visible = true;
    flashMesh.rotation.z = Math.random() * Math.PI;
    const s = 1.0 + Math.random() * 0.6;
    flashMesh.scale.set(s, s, s);
  }
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
let savedJoin = null; // { name, team } or { name, solo: true } — for auto-rejoin
socket.onOpen = () => {
  connected = true;
  connectStatus.textContent = 'Connected.';
  joinBox.classList.remove('hidden');
  connBanner.classList.add('hidden');
  // Reconnect: the server dropped the old player entry when the socket
  // closed, so rejoin with the same callsign/team.
  if (savedJoin) {
    if (savedJoin.solo) socket.send({ t: 'solo', name: savedJoin.name });
    else socket.send({ t: 'join', name: savedJoin.name, team: savedJoin.team });
  }
};
socket.onClose = () => {
  connected = false;
  connectStatus.textContent = 'Disconnected from the server. Reconnecting…';
  connBanner.classList.remove('hidden');
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
  savedJoin = null;
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

socket.on('kicked', (msg) => {
  // The host cleared the room: forget the saved join so the auto-reconnect
  // (the server closes this socket a moment later) does not rejoin, and
  // go back to the join screen with an explanation. The notice stays up
  // until the next join attempt; the connection status line is left alone
  // because the reconnect flow overwrites it.
  savedJoin = null;
  joined = false;
  solo = false;
  myTeam = null;
  downUntil = 0;
  downOverlay.classList.add('hidden');
  pendingRoundEnd = null;
  pendingMatchEnd = null;
  teamsBox.classList.add('hidden');
  joinBox.classList.remove('hidden');
  exitSoloBtn.classList.add('hidden');
  endScreen.classList.add('hidden');
  kickNotice.textContent = msg.reason || 'The host cleared the room. Rejoin to play.';
  kickNotice.classList.remove('hidden');
  showScreen('lobby');
});

socket.on('state', (msg) => {
  game.phase = msg.phase;
  game.round = msg.round;
  game.score = msg.score;
  game.attackersTeam = msg.attackersTeam;
  if (msg.objective) currentObjective = msg.objective;
  updateRoleLabels(msg.attackersTeam);
  meta = new Map(msg.players.map((p) => [p.id, p]));
  const me = meta.get(myId);
  if (me) myTeam = me.team;
  if (me && savedJoin && !savedJoin.solo) savedJoin.team = me.team;
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
  if (msg.phase === 'intermission') {
    // Reconnecting (or joining late) during an intermission: restore the
    // round result + CONTINUE button the roundEnd event already showed
    // to everyone else. Not during the 3-second YOU'RE DOWN — the held
    // roundEnd event shows it when the 3 seconds are over.
    if (msg.roundWinner && !downUntil) {
      showBanner(roundResultText(msg.roundWinner, msg.roundReason, msg.score), null);
      continueBtn.classList.remove('hidden');
    }
  } else {
    continueBtn.classList.add('hidden');
  }
});

socket.on('snapshot', (msg) => {
  game.phase = msg.phase;
  game.round = msg.round;
  game.score = msg.score;
  game.timeLeftMs = msg.timeLeftMs;
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
      // Just eliminated: show YOU'RE DOWN for 3 seconds before switching
      // to spectate (or to the round-end UI, if the round ended). A
      // teamkill adds the FRIENDLY FIRE line under it.
      downUntil = performance.now() + 3000;
      downOverlay.classList.remove('hidden');
      downSub.classList.toggle('hidden', !killedByFriendlyFire);
      killedByFriendlyFire = false;
      controls.exitLock();
      controls.firing = false;
    }
    if (!wasAlive && myAlive) {
      // Revived by a round reset: clear any pending down state.
      spectateTarget = null;
      downUntil = 0;
      downOverlay.classList.add('hidden');
      downSub.classList.add('hidden');
      killedByFriendlyFire = false;
      pendingRoundEnd = null;
      pendingMatchEnd = null;
    }
  }
  // Validate the spectate target is still alive.
  if (spectateTarget != null) {
    const t = snapPlayers.get(spectateTarget);
    if (!t || !t.alive) spectateTarget = livingTeammates()[0] ?? null;
  }
});

socket.on('shot', (msg) => {
  if (solo) return; // solo shots never hit; match shots stay out of the solo HUD
  if (msg.targetId === myId && msg.killed && msg.friendlyFire) {
    // I was teamkilled: remember it for the YOU'RE DOWN overlay. If the
    // snapshot already showed my death (overlay up), add the line now.
    killedByFriendlyFire = true;
    if (downUntil) downSub.classList.remove('hidden');
  }
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

// Shared by the roundEnd event and the intermission restore in the state
// handler, so a reconnecting player sees the same result text.
function roundResultText(winner, reason, score) {
  const winnerRole = game.attackersTeam === winner ? 'ATTACKERS' : 'DEFENDERS';
  const reasonText =
    reason === 'elimination'
      ? 'eliminated the enemy team'
      : reason === 'objective'
        ? 'reached the objective'
        : 'survived the round';
  return `${winnerRole} WIN THE ROUND\n${reasonText}\nScore: ${score.A} — ${score.B}`;
}

// Shared by the roundEnd event and the YOU'RE DOWN expiry, so a player
// eliminated at the end of a round sees the same UI, just 3 seconds later.
function showRoundEndUI(msg) {
  // Sticky banner: it stays up until CONTINUE starts the next round.
  showBanner(roundResultText(msg.winner, msg.reason, msg.score), null);
  // No CONTINUE at match end — the matchEnd screen follows with rematch.
  if (msg.score[msg.winner] < 3) continueBtn.classList.remove('hidden');
}

function showMatchEndUI(msg) {
  continueBtn.classList.add('hidden');
  const winnerRole = game.attackersTeam === msg.winner ? 'ATTACKERS' : 'DEFENDERS';
  endTitle.textContent = `${winnerRole} WIN THE MATCH`;
  endScore.textContent = `Final score: ${roleLabel('A')} ${msg.score.A} — ${msg.score.B} ${roleLabel('B')}`;
  endHostBtns.classList.remove('hidden'); // anyone can rematch now
  endWait.classList.add('hidden');
  endScreen.classList.remove('hidden');
}

socket.on('roundStart', (msg) => {
  if (solo) return;
  if (msg.objective) currentObjective = msg.objective;
  continueBtn.classList.add('hidden');
  // A new round clears any pending down state (e.g. someone pressed
  // CONTINUE during another player's 3-second YOU'RE DOWN).
  downUntil = 0;
  downOverlay.classList.add('hidden');
  downSub.classList.add('hidden');
  killedByFriendlyFire = false;
  pendingRoundEnd = null;
  pendingMatchEnd = null;
  endScreen.classList.add('hidden');
  showBanner(`ROUND ${msg.round}`, 2500);
  if (mapOpen) drawMap(); // the objective moves with each round's draw
});

socket.on('roundEnd', (msg) => {
  if (solo) return;
  // During my 3-second YOU'RE DOWN, hold the result and show it when the
  // 3 seconds are over instead of cutting the overlay short.
  if (downUntil) {
    pendingRoundEnd = msg;
    return;
  }
  showRoundEndUI(msg);
});

socket.on('matchEnd', (msg) => {
  if (solo) return;
  if (downUntil) {
    pendingMatchEnd = msg;
    return;
  }
  showMatchEndUI(msg);
});

// ---------------------------------------------------------------------------
// Lobby buttons
// ---------------------------------------------------------------------------

function join(team) {
  sfx.ensure();
  kickNotice.classList.add('hidden');
  const name = nameInput.value.trim() || `Player${myId ?? ''}`;
  savedJoin = { name, team };
  socket.send({ t: 'join', name, team });
}

$('joinA').addEventListener('click', () => join('A'));
$('joinB').addEventListener('click', () => join('B'));
$('joinAuto').addEventListener('click', () => join(null));
$('soloBtn').addEventListener('click', () => {
  sfx.ensure();
  kickNotice.classList.add('hidden');
  const name = nameInput.value.trim() || `Player${myId ?? ''}`;
  savedJoin = { name, solo: true };
  socket.send({ t: 'solo', name });
});
exitSoloBtn.addEventListener('click', () => socket.send({ t: 'leaveSolo' }));
$('switchBtn').addEventListener('click', () => {
  socket.send({ t: 'switchTeam', team: myTeam === 'A' ? 'B' : 'A' });
});
$('atkA').addEventListener('click', () => socket.send({ t: 'setAttackers', team: 'A' }));
$('atkB').addEventListener('click', () => socket.send({ t: 'setAttackers', team: 'B' }));
$('startBtn').addEventListener('click', () => socket.send({ t: 'start' }));
// Clear room needs two clicks: the first arms it (4s window), the second
// sends. Kicking everyone is destructive; a stray tap must not do it.
let clearArmed = false;
let clearArmTimer = null;
function disarmClear() {
  clearArmed = false;
  clearTimeout(clearArmTimer);
  clearRoomBtn.textContent = 'Clear room — kick everyone else';
  clearRoomBtn.classList.remove('armed');
}
clearRoomBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true;
    clearRoomBtn.textContent = 'Click again to kick everyone';
    clearRoomBtn.classList.add('armed');
    clearTimeout(clearArmTimer);
    clearArmTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  socket.send({ t: 'clearRoom' });
});
continueBtn.addEventListener('click', () => {
  socket.send({ t: 'continue' });
  // The round starts right after; the state handler re-shows the button
  // if the room is still in intermission.
  continueBtn.classList.add('hidden');
});
$('rematchBtn').addEventListener('click', () => socket.send({ t: 'rematch', swap: false }));
$('swapBtn').addEventListener('click', () => socket.send({ t: 'rematch', swap: true }));
mapBtn.addEventListener('click', () => toggleMap());
mapOverlay.addEventListener('click', () => toggleMap());
mapCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMap(); });
fsBtn.addEventListener('click', () => toggleFullscreen());
climbBtn.addEventListener('click', () => tryClimb());
fsHelpClose.addEventListener('click', () => fsHelp.classList.add('hidden'));
fsHelp.addEventListener('click', () => fsHelp.classList.add('hidden'));
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join(null);
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

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
    // Name tags are teammates-only: the enemy team sees no tag at all.
    // (Solo players have no team, so they neither show nor see tags.)
    const m = meta.get(id);
    const isTeammate = !solo && myTeam != null && !!m && !m.solo && m.team === myTeam;
    if (g.userData.tag) g.userData.tag.visible = isTeammate;
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

  // Window climb button: visible only while alive in-game near a
  // ground-floor window.
  currentWindow = ((game.phase === 'playing' || solo) && myAlive) ? nearbyWindow() : null;
  climbBtn.classList.toggle('hidden', !currentWindow);

  // YOU'RE DOWN expiry: after 3 seconds, switch to spectate (round still
  // going) or show the held round/match-end UI (round ended during the 3s).
  if (downUntil && now >= downUntil) {
    downUntil = 0;
    downOverlay.classList.add('hidden');
    if (pendingRoundEnd) {
      const msg = pendingRoundEnd;
      pendingRoundEnd = null;
      showRoundEndUI(msg);
    }
    if (pendingMatchEnd) {
      const msg = pendingMatchEnd;
      pendingMatchEnd = null;
      showMatchEndUI(msg);
    }
    if (game.phase === 'playing' && !myAlive) {
      spectateTarget = livingTeammates()[0] ?? null;
    }
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
      // Aiming down the sights slows movement.
      const speed = SPEED * (1 - aimBlend * 0.35) * Math.min(1, len);
      vx = (vx / len) * speed;
      vz = (vz / len) * speed;
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
  } else if (!myAlive && downUntil) {
    // YOU'RE DOWN: frozen first-person view at the death spot, no input.
    // Takes precedence over the spectate and elevated views.
    camera.position.set(local.x, local.y + EYE_HEIGHT, local.z);
    camera.rotation.set(local.pitch, local.yaw, 0);
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

  updateHUD();
  updateViewmodel(dt, now);

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

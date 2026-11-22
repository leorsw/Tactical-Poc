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
const mapBtn = $('mapBtn');
const fsBtn = $('fsBtn');
const mapOverlay = $('mapOverlay');
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

  // Objective: marked on the road only — a filled disc + ring, no tall
  // pillar, so it cannot be seen from across the map.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(OBJECTIVE.r, 40),
    new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.22, side: THREE.DoubleSide })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(OBJECTIVE.x, 0.02, OBJECTIVE.z);
  scene.add(disc);
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
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
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
// On-demand map: street, houses and the objective only. No player markers
// of any kind, by design — the map shows terrain, not live positions.
// The map is static, so it is drawn once when opened.
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
  // Objective diamond.
  mapCtx.fillStyle = '#ffcc00';
  const ox = mx(OBJECTIVE.x);
  const oy = mz(OBJECTIVE.z);
  mapCtx.beginPath();
  mapCtx.moveTo(ox, oy - 8);
  mapCtx.lineTo(ox + 7, oy);
  mapCtx.lineTo(ox, oy + 8);
  mapCtx.lineTo(ox - 7, oy);
  mapCtx.closePath();
  mapCtx.fill();
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
  const done = (p) => { if (p && p.catch) p.catch(() => {}); };
  if (document.fullscreenElement) done(document.exitFullscreen());
  else done(document.documentElement.requestFullscreen());
}
document.addEventListener('fullscreenchange', () => {
  fsBtn.textContent = document.fullscreenElement ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
});

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
  endHostBtns.classList.remove('hidden'); // anyone can rematch now
  endWait.classList.add('hidden');
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
mapBtn.addEventListener('click', () => toggleMap());
mapOverlay.addEventListener('click', () => toggleMap());
fsBtn.addEventListener('click', () => toggleFullscreen());
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

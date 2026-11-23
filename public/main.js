// main.js — game client for the tactical FPS POC.
//
// Vanilla Three.js (no build step). The client simulates local movement,
// raycasts shots locally and sends claims to the server, which validates
// them. HUD, minimap, lobby and spectating all live here.

import * as THREE from 'three';
import {
  HOUSES,
  GROUND_WINDOWS,
  climbFadeAt,
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
const joinAutoEl = $('joinAuto');
const joinBlockedNotice = $('joinBlockedNotice');
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
const captureBar = $('captureBar');
const captureLabel = $('captureLabel');
const captureFill = $('captureFill');
const roundInfo = $('roundInfo');
const healthFill = $('healthFill');
const healthText = $('healthText');
const ammoText = $('ammoText');
const reloadArrowFill = $('reloadArrowFill'); // SVG rect inside the reload arrow
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
const endStats = $('endStats');
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
// One stable id per tab session (survives reloads, NOT shared between
// tabs): the server uses it to recognise a reconnecting tab and take over
// its old record instead of duplicating the player.
let tabSessionId = null;
try {
  tabSessionId = sessionStorage.getItem('tacticalSessionId');
  if (!tabSessionId) {
    tabSessionId = crypto.randomUUID
      ? crypto.randomUUID()
      : `s${Date.now()}${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('tacticalSessionId', tabSessionId);
  }
} catch {
  tabSessionId = `s${Date.now()}${Math.random().toString(36).slice(2)}`;
}
// Send a join/solo message, tagged with this tab's session id.
function sendJoin(join) {
  if (join.solo) socket.send({ t: 'solo', name: join.name, session: tabSessionId });
  else socket.send({ t: 'join', name: join.name, team: join.team, session: tabSessionId });
}
let meta = new Map(); // playerId -> {name, team, role, commander, host}
let npcMeta = new Map(); // npcId -> {name, team, role} — the solo NPC never appears in state, so its name/team come from snapshots
let snapPlayers = new Map(); // playerId -> latest snapshot entry
let game = {
  phase: 'lobby',
  round: 0,
  score: { A: 0, B: 0 },
  attackersTeam: 'A',
  timeLeftMs: 0,
  captureProgress: 0, // 0..1 while an attacker holds the objective zone
};
let currentObjective = null; // {x, z, r} — the defenders' spawn centre this round
let currentAttackersSpawn = null; // {x, z} — the attackers' spawn centre this round
let lastRoundSeen = 0;
let myAlive = true;
let myHealth = 100;
let myInMag = 29;
let myMags = 5;
let reloading = false;
let reloadEndsAt = 0;
let currentWindow = null; // ground-floor window in climb range, if any
// Window climb: 1.5 s to cross from one side of the wall to the other.
// The position interpolates from climbFrom to climbTo (0.75 m past the
// wall plane); viewers see the figure fade into the wall and out the
// other side (climbFadeAt in map.js). No screen fade.
let climbing = false;
let climbStartAt = 0;
let climbFrom = null; // {x, z} where the climb started
let climbTo = null;   // {x, z} 0.75 m past the wall plane
const CLIMB_MS = 1500;
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
let crouchBlend = 0; // 0 = standing eye height, 1 = crouched (eye 0.35 m lower)
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
    new THREE.MeshLambertMaterial({ color: 0x8b6f47 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  shootTargets.push(ground);

  const street = new THREE.Mesh(
    new THREE.PlaneGeometry(12.6, 126),
    new THREE.MeshLambertMaterial({ color: 0x1e1e1e })
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
  // spawn X) is shown on the map only — see drawMap. A visible ring +
  // beam was built and removed at Lior's request (22/11/2026): the zone
  // stays hidden in the world; the 30 s capture hold is what makes the
  // round ending legible instead.

  controls.attach(renderer.domElement, {
    joyZone: $('joyZone'),
    joyBase: $('joyBase'),
    joyKnob: $('joyKnob'),
    lookZone: $('lookZone'),
    fireBtn: $('fireBtn'),
    reloadArrow: $('reloadArrow'),
    aimBtn: $('aimBtn'),
    crouchBtn: $('crouchBtn'),
  });
  if (controls.isTouch) document.body.classList.add('touch');
  $('lookZone').addEventListener('click', () => {
    // On mobile, tapping the look area while spectating cycles the target.
    if (!myAlive && game.phase === 'playing') cycleSpectate();
  });

  // Keep the renderer glued to the live container size. On iOS Safari the
  // canvas can get stuck at a transitional size (e.g. sized during a
  // rotation, when the container briefly reports ~2x the landscape height)
  // and no second resize ever corrects it — the game then renders zoomed
  // with its centre below the screen, so the rifle vanishes under the
  // bottom edge and only the sight peeks out when aiming (23/11/2026).
  // Re-syncing from several signals makes any transient self-heal.
  const syncRendererSize = () => {
    if (!renderer || !camera) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const cv = renderer.domElement;
    if (cv.style.width !== `${w}px` || cv.style.height !== `${h}px`) {
      renderer.setSize(w, h);
    }
  };
  window.__syncRendererSize = syncRendererSize; // for the render loop
  window.addEventListener('resize', syncRendererSize);
  window.addEventListener('orientationchange', () => {
    // iOS fires this before the new layout settles — re-read twice.
    setTimeout(syncRendererSize, 300);
    setTimeout(syncRendererSize, 1000);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncRendererSize);
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncRendererSize).observe(container);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncRendererSize();
  });
  // ?debug=1 — a tiny readout of the sizes that decide where the rifle
  // renders (container / canvas / viewport / camera aspect). Off by default.
  if (new URLSearchParams(location.search).has('debug')) {
    const d = document.createElement('div');
    d.id = 'sizeDebug';
    d.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:99;background:rgba(0,0,0,0.75);color:#0f0;font:11px monospace;padding:4px 6px;border-radius:4px;pointer-events:none;white-space:pre;';
    document.body.appendChild(d);
    window.__sizeDebug = d;
  }
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
  const gunmetal = new THREE.MeshLambertMaterial({ color: 0x414741 });
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
  for (const g of playerMeshes.values()) {
    const u = g.userData;
    if (u.flash && u.flash.visible && now > (u.flashUntil || 0)) u.flash.visible = false;
  }
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

// --- Tactical poses ---------------------------------------------------------
// The soldier is a small joint hierarchy: hips -> thigh -> knee -> shin,
// waist -> torso -> shoulder -> elbow -> forearm, plus a neck pivot and a
// rifle group that follows the upper body. The body is an oval torso with
// capsule limbs — no sharp corners anywhere — connected by pivots. A pose is a set of joint angles;
// every frame each mesh lerps its current angles toward its target pose
// (~0.2 s), so transitions are smooth, and the walk swing adds on top of
// the hip/knee angles.
//
// Sign conventions (rotation.x; forward = -Z). Verified against three.js
// (2026-11-23): the spine/head/rifle signs were documented backwards
// before — the comments below are the true behaviour.
//   hip +x swings the leg forward; knee -x bends the shin back (a natural
//   knee bend); elbow +x bends the forearm forward (a natural elbow bend);
//   spine -x leans the upper body FORWARD (top toward -Z); +x leans it back.
//   headX -x pitches the head forward/down (toward the stock); +x tilts it
//   back (chin up). rifleRX +x raises the muzzle; -x lowers it.
// The shoulder also has a twist (shY, rotation.y): it orients the elbow
// hinge so the forearm can swing inward to the grip — without it the
// trigger hand can't reach the pistol grip with a natural tucked elbow
// (best 3-DOF miss was 10.7 cm with the elbow crossed to the centreline).
// Arm angles for the rifle-up poses were IK-solved (ik-solve.mjs) so both
// hands land exactly on the grips at the raised rifle height; the old
// hand-tuned angles missed the grips by 44-50 cm (hands floating beside
// the rifle) — a big part of why the hold looked unrealistic.
const POSES = {
  // Rifle low across the chest, muzzle raised, slight bend in the knees.
  ready: {
    bodyDrop: 0, spine: 0.06, headX: 0,
    hipL: 0.05, hipR: -0.05, kneeL: -0.08, kneeR: -0.08, hipLz: 0, hipRz: 0,
    shLx: 0.45, shLy: 0, shLz: -0.2, elLx: 1.0,
    shRx: 0.35, shRy: 0, shRz: 0.15, elRx: 1.1,
    rifleY: 0.47, rifleZ: -0.3, rifleRX: 0.3,
  },
  // Rifle shouldered at eye level, cheek on the stock, head pitched
  // forward onto the stock, deep forward lean, deep athletic crouch
  // (front foot forward, back foot on its toe), narrow stance. The
  // barrel stays level: rifleRX cancels the spine lean (world pitch =
  // spine + rifleRX). The rifle sits high — its top edge tucks under
  // the head, as in Lior's approved illustration — so the stock is
  // partly hidden behind the head from the side.
  aim: {
    bodyDrop: -0.07, spine: -0.3, headX: -0.12,
    hipL: 0.65, hipR: -0.25, kneeL: -0.95, kneeR: -0.45, hipLz: 0, hipRz: 0,
    shLx: 1.57, shLy: 0.11, shLz: 0.69, elLx: 0.34,
    shRx: 0.99, shRy: 0.36, shRz: -0.81, elRx: 2.01,
    rifleY: 0.78, rifleZ: -0.3, rifleRX: 0.3,
  },
  // Deep one-knee kneel (left foot forward, right knee down), rifle up —
  // the front thigh goes just past horizontal so the body drops low.
  // Same hold as aim: rifle at eye level, hands on the grips.
  kneel: {
    bodyDrop: -0.33, spine: -0.12, headX: -0.06,
    hipL: 1.65, hipR: -0.5, kneeL: -1.65, kneeR: -1.07, hipLz: 0, hipRz: 0,
    shLx: 1.57, shLy: 0.11, shLz: 0.69, elLx: 0.34,
    shRx: 0.99, shRy: 0.36, shRz: -0.81, elRx: 2.01,
    rifleY: 0.78, rifleZ: -0.3, rifleRX: 0.12,
  },
  // Crouch-walk: knees bent, feet slightly apart (a small straddle),
  // rifle up. Upright enough to read as walking, not a squat.
  // Same hold as aim: rifle at eye level, hands on the grips.
  crouchWalk: {
    bodyDrop: -0.07, spine: -0.14, headX: -0.06,
    hipL: 0.55, hipR: 0.55, kneeL: -0.95, kneeR: -0.95, hipLz: -0.15, hipRz: 0.15,
    shLx: 1.57, shLy: 0.11, shLz: 0.69, elLx: 0.34,
    shRx: 0.99, shRy: 0.36, shRz: -0.81, elRx: 2.01,
    rifleY: 0.78, rifleZ: -0.3, rifleRX: 0.14,
  },
};
const POSE_KEYS = Object.keys(POSES.ready);

function getPlayerMesh(id) {
  if (playerMeshes.has(id)) return playerMeshes.get(id);
  const m = meta.get(id) || npcMeta.get(id) || {};
  const group = new THREE.Group();
  // The figure is dark grey-green; the team shows only in the floating name tag.
  const body = new THREE.MeshLambertMaterial({ color: 0x535c54 });
  const darker = new THREE.MeshLambertMaterial({ color: 0x3e443e });
  const gunmetal = new THREE.MeshLambertMaterial({ color: 0x414741 });
  const add = (parent, w, h, d, x, y, z, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  // Hips group: drops when crouching/kneeling so the feet stay planted.
  const hips = new THREE.Group();
  hips.position.y = 0.605;
  group.add(hips);

  // Legs: thigh hangs from the hip pivot, shin + boot from the knee pivot.
  // Legs are 10% longer than the original build (thigh 0.31 + shin 0.30
  // = 0.605): the figure stands taller, and the kneel drops lower.
  // Limbs are capsules, not boxes — rounded ends, no sharp corners, so the
  // whole body reads oval. (Capsule total = length + 2 * radius.)
  const mkLeg = (x) => {
    const hip = new THREE.Group();
    hip.position.set(x, 0, 0);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.14, 4, 10), body);
    thigh.position.set(0, -0.155, 0);
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.set(0, -0.31, 0);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.14, 4, 10), body);
    shin.position.set(0, -0.15, 0);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.32), darker);
    boot.position.set(0, -0.30, -0.04);
    knee.add(shin, boot);
    hip.add(knee);
    hips.add(hip);
    return { hip, knee, boot };
  };
  const legL = mkLeg(-0.11);
  const legR = mkLeg(0.11);

  // Upper body: pivots at the waist so poses can lean the torso. Y values
  // below are relative to the waist (0.605) — absolute heights are 0.055 higher than before.
  const upper = new THREE.Group();
  hips.add(upper);
  // Torso (hittable): an oval — a sphere squashed front-to-back — instead
  // of a box, so the body reads round from every angle. Same bounding box
  // as the old 0.52 x 0.62 x 0.3 box. The vest plate sits against the curve
  // (its back edge sinks into the torso at the centre) and the pouches sit
  // on the plate.
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.31, 12, 10), body);
  torso.scale.set(0.84, 1.0, 0.48);
  torso.position.set(0, 0.31, 0);
  torso.userData.playerId = id;
  upper.add(torso);
  add(upper, 0.42, 0.45, 0.06, 0, 0.33, -0.13, darker);
  add(upper, 0.12, 0.14, 0.05, -0.12, 0.27, -0.155, darker);
  add(upper, 0.12, 0.14, 0.05, 0.12, 0.27, -0.155, darker);

  // Arms: shoulder pivot -> upper arm -> elbow pivot -> forearm + hand.
  const mkArm = (side) => { // side: -1 left, +1 right
    const shoulder = new THREE.Group();
    shoulder.position.set(0.3 * side, 0.57, 0);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), body);
    shoulder.add(cap);
    const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.19, 4, 10), body);
    upperArm.position.set(0, -0.16, 0);
    shoulder.add(upperArm);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.32, 0);
    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.19, 4, 10), body);
    forearm.position.set(0, -0.15, 0);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), darker);
    hand.position.set(0, -0.31, -0.01);
    elbow.add(forearm, hand);
    shoulder.add(elbow);
    upper.add(shoulder);
    return { shoulder, elbow };
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  // Head (hittable): a plain round head, no helmet — the silhouette stays
  // readable at distance without extra detail.
  const neck = new THREE.Group();
  neck.position.set(0, 0.82, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), body);
  head.position.y = 0.05;
  head.userData.playerId = id;
  neck.add(head);
  upper.add(neck);

  // Rifle: receiver, barrel, magazine, stock — held forward, stock at the
  // shoulder, muzzle ahead. A child of the upper body so it follows the
  // lean; each pose sets its exact height.
  const rifleMesh = new THREE.Group();
  const rAdd = (w, h, d, x, y, z, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    rifleMesh.add(mesh);
    return mesh;
  };
  rAdd(0.07, 0.1, 0.45, 0, 0, 0, gunmetal); // receiver
  // Barrel (0.225, half of the 0.45 tried before — Lior found the long
  // barrel too prominent): total rifle length ~0.83 with stock+receiver.
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.225, 8), gunmetal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.3225);
  rifleMesh.add(barrel);
  rAdd(0.05, 0.16, 0.08, 0, -0.11, -0.02, darker); // magazine
  rAdd(0.06, 0.09, 0.16, 0, 0, 0.28, darker); // stock
  rifleMesh.position.set(0.08, 0.47, -0.3);
  rifleMesh.rotation.x = 0.3;
  upper.add(rifleMesh);
  // Muzzle flash for this player's shots, seen by everyone else: two
  // crossed additive planes at the muzzle, hidden until a 'shot' event
  // shows them for 90 ms (same shape as the first-person flash).
  const pFlashMat = new THREE.MeshBasicMaterial({
    color: 0xffc933, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const pFlash = new THREE.Group();
  const pf1 = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), pFlashMat);
  const pf2 = pf1.clone();
  pf2.rotation.z = Math.PI / 2;
  pFlash.add(pf1, pf2);
  pFlash.position.set(0, 0.01, -0.47);
  pFlash.visible = false;
  rifleMesh.add(pFlash);

  const tag = makeNameSprite(m.name || '?', TEAM_CSS[m.role] || '#ffffff');
  tag.position.y = 1.45;
  upper.add(tag);

  group.userData.bodyMat = body;
  group.userData.darkerMat = darker;
  group.userData.gunmetalMat = gunmetal;
  group.userData.fadeOpacity = 1;
  group.userData.tag = tag;
  group.userData.tagName = m.name || '?';
  group.userData.tagRole = m.role;
  group.userData.flash = pFlash;
  group.userData.flashUntil = 0;
  group.userData.hips = hips;
  group.userData.upper = upper;
  group.userData.legL = legL.hip;
  group.userData.legR = legR.hip;
  group.userData.kneeL = legL.knee;
  group.userData.kneeR = legR.knee;
  group.userData.bootL = legL.boot;
  group.userData.bootR = legR.boot;
  group.userData.armL = armL;
  group.userData.armR = armR;
  group.userData.neck = neck;
  group.userData.rifle = rifleMesh;
  group.userData.poseCur = { ...POSES.ready };
  group.userData.walkPhase = 0; // advances with distance travelled
  group.userData.walkAmp = 0;   // eases in/out so the legs never snap
  scene.add(group);
  playerMeshes.set(id, group);
  shootTargets.push(torso, head);
  return group;
}

// Set a soldier mesh's opacity (window-climb fade). The materials go
// transparent only while fading — at opacity 1 they are opaque again,
// so normal rendering (sorting, depth) is untouched. The name tag fades
// with the body. Skips redundant writes: at rest every mesh sits at 1.
function setMeshFade(g, opacity) {
  const u = g.userData;
  if (u.fadeOpacity === opacity) return;
  u.fadeOpacity = opacity;
  const transparent = opacity < 1;
  for (const mat of [u.bodyMat, u.darkerMat, u.gunmetalMat]) {
    mat.transparent = transparent;
    mat.depthWrite = !transparent;
    mat.opacity = opacity;
  }
  if (u.tag) {
    u.tag.material.transparent = true;
    u.tag.material.opacity = opacity;
  }
}

// Lerp one mesh's joints toward its target pose, then add the walk swing on
// top of the hip/knee angles. Called every frame for every visible mesh.
function applyPose(g, target, dt, walkPhase, walkAmp) {
  const u = g.userData;
  const k = 1 - Math.exp(-dt * 10); // ~0.2 s to settle
  const cur = u.poseCur;
  for (const key of POSE_KEYS) cur[key] += (target[key] - cur[key]) * k;
  u.hips.position.y = 0.605 + cur.bodyDrop;
  u.upper.rotation.x = cur.spine;
  u.neck.rotation.x = cur.headX;
  const swing = Math.sin(walkPhase) * walkAmp;
  const norm = walkAmp / 0.55;
  u.legL.rotation.x = cur.hipL + swing;
  u.legR.rotation.x = cur.hipR - swing;
  u.legL.rotation.z = cur.hipLz;
  u.legR.rotation.z = cur.hipRz;
  // The knee bends while its leg swings forward, then straightens as the
  // foot plants — the forward step reads as a step, not a stiff swing.
  u.kneeL.rotation.x = cur.kneeL - Math.max(0, Math.sin(walkPhase)) * 0.5 * norm;
  u.kneeR.rotation.x = cur.kneeR - Math.max(0, -Math.sin(walkPhase)) * 0.5 * norm;
  // Boots stay flat on the ground: counter-rotate each boot by its leg's
  // static pose angles, so a bent knee doesn't tilt the foot (in the aim
  // pose the back boot used to stab toe-first into the floor at 40°).
  // Only the pose angles are cancelled — the walk swing still rocks the
  // boot with the step, as a real foot does.
  u.bootL.rotation.x = -(cur.hipL + cur.kneeL);
  u.bootR.rotation.x = -(cur.hipR + cur.kneeR);
  u.armL.shoulder.rotation.x = cur.shLx;
  u.armL.shoulder.rotation.y = cur.shLy;
  u.armL.shoulder.rotation.z = cur.shLz;
  u.armL.elbow.rotation.x = cur.elLx;
  u.armR.shoulder.rotation.x = cur.shRx;
  u.armR.shoulder.rotation.y = cur.shRy;
  u.armR.shoulder.rotation.z = cur.shRz;
  u.armR.elbow.rotation.x = cur.elRx;
  u.rifle.position.y = cur.rifleY;
  u.rifle.position.z = cur.rifleZ;
  u.rifle.rotation.x = cur.rifleRX;
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
    const m = meta.get(id) || npcMeta.get(id) || {};
    // Bodies stay grey-green; only the name tag follows the team color, so it
    // is rebuilt when the name or the team changes.
    if (g.userData.tagName !== (m.name || '?') || g.userData.tagRole !== m.role) {
      g.userData.upper.remove(g.userData.tag);
      const tag = makeNameSprite(m.name || '?', TEAM_CSS[m.role] || '#ffffff');
      tag.position.y = 1.45;
      g.userData.upper.add(tag);
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

  // Reload progress: the arrow fills right-to-left over the 3.5 s reload.
  // The arrow spans x 6..204 in its SVG viewBox; the fill rect is anchored
  // at the right edge and grows left as the reload progresses. On desktop
  // the arrow is hidden (touch UI) and only RELOADING… shows.
  if (reloading) {
    reloadText.classList.remove('hidden');
    const total = 3500;
    const left = Math.max(0, reloadEndsAt - performance.now());
    const p = 1 - left / total; // 0..1
    reloadArrowFill.setAttribute('x', String(204 - p * 198));
    reloadArrowFill.setAttribute('width', String(p * 198));
    if (left <= 0) reloading = false;
  } else {
    reloadText.classList.add('hidden');
    reloadArrowFill.setAttribute('x', '204');
    reloadArrowFill.setAttribute('width', '0');
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

  // Objective capture progress bar. The bar is visible while an
  // attacker holds the zone; attackers see it as their own capture,
  // defenders as a warning.
  const cp = game.captureProgress || 0;
  if (!solo && game.phase === 'playing' && cp > 0) {
    const iAmAttacker = myTeam != null && myTeam === game.attackersTeam;
    captureLabel.textContent = iAmAttacker
      ? 'CAPTURING THE OBJECTIVE…'
      : '⚠ ENEMY CAPTURING THE OBJECTIVE';
    captureBar.classList.toggle('danger', !iAmAttacker);
    captureFill.style.width = `${Math.round(cp * 100)}%`;
    captureBar.classList.remove('hidden');
  } else {
    captureBar.classList.add('hidden');
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
// On-demand map: street, houses, house numbers and the two spawn marks.
// No player markers of any kind, by design — the map shows terrain, not
// live positions. The objective is the defenders' spawn X (red), shown on
// the map only — never as a ground mark in the 3D world. It is labelled
// by the viewer's role: attackers see "לכבוש" (capture), defenders "להגן"
// (defend), solo players see the X without a label. The attackers' spawn
// is a blue X (no label). The map is drawn when opened, and redrawn on
// round start (both marks move with each round's draw).
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
  // House numbers, centred in each house (odd east / even west, 1..10).
  mapCtx.save();
  mapCtx.font = `bold ${Math.round(W / 24)}px system-ui, sans-serif`;
  mapCtx.textAlign = 'center';
  mapCtx.textBaseline = 'middle';
  mapCtx.lineWidth = 4;
  mapCtx.strokeStyle = '#101216';
  mapCtx.fillStyle = '#ffffff';
  for (const h of HOUSES) {
    const label = String(h.number);
    mapCtx.strokeText(label, mx(h.cx), mz(h.cz));
    mapCtx.fillText(label, mx(h.cx), mz(h.cz));
  }
  mapCtx.restore();
  // Spawn marks: the objective (defenders' spawn, red X) and the
  // attackers' spawn (blue X). Neither is marked in the 3D world.
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
  if (currentAttackersSpawn) {
    drawX(currentAttackersSpawn.x, currentAttackersSpawn.z, TEAM_CSS.attackers);
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
  if (climbing) return;
  const w = currentWindow;
  if (!w) return;
  // End point: 0.75 m past the wall plane, same spot along the wall,
  // collision-resolved so the landing is never inside solid geometry.
  // The loop interpolates from the current position to it over 1.5 s.
  let tx = local.x;
  let tz = local.z;
  if (w.axis === 'x') tx = w.plane + (local.x < w.plane ? 0.75 : -0.75);
  else tz = w.plane + (local.z < w.plane ? 0.75 : -0.75);
  const fixed = resolveCollision(tx, tz, local.y);
  climbing = true;
  climbStartAt = performance.now();
  climbFrom = { x: local.x, z: local.z };
  climbTo = { x: fixed.x, z: fixed.z };
}

// Shooting / reload
// ---------------------------------------------------------------------------

function tryFire(now) {
  if (!myAlive || (game.phase !== 'playing' && !solo)) return;
  if (climbing) return; // frozen mid-climb
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
  if (climbing) return; // frozen mid-climb
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
let lastRejoinRetry = 0; // throttle for the state-handler rejoin retry
socket.onOpen = () => {
  connected = true;
  connectStatus.textContent = 'Connected.';
  joinBox.classList.remove('hidden');
  connBanner.classList.add('hidden');
  // Reconnect: the server dropped the old player entry when the socket
  // closed, so rejoin with the same callsign/team.
  if (savedJoin) sendJoin(savedJoin);
};
socket.onClose = () => {
  connected = false;
  connectStatus.textContent = 'Disconnected from the server. Reconnecting…';
  connBanner.classList.remove('hidden');
};

// Heartbeat: tell the server we're alive every 10 seconds, in every
// state (lobby, playing, spectating, solo) — so a dead connection is
// noticed and the player is removed (and may rejoin within the grace
// window) instead of lingering as a ghost.
setInterval(() => {
  if (connected) socket.send({ t: 'ping' });
}, 10000);

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
  // A join error means this connection is NOT in the room (e.g. a rejoin
  // rejected mid-match because the old record is still active). Don't
  // stay stuck on the game screen: go back to the lobby. The saved join
  // is kept, so the state handler retries the rejoin below.
  if (joined) {
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
    showScreen('lobby');
  }
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
  if (msg.attackersSpawn) currentAttackersSpawn = msg.attackersSpawn;
  updateRoleLabels(msg.attackersTeam);
  meta = new Map(msg.players.map((p) => [p.id, p]));
  const me = meta.get(myId);
  if (me) myTeam = me.team;
  if (me && savedJoin && !savedJoin.solo) savedJoin.team = me.team;
  refreshMeshColors();
  // Drop meshes for players who left.
  for (const id of [...playerMeshes.keys()]) {
    if (!meta.has(id) && !npcMeta.has(id)) removePlayerMesh(id);
  }
  // Join availability for players who have not joined yet: while a
  // match is in progress (playing, or the intermission between rounds),
  // newcomers cannot join — the lobby shows the wait message and the
  // join buttons stay disabled. Joins open again when the match ends
  // ('ended', for the rematch) or the room returns to the lobby. Solo
  // mode is unaffected. (Runs before the `!joined` return below — the
  // server sends state to waiting sockets too.)
  const joinBlocked = msg.phase === 'playing' || msg.phase === 'intermission';
  joinBlockedNotice.classList.toggle('hidden', !joinBlocked);
  joinAEl.disabled = joinBlocked;
  joinBEl.disabled = joinBlocked;
  joinAutoEl.disabled = joinBlocked;
  if (!joined) {
    // A returning player whose rejoin was rejected (old record still in
    // the room, grace not open yet) retries on state updates, at most
    // once per 2 s: the server accepts once the old record goes silent
    // (ghost takeover) or is swept (grace entry), or the match ends.
    // Newcomers have no savedJoin, so they never retry.
    if (savedJoin && connected && Date.now() - lastRejoinRetry > 2000) {
      lastRejoinRetry = Date.now();
      sendJoin(savedJoin);
    }
    return;
  }
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
  game.captureProgress = msg.captureProgress || 0;
  snapPlayers = new Map(msg.players.map((p) => [p.id, p]));
  // NPC entries (the solo defender dummy) carry their own name/team —
  // they never appear in state messages, so meta never knows them.
  for (const [id, s] of snapPlayers) {
    if (s.npc) npcMeta.set(id, { name: s.name || 'NPC', team: s.team || 'B', role: 'defenders' });
  }
  for (const id of [...npcMeta.keys()]) {
    if (!snapPlayers.has(id)) {
      npcMeta.delete(id);
      removePlayerMesh(id);
    }
  }

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
      // Just eliminated. The pointer lock is released either way; the
      // YOU'RE DOWN overlay shows only while the round is still going.
      // On the final kill the server broadcasts roundEnd/matchEnd
      // synchronously, but the death snapshot goes out on the next tick —
      // so the round/match-end UI may already own the screen when this
      // snapshot arrives, and showing the overlay then would cover the
      // banner (or the stats table) for 3 seconds. Found by the
      // screenshot run (22/11/2026).
      controls.exitLock();
      controls.firing = false;
      if (msg.phase === 'playing') {
        downUntil = performance.now() + 3000;
        downOverlay.classList.remove('hidden');
        downSub.classList.toggle('hidden', !killedByFriendlyFire);
      }
      killedByFriendlyFire = false;
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
  // Another player's shot: a flash on their rifle and a bang, quieter
  // with distance. This runs for everyone, including solo players
  // watching the NPC — it is world feedback, not HUD. (My own shots
  // already flashed and sounded locally when I fired.)
  if (msg.shooterId !== myId) {
    const g = playerMeshes.get(msg.shooterId);
    if (g && g.userData.flash) {
      g.userData.flash.visible = true;
      g.userData.flash.rotation.z = Math.random() * Math.PI;
      g.userData.flashUntil = performance.now() + 90;
    }
    const s = snapPlayers.get(msg.shooterId);
    let vol = 0.5;
    if (s) vol = Math.max(0.12, 1 - Math.hypot(s.x - local.x, s.z - local.z) / 60);
    sfx.shoot(vol);
  }
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
        ? 'captured the objective'
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
  // The round-end banner is sticky — hide it, or it overlaps the
  // match-end screen (and the stats table) underneath it.
  bannerEl.classList.add('hidden');
  const winnerRole = game.attackersTeam === msg.winner ? 'ATTACKERS' : 'DEFENDERS';
  endTitle.textContent = `${winnerRole} WIN THE MATCH`;
  endScore.textContent = `Final score: ${roleLabel('A')} ${msg.score.A} — ${msg.score.B} ${roleLabel('B')}`;
  // Match stats table (server-sorted by kills, then damage). Names are
  // user input, so they are escaped before going into innerHTML.
  const stats = Array.isArray(msg.stats) ? msg.stats : [];
  if (stats.length > 0) {
    const rows = stats.map((s) => {
      const acc = s.accuracy == null ? '—' : `${s.accuracy}%`;
      const cls = s.role === 'attackers' ? 'atk' : 'def';
      return `<tr><td class="${cls}">${escapeHtml(s.name)}</td><td>${s.kills}</td><td>${s.deaths}</td><td>${s.teamkills}</td><td>${acc}</td><td>${s.damage}</td><td>${s.captures}</td></tr>`;
    }).join('');
    endStats.innerHTML = `<table><thead><tr><th>Player</th><th>K</th><th>D</th><th>TK</th><th>Acc</th><th>Dmg</th><th>Cap</th></tr></thead><tbody>${rows}</tbody></table>`;
    endStats.classList.remove('hidden');
  } else {
    endStats.innerHTML = '';
    endStats.classList.add('hidden');
  }
  endHostBtns.classList.remove('hidden'); // anyone can rematch now
  endWait.classList.add('hidden');
  endScreen.classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

socket.on('roundStart', (msg) => {
  if (solo) return;
  if (msg.objective) currentObjective = msg.objective;
  if (msg.attackersSpawn) currentAttackersSpawn = msg.attackersSpawn;
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
  sendJoin(savedJoin);
}

$('joinA').addEventListener('click', () => join('A'));
$('joinB').addEventListener('click', () => join('B'));
$('joinAuto').addEventListener('click', () => join(null));
$('soloBtn').addEventListener('click', () => {
  sfx.ensure();
  kickNotice.classList.add('hidden');
  const name = nameInput.value.trim() || `Player${myId ?? ''}`;
  savedJoin = { name, solo: true };
  sendJoin(savedJoin);
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
let lastSizeSync = 0;

function loop() {
  requestAnimationFrame(loop);
  if (!threeReady) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();

  // Backstop: re-sync the renderer size twice a second, so a canvas stuck
  // at a stale size (iOS rotation) heals even if no event fires.
  // Time-based, not frame-based: a throttled tab still heals promptly.
  if (now - lastSizeSync > 500) {
    lastSizeSync = now;
    window.__syncRendererSize?.();
    const dbg = window.__sizeDebug;
    if (dbg && renderer && camera) {
      const c = $('scene-container');
      const cv = renderer.domElement;
      dbg.textContent =
        `container ${c.clientWidth}x${c.clientHeight}\n` +
        `canvas ${cv.style.width} x ${cv.style.height} (buf ${cv.width}x${cv.height})\n` +
        `inner ${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}\n` +
        `aspect ${camera.aspect.toFixed(3)} fov ${camera.fov.toFixed(1)} aim ${aimBlend.toFixed(2)}`;
    }
  }

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
    const m = meta.get(id) || npcMeta.get(id);
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
    // Window-climb fade: a figure passing through a window merges with
    // the wall (fades out at the plane, back in on the other side).
    // Purely positional, from the interpolated position — see
    // climbFadeAt in map.js.
    setMeshFade(g, climbFadeAt(g.position.x, g.position.z));
    // Pose + walk animation: pick the pose from the snapshot flags, lerp
    // the joints toward it, and swing the legs from the distance actually
    // travelled (interpolated, so teleports and snapshot jitter don't
    // flail them).
    const u = g.userData;
    if (u.legL && u.legR) {
      const dx = g.position.x - (u.prevX ?? g.position.x);
      const dz = g.position.z - (u.prevZ ?? g.position.z);
      u.prevX = g.position.x;
      u.prevZ = g.position.z;
      const dist = Math.min(Math.hypot(dx, dz), 0.25);
      const speed = dt > 0 ? dist / dt : 0;
      const moving = speed > 0.4;
      // Crouching reads as a one-knee kneel when still, a low crouch-walk
      // when moving; aiming raises the rifle; otherwise the ready stance.
      let poseName = 'ready';
      if (s.crouch) poseName = moving ? 'crouchWalk' : 'kneel';
      else if (s.aiming) poseName = 'aim';
      const targetAmp = moving ? (s.crouch ? 0.3 : 0.55) : 0;
      u.walkAmp += (targetAmp - u.walkAmp) * (1 - Math.exp(-dt * 8));
      if (moving) u.walkPhase += (dist / 1.1) * Math.PI; // one step per ~1.1 m
      applyPose(g, POSES[poseName], dt, u.walkPhase, u.walkAmp);
    }
  }

  // Window climb button: visible only while alive in-game near a
  // ground-floor window.
  currentWindow = ((game.phase === 'playing' || solo) && myAlive) ? nearbyWindow() : null;
  climbBtn.classList.toggle('hidden', !currentWindow || climbing);

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
    // Crouch blends the eye height down smoothly (no snap on toggle).
    crouchBlend += ((controls.crouch ? 1 : 0) - crouchBlend) * (1 - Math.exp(-dt * 10));
    // Look still works mid-climb (the camera crosses the wall with the
    // player); movement, fire and reload are frozen (see below, tryFire,
    // tryReload). The look deltas are consumed either way.
    const look = controls.takeLook();
    local.yaw -= look.dx * 0.0023;
    local.pitch -= look.dy * 0.0023;
    local.pitch = Math.max(-1.45, Math.min(1.45, local.pitch));

    // Move — or, mid-climb, the scripted crossing: 1.5 s from climbFrom
    // to climbTo with no collision (the path crosses the wall by design).
    if (climbing) {
      const t = Math.min((now - climbStartAt) / CLIMB_MS, 1);
      const s = t * t * (3 - 2 * t); // smoothstep: slow ends, fastest mid-wall
      local.x = climbFrom.x + (climbTo.x - climbFrom.x) * s;
      local.z = climbFrom.z + (climbTo.z - climbFrom.z) * s;
      if (t >= 1) climbing = false;
    } else {
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
        // Aiming down the sights slows movement; crouching slows it more.
        const speed = SPEED * (1 - aimBlend * 0.35) * (controls.crouch ? 0.45 : 1) * Math.min(1, len);
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
    }

    camera.position.set(local.x, local.y + EYE_HEIGHT - crouchBlend * 0.35, local.z);
    camera.rotation.set(local.pitch, local.yaw, 0);

    // Fire while holding.
    if (controls.firing) tryFire(now);

    // Send movement ~15/sec. The stance flags ride along so other players
    // see the pose (kneel / aim); aiming uses the smoothed ADS blend so a
    // half-second ADS flicker doesn't flap the pose.
    if (now - lastMoveSent >= MOVE_SEND_MS) {
      lastMoveSent = now;
      socket.send({ t: 'move', x: local.x, y: local.y, z: local.z, yaw: local.yaw, pitch: local.pitch,
        aiming: aimBlend > 0.5, crouch: controls.crouch });
    }
  } else if (!myAlive && downUntil) {
    // YOU'RE DOWN: frozen first-person view at the death spot, no input.
    // Takes precedence over the spectate and elevated views.
    camera.position.set(local.x, local.y + EYE_HEIGHT - crouchBlend * 0.35, local.z);
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

  // A mid-climb death or round end cancels the climb (the position stays
  // where it is — the next round's spawn resets it). Runs outside the
  // movement block so a mid-climb death still clears the flag.
  if (climbing && !(myAlive && (game.phase === 'playing' || solo))) climbing = false;

  updateHUD();
  updateViewmodel(dt, now);

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.__tacticalBooted = true;
window.__tacticalLocal = local; // debug/test hook: the local player's position
window.__tacticalMeshes = playerMeshes; // debug/test hook: remote player meshes by id
document.getElementById('boot')?.remove(); // inline splash done its job
socket.connect();
// If the server never answers, say so instead of hanging silently.
setTimeout(() => {
  if (!connected && connectStatus.textContent.startsWith('Connecting')) {
    connectStatus.textContent = 'Cannot reach the game server. Is the "npm start" window still open? If yes, reload this page.';
    connectStatus.style.color = '#ff8080';
  }
}, 5000);

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
  WALL_COLOR,
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
const adminLoginRow = $('adminLoginRow');
const adminCodeInput = $('adminCodeInput');
const adminLoginBtn = $('adminLoginBtn');
const adminError = $('adminError');
const adminPanel = $('adminPanel');
const adminPlayerRows = $('adminPlayerRows');
const adminGrenadeBtn = $('adminGrenadeBtn');
const prepToggleBtn = $('prepToggleBtn');
const roundDurationInput = $('roundDurationInput');
const scoreBox = $('scoreBox');
const timerEl = $('timer');
const aliveBox = $('aliveBox');
const emptyCaption = $('emptyCaption');
const captureBar = $('captureBar');
const captureLabel = $('captureLabel');
const captureFill = $('captureFill');
const roundInfo = $('roundInfo');
const healthIcon = $('healthIcon');
const ammoText = $('ammoText');
const magIcons = $('magIcons');
// One magazine icon: a magazine outline with a baseplate, white
// stroke on transparent (the red state is applied by CSS, see style.css).
// Magazine icons are Lior's own images, inlined as data URLs (26/11/2026:
// the GitHub push route cannot carry binary files — a base64 push
// arrives double-encoded — so the PNGs live in the code, not in
// public/icons/. mag-red is the same outline recoloured #e53333 for the
// loaded mag when it is empty). (26/11/2026, changes list item 8.)
const MAG_IMG = '<img src="data:image/png;base64,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" alt="">';
const MAG_IMG_RED = '<img src="data:image/png;base64,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" alt="">';
function renderMagIcons() {
  // One icon per magazine, spares + the loaded one: rifleman/marksman start
  // with 6, gunner with 3. The LAST icon is the loaded magazine — it turns
  // red when it empties, until a reload; the reload consumes a spare icon
  // and the red clears. When the last magazine empties it simply stays red
  // (and NO AMMO shows next to it). Rebuilds only when the count/red state
  // changed (this runs every frame). (Lior, 25/11/2026.)
  const total = myMags + 1; // spares + loaded
  const red = myInMag === 0;
  const out = red && myMags === 0; // last magazine empty: red icon + NO AMMO
  const key = `${total}:${red}:${out}`;
  if (magIcons.dataset.key === key) return;
  magIcons.dataset.key = key;
  magIcons.classList.remove('hidden');
  magIcons.innerHTML = Array.from({ length: total }, (_, i) =>
    `<span class="magIcon${red && i === total - 1 ? ' red' : ''}">${red && i === total - 1 ? MAG_IMG_RED : MAG_IMG}</span>`).join('');
  if (out) {
    ammoText.classList.remove('hidden');
    ammoText.textContent = 'NO AMMO';
    ammoText.style.color = '#e53333';
  } else {
    ammoText.classList.add('hidden');
  }
}
const reloadArrowFill = $('reloadArrowFill'); // SVG rect inside the reload arrow
const reloadText = $('reloadText');
const damageFlashEl = $('damageFlash');
const bannerEl = $('banner');
const continueBtn = $('continueBtn');
const downOverlay = $('downOverlay');
const downSub = $('downSub');
const spectateBar = $('spectateBar');
const lockHint = $('lockHint');
const exitSoloBtn = $('exitSoloBtn');
const exitBtn = $('exitBtn');
const specExitBtn = $('specExitBtn');
const specRecBtn = $('specRecBtn');
const specActionBtn = $('specActionBtn');
const recPanel = $('recPanel');
const recInfo = $('recInfo');
const recDownloadBtn = $('recDownloadBtn');
const recShareBtn = $('recShareBtn');
const recShareNote = $('recShareNote');
const recCloseBtn = $('recCloseBtn');
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
  onGrenade: () => startGrenadeArm(),
});

let myId = null;
let myClass = 'rifleman'; // my class: rifleman | marksman | gunner
let joined = false;
let solo = false;
let spectating = false; // bird's-eye admin view: no figure, no weapon (Lior, 26/11/2026)
let specX = 0; // bird's-eye pan target (drag pans the view along the street)
let specZ = 0;
let myTeam = null;
let isHost = false;
let amAdmin = false; // set from the state (me.admin) — the admin runs the match
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
  if (join.solo) socket.send({ t: 'solo', name: join.name, cls: join.cls || 'rifleman', grenades: join.grenades !== false, session: tabSessionId });
  else socket.send({ t: 'join', name: join.name, team: join.team, session: tabSessionId });
}
// Solo class picker (Lior, 25/11/2026): solo players choose their own
// class in the lobby; team players get theirs from the admin.
let soloClass = 'rifleman';
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
  prepActive: false,
  prepMsLeft: 0,
};
let currentObjective = null; // {x, z, r} — the defenders' spawn centre this round
let currentAttackersSpawn = null; // {x, z} — the attackers' spawn centre this round
let lastRoundSeen = 0;
let myAlive = true;
let myHealth = 100;
let myInMag = 29;
let myMags = 5;
let myGrenades = 2; // grenades left this round (Lior, 25/11/2026)
let soloGrenades = true; // solo toggle: add grenades to my solo mode
let grenadeArming = null; // { endsAt } while a grenade button fills (1.5 s)
let localThrowAt = 0; // my own throw, for the viewmodel dip
const grenadeMeshes = new Map(); // id -> flying/landed grenade mesh
const activeExplosions = []; // { mesh, bornAt } expanding blast visuals
let reloading = false;
let reloadEndsAt = 0;
let myReloadMs = 3500; // this class's reload time (gunner: 5000)
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
const FALL_MS = 600; // a fallen figure takes 0.6 s to hit the ground (and to stand back up)
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
let crouchBlend = 0; // 0 = standing eye height, 1 = crouched (eye lower)
const CROUCH_EYE_DROP = 0.5; // 0.5 m — standing eye 1.70, kneel eye 1.20.
// The player is 1.8 m tall (Lior, 25/11/2026), so the drop is significant;
// the kneel pose deepens to match (bodyDrop -0.50).
// the kneel leg angles re-solved so the feet stay planted.
const CROUCH_WALK_LIMIT_MS = 2000; // crouch-walking limit (Lior, 25/11/2026)
let crouchWalkMs = 0; // continuous crouch-walking time; resets on stop/stand
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
let sightReflex = null; // rounded-square housing + red dot (rifleman/gunner)
let sightScope = null; // circular housing + thin red cross (marksman)
let rifleBody = null; // first-person standard rifle body
let lmgBody = null; // first-person LMG body (gunner)
let impactMarker = null;

// ---------------------------------------------------------------------------
// Texture atlas (Lior, 26/11/2026): one canvas holds the wall look — grey
// concrete blocks with peeling beige plaster and weathering — so houses
// read as detailed without adding a single draw call. One tile covers
// 4 m x 4 m in the world; the pattern is seamless, so it can repeat
// across any wall segment. (The approved look, illustration v4: the grey
// design stays, only texture is added — no door, the game has none.)
// ---------------------------------------------------------------------------
const WALL_TILE_M = 4;
function makeWallAtlasTexture() {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  // Base: the same grey as the flat walls (the look stays grey).
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, S, S);
  // Concrete block courses (0.25 m rows, 0.5 m blocks, running bond).
  const course = S / 16; // 64 px = 0.25 m
  const block = S / 8;   // 128 px = 0.5 m
  ctx.strokeStyle = 'rgba(70,70,70,0.7)';
  ctx.lineWidth = 3;
  for (let r = 0; r < 16; r++) {
    const y = r * course;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke();
    const off = (r % 2) * block / 2;
    for (let c = -1; c < 9; c++) {
      const x = c * block + off;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + course); ctx.stroke();
    }
  }
  // Speckle noise (concrete grain).
  for (let i = 0; i < 5000; i++) {
    const v = 120 + Math.floor(Math.random() * 60);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.04 + Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // Peeling beige plaster: small irregular torn-edge blobs (a few per
  // tile — the grey blocks stay dominant, as in illustration v4). The
  // edge wobbles smoothly (low-frequency sine + tiny noise) so the patch
  // reads as torn plaster, not a star. Each blob is drawn at 9 wrapped
  // offsets so the tile stays seamless.
  const blob = (cx, cy, rx, ry) => {
    const pts = [];
    const n = 24;
    const ph1 = Math.random() * Math.PI * 2;
    const ph2 = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = 0.8 + 0.18 * Math.sin(2 * a + ph1) + 0.12 * Math.sin(3 * a + ph2) + (Math.random() - 0.5) * 0.08;
      pts.push([cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr]);
    }
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x + dx, y + dy); else ctx.lineTo(x + dx, y + dy); });
      ctx.closePath();
      ctx.fillStyle = '#c8b490';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,120,80,0.7)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  };
  blob(220, 260, 150, 115);
  blob(700, 180, 130, 100);
  blob(480, 620, 160, 120);
  blob(830, 720, 120, 130);
  blob(120, 820, 100, 85);
  // Weathering: vertical streaks, full height (seamless).
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S;
    const w = 6 + Math.random() * 22;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, 'rgba(50,50,50,0)');
    grad.addColorStop(0.5, `rgba(50,50,50,${0.05 + Math.random() * 0.09})`);
    grad.addColorStop(1, 'rgba(50,50,50,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, w, S);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

// Road texture (Lior, 26/11/2026 — approved after a player-view preview):
// procedural asphalt, full road width (12.6 m) x 4 m, tiled along the
// street. Same approach as the wall atlas: one canvas texture, no new
// draw calls. No markings on the road, so it can't be confused with
// game markers (the red/blue X).
function makeRoadTexture() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 324;
  const x = cv.getContext('2d');
  const W = 1024, H = 324;
  const rnd = (a, b) => a + Math.random() * (b - a);
  x.fillStyle = '#232323';
  x.fillRect(0, 0, W, H);
  // Soft blotches — kept in the middle band so none is cut by the
  // top/bottom tile edge (a cut blotch would show the seam).
  for (let i = 0; i < 46; i++) {
    const gx = rnd(0, W), gy = rnd(110, H - 110), r = rnd(30, 100);
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
    const light = Math.random() < 0.5;
    g.addColorStop(0, light ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(gx - r, gy - r, r * 2, r * 2);
  }
  // Wheel-wear bands: two lanes (centres x=256 / 768), two tracks each.
  for (const bx of [191, 321, 703, 833]) {
    for (let k = 0; k < 3; k++) {
      x.fillStyle = 'rgba(0,0,0,0.05)';
      x.fillRect(bx - 23 + rnd(-6, 6), 0, 46, H);
    }
    x.fillStyle = 'rgba(255,255,255,0.025)';
    x.fillRect(bx - 23, 0, 46, H);
  }
  // Patches: jittered polygons, fully inside the tile.
  function patch(cx, cy, w, h, fill) {
    x.beginPath();
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = cx + Math.cos(a) * w / 2 * rnd(0.7, 1.25);
      const py = cy + Math.sin(a) * h / 2 * rnd(0.7, 1.25);
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.closePath();
    x.fillStyle = fill;
    x.fill();
    x.strokeStyle = 'rgba(0,0,0,0.35)';
    x.lineWidth = 2;
    x.stroke();
  }
  patch(300, 90, 260, 90, 'rgba(28,28,28,0.55)');
  patch(760, 240, 200, 80, 'rgba(43,43,43,0.5)');
  // Cracks: random walks, kept 20 px from the top/bottom edges.
  function crack(sx, sy) {
    x.beginPath();
    x.moveTo(sx, sy);
    let px = sx, py = sy;
    for (let i = 0; i < 14; i++) {
      px += rnd(-26, 26);
      py += rnd(4, 18);
      if (py > H - 20) break;
      x.lineTo(px, py);
    }
    x.strokeStyle = 'rgba(0,0,0,0.5)';
    x.lineWidth = 2;
    x.stroke();
  }
  crack(120, 30);
  crack(620, 24);
  crack(900, 40);
  // Speckle, wrapped top-to-bottom so the tile seams are invisible.
  for (let i = 0; i < 6000; i++) {
    const dx = rnd(0, W), dy = rnd(0, H);
    const light = Math.random() < 0.5;
    x.fillStyle = light ? `rgba(255,255,255,${rnd(0.05, 0.16)})` : `rgba(0,0,0,${rnd(0.08, 0.2)})`;
    const s = rnd(0.6, 1.8);
    x.fillRect(dx, dy, s, s);
    if (dy < 3) x.fillRect(dx, dy + H, s, s);
    if (dy > H - 3) x.fillRect(dx, dy - H, s, s);
  }
  // Worn darker edges where the road meets the dirt.
  let eg = x.createLinearGradient(0, 0, 40, 0);
  eg.addColorStop(0, 'rgba(0,0,0,0.28)');
  eg.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = eg;
  x.fillRect(0, 0, 40, H);
  eg = x.createLinearGradient(W, 0, W - 40, 0);
  eg.addColorStop(0, 'rgba(0,0,0,0.28)');
  eg.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = eg;
  x.fillRect(W - 40, 0, 40, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 32); // one tile per 4 m along the 126 m street
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

// Scale a BoxGeometry's UVs so the atlas tiles every WALL_TILE_M metres
// in the world (consistent pattern scale on every wall segment, whatever
// its size). BoxGeometry lays its 6 faces out as 4 vertices each, in the
// order +x, -x, +y, -y, +z, -z.
function scaleBoxUVs(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const faces = [
    [d, h], [d, h], // +x, -x: width = depth, height = height
    [w, d], [w, d], // +y, -y: width = width, height = depth
    [w, h], [w, h], // +z, -z: width = width, height = height
  ];
  for (let f = 0; f < 6; f++) {
    const su = faces[f][0] / WALL_TILE_M;
    const sv = faces[f][1] / WALL_TILE_M;
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
}

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
    new THREE.MeshLambertMaterial({ map: makeRoadTexture() })
  );
  street.rotation.x = -Math.PI / 2;
  street.position.y = 0;
  scene.add(street);
  shootTargets.push(street);

  // Houses (walls with door/window gaps, slabs, roofs). Walls use the
  // atlas texture (plaster + blocks + weathering, 26/11/2026); slabs,
  // floors and roofs stay flat colours.
  const wallMat = new THREE.MeshLambertMaterial({ map: makeWallAtlasTexture() });
  const materials = {};
  for (const b of visualBoxes()) {
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    const d = b.z1 - b.z0;
    let mesh;
    if (b.color === WALL_COLOR) {
      const geo = new THREE.BoxGeometry(w, h, d);
      scaleBoxUVs(geo, w, h, d);
      mesh = new THREE.Mesh(geo, wallMat);
    } else {
      if (!materials[b.color]) {
        materials[b.color] = new THREE.MeshLambertMaterial({ color: b.color });
      }
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials[b.color]);
    }
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
    controls.fireQueued = false;
    controls.fireHeld = false; // a gunner holding FIRE must not resume firing on his own after a blur
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
  // Two rifle bodies, switched by class in updateViewmodel (like the
  // sights): the standard rifle and the gunner's LMG (Lior, 26/11/2026).
  rifleBody = new THREE.Group();
  lmgBody = new THREE.Group();
  const add = (w, h, d, x, y, z, mat, rx = 0, target = rifleBody) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || gunmetal);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    target.add(m);
    return m;
  };
  // Standard rifle body.
  add(0.07, 0.11, 0.42, 0, 0, 0); // receiver
  add(0.05, 0.05, 0.34, 0, 0.01, -0.36); // handguard
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.22, 8), gunmetal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.6);
  rifleBody.add(barrel);
  add(0.06, 0.16, 0.09, 0, -0.12, -0.05, gripMat, 0.15); // magazine
  add(0.06, 0.09, 0.14, 0, -0.01, 0.24); // stock (short: stays in front of the near plane)
  add(0.05, 0.12, 0.07, 0, -0.11, 0.14, gripMat, -0.3); // pistol grip
  // Gunner's LMG body: thicker receiver and barrel, big box magazine,
  // carry handle, short bipod legs under the barrel. (The full deployed
  // bipod lives on the third-person figure; in first person the legs
  // stay short so they never block the sight picture.)
  add(0.09, 0.12, 0.5, 0, 0, 0, gunmetal, 0, lmgBody); // receiver
  const lmgBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), gunmetal);
  lmgBarrel.rotation.x = Math.PI / 2;
  lmgBarrel.position.set(0, 0.01, -0.62);
  lmgBody.add(lmgBarrel);
  add(0.1, 0.17, 0.13, 0, -0.12, -0.05, gripMat, 0.15, lmgBody); // box magazine
  add(0.04, 0.035, 0.28, 0, 0.078, -0.02, gunmetal, 0, lmgBody); // carry handle
  add(0.07, 0.09, 0.14, 0, -0.01, 0.24, gunmetal, 0, lmgBody); // stock
  add(0.05, 0.12, 0.07, 0, -0.11, 0.14, gripMat, -0.3, lmgBody); // pistol grip
  {
    // Short bipod legs under the barrel (mount at y -0.06, z -0.32).
    const mount = new THREE.Vector3(0, -0.06, -0.32);
    const leg = (foot) => {
      const dir = new THREE.Vector3().subVectors(foot, mount);
      const len = dir.length();
      const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 6), gunmetal);
      legMesh.position.copy(mount).addScaledVector(dir, 0.5);
      legMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      lmgBody.add(legMesh);
    };
    leg(new THREE.Vector3(-0.1, -0.24, -0.4));
    leg(new THREE.Vector3(0.1, -0.24, -0.4));
  }
  g.add(rifleBody);
  g.add(lmgBody);
  // Sights — two variants, switched by class in updateViewmodel:
  // rifleman/gunner: rounded-square reflex housing with a red dot;
  // marksman: circular housing with a thin red cross (Lior, 26/11/2026).
  // Both sit on the sight line (local y = 0.13), so they land on the screen
  // centre when aiming. The iron sights are gone.
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
  // --- reflex sight (rifleman / gunner) ---
  sightReflex = new THREE.Group();
  const sightShape = new THREE.Shape(roundedRect(0.05, 0.02).getPoints(24));
  sightShape.holes.push(roundedRect(0.035, 0.012));
  const housing = new THREE.Mesh(
    new THREE.ExtrudeGeometry(sightShape, { depth: 0.025, bevelEnabled: false }),
    gunmetal
  );
  housing.position.set(0, 0.13, -0.095);
  sightReflex.add(housing);
  // Glass pane (subtle) + the red dot at the centre of the window.
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.07, 0.07),
    new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
  );
  glass.position.set(0, 0.13, -0.082);
  sightReflex.add(glass);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 16),
    new THREE.MeshBasicMaterial({ color: 0xff2222 })
  );
  dot.position.set(0, 0.13, -0.08);
  sightReflex.add(dot);
  g.add(sightReflex);
  // --- marksman scope: circular housing + thin red cross ---
  sightScope = new THREE.Group();
  const scopeShape = new THREE.Shape();
  scopeShape.absarc(0, 0, 0.05, 0, Math.PI * 2, false);
  const scopeHole = new THREE.Path();
  scopeHole.absarc(0, 0, 0.035, 0, Math.PI * 2, true);
  scopeShape.holes.push(scopeHole);
  const scopeHousing = new THREE.Mesh(
    new THREE.ExtrudeGeometry(scopeShape, { depth: 0.025, bevelEnabled: false }),
    gunmetal
  );
  scopeHousing.position.set(0, 0.13, -0.095);
  sightScope.add(scopeHousing);
  const scopeGlass = new THREE.Mesh(
    new THREE.CircleGeometry(0.035, 24),
    new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
  );
  scopeGlass.position.set(0, 0.13, -0.082);
  sightScope.add(scopeGlass);
  const crossMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
  const crossV = new THREE.Mesh(new THREE.PlaneGeometry(0.0025, 0.03), crossMat);
  crossV.position.set(0, 0.13, -0.08);
  sightScope.add(crossV);
  const crossH = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.0025), crossMat);
  crossH.position.set(0, 0.13, -0.08);
  sightScope.add(crossH);
  g.add(sightScope);
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
  // The sight follows the class: the marksman gets the circular scope with
  // the thin red cross, the other classes keep the reflex dot (26/11/2026).
  if (sightReflex) sightReflex.visible = myClass !== 'marksman';
  if (sightScope) sightScope.visible = myClass === 'marksman';
  // The rifle body follows the class too: the gunner carries an LMG
  // (26/11/2026) — and the flash moves to its longer muzzle.
  if (rifleBody) rifleBody.visible = myClass !== 'gunner';
  if (lmgBody) lmgBody.visible = myClass === 'gunner';
  if (flashMesh) flashMesh.position.z = myClass === 'gunner' ? -0.8 : -0.74;
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
  // My own grenade throw: the rifle dips down and back over 0.6 s
  // (Lior, 25/11/2026).
  const throwT = localThrowAt ? (now - localThrowAt) / 600 : 1;
  if (throwT < 1) {
    const dip = Math.sin(Math.PI * throwT);
    rifle.position.y -= dip * 0.18;
    rifle.position.z += dip * 0.1;
  } else if (localThrowAt) {
    localThrowAt = 0;
  }
  // Aiming narrows the field of view slightly — the marksman's scope
  // magnifies x4 (FOV 22 at full aim, vs 55 for the other classes).
  const adsFov = myClass === 'marksman' ? 22 : 55;
  const targetFov = 75 - aimBlend * (75 - adsFov);
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

// --- On-body name (Lior, 25/11/2026) --------------------------------------
// The player's name printed ON the body — forehead (front of the head) and
// upper back, like a jersey name, in the team colour, teammates-only like
// the floating tag. It is a curved texture patch hugging the geometry,
// NOT a flat floating plane: a sphere segment just above the head sphere
// and one above the torso ellipsoid, using the same canvas-texture
// technique as the tag. The patch is invisible except where the letters
// are (transparent canvas), follows the head/torso pivots, and wraps away
// naturally when seen from the side.
//   SphereGeometry parametrisation (three.js): phi is the horizontal angle
//   (z = r·sin(phi)·sin(theta)), so the front (-Z) is phi=-PI/2 and the
//   back (+Z) is phi=+PI/2; theta is measured from the top (+Y).
function makeBodyNameTexture(name, colorCss, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const text = name.slice(0, 16);
  // Fit the font to the canvas (Lior, 25/11/2026): the name spreads almost
  // to the edges of the patch, and the size follows the name's length — a
  // short name is drawn much bigger than a long one. Start from the tallest
  // font that fits the height, then shrink until the width fits too.
  const maxW = w * 0.92, maxH = h * 0.88;
  let size = Math.floor(maxH);
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) size = Math.max(8, Math.floor(size * maxW / tw));
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Dark outline so the team colour reads on the dark body.
  ctx.lineWidth = Math.max(4, size / 10);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, w / 2, h / 2 + 2);
  ctx.fillStyle = colorCss;
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function makeBodyNamePatch(name, colorCss, opts) {
  const tex = makeBodyNameTexture(name, colorCss, opts.canvasW, opts.canvasH);
  const geo = new THREE.SphereGeometry(opts.radius, 16, 10,
    opts.phiCenter - opts.phiLength / 2, opts.phiLength,
    opts.thetaStart, opts.thetaLength);
  // Lambert, like the body — the patch shades with the figure. Transparent
  // so only the letters show; depthWrite off so its transparent texels
  // never occlude the body behind them.
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  if (opts.scale) mesh.scale.set(opts.scale[0], opts.scale[1], opts.scale[2]);
  mesh.position.set(opts.position[0], opts.position[1], opts.position[2]);
  mesh.renderOrder = 2; // above the opaque body, below the tag sprite (10)
  return mesh;
}

// (Re)build a figure's head + back name patches. NPCs and solo players get
// none — nobody can see them (teammates-only, and solo players have no
// team). Called from getPlayerMesh and from refreshMeshColors on name/team
// change, next to the tag rebuild.
function rebuildBodyNamePatches(id, g) {
  const u = g.userData;
  const m = meta.get(id) || npcMeta.get(id) || {};
  for (const key of ['headPatch', 'backPatch']) {
    if (u[key]) {
      if (u[key].parent) u[key].parent.remove(u[key]);
      u[key].geometry.dispose();
      if (u[key].material.map) u[key].material.map.dispose();
      u[key].material.dispose();
      u[key] = null;
    }
  }
  u.patchMats = [];
  if (npcMeta.has(id) || m.solo) return;
  const color = TEAM_CSS[m.role] || '#ffffff';
  const name = m.name || '?';
  // Head: sphere r 0.21 -> patch at 0.215, forehead band (theta 40-80 deg
  // from the top), 109 deg arc around the front (-Z) so the name spreads
  // wide across the head (Lior, 25/11/2026). The canvas is 384 wide to
  // match the patch aspect (~2.4:1) so the letters don't stretch.
  const head = makeBodyNamePatch(name, color, {
    radius: 0.215, phiCenter: -Math.PI / 2, phiLength: 1.9,
    thetaStart: 0.7, thetaLength: 0.7,
    canvasW: 384, canvasH: 160, position: [0, 0.05, 0],
  });
  // Back: torso ellipsoid (r 0.31, scale 0.84/1.0/0.48) -> patch at 0.315
  // with the same scale, back band (theta 34-92 deg), 126 deg arc around
  // the back (+Z) so the name spreads edge to edge across the back
  // (Lior, 25/11/2026). The band is tall so the letters themselves are big;
  // the canvas is 512x256 to match the patch aspect (~2:1) so the letters
  // don't stretch.
  const back = makeBodyNamePatch(name, color, {
    radius: 0.315, scale: [0.84, 1.0, 0.48], phiCenter: Math.PI / 2, phiLength: 2.2,
    thetaStart: 0.6, thetaLength: 1.0,
    canvasW: 512, canvasH: 256, position: [0, 0.31, 0],
  });
  u.neck.add(head);
  u.upper.add(back);
  u.headPatch = head;
  u.backPatch = back;
  u.patchMats = [head.material, back.material];
  u.patchName = name;
  u.patchRole = m.role;
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
    bodyDrop: -0.09, spine: -0.3, headX: -0.12,
    hipL: 0.65, hipR: -0.25, kneeL: -0.95, kneeR: -0.45, hipLz: 0, hipRz: 0,
    shLx: 1.57, shLy: 0.11, shLz: 0.69, elLx: 0.34,
    shRx: 0.99, shRy: 0.36, shRz: -0.81, elRx: 2.01,
    rifleY: 0.78, rifleZ: -0.3, rifleRX: 0.3,
  },
  // Deep one-knee kneel (left foot forward, right knee down), rifle up —
  // the front thigh goes just past horizontal so the body drops low.
  // Same hold as aim: rifle at eye level, hands on the grips.
  // bodyDrop -0.50 (was -0.38): the player is 1.8 m tall (Lior,
  // 25/11/2026) — hips 0.885 -> 0.385, eye 1.70 -> 1.20, a 0.5 m drop.
  // The leg angles were re-solved by FK (kneel-fk.mjs) for the longer
  // legs so the front foot stays planted (1.67/-1.99) and the back knee
  // stays on the ground (-0.56/-1.01, it slides 2 cm back).
  kneel: {
    bodyDrop: -0.50, spine: -0.12, headX: -0.06,
    hipL: 1.67, hipR: -0.56, kneeL: -1.99, kneeR: -1.01, hipLz: 0, hipRz: 0,
    shLx: 1.57, shLy: 0.11, shLz: 0.69, elLx: 0.34,
    shRx: 0.99, shRy: 0.36, shRz: -0.81, elRx: 2.01,
    rifleY: 0.78, rifleZ: -0.3, rifleRX: 0.12,
  },
  // Crouch-walk: knees bent, feet slightly apart (a small straddle),
  // rifle up. Upright enough to read as walking, not a squat.
  // Same hold as aim: rifle at eye level, hands on the grips.
  // bodyDrop stays -0.08: with the 1.8 m legs the FK (kneel-fk.mjs)
  // shows the boot lands exactly at -0.08 — no re-solve needed.
  crouchWalk: {
    bodyDrop: -0.08, spine: -0.14, headX: -0.06,
    hipL: 0.55, hipR: 0.55, kneeL: -0.95, kneeR: -0.95, hipLz: -0.15, hipRz: 0.15,
    shLx: 1.57, shLy: 0.11, shLz: 0.69, elLx: 0.34,
    shRx: 0.99, shRy: 0.36, shRz: -0.81, elRx: 2.01,
    rifleY: 0.78, rifleZ: -0.3, rifleRX: 0.14,
  },
};
const POSE_KEYS = Object.keys(POSES.ready);

// The rifle a figure carries — rifleman/marksman get the standard rifle;
// the gunner gets an LMG (Lior, 26/11/2026, illustration v3): thicker
// receiver and barrel, big box magazine, carry handle, and a deployed
// bipod mounted under the barrel where the front grip was. The stock
// stays short so its rear end sits inside the shoulder, never sticking
// out behind it. Returns the group and the muzzle z (for the flash).
function makeRifleMesh(cls, gunmetal, darker) {
  const mesh = new THREE.Group();
  const add = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    mesh.add(m);
    return m;
  };
  let muzzleZ = -0.47;
  if (cls === 'gunner') {
    add(0.09, 0.12, 0.5, 0, 0, 0, gunmetal); // receiver, thicker
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), gunmetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, -0.4);
    mesh.add(barrel);
    add(0.045, 0.045, 0.06, 0, 0.01, -0.56, darker); // muzzle brake
    add(0.1, 0.17, 0.13, 0, -0.12, -0.02, darker); // box magazine (120 rounds)
    add(0.04, 0.035, 0.28, 0, 0.078, -0.02, gunmetal); // carry handle
    add(0.07, 0.09, 0.14, 0, 0, 0.27, darker); // stock (short: rear stays inside the shoulder)
    // Deployed bipod: mount under the barrel, legs splayed down-forward.
    const mount = new THREE.Vector3(0, -0.06, -0.32);
    const leg = (foot) => {
      const dir = new THREE.Vector3().subVectors(foot, mount);
      const len = dir.length();
      const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 6), gunmetal);
      legMesh.position.copy(mount).addScaledVector(dir, 0.5);
      legMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      mesh.add(legMesh);
    };
    leg(new THREE.Vector3(-0.14, -0.3, -0.42));
    leg(new THREE.Vector3(0.14, -0.3, -0.42));
    muzzleZ = -0.58;
  } else {
    add(0.07, 0.1, 0.45, 0, 0, 0, gunmetal); // receiver
    // Barrel (0.225, half of the 0.45 tried before — Lior found the long
    // barrel too prominent): total rifle length ~0.83 with stock+receiver.
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.225, 8), gunmetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, -0.3225);
    mesh.add(barrel);
    add(0.05, 0.16, 0.08, 0, -0.11, -0.02, darker); // magazine
    add(0.06, 0.09, 0.16, 0, 0, 0.28, darker); // stock
  }
  return { mesh, muzzleZ };
}

// Rebuild a figure's rifle when its class changes (admin/solo setClass):
// the gunner carries an LMG, everyone else the standard rifle. The flash
// survives the rebuild (it moves to the new rifle); only geometries are
// disposed — the materials are shared across figures.
function rebuildRifle(id, g) {
  const m = meta.get(id) || npcMeta.get(id) || {};
  const cls = m.cls || 'rifleman';
  if (g.userData.rifleCls === cls) return;
  const old = g.userData.rifle;
  const flash = g.userData.flash;
  if (old) {
    if (flash) old.remove(flash);
    old.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    if (old.parent) old.parent.remove(old); // also covers a dropped rifle lying in the scene
  }
  const { mesh, muzzleZ } = makeRifleMesh(cls, g.userData.gunmetalMat, g.userData.darkerMat);
  mesh.position.set(0.08, g.userData.poseCur.rifleY, g.userData.poseCur.rifleZ);
  mesh.rotation.x = g.userData.poseCur.rifleRX;
  if (flash) { flash.position.set(0, 0.01, muzzleZ); mesh.add(flash); }
  g.userData.upper.add(mesh);
  g.userData.rifle = mesh;
  g.userData.rifleCls = cls;
}

function getPlayerMesh(id) {
  if (playerMeshes.has(id)) return playerMeshes.get(id);
  const m = meta.get(id) || npcMeta.get(id) || {};
  const group = new THREE.Group();
  // Rotation order YXZ: the fall (rotation.x) pitches in the yawed frame,
  // so a figure always falls backward relative to where it faces. Live
  // figures only use rotation.y, so this changes nothing for them.
  group.rotation.order = 'YXZ';
  // The figure is dark grey-green; the team shows only in the on-body name.
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
  hips.position.y = 0.885; // head top 1.80 - 0.915 torso/head stack
  group.add(hips);

  // Legs: thigh hangs from the hip pivot, shin + boot from the knee pivot.
  // The player is 1.8 m tall (Lior, 25/11/2026): thigh 0.45 + shin 0.44
  // = 0.885. Limbs are capsules, not boxes — rounded ends, no sharp
  // corners, so the whole body reads oval. (Capsule total = length + 2 * radius.)
  const mkLeg = (x) => {
    const hip = new THREE.Group();
    hip.position.set(x, 0, 0);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.28, 4, 10), body);
    thigh.position.set(0, -0.225, 0);
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.set(0, -0.45, 0);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.28, 4, 10), body);
    shin.position.set(0, -0.22, 0);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.32), darker);
    boot.position.set(0, -0.44, -0.04);
    knee.add(shin, boot);
    hip.add(knee);
    hips.add(hip);
    return { hip, knee, boot };
  };
  const legL = mkLeg(-0.11);
  const legR = mkLeg(0.11);

  // Upper body: pivots at the waist so poses can lean the torso. Y values
  // below are relative to the waist (0.885).
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
  const { mesh: rifleMesh, muzzleZ } = makeRifleMesh(m.cls || 'rifleman', gunmetal, darker);
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
  // True cross: rotate about Y, so the second plane faces sideways while
  // the first faces along the barrel — the flash is visible from the
  // side as well as from the front and back. (A rotation about Z is a
  // no-op on a square plane: both planes ended up coplanar, and the
  // flash was edge-on — invisible — to anyone watching from the side.
  // Lior, 24/11.)
  pf2.rotation.y = Math.PI / 2;
  pFlash.add(pf1, pf2);
  pFlash.position.set(0, 0.01, muzzleZ);
  pFlash.visible = false;
  rifleMesh.add(pFlash);

  group.userData.bodyMat = body;
  group.userData.darkerMat = darker;
  group.userData.gunmetalMat = gunmetal;
  group.userData.fadeOpacity = 1;
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
  group.userData.rifleCls = m.cls || 'rifleman'; // rebuilt on class change (LMG for the gunner)
  group.userData.poseCur = { ...POSES.ready };
  group.userData.walkPhase = 0; // advances with distance travelled
  group.userData.walkAmp = 0;   // eases in/out so the legs never snap
  rebuildBodyNamePatches(id, group);
  // Spectator disc (26/11/2026): a team-coloured ring under the figure,
  // visible only to a bird's-eye spectator. Hidden by default.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.8, 20),
    new THREE.MeshBasicMaterial({ color: TEAM_CSS[m.role] || '#ffffff', transparent: true, opacity: 0.75, depthWrite: false })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.03;
  disc.visible = false;
  group.add(disc);
  group.userData.disc = disc;
  group.userData.discRole = m.role;
  scene.add(group);
  playerMeshes.set(id, group);
  shootTargets.push(torso, head);
  return group;
}

// Set a soldier mesh's opacity (window-climb fade). The materials go
// transparent only while fading — at opacity 1 they are opaque again,
// so normal rendering (sorting, depth) is untouched. The on-body name
// patches fade with the body. Skips redundant writes: at rest every mesh
// sits at 1.
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
  // Body-name patches fade with the body (same opacity) but keep their own
  // transparent/depthWrite flags — flipping transparent off would paint the
  // patch's transparent texels black on the body.
  if (u.patchMats) {
    for (const mat of u.patchMats) mat.opacity = opacity;
  }
}

// Drop a fallen figure's rifle on the floor beside the body (0.55 m to
// the figure's right, 0.9 m behind the feet — beside the torso), lying
// flat with the barrel toward the head, resting on its magazine. The rifle
// is re-parented to the scene so it stops following the body's rotation;
// pickUpRifle restores it on revival. The drop height follows the figure's
// own floor — a second-floor body keeps its rifle upstairs (24/11/2026:
// the old hardcoded y=0.2 dropped it through the floor to the ground).
// No-op if already dropped.
function dropRifle(g) {
  const u = g.userData;
  if (!u.rifle || u.rifle.parent !== u.upper) return;
  // Yaw only — the fall pitch must not tilt the offset.
  const sin = Math.sin(g.rotation.y), cos = Math.cos(g.rotation.y);
  const ox = 0.55 * cos + 0.9 * sin;
  const oz = -0.55 * sin + 0.9 * cos;
  scene.add(u.rifle);
  u.rifle.position.set(g.position.x + ox, g.position.y + 0.2, g.position.z + oz);
  u.rifle.rotation.set(0, g.rotation.y + Math.PI, 0);
}

// Return a dropped rifle to the figure's hands. The local position and
// rotation are reset here: the rifle still carries its world-space drop
// coordinates, and applyPose only writes y/z/rx — without this reset the
// stale x (up to ±18) left the rifle floating metres from the body
// forever after a revival (24/11/2026: 7.8 m in the rifle-probe re-run).
// No-op if already attached.
function pickUpRifle(g) {
  const u = g.userData;
  if (!u.rifle || u.rifle.parent === u.upper) return;
  u.upper.add(u.rifle);
  u.rifle.position.set(0.08, u.poseCur.rifleY, u.poseCur.rifleZ);
  u.rifle.rotation.set(u.poseCur.rifleRX, 0, 0);
}

// Lerp one mesh's joints toward its target pose, then add the walk swing on
// top of the hip/knee angles. Called every frame for every visible mesh.
function applyPose(g, target, dt, walkPhase, walkAmp) {
  const u = g.userData;
  const k = 1 - Math.exp(-dt * 10); // ~0.2 s to settle
  const cur = u.poseCur;
  for (const key of POSE_KEYS) cur[key] += (target[key] - cur[key]) * k;
  u.hips.position.y = 0.885 + cur.bodyDrop; // 1.8 m figure (Lior, 25/11/2026)
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
  // The rifle follows the pose only while it is in the hands — a dropped
  // rifle (lying beside a fallen body) must not be moved by the pose.
  // x and ry/rz are pinned too: a re-parented rifle keeps its stale
  // world-space x and drop rotation otherwise (24/11/2026 floating
  // rifle bug — the pose is the only per-frame writer of the rifle).
  if (u.rifle.parent === u.upper) {
    u.rifle.position.x = 0.08;
    u.rifle.position.y = cur.rifleY;
    u.rifle.position.z = cur.rifleZ;
    u.rifle.rotation.x = cur.rifleRX;
    u.rifle.rotation.y = 0;
    u.rifle.rotation.z = 0;
  }
  // Grenade throw (Lior, 25/11/2026): the right arm swings up and
  // forward over 0.6 s, additive on top of the pose. Set by the
  // grenadeThrown event (u.throwAt).
  if (u.throwAt) {
    const throwT = (performance.now() - u.throwAt) / 600;
    if (throwT < 1) {
      const swing = Math.sin(Math.PI * throwT);
      u.armR.shoulder.rotation.x -= swing * 1.1;
      u.armR.elbow.rotation.x -= swing * 0.5;
    } else {
      u.throwAt = 0;
    }
  }
}

function removePlayerMesh(id) {
  const g = playerMeshes.get(id);
  if (!g) return;
  // A dropped rifle is a child of the scene, not the group — remove it
  // too, or it would lie on the ground forever.
  const rifle = g.userData.rifle;
  if (rifle && rifle.parent === scene) scene.remove(rifle);
  scene.remove(g);
  playerMeshes.delete(id);
  for (let i = shootTargets.length - 1; i >= 0; i--) {
    if (shootTargets[i].userData.playerId === id) shootTargets.splice(i, 1);
  }
}

function refreshMeshColors() {
  for (const [id, g] of playerMeshes) {
    const m = meta.get(id) || npcMeta.get(id) || {};
    // Bodies stay grey-green; only the on-body name follows the team color,
    // so the patches are rebuilt when the name or the team changes.
    if (g.userData.patchName !== (m.name || '?') || g.userData.patchRole !== m.role) {
      rebuildBodyNamePatches(id, g);
    }
    // The spectator disc follows the role too (attackers/defenders swap).
    if (g.userData.disc && g.userData.discRole !== m.role) {
      g.userData.disc.material.color.set(TEAM_CSS[m.role] || '#ffffff');
      g.userData.discRole = m.role;
    }
    // The rifle follows the class: a gunner carries an LMG.
    if (g.userData.rifleCls !== (m.cls || 'rifleman')) {
      rebuildRifle(id, g);
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
      if (p.admin) tags.push('ADMIN');
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
  if (me && me.cls) myClass = me.cls; // class changes (admin/solo) arrive here
  hostControls.classList.toggle('hidden', !isHost);
  // Admin (Lior, 25/11/2026): the admin rules apply only once someone
  // has entered the code. With no admin in the room, the lobby works
  // as before — anyone may start, so the button shows to everyone and
  // nobody waits. The code row shows to joined team players who are
  // not the admin yet; the panel shows to the admin.
  amAdmin = !!me && me.admin === true;
  // A spectating admin still counts: while they watch from above, the
  // lobby must not fall back to "anyone may start" (26/11/2026).
  const adminExists = state.players.some((p) => p.admin) || state.adminSpectating === true;
  adminLoginRow.classList.toggle('hidden', !me || me.solo || amAdmin);
  adminPanel.classList.toggle('hidden', !amAdmin);
  if (amAdmin) renderAdminRows(state.players.filter((p) => !p.solo));
  grenadesAllowedState = state.grenadesAllowed !== false;
  adminGrenadeBtn.textContent = grenadesAllowedState ? 'On' : 'Off';
  adminGrenadeBtn.classList.toggle('activeChoice', grenadesAllowedState);
  // Prep time toggle — any team player may flip it (Lior, 26/11/2026).
  prepEnabledState = state.prepEnabled === true;
  prepToggleBtn.textContent = prepEnabledState ? 'On' : 'Off';
  prepToggleBtn.classList.toggle('activeChoice', prepEnabledState);
  // Round length (admin field, Lior 26/11/2026): show the server's
  // current value, but never clobber a number the admin is typing.
  if (state.roundDurationMin != null && document.activeElement !== roundDurationInput) {
    roundDurationInput.value = String(state.roundDurationMin);
  }
  $('atkA').classList.toggle('activeChoice', state.attackersTeam === 'A');
  $('atkB').classList.toggle('activeChoice', state.attackersTeam === 'B');
  const canStart = aCount >= 1 && bCount >= 1;
  startBtn.disabled = (adminExists && !amAdmin) || !canStart;
  startBtn.classList.toggle('hidden', adminExists && !amAdmin);
  waitHost.classList.toggle('hidden', !adminExists || amAdmin);
  // The spectating admin runs the match from above: START in the lobby,
  // CONTINUE during an intermission (hidden otherwise).
  const specAction = spectating
    && ((game.phase === 'lobby' && canStart) || game.phase === 'intermission');
  specActionBtn.classList.toggle('hidden', !specAction);
  if (specAction) specActionBtn.textContent = game.phase === 'intermission' ? 'CONTINUE' : 'START';
  startHint.textContent = adminExists && !amAdmin
    ? 'Only the admin can start the match.'
    : canStart
      ? 'First to 3 round wins takes the match.'
      : 'Need at least 1 player on each team to start.';
}

function showScreen(name) {
  lobbyEl.classList.toggle('hidden', name !== 'lobby');
  gameEl.classList.toggle('hidden', name !== 'game');
  if (name === 'game') initThree();
  if (name === 'lobby') {
    hideHelpUI();
    if (mapOpen) {
      mapOpen = false;
      mapOverlay.classList.add('hidden');
    }
  }
}

// ---------------------------------------------------------------------------
// Help slide "איך משחקים?" (Lior, 24/11/2026)
// ---------------------------------------------------------------------------
// A DOM overlay over the live game screen. Shown on entering the game
// the FIRST time on this device (localStorage flag), auto-closing after
// 10 s. After closing, a "?" button top-right reopens it (auto-closes
// after 10 s again). The CLIMB callout shows only while the CLIMB
// button is visible (it only appears near a ground-floor window).
const HELP_SEEN_KEY = 'tacticalHelpSeen';
const HELP_AUTO_CLOSE_MS = 10000;
let helpSlideTimer = 0;
let helpSlideDoneThisEntry = false;

function helpSeen() {
  try { return localStorage.getItem(HELP_SEEN_KEY) === '1'; } catch { return false; }
}

function markHelpSeen() {
  try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch { /* private mode: show again next entry */ }
}

function showHelpSlide() {
  // CLIMB is only visible near a window — its callout (and leader)
  // show only when the button is.
  const climbVisible = !climbBtn.classList.contains('hidden');
  $('helpCoClimb').classList.toggle('hidden', !climbVisible);
  $('helpLeaderClimb').classList.toggle('hidden', !climbVisible);
  $('helpSlide').classList.remove('hidden');
  $('helpBtn').classList.add('hidden');
  clearTimeout(helpSlideTimer);
  helpSlideTimer = setTimeout(closeHelpSlide, HELP_AUTO_CLOSE_MS);
}

function closeHelpSlide() {
  clearTimeout(helpSlideTimer);
  $('helpSlide').classList.add('hidden');
  $('helpBtn').classList.remove('hidden');
}

// Once per entry into the game screen: first-time devices get the slide,
// returning devices just get the "?" button.
function maybeShowHelpSlide() {
  if (helpSlideDoneThisEntry) return;
  helpSlideDoneThisEntry = true;
  if (helpSeen()) {
    $('helpBtn').classList.remove('hidden');
    return;
  }
  markHelpSeen();
  showHelpSlide();
}

function hideHelpUI() {
  clearTimeout(helpSlideTimer);
  $('helpSlide').classList.add('hidden');
  $('helpBtn').classList.add('hidden');
  helpSlideDoneThisEntry = false;
}

$('helpCloseBtn').addEventListener('click', closeHelpSlide);
$('helpBtn').addEventListener('click', showHelpSlide);

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
  // Score + timer + alive counts. The top bar shows the timer only
  // (score/alive/round lines are hidden in CSS); in solo there is no
  // match clock, so the timer hides too and the top stays empty.
  if (solo) {
    scoreBox.textContent = 'SOLO MODE';
    timerEl.textContent = '—';
    timerEl.classList.add('hidden');
    aliveBox.textContent = '—';
    roundInfo.textContent = 'Explore the map — move, shoot, reload';
  } else {
    timerEl.classList.remove('hidden');
    scoreBox.textContent = `${roleLabel('A')} ${game.score.A} — ${game.score.B} ${roleLabel('B')}`;
    if (game.phase === 'playing') {
      // Defense prep time: the timer counts the prep down for everyone.
      timerEl.textContent = game.prepActive
        ? `התארגנות ${fmtTime(game.prepMsLeft)}`
        : fmtTime(game.timeLeftMs);
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

  // Health + ammo (mine). The ammo reads as magazine icons — one per spare
  // magazine (Lior, 25/11/2026). The leftmost turns red when the loaded
  // magazine is empty, and disappears on reload. NO AMMO when nothing
  // is left at all. Health icon: green at full health, red after the
  // first hit (24/11/2026 — the bar and the number are gone).
  healthIcon.classList.toggle('hurt', myHealth < 100);
  renderMagIcons();
  renderGrenadeButtons();

  // Reload progress: the arrow fills right-to-left over the 3.5 s reload.
  // The arrow spans x 6..204 in its SVG viewBox; the fill rect is anchored
  // at the right edge and grows left as the reload progresses. On desktop
  // the arrow is hidden (touch UI) and only RELOADING… shows.
  if (reloading) {
    reloadText.classList.remove('hidden');
    const total = myReloadMs;
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

// EMPTY caption: how long it stays up per press (each press re-triggers).
const EMPTY_CAPTION_MS = 1500;
let emptyCaptionTimer = 0;
function showEmptyCaption() {
  emptyCaption.classList.add('show');
  clearTimeout(emptyCaptionTimer);
  emptyCaptionTimer = setTimeout(() => emptyCaption.classList.remove('show'), EMPTY_CAPTION_MS);
}

function tryFire(now) {
  if (!myAlive || (game.phase !== 'playing' && !solo)) return;
  if (climbing) return; // frozen mid-climb
  if (mapOpen || reloading) return;
  // Empty magazine: no shot, but tell the player why — a red EMPTY
  // caption at the top of the screen. (While reloading the RELOADING…
  // text already covers it, so no caption there.)
  if (myInMag <= 0) { showEmptyCaption(); return; }
  // Per-class fire rate: the marksman fires one bullet per second only
  // while aiming down the sights; from the hip he fires like a
  // rifleman (Lior, 26/11/2026). The server enforces the same rule.
  const interval = myClass === 'marksman' && controls.aiming ? 1000 : FIRE_INTERVAL;
  if (now - lastFireAt < interval) return;
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
  // The wall/floor impact point travels with the shot (26/11/2026):
  // other players see the hit and hear it when it lands near them.
  let impact = null;
  if (hits.length > 0) {
    const first = hits[0].object;
    if (first.userData.playerId != null) {
      targetId = first.userData.playerId;
    } else {
      // Visible impact where the bullet lands.
      impact = {
        x: Math.round(hits[0].point.x * 10) / 10,
        y: Math.round(hits[0].point.y * 10) / 10,
        z: Math.round(hits[0].point.z * 10) / 10,
      };
      impactMarker.position.copy(hits[0].point);
      impactMarker.visible = true;
      impactMarker.material.opacity = 0.95;
      impactMarker.userData.bornAt = now;
    }
  }
  socket.send({ t: 'shot', targetId, impact, aiming: controls.aiming });
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

// Grenades (Lior, 25/11/2026): two per round. Pressing a grenade button
// (or G on desktop) starts a 3 s arming — the left button fills
// bottom-up — and the throw goes out when the fill completes. The
// server then flies the grenade 10 m and explodes it 3 s after the throw.
const GRENADE_ARM_MS = 1500;
const grenadeBtnEls = [document.getElementById('grenadeBtn0'), document.getElementById('grenadeBtn1')];
for (const btn of grenadeBtnEls) btn.addEventListener('click', () => startGrenadeArm());

function startGrenadeArm() {
  if (grenadeArming) return; // already arming one
  if (!myAlive || (game.phase !== 'playing' && !solo)) return;
  if (myGrenades <= 0) return;
  grenadeArming = { endsAt: performance.now() + GRENADE_ARM_MS };
}

function throwGrenade() {
  grenadeArming = null;
  if (!myAlive || (game.phase !== 'playing' && !solo)) return;
  socket.send({ t: 'throwGrenade' });
  localThrowAt = performance.now(); // the viewmodel dip
}

// Grenade buttons, refreshed every frame from the HUD: button 0 is the
// first grenade, button 1 the second — the left one fills and disappears
// first, the right one remains. A death or a round end cancels the arming.
function renderGrenadeButtons() {
  if (!myAlive || (game.phase !== 'playing' && !solo)) grenadeArming = null;
  const canThrow = myAlive && (game.phase === 'playing' || solo);
  grenadeBtnEls[0].classList.toggle('hidden', !canThrow || myGrenades < 2);
  grenadeBtnEls[1].classList.toggle('hidden', !canThrow || myGrenades < 1);
  const filling = grenadeArming
    ? (myGrenades >= 2 ? grenadeBtnEls[0] : grenadeBtnEls[1])
    : null;
  for (const btn of grenadeBtnEls) {
    const fill = btn.querySelector('.grenadeFill');
    if (btn === filling) {
      const left = Math.max(0, grenadeArming.endsAt - performance.now());
      fill.style.height = `${(1 - left / GRENADE_ARM_MS) * 100}%`;
      if (left <= 0) throwGrenade();
    } else {
      fill.style.height = '0%';
    }
  }
}

// Grenade meshes, synced from the snapshot's live list: a small dark
// sphere that flies the server's arc and rests where it lands.
const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
const grenadeMat = new THREE.MeshLambertMaterial({ color: 0x2a2d2a });
function updateGrenadeMeshes(list) {
  const seen = new Set();
  for (const g of list) {
    seen.add(g.id);
    let mesh = grenadeMeshes.get(g.id);
    if (!mesh) {
      mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
      scene.add(mesh);
      grenadeMeshes.set(g.id, mesh);
    }
    mesh.position.set(g.x, g.y, g.z);
  }
  for (const [id, mesh] of [...grenadeMeshes]) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      grenadeMeshes.delete(id);
    }
  }
}

// Blast visual: an orange sphere that expands to the 4 m blast radius
// and fades over 0.6 s. Updated in the render loop.
function showExplosion(x, y, z) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
  mesh.position.set(x, y + 0.2, z);
  mesh.scale.setScalar(0.3);
  scene.add(mesh);
  activeExplosions.push({ mesh, bornAt: performance.now() });
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
  // Expiring invite link (Lior, 26/11/2026): a visitor who opened a
  // shared ?invite=<code> link asks the server whether it is still good.
  // (A returning player reconnects with savedJoin regardless — the link
  // gates new entry, not reconnection.)
  const inviteCode = new URLSearchParams(location.search).get('invite');
  if (inviteCode) socket.send({ t: 'checkInvite', code: inviteCode });
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
  myClass = msg.cls || 'rifleman';
  joined = true;
  joinBox.classList.add('hidden');
  teamsBox.classList.remove('hidden');
});

socket.on('soloJoined', (msg) => {
  myId = msg.id;
  myClass = msg.cls || 'rifleman';
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
  maybeShowHelpSlide();
  // No intro banner: it overlapped the help slide on first entry and
  // added nothing on later ones (removed 24/11/2026, Lior's call).
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

socket.on('left', () => {
  // Deliberate team leave (EXIT button): same reset as soloLeft, plus
  // the mid-match overlays. savedJoin is cleared so the state handler
  // does not auto-rejoin — the player chose to leave (they may still
  // rejoin by hand within the 5-minute grace window).
  joined = false;
  solo = false;
  savedJoin = null;
  myTeam = null;
  myAlive = true;
  myHealth = 100;
  myInMag = 29;
  myMags = 5;
  downUntil = 0;
  downOverlay.classList.add('hidden');
  pendingRoundEnd = null;
  pendingMatchEnd = null;
  exitBtn.classList.add('hidden');
  endScreen.classList.add('hidden');
  teamsBox.classList.add('hidden');
  joinBox.classList.remove('hidden');
  showScreen('lobby');
});

// Bird's-eye spectator (Lior, 26/11/2026): the admin watches from above
// with no figure and no weapon. myAlive stays false so the viewmodel,
// fire, grenades and the chase camera all stay off; the render loop
// switches the camera to the top-down view while spectating is set.
socket.on('spectateJoined', (msg) => {
  myId = msg.id;
  joined = true;
  solo = false;
  spectating = true;
  specX = 0; // centre the bird's-eye view on the street
  specZ = 0;
  myTeam = null;
  myAlive = false;
  savedJoin = null;
  document.body.classList.add('spectating');
  joinBox.classList.add('hidden');
  teamsBox.classList.add('hidden');
  exitSoloBtn.classList.add('hidden');
  exitBtn.classList.add('hidden');
  specExitBtn.classList.remove('hidden');
  hideHelpUI();
  showScreen('game');
  // The REC button shows only to the bird's-eye admin — and only
  // where this browser can actually record (MediaRecorder + a
  // capturable canvas). Checked after showScreen('game'): initThree
  // creates the renderer/canvas there, so before it there is no
  // canvas to capture.
  const canRecord = typeof MediaRecorder !== 'undefined'
    && !!renderer && !!renderer.domElement.captureStream;
  specRecBtn.classList.toggle('hidden', !canRecord);
});

socket.on('spectateLeft', () => {
  spectating = false;
  joined = false;
  myId = null;
  myAlive = true;
  myHealth = 100;
  myInMag = 29;
  myMags = 5;
  document.body.classList.remove('spectating');
  specExitBtn.classList.add('hidden');
  specActionBtn.classList.add('hidden');
  // Leaving mid-recording finalizes what was captured — the done
  // panel opens when the recorder stops. Otherwise hide the panel.
  if (specRecorder) stopSpecRecording();
  else recPanel.classList.add('hidden');
  specRecBtn.classList.add('hidden');
  exitBtn.classList.add('hidden');
  endScreen.classList.add('hidden');
  teamsBox.classList.add('hidden');
  joinBox.classList.remove('hidden');
  hideHelpUI();
  showScreen('lobby');
});

socket.on('adminOk', () => {
  // The admin panel renders from the state that follows this message.
  adminCodeInput.value = '';
  adminError.classList.add('hidden');
});

socket.on('error', (msg) => {
  if (msg.message === 'Wrong admin code.') {
    adminError.textContent = msg.message;
    adminError.classList.remove('hidden');
    return;
  }
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
    exitBtn.classList.add('hidden');
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
  exitBtn.classList.add('hidden');
  endScreen.classList.add('hidden');
  kickNotice.textContent = msg.reason || 'The host cleared the room. Rejoin to play.';
  kickNotice.classList.remove('hidden');
  showScreen('lobby');
});

// Admin panel rows (Lior, 25/11/2026): one row per team player — an
// editable name, team buttons, class buttons. Rebuilt only when the
// player set changes, so typing a name is not interrupted by a state
// arriving mid-edit.
let adminRowsSig = '';
let grenadesAllowedState = true;
let prepEnabledState = false; // prep time toggle, off by default (26/11/2026)
function renderAdminRows(teamPlayers) {
  const sig = teamPlayers.map((p) => `${p.id}:${p.name}:${p.team}:${p.cls}`).join('|');
  if (sig === adminRowsSig) return;
  adminRowsSig = sig;
  adminPlayerRows.innerHTML = '';
  for (const p of teamPlayers) {
    const row = document.createElement('div');
    row.className = 'adminRow';
    const nameEl = document.createElement('input');
    nameEl.type = 'text';
    nameEl.maxLength = 16;
    nameEl.value = p.name;
    nameEl.className = 'adminNameInput';
    nameEl.addEventListener('change', () => {
      const name = nameEl.value.trim();
      if (name && name !== p.name) socket.send({ t: 'rename', playerId: p.id, name });
    });
    row.appendChild(nameEl);
    for (const team of ['A', 'B']) {
      const btn = document.createElement('button');
      btn.textContent = team === 'A' ? 'Attackers' : 'Defenders';
      btn.className = 'classBtn' + (p.team === team ? ' activeChoice' : '');
      btn.addEventListener('click', () => socket.send({ t: 'setTeam', playerId: p.id, team }));
      row.appendChild(btn);
    }
    for (const [cls, label] of [['rifleman', 'Rifleman'], ['marksman', 'Marksman'], ['gunner', 'Gunner']]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.className = 'classBtn' + (p.cls === cls ? ' activeChoice' : '');
      btn.addEventListener('click', () => socket.send({ t: 'setClass', playerId: p.id, cls }));
      row.appendChild(btn);
    }
    if (p.id === myId) {
      const you = document.createElement('span');
      you.className = 'adminYou';
      you.textContent = '(you)';
      row.appendChild(you);
    }
    adminPlayerRows.appendChild(row);
  }
}

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
  // A bird's-eye spectator stays in the game view too — the lobby-phase
  // branch below would otherwise yank them back to the lobby screen on
  // every state (26/11/2026). renderLobby still runs above so the
  // spectator's START / CONTINUE button updates.
  if (spectating) return;
  if (msg.phase === 'lobby') {
    showScreen('lobby');
    endScreen.classList.add('hidden');
    exitBtn.classList.add('hidden');
  } else {
    showScreen('game');
    maybeShowHelpSlide();
    // Team players get an EXIT button (top-left) in the match, in the
    // intermission and on the final screen — the lobby has none (Lior,
    // 24/11). Solo players use EXIT SOLO instead (handled above).
    exitBtn.classList.remove('hidden');
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
  game.prepActive = msg.prepActive;
  game.prepMsLeft = msg.prepMsLeft || 0;
  game.captureProgress = msg.captureProgress || 0;
  snapPlayers = new Map(msg.players.map((p) => [p.id, p]));
  updateGrenadeMeshes(msg.grenades || []);
  // Debug hook: the live NPC list (id, position, alive) for the
  // screenshot runs, which aim the camera at a chosen NPC.
  window.__npcs = msg.players
    .filter((p) => p.npc)
    .map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, alive: p.alive, health: p.health }));
  // NPC entries carry their own name/team — they never appear in state
  // messages, so meta never knows them.
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
    // A gunner who dies while holding FIRE must not resume firing on his
    // own next round (stuck-fire bug): clear the held flag on death.
    if (wasAlive && !myAlive) controls.fireHeld = false;
    myHealth = me.health;
    myInMag = me.inMag;
    myMags = me.mags;
    myGrenades = me.grenades ?? myGrenades;
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
      controls.fireQueued = false;
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
    // Wall/floor hits are visible to everyone now (Lior, 26/11/2026):
    // the same yellow marker the shooter sees, at the broadcast point.
    // My own shots already showed the marker locally when I fired.
    if (msg.impact) {
      impactMarker.position.set(msg.impact.x, msg.impact.y, msg.impact.z);
      impactMarker.visible = true;
      impactMarker.material.opacity = 0.95;
      impactMarker.userData.bornAt = performance.now();
      // Near-miss: an impact within 1 m of my body cracks in my ears.
      if (myAlive) {
        const dy = Math.max(local.y - msg.impact.y, 0, msg.impact.y - (local.y + 1.8));
        const d = Math.hypot(msg.impact.x - local.x, dy, msg.impact.z - local.z);
        if (d < 1) sfx.impact();
      }
    }
  }
  if (solo) {
    // No killfeed, no hitmarker, no hit sound — in solo or in a match
    // (Lior, 23/11: they hurt realism). A hit is visible only as the
    // figure falling; match shots stay out of the solo HUD.
    return;
  }
  if (msg.targetId === myId && msg.killed && msg.friendlyFire) {
    // I was teamkilled: remember it for the YOU'RE DOWN overlay. If the
    // snapshot already showed my death (overlay up), add the line now.
    killedByFriendlyFire = true;
    if (downUntil) downSub.classList.remove('hidden');
  }
  if (msg.targetId === myId && msg.hit && !msg.killed) {
    showDamageFlash();
  }
});

socket.on('npcHit', () => {
  // Solo only: an NPC's shot landed. The screen reddens like a real hit,
  // but there is no health loss and no elimination (Lior, 25/11/2026).
  if (solo) showDamageFlash();
});

socket.on('grenadeThrown', (msg) => {
  // Throw animation: the thrower's right arm swings (remote figures);
  // my own throw dips the viewmodel rifle.
  if (msg.throwerId === myId) {
    localThrowAt = performance.now();
    return;
  }
  const g = playerMeshes.get(msg.throwerId);
  if (g) g.userData.throwAt = performance.now();
});

socket.on('grenadeExploded', (msg) => {
  showExplosion(msg.x, msg.y, msg.z);
  // A grenade teamkill adds the FRIENDLY FIRE line under YOU'RE DOWN,
  // like a shot teamkill (the snapshot shows the death a tick later and
  // reads this flag).
  if (msg.victims && msg.victims.includes(myId)) {
    const throwerMeta = meta.get(msg.throwerId);
    const myRole = meta.get(myId)?.role;
    if (throwerMeta && myRole && throwerMeta.role === myRole) {
      killedByFriendlyFire = true;
      if (downUntil) downSub.classList.remove('hidden');
    }
  }
});

socket.on('reloadStart', (msg) => {
  if (msg.playerId === myId) {
    reloading = true;
    myReloadMs = msg.reloadMs || 3500;
    reloadEndsAt = performance.now() + myReloadMs;
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
  // A new round never starts with a held trigger (stuck-fire bug).
  controls.fireHeld = false;
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
  savedJoin = { name, solo: true, cls: soloClass, grenades: soloGrenades };
  sendJoin(savedJoin);
});
document.querySelectorAll('#soloClassRow .classBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    soloClass = btn.dataset.cls;
    document.querySelectorAll('#soloClassRow .classBtn').forEach((b) =>
      b.classList.toggle('activeChoice', b === btn));
    // Already solo: switch class immediately, no rejoin needed.
    if (solo && joined) socket.send({ t: 'setClass', cls: soloClass });
  });
});
// Solo grenade toggle (Lior, 25/11/2026): applies on the next solo
// entry (the count is set at join time).
$('soloGrenadeBtn').addEventListener('click', () => {
  soloGrenades = !soloGrenades;
  const btn = $('soloGrenadeBtn');
  btn.textContent = soloGrenades ? 'On' : 'Off';
  btn.classList.toggle('activeChoice', soloGrenades);
});
exitSoloBtn.addEventListener('click', () => socket.send({ t: 'leaveSolo' }));
exitBtn.addEventListener('click', () => socket.send({ t: 'leave' }));
// Bird's-eye spectator (admin only, from the admin panel).
$('spectateBtn').addEventListener('click', () => socket.send({ t: 'spectate' }));
specExitBtn.addEventListener('click', () => socket.send({ t: 'leaveSpectate' }));
specActionBtn.addEventListener('click', () => {
  socket.send({ t: game.phase === 'intermission' ? 'continue' : 'start' });
});
// Bird's-eye recording (Lior, 26/11/2026): the admin spectator records
// exactly what they see from above — the WebGL canvas, plus the game
// audio — with MediaRecorder. The file downloads to the admin's device,
// or goes out through the OS share sheet (Mail, Drive, WhatsApp…),
// which is how a recording reaches email or Drive: a mailto: link
// cannot carry an attachment, and the game server holds no mail or
// Drive credentials. The tab must stay in the foreground while
// recording — a background tab stops drawing frames.
let specRecorder = null; // MediaRecorder while recording
let specRecChunks = [];
let specRecStart = 0;
let specRecTimer = 0;
let specRecStream = null;
let specRecBlob = null;
let specRecBlobUrl = null;
let specRecMime = '';
let specRecExt = 'webm';
let specRecName = '';

function pickRecMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [mime, ext] of [
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
    ['video/mp4', 'mp4'],
  ]) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: '', ext: 'webm' }; // no preference matched — let the browser pick
}

function fmtRecTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtRecSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateRecBtn() {
  if (!specRecorder) {
    specRecBtn.classList.remove('recording');
    specRecBtn.textContent = '● REC';
    return;
  }
  specRecBtn.classList.add('recording');
  specRecBtn.innerHTML = `<span class="recDot"></span>REC ${fmtRecTime(Date.now() - specRecStart)}`;
}

function startSpecRecording() {
  if (specRecorder || !renderer) return;
  const picked = pickRecMime();
  if (!picked || !renderer.domElement.captureStream) return; // cannot record here
  specRecMime = picked.mime;
  specRecExt = picked.ext;
  // The REC tap is a user gesture, so the AudioContext may start now.
  sfx.ensure();
  specRecStream = renderer.domElement.captureStream(30);
  const audioStream = sfx.recordingStream();
  if (audioStream) {
    const track = audioStream.getAudioTracks()[0];
    if (track && track.readyState === 'live') specRecStream.addTrack(track);
  }
  specRecChunks = [];
  try {
    specRecorder = new MediaRecorder(specRecStream,
      { mimeType: specRecMime || undefined, videoBitsPerSecond: 5_000_000 });
  } catch {
    specRecorder = null;
    return;
  }
  specRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) specRecChunks.push(e.data); };
  specRecorder.onstop = finishSpecRecording;
  specRecStart = Date.now();
  try {
    specRecorder.start(500);
  } catch {
    specRecorder = null;
    return;
  }
  updateRecBtn();
  specRecTimer = setInterval(updateRecBtn, 1000);
}

function stopSpecRecording() {
  if (!specRecorder) return;
  clearInterval(specRecTimer);
  specRecTimer = 0;
  const rec = specRecorder;
  specRecorder = null;
  updateRecBtn();
  try { rec.stop(); } catch { /* already stopped */ }
  // End the capture stream's tracks; the audio track belongs to the
  // game's shared recording destination — a fresh one is built on the
  // next recording if this track ended (see audio.js).
  if (specRecStream) {
    specRecStream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already ended */ } });
  }
  specRecStream = null;
}

function finishSpecRecording() {
  const durationMs = Date.now() - specRecStart;
  const blob = new Blob(specRecChunks, { type: specRecMime || 'video/webm' });
  specRecChunks = [];
  if (specRecBlobUrl) URL.revokeObjectURL(specRecBlobUrl);
  specRecBlob = blob;
  specRecBlobUrl = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  specRecName = `tactical-poc-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${specRecExt}`;
  recInfo.textContent = `${specRecName} · ${fmtRecTime(durationMs)} · ${fmtRecSize(blob.size)}`;
  // The OS share sheet is the route to email and Drive: Mail and the
  // Drive app both accept a video file from it. Long recordings are
  // big (about 40 MB a minute at this bitrate) — past email's usual
  // 25 MB cap, so for a long one Drive is the reliable route.
  const file = new File([blob], specRecName, { type: blob.type });
  const canShare = typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [file] });
  recShareBtn.classList.toggle('hidden', !canShare);
  recShareNote.classList.toggle('hidden', canShare);
  if (!canShare) {
    recShareNote.textContent = 'Sharing is not available in this browser — use Download, then attach or upload the file yourself.';
  }
  recPanel.classList.remove('hidden');
  // Test hook: the browser run reads the finished recording.
  window.__lastRecording = { name: specRecName, size: blob.size, mimeType: blob.type, durationMs, canShare };
}

specRecBtn.addEventListener('click', () => {
  if (specRecorder) stopSpecRecording();
  else startSpecRecording();
});
recDownloadBtn.addEventListener('click', () => {
  if (!specRecBlobUrl) return;
  const a = document.createElement('a');
  a.href = specRecBlobUrl;
  a.download = specRecName;
  document.body.appendChild(a);
  a.click();
  a.remove();
});
recShareBtn.addEventListener('click', async () => {
  if (!specRecBlob) return;
  const file = new File([specRecBlob], specRecName, { type: specRecBlob.type });
  try {
    await navigator.share({ files: [file], title: specRecName });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // the user dismissed the sheet
    recShareNote.classList.remove('hidden');
    recShareNote.textContent = 'Sharing failed — try Download instead.';
  }
});
recCloseBtn.addEventListener('click', () => {
  recPanel.classList.add('hidden');
});
// Expiring invite links (admin only, 1 hour — Lior, 26/11/2026).
$('createInviteBtn').addEventListener('click', () => socket.send({ t: 'createInvite' }));
$('copyInviteBtn').addEventListener('click', async () => {
  const input = $('inviteLinkInput');
  const btn = $('copyInviteBtn');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
});

socket.on('inviteCreated', (msg) => {
  $('inviteLinkInput').value = `${location.origin}/?invite=${msg.code}`;
  $('inviteExpiry').textContent = `valid until ${new Date(msg.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('inviteOut').classList.remove('hidden');
});

socket.on('inviteStatus', (msg) => {
  // An expired (or bogus) shared link: show the notice and hide the join
  // UI, so a new visitor cannot enter through it. Direct entry without
  // a link stays open (Lior is still deliberating about that).
  if (msg.valid) return;
  $('inviteExpired').classList.remove('hidden');
  joinBox.classList.add('hidden');
  teamsBox.classList.add('hidden');
});
$('switchBtn').addEventListener('click', () => {
  socket.send({ t: 'switchTeam', team: myTeam === 'A' ? 'B' : 'A' });
});
$('atkA').addEventListener('click', () => socket.send({ t: 'setAttackers', team: 'A' }));
$('atkB').addEventListener('click', () => socket.send({ t: 'setAttackers', team: 'B' }));
$('startBtn').addEventListener('click', () => socket.send({ t: 'start' }));
// Admin login (Lior, 25/11/2026): the code makes this player the admin.
// The panel itself renders from the state (see the state handler).
adminLoginBtn.addEventListener('click', () => {
  const code = adminCodeInput.value.trim();
  if (!code) return;
  adminError.classList.add('hidden');
  socket.send({ t: 'admin', code });
});
adminCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') adminLoginBtn.click();
});
adminGrenadeBtn.addEventListener('click', () => {
  socket.send({ t: 'setGrenadesAllowed', allowed: !grenadesAllowedState });
});
$('roundDurationBtn').addEventListener('click', () => {
  const mins = Number(roundDurationInput.value);
  if (Number.isFinite(mins)) socket.send({ t: 'setRoundDuration', minutes: mins });
});
prepToggleBtn.addEventListener('click', () => {
  socket.send({ t: 'setPrepEnabled', enabled: !prepEnabledState });
});
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
  // Semi-auto: consume a queued FIRE press every frame, even when the
  // player is dead or spectating — a press then is discarded, never
  // fired late on the next round. The machine gunner is full-auto:
  // holding FIRE keeps firing (paced by tryFire's interval).
  const firePressed = controls.takeFirePress()
    || (myClass === 'gunner' && controls.fireHeld);

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
      // Fallen: the figure falls backward onto the ground over FALL_MS
      // and lies there until revival — no name, no effects, just the
      // body. The rifle drops beside it once the body is down. The joints
      // freeze in the pose the figure died in.
      const g = playerMeshes.get(id);
      if (g) {
        const u = g.userData;
        // A fallen body shows no name.
        if (u.headPatch) u.headPatch.visible = false;
        if (u.backPatch) u.backPatch.visible = false;
        if (u.disc) u.disc.visible = false;
        setMeshFade(g, 1); // a body that died mid-climb-fade is fully opaque
        if (u.fallTo !== 1) {
          u.fallFrom = u.fallT ?? 0;
          u.fallTo = 1;
          u.fallStartAt = now;
        }
        const t = Math.min((now - u.fallStartAt) / FALL_MS, 1);
        u.fallT = u.fallFrom + (1 - u.fallFrom) * (t * t); // ease-in: a fall accelerates
        g.rotation.x = u.fallT * (Math.PI / 2);
        if (t >= 1) dropRifle(g);
        g.visible = true;
      }
      continue;
    }
    const g = getPlayerMesh(id);
    g.visible = true;
    const u = g.userData;
    // Stand back up after a fall (round-start revives teleport, so the
    // reset is invisible there). The rifle returns to the hands once the
    // figure is upright. Solo NPCs never stand back up — their snapshot
    // alive flag stays false once down.
    if (u.fallTo !== 0) {
      u.fallFrom = u.fallT ?? 0;
      u.fallTo = 0;
      u.fallStartAt = now;
    }
    if (u.fallT > 0) {
      const t = Math.min((now - u.fallStartAt) / FALL_MS, 1);
      const easeOut = 1 - (1 - t) * (1 - t);
      u.fallT = u.fallFrom * (1 - easeOut);
      g.rotation.x = u.fallT * (Math.PI / 2);
      if (t >= 1) pickUpRifle(g);
    } else {
      g.rotation.x = 0;
    }
    // The on-body name is teammates-only: the enemy team sees no name at all.
    // (Solo players have no team, so they neither show nor see names.)
    const m = meta.get(id) || npcMeta.get(id);
    const isTeammate = !solo && myTeam != null && !!m && !m.solo && m.team === myTeam;
    if (g.userData.headPatch) g.userData.headPatch.visible = isTeammate;
    if (g.userData.backPatch) g.userData.backPatch.visible = isTeammate;
    // Bird's-eye spectator: a team-coloured disc under each living figure
    // (26/11/2026) — dark figures on the black street are nearly invisible
    // from above without it. Only the spectator's client shows it.
    if (g.userData.disc) g.userData.disc.visible = spectating;
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

  if (spectating) {
    // Bird's-eye admin view: 55 m up (figures read as small dots, ~8 px),
    // drag pans the view along the street. The look deltas are consumed
    // here so they never leak into the yaw when spectating ends.
    const look = controls.takeLook();
    specX = Math.max(-18, Math.min(18, specX - look.dx * 0.05));
    specZ = Math.max(-62, Math.min(62, specZ - look.dy * 0.05));
    camera.position.set(specX, 55, specZ);
    camera.rotation.set(-Math.PI / 2, 0, 0);
  } else if ((game.phase === 'playing' || solo) && myAlive) {
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
      // Defense prep time (Lior, 25/11/2026): attackers wait at spawn
      // while the defenders get into position — no movement, but looking
      // around still works (yaw is applied below, outside this block).
      if (game.prepActive && meta.get(myId)?.role === 'attackers') { vx = 0; vz = 0; }
      const len = Math.hypot(vx, vz);
      if (len > 0) {
        // Aiming down the sights slows movement; crouching slows it more.
        const speed = SPEED * (1 - aimBlend * 0.35) * (controls.crouch ? 0.45 : 1) * Math.min(1, len);
        vx = (vx / len) * speed;
        vz = (vz / len) * speed;
      }
      // Crouch-walk limit: 2 continuous seconds of walking while crouched
      // returns the player to standing (Lior, 25/11/2026).
      if (controls.crouch && len > 0.01) {
        crouchWalkMs += dt * 1000;
        if (crouchWalkMs >= CROUCH_WALK_LIMIT_MS) {
          controls.setCrouch(false);
          crouchWalkMs = 0;
        }
      } else {
        crouchWalkMs = 0;
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

    camera.position.set(local.x, local.y + EYE_HEIGHT - crouchBlend * CROUCH_EYE_DROP, local.z);
    camera.rotation.set(local.pitch, local.yaw, 0);

    // Semi-auto: one shot per press, never a held-down stream.
    if (firePressed) tryFire(now);

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
    camera.position.set(local.x, local.y + EYE_HEIGHT - crouchBlend * CROUCH_EYE_DROP, local.z);
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

  // Blast visuals: expand to the 4 m radius and fade over 0.6 s.
  for (let i = activeExplosions.length - 1; i >= 0; i--) {
    const e = activeExplosions[i];
    const age = now - e.bornAt;
    if (age >= 600) {
      scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
      activeExplosions.splice(i, 1);
    } else {
      const t = age / 600;
      e.mesh.scale.setScalar(0.3 + t * 3.7);
      e.mesh.material.opacity = 0.85 * (1 - t);
    }
  }

  updateHUD();
  updateViewmodel(dt, now);

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.__tacticalBooted = true;
window.__tacticalLocal = local; // debug/test hook: the local player's position
// Debug/test hook: the firing-relevant state (why a click did or did not fire).
window.__tacticalFire = () => ({
  queued: controls.fireQueued,
  locked: controls.locked,
  alive: myAlive,
  solo,
  phase: game.phase,
  inMag: myInMag,
  reloading,
  climbing,
  mapOpen,
});
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

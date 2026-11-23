// ik-solve.mjs — solve the aim-pose arm angles so both hands land on the
// rifle grips at the NEW raised rifle height (rifleY 0.78, rifleZ -0.3).
// The rifle sits at the head's lower quarter (as in Lior's approved
// illustration), not below the chin: the stock tucks under the head ball
// and the barrel emerges at eye-line height.
//
// The 3-DOF arm (shX, shZ, elX) CANNOT put the trigger hand on the pistol
// grip with a natural tucked elbow: the shoulder's two rotations fix both
// the upper-arm direction and the elbow hinge axis, and the hinge then
// can't swing the forearm inward enough (best miss 10.7 cm, elbow crossed
// to the centreline). The fix is a shoulder-twist DOF: shY (rotation.y on
// the shoulder group), added to the pose system alongside shX/shZ. With
// 4 DOF the chain can hit any reachable grip with a natural elbow.
//
// Replicates the game's arm chain exactly (mkArm + applyPose in main.js):
// shoulder Group at (+/-0.3, 0.57, 0) with Euler (shX, shY, shZ), elbow
// Group at (0, -0.32, 0) with Euler (elX, 0, 0), hand sphere at
// (0, -0.31, -0.01) in elbow space. Forward kinematics via three.js
// matrices; coordinate descent on (shX, shY, shZ, elX) from several
// starts (a 4-D grid is too big), keeping the best.
//
// Targets (upper-local, rifle at y 0.72, z -0.3):
//   right hand -> pistol grip (rifle-local 0, -0.10, +0.08)
//   left hand  -> foregrip    (rifle-local 0, -0.05, -0.18)
// The elbow must look natural: below the shoulder, on the arm's own
// side, clear of the torso/vest (vest front face at z=-0.16, x within
// +/-0.21, y 0.11..0.56), and the twist kept modest.
//
// Run: node ik-solve.mjs   (from the tactical-poc directory)

import * as THREE from 'three';

const RIFLE_Y = 0.78;
const RIFLE_Z = -0.3;
const RIFLE_X = 0.08;

const TARGETS = {
  R: new THREE.Vector3(RIFLE_X, RIFLE_Y - 0.10, RIFLE_Z + 0.08),
  L: new THREE.Vector3(RIFLE_X, RIFLE_Y - 0.05, RIFLE_Z - 0.18),
};

// Forward kinematics for one arm: returns { hand, elbow } in upper space.
function fk(side, shX, shY, shZ, elX) {
  const shoulder = new THREE.Group();
  shoulder.position.set(0.3 * side, 0.57, 0);
  shoulder.rotation.set(shX, shY, shZ);
  const elbow = new THREE.Group();
  elbow.position.set(0, -0.32, 0);
  elbow.rotation.set(elX, 0, 0);
  shoulder.add(elbow);
  shoulder.updateMatrixWorld(true);
  const hand = new THREE.Vector3(0, -0.31, -0.01).applyMatrix4(elbow.matrixWorld);
  const elbowPos = new THREE.Vector3().setFromMatrixPosition(elbow.matrixWorld);
  return { hand, elbow: elbowPos };
}

function cost(side, target, shX, shY, shZ, elX) {
  const { hand, elbow } = fk(side, shX, shY, shZ, elX);
  let c = hand.distanceTo(target) * 3;
  // Natural elbow: below the shoulder, on the arm's own side, not flared,
  // clear of the vest (front face z=-0.16, |x|<0.21, 0.11<y<0.56).
  if (elbow.y > 0.5) c += (elbow.y - 0.5);
  if (elbow.x * side < 0.08) c += (0.08 - elbow.x * side) * 2;
  if (Math.abs(elbow.x) > 0.38) c += (Math.abs(elbow.x) - 0.38);
  if (elbow.z < -0.14 && Math.abs(elbow.x) < 0.23 && elbow.y > 0.09 && elbow.y < 0.58) {
    c += (-0.14 - elbow.z) * 2; // clipping the vest
  }
  if (Math.abs(shY) > 0.8) c += (Math.abs(shY) - 0.8);
  if (Math.abs(shZ) > 0.9) c += (Math.abs(shZ) - 0.9);
  // Trigger (right) elbow: prefer the tucked spot — down at the body's
  // side, slightly forward — over an elbow jutting forward. The grip is
  // high now, so the elbow can't hang as low as before, but it should
  // stay in, not out. (The support elbow is meant to be forward, under
  // the rifle, so this term applies to the right arm only.)
  if (side === 1) {
    c += 0.5 * elbow.distanceTo(new THREE.Vector3(0.12, 0.38, -0.18));
  }
  return c;
}

function descend(side, target, start) {
  let best = { ...start, c: cost(side, target, start.shX, start.shY, start.shZ, start.elX) };
  let step = 0.08;
  while (step > 0.001) {
    let improved = false;
    for (const key of ['shX', 'shY', 'shZ', 'elX']) {
      for (const d of [-step, step]) {
        const trial = { ...best, [key]: best[key] + d };
        const c = cost(side, target, trial.shX, trial.shY, trial.shZ, trial.elX);
        if (c < best.c) { best = { ...trial, c }; improved = true; }
      }
    }
    if (!improved) step /= 2;
  }
  return best;
}

function solve(side, target) {
  // Several starts: the current 3-DOF best, a natural-elbow guess, and
  // random restarts — coordinate descent can stick in local minima.
  const starts = [
    { shX: 0.63, shY: 0, shZ: -0.9 * side, elX: 1.96 },
    { shX: 0.6, shY: 0.3 * side, shZ: -0.4 * side, elX: 2.1 },
    { shX: 1.4, shY: 0, shZ: 0.7 * -side, elX: 0.5 },
    { shX: 1.0, shY: -0.3 * side, shZ: 0.3 * -side, elX: 1.0 },
  ];
  for (let i = 0; i < 12; i++) {
    starts.push({
      shX: Math.random() * 2.2,
      shY: (Math.random() - 0.5) * 1.6,
      shZ: (Math.random() - 0.5) * 1.8,
      elX: Math.random() * 2.4,
    });
  }
  let best = null;
  for (const s of starts) {
    const r = descend(side, target, s);
    if (!best || r.c < best.c) best = r;
  }
  const { hand, elbow } = fk(side, best.shX, best.shY, best.shZ, best.elX);
  return { ...best, hand, elbow, miss: hand.distanceTo(target) };
}

for (const side of [1, -1]) {
  const key = side === 1 ? 'R' : 'L';
  const r = solve(side, TARGETS[key]);
  console.log(`${key === 'R' ? 'Right' : 'Left '} arm (side ${side}): ` +
    `shX=${r.shX.toFixed(2)} shY=${r.shY.toFixed(2)} shZ=${r.shZ.toFixed(2)} elX=${r.elX.toFixed(2)} ` +
    `miss=${(r.miss * 100).toFixed(1)}cm ` +
    `hand=(${r.hand.x.toFixed(2)},${r.hand.y.toFixed(2)},${r.hand.z.toFixed(2)}) ` +
    `elbow=(${r.elbow.x.toFixed(2)},${r.elbow.y.toFixed(2)},${r.elbow.z.toFixed(2)})`);
}
console.log('targets: R', TARGETS.R.toArray().map((n) => n.toFixed(2)).join(','),
  ' L', TARGETS.L.toArray().map((n) => n.toFixed(2)).join(','));

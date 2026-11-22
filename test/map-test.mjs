// map-test.mjs — unit tests for the shared map module (collision, floors).
// Run: node test/map-test.mjs

import assert from 'node:assert/strict';
import {
  HOUSES,
  SPAWNS,
  COLLIDERS,
  floorHeightAt,
  resolveCollision,
  objectiveContains,
  visualBoxes,
  stairRamps,
} from '../public/map.js';

let n = 0;
function check(label, fn) {
  fn();
  n++;
  console.log(`ok ${n} - ${label}`);
}

check('10 houses, 5 per side', () => {
  assert.equal(HOUSES.length, 10);
  assert.equal(HOUSES.filter((h) => h.side < 0).length, 5);
  assert.equal(HOUSES.filter((h) => h.side > 0).length, 5);
});

check('alleys between houses on the same side are 4 m wide', () => {
  for (const side of [-1, 1]) {
    const zs = HOUSES.filter((h) => h.side === side).map((h) => h.cz).sort((a, b) => a - b);
    for (let i = 1; i < zs.length; i++) {
      assert.equal(zs[i] - zs[i - 1], 16); // 12 m house + 4 m alley
    }
  }
});

check('6 spawn points per role', () => {
  assert.equal(SPAWNS.attackers.length, 6);
  assert.equal(SPAWNS.defenders.length, 6);
  assert.ok(SPAWNS.attackers.every((s) => s.z === -55));
  assert.ok(SPAWNS.defenders.every((s) => s.z === 55));
});

check('colliders and visual geometry exist', () => {
  // 6 colliders per house x 10 houses + 4 boundary walls = 64.
  assert.equal(COLLIDERS.length, 64);
  assert.ok(visualBoxes().length > 100);
  assert.equal(stairRamps().length, 10);
});

check('floor height is 0 outside houses', () => {
  assert.equal(floorHeightAt(0, 0, 0), 0);
  assert.equal(floorHeightAt(0, -55, 0), 0);
  assert.equal(floorHeightAt(17, 0, 0), 0);
});

check('floor height inside a house follows the current floor', () => {
  // West house at cz=0: interior centre is (-11, 0).
  assert.equal(floorHeightAt(-11, 0, 0), 0);
  assert.equal(floorHeightAt(-11, 0, 3), 3);
});

check('stairs interpolate from 0 to 3', () => {
  // West house cz=0: stair strip x -15.5..-13.5, z -4..+2.
  assert.equal(floorHeightAt(-14.5, -4, 0), 0);
  assert.equal(floorHeightAt(-14.5, -1, 0), 1.5);
  assert.equal(floorHeightAt(-14.5, 2, 0), 3);
});

check('open street has no collision push', () => {
  const out = resolveCollision(0, 0, 0);
  assert.equal(out.x, 0);
  assert.equal(out.z, 0);
});

check('a point inside a wall is pushed out', () => {
  // North wall of the west house at cz=0 sits at z=-6.
  const out = resolveCollision(-11, -6, 0);
  assert.ok(Math.abs(out.z - -6) >= 0.4, `expected push out of wall, got z=${out.z}`);
});

check('door gap is passable on the ground floor', () => {
  // Door of the west house at cz=0: x=-6, z=0, y=0.
  const out = resolveCollision(-6, 0, 0);
  assert.ok(Math.abs(out.x - -6) < 0.01 && Math.abs(out.z) < 0.01,
    `door should be open at ground level, got ${JSON.stringify(out)}`);
});

check('door gap is blocked on the second floor (header)', () => {
  const out = resolveCollision(-6, 0, 3);
  assert.ok(Math.abs(out.x - -6) >= 0.4, `header should block at y=3, got ${JSON.stringify(out)}`);
});

check('windows on the alley-facing walls (north/south)', () => {
  const boxes = visualBoxes();
  const covered = (x, y, z) => boxes.some(
    (b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1);
  // West house at cz=0: north wall at z=-6. Window band x -15.3..-13.7.
  assert.equal(covered(-14.5, 1.6, -6), false, 'ground-floor north window should be a gap');
  assert.equal(covered(-14.5, 4.6, -6), false, 'upper north window should be a gap');
  assert.equal(covered(-11, 1.6, -6), true, 'wall between windows stays solid');
  assert.equal(covered(-14.5, 0.5, -6), true, 'wall below the window stays solid');
  // South wall mirrors it (z=+6).
  assert.equal(covered(-14.5, 1.6, 6), false, 'ground-floor south window should be a gap');
  // Back wall (x=-16) has no windows.
  assert.equal(covered(-16, 1.6, 0), true, 'back wall stays solid');
});

check('objective zone detection', () => {
  assert.equal(objectiveContains(0, 52), true);
  assert.equal(objectiveContains(2, 53), true);
  assert.equal(objectiveContains(0, 40), false);
  assert.equal(objectiveContains(0, -52), false);
});

console.log(`map tests passed (${n} checks)`);

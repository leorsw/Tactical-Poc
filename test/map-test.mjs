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

check('6 houses, 3 per side', () => {
  assert.equal(HOUSES.length, 6);
  assert.equal(HOUSES.filter((h) => h.side < 0).length, 3);
  assert.equal(HOUSES.filter((h) => h.side > 0).length, 3);
});

check('6 spawn points per role', () => {
  assert.equal(SPAWNS.attackers.length, 6);
  assert.equal(SPAWNS.defenders.length, 6);
  assert.ok(SPAWNS.attackers.every((s) => s.z === -55));
  assert.ok(SPAWNS.defenders.every((s) => s.z === 55));
});

check('colliders and visual geometry exist', () => {
  // 6 colliders per house x 6 houses + 4 boundary walls = 40.
  assert.equal(COLLIDERS.length, 40);
  assert.ok(visualBoxes().length > 100);
  assert.equal(stairRamps().length, 6);
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

check('objective zone detection', () => {
  assert.equal(objectiveContains(0, 52), true);
  assert.equal(objectiveContains(2, 53), true);
  assert.equal(objectiveContains(0, 40), false);
  assert.equal(objectiveContains(0, -52), false);
});

console.log(`map tests passed (${n} checks)`);

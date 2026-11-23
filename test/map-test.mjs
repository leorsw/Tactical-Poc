// map-test.mjs — unit tests for the shared map module (collision, floors).
// Run: node test/map-test.mjs

import assert from 'node:assert/strict';
import {
  HOUSES,
  SPAWNS,
  OBJECTIVE,
  GROUND_WINDOWS,
  COLLIDERS,
  spawnLayout,
  climbFadeAt,
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

check('spawnLayout: all 4 side combinations, 6 spawns per role, correct ends', () => {
  for (const atkSide of [-1, 1]) {
    for (const defSide of [-1, 1]) {
      const layout = spawnLayout(atkSide, defSide);
      assert.equal(layout.attackers.length, 6);
      assert.equal(layout.defenders.length, 6);
      assert.ok(layout.attackers.every((s) => s.z === -45));
      assert.ok(layout.defenders.every((s) => s.z === 45));
      // Attackers cluster around atkSide*11 (x 8..14 or -14..-8), defenders
      // around defSide*11 — behind the end houses, off the street axis.
      const atkX = layout.attackers.map((s) => s.x);
      const defX = layout.defenders.map((s) => s.x);
      assert.ok(atkX.every((x) => x >= atkSide * 11 - 3 && x <= atkSide * 11 + 3));
      assert.ok(defX.every((x) => x >= defSide * 11 - 3 && x <= defSide * 11 + 3));
      assert.ok(layout.attackers.every((s) => s.yaw === Math.PI));
      assert.ok(layout.defenders.every((s) => s.yaw === 0));
    }
  }
  // Canonical SPAWNS export = attackers west, defenders east.
  assert.deepEqual(SPAWNS.attackers, spawnLayout(-1, 1).attackers);
  assert.deepEqual(SPAWNS.defenders, spawnLayout(-1, 1).defenders);
});

check('spawn points are clear of colliders and on open ground (all 4 layouts)', () => {
  for (const atkSide of [-1, 1]) {
    for (const defSide of [-1, 1]) {
      const layout = spawnLayout(atkSide, defSide);
      for (const role of ['attackers', 'defenders']) {
        for (const s of layout[role]) {
          const out = resolveCollision(s.x, s.z, 0);
          assert.equal(out.x, s.x);
          assert.equal(out.z, s.z);
          assert.equal(floorHeightAt(s.x, s.z, 0), 0);
        }
      }
    }
  }
});

check('objective is the defenders spawn centre in every layout', () => {
  for (const atkSide of [-1, 1]) {
    for (const defSide of [-1, 1]) {
      const layout = spawnLayout(atkSide, defSide);
      assert.equal(layout.objective.x, defSide * 11);
      assert.equal(layout.objective.z, 45);
      assert.equal(layout.objective.r, 3.5);
      // Every defender spawn point sits inside the objective zone.
      for (const s of layout.defenders) assert.equal(objectiveContains(s.x, s.z, layout.objective), true);
      // No attacker spawn point is inside it.
      for (const s of layout.attackers) assert.equal(objectiveContains(s.x, s.z, layout.objective), false);
      // The zone must not reach the street on either side.
      assert.equal(objectiveContains(6, 45, layout.objective), false, 'zone must not reach the street (east)');
      assert.equal(objectiveContains(-6, 45, layout.objective), false, 'zone must not reach the street (west)');
    }
  }
  // Canonical OBJECTIVE export matches the canonical layout.
  assert.deepEqual(OBJECTIVE, spawnLayout(-1, 1).objective);
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

check('grey floor inside each house', () => {
  const boxes = visualBoxes();
  const covered = (x, y, z) => boxes.some(
    (b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1);
  // Inside the west house at cz=0: the floor covers the footprint.
  assert.equal(covered(-11, 0.01, 0), true, 'house interior has a floor');
  // The street has no floor box (green ground plane only).
  assert.equal(covered(0, 0.01, 0), false, 'street has no floor box');
});

check('objective zone detection', () => {
  assert.equal(objectiveContains(11, 45), true);
  assert.equal(objectiveContains(12, 46), true);
  assert.equal(objectiveContains(6, 45), false, 'zone must not reach the street');
  assert.equal(objectiveContains(0, 52), false, 'old road objective is gone');
  assert.equal(objectiveContains(0, -52), false);
});

check('ground-floor windows: 60, vault landings clear', () => {
  assert.equal(GROUND_WINDOWS.length, 60);
  // Every window's vault landing (0.75 m past the plane, both sides) must
  // be free of colliders, or the climb would push the player back.
  for (const w of GROUND_WINDOWS) {
    for (const side of [-1, 1]) {
      const px = w.axis === 'x' ? w.plane + side * 0.75 : w.center;
      const pz = w.axis === 'x' ? w.center : w.plane + side * 0.75;
      const out = resolveCollision(px, pz, 0);
      assert.equal(out.x, px, `window ${JSON.stringify(w)} side ${side}: x pushed`);
      assert.equal(out.z, pz, `window ${JSON.stringify(w)} side ${side}: z pushed`);
    }
  }
});

check('window-climb fade: 0 at the plane, 1 at 0.75 m, window-only', () => {
  // West end house (cz -32), north wall plane z -38, window at x -14.5.
  assert.equal(climbFadeAt(-14.5, -38), 0);
  assert.equal(climbFadeAt(-14.5, -38.375), 0.5);
  assert.equal(climbFadeAt(-14.5, -38.75), 1, 'collision distance: no fade');
  assert.equal(climbFadeAt(-14.5, -39.5), 1);
  assert.equal(climbFadeAt(-11, -38), 1, 'at the plane but not in a window');
  assert.equal(climbFadeAt(0, 0), 1, 'street centre');
  // Street-side window: west house street wall x -6, window at z -35.5.
  assert.equal(climbFadeAt(-6, -35.5), 0);
  assert.equal(climbFadeAt(-6.375, -35.5), 0.5);
});

console.log(`map tests passed (${n} checks)`);

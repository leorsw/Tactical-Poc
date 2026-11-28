// map-test.mjs — unit tests for the shared map module (collision, floors).
// Run: node test/map-test.mjs

import assert from 'node:assert/strict';
import {
  HOUSES,
  SPAWNS,
  OBJECTIVE,
  GROUND_WINDOWS,
  COLLIDERS,
  LAYOUTS,
  WALL_COLOR,
  getLayout,
  spawnLayout,
  climbFadeAt,
  floorHeightAt,
  resolveCollision,
  objectiveContains,
  visualBoxes,
  stairRamps,
  hasLineOfSight,
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
  // West house cz=0: stair strip x -15.5..-13.5, z -2.5..+1 (27/11/2026,
  // post-v41 item 9: was z -4..+2 — a 3.5 m flight, not a 6 m ramp).
  assert.equal(floorHeightAt(-14.5, -2.5, 0), 0);
  assert.equal(floorHeightAt(-14.5, -0.75, 0), 1.5);
  assert.equal(floorHeightAt(-14.5, 1, 0), 3);
});

check('stairs are steep flights, not ramps', () => {
  // Post-v41 item 9: 3.5 m run for a 3 m rise (~40.6°, was 26.6°).
  for (const s of stairRamps()) {
    assert.equal(s.run, 3.5, `flight run is 3.5 m, got ${s.run}`);
    assert.equal(s.rise, 3, `flight rise is 3 m, got ${s.rise}`);
  }
  for (const s of stairRamps(LAYOUTS.large)) {
    assert.equal(s.run, 3.5, `large flight run is 3.5 m, got ${s.run}`);
    assert.equal(s.rise, 3, `large flight rise is 3 m, got ${s.rise}`);
  }
});

check('second flight sits on the opposite wall from the first (item 11)', () => {
  // Post-v41 item 11: in the tall houses the floor 2->3 flight moved
  // from the adjacent strip (towards the centre) to the opposite
  // (front/street-facing) wall, so the player must cross floor 2 to
  // climb on. Same z range and +z ascent as the first flight.
  const tall = getLayout('large').houses.filter((h) => h.floors === 3);
  assert.equal(tall.length, 2, `expected 2 tall houses, got ${tall.length}`);
  for (const h of tall) {
    assert.ok(h.stair2, `tall house #${h.number} has no stair2`);
    const mid1 = (h.stair.x0 + h.stair.x1) / 2 - h.cx;
    const mid2 = (h.stair2.x0 + h.stair2.x1) / 2 - h.cx;
    assert.ok(Math.sign(mid1) !== Math.sign(mid2),
      `house #${h.number}: stair2 must mirror stair about cx (stair ${mid1.toFixed(1)}, stair2 ${mid2.toFixed(1)})`);
    assert.equal(h.stair2.z0, h.stair.z0, `house #${h.number}: stair2 z0`);
    assert.equal(h.stair2.z1, h.stair.z1, `house #${h.number}: stair2 z1`);
    assert.equal(h.stair2.x1 - h.stair2.x0, 2, `house #${h.number}: stair2 is 2 m wide`);
  }
});

check('every wall box tags its inward face (item 12)', () => {
  // Post-v41 item 12: the client renders a plain-plaster lining on the
  // inward face of every wall box — uniform plaster indoors, the v7
  // patch outside only. Every WALL_COLOR box must carry inward in
  // {px, nx, pz, nz}, pointing at the house centre.
  for (const name of ['small', 'large']) {
    const boxes = visualBoxes(getLayout(name));
    const walls = boxes.filter((b) => b.color === WALL_COLOR);
    assert.ok(walls.length > 0, `${name}: no wall boxes`);
    for (const b of walls) {
      assert.ok(['px', 'nx', 'pz', 'nz'].includes(b.inward),
        `${name}: wall box ${JSON.stringify(b)} has no inward tag`);
    }
  }
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
  // Back wall (x=-16) has windows too (v41): gaps at cz +/- 3.5, solid
  // between them (z=0) and below/above the windows.
  assert.equal(covered(-16, 1.6, -3.5), false, 'ground-floor back window should be a gap');
  assert.equal(covered(-16, 4.6, -3.5), false, 'upper back window should be a gap');
  assert.equal(covered(-16, 1.6, 0), true, 'back wall between windows stays solid');
  assert.equal(covered(-16, 0.5, -3.5), true, 'back wall below the window stays solid');
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

check('ground-floor windows: 80 (v41: back-wall pair added), vault landings clear', () => {
  assert.equal(GROUND_WINDOWS.length, 80);
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

check('line of sight: clear street, windows and doors pass', () => {
  // Open street, eye to torso.
  assert.equal(hasLineOfSight(0, 1.6, 0, 0, 1.2, 20), true);
  // Out of a ground-floor window (west house cz=0, window at z=-3.5).
  assert.equal(hasLineOfSight(-6.8, 1.6, -3.5, 0, 1.2, -3.5), true);
  // Out of an upper window (eye 4.6, target torso 4.2).
  assert.equal(hasLineOfSight(-6.8, 4.6, -3.5, 0, 4.2, -3.5), true);
  // Through a doorway (door gap below 2.2, z=0).
  assert.equal(hasLineOfSight(-6.8, 1.6, 0, 0, 1.2, 0), true);
  // Through two windows: house to house across the street.
  assert.equal(hasLineOfSight(-6.8, 1.6, -3.5, 6.8, 1.2, -3.5), true);
});

check('line of sight: solid walls block', () => {
  // North wall of the west house (cz=0) at z=-6, x=-11 is a solid band.
  assert.equal(hasLineOfSight(-11, 1.6, -3, -11, 1.6, -20), false);
  // Street wall between window and door (z=-1.5 is a solid band).
  assert.equal(hasLineOfSight(-6.8, 1.6, -1.5, 0, 1.2, -1.5), false);
  // Back wall (x=-16) is solid full height — even though the ray enters
  // through the door gap first.
  assert.equal(hasLineOfSight(0, 1.6, 0, -17, 1.2, 0), false);
});

check('line of sight: blind spot under an upper window, slab blocks', () => {
  // Upper window down to a player right below it: the ray crosses the
  // solid band between the windows (y 2.2..4.0).
  assert.equal(hasLineOfSight(-6.8, 4.6, -3.5, -5, 1.2, -3.5), false);
  // Upper floor to ground floor inside the same house: the second-floor
  // slab (y 2.8..3.0) is in the way.
  assert.equal(hasLineOfSight(-6.8, 4.6, -3.5, -11, 1.2, 0), false);
});

// ---------------------------------------------------------------------------
// v41: layouts, large map, back windows, tall houses, overlay
// ---------------------------------------------------------------------------

check('getLayout: known names resolve, anything else falls back to small', () => {
  assert.equal(getLayout('small'), LAYOUTS.small);
  assert.equal(getLayout('large'), LAYOUTS.large);
  assert.equal(getLayout('nope'), LAYOUTS.small);
  assert.equal(getLayout(), LAYOUTS.small);
  assert.equal(getLayout(null), LAYOUTS.small);
  assert.equal(getLayout('LARGE'), LAYOUTS.small, 'names are case-sensitive');
});

check('large layout: 20 houses, right numbering per quarter', () => {
  const large = LAYOUTS.large;
  assert.equal(large.houses.length, 20);
  assert.deepEqual(large.houses.map((h) => h.number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const quarter = (h) => (h.cz < 0 ? (h.cx > 0 ? 'NE' : 'NW') : (h.cx > 0 ? 'SE' : 'SW'));
  assert.deepEqual(large.houses.filter((h) => quarter(h) === 'NE').map((h) => h.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(large.houses.filter((h) => quarter(h) === 'NW').map((h) => h.number), [6, 7, 8, 9, 10]);
  assert.deepEqual(large.houses.filter((h) => quarter(h) === 'SE').map((h) => h.number), [11, 12, 13, 14, 15]);
  assert.deepEqual(large.houses.filter((h) => quarter(h) === 'SW').map((h) => h.number), [16, 17, 18, 19, 20]);
  // N-S houses keep the small-map pitch and footprint; E-W houses are
  // rotated 90 degrees (12 wide along x, 10 deep along z).
  for (const h of large.houses) {
    if (h.facing === 'ns') {
      assert.equal(h.x1 - h.x0, 10);
      assert.equal(h.z1 - h.z0, 12);
    } else {
      assert.equal(h.x1 - h.x0, 12);
      assert.equal(h.z1 - h.z0, 10);
    }
  }
  assert.equal(large.houses.filter((h) => h.facing === 'ns').length, 12);
  assert.equal(large.houses.filter((h) => h.facing === 'ew').length, 8);
  // Bounds enclose houses + roads + spawns with a 6 m margin.
  assert.deepEqual(large.bounds, { x0: -50, x1: 50, z0: -66, z1: 66 });
  assert.equal(LAYOUTS.small.bounds.x1, 18, 'small bounds unchanged');
});

check('corner houses 3/8/13/18 sit at the cross', () => {
  const byNumber = new Map(LAYOUTS.large.houses.map((h) => [h.number, h]));
  assert.deepEqual([byNumber.get(3).cx, byNumber.get(3).cz], [11, -16]);
  assert.deepEqual([byNumber.get(8).cx, byNumber.get(8).cz], [-11, -16]);
  assert.deepEqual([byNumber.get(13).cx, byNumber.get(13).cz], [11, 16]);
  assert.deepEqual([byNumber.get(18).cx, byNumber.get(18).cz], [-11, 16]);
  // Each corner house's inner face meets the first E-W house's inner face.
  assert.equal(byNumber.get(4).x0, 16, 'house 4 starts where house 3 ends');
  assert.equal(byNumber.get(9).x1, -16, 'house 9 ends where house 8 starts');
  assert.equal(byNumber.get(14).x0, 16, 'house 14 starts where house 13 ends');
  assert.equal(byNumber.get(19).x1, -16, 'house 19 ends where house 18 starts');
  // Overlay flags the same four houses as corners.
  const corners = LAYOUTS.large.overlay.houses.filter((h) => h.corner).map((h) => h.number);
  assert.deepEqual(corners, [3, 8, 13, 18]);
  assert.equal(LAYOUTS.small.overlay.houses.filter((h) => h.corner).length, 0);
});

check('tall houses #8/#13: 3 floors, second stair flight, 9 m walls', () => {
  const byNumber = new Map(LAYOUTS.large.houses.map((h) => [h.number, h]));
  for (const n of [8, 13]) {
    const h = byNumber.get(n);
    assert.equal(h.floors, 3);
    assert.ok(h.stair2, `house ${n} has a second flight`);
  }
  // #8 (west): stair1 x -15.5..-13.5 (back wall), stair2 the opposite
  // strip -8.5..-6.5 (front/street wall, 27/11/2026 post-v41 item 11).
  assert.deepEqual(byNumber.get(8).stair2, { x0: -8.5, x1: -6.5, z0: -18.5, z1: -15 });
  // #13 (east): stair1 x 13.5..15.5, stair2 6.5..8.5.
  assert.deepEqual(byNumber.get(13).stair2, { x0: 6.5, x1: 8.5, z0: 13.5, z1: 17 });
  // Every other large house is 2 floors with no second flight.
  for (const h of LAYOUTS.large.houses) {
    if (h.number !== 8 && h.number !== 13) {
      assert.equal(h.floors, 2, `house ${h.number} is 2 floors`);
      assert.equal(h.stair2, null, `house ${h.number} has no stair2`);
    }
  }
  // Floor height inside #8 follows all three floors + the second flight.
  const L = LAYOUTS.large;
  assert.equal(floorHeightAt(-11, -16, 0, L), 0);
  assert.equal(floorHeightAt(-11, -16, 3, L), 3);
  assert.equal(floorHeightAt(-11, -16, 5, L), 6, 'above 4.5 m: floor 3');
  assert.equal(floorHeightAt(-7.5, -18.5, 3, L), 3, 'stair2 bottom');
  assert.equal(floorHeightAt(-7.5, -16.75, 3, L), 4.5, 'stair2 middle');
  assert.equal(floorHeightAt(-7.5, -15, 3, L), 6, 'stair2 top');
  // 2-floor houses are unaffected by the 4.5 m rule.
  assert.equal(floorHeightAt(-11, -32, 5, L), 3, '2-floor house caps at 3');
  // Roof at y 9 on tall houses, y 6 elsewhere (visual boxes).
  const boxes = visualBoxes(L);
  const covered = (x, y, z) => boxes.some(
    (b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1);
  assert.equal(covered(-11, 9.1, -16), true, 'tall house roof at y 9');
  assert.equal(covered(-11, 6.1, -32), true, 'normal house roof at y 6');
  // Floor-3 windows are gaps on the tall houses (street wall, x=-6).
  assert.equal(covered(-6, 7.6, -19.5), false, 'floor-3 street window is a gap');
  assert.equal(covered(-6, 6.5, -19.5), true, 'wall below the floor-3 window stays solid');
});

check('stairs catch only players on the flight\'s own floors (item 26)', () => {
  // 28/11/2026, fix-list item 26: the old floorHeightAt returned the
  // flight height from (x,z) alone, so a player on the ground floor
  // walking under stair2 (3->6) got lifted to floor 3, and a player on
  // floor 3 walking over stair1 (0->3) got dropped to the ground.
  // House #8 (west, cx=-11, cz=-16, large map): stair1 x -15.5..-13.5,
  // stair2 x -8.5..-6.5, both z -18.5..-15.
  const L = LAYOUTS.large;
  assert.equal(floorHeightAt(-7.5, -16.75, 0, L), 0, 'ground under stair2 stays on the ground');
  assert.equal(floorHeightAt(-14.5, -16.75, 6, L), 6, 'floor 3 over stair1 stays on floor 3');
  assert.equal(floorHeightAt(-14.5, -16.75, 3, L), 1.5, 'floor 2 over stair1 descends onto the flight');
  assert.equal(floorHeightAt(-7.5, -16.75, 6, L), 4.5, 'floor 3 over stair2 descends onto the flight');
  assert.equal(floorHeightAt(-7.5, -18.5, 3, L), 3, 'floor 2 at the stair2 base starts the climb');
  assert.equal(floorHeightAt(-14.5, -18.5, 0, L), 0, 'ground at the stair1 base starts the climb');
});

check('back windows: visual-box count grows by 8 per house', () => {
  // Small: 10 houses x 44 boxes + 4 fence = 444 (was 354 with a solid
  // back wall: 10 x 35 + 4). Large: 12 ns x 44 + 8 ew x 43 + 2 tall
  // extra (8 window-band pieces + 4 floor-3 slab pieces) + 4 fence = 900.
  assert.equal(visualBoxes().length, 444);
  assert.equal(visualBoxes(LAYOUTS.large).length, 900);
});

check('overlay data present for both layouts', () => {
  for (const [name, layout] of [['small', LAYOUTS.small], ['large', LAYOUTS.large]]) {
    const o = layout.overlay;
    assert.deepEqual(o.fence, layout.bounds, `${name}: fence = bounds`);
    assert.equal(o.houses.length, layout.houses.length, `${name}: one entry per house`);
    for (const oh of o.houses) {
      const h = layout.houses.find((hh) => hh.number === oh.number);
      assert.equal(oh.x, h.cx, `${name} #${oh.number}: x is the centre`);
      assert.equal(oh.z, h.cz, `${name} #${oh.number}: z is the centre`);
      assert.equal(oh.w, h.x1 - h.x0, `${name} #${oh.number}: w along x`);
      assert.equal(oh.d, h.z1 - h.z0, `${name} #${oh.number}: d along z`);
      assert.equal(oh.tall, h.floors === 3, `${name} #${oh.number}: tall flag`);
    }
  }
  // Small: one road (the N-S street). Large: two roads crossing.
  assert.deepEqual(LAYOUTS.small.overlay.roads,
    [{ x0: -6.3, z0: -62, x1: 6.3, z1: 62 }]);
  assert.deepEqual(LAYOUTS.large.overlay.roads, [
    { x0: -6.3, z0: -66, x1: 6.3, z1: 66 },
    { x0: -50, z0: -6.3, x1: 50, z1: 6.3 },
  ]);
});

check('tallSpawns: defenders inside the tall building, attackers at the opposite end', () => {
  const ts = LAYOUTS.large.tallSpawns;
  assert.ok(ts, 'large layout has tallSpawns');
  assert.equal(LAYOUTS.small.tallSpawns, undefined, 'small layout has none');
  for (const [num, house] of [[8, { cx: -11, cz: -16 }], [13, { cx: 11, cz: 16 }]]) {
    const t = ts[num];
    assert.equal(t.defenders.length, 6, `#${num}: 6 defender points`);
    assert.equal(t.attackers.length, 6, `#${num}: 6 attacker points`);
    // Defenders are inside the building, on open ground, clear of the stairs.
    for (const s of t.defenders) {
      assert.ok(Math.abs(s.x - house.cx) <= 4.5 && Math.abs(s.z - house.cz) <= 5.5,
        `#${num} defender inside the building: ${JSON.stringify(s)}`);
      const out = resolveCollision(s.x, s.z, 0, 0.4, LAYOUTS.large);
      assert.equal(out.x, s.x, `#${num} defender clear: ${JSON.stringify(s)}`);
      assert.equal(out.z, s.z, `#${num} defender clear: ${JSON.stringify(s)}`);
      assert.equal(floorHeightAt(s.x, s.z, 0, LAYOUTS.large), 0);
    }
    // Objective is the top floor of that building.
    assert.deepEqual(t.objective, { x: house.cx, z: house.cz, r: 3.5, yMin: 6 });
  }
  // Opposite ends: #8's attackers at the SE end (z +60), #13's at the NW end.
  assert.ok(ts[8].attackers.every((s) => s.z === 60 && s.x > 0), '#8 attackers at SE end');
  assert.ok(ts[8].attackers.every((s) => s.yaw === 0), '#8 attackers face north');
  assert.ok(ts[13].attackers.every((s) => s.z === -60 && s.x < 0), '#13 attackers at NW end');
  assert.ok(ts[13].attackers.every((s) => s.yaw === Math.PI), '#13 attackers face south');
  // Attackers sit inside the objective-style end zone, defenders do not.
  assert.ok(ts[8].attackers.every((s) => objectiveContains(s.x, s.z, { x: 11, z: 60, r: 3.5 })));
});

check('layout-parameterised functions agree with the no-arg versions (small)', () => {
  const L = LAYOUTS.small;
  assert.deepEqual(visualBoxes(L), visualBoxes());
  assert.deepEqual(stairRamps(L), stairRamps());
  assert.deepEqual(spawnLayout(-1, 1, L), spawnLayout(-1, 1));
  assert.deepEqual(spawnLayout(1, -1, 'small'), spawnLayout(1, -1));
  assert.deepEqual(resolveCollision(-11, -6, 0, 0.4, L), resolveCollision(-11, -6, 0));
  assert.equal(floorHeightAt(-14.5, -1, 0, L), floorHeightAt(-14.5, -1, 0));
  assert.equal(climbFadeAt(-14.5, -38, L), climbFadeAt(-14.5, -38));
  assert.equal(hasLineOfSight(0, 1.6, 0, 0, 1.2, 20, L), hasLineOfSight(0, 1.6, 0, 0, 1.2, 20));
  // A layout name string works too.
  assert.equal(floorHeightAt(-11, -16, 3, 'large'), 3, 'large house interior, floor 2');
});

check('large layout: spawns clear, objective clear of the street, 160 ground windows', () => {
  const L = LAYOUTS.large;
  assert.equal(L.colliders.length, 124, '20 houses x 6 + 4 boundary');
  assert.equal(L.groundWindows.length, 160, '20 houses x 8');
  assert.equal(stairRamps(L).length, 22, '20 first flights + 2 second flights');
  for (const atkSide of [-1, 1]) {
    for (const defSide of [-1, 1]) {
      const layout = spawnLayout(atkSide, defSide, L);
      assert.ok(layout.attackers.every((s) => s.z === -60));
      assert.ok(layout.defenders.every((s) => s.z === 60));
      assert.equal(layout.objective.z, 60);
      assert.equal(layout.objective.r, 3.5);
      for (const role of ['attackers', 'defenders']) {
        for (const s of layout[role]) {
          const out = resolveCollision(s.x, s.z, 0, 0.4, L);
          assert.equal(out.x, s.x, `large spawn clear: ${JSON.stringify(s)}`);
          assert.equal(out.z, s.z, `large spawn clear: ${JSON.stringify(s)}`);
          assert.equal(floorHeightAt(s.x, s.z, 0, L), 0);
        }
      }
      assert.equal(objectiveContains(6, 60, layout.objective), false, 'zone must not reach the street');
      assert.equal(objectiveContains(-6, 60, layout.objective), false, 'zone must not reach the street');
    }
  }
  // Every large ground window's vault landing is clear of colliders.
  for (const w of L.groundWindows) {
    for (const side of [-1, 1]) {
      const px = w.axis === 'x' ? w.plane + side * 0.75 : w.center;
      const pz = w.axis === 'x' ? w.center : w.plane + side * 0.75;
      const out = resolveCollision(px, pz, 0, 0.4, L);
      assert.equal(out.x, px, `large window ${JSON.stringify(w)} side ${side}: x pushed`);
      assert.equal(out.z, pz, `large window ${JSON.stringify(w)} side ${side}: z pushed`);
    }
  }
});

check('large layout: E-W house doors, floors, stairs, line of sight', () => {
  const L = LAYOUTS.large;
  // House #4 (E-W, cx 22, cz -11.3): door on the street wall z=-6.3.
  const door = resolveCollision(22, -6.3, 0, 0.4, L);
  assert.ok(Math.abs(door.x - 22) < 0.01 && Math.abs(door.z - -6.3) < 0.01,
    `E-W door passable at ground level, got ${JSON.stringify(door)}`);
  const blocked = resolveCollision(22, -6.3, 3, 0.4, L);
  assert.ok(Math.abs(blocked.z - -6.3) >= 0.4, `E-W door header blocks at y=3, got ${JSON.stringify(blocked)}`);
  // Floor height inside #4 follows the current floor; stairs run along x.
  assert.equal(floorHeightAt(22, -11.3, 0, L), 0);
  assert.equal(floorHeightAt(22, -11.3, 3, L), 3);
  assert.equal(floorHeightAt(20.25, -15.3, 0, L), 0, 'E-W stair bottom');
  assert.equal(floorHeightAt(22, -15.3, 0, L), 1.5, 'E-W stair middle');
  assert.equal(floorHeightAt(23.75, -15.3, 0, L), 3, 'E-W stair top');
  // Line of sight: out of #4's door onto the E-W road, and blocked
  // through the solid band next to the door.
  assert.equal(hasLineOfSight(22, 1.6, -11.3, 22, 1.2, 0, L), true, 'through the E-W door');
  assert.equal(hasLineOfSight(24, 1.6, -11.3, 24, 1.2, 0, L), false, 'solid band blocks');
  // Out of #4's back-wall window (z=-16.3, window at x=25.5).
  assert.equal(hasLineOfSight(25.5, 1.6, -11.3, 25.5, 1.2, -25, L), true, 'through the back window');
  // Per-layout LOS cache: this ray is clear on the small map (open
  // ground east of the street) but blocked on the large map (house #5).
  assert.equal(hasLineOfSight(30, 1.6, -11.3, 45, 1.2, -11.3), true, 'small: open ground');
  assert.equal(hasLineOfSight(30, 1.6, -11.3, 45, 1.2, -11.3, L), false, 'large: E-W house blocks');
});

check('NPC window-spot inventory covers the per-map count (fix-list item 32)', () => {
  // Same spot formula as the server's drawNpcSet: per house, two z
  // offsets x two floors.
  for (const [name, count] of [['small', 10], ['large', 20]]) {
    const L = getLayout(name);
    const spots = L.houses.length * 2 * 2;
    assert.ok(spots >= count, `${name}: ${spots} spots must cover ${count} NPCs`);
  }
  assert.equal(getLayout('small').houses.length, 10);
  assert.equal(getLayout('large').houses.length, 20);
});

check('spawnLayout on the large layout uses the large ends (fix-list item 31)', () => {
  const layout = spawnLayout(-1, 1, getLayout('large'));
  assert.ok(layout.attackers.every((s) => s.z === -60), 'large attackers spawn at z = -60');
  assert.ok(layout.defenders.every((s) => s.z === 60), 'large defenders spawn at z = 60');
});

console.log(`map tests passed (${n} checks)`);

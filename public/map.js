// map.js — shared map definition for the tactical FPS POC.
//
// This module is intentionally free of any Three.js or browser dependency so
// it can be imported both by the browser client and by the Node server.
// It is the single source of truth for:
//   - house layout (positions, doors, windows, stairs)
//   - movement collision (AABB colliders with height ranges)
//   - floor height (ground floor vs second floor vs stairs)
//   - spawn points and the objective zone
//
// Coordinate system: the N-S street runs along the Z axis (z = -60..+60),
// X is across the street (x = -18..+18 on the small map). Y is up. Ground
// level is y = 0, the second floor is y = 3, the third floor (large map
// tall houses only) is y = 6.
//
// Two layouts (v41):
//   - "small": the original 10-house street (default; every existing
//     export and every no-argument call is bound to this layout).
//   - "large": a 20-house crossroads — two asphalt roads (N-S + E-W),
//     four quarters of five houses each (see buildLargeHouses below).
// Every function that used to read the small map takes an optional final
// `layout` argument (a layout object, or a layout name string); omitting
// it behaves exactly as before.

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.7;
export const FLOOR2_Y = 3;
export const FLOOR3_Y = 6; // tall houses (large map only): floor-3 feet height

export const OBJECTIVE_R = 3.5;

// ---------------------------------------------------------------------------
// Houses
// ---------------------------------------------------------------------------
// House fields (both facings):
//   cx, cz       centre. x0/x1/z0/z1 outer footprint, ix0..iz1 interior
//                (inside the 0.3 m walls).
//   side         -1 = west of the N-S road (x negative), +1 = east.
//   number       map number (see the layout builders for the scheme).
//   floors       2, or 3 for the tall houses.
//   stair        first flight {x0,x1,z0,z1}: ground -> floor 2.
//   stair2       second flight {x0,x1,z0,z1} (floor 2 -> floor 3), or null.
//   facing       'ns' = the street-facing wall is an x-plane facing the
//                N-S road (as on the small map); 'ew' = the street-facing
//                wall is a z-plane facing the E-W road (large map only).
//   Footprint is always 10 x 12 m with the 12 m facade facing its street:
//   'ns' houses are 10 wide (x) by 12 deep (z); 'ew' houses are 12 wide
//   (x) by 10 deep (z).

function nsHouse(cx, cz, side, number, tall = false) {
  const floors = tall ? 3 : 2;
  // Stairs: a 2 m wide strip along the back wall, 3.5 m long in z,
  // ascending towards +z from y=0 to y=3 (27/11/2026, post-v41 item 9:
  // the old 6 m ramp (26.6°) is now a 3.5 m flight (40.6°) rendered as
  // real steps — see stairSteps() in main.js. The climb itself needs
  // no code: floorHeightAt interpolates over the strip, and movement
  // has no slope limit.)
  const stair = {
    x0: side < 0 ? cx - 4.5 : cx + 2.5,
    x1: side < 0 ? cx - 2.5 : cx + 4.5,
    z0: cz - 2.5,
    z1: cz + 1,
  };
  // Second flight (tall houses only): the adjacent 2 m strip towards the
  // house centre, same z range, ascending +z from y=3 to y=6.
  const stair2 = tall
    ? {
        x0: side < 0 ? cx - 2.5 : cx + 0.5,
        x1: side < 0 ? cx - 0.5 : cx + 2.5,
        z0: cz - 2.5,
        z1: cz + 1,
      }
    : null;
  return {
    cx,
    cz,
    side, // -1 = west (x negative), +1 = east
    number,
    floors,
    stair,
    stair2,
    facing: 'ns',
    x0: cx - 5,
    x1: cx + 5,
    z0: cz - 6,
    z1: cz + 6,
    ix0: cx - 5 + 0.15,
    ix1: cx + 5 - 0.15,
    iz0: cz - 6 + 0.15,
    iz1: cz + 6 - 0.15,
  };
}

function ewHouse(cx, cz, number) {
  // 'ew' house: 12 m wide (x) by 10 m deep (z). The street-facing wall is
  // the z-plane on the E-W-road side (south wall for houses north of the
  // road, north wall for houses south of it); the back wall is the
  // opposite z-plane. side is still east (+1) / west (-1) of the N-S road.
  const northOfRoad = cz < 0;
  const backZ = northOfRoad ? cz - 5 : cz + 5;
  // Stairs: a 2 m wide strip along the back wall, 3.5 m long in x,
  // ascending towards +x from y=0 to y=3 (27/11/2026, post-v41 item 9:
  // was 6 m — see nsHouse).
  const stair = {
    x0: cx - 1.75,
    x1: cx + 1.75,
    z0: northOfRoad ? backZ : backZ - 2,
    z1: northOfRoad ? backZ + 2 : backZ,
  };
  return {
    cx,
    cz,
    side: cx > 0 ? 1 : -1, // -1 = west (x negative), +1 = east
    number,
    floors: 2,
    stair,
    stair2: null,
    facing: 'ew',
    x0: cx - 6,
    x1: cx + 6,
    z0: cz - 5,
    z1: cz + 5,
    ix0: cx - 6 + 0.15,
    ix1: cx + 6 - 0.15,
    iz0: cz - 5 + 0.15,
    iz1: cz + 5 - 0.15,
  };
}

// Street plane / back plane of a house, by facing.
function streetPlane(h) {
  return h.facing === 'ns' ? h.side * 6 : h.cz < 0 ? h.z1 : h.z0;
}
function backPlane(h) {
  return h.facing === 'ns' ? h.side * 16 : h.cz < 0 ? h.z0 : h.z1;
}

// Small map houses: 5 per side of the street, centred at x = +/-11,
// z = -32 / -16 / 0 / +16 / +32. Each house is 10 m wide (x) by 12 m deep
// (z), 6 m tall (two 3 m floors), so adjacent houses leave a 4 m alley
// between them. House numbers (map only): facing north (up the map),
// odd on the right (east, x = +11), even on the left (west, x = -11),
// increasing south to north — east 1, 3, 5, 7, 9; west 2, 4, 6, 8, 10.
function buildSmallHouses() {
  const houses = [];
  for (const side of [-1, 1]) {
    for (const cz of [-32, -16, 0, 16, 32]) {
      const cx = side * 11;
      const idx = (32 - cz) / 16; // 0 (southernmost) .. 4 (northernmost)
      houses.push(nsHouse(cx, cz, side, 2 * idx + (side > 0 ? 1 : 2)));
    }
  }
  return houses;
}

// Large map houses (see the scheme image
// street-scheme-20-houses-v2-2026-11-27.png): two asphalt roads cross —
// the N-S road is the current street geometry (road x +/-6.3), the E-W
// road is the same width (12.6 m) centred on z = 0. Four quarters, five
// houses each; numbering per quarter increases away from the cross:
//   NE 1-5:  #1 (11,-48), #2 (11,-32), #3 (11,-16, corner),
//            #4 (22,-11.3), #5 (38,-11.3)   [E-W houses]
//   NW 6-10: #6 (-11,-48), #7 (-11,-32), #8 (-11,-16, corner, TALL),
//            #9 (-22,-11.3), #10 (-38,-11.3)
//   SE 11-15: #11 (11,48), #12 (11,32), #13 (11,16, corner, TALL),
//            #14 (22,11.3), #15 (38,11.3)
//   SW 16-20: #16 (-11,48), #17 (-11,32), #18 (-11,16, corner),
//            #19 (-22,11.3), #20 (-38,11.3)
// N-S houses keep the small-map pitch (12 m deep + 4 m alley = 16 m) and
// sit at cx = +/-11, so the corner house's inner face (x = +/-16) meets
// the first E-W house's inner face (x = +/-16) exactly at the cross.
// E-W houses are 12 m wide (x) + 4 m alley = 16 m pitch, centred
// z = -/+11.3 so their street wall sits on the road edge (z = -/+6.3).
// Fence: outermost extent + 6 m — houses reach x +/-44, spawns reach
// z +/-60, so the fence is x +/-50, z +/-66.
function buildLargeHouses() {
  const houses = [];
  // N-S houses: [number, cx, cz, tall].
  for (const [number, cx, cz, tall] of [
    [1, 11, -48, false], [2, 11, -32, false], [3, 11, -16, false],
    [6, -11, -48, false], [7, -11, -32, false], [8, -11, -16, true],
    [11, 11, 48, false], [12, 11, 32, false], [13, 11, 16, true],
    [16, -11, 48, false], [17, -11, 32, false], [18, -11, 16, false],
  ]) {
    houses.push(nsHouse(cx, cz, cx > 0 ? 1 : -1, number, tall));
  }
  // E-W houses: [number, cx, cz].
  for (const [number, cx, cz] of [
    [4, 22, -11.3], [5, 38, -11.3],
    [9, -22, -11.3], [10, -38, -11.3],
    [14, 22, 11.3], [15, 38, 11.3],
    [19, -22, 11.3], [20, -38, 11.3],
  ]) {
    houses.push(ewHouse(cx, cz, number));
  }
  houses.sort((a, b) => a.number - b.number);
  return houses;
}

// ---------------------------------------------------------------------------
// Spawns
// ---------------------------------------------------------------------------
// Spawn layout: each round, each team independently draws a random side of
// the street (west x = -11 or east x = +11) — 4 combinations. The ends stay
// fixed: attackers north (facing +z, yaw = PI), defenders south (facing -z,
// yaw = 0). Spawn points sit behind the end houses, hidden from the street.
// The objective is always the defenders' spawn centre (r = 3.5 keeps the
// zone behind the house: the nearest street point (x = 6) is 5 m from the
// centre, so attackers must leave the street).
// Yaw follows the Three.js convention: forward = (-sin(yaw), 0, -cos(yaw)).
// Small map ends: z = -45 / +45 (houses reach z +/-38, fence +/-62).
// Large map ends: z = -60 / +60 (end houses reach z +/-54, fence +/-66),
// so the objective zone (r 3.5, reaching z 56.5) stays clear of the houses.
const SPAWN_X = 11;
const SPAWN_DX = [-3, -1.8, -0.6, 0.6, 1.8, 3];

export function spawnLayout(atkSide, defSide, layout) {
  const l = resolveLayout(layout);
  const spawnZ = l.spawnZ;
  const mk = (role, side) => SPAWN_DX.map((dx) => ({
    x: side * SPAWN_X + dx,
    z: spawnZ[role],
    yaw: role === 'attackers' ? Math.PI : 0,
  }));
  return {
    attackers: mk('attackers', atkSide),
    defenders: mk('defenders', defSide),
    objective: { x: defSide * SPAWN_X, z: spawnZ.defenders, r: OBJECTIVE_R },
    // Attackers' spawn centre (shown on the map as a blue X).
    attackersSpawn: { x: atkSide * SPAWN_X, z: spawnZ.attackers },
  };
}

// Tall-building spawns (large map only): defenders hold the tall building
// itself, attackers start at the OPPOSITE end of the map.
//   #8 (NW, cx -11, cz -16): defenders 6 points inside the building,
//     attackers 6 points at the SE end (x ~ +11, z = +60, facing north),
//     objective = the top floor (yMin = 6, the floor-3 feet height).
//   #13 (SE, cx +11, cz +16): mirrored — defenders inside #13, attackers
//     at the NW end (x ~ -11, z = -60, facing south).
// Defender points avoid both stair strips; yaw faces the attackers' end.
// NOTE: objectiveContains() is 2D only — callers must also check the
// player's feet height is >= objective.yMin for tall objectives.
function buildTallSpawns() {
  const mkAttackers = (side, z, yaw) => SPAWN_DX.map((dx) => ({
    x: side * SPAWN_X + dx,
    z,
    yaw,
  }));
  return {
    8: {
      defenders: [
        { x: -10.5, z: -19, yaw: Math.PI }, { x: -8, z: -19, yaw: Math.PI },
        { x: -7, z: -19, yaw: Math.PI }, { x: -10.5, z: -13, yaw: Math.PI },
        { x: -8, z: -13, yaw: Math.PI }, { x: -7, z: -13, yaw: Math.PI },
      ],
      attackers: mkAttackers(1, 60, 0),
      objective: { x: -11, z: -16, r: OBJECTIVE_R, yMin: FLOOR3_Y },
    },
    13: {
      defenders: [
        { x: 7, z: 13, yaw: 0 }, { x: 8, z: 13, yaw: 0 },
        { x: 10.5, z: 13, yaw: 0 }, { x: 7, z: 19, yaw: 0 },
        { x: 8, z: 19, yaw: 0 }, { x: 10.5, z: 19, yaw: 0 },
      ],
      attackers: mkAttackers(-1, -60, Math.PI),
      objective: { x: 11, z: 16, r: OBJECTIVE_R, yMin: FLOOR3_Y },
    },
  };
}

// ---------------------------------------------------------------------------
// Ground-floor windows, for the climb-through feature (client only).
// Each window: the wall plane (axis + coordinate) and the center/half-width
// along the wall. Ground floor only (windows at y 1.0..2.2); upper-floor
// windows (y 4.0..5.2, 7.0..8.2) are not climbable. 8 per house:
// 2 street + 2 north/south (or east/west) + 2 back — the back-wall pair
// (v41) makes the rear a climbable entry, like the other faces.
// Small map: 10 houses x 8 = 80 windows. Large map: 20 houses x 8 = 160.
function buildGroundWindows(houses) {
  const list = [];
  for (const h of houses) {
    if (h.facing === 'ns') {
      const streetX = streetPlane(h);
      const backX = backPlane(h);
      for (const wz of [h.cz - 3.5, h.cz + 3.5]) {
        list.push({ axis: 'x', plane: streetX, center: wz, half: 0.8 });
        list.push({ axis: 'x', plane: backX, center: wz, half: 0.8 });
      }
      for (const wz of [h.z0, h.z1]) {
        for (const wx of [h.cx - 3.5, h.cx + 3.5]) {
          list.push({ axis: 'z', plane: wz, center: wx, half: 0.8 });
        }
      }
    } else {
      const streetZ = streetPlane(h);
      const backZ = backPlane(h);
      for (const wx of [h.cx - 3.5, h.cx + 3.5]) {
        list.push({ axis: 'z', plane: streetZ, center: wx, half: 0.8 });
        list.push({ axis: 'z', plane: backZ, center: wx, half: 0.8 });
      }
      for (const wx of [h.x0, h.x1]) {
        for (const wz of [h.cz - 3.5, h.cz + 3.5]) {
          list.push({ axis: 'x', plane: wx, center: wz, half: 0.8 });
        }
      }
    }
  }
  return list;
}

// Window-climb fade (client only): how visible a figure at (x, z) is to
// other players — 1 = fully visible, 0 = fully merged into the wall.
// Within 0.75 m of a window's wall plane, inside the window opening along
// the wall, visibility ramps linearly with the distance from the plane
// (0 at the plane, 1 at 0.75 m out). A walking player can never get that
// close — collision stops them ~0.75 m from the plane — so this only
// fires while climbing through, and only the crossing figure fades.
// Purely positional: no protocol change, no server involvement.
export const CLIMB_FADE_DIST = 0.75;
export function climbFadeAt(x, z, layout) {
  const windows = resolveLayout(layout).groundWindows;
  let fade = 1;
  for (const w of windows) {
    let d;
    let along;
    if (w.axis === 'x') { d = Math.abs(x - w.plane); along = Math.abs(z - w.center); }
    else { d = Math.abs(z - w.plane); along = Math.abs(x - w.center); }
    if (along <= w.half && d < CLIMB_FADE_DIST) fade = Math.min(fade, d / CLIMB_FADE_DIST);
  }
  return fade;
}

// ---------------------------------------------------------------------------
// Movement collision
// ---------------------------------------------------------------------------
// Colliders are 2D boxes in (x, z) with a height range [y0, y1]. A collider
// only blocks a player whose body (y .. y + PLAYER_HEIGHT) overlaps that
// range. This is what makes doors work: the door header (y 2.2..top)
// blocks a player standing on the second floor, while a player on the
// ground floor (body 0..1.8) walks through the gap underneath it.
//
// Windows are NOT gaps in movement collision: the street wall is solid for
// movement except for the door. Bullets use the visual meshes (which do have
// window gaps), so you can shoot through a window but not walk through one.
// 6 colliders per house + 4 boundary walls (small: 64, large: 124).

function buildColliders(houses, bounds) {
  const list = [];
  const T = 0.15; // half wall thickness (walls are 0.3 m thick)

  for (const h of houses) {
    const topY = h.floors * 3;
    if (h.facing === 'ns') {
      // North and south walls (full height).
      list.push({ x0: h.x0, x1: h.x1, z0: h.z0 - T, z1: h.z0 + T, y0: 0, y1: topY });
      list.push({ x0: h.x0, x1: h.x1, z0: h.z1 - T, z1: h.z1 + T, y0: 0, y1: topY });
      // Back wall (full height). Back is x = +/-16.
      const backX = backPlane(h);
      list.push({ x0: backX - T, x1: backX + T, z0: h.z0, z1: h.z1, y0: 0, y1: topY });
      // Street-facing wall (x = +/-6), split around the 1.2 m door gap.
      const streetX = streetPlane(h);
      list.push({ x0: streetX - T, x1: streetX + T, z0: h.z0, z1: h.cz - 0.6, y0: 0, y1: topY });
      list.push({ x0: streetX - T, x1: streetX + T, z0: h.cz + 0.6, z1: h.z1, y0: 0, y1: topY });
      // Door header: blocks only players above ground level.
      list.push({ x0: streetX - T, x1: streetX + T, z0: h.cz - 0.6, z1: h.cz + 0.6, y0: 2.2, y1: topY });
    } else {
      // East and west walls (full height).
      list.push({ x0: h.x0 - T, x1: h.x0 + T, z0: h.z0, z1: h.z1, y0: 0, y1: topY });
      list.push({ x0: h.x1 - T, x1: h.x1 + T, z0: h.z0, z1: h.z1, y0: 0, y1: topY });
      // Back wall (full height): the z-plane away from the E-W road.
      const backZ = backPlane(h);
      list.push({ x0: h.x0, x1: h.x1, z0: backZ - T, z1: backZ + T, y0: 0, y1: topY });
      // Street-facing wall (z = -/+6.3), split around the 1.2 m door gap.
      const streetZ = streetPlane(h);
      list.push({ x0: h.x0, x1: h.cx - 0.6, z0: streetZ - T, z1: streetZ + T, y0: 0, y1: topY });
      list.push({ x0: h.cx + 0.6, x1: h.x1, z0: streetZ - T, z1: streetZ + T, y0: 0, y1: topY });
      // Door header: blocks only players above ground level.
      list.push({ x0: h.cx - 0.6, x1: h.cx + 0.6, z0: streetZ - T, z1: streetZ + T, y0: 2.2, y1: topY });
    }
  }

  // Outer boundary walls.
  list.push({ x0: bounds.x0 - 0.15, x1: bounds.x0 + 0.15, z0: bounds.z0, z1: bounds.z1, y0: 0, y1: 6 });
  list.push({ x0: bounds.x1 - 0.15, x1: bounds.x1 + 0.15, z0: bounds.z0, z1: bounds.z1, y0: 0, y1: 6 });
  list.push({ x0: bounds.x0, x1: bounds.x1, z0: bounds.z0 - 0.15, z1: bounds.z0 + 0.15, y0: 0, y1: 6 });
  list.push({ x0: bounds.x0, x1: bounds.x1, z0: bounds.z1 - 0.15, z1: bounds.z1 + 0.15, y0: 0, y1: 6 });
  return list;
}

// ---------------------------------------------------------------------------
// Map overlay (client only): the data the in-game map (M key) draws from,
// in game coordinates. roads: asphalt rects; houses: centre, footprint
// (w = width along x, d = depth along z), number, corner (the four houses
// at the cross: 3, 8, 13, 18 on the large map), tall (3-story houses).
// fence: the boundary rect (= the layout bounds).
function buildOverlay(name, houses, bounds) {
  const roads = [{ x0: -6.3, z0: bounds.z0, x1: 6.3, z1: bounds.z1 }];
  if (name === 'large') {
    roads.push({ x0: bounds.x0, z0: -6.3, x1: bounds.x1, z1: 6.3 });
  }
  return {
    roads,
    houses: houses.map((h) => ({
      x: h.cx,
      z: h.cz,
      w: h.x1 - h.x0,
      d: h.z1 - h.z0,
      number: h.number,
      corner: name === 'large' && [3, 8, 13, 18].includes(h.number),
      tall: h.floors === 3,
    })),
    fence: { x0: bounds.x0, z0: bounds.z0, x1: bounds.x1, z1: bounds.z1 },
  };
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------
// Each layout: { name, houses, bounds, colliders, groundWindows, spawns,
// objectiveR, overlay, spawnX, spawnZ } — spawns is the canonical
// spawnLayout(-1, 1) result for that layout. The large layout also has
// tallSpawns (see buildTallSpawns). spawnX/spawnZ are the spawn geometry
// spawnLayout() reads; everything else is the layout's data.
function buildLayout(name, houses, bounds, spawnZ) {
  const layout = {
    name,
    houses,
    bounds,
    colliders: buildColliders(houses, bounds),
    groundWindows: buildGroundWindows(houses),
    objectiveR: OBJECTIVE_R,
    overlay: buildOverlay(name, houses, bounds),
    spawnX: SPAWN_X,
    spawnZ,
  };
  layout.spawns = spawnLayout(-1, 1, layout);
  return layout;
}

export const LAYOUTS = {
  small: buildLayout(
    'small',
    buildSmallHouses(),
    { x0: -18, x1: 18, z0: -62, z1: 62 },
    { attackers: -45, defenders: 45 },
  ),
  large: buildLayout(
    'large',
    buildLargeHouses(),
    { x0: -50, x1: 50, z0: -66, z1: 66 },
    { attackers: -60, defenders: 60 },
  ),
};
LAYOUTS.large.tallSpawns = buildTallSpawns();

// Returns LAYOUTS[name], or the small layout for anything else
// (unknown name, undefined, null).
export function getLayout(name) {
  return LAYOUTS[name] || LAYOUTS.small;
}

// Accepts a layout object, a layout name string, or nothing (small).
function resolveLayout(layout) {
  if (!layout) return LAYOUTS.small;
  if (typeof layout === 'string') return getLayout(layout);
  return layout;
}

// Small-layout aliases: every pre-v41 export stays bound to the small
// layout, so existing call sites keep working unchanged.
export const BOUNDS = LAYOUTS.small.bounds;
export const HOUSES = LAYOUTS.small.houses;
export const COLLIDERS = LAYOUTS.small.colliders;
export const GROUND_WINDOWS = LAYOUTS.small.groundWindows;
export const SPAWNS = LAYOUTS.small.spawns;
export const OBJECTIVE = LAYOUTS.small.spawns.objective;

// Push a circle (player) out of every collider it overlaps. Returns a new
// {x, z}. `y` is the player's current feet height.
export function resolveCollision(x, z, y, radius = PLAYER_RADIUS, layout) {
  const colliders = resolveLayout(layout).colliders;
  let px = x;
  let pz = z;
  const bodyTop = y + PLAYER_HEIGHT;
  // Two passes are enough for corners where two walls meet.
  for (let pass = 0; pass < 2; pass++) {
    for (const c of colliders) {
      if (bodyTop <= c.y0 || y >= c.y1) continue; // no height overlap
      const closestX = Math.max(c.x0, Math.min(px, c.x1));
      const closestZ = Math.max(c.z0, Math.min(pz, c.z1));
      const dx = px - closestX;
      const dz = pz - closestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq >= radius * radius) continue;
      if (distSq > 1e-9) {
        const dist = Math.sqrt(distSq);
        const push = (radius - dist) / dist;
        px += dx * push;
        pz += dz * push;
      } else {
        // Centre is inside the box: push out along the smallest penetration.
        const pushLeft = px - c.x0 + radius;
        const pushRight = c.x1 - px + radius;
        const pushNorth = pz - c.z0 + radius;
        const pushSouth = c.z1 - pz + radius;
        const m = Math.min(pushLeft, pushRight, pushNorth, pushSouth);
        if (m === pushLeft) px = c.x0 - radius;
        else if (m === pushRight) px = c.x1 + radius;
        else if (m === pushNorth) pz = c.z0 - radius;
        else pz = c.z1 + radius;
      }
    }
  }
  return { x: px, z: pz };
}

// Stair interpolation parameter (0 at the bottom, 1 at the top) along the
// flight's long axis — z for 'ns' houses, x for 'ew' houses.
function stairT(s, x, z) {
  if (s.x1 - s.x0 >= s.z1 - s.z0) return (x - s.x0) / (s.x1 - s.x0);
  return (z - s.z0) / (s.z1 - s.z0);
}

// Floor height at a position. `currentY` is the player's current feet height
// and disambiguates "standing on the second floor" from "standing under it"
// inside a house: above 1.5 m you are on the upper floor, below it you are
// on the ground floor (above 4.5 m: the third floor, tall houses only).
// On the stairs the height interpolates smoothly; the second flight
// (stair2) interpolates from 3 to 6.
export function floorHeightAt(x, z, currentY, layout) {
  const houses = resolveLayout(layout).houses;
  for (const h of houses) {
    if (x < h.ix0 || x > h.ix1 || z < h.iz0 || z > h.iz1) continue;
    if (h.stair2) {
      const s2 = h.stair2;
      if (x >= s2.x0 && x <= s2.x1 && z >= s2.z0 && z <= s2.z1) {
        const t = Math.max(0, Math.min(1, stairT(s2, x, z)));
        return FLOOR2_Y + FLOOR2_Y * t;
      }
    }
    const s = h.stair;
    if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) {
      const t = Math.max(0, Math.min(1, stairT(s, x, z)));
      return FLOOR2_Y * t;
    }
    if (h.floors === 3) return currentY > 4.5 ? FLOOR3_Y : currentY > 1.5 ? FLOOR2_Y : 0;
    return currentY > 1.5 ? FLOOR2_Y : 0;
  }
  return 0;
}

// True when a point is inside the objective zone (defaults to the
// canonical zone; the server passes the current round's zone).
// 2D only: for a tall objective (with yMin) the caller must also check
// the player's feet height is >= zone.yMin.
export function objectiveContains(x, z, zone = OBJECTIVE) {
  const dx = x - zone.x;
  const dz = z - zone.z;
  return dx * dx + dz * dz <= zone.r * zone.r;
}

// ---------------------------------------------------------------------------
// Visual geometry (client only, but derived here so art matches collision)
// ---------------------------------------------------------------------------
// Returns a list of solid boxes {x0,y0,z0,x1,y1,z1,color} describing every
// house wall (with door and window gaps), floor slabs and roof.
// Colors are plain numbers so this stays Three.js free; the client turns
// them into materials.

export const WALL_COLOR = 0x9a9a9a;
export const FENCE_COLOR = 0x8a8a8a; // boundary fence only (v7, 27/11/2026)
const FLOOR_COLOR = 0x7a7a7a; // grey floor inside each house
const SLAB_COLOR = 0x8f8f8f;
const ROOF_COLOR = 0x7d7d7d;

// One wall of a house: a plane at `plane` (axis 'x' = x-plane running
// along z, axis 'z' = z-plane running along x), spanning [from, to]
// along the wall, with two windows per floor at `winCenters` (1.6 m
// wide: centre +/- 0.8) and an optional 1.2 m door at `doorCenter`.
// Window openings are y 1.0..2.2 (ground), 4.0..5.2 (floor 2),
// 7.0..8.2 (floor 3); solid bands fill below, between and above them.
// topY is the wall height (6, or 9 for tall houses).
function pushWall(boxes, axis, plane, from, to, winCenters, doorCenter, topY, floors) {
  const T = 0.15;
  const cuts = [from, to];
  for (const c of winCenters) cuts.push(c - 0.8, c + 0.8);
  if (doorCenter != null) cuts.push(doorCenter - 0.6, doorCenter + 0.6);
  cuts.sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-9) continue;
    const mid = (a + b) / 2;
    let kind = 'full';
    for (const c of winCenters) if (Math.abs(mid - c) < 0.8) kind = 'window';
    if (doorCenter != null && Math.abs(mid - doorCenter) < 0.6) kind = 'door';
    const box = (y0, y1) => (axis === 'x'
      ? { x0: plane - T, x1: plane + T, z0: a, z1: b, y0, y1, color: WALL_COLOR }
      : { x0: a, x1: b, z0: plane - T, z1: plane + T, y0, y1, color: WALL_COLOR });
    if (kind === 'full') {
      boxes.push(box(0, topY));
    } else if (kind === 'door') {
      // Only the header above the 2.2 m door.
      boxes.push(box(2.2, topY));
    } else {
      // Window band: solid below each window, between the windows, and
      // above the top window.
      for (let f = 0; f < floors; f++) {
        boxes.push(box(f === 0 ? 0 : 2.2 + 3 * (f - 1), 1 + 3 * f));
      }
      boxes.push(box(2.2 + 3 * (floors - 1), topY));
    }
  }
}

// A floor slab at height yTop (top surface), 0.2 m thick, covering the
// house interior except for the stair opening `stair` (may be null).
function pushSlab(boxes, h, stair, yTop) {
  const slab = (x0, x1, z0, z1) => {
    if (x1 - x0 < 1e-9 || z1 - z0 < 1e-9) return;
    boxes.push({ x0, x1, z0, z1, y0: yTop - 0.2, y1: yTop, color: SLAB_COLOR });
  };
  if (!stair) {
    slab(h.ix0, h.ix1, h.iz0, h.iz1);
    return;
  }
  slab(h.ix0, stair.x0, h.iz0, h.iz1); // strip on one side of the opening
  slab(stair.x1, h.ix1, h.iz0, h.iz1); // strip on the other side
  slab(stair.x0, stair.x1, stair.z1, h.iz1); // beyond the opening
  slab(stair.x0, stair.x1, h.iz0, stair.z0); // before the opening
}

export function visualBoxes(layout) {
  const l = resolveLayout(layout);
  const boxes = [];
  const T = 0.15;

  for (const h of l.houses) {
    const topY = h.floors * 3;
    if (h.facing === 'ns') {
      // North / south walls (facing the neighbouring houses / alleys):
      // two windows per floor. Back wall: two windows per floor as well
      // (v41 — the back wall is no longer solid).
      for (const wz of [h.z0, h.z1]) {
        pushWall(boxes, 'z', wz, h.x0, h.x1, [h.cx - 3.5, h.cx + 3.5], null, topY, h.floors);
      }
      pushWall(boxes, 'x', backPlane(h), h.z0, h.z1, [h.cz - 3.5, h.cz + 3.5], null, topY, h.floors);
      // Street-facing wall, with the door and two windows per floor.
      pushWall(boxes, 'x', streetPlane(h), h.z0, h.z1, [h.cz - 3.5, h.cz + 3.5], h.cz, topY, h.floors);
    } else {
      // East / west walls: two windows per floor.
      for (const wx of [h.x0, h.x1]) {
        pushWall(boxes, 'x', wx, h.z0, h.z1, [h.cz - 3.5, h.cz + 3.5], null, topY, h.floors);
      }
      // Back wall (away from the E-W road): two windows per floor.
      pushWall(boxes, 'z', backPlane(h), h.x0, h.x1, [h.cx - 3.5, h.cx + 3.5], null, topY, h.floors);
      // Street-facing wall (towards the E-W road), with the door and two
      // windows per floor.
      pushWall(boxes, 'z', streetPlane(h), h.x0, h.x1, [h.cx - 3.5, h.cx + 3.5], h.cx, topY, h.floors);
    }

    // Ground-floor floor: a thin grey slab over the green ground plane.
    boxes.push({ x0: h.ix0, x1: h.ix1, z0: h.iz0, z1: h.iz1, y0: 0, y1: 0.02, color: FLOOR_COLOR });

    // Second-floor slab (top surface at y = 3), with the stair opening cut out.
    pushSlab(boxes, h, h.stair, FLOOR2_Y);
    // Tall houses: third-floor slab (top surface at y = 6), with the
    // second-flight opening cut out.
    if (h.floors === 3) pushSlab(boxes, h, h.stair2, FLOOR3_Y);

    // Flat roof.
    boxes.push({ x0: h.x0 - T, x1: h.x1 + T, z0: h.z0 - T, z1: h.z1 + T, y0: topY, y1: topY + 0.25, color: ROOF_COLOR });
  }

  // Low boundary walls (visual only; movement colliders already exist).
  const b = l.bounds;
  boxes.push({ x0: b.x0 - 0.15, x1: b.x0 + 0.15, z0: b.z0, z1: b.z1, y0: 0, y1: 2, color: FENCE_COLOR });
  boxes.push({ x0: b.x1 - 0.15, x1: b.x1 + 0.15, z0: b.z0, z1: b.z1, y0: 0, y1: 2, color: FENCE_COLOR });
  boxes.push({ x0: b.x0, x1: b.x1, z0: b.z0 - 0.15, z1: b.z0 + 0.15, y0: 0, y1: 2, color: FENCE_COLOR });
  boxes.push({ x0: b.x0, x1: b.x1, z0: b.z1 - 0.15, z1: b.z1 + 0.15, y0: 0, y1: 2, color: FENCE_COLOR });
  return boxes;
}

// Stair ramps for the client to render as sloped boxes. One entry per
// flight: flight 1 rises from y0 = 0, flight 2 (tall houses) from y0 = 3;
// width is the flight's short side, run its long side, rise is 3 m.
export function stairRamps(layout) {
  const houses = resolveLayout(layout).houses;
  const ramps = [];
  for (const h of houses) {
    const mk = (s, flight, y0) => ({
      cx: (s.x0 + s.x1) / 2,
      cz: (s.z0 + s.z1) / 2,
      width: Math.min(s.x1 - s.x0, s.z1 - s.z0),
      run: Math.max(s.x1 - s.x0, s.z1 - s.z0),
      rise: FLOOR2_Y,
      y0,
      flight,
      // The ramp ascends along the strip's long side: +z for N-S houses,
      // +x for E-W houses (the client builds the slanted mesh from this).
      axis: (s.z1 - s.z0) >= (s.x1 - s.x0) ? 'z' : 'x',
    });
    ramps.push(mk(h.stair, 1, 0));
    if (h.stair2) ramps.push(mk(h.stair2, 2, FLOOR2_Y));
  }
  return ramps;
}

// ---------------------------------------------------------------------------
// Line of sight
// ---------------------------------------------------------------------------
// True when nothing blocks the straight line from eye point A to target
// point B. The occluders are the visual boxes — walls WITH real window
// and door gaps — so a ray through a window opening (y 1.0..2.2 ground,
// 4.0..5.2 upper, 7.0..8.2 floor 3) or a doorway (below 2.2) passes,
// while a ray through solid wall, a floor slab or a roof is blocked.
// That also gives the blind spot under an upper window for free: a ray
// from an upper window down to a player standing right below it crosses
// the solid band between the windows (y 2.2..4.0).
//
// The server uses this for NPC fire decisions (an NPC only opens fire
// when it can see its target); the client could reuse it for the same
// reason. The box list is built once per layout and cached — visualBoxes()
// is ~300-900 boxes, and a burst-start check touches each of them once.
const LOS_BOXES_BY_LAYOUT = new Map();
export function hasLineOfSight(ax, ay, az, bx, by, bz, layout) {
  const l = resolveLayout(layout);
  let boxes = LOS_BOXES_BY_LAYOUT.get(l.name);
  if (!boxes) {
    boxes = visualBoxes(l);
    LOS_BOXES_BY_LAYOUT.set(l.name, boxes);
  }
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  for (const b of boxes) {
    // Slab method: the t-range [tmin, tmax] where the ray is inside the
    // box. Any overlap with the segment [0, 1] means the ray hits it.
    let tmin = 0;
    let tmax = 1;
    let hit = true;
    for (const [o, d, lo, hi] of [[ax, dx, b.x0, b.x1], [ay, dy, b.y0, b.y1], [az, dz, b.z0, b.z1]]) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) { hit = false; break; }
      } else {
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) { hit = false; break; }
      }
    }
    if (hit) return false; // a solid box stands between A and B
  }
  return true;
}

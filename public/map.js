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
// Coordinate system: the street runs along the Z axis (z = -60..+60),
// X is across the street (x = -18..+18). Y is up. Ground level is y = 0,
// the second floor is y = 3.

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.7;
export const EYE_HEIGHT = 1.6;
export const FLOOR2_Y = 3;

export const BOUNDS = { x0: -18, x1: 18, z0: -62, z1: 62 };

// Houses: 5 per side of the street, centred at x = +/-11,
// z = -32 / -16 / 0 / +16 / +32. Each house is 10 m wide (x) by 12 m deep
// (z), 6 m tall (two 3 m floors), so adjacent houses leave a 4 m alley
// between them.
export const HOUSES = [];
for (const side of [-1, 1]) {
  for (const cz of [-32, -16, 0, 16, 32]) {
    const cx = side * 11;
    HOUSES.push({
      cx,
      cz,
      side, // -1 = west (x negative), +1 = east
      // Outer footprint.
      x0: cx - 5,
      x1: cx + 5,
      z0: cz - 6,
      z1: cz + 6,
      // Interior (inside the 0.3 m walls).
      ix0: cx - 5 + 0.15,
      ix1: cx + 5 - 0.15,
      iz0: cz - 6 + 0.15,
      iz1: cz + 6 - 0.15,
      // Stairs: a 2 m wide strip along the back wall, 6 m long in z,
      // ascending towards +z from y=0 to y=3.
      stair: {
        x0: side < 0 ? -15.5 : 13.5,
        x1: side < 0 ? -13.5 : 15.5,
        z0: cz - 4,
        z1: cz + 2,
      },
    });
  }
}

// Spawn layout: each round, each team independently draws a random side of
// the street (west x = -11 or east x = +11) — 4 combinations. The ends stay
// fixed: attackers north (z = -45, facing +z, yaw = PI), defenders south
// (z = +45, facing -z, yaw = 0). Spawn points sit behind the end houses,
// hidden from the street. The objective is always the defenders' spawn
// centre (r = 3.5 keeps the zone behind the house: the nearest street point
// (x = 6) is 5 m from the centre, so attackers must leave the street).
// Yaw follows the Three.js convention: forward = (-sin(yaw), 0, -cos(yaw)).
export const OBJECTIVE_R = 3.5;
const SPAWN_X = 11;
const SPAWN_Z = { attackers: -45, defenders: 45 };
const SPAWN_DX = [-3, -1.8, -0.6, 0.6, 1.8, 3];

export function spawnLayout(atkSide, defSide) {
  const mk = (role, side) => SPAWN_DX.map((dx) => ({
    x: side * SPAWN_X + dx,
    z: SPAWN_Z[role],
    yaw: role === 'attackers' ? Math.PI : 0,
  }));
  return {
    attackers: mk('attackers', atkSide),
    defenders: mk('defenders', defSide),
    objective: { x: defSide * SPAWN_X, z: SPAWN_Z.defenders, r: OBJECTIVE_R },
  };
}

// Canonical layout (attackers west, defenders east) — used for solo mode
// and as the pre-match default.
export const SPAWNS = spawnLayout(-1, 1);
export const OBJECTIVE = SPAWNS.objective;

// Ground-floor windows, for the climb-through feature (client only).
// Each window: the wall plane (axis + coordinate) and the center/half-width
// along the wall. Ground floor only (windows at y 1.0..2.2); upper-floor
// windows (y 4.0..5.2) are not climbable. 60 windows total:
// 10 houses x (2 street + 2 north + 2 south).
export const GROUND_WINDOWS = [];
for (const h of HOUSES) {
  const streetX = h.side * 6;
  for (const wz of [h.cz - 3.5, h.cz + 3.5]) {
    GROUND_WINDOWS.push({ axis: 'x', plane: streetX, center: wz, half: 0.8 });
  }
  for (const wz of [h.z0, h.z1]) {
    for (const wx of [h.cx - 3.5, h.cx + 3.5]) {
      GROUND_WINDOWS.push({ axis: 'z', plane: wz, center: wx, half: 0.8 });
    }
  }
}

// ---------------------------------------------------------------------------
// Movement collision
// ---------------------------------------------------------------------------
// Colliders are 2D boxes in (x, z) with a height range [y0, y1]. A collider
// only blocks a player whose body (y .. y + PLAYER_HEIGHT) overlaps that
// range. This is what makes doors work: the door header (y 2.2..6) blocks a
// player standing on the second floor, while a player on the ground floor
// (body 0..1.7) walks through the gap underneath it.
//
// Windows are NOT gaps in movement collision: the street wall is solid for
// movement except for the door. Bullets use the visual meshes (which do have
// window gaps), so you can shoot through a window but not walk through one.

function buildColliders() {
  const list = [];
  const T = 0.15; // half wall thickness (walls are 0.3 m thick)

  for (const h of HOUSES) {
    // North and south walls (full height).
    list.push({ x0: h.x0, x1: h.x1, z0: h.z0 - T, z1: h.z0 + T, y0: 0, y1: 6 });
    list.push({ x0: h.x0, x1: h.x1, z0: h.z1 - T, z1: h.z1 + T, y0: 0, y1: 6 });
    // Back wall (full height). Back is x = +/-16.
    const backX = h.side * 16;
    list.push({ x0: backX - T, x1: backX + T, z0: h.z0, z1: h.z1, y0: 0, y1: 6 });
    // Street-facing wall (x = +/-6), split around the 1.2 m door gap.
    const streetX = h.side * 6;
    list.push({ x0: streetX - T, x1: streetX + T, z0: h.z0, z1: h.cz - 0.6, y0: 0, y1: 6 });
    list.push({ x0: streetX - T, x1: streetX + T, z0: h.cz + 0.6, z1: h.z1, y0: 0, y1: 6 });
    // Door header: blocks only players above ground level.
    list.push({ x0: streetX - T, x1: streetX + T, z0: h.cz - 0.6, z1: h.cz + 0.6, y0: 2.2, y1: 6 });
  }

  // Outer boundary walls.
  list.push({ x0: -18.15, x1: -17.85, z0: -62, z1: 62, y0: 0, y1: 6 });
  list.push({ x0: 17.85, x1: 18.15, z0: -62, z1: 62, y0: 0, y1: 6 });
  list.push({ x0: -18, x1: 18, z0: -62.15, z1: -61.85, y0: 0, y1: 6 });
  list.push({ x0: -18, x1: 18, z0: 61.85, z1: 62.15, y0: 0, y1: 6 });
  return list;
}

export const COLLIDERS = buildColliders();

// Push a circle (player) out of every collider it overlaps. Returns a new
// {x, z}. `y` is the player's current feet height.
export function resolveCollision(x, z, y, radius = PLAYER_RADIUS) {
  let px = x;
  let pz = z;
  const bodyTop = y + PLAYER_HEIGHT;
  // Two passes are enough for corners where two walls meet.
  for (let pass = 0; pass < 2; pass++) {
    for (const c of COLLIDERS) {
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

// Floor height at a position. `currentY` is the player's current feet height
// and disambiguates "standing on the second floor" from "standing under it"
// inside a house: above 1.5 m you are on the upper floor, below it you are
// on the ground floor. On the stairs the height interpolates smoothly.
export function floorHeightAt(x, z, currentY) {
  for (const h of HOUSES) {
    if (x < h.ix0 || x > h.ix1 || z < h.iz0 || z > h.iz1) continue;
    const s = h.stair;
    if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) {
      const t = Math.max(0, Math.min(1, (z - s.z0) / (s.z1 - s.z0)));
      return FLOOR2_Y * t;
    }
    return currentY > 1.5 ? FLOOR2_Y : 0;
  }
  return 0;
}

// True when a point is inside the objective zone (defaults to the
// canonical zone; the server passes the current round's zone).
export function objectiveContains(x, z, zone = OBJECTIVE) {
  const dx = x - zone.x;
  const dz = z - zone.z;
  return dx * dx + dz * dz <= zone.r * zone.r;
}

// ---------------------------------------------------------------------------
// Visual geometry (client only, but derived here so art matches collision)
// ---------------------------------------------------------------------------
// Returns a list of solid boxes {x0,y0,z0,x1,y1,z1,color} describing every
// house wall (with door and window gaps), second-floor slab and roof.
// Colors are plain numbers so this stays Three.js free; the client turns
// them into materials.

const WALL_COLOR = 0x9a9a9a;
const FLOOR_COLOR = 0x7a7a7a; // grey floor inside each house
const SLAB_COLOR = 0x8f8f8f;
const ROOF_COLOR = 0x7d7d7d;

export function visualBoxes() {
  const boxes = [];
  const T = 0.15;

  for (const h of HOUSES) {
    // North / south walls (facing the neighbouring houses / alleys): two
    // windows per floor, like the street wall. The back wall stays solid.
    for (const wz of [h.z0, h.z1]) {
      const bands = [
        [h.x0, h.cx - 4.3, 'full'],
        [h.cx - 4.3, h.cx - 2.7, 'window'],
        [h.cx - 2.7, h.cx + 2.7, 'full'],
        [h.cx + 2.7, h.cx + 4.3, 'window'],
        [h.cx + 4.3, h.x1, 'full'],
      ];
      for (const [x0, x1, kind] of bands) {
        if (kind === 'full') {
          boxes.push({ x0, x1, z0: wz - T, z1: wz + T, y0: 0, y1: 6, color: WALL_COLOR });
        } else {
          // Window band: solid below the ground window, between the
          // windows, and above the upper window (y 1.0..2.2, 4.0..5.2).
          boxes.push({ x0, x1, z0: wz - T, z1: wz + T, y0: 0, y1: 1.0, color: WALL_COLOR });
          boxes.push({ x0, x1, z0: wz - T, z1: wz + T, y0: 2.2, y1: 4.0, color: WALL_COLOR });
          boxes.push({ x0, x1, z0: wz - T, z1: wz + T, y0: 5.2, y1: 6, color: WALL_COLOR });
        }
      }
    }
    const backX = h.side * 16;
    boxes.push({ x0: backX - T, x1: backX + T, z0: h.z0, z1: h.z1, y0: 0, y1: 6, color: WALL_COLOR });

    // Street-facing wall, built from z-bands so the door and the four
    // windows (two per floor) are real gaps.
    // Bands: [z0, z1, kind] where kind is 'full', 'window' or 'door'.
    const cz = h.cz;
    const bands = [
      [cz - 6, cz - 4.3, 'full'],
      [cz - 4.3, cz - 2.7, 'window'],
      [cz - 2.7, cz - 0.6, 'full'],
      [cz - 0.6, cz + 0.6, 'door'],
      [cz + 0.6, cz + 2.7, 'full'],
      [cz + 2.7, cz + 4.3, 'window'],
      [cz + 4.3, cz + 6, 'full'],
    ];
    const streetX = h.side * 6;
    for (const [z0, z1, kind] of bands) {
      if (kind === 'full') {
        boxes.push({ x0: streetX - T, x1: streetX + T, z0, z1, y0: 0, y1: 6, color: WALL_COLOR });
      } else if (kind === 'door') {
        // Only the header above the 2.2 m door.
        boxes.push({ x0: streetX - T, x1: streetX + T, z0, z1, y0: 2.2, y1: 6, color: WALL_COLOR });
      } else {
        // Window band: solid below the ground window, between the windows,
        // and above the upper window. Windows are y 1.0..2.2 and 4.0..5.2.
        boxes.push({ x0: streetX - T, x1: streetX + T, z0, z1, y0: 0, y1: 1.0, color: WALL_COLOR });
        boxes.push({ x0: streetX - T, x1: streetX + T, z0, z1, y0: 2.2, y1: 4.0, color: WALL_COLOR });
        boxes.push({ x0: streetX - T, x1: streetX + T, z0, z1, y0: 5.2, y1: 6, color: WALL_COLOR });
      }
    }

    // Ground-floor floor: a thin grey slab over the green ground plane.
    boxes.push({ x0: h.ix0, x1: h.ix1, z0: h.iz0, z1: h.iz1, y0: 0, y1: 0.02, color: FLOOR_COLOR });

    // Second-floor slab (top surface at y = 3), with the stair opening cut out.
    const s = h.stair;
    if (h.side < 0) {
      boxes.push({ x0: s.x1, x1: h.ix1, z0: h.iz0, z1: h.iz1, y0: 2.8, y1: 3.0, color: SLAB_COLOR });
      boxes.push({ x0: h.ix0, x1: s.x1, z0: s.z1, z1: h.iz1, y0: 2.8, y1: 3.0, color: SLAB_COLOR });
      boxes.push({ x0: h.ix0, x1: s.x1, z0: h.iz0, z1: s.z0, y0: 2.8, y1: 3.0, color: SLAB_COLOR });
    } else {
      boxes.push({ x0: h.ix0, x1: s.x0, z0: h.iz0, z1: h.iz1, y0: 2.8, y1: 3.0, color: SLAB_COLOR });
      boxes.push({ x0: s.x0, x1: h.ix1, z0: s.z1, z1: h.iz1, y0: 2.8, y1: 3.0, color: SLAB_COLOR });
      boxes.push({ x0: s.x0, x1: h.ix1, z0: h.iz0, z1: s.z0, y0: 2.8, y1: 3.0, color: SLAB_COLOR });
    }

    // Flat roof.
    boxes.push({ x0: h.x0 - T, x1: h.x1 + T, z0: h.z0 - T, z1: h.z1 + T, y0: 6, y1: 6.25, color: ROOF_COLOR });
  }

  // Low boundary walls (visual only; movement colliders already exist).
  boxes.push({ x0: -18.15, x1: -17.85, z0: -62, z1: 62, y0: 0, y1: 2, color: WALL_COLOR });
  boxes.push({ x0: 17.85, x1: 18.15, z0: -62, z1: 62, y0: 0, y1: 2, color: WALL_COLOR });
  boxes.push({ x0: -18, x1: 18, z0: -62.15, z1: -61.85, y0: 0, y1: 2, color: WALL_COLOR });
  boxes.push({ x0: -18, x1: 18, z0: 61.85, z1: 62.15, y0: 0, y1: 2, color: WALL_COLOR });
  return boxes;
}

// Stair ramps for the client to render as sloped boxes.
export function stairRamps() {
  return HOUSES.map((h) => ({
    cx: (h.stair.x0 + h.stair.x1) / 2,
    cz: (h.stair.z0 + h.stair.z1) / 2,
    width: h.stair.x1 - h.stair.x0,
    run: h.stair.z1 - h.stair.z0,
    rise: FLOOR2_Y,
  }));
}

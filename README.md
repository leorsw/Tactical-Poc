# Tactical POC — browser-based team FPS

A proof of concept for testing **team combat behavior under fire**: two teams
fight on one street, no respawn, limited ammo, and an objective the attackers
must reach. Built to answer one question — *is the teamwork experience worth
developing further?* — not to be a finished game.

**Stack:** Node.js + `ws` server, vanilla Three.js client (ES modules).
No build step, no TypeScript, no framework, no CDN at runtime (Three.js is
served from local `node_modules`, so the game works on a LAN without
internet).

## How to run locally

```bash
cd tactical-poc
npm install
npm start
```

Then open <http://localhost:8020> in a desktop browser.

## How to test from phones on the same WiFi

1. Make sure the phones are on the **same WiFi network** as the laptop.
2. Find the laptop's LAN IP:
   - **macOS:** `ipconfig getifaddr en0`
   - **Linux:** `ip -4 addr show` (look for `inet 192.168.x.x`)
   - **Windows:** `ipconfig` (look for "IPv4 Address")
3. On each phone, open `http://<LAN-IP>:8020` (for example
   `http://192.168.1.42:8020`). No install needed — it runs in the browser.
4. Hold the phone in **landscape**. Use the left virtual joystick to move,
   drag the right side of the screen to look, hold **FIRE** to shoot and tap
   **RELOAD** to reload.
5. If a phone cannot reach the page, check the laptop firewall: port 8020
   must be reachable on the LAN (the server listens on `0.0.0.0`).

## Troubleshooting

- **Stuck on "Connecting to server..."** — the page loaded but the game code
  did not start. Most likely Three.js is missing: in the game folder run
  `npm install` again and check that `node_modules/three/build/three.module.js`
  exists, then `npm start` and reload. Quick check: open
  `http://localhost:8020/three/three.module.js` — it should download a large JS
  file, not "Not found".
- **"Cannot reach the game server"** — the `npm start` window was closed or
  the server crashed. Start it again (`npm start` in the game folder) and
  reload the page.
- **Phones cannot reach the page** — the phone must be on the same WiFi as
  the laptop, and the laptop firewall must allow port 8020 on the LAN.

## Controls

### Desktop
| Input | Action |
|---|---|
| WASD / arrows | Move |
| Mouse | Look (click the game to capture the mouse) |
| Hold left mouse | Fire |
| Hold right mouse | Aim down the sights (tighter spread, slight zoom, slower move) |
| R | Reload (3.5 s) |
| M | Toggle map (terrain only, no player markers) |
| F | Toggle fullscreen (on iPhone Safari the button shows Add-to-Home-Screen instructions — no Fullscreen API there) |
| E | Climb through a nearby ground-floor window (a CLIMB button also appears) |
| Click (while eliminated) | Cycle spectate target |

### Mobile (touch)
| Input | Action |
|---|---|
| Left virtual joystick | Move |
| Drag right side of screen | Look |
| Hold FIRE | Fire |
| AIM button | Toggle aim down the sights |
| RELOAD button | Reload (3.5 s) |
| MAP button | Show map (terrain only, no player markers) |
| Tap look area (while eliminated) | Cycle spectate target |

## Solo mode

Alone? Click **Solo mode — explore alone** in the lobby. You spawn at the
attackers' end and can walk the whole map, shoot and reload, with no teams,
no timer and no win condition. Nobody can shoot you and you cannot shoot
anyone; a match can start alongside you while you explore. **EXIT SOLO**
(top-left) returns you to the lobby, where you can join a team normally.

## Player animation

Other players' soldiers walk: each leg hangs from a hip pivot and swings
with the distance actually travelled (one step per ~1.1 m), easing in when
a player starts moving and back to neutral when they stop. The arms stay
on the rifle. The cycle is driven by the interpolated position, so
teleports (e.g. window climbs) don't flail the legs.

## Match flow

1. **Lobby:** enter a callsign, join the Attackers or the Defenders
   (or auto-assign). The columns and join buttons are labelled by role —
   the host picks which team attacks, and the labels follow the pick.
   Teams need **not** be symmetric — 6 attackers vs 2 defenders is allowed.
   1–6 players per team; a match can start with as few as 1 player per side
   (2+ per team is recommended and the lobby says so).
2. The **first player to join is the host**. The host picks which team
   attacks. **Any** joined player can press **Start match** once both teams
   have at least 1 player (1v1 is enough).
   The first player to join **each team** is marked that team's
   **commander** (label only in v1 — no special powers).
   The host also has a **Clear room** button (lobby only, two clicks to
   confirm): it kicks every other player — teams and solo — back to the
   join screen, so a new game starts clean. Kicked players can rejoin.
   **No mid-match joins:** once a match has started, a player who has not
   joined yet waits in the lobby — the join buttons are disabled and a
   message says a match is in progress. Joins open again when the match
   ends (for the rematch) or the room returns to the lobby. A team player
   who disconnected mid-match may rejoin within 5 minutes (same callsign
   + team) and spectates until the next round. Solo mode stays available
   during a match.
   **Heartbeat:** every client pings the server every 10 seconds (in all
   states — lobby, playing, spectating, solo). A player silent for more
   than 90 seconds is removed as if disconnected — mid-match, they get
   the 5-minute rejoin grace — so a crashed tab or dead connection never
   leaves a ghost in the room.
   **Ghost takeover:** a rejoin never duplicates the player. If the old
   record is still in the room when the player comes back on a new
   connection (frozen tab, sweep hasn't run yet), the rejoin takes it
   over: immediately when the tab session matches (one stable id per
   tab, sent with every join), or after 15 seconds of silence for a
   same-callsign+team ghost. An ACTIVE same-name player is never taken
   over. The ghost's socket is terminated so the frozen client notices
   and reconnects cleanly. A rejected rejoin drops the client back to
   the lobby instead of a stuck game screen, and the client retries the
   rejoin on state updates (at most once per 2 s) until the server
   accepts.
3. **Rounds:** first team to **3 round wins** takes the match. Round timer
   is **5:00**.
   - **Attackers** win a round by eliminating all defenders **or** by
     **capturing the objective**: any living attacker must **hold the
     zone for 30 seconds** (the zone is the defenders' spawn centre; the
     attackers' end point *is* the defenders' start point). Entering the
     zone starts the hold — leaving it, or dying in it, resets the timer.
     A progress bar shows the hold to everyone (attackers see
     "CAPTURING…", defenders a warning). Reaching the zone used to end
     the round instantly, so a straight sprint won rounds in ~20 s with
     no fight — that was the "rounds end for no reason" bug (22/11/2026).
     The objective is marked with a red **X on the map only** (M) — never
     as a ground mark in the world, at Lior's request — labelled
     **לכבוש** for attackers and **להגן** for defenders.
   - **Defenders** win a round by eliminating all attackers **or** by
     surviving until the timer expires.
   - **Spawn sides are drawn fresh every round:** each team independently
     starts on the west or east side of the street (4 combinations), so
     the objective moves with the defenders' spawn.
   - **Intermission:** when a round ends, the result stays on screen with
     a **CONTINUE** button — the next round starts only when a player
     presses it. Positions, health and ammo reset. Roles stay the same
     for the whole match.
4. **No respawn.** An eliminated player spectates: the camera follows a
   living teammate (click/tap to cycle). When no teammate is alive, the
   round is already over.
5. After the match ends, **any** player can start a **Rematch** (same roles)
   or **Swap roles & rematch**. The match-end screen shows a **stats
   board** for the match: kills, deaths, teamkills, accuracy (hits /
   shots), damage dealt, and objective captures per player, sorted by
   kills then damage. Stats reset every match; players who left
   mid-match are not on the board.

## Combat rules

- Health **100**. Damage falls off with distance (shooter to target):
  - **Close (up to 15 m): 100 damage** — one hit eliminates.
  - **Medium (15–50 m): 50 damage** — two hits eliminate.
  - **Long (over 50 m): 34 damage** — three hits eliminate.
- A non-lethal hit flashes the victim's screen red for ~3 seconds.
  No health regen, no healing.
- When a player is eliminated, they see **YOU'RE DOWN** for 3 seconds
  (frozen first-person view) before switching to spectate — or to the
  round/match-end screen, if the round ended. A teamkill adds a
  **FRIENDLY FIRE** line under it (the killfeed also flags teamkills).
- **Name tags are teammates-only** — the enemy team sees no tag — and a
  tag behind a wall is hidden by the wall (normal depth testing).
- **6 magazines × 29 rounds.** Reloading takes **3.5 s** and you cannot fire
  while reloading. No pistol, no other weapon. A player out of ammo can
  still move and observe but cannot fire. There is **no auto-reload**: when
  a magazine runs out, nothing happens until you press R (desktop) or the
  RELOAD button (mobile).
- Hitscan rifle, hold to fire at ~10 rounds/sec. Spread is wide from the
  hip and tight when aiming down the sights. There is **no crosshair** by
  design: the rifle hangs lowered while moving, and aiming raises it so the
  reflex sight (rounded square, red dot) sits on the centre of the screen. Each shot kicks the rifle
  and flashes the muzzle; hits on walls show a brief impact marker.
- Friendly fire is **ON**: a hit from anyone on anyone kills, including teammates (shown as TEAMKILL in the kill feed). No extra penalty beyond losing the teammate.
- The server is authoritative for health, ammo, score, timer and win
  conditions. Clients simulate their own movement and send shot claims;
  the server validates them (shooter/target alive, ammo left, fire-rate
  plausible) before applying damage.

## The map

One street (~120 m) along the Z axis with **10 grey-box houses**, 5 per
side, with **4 m alleys** between adjacent houses. Each house has an
enterable ground floor (door gap in the street-facing wall, grey floor),
windows on three faces (street + both alley sides) on the ground and
second floors, and interior stairs to the second floor. Each team spawns
behind the end houses at opposite far ends of the street, marked by a
painted **X** in the team's color (blue = attackers, red = defenders) —
hidden from the street, north/south of the first building at each end.
The red X is the attackers' objective. Ground-floor windows can be
climbed through in either direction: get close and a **CLIMB** button
appears (or press **E**).

## Tests

```bash
npm test
```

- `test/map-test.mjs` — unit tests for collision, floor height, stairs,
  doors, alleys, the objective zone and the window-climb landings
  (17 checks).
- `test/headless-test.mjs` — spawns the real server and plays through it
  with fake WebSocket clients: damage falloff at close/medium/long range, a
  2v2 elimination win, an objective win, a reload cycle, a no-auto-reload
  check, a friendly-fire kill, an empty-team start rejection, an
  asymmetric 1v2 start, and a solo-mode scenario (explore alone,
  shooting/reload alone, a match starting alongside, leave and re-join).
  Plus: clear-room, no-mid-match-joins, heartbeat ghost sweep, and a
  capture-hold + match-stats scenario (leaving the zone early resets the
  capture; a full 1v1 match ends with a verified stats board).

## Known limits / what is NOT in v1

- **No jump, no crouch.** Deliberately left out of v1.
- **No bots.** Every player is a real person; a match needs at least 1
  player per team. With few testers, play 2v2 or 1v2; a lone tester can
  use Solo mode to explore the map.
- **No voice chat.** Teams coordinate via a separate call (phone,
  WhatsApp, Discord) or by shouting across the room.
- **Commander is a label only** — no orders, map pings or special view.
- **No anti-cheat rigor.** Shot claims are validated for plausibility, but
  a modified client could lie about hits. Fine for a friendly POC test.
- **No persistent accounts or stats.** Closing the page removes you from
  the room; if everyone leaves, the room resets to a fresh lobby.
  Match stats exist only for the match in progress and vanish with it.
- **One room only.** Everyone who opens the page joins the same lobby.
- **No mobile Safari pointer lock** (not applicable — touch controls are
  used instead). Desktop Safari/Chrome/Firefox all work.
- **Shooting through windows works; walking through them doesn't** — by
  design, windows are firing positions, not entrances.
- **Server does not simulate physics/collision** — movement is
  client-simulated and relayed. Positions are clamped to the map bounds.
- **Live deployment:** <https://tactical-poc.fly.dev/> (Fly, region `fra`,
  one machine). Every push to `main` deploys automatically via GitHub
  Actions (workflow: `.github/workflows/fly-deploy.yml`). Multi-file pushes
  batch into a single deploy run: all commits but the last carry
  `[skip ci]` (parallel `fly deploy` runs race and fail — 22/11/2026).
- **Exactly one machine, always:** the room lives in server memory, so a
  second machine would split players into two invisible rooms that can't
  see each other. `fly.toml` sets `auto_start_machines = false` and deploy
  strategy `immediate` (stop, update, start — no old+new overlap window).
  Never scale this app above 1 machine.
- **Auto-reconnect:** if the connection drops (deploy restart, mobile
  network blip), the client reconnects with backoff (1s, 2s, 4s, 8s cap)
  and rejoins with the same callsign/team; a red "Connection lost —
  reconnecting…" banner shows in-game while disconnected. Rejoining
  mid-match spectates until the next round (same as any late joiner).

## Files

```
package.json            start + test scripts; deps: three, ws
server.mjs              HTTP + WebSocket server, authoritative game state
public/
  index.html            lobby + HUD + touch controls markup
  style.css             lobby/HUD/touch styling
  main.js               Three.js client: rendering, shooting, HUD, minimap
  map.js                shared map: houses, collision, floors, spawns
  controls.js           desktop + mobile input
  net.js                WebSocket wrapper
  audio.js              synthesized shoot/hit blips (WebAudio, no assets)
test/
  map-test.mjs          map unit tests
  headless-test.mjs     scripted 2v2 + 1v2 server test
```

## Changelog (22/11/2026)

- **Objective capture + match stats:** reaching the objective no longer
  ends the round instantly — an attacker must hold the zone for 30 s
  (leaving or dying resets the timer), with a progress bar for everyone.
  Fixes the "rounds end for no reason" bug: a straight sprint used to
  win rounds in ~20 s, and the zone was invisible in the 3D world. The
  zone stays map-only (a visible ring + beam was built and removed at
  Lior's request). Match-end screen now shows a per-player stats board
  (K / D / TK / accuracy / damage / captures).
- **YOU'RE DOWN vs end screens:** the down overlay no longer pops over the
  round-end banner or the match-end stats table. On the final kill the
  server broadcasts roundEnd/matchEnd synchronously, but the death
  snapshot goes out on the next tick — so the overlay only shows while
  the round is still playing. Found by the screenshot run (22/11/2026).
- **Round 4:** lobby labelled by role (ATTACKERS / DEFENDERS, join buttons
  included); objective shown on the map only, defenders' X only, labelled
  לכבוש / להגן; CONTINUE button ends each intermission (no auto-advance);
  spawn sides drawn randomly every round (4 combinations).

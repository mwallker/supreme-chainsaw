# Emberwake — co-op RPG prototype

A **3D** browser prototype of an open-world RPG with **turn-based action-point combat**, a deep **crafting & item interaction** system and **peer-to-peer co-op for up to 4 players** (one player hosts — no dedicated server).

No build step and no art assets: plain ES modules + [Three.js](https://threejs.org) (r160, vendored in `vendor/`, MIT). The world is a tactical diorama — tiled terrain with height, low-poly procedural models, dynamic shadows, fire light, rotatable camera.

## Run it

Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
python3 -m http.server 8080      # or: npm start
# open http://localhost:8080
```

It also works as-is on any static host (GitHub Pages, Netlify…). Peers need to reach the page and each other.

## Multiplayer

The host's browser runs the authoritative simulation. Clients send *intents* (move, attack, combine…); the host validates them and streams per-entity JSON diffs back at 10 Hz. Choose a connection mode on the title screen:

| Mode | How players find each other | Servers involved |
|---|---|---|
| **Online** | Host gets a 5-letter room code | Public PeerJS broker for the WebRTC handshake only (+ public STUN). All game traffic is direct peer-to-peer. |
| **Manual** | Host creates an invite code in the Party panel (`N`), friend pastes it and sends back a reply code | None (public STUN only) |
| **Local tabs** | Room code; open more tabs of the same browser | None (`BroadcastChannel`) — for testing |

- 1–4 players; a 5th is turned away. Players can drop in mid-game and rejoin with the same name to get their character back.
- A heartbeat frees the slot of anyone who disappears without saying goodbye.
- The host can **save** the world (Party panel; also autosaves every minute) and **continue** later from the title screen.
- Simulation ticks run on a Worker timer so the host keeps working when the host's tab is in the background.

## Character creation

Name, colour, one of four backgrounds, and 3 free attribute points across **Might / Finesse / Intellect / Vigor** (no D&D rules, just these).

| Background | Kit | Skills |
|---|---|---|
| Sellsword | sword, shield, tunic | Cleave, Shield Bash (knockback through surfaces), Second Wind |
| Ranger | bow, 24 arrows, dagger, ember paste | Aimed Shot, Flare Arrow (ignites a tile), Dash |
| Alchemist | mortar, flasks, oil, firebombs | Acid Splash, Mend — passive *Quick Toss*: throws cost 1 AP |
| Elementalist | staff, tinderbox | Firebolt, Frost Ray, Lightning Lash, Rain |

## Combat — action points

- Exploration is real-time; combat is turn-based and starts when enemies spot you or you strike first (you then act first).
- Each turn gives **+4 AP**, unused AP carries over up to **6**.
- Moving: 1 AP per 3 tiles (4 with high Finesse, halved while *Oiled*). Attack 2 AP, throw 2 AP, item use / interaction / crafting 1 AP, skills 1–3 AP with cooldowns.
- Statuses: Wet, Burning, Chilled, Frozen, Shocked, Stunned, Poisoned, Oiled. They interact: Wet + shock → Stunned, Wet/Chilled + frost → Frozen, physical hits shatter Frozen targets for +50%, Oiled + fire → flare-up, water puts out Burning.
- Downed allies are revived by a healing potion or *Mend*; if everyone falls the party wakes up in the village.

## Elements & surfaces

Liquids create surfaces; energies transform them. Everything chains:

| Surface | + Fire | + Frost | + Lightning | + Water |
|---|---|---|---|---|
| **Oil** | whole slick ignites | — | — | — |
| **Poison** | explodes (chains) | — | — | diluted |
| **Water / Blood** | steam (makes everyone Wet) | ice, and anyone standing in it **freezes** | whole pool **electrified**, everyone Shocked | — |
| **Ice** | melts to water | — | — | — |
| **Fire** | — | extinguished | — | steam |

Oil barrels explode in fire; powder kegs explode violently and chain to nearby barrels. Trees catch fire and spread it; charred trees yield charcoal. Wounds splash blood, which conducts and freezes like water.

## Crafting & item interactions

- **Combine**: drag one item onto another (or use the 3-slot crafting grid). 38 recipes — most must be **discovered by experimenting**; the recipe book shows hints for the unknown ones. Tools can go into the grid too (drag a herb onto a mortar).
- **Coatings**: drag a paste (ember/frost/storm/venom) or a flask of oil/poison onto a weapon or a stack of arrows. Coated hits add element damage, statuses — and apply the element to the target's tile (fire arrows ignite oil, storm arrows electrify puddles).
- **Use X on Y**: right-click anything to see every way your items apply to it — chop trees, mine rocks, harvest herbs, skin wolves, fill flasks at wells/lakes/barrels/puddles, douse fires, pour liquids, light campfires & forges, ignite barrels, cook meat, burn logs into charcoal, smelt ore, pick or smash locks, heal allies…
- **Throw anything**: flasks shatter into surfaces, bombs combine a liquid with an element, rocks just hurt.
- **Stations**: campfire (cooking, charcoal, resting), forge (smelting, metal gear), workbench, alchemy table. Stations stand in for tools.

Example chains: emberroot → *mortar* → ember paste → coat arrows → shoot an oil barrel next to bandits · burn a tree → chop the charred trunk → charcoal + sulfur (mine it) → gunpowder → flask + gunpowder + cloth → powder bomb · iron ore → lit forge → ingots → sword at the forge with a hammer.

## Controls

| | |
|---|---|
| Left-click | walk / attack / interact (auto-uses an axe or pickaxe on trees and rocks) |
| Right-click | context menu with every action, including "use item on this" |
| `1`–`5` | attack / skills, then click a target · `Space` end turn · `Esc` cancel |
| `I` `C` `P` `N` `H` | inventory, crafting, character, party/connection, help |
| `Enter` | chat · `WASD` pan · `Q`/`E` or middle-drag rotate camera · `F` recenter · wheel zoom · minimap click to look |

## Code layout

```
js/
  data/      items, recipes, enemies, classes, objects, tiles (pure data)
  sim/       authoritative game: game.js (turns, actions, movement), rules.js (statuses,
             surfaces, damage), crafting.js, interact.js (item→world rules), skills.js, ai.js,
             worldgen.js, map.js (A*, line of sight), entities.js
  net/       transport.js (PeerJS / manual WebRTC / BroadcastChannel + chunking), session.js (host diffing, client replica)
  render/    renderer3d.js (Three.js: instanced terrain/trees/rocks/grass, procedural creature & prop models,
             surface layers, flames + pooled point lights, particles, raycast picking, DOM nameplates & floating text)
  ui/        hud.js (panels, drag & drop, context menus, targeting)
  main.js    title, character creation, hosting/joining, main loop
tests/sim.test.js   headless simulation tests (npm test)
```

The rules functions (`matchCombination`, `applyRulesFor`, `skillError`…) are pure and shared by host and clients, so the UI can preview results (combine outcome, available interactions, range/LOS) without a round trip, while the host stays authoritative.

## Rendering notes

- The simulation is a tile grid; the renderer maps tile `(x, y)` to world `(x+0.5, height, y+0.5)`. Clicking raycasts against creatures, props and tree/rock instances first, then the terrain heightfield.
- Static scenery (≈12k terrain columns, ~1k trees, grass tufts) uses `InstancedMesh`, so draw calls stay low. Dynamic lights are a pool of 6 point lights assigned to the nearest fires.
- Needs WebGL with a real GPU for smooth framerates (software rendering works but is slow).

## Known limitations (it's a prototype)

- The whole party is pulled into a fight, even members far away.
- No fog of war, quests, dialogue or enemy respawns; the host is trusted (no anti-cheat).
- The Online mode depends on the public PeerJS broker being up; some strict NATs need a TURN server, which isn't included — use Manual mode or a LAN in that case.

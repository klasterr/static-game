# Depths — endless procedural dungeon crawler

A real-time action roguelite that runs entirely in the browser and deploys as a
purely static site. **No image assets, no audio assets, no backend, no runtime
network calls** — every visual is drawn with Canvas 2D primitives and all sound
is synthesised with WebAudio, so the whole game is one JS bundle (~195 kB,
67 kB gzipped).

- Live: https://klasterr.github.io/static-game/
- Repo: `klasterr/static-game`, branch `main`, deployed by
  `.github/workflows/deploy.yml` on every push.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit && vite build -> dist/
npm test           # vitest run, 31 tests, ~9s
npm run typecheck
GEN_FUZZ=5000 npx vitest run -t "keeps every walkable tile reachable"   # full sweep, ~60s
```

`vite.config.ts` sets `base: './'`. Keep it that way — relative asset URLs work
identically at `/`, at the `/static-game/` Pages subpath, and over `file://`,
with no environment branching.

---

## 1. The design brief, and the constraints that follow from it

The game is **endless** — a continuous descent, not a handful of authored
levels — but explicitly **must not feel monotonous**. That single requirement
drives most of the architecture, so it is worth knowing before changing
anything:

- **Behaviour variety beats stat variety.** Seven enemies each demand a
  *different player response*. Adding an eighth enemy that is "a Bone Rat with
  more health" adds nothing. See §5.
- **Layout grammar is the strongest anti-monotony lever.** Two biomes use two
  genuinely different generators, because rooms-and-corridors (chokepoints,
  doorway fighting) and caves (open swarming, cover-blob kiting) play
  differently in a way no palette swap can achieve.
- **No image assets** means an enemy is distinguished by *silhouette family*
  plus *motion verb*. Two enemies may share a colour if both of those differ;
  never both.
- **Enemy power outruns player power on purpose.** Relative capability decays
  ~1.35% per floor, halving over ~50 floors. A run ends because your margin for
  error ran out, not because you hit a wall. Meta-progression moves the
  *intercept*, never the slope.

---

## 2. Layout

~19,500 lines of TypeScript across 66 files. Dependencies flow strictly
downward; `world/` may never import from `run/` or `ui/`.

```
src/
  main.ts          DOM bootstrap only: canvas, rAF, resize, blur, visibility
  game.ts          the fixed-timestep loop + the scene stack

  core/            no game knowledge, no DOM (except input/audio/storage)
    constants.ts   ALL tuning numbers live here
    math.ts        allocation-free helpers, scratch vectors
    rng.ts         cyrb128 + sfc32, numbered streams, seed strings
    input.ts       event-QUEUE drained at step boundaries (see §4)
    storage.ts     versioned localStorage under the `sg.` prefix
    audio.ts       synthesised drones, motifs and sfx
    time.ts        rolling frame stats + adaptive fx budget
    touch.ts       dynamic virtual stick, lazy-loaded on coarse pointers

  world/           the simulation. Pure logic; no canvas, no DOM.
    entities.ts    the fat `Entity` struct, `DerivedStats`, `PlayerState`
    world.ts       entity lifecycle: spawn/kill/flush (see §3)
    ctx.ts         `GameCtx` — what every behaviour and item effect receives
    collision.ts   circle-vs-tilegrid, circle-vs-circle, melee cone
    tiles.ts       `Tile` enum, lookup tables, `Tilemap`, DDA raycast
    flowfield.ts   BFS distance field used instead of per-enemy A*
    player.ts      locomotion, dash, the attack state machine, pickups
    enemies.ts     AI dispatch, shared integration, separation, affixes
    combat.ts      `applyDamage` — the single choke point for all damage
    projectiles.ts projectiles, lobs, hazard volumes, status ticks

  gen/             floor generation. Deterministic, no DOM.
    floor.ts       the orchestrator + regenerate loop + fallback
    generateRooms.ts / generateCaves.ts / generateBossFloor.ts
    connectivity.ts  flood fill, region labelling, Prim MST, tunnelling
    distanceField.ts Chebyshev transform, cave chamber detection
    specialRooms.ts  stair placement, special-room assignment
    decorate.ts      hazard painting, torch placement
    populate.ts      enemy + loot placement
    level.ts         `Level`, `Room`, `SpawnRecord`, `LootRecord`

  systems/         cross-cutting rules
    scaling.ts     THE difficulty design. Every balance change starts here.
    loot.ts        pools, rarity rolls, drop plans
    progression.ts XP, levels, perk offers
    trickle.ts     trickle spawner, Depth Wraith, visited-room tracking

  render/          everything canvas
    renderer.ts    canvas, DPI/zoom/transform, culling, text cache
    scene.ts       the world render pass + dev overlay
    camera.ts      deadzone follow, aim lookahead, trauma shake
    lighting.ts    `LightBuffer` — half-res additive lights, multiply composite
    tileart.ts     bakes the per-biome tile atlas
    entityart.ts   per-kind procedural entity drawing
    glyphs.ts      shared shape primitives (all art is built from these)
    fx.ts          SoA particles, damage numbers, decals, transient lights
    hud.ts / minimap.ts

  content/         data modules with behaviours as functions (see §6)
    index.ts       registries + `validateContent()`
    types/         BiomeDef, EnemyDef, item types
    behaviors/primitives.ts   composable AI building blocks
    enemies/ biomes/ items/   the actual content
    classes.ts perks.ts shrines.ts modifiers.ts unlocks.ts

  run/runState.ts  owns the world + current floor + the reward economy
  ui/scenes.ts     Title, ClassSelect, Sanctum, Settings, Help, Play,
                   Pause, Choice, Descend, GameOver
  ui/menu.ts       canvas menu widgets

tests/
  generation.test.ts   connectivity fuzz, determinism, stream independence
  simulation.test.ts   headless run stepping, combat, collision, save fuzz
```

---

## 3. The five invariants

Break any of these and you get bugs that take a day to find. They are each
commented at their definition site too.

**1. Entity lifecycle: `pending` / `alive` / `flush`.**
`spawn()` appends to a *pending* queue, not to `ents`. `kill()` only flips
`alive`. `flush()` runs exactly once at the end of the tick and does the appends
plus a backward swap-remove into the pool. Consequence: `ents.length` is
invariant for a whole tick, so every system can iterate it forward and skip
`!e.alive`. Nothing outside `world/world.ts` may push or splice `ents`.

**2. Never hold an `Entity` across ticks** — except `world.player`.
Entities are pooled, so after `flush()` a dead entity's object is reused with
different data. Use `{id, gen}` handles via `world.ref()` / `world.resolve()`,
or better, design the reference away: projectiles carry `team` + `payload`
rather than an owner pointer, and AI targets `ctx.target`. Where a boss needed
to know its orb count, it caches a **number** in a scratch field.

**3. RNG streams are independent and must stay that way.**
`floorRng(runSeed, depth, Stream.X)`. Adding a loot roll must not shift the
dungeon layout, or every content tweak invalidates every shared seed. A seeded
stream may never be advanced by a call whose occurrence or count depends on
frame timing, player position, `Map`/`Set` iteration order, or promise ordering.
Iterate rooms by `id`, never by hash-map order. Cosmetic randomness (particles,
shake, audio detune) uses `Math.random` and must not touch these streams.
There is a test asserting layout is unchanged when only the loot pool changes.

**4. `applyDamage` is the only way anything takes damage.**
Hitstop, flash, knockback, damage numbers, shake, leech, chains, on-hit relics
and death rewards all live in `world/combat.ts`. Feel tuning is therefore one
file, not fifteen.

**5. Canvas state must be restored.**
`imageSmoothingEnabled` is `true` only for the light composite and `false`
everywhere else; `globalCompositeOperation` must return to `source-over` after
the particle and light passes. Leaking either makes the *next* frame wrong,
which is a confusing symptom. Also **banned in hot paths**: `ctx.shadowBlur`,
`ctx.filter`, per-frame `createRadialGradient`, template-string `fillStyle`,
uncached `measureText`. Each is a known 4–20 ms mistake.

---

## 4. Loop and rendering

**Fixed 60 Hz timestep with an accumulator, plus render interpolation.**
The attack active window is 70 ms — four ticks. With a variable dt, a 33 ms
frame merges windup and active and a 50 ms frame can skip the overlap test
entirely. Fixed stepping is also what makes knockback decay and i-frames
framerate-independent.

- `MAX_STEPS = 5`, then the accumulator is dumped — never spiral.
- A raw dt over 250 ms (tab blur, sleep, breakpoint) is discarded, not caught up.
- `resume()` zeroes the accumulator. Without that, unpausing runs five steps at
  once and teleports every enemy onto the player.
- Every entity stores `px/py` (last tick). Render lerps them. **Nothing
  gameplay-relevant may read `px/py`**, and both must be reset on spawn and on
  every teleport or floor change, or entities streak across the screen.

**Layer order** (in `render/scene.ts`) is not arbitrary:

```
background → tiles → hazard overlays → decals → ground telegraphs →
entities (y-sorted) → particles → LIGHT COMPOSITE → post FX → HUD
```

The light composite sits above entities so enemies are *lit* rather than pasted
on the dark. The HUD sits above the composite so it is never dimmed by
torchlight. Damage numbers are drawn in screen space for the same reason.

**Lighting**: accumulate additive pre-baked gradient sprites into a half-res
offscreen canvas, then composite with `multiply`. `multiply` is the right
operator for "how much light reaches this pixel" and preserves the biome
palette, where `screen`/`lighter` over a black mask washes it toward grey.

**Crispness** needs all three of: integer zoom, `imageSmoothingEnabled = false`,
and the camera snapped to whole device pixels. Drop the snap and tiles shimmer
as you walk. Shake is applied *after* the snap and may be fractional.

**Input is an event queue drained at step boundaries.** The naive
`pressed = downNow && !downLast` silently loses any key pressed and released
inside one 16.7 ms window, which happens constantly when mashing attack on a
machine dropping frames. Held state is cleared on `blur` and
`visibilitychange`, or alt-tabbing mid-strafe leaves you walking forever.

**Performance budget**: ≤8 ms/frame at 1280×720, DPR 2, integrated graphics.
Brute-force collision at 80 entities is ~3,160 pairs/tick ≈ 0.05 ms. **Do not
add a uniform grid** — it is premature and brings its own bug class. If a
profile ever shows the pair loop over 1.5 ms, use single-axis sweep-and-prune.
Likewise pathing is a per-room BFS flow field, not per-enemy A*; at width-2
corridors the result is indistinguishable and ~50× cheaper.

---

## 5. Content model

**Content is TypeScript data modules with behaviours as first-class functions,
not JSON.** Behaviours *are* the content — a charger is
`approach → telegraph → locked dash → recover`, not a bag of stats — and
expressing that in JSON means writing an interpreter for a mini-language, which
is untypecheckable and always grows into an unmaintainable DSL. TS also gives
compile-time validation of every field, cross-references by value, and zero
async content loading.

`content/behaviors/primitives.ts` is what makes enemies cheap: each `ai` is
5–20 lines composed from `chase`, `kite`, `strafeArc`, `telegraphedCharge`,
`meleeSwing`, `shootAt`, `lobAtTarget`, `blinkNear`, `expandingRing`,
`directionalShield`, and friends. **Anything two enemies would both want belongs
in there**, tested once, rather than open-coded per species.

Enemy AI operates on the pooled `Entity` using generic numeric scratch fields.
The conventions (documented at the top of `primitives.ts`):

| Field | Use |
| --- | --- |
| `state` / `stateT` | attack or phase state machine |
| `aiT` | primary cooldown |
| `cd1` | secondary cooldown |
| `ax` / `ay` | a remembered point (anchor, aim, shield angle) |
| `bx` / `by` | spare scalars |
| `cd0` | **reserved** — contact-damage cooldown |
| `cd2` | **reserved** — Warded affix window |

The current roster and the response each one demands:

| Enemy | Demands |
| --- | --- |
| Bone Rat | crowd control, never standing still |
| Bone Archer | close the gap, or use cover |
| Skeleton Warden | flank it (0.35 s shield lag), or use a DoT |
| Grave Hand | read the floor; the counter to speed-stacking |
| Spore Puff | kill at range, or bait it into a crowd |
| Myconid Splitter | make space *before* killing it |
| Cap Slinger | keep moving laterally; the floor shrinks |
| Ossuary Choir (boss) | target priority, then ring-gap dodging |
| Depth Wraith | a clock, not a fight — unkillable, arrives at 6:00 |

Elites multiply an ordinary species by 2.6× HP / 1.3× damage and add one of four
affixes (Volatile, Warded, Frenzied, Hasted). Sixteen distinct encounters for
about forty lines each — the cheapest variety multiplier in the design.

`validateContent()` runs at boot in dev and in the tests. It catches the class
of mistake that otherwise surfaces as a crash on floor 14: a roster referencing
a renamed enemy, a zero-weight table, a relic exceeding the 15%/stack guardrail.

---

## 6. Non-obvious design decisions

Things that look like bugs or oversights but are deliberate. Please read before
"fixing" them.

- **No inventory screen, ever.** Relics auto-pickup and stack infinitely; there
  is one weapon slot and one or two consumable quick-slots. Any UI that makes
  the player stop and read a grid destroys four-minute-floor pacing and trains
  pause-farming. Weapon swaps are the one interaction worth having because they
  change the *attack verb*.
- **The old weapon lands back on the pedestal** after a swap, so trying
  something out is reversible.
- **Facing is latched at the Windup→Active boundary**, not sampled per tick.
  Re-aiming mid-swing makes the arc feel like a vacuum cleaner and removes all
  commitment.
- **DoTs bypass directional shields and armour plates.** This is the intended
  "aha" for Ember builds and is deliberately *not* in any item description.
- **Hazards damage enemies too** (spike plates do; spore vents deliberately do
  not). Knockback relics quietly become shove-them-into-the-spikes relics.
- **Trickle spawns give 0 loot and 40% XP.** They are pressure, not a farm —
  otherwise the optimal play is standing in a cleared room waiting for spawns.
- **The stairs work the moment you find them.** Every floor is a greed decision,
  which lets the player author their own floor length. This is the highest-value
  pacing mechanic in the game.
- **Souls bank on descent, not on death**, so a crash or a closed tab never
  costs a whole run. There is no corpse-run mechanic and should not be.
- **The silent catch-up rule**: arriving under 35% health quietly upgrades one
  drop to a sustain relic and forces Shrine of Mending into the first pair.
  Undisclosed by design — see `populate.ts`.
- **Healing is bounded per floor** so health is a resource spent across a run
  rather than a per-floor reset.
- **Meta-progression only widens loot pools.** No node removes a penalty; one
  that did would retroactively make earlier runs feel rigged. The free class
  (Wanderer) is deliberately the best relic-economy class and is viable to
  floor 25+.
- **The treasure vault door is NOT sealed.** The original design opened it when
  its guards died, but the guards are inside — an unopenable soft-lock, caught
  by the connectivity fuzz. The fight is the lock.
- **`minMainPath` is `0.62·(W+H)`, not the planned `0.9`.** 0.9 is
  geometrically unreachable (rooms cannot sit in the corners) and was rejecting
  ~68% of good floors into the emergency fallback. Measured against 400 floors.

---

## 7. Where to change what

| Want to change | Go to |
| --- | --- |
| How combat *feels* (hitstop, i-frames, knockback, shake) | `core/constants.ts`, then `world/combat.ts` |
| Difficulty, floor size, souls, XP curve | `systems/scaling.ts` |
| Add an enemy | `content/enemies/*.ts` + add to a biome roster; reuse `behaviors/primitives.ts` |
| Add a relic / weapon / consumable | `content/items/*.ts` + `systems/loot.ts` pools |
| Add a biome | `content/biomes/*.ts` + register in `content/index.ts`; pick an existing generator |
| Dungeon shape | `gen/generateRooms.ts` / `gen/generateCaves.ts` |
| Floor pacing, spawn pressure | `systems/trickle.ts` |
| Menus, overlays, HUD | `ui/scenes.ts`, `ui/menu.ts`, `render/hud.ts` |

All UI is drawn on the canvas — there is no DOM UI. One rendering path means no
CSS, no z-index fights, no font-loading flash.

---

## 8. Testing

31 tests, ~9 s, all headless. The simulation layer has **no DOM dependency** on
purpose, so a run can be stepped thousands of times in Node — that is what makes
it possible to catch a crash in the AI or the reward economy without a browser.

The most valuable test is the **connectivity fuzz**: it is the only thing
standing between a bad seed and an unfinishable run. It already caught two real
bugs (the vault soft-lock and the unreachable path target). Keep it green, and
run `GEN_FUZZ=5000` before releases.

### Known gap — the rendering path has never been visually verified

Typecheck, build and all 31 tests pass, but **no frame has ever actually been
rendered and looked at**. Browser automation was declined in the session that
built this. The tests cannot catch a wrong canvas transform, an inverted layer
order, or an exception inside a draw call.

`jsdom` is installed as a devDependency but unused. The highest-value next test
is a render smoke test: jsdom environment, a stub 2D context that records calls,
boot the game, drive a few hundred frames through `Game.frame` across Title →
Play → Pause → Descend → GameOver, and assert nothing throws. That would close
most of this gap without a real browser.

---

## 9. Deliberately deferred

Do not add these without asking; each was considered and cut with a reason.

- **Line-of-sight shadow casting** — the biggest scope-creep trap here. Looks
  incredible, eats a week.
- **Mid-run save/resume** — *the first thing worth adding.* Runs reach ~50
  minutes, which is a real retention problem for a browser game, and the seeded
  generator makes it nearly free: store seed + floor + player state and
  regenerate the tiles.
- Biomes 3–4 (Foundry, Frozen Depths) — designed, not built; both reuse an
  existing generator, so they are cheap.
- Equipment affixes, armour and trinket slots.
- Floor-21+ remix system (guest enemy packs, palette hue-shift, dual hazards).
  `hueShift()` in `content/types/biome.ts` already exists for it.
- Deterministic combat replay — weeks of work, near-zero player value.
- Any inventory grid, crafting, sockets, or item durability — actively harmful
  to the core loop.
- Leaderboards or achievements — need a backend, which the brief rules out.
- An ECS refactor or WebGL. Profile first; the numbers say Canvas 2D is fine.

---

## 10. Conventions

- Commit as `klasterr <kuzjovictor@gmail.com>`. **Do not add
  `Co-Authored-By: Claude` trailers** — the user asked for these to be removed.
- `klasterr` is the GitHub account with the `workflow` token scope; the other
  logged-in account (`viktor-kuzo`) lacks it and cannot push Actions files.
- `tsconfig.json` is strict, including `noUnusedLocals` and
  `noUnusedParameters`. Don't paper over an unused import with `void x` — delete
  it.
- `localStorage` keys must keep the `sg.` prefix: GitHub Pages puts every one of
  the user's projects on the same origin, so storage is shared across all of
  them.
- Comments should explain *why*, especially where a decision looks wrong at
  first glance. That is most of what makes this codebase navigable.

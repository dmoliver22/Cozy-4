# Terraces

*Sculpt a misty mountainside into terraced fields. Water cascades from step to step, and villages grow wherever it reaches.*

A relaxing, physics-driven builder inspired by the rice terraces of Southeast Asia and the Andes. You don't place buildings: you shape the land. Cut a terrace and the spring water spills down to fill it; sow along the flow and a hamlet appears. Each mountain is a gentle puzzle about where water goes. There are no timers and no fail state, and every stroke can be undone.

This repository is the **Stage 1 web toy**: one mountain, three light goals (plus a second set once those are met), built to run in a browser and upload to itch.io as-is.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (relative paths — zip it for itch.io)
npm test           # simulation tests (node)
```

You need a browser with WebGL 2 (any recent Chrome, Edge, Firefox or Safari). Add `?quality=low` to the URL for older laptops and phones (it's on by default for touch devices). `?tm=agx` or `?tm=neutral` switch the tone mapping.

### Controls

| | Desktop | Touch |
|---|---|---|
| Use tool | Left drag | One finger |
| Orbit | Right drag, <kbd>Q</kbd>/<kbd>E</kbd>, <kbd>R</kbd>/<kbd>F</kbd> | Two fingers |
| Zoom | Wheel (zooms toward the cursor), <kbd>+</kbd>/<kbd>-</kbd> | Pinch |
| Pan | Middle drag, <kbd>Shift</kbd>+drag, <kbd>WASD</kbd> | — |
| Tools | <kbd>1</kbd>–<kbd>5</kbd>, brush size <kbd>[</kbd> <kbd>]</kbd> or <kbd>Alt</kbd>+wheel | Tray |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Tray |
| Hide UI / photo | <kbd>H</kbd> / <kbd>P</kbd> | Camera button |

### Tools

- **Terrace** cuts a level shelf at the height where you start the stroke. Drag along the slope and it follows you around the mountain. Start on an existing terrace (or close to its level) to extend it. Terrace rims grow an earthen bund, so a paddy fills to its lowest point and spills from there.
- **Channel** digs a groove whose bed only ever descends from where you started. Drag uphill and it cuts deeper instead, so water always runs the way you drew it.
- **Sow** throws seeds from the pouch. Rice needs standing water, tea likes damp slopes that drain (the seepage just below a paddy), and flowers grow almost anywhere.
- **Path** lays a footpath. Villagers walk faster on paths, and joining two hamlets with one is a goal.
- **Soften** eases the land back toward its natural shape.

### The mountain's goals

1. Lead the spring down five terraces. The first cut through the old berm does it.
2. Grow forty rice plants in flooded paddies.
3. Welcome a hamlet of six homes.

Then: tea where water seeps but never pools, thirty flowers, and a footpath joining two hamlets. After that the mountain is yours. The game autosaves to the browser.

## The physics

Nearly everything on screen is simulated rather than animated.

| System | What's simulated | Where |
|---|---|---|
| **Water** | Shallow water on the heightfield using the *virtual pipes* model (O'Brien & Hodgins; Mei et al.). Flux is driven by hydrostatic head and gravity and slowed by depth-dependent bed friction. The result is momentum, sloshing, waves, pooling to a flat level, and spilling at the lowest point of a bund. | `src/sim/water.js` |
| **Soil water** | Infiltration into dry soil (paddies have a puddled hardpan), Darcy-like downhill seepage and diffusion, evapotranspiration, and evaporation from open water. | `src/sim/water.js` |
| **Erosion** | Suspended-sediment capacity from flow speed and slope: erosion, semi-Lagrangian transport, deposition. Silt that settles in paddies becomes fertility instead of filling them. | `src/sim/water.js` |
| **Granular soil** | Angle-of-repose relaxation (thermal erosion) for loose soil. Terraces, stone risers and channels are retained. | `src/sim/terrain.js` |
| **Rigid bodies** | [Rapier](https://rapier.rs) 3D. The sculpted heightfield is mirrored into a Rapier heightfield collider whenever the land changes. Cut soil breaks off as clods that tumble downhill and dissolve where they settle (adding soil, or silt in a paddy). Seeds are thrown from the pouch, arc, bounce, roll off slopes that are too steep and take root where they come to rest. Flower petals drop and float. | `src/physics/physics.js` |
| **Water ↔ bodies** | Archimedes buoyancy from submerged volume, plus drag toward the local current, so petals ride the flow over bunds and down waterfalls. Impacts push water outward, and the pipe model turns that into ripples. | `src/physics/physics.js` |
| **Wind** | A veering breeze with travelling gust fronts drives a field of damped spring oscillators, so rice and trees sway as waves roll across the paddies. | `src/sim/wind.js` |
| **Particles** | Waterfall spray (ballistic plus drag), chimney smoke (buoyant hot air that cools), dust, rain, fluttering petals and fireflies. | `src/render/particles.js` |
| **Life** | Crops grow by how well the local water suits them. Homes appear on a spring-damper with squash and stretch, villagers steer over the heightfield preferring paths and avoiding deep water, buffalo wade in paddies, and birds flock as boids. | `src/game/*.js` |
| **Sound** | Synthesised at runtime. Karplus–Strong plucked strings, modal-synthesis bells and gong, water "plips" at the Minnaert resonance of the trapped bubble, and running water, wind and rain from noise driven by the simulation's flow energy. | `src/audio/audio.js` |

## Code map

```
src/
  sim/        pure JS, unit-tested in node: terrain, water, wind, ecology, mountain generator
  physics/    Rapier world + water coupling
  render/     three.js views: terrain, water, sky/day cycle, mist, particles, post (tilt-shift, bloom, grade)
  game/       crops, village, nature (trees, birds), goals, tools + undo, camera, save, Game orchestrator
  ui/         tray, goal card, hints, title screen
  audio/      procedural audio engine
test/         simulation tests (mass conservation, paddy filling, channels, undo, the first-cut cascade)
```

## Shipping to itch.io

`npm run build`, zip the *contents* of `dist/`, upload as an HTML game, and set the viewport to 1280×720 with "fullscreen button" enabled. The build uses relative paths and needs no server features.

## A note on place and people

The terraces of Ifugao, Sa Pa, Bali, Yunnan, and the Andean *andenes* are living, sacred landscapes that farming communities have built and kept up over centuries. The houses, music and names in this toy are deliberately simple, generic placeholders. The design brief says the full game should be made **with** people from those places, with paid cultural consultants shaping the architecture, instruments, crops and stories before anything ships beyond this prototype.

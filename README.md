# Mark Truant — web gallery

A walkable, non-Euclidean gallery for the browser, built with three.js.

## Running it

```bash
npm install
npm run dev        # local dev server at http://localhost:5173
npm run build      # static site in dist/ (what Netlify publishes)
```

Node lives in `~/.local/node` on this machine (added to `PATH` in `~/.zshrc`).

## Levels come from Blender

Levels are `.glb` files in `public/levels/`, exported from Blender with
**Include → Custom Properties** ticked. Objects are tagged with custom properties
(Object Properties → Custom Properties), and the game wires up their behaviour:

| Property | On | Effect |
| --- | --- | --- |
| `portal = "A"`, `link = "B"` | a flat, upright plane | Becomes a portal to the plane tagged `portal = "B"`. Its front is the side the face normal points to (blue in Blender's Face Orientation overlay). Linked portals must be the same size. |
| `recursion = 4` | a portal | Optional. How many times a portal can be seen through itself. |
| `spawn = 1` | an empty | Player start, looking along the empty's local +Y. |
| `nocollide = 1` | a mesh | The player can walk through it. |

`tools/build_test_level.py` builds the prototype level from scratch and is a working
example of all of the above:

```bash
npm run level:test   # writes blender/test_level.blend and public/levels/test.glb
```

The starting area lives in `blender/StartingArea.blend`. Edit that copy, then:

```bash
npm run level:start  # writes public/levels/start.glb
```

The intro finds things by name: objects `M` and `Button`, materials `CeilingWhite`
(pure white, blends into the ground) and `Material.002` (black corridor floor).
The prototype portal level is still at `/?level=test`.

When exporting by hand, set **Lighting Mode → Non-Physical** so lights match Blender.

## Code

- `src/main.js`: renderer, loop, startup
- `src/level.js`: loads a level and reads the Blender tags
- `src/player.js`: first-person controller and collision (three-mesh-bvh)
- `src/intro.js`: starting-area look and the opening camera drop
- `src/portals.js`: portal rendering, recursion and teleporting

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
| `portal = "A"`, `link = "B"` | a flat, upright plane | Becomes a portal to the plane tagged `portal = "B"`. Its front is the side the face normal points to (blue in Blender's Face Orientation overlay). Linked portals are joined centre to centre, so line their floors up; one may be larger than the other (the extra shows the wall around the smaller one). |
| `recursion = 4` | a portal | Optional. How many times a portal can be seen through itself. |
| `spawn = 1` | an empty | Player start, looking along the empty's local +Y. |
| `nocollide = 1` | a mesh | The player can walk through it. |
| `hidden = 1` | a mesh | Not drawn, but still solid (ramps, invisible steps). |
| `cardarea = 1` | floor faces | Where the sentence cards are scattered (the 5555 build script makes it from the Room mesh's `Floor` vertex group), using the level's `Card` mesh as the card. One card per line of `public/sentences.txt`. |

`tools/build_test_level.py` builds the prototype level from scratch and is a working
example of all of the above:

```bash
npm run level:test   # writes blender/test_level.blend and public/levels/test.glb
```

The starting area lives in `blender/StartingArea.blend`. Edit that copy, then:

```bash
npm run level:start  # writes public/levels/start.glb
```

Room 5555 is `blender/Room5555.blend` and the bedroom behind the Dierama's slits is
`blender/Bedroom.blend` (its `Closed` and `Open` collections become two worlds, one per
slit; see the notes at the top of each script):

```bash
npm run level:5555     # writes public/levels/room5555-*.glb
npm run level:bedroom  # writes public/levels/bedroom-closed.glb and bedroom-open.glb
```

The intro finds things by name: objects `M` and `Button`, materials `CeilingWhite`
(pure white, blends into the ground) and `Material.002` (black corridor floor).
The doors are `DoorLeft` and `DoorRight`, and the single `Keypad` (children `0Butt`–`9Butt`,
`XButt`, `<Butt`, matching `*Emis` glow slots, `Light1`–`Light4`) is copied onto the
other door in code. Code `5555` opens a door, X walks away, < clears.
The prototype portal level is still at `/?level=test`.

When exporting by hand, set **Lighting Mode → Non-Physical** so lights match Blender.

## Code

- `src/main.js`: renderer, loop, startup
- `src/level.js`: loads a level and reads the Blender tags
- `src/player.js`: first-person controller and collision (three-mesh-bvh)
- `src/intro.js`: starting-area look and the opening camera drop
- `src/keypad.js`: door keypads and opening doors
- `src/portals.js`: portal rendering, recursion and teleporting
- `src/cards.js`: the sentence cards (all cards baked into one mesh, all their letters into another)
- `src/bulb.js`: the giant lightbulb in room 5555 (right) flickers, with its glow, a point light, a buzz and clinks, ported from Unity's FlickeringEmission.cs
- `src/video.js`: the `Vid` plane plays `media/vid.mp4`, with its sound from the wall
- `src/screens.js`: the CardScreens panels (a new random sentence every 1 / 0.5 / 0.25 s, each lighting the room with an area light). Rooms listed in `SHADE` (main.js) get little sky light under their ceiling (`src/shade.js`), so the screens light them.

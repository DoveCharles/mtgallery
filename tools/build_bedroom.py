"""Exports the bedroom behind the Dierama's slits (room 5555, right) from blender/Bedroom.blend.

Run from the web/ folder:  npm run level:bedroom
(or: blender -b blender/Bedroom.blend --python tools/build_bedroom.py)

Bedroom.blend holds one room in two configurations: everything in the scene collection is
in both, and the "Closed" and "Open" collections each only go into their own one (the
excluded "Incases" collection goes into neither). Writes public/levels/bedroom-closed.glb
and bedroom-open.glb (see EXTRA_WORLDS in src/main.js), each with a portal named "Exit":

- Closed: at the end of the Star corridor, facing the room. The corridor leads to the
  room's window, which can be climbed through: the window wall is walk-through across the
  window's width, and hidden ramps lift the player up to the sill and back down.
- Open: at the end of the Room mesh's corridor (behind the door), facing the bedroom.

Each exit is linked to one of the Dierama's slits (see tools/build_room5555.py), so its
centre sits at the slit centre's height above the floor (floors line up through the
portal) and it spans the corridor's width; the end wall below its top is cut away so the
player can walk up to it. The room is modelled in metres but exported scaled like room
5555 (the Star corridor is the same 2 x 3.16 as that room's opening), so the two match.
The .blend itself is left untouched.
"""
import bpy
import bmesh
import os
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(ROOT, "blender", "Bedroom.blend")
SCALE = 1.25  # as room 5555
VARIANTS = {"Closed": "bedroom-closed", "Open": "bedroom-open"}
SKIP = ["Incases"]  # collections in neither
EXIT_TOP = 2 * 1.318  # exits run from the floor to here: centred on the slits' centre height (Room5555.blend units)

# Closed: the end wall of the Star corridor (y = STAR_END) and the room's window, in Blender
# world coordinates.
STAR_END = 7.305
WINDOW_X = (-1.141, -0.351)  # the clear opening
WINDOW_SILL = 0.505
WINDOW_TOP = 1.763
WINDOW_WALL_Y = (1.398, 1.626)  # the wall, sill and frame, room side to corridor side
WINDOW_CUT = {"x": (-1.2, -0.3), "y": (1.3, 1.75), "z": (0.02, 1.85)}  # made walk-through
# The player (1.95 m tall) is lifted RAMP_RISE so their head just clears the window's top.
RAMP_RISE = WINDOW_TOP - 1.95 / SCALE - 0.035
RAMP_RUN = 0.9  # length of each slope

# Open: the end of the corridor behind the door.
OPEN_END = -8.089  # inner face of the end wall
OPEN_CUT = {"x": (-0.1, 2.4), "y": (-8.3, -8.08)}


def apply_modifiers(o):
    """Bakes an object's modifiers into its mesh (so its faces can be edited as seen)."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    o.data = me


def inside(p, box):
    return all(lo <= getattr(p, axis) <= hi for axis, (lo, hi) in box.items())


def cut_box(o, box, cuts, split=None):
    """Cuts o's faces near `box` along the planes in `cuts` ((point, normal) pairs, world
    space), then removes the faces whose centres are inside `box`. With `split`, those
    faces are moved into a new object of that name instead (returned)."""
    apply_modifiers(o)
    m = o.matrix_world.copy()
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.transform(m)
    near = {axis: (lo - 0.05, hi + 0.05) for axis, (lo, hi) in box.items()}
    for co, no in cuts:
        faces = [f for f in bm.faces if inside(f.calc_center_median(), near) or any(inside(v.co, near) for v in f.verts)]
        geom = faces + list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no)
    taken = [f for f in bm.faces if inside(f.calc_center_median(), box)]
    if not taken:
        raise SystemExit(f"Nothing of {o.name} inside {box}")
    part = None
    if split:
        rest = bm.copy()
        bmesh.ops.delete(rest, geom=[f for f in rest.faces if not inside(f.calc_center_median(), box)], context="FACES")
        rest.transform(m.inverted())
        me = bpy.data.meshes.new(split)
        rest.to_mesh(me)
        rest.free()
        for mat in o.data.materials:
            me.materials.append(mat)
        part = bpy.data.objects.new(split, me)
        part.matrix_world = m
        for c in o.users_collection:
            c.objects.link(part)
    bmesh.ops.delete(bm, geom=taken, context="FACES")
    bm.transform(m.inverted())
    bm.to_mesh(o.data)
    bm.free()
    return part


def add_mesh(name, verts, faces, collection, facing=None, **tags):
    """A new mesh object from world-space verts. With `facing`, each face is flipped to
    point that way."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([Vector(v) for v in verts], [], faces)
    if facing:
        for p in me.polygons:
            if p.normal.dot(Vector(facing)) < 0:
                p.flip()
    me.update()
    o = bpy.data.objects.new(name, me)
    for k, v in tags.items():
        o[k] = v
    collection.objects.link(o)
    return o


def exit_portal(x, y, facing, collection):
    """The "Exit" portal: across the corridor (x0..x1) at y, from the floor to EXIT_TOP."""
    (x0, x1) = x
    return add_mesh(
        "Portal_Exit",
        [(x0, y, 0), (x1, y, 0), (x1, y, EXIT_TOP), (x0, y, EXIT_TOP)],
        [(0, 1, 2, 3)],
        collection,
        facing=facing,
        portal="Exit",
    )


def bounds(o):
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    return [(min(p[i] for p in pts), max(p[i] for p in pts)) for i in range(3)]


def build_closed(collection):
    # The exit: the Star corridor's end wall, cut away below the top of the portal.
    star = bpy.data.objects["Star"]
    (sx, sy, _) = bounds(star)
    cut_box(star, {"x": sx, "y": (STAR_END - 0.01, STAR_END + 0.01), "z": (-0.01, EXIT_TOP)}, [((0, 0, EXIT_TOP), (0, 0, 1))])
    exit_portal(sx, STAR_END, (0, -1, 0), collection)

    # The window: walk-through across its width (sill, frame, the wall below and just
    # above it), seen as before.
    room = bpy.data.objects["Room"]
    c = WINDOW_CUT
    frame = cut_box(
        room,
        c,
        [((c["x"][0], 0, 0), (1, 0, 0)), ((c["x"][1], 0, 0), (1, 0, 0)), ((0, 0, c["z"][1]), (0, 0, 1))],
        split="WindowWall",
    )
    frame["nocollide"] = 1

    # Hidden ramps up to the sill height and back down: across the corridor on its side,
    # and across the window (sloping down on three sides) on the room's.
    h = RAMP_RISE
    wy0, wy1 = WINDOW_WALL_Y
    add_mesh(
        "RampCorridor",
        [(sx[0], wy0, h), (sx[1], wy0, h), (sx[1], wy1 + 0.3, h), (sx[0], wy1 + 0.3, h), (sx[1], wy1 + 0.3 + RAMP_RUN, 0), (sx[0], wy1 + 0.3 + RAMP_RUN, 0)],
        [(0, 1, 2, 3), (3, 2, 4, 5)],
        collection,
        facing=(0, 0, 1),
        hidden=1,
    )
    x0, x1 = WINDOW_X
    top = [(x0, wy1, h), (x1, wy1, h), (x1, wy0 - 0.3, h), (x0, wy0 - 0.3, h)]
    foot = [(x0 - RAMP_RUN, wy1, 0), (x1 + RAMP_RUN, wy1, 0), (x1 + RAMP_RUN, wy0 - 0.3 - RAMP_RUN, 0), (x0 - RAMP_RUN, wy0 - 0.3 - RAMP_RUN, 0)]
    add_mesh(
        "RampRoom",
        top + foot,
        [(0, 1, 2, 3), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)],
        collection,
        facing=(0, 0, 1),
        hidden=1,
    )


def build_open(collection):
    # The exit: the end wall of the corridor behind the door, cut away below the top of
    # the portal (both its faces and the edges between).
    room = bpy.data.objects["Room"]
    box = dict(OPEN_CUT, z=(-0.05, EXIT_TOP))
    cut_box(room, box, [((0, 0, EXIT_TOP), (0, 0, 1))])
    # The corridor's inner walls, either side of the exit.
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene
    mid = Vector((1.15, OPEN_END + 0.5, 1.0))
    xs = []
    for d in ((-1, 0, 0), (1, 0, 0)):
        hit, loc, *_ = scene.ray_cast(dg, mid, Vector(d))
        if not hit:
            raise SystemExit("Couldn't find the walls of the corridor behind the door")
        xs.append(loc.x)
    exit_portal(xs, OPEN_END, (0, 1, 0), collection)


def build(keep):
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    for name in [*VARIANTS, *SKIP]:
        if name != keep:
            for o in list(bpy.data.collections[name].all_objects):
                bpy.data.objects.remove(o)
    collection = bpy.data.collections[keep]
    (build_closed if keep == "Closed" else build_open)(collection)

    # Everything under one scaled root (scaling the objects themselves would change
    # their modifiers).
    root = bpy.data.objects.new("Bedroom", None)
    bpy.context.scene.collection.objects.link(root)
    for o in bpy.data.objects:
        if o is not root and o.parent is None:
            o.parent = root
    root.scale = (SCALE,) * 3

    glb = os.path.join(ROOT, "public", "levels", VARIANTS[keep] + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=glb,
        export_format="GLB",
        export_extras=True,
        export_lights=True,
        export_apply=True,
        export_yup=True,
        export_import_convert_lighting_mode="COMPAT",
        # Nothing here is textured (the Room's "Untitled" image is blank white) or uses
        # the vertex colours, and the meshes are dense: leave them out.
        export_texcoords=False,
        export_vertex_color="NONE",
        export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=False,
        export_image_format="NONE",
    )
    print("Exported", glb)


for variant in VARIANTS:
    build(variant)

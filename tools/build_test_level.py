"""Builds the prototype test level in Blender and exports it for the web build.

Run from the web/ folder:  npm run level:test
(or: blender -b --python tools/build_test_level.py)

Writes blender/test_level.blend (open it to see how things are tagged)
and public/levels/test.glb (what the game loads).

Tagging conventions (object custom properties, exported as glTF extras):
  portal = "A", link = "B"   -> a flat, vertical plane becomes a portal to plane "B".
                                The portal's front is the side its face normal points to.
  recursion = 4              -> optional, max portal-in-portal depth (default 4).
  spawn = 1                  -> empty where the player starts, looking along its local +Y.
  nocollide = 1              -> mesh the player can walk through.
"""
import bpy
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(ROOT, "blender", "test_level.blend")
GLB = os.path.join(ROOT, "public", "levels", "test.glb")

bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, roughness=0.8, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = strength
    return m


def collection(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def move_to(obj, coll):
    for c in obj.users_collection:
        c.objects.unlink(obj)
    coll.objects.link(obj)


def box(name, coll, center, size, mat, **props):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center, scale=size)
    o = bpy.context.active_object
    o.name = name
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    for k, v in props.items():
        o[k] = v
    move_to(o, coll)
    return o


def wall(name, coll, mat, axis, at, a, b, height, t=0.3, door=None, base=0.0):
    """Wall running along `axis` ('x' or 'y') from a to b, at fixed other coordinate `at`.
    door = (center, width, height) cuts an opening."""
    segs = [(a, b, 0.0, height)]
    if door:
        c, w, h = door
        segs = [(a, c - w / 2, 0.0, height), (c + w / 2, b, 0.0, height), (c - w / 2, c + w / 2, h, height)]
    for i, (s, e, z0, z1) in enumerate(segs):
        mid, length, zc, h = (s + e) / 2, e - s, base + (z0 + z1) / 2, z1 - z0
        if axis == "x":
            box(f"{name}.{i}", coll, (mid, at, zc), (length, t, h), mat)
        else:
            box(f"{name}.{i}", coll, (at, mid, zc), (t, length, h), mat)


# Rotation that turns a default (+Z facing) plane upright, facing the given direction.
FACING = {"-y": 0.0, "+y": math.pi, "-x": -math.pi / 2, "+x": math.pi / 2}


def portal(name, coll, mat, center, size, facing, link):
    bpy.ops.mesh.primitive_plane_add(size=1, location=center, rotation=(math.pi / 2, 0, FACING[facing]))
    o = bpy.context.active_object
    o.name = f"Portal_{name}"
    o.scale = (size[0], size[1], 1)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.data.materials.append(mat)
    o["portal"] = name
    o["link"] = link
    move_to(o, coll)
    return o


def point_light(name, coll, loc, power, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, "POINT")
    d.energy = power
    d.color = color
    d.shadow_soft_size = 0.2
    o = bpy.data.objects.new(name, d)
    o.location = loc
    coll.objects.link(o)


# --- materials -------------------------------------------------------------
white_wall = material("GalleryWall", (0.8, 0.8, 0.78))
gallery_floor = material("GalleryFloor", (0.12, 0.11, 0.1), roughness=0.5)
plinth_mat = material("Plinth", (0.9, 0.9, 0.9))
black_box = material("BlackBox", (0.015, 0.015, 0.02), roughness=0.3)
door_glow = material("DoorGlow", (1, 1, 1), emission=(1, 0.95, 0.85), strength=6)
panel_glow = material("CeilingPanel", (1, 1, 1), emission=(1, 1, 1), strength=3)
art_red = material("ArtRed", (0.6, 0.05, 0.03), roughness=0.4)
art_gold = material("ArtGold", (0.8, 0.55, 0.15), roughness=0.25)
hall_wall = material("HallWall", (0.35, 0.05, 0.04))
hall_floor = material("HallFloor", (0.05, 0.05, 0.06), roughness=0.35)
pillar_mat = material("Pillar", (0.7, 0.65, 0.55))
sun_glow = material("Sun", (1, 0.5, 0.2), emission=(1, 0.45, 0.15), strength=8)
portal_mat = material("PortalMarker", (1, 0, 1), emission=(1, 0, 1), strength=1)

# --- gallery: a 16x16 room whose east and west doorways loop into each other ---
g = collection("Gallery")
box("Floor", g, (0, 0, -0.1), (16.6, 16.6, 0.2), gallery_floor)
box("Ceiling", g, (0, 0, 4.6), (16.6, 16.6, 0.2), white_wall)
wall("WallN", g, white_wall, "x", 8, -8.15, 8.15, 4.5)
wall("WallS", g, white_wall, "x", -8, -8.15, 8.15, 4.5)
wall("WallE", g, white_wall, "y", 8, -8, 8, 4.5, door=(0, 1.6, 2.6))
wall("WallW", g, white_wall, "y", -8, -8, 8, 4.5, door=(0, 1.6, 2.6))
for i, y in enumerate((-4, 0, 4)):
    box(f"CeilingPanel.{i}", g, (0, y, 4.47), (6, 0.4, 0.06), panel_glow, nocollide=1)

for i, (x, y, art) in enumerate(((-4.5, 4.5, art_red), (4.5, 4.5, art_gold), (-4.5, -3.5, art_gold), (4.5, -3.5, art_red))):
    box(f"Plinth.{i}", g, (x, y, 0.5), (0.8, 0.8, 1.0), plinth_mat)
    box(f"Art.{i}", g, (x, y, 1.35), (0.4, 0.4, 0.7), art)

point_light("GalleryLight.0", g, (-4, -4, 4), 400)
point_light("GalleryLight.1", g, (4, 4, 4), 400)

# --- the black box: small outside, a whole hall inside ----------------------
b = collection("Box")
wall("BoxFront", b, black_box, "x", -0.125, -1.2, 1.2, 3.2, t=0.15, door=(0, 1.2, 2.3))
wall("BoxBack", b, black_box, "x", 2.125, -1.2, 1.2, 3.2, t=0.15)
wall("BoxL", b, black_box, "y", -1.125, -0.2, 2.2, 3.2, t=0.15)
wall("BoxR", b, black_box, "y", 1.125, -0.2, 2.2, 3.2, t=0.15)
box("BoxRoof", b, (0, 1.0, 3.125), (2.4, 2.4, 0.15), black_box)
box("BoxDoorGlow.L", b, (-0.62, -0.21, 1.17), (0.04, 0.03, 2.34), door_glow, nocollide=1)
box("BoxDoorGlow.R", b, (0.62, -0.21, 1.17), (0.04, 0.03, 2.34), door_glow, nocollide=1)
box("BoxDoorGlow.T", b, (0, -0.21, 2.32), (1.28, 0.03, 0.04), door_glow, nocollide=1)

# --- the hall, far away at x=100 ---------------------------------------------
h = collection("Hall")
HX = 100
box("HallFloor", h, (HX, 0, -0.1), (20.6, 30.6, 0.2), hall_floor)
box("HallCeiling", h, (HX, 0, 10.1), (20.6, 30.6, 0.2), hall_wall)
wall("HallWallN", h, hall_wall, "x", 15, HX - 10.15, HX + 10.15, 10)
wall("HallWallS", h, hall_wall, "x", -15, HX - 10.15, HX + 10.15, 10, door=(HX, 1.2, 2.3))
wall("HallWallE", h, hall_wall, "y", HX + 10, -15, 15, 10)
wall("HallWallW", h, hall_wall, "y", HX - 10, -15, 15, 10)
for i, y in enumerate(range(-10, 13, 4)):
    box(f"Pillar.L{i}", h, (HX - 6, y, 5), (1, 1, 10), pillar_mat)
    box(f"Pillar.R{i}", h, (HX + 6, y, 5), (1, 1, 10), pillar_mat)
box("Sun", h, (HX, 14.8, 5), (6, 0.1, 6), sun_glow, nocollide=1)
for i, y in enumerate((-9, 0, 9)):
    point_light(f"HallLight.{i}", h, (HX, y, 8), 1500, color=(1, 0.75, 0.55))

# --- portals -----------------------------------------------------------------
p = collection("Portals")
portal("E", p, portal_mat, (8, 0, 1.3), (1.6, 2.6), "-x", "W")
portal("W", p, portal_mat, (-8, 0, 1.3), (1.6, 2.6), "+x", "E")
portal("BoxOutside", p, portal_mat, (0, -0.125, 1.15), (1.2, 2.3), "-y", "BoxInside")
portal("BoxInside", p, portal_mat, (HX, -15, 1.15), (1.2, 2.3), "+y", "BoxOutside")

bpy.ops.object.empty_add(type="ARROWS", location=(0, -6, 0))
spawn = bpy.context.active_object
spawn.name = "Spawn"
spawn["spawn"] = 1

# --- save + export -----------------------------------------------------------
os.makedirs(os.path.dirname(BLEND), exist_ok=True)
os.makedirs(os.path.dirname(GLB), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.export_scene.gltf(
    filepath=GLB,
    export_format="GLB",
    export_extras=True,
    export_lights=True,
    export_apply=True,
    export_yup=True,
    export_import_convert_lighting_mode="COMPAT",
)
print("Exported", GLB)

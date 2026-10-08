"""Exports the rooms behind the 5555 doors from blender/Room5555.blend.

Run from the web/ folder:  npm run level:5555
(or: blender -b blender/Room5555.blend --python tools/build_room5555.py)

Room5555.blend holds one room in two versions: everything outside the "Left" and "Right"
collections is in both, and each collection only goes into its own door's room. Writes
public/levels/room5555-left.glb and room5555-right.glb (see ROOMS in src/main.js).

The faces with the "PortalFace" material are where the door's portal goes: they are cut
out of their mesh into a portal plane named "Entrance". The room was modelled at 0.8x the
starting area's scale (that opening is 2 x 3.16, the doors 2.5 x 3.955), so it is
exported scaled up by SCALE. glTF has no Glass BSDF, so glass materials are exported as
clear, mostly transparent surfaces instead. The .blend itself is left untouched.

The "Card" mesh (Left room) is the template for the sentence cards: the game lays one
card per line of public/sentences.txt over the faces of the Room mesh's "Floor" vertex
group, copied out here into a `cardarea` mesh (see src/cards.js).

Objects in UNIFORM are exported with every face in one material (the Ceiling had a
leftover face in another).
"""
import bpy
import bmesh
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(ROOT, "blender", "Room5555.blend")
SCALE = 1.25
VARIANTS = {"Left": "room5555-left", "Right": "room5555-right"}
PORTAL_MATERIAL = "PortalFace"
GLASS_ALPHA = 0.15
CARD_FLOOR_GROUP = "Floor"  # vertex group on the Room mesh: the faces the cards are spread over
UNIFORM = {"Ceiling": "Material.003"}  # objects exported all in one material (the walls')


def cut_portal():
    """Moves the PortalFace faces out of their mesh into a portal plane."""
    for o in list(bpy.data.objects):
        if o.type != "MESH":
            continue
        slots = [i for i, m in enumerate(o.data.materials) if m and m.name == PORTAL_MATERIAL]
        if not slots:
            continue
        bm = bmesh.new()
        bm.from_mesh(o.data)
        faces = [f for f in bm.faces if f.material_index in slots]
        if not faces:
            bm.free()
            continue

        # The plane: a copy of just those faces.
        plane = bmesh.new()
        verts = {}
        for f in faces:
            for v in f.verts:
                if v not in verts:
                    verts[v] = plane.verts.new(v.co)
            plane.faces.new([verts[v] for v in f.verts])
        me = bpy.data.meshes.new("Entrance")
        plane.to_mesh(me)
        plane.free()
        portal = bpy.data.objects.new("Portal_Entrance", me)
        portal.matrix_world = o.matrix_world
        portal["portal"] = "Entrance"
        for c in o.users_collection:
            c.objects.link(portal)

        bmesh.ops.delete(bm, geom=faces, context="FACES_ONLY")
        bm.to_mesh(o.data)
        bm.free()
        return portal
    raise SystemExit(f"No faces with the {PORTAL_MATERIAL} material")


def convert_glass():
    """Glass BSDF -> a Principled BSDF the exporter understands: thin, clear, see-through."""
    for m in bpy.data.materials:
        nodes = m.node_tree.nodes if m.use_nodes and m.node_tree else []
        glass = next((n for n in nodes if n.type == "BSDF_GLASS"), None)
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)
        if not glass or not out:
            continue
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.inputs["Base Color"].default_value = glass.inputs["Color"].default_value
        bsdf.inputs["Roughness"].default_value = 0.05
        bsdf.inputs["Alpha"].default_value = GLASS_ALPHA
        m.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        m.blend_method = "BLEND"


def tag_cards(keep):
    """Card template and the floor area they're scattered over (both walk-through)."""
    card = bpy.data.objects.get("Card")
    if not card:
        return
    card["nocollide"] = 1
    room = bpy.data.objects["Room"]
    group = room.vertex_groups.get(CARD_FLOOR_GROUP)
    if not group:
        raise SystemExit(f'Room has no "{CARD_FLOOR_GROUP}" vertex group for the cards')
    src = room.data
    inside = {v.index for v in src.vertices if any(g.group == group.index and g.weight > 0 for g in v.groups)}
    faces = [p for p in src.polygons if all(i in inside for i in p.vertices)]
    if not faces:
        raise SystemExit(f'No faces lie wholly in the "{CARD_FLOOR_GROUP}" vertex group')
    used = sorted({i for p in faces for i in p.vertices})
    remap = {old: new for new, old in enumerate(used)}
    me = bpy.data.meshes.new("CardArea")
    me.from_pydata([room.matrix_world @ src.vertices[i].co for i in used], [], [[remap[i] for i in p.vertices] for p in faces])
    area = bpy.data.objects.new("CardArea", me)
    area["cardarea"] = 1
    area["nocollide"] = 1
    bpy.data.collections[keep].objects.link(area)


def uniform_materials():
    """Every face of each UNIFORM object in its one material (leftover slots ignored)."""
    for name, material in UNIFORM.items():
        o = bpy.data.objects.get(name)
        if not o:
            continue
        index = next((i for i, s in enumerate(o.material_slots) if s.material and s.material.name == material), None)
        if index is None:
            raise SystemExit(f'{name} has no "{material}" material slot')
        for p in o.data.polygons:
            p.material_index = index


def build(keep):
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    for name in VARIANTS:
        if name != keep:
            for o in list(bpy.data.collections[name].all_objects):
                bpy.data.objects.remove(o)
    cut_portal()
    convert_glass()
    uniform_materials()
    tag_cards(keep)

    # Everything under one scaled root (scaling the objects themselves would change
    # their bevel/solidify modifiers).
    root = bpy.data.objects.new("Room5555", None)
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
    )
    print("Exported", glb)


for variant in VARIANTS:
    build(variant)

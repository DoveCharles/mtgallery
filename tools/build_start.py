"""Exports the starting area for the web build.

Run from the web/ folder:  npm run level:start

Reads blender/StartingArea.blend (edit that file; this script never saves it) and
writes public/levels/start.glb. The intro looks objects and materials up by name,
so keep these names:
  M, Button                 -> the black M and the throbbing button on it
  CeilingWhite (material)   -> pure white, blends into the white ground
  Material.002 (material)   -> the black corridor floor
  Spawn (empty, optional)   -> where the intro lands; added at the corridor end if missing
"""
import bpy
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB = os.path.join(ROOT, "public", "levels", "start.glb")

# Texture files the blend points at may not exist on this machine; the game
# recolours those materials anyway, so drop missing images instead of exporting broken refs.
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    for n in list(m.node_tree.nodes):
        if n.type == "TEX_IMAGE" and (not n.image or not n.image.has_data):
            m.node_tree.nodes.remove(n)

if "Spawn" not in bpy.data.objects:
    spawn = bpy.data.objects.new("Spawn", None)
    spawn.location = (0, -0.35, 0.06)
    bpy.context.scene.collection.objects.link(spawn)
bpy.data.objects["Spawn"]["spawn"] = 1

os.makedirs(os.path.dirname(GLB), exist_ok=True)
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

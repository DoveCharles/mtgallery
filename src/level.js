import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

// Custom properties set in Blender land in userData. A property on a parent
// object (e.g. a multi-material mesh exported as a group) applies to its children.
function prop(obj, key) {
  for (let o = obj; o; o = o.parent) {
    if (o.userData[key] !== undefined) return o.userData[key];
  }
  return undefined;
}

// `moving(obj)` marks meshes that will move at runtime (doors), so they stay out of the
// static collider; the code that moves them handles their collision itself.
// Several levels can share a scene: `offset` moves one out of the others' way, and
// `world` names it, prefixing its portal ids ("test/E") and tagging its portals.
export async function loadLevel(url, scene, onProgress, moving = () => false, { offset, world } = {}) {
  const gltf = await new GLTFLoader().loadAsync(url, onProgress);
  const root = gltf.scene;
  if (offset) root.position.copy(offset);
  scene.add(root);
  root.updateMatrixWorld(true);
  const id = (v) => (world ? `${world}/${v}` : String(v));

  const portals = [];
  const colliderParts = [];
  let spawn = null;

  root.traverse((o) => {
    if (o.userData.spawn) spawn = o;
    if (!o.isMesh) return;

    if (prop(o, 'portal') !== undefined) {
      portals.push({
        id: id(prop(o, 'portal')),
        link: prop(o, 'link') ? id(prop(o, 'link')) : null, // unlinked until the game links it
        world,
        recursion: prop(o, 'recursion'),
        mesh: o,
      });
      return;
    }
    if (prop(o, 'hidden')) o.visible = false; // still solid
    if (prop(o, 'nocollide')) return;
    for (let a = o; a; a = a.parent) if (moving(a)) return;

    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const part = new THREE.BufferGeometry();
    part.setAttribute('position', g.getAttribute('position').clone().applyMatrix4(o.matrixWorld));
    colliderParts.push(part);
  });

  // Portal planes are only markers; the portal system draws its own screens.
  // (Detached with their world transform kept, so an offset level's portals stay put.)
  for (const p of portals) {
    scene.attach(p.mesh);
    p.mesh.removeFromParent();
  }

  return { root, colliderGeometry: mergeGeometries(colliderParts), spawn, portals };
}

// One collider for all the levels in the scene.
export const buildCollider = (levels) => new MeshBVH(mergeGeometries(levels.map((l) => l.colliderGeometry)));

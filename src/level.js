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

export async function loadLevel(url, scene, onProgress) {
  const gltf = await new GLTFLoader().loadAsync(url, onProgress);
  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);

  const portals = [];
  const colliderParts = [];
  let spawn = null;

  root.traverse((o) => {
    if (o.userData.spawn) spawn = o;
    if (!o.isMesh) return;

    if (prop(o, 'portal') !== undefined) {
      portals.push({
        id: String(prop(o, 'portal')),
        link: String(prop(o, 'link')),
        recursion: prop(o, 'recursion'),
        mesh: o,
      });
      return;
    }
    if (prop(o, 'nocollide')) return;

    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const part = new THREE.BufferGeometry();
    part.setAttribute('position', g.getAttribute('position').clone().applyMatrix4(o.matrixWorld));
    colliderParts.push(part);
  });

  // Portal planes are only markers; the portal system draws its own screens.
  for (const p of portals) p.mesh.removeFromParent();

  const collider = new MeshBVH(mergeGeometries(colliderParts));
  return { root, collider, spawn, portals };
}

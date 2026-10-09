import * as THREE from 'three';

// The wax paintings in room 5555 (right)'s frames. Blender has each row's paintings as one
// mesh (a small square in the middle of each frame) showing a placeholder scan: it's cut into
// one mesh per painting, and each shows its own image (public/textures/wax: 1k copies of the
// Unity project's WaxPaintings), cropped as the Unity project's materials had it: `scale` of
// the image across the square, from `offset` (as Unity's tiling and offset).

const CROPS = {
  'test-2': { scale: [1.02, 0.76], offset: [-0.01, 0.22] },
  'test-3': { scale: [0.97, 0.93], offset: [0, 0] },
  'test-3-1-2': { scale: [0.78, 0.67], offset: [0.13, 0.3] },
  'test-3-2': { scale: [1, 0.72], offset: [0, 0.13] },
};
const WHOLE = { scale: [1, 1], offset: [0, 0] };
const GAP = 0.3; // m, at least, between one painting and the next

const textures = {};
function texture(image) {
  if (textures[image]) return textures[image];
  const t = new THREE.TextureLoader().load(`/textures/wax/${image}.jpg`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return (textures[image] = t);
}

// Replaces `mesh` (a row's paintings) with one mesh per painting, showing `paintings` left to
// right as you face the row: image names, each with " turned" after it to hang it upside down.
export function hangPaintings(mesh, paintings) {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const position = g.attributes.position;
  const normal = g.attributes.normal;
  const world = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));

  // Across the row, as you face it: right is up × the way the paintings face.
  const facing = new THREE.Vector3().fromBufferAttribute(normal, 0).transformDirection(mesh.matrixWorld);
  const right = new THREE.Vector3(0, 1, 0).cross(facing).normalize();
  const across = world.map((p) => p.dot(right));

  // The triangles, by how far along the row they are; a gap starts the next painting.
  const triangles = Array.from({ length: position.count / 3 }, (_, t) => ({ t, at: (across[t * 3] + across[t * 3 + 1] + across[t * 3 + 2]) / 3 }));
  triangles.sort((a, b) => a.at - b.at);
  const groups = [];
  for (const tri of triangles) {
    const last = groups.at(-1);
    if (last && tri.at - last.at.at(-1) < GAP) last.at.push(tri.at), last.t.push(tri.t);
    else groups.push({ at: [tri.at], t: [tri.t] });
  }

  groups.forEach((group, i) => {
    const [image, turned] = (paintings[i] ?? paintings[0]).split(' ');
    const { scale, offset } = CROPS[image] ?? WHOLE;
    const verts = group.t.flatMap((t) => [t * 3, t * 3 + 1, t * 3 + 2]);
    const box = { u: [Infinity, -Infinity], v: [Infinity, -Infinity] };
    for (const k of verts) {
      box.u = [Math.min(box.u[0], across[k]), Math.max(box.u[1], across[k])];
      box.v = [Math.min(box.v[0], world[k].y), Math.max(box.v[1], world[k].y)];
    }
    const pos = new Float32Array(verts.length * 3);
    const nor = new Float32Array(verts.length * 3);
    const uv = new Float32Array(verts.length * 2);
    verts.forEach((k, j) => {
      pos.set([position.getX(k), position.getY(k), position.getZ(k)], j * 3);
      nor.set([normal.getX(k), normal.getY(k), normal.getZ(k)], j * 3);
      let u = (across[k] - box.u[0]) / (box.u[1] - box.u[0]);
      let v = (world[k].y - box.v[0]) / (box.v[1] - box.v[0]);
      if (turned) (u = 1 - u), (v = 1 - v);
      uv.set([offset[0] + scale[0] * u, offset[1] + scale[1] * v], j * 2);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // Unlit, as the Unity project's (URP's Unlit shader): the image as it is, whatever the light.
    const material = new THREE.MeshBasicMaterial({ name: 'WaxPainting', map: texture(image), side: mesh.material.side });
    const painting = new THREE.Mesh(geometry, material);
    painting.name = `${mesh.name}_${i}`;
    painting.position.copy(mesh.position);
    painting.quaternion.copy(mesh.quaternion);
    painting.scale.copy(mesh.scale);
    painting.layers.mask = mesh.layers.mask;
    painting.castShadow = mesh.castShadow;
    painting.receiveShadow = mesh.receiveShadow;
    mesh.parent.add(painting);
  });
  mesh.removeFromParent();
}

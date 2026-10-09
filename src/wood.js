import * as THREE from 'three';

// Procedural wood: the grain is worked out from the position inside a block of wood (an
// object's local space), not from UVs, so it lines up across parts and needs no unwrapping.
// The grain runs horizontally along each side (along x on the faces facing z, along z on
// those facing x), like boards: growth rings around a heart well off below one side (they
// show as long, gently wavering bands, like flat-sawn boards), fine fibres along the grain,
// and some slow blotchiness, all from value noise. The same grain bumps the surface: the
// harder latewood stands a little proud of the earlywood and the fibres are fine grooves.

const GRAIN = /* glsl */ `
uniform vec3 woodEarly;
uniform vec3 woodLate;
uniform float woodRings;
uniform vec3 woodHeart;
uniform vec3 woodCentre;
uniform vec3 woodHalf;
uniform float woodBump;
varying vec3 vWood;
varying vec3 vWoodNormal;
float woodHeight; // set by woodAt

float woodHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float woodNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(woodHash(i), woodHash(i + vec3(1, 0, 0)), f.x), mix(woodHash(i + vec3(0, 1, 0)), woodHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(woodHash(i + vec3(0, 0, 1)), woodHash(i + vec3(1, 0, 1)), f.x), mix(woodHash(i + vec3(0, 1, 1)), woodHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float woodFbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * woodNoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
// Colour (linear) and roughness at p; the grain runs along x.
vec4 woodAt(vec3 p) {
  vec3 q = p - woodHeart;
  q.yz += (woodFbm(q * vec3(0.4, 1.2, 1.2)) - 0.5) * 0.12; // the log isn't quite straight
  float r = length(q.yz) * woodRings + woodFbm(q * vec3(0.3, 4.0, 4.0)) * 0.7;
  float ring = fract(r);
  // Each year's ring: pale earlywood darkening into latewood, then a sharp edge.
  float late = smoothstep(0.55, 0.97, ring) * (1.0 - smoothstep(0.97, 1.0, ring));
  float fibre = woodNoise(q * vec3(2.0, 160.0, 160.0));
  // Fibres finer than a pixel or so would only shimmer as bumps: they fade out with distance.
  float fibreBump = 1.0 - smoothstep(0.4, 1.2, length(fwidth(q.yz * 160.0)));
  woodHeight = late + (fibre - 0.5) * 0.45 * fibreBump;
  float year = woodHash(vec3(floor(r), 3.1, 7.7));
  vec3 colour = mix(woodEarly, woodLate, clamp(late * 0.85 + fibre * 0.2, 0.0, 1.0));
  colour *= (0.88 + 0.24 * year) * (0.8 + 0.4 * woodFbm(q * vec3(0.4, 2.5, 2.5)));
  return vec4(colour, mix(0.55, 0.75, late));
}
// The grain along whichever horizontal axis lies in the face; flat faces (the top, a slit's
// top and bottom) take that of the nearest side.
vec4 woodBoard() {
  vec3 p = vWood - woodCentre;
  vec3 n = abs(vWoodNormal);
  bool xSide = n.y > max(n.x, n.z) ? abs(p.x) / woodHalf.x > abs(p.z) / woodHalf.z : n.x > n.z;
  return woodAt(xSide ? p.zyx : p);
}
// The normal tilted by woodHeight's slope across the screen (as three's bump map does).
vec3 woodBumped(vec3 surfPos, vec3 n) {
  vec3 dpx = dFdx(surfPos);
  vec3 dpy = dFdy(surfPos);
  vec3 r1 = cross(dpy, n);
  vec3 r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(woodHeight) * r1 + dFdy(woodHeight) * r2);
  return normalize(abs(det) * n - woodBump * grad);
}
`;

const linear = (hex) => new THREE.Color(hex); // three converts sRGB hex to linear

// `space`: the object whose local space is the block of wood (pass the same one for parts
// that should share a grain). `heart`: where the log's centre line passes, from the
// middle of `space`'s mesh (x is along the grain, y up, z the depth into the face).
export function woodMaterial({
  space,
  side = THREE.FrontSide,
  early = 0xb08458,
  late = 0x6b4426,
  rings = 14, // per unit (of `space`)
  heart = new THREE.Vector3(0, -3, -2.5),
  bump = 0.001, // how deep the grain is (world units, roughly)
} = {}) {
  const material = new THREE.MeshStandardMaterial({ side, roughness: 1, metalness: 0 });
  material.name = 'ProceduralWood';
  space.updateWorldMatrix(true, false);
  space.geometry.computeBoundingBox();
  const uniforms = {
    woodSpace: { value: space.matrixWorld.clone().invert() },
    woodEarly: { value: linear(early) },
    woodLate: { value: linear(late) },
    woodRings: { value: rings },
    woodHeart: { value: heart },
    woodCentre: { value: space.geometry.boundingBox.getCenter(new THREE.Vector3()) },
    woodHalf: { value: space.geometry.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(0.5) },
    woodBump: { value: bump },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 woodSpace;\nvarying vec3 vWood;\nvarying vec3 vWoodNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWood = (woodSpace * modelMatrix * vec4(transformed, 1.0)).xyz;\nvWoodNormal = normalize(mat3(woodSpace * modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GRAIN}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec4 wood = woodBoard();\ndiffuseColor.rgb *= wood.rgb;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= wood.a;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = woodBumped(-vViewPosition, normal);');
  };
  material.customProgramCacheKey = () => 'procedural-wood';
  return material;
}

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

// Stained quarter-sawn oak (room 5555's frames, after a photo of the real ones): boards
// laid flat, one above another, each showing the growth rings edge-on as fine straight lines
// along it, with the oak's ray fleck rippling across them in patches, lighter flakes outlined
// darker. All in world space (a metre is a metre), so separate pieces don't line up like one
// block.
const OAK = /* glsl */ `
uniform vec3 oakDark;
uniform vec3 oakMid;
uniform vec3 oakLight;
uniform float oakBoard;
uniform float oakBump;
varying vec3 vOak;
varying vec3 vOakNormal;
float oakHeight; // set by oakAt

float oakHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float oakNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(oakHash(i), oakHash(i + vec3(1, 0, 0)), f.x), mix(oakHash(i + vec3(0, 1, 0)), oakHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(oakHash(i + vec3(0, 0, 1)), oakHash(i + vec3(1, 0, 1)), f.x), mix(oakHash(i + vec3(0, 1, 1)), oakHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float oakFbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * oakNoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
// Colour (linear) and roughness at g: x across the grain, y along it (m).
vec4 oakAt(vec2 g) {
  float board = floor(g.x / oakBoard);
  float bh = oakHash(vec3(board, 1.3, 2.7));
  // The rings, edge on: fine lines along the grain, wavering a little, blurred to an
  // average where they'd be finer than a pixel.
  float x = g.x + (oakFbm(vec3(g.x * 4.0, g.y * 0.7, bh * 10.0)) - 0.5) * 0.03;
  float ring = oakNoise(vec3(x * 120.0, g.y * 1.5, bh * 20.0));
  ring = smoothstep(0.25, 0.75, ring);
  ring = mix(ring, 0.5, smoothstep(0.4, 1.2, fwidth(x * 120.0)));
  // Ray fleck: the contours of a field that changes faster along the grain than across,
  // so they ripple across it as thin wavy lines round faintly lighter flakes; in patches.
  float f = oakFbm(vec3(g.x * 9.0, g.y * 26.0, bh * 30.0 + 5.0)) * 5.0;
  float band = fract(f);
  float edge = 1.0 - smoothstep(0.0, max(0.09, fwidth(f) * 1.5), min(band, 1.0 - band));
  edge *= 1.0 - smoothstep(0.5, 1.0, fwidth(f)); // too fine to see: gone
  float patches = smoothstep(0.4, 0.62, oakFbm(vec3(g.x * 6.0, g.y * 2.5, bh * 7.0)));
  float flake = smoothstep(0.3, 0.7, band) * patches;
  oakHeight = ring * 0.4 + flake * 0.3 - edge * patches * 0.3;
  vec3 colour = mix(oakMid, oakDark, ring * 0.7);
  colour = mix(colour, oakLight, flake * 0.45);
  colour = mix(colour, oakDark, edge * patches * 0.55);
  colour *= (0.85 + 0.3 * bh) * (0.85 + 0.3 * oakFbm(vec3(g.x * 2.0, g.y * 0.4, 3.0)));
  return vec4(colour, mix(0.5, 0.62, ring) - flake * 0.08);
}
// The grain runs horizontally along the sides; on the faces looking up or down, along x.
vec4 oakBoardAt() {
  vec3 n = abs(vOakNormal);
  vec2 g = n.y > max(n.x, n.z) ? vOak.zx : vec2(vOak.y, n.x > n.z ? vOak.z : vOak.x);
  return oakAt(g);
}
vec3 oakBumped(vec3 surfPos, vec3 n) {
  vec3 dpx = dFdx(surfPos);
  vec3 dpy = dFdy(surfPos);
  vec3 r1 = cross(dpy, n);
  vec3 r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(oakHeight) * r1 + dFdy(oakHeight) * r2);
  return normalize(abs(det) * n - oakBump * grad);
}
`;

export function oakMaterial({
  side = THREE.FrontSide,
  dark = 0x24160b,
  mid = 0x4a3020,
  light = 0x6e4e30,
  board = 0.16, // m, how wide the boards are
  bump = 0.0006,
} = {}) {
  const material = new THREE.MeshStandardMaterial({ side, roughness: 1, metalness: 0 });
  material.name = 'Oak';
  const uniforms = {
    oakDark: { value: linear(dark) },
    oakMid: { value: linear(mid) },
    oakLight: { value: linear(light) },
    oakBoard: { value: board },
    oakBump: { value: bump },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOak;\nvarying vec3 vOakNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOak = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvOakNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${OAK}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec4 oak = oakBoardAt();\ndiffuseColor.rgb *= oak.rgb;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= oak.a;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = oakBumped(-vViewPosition, normal);');
  };
  material.customProgramCacheKey = () => 'quarter-sawn-oak';
  return material;
}

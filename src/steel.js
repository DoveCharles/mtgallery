import * as THREE from 'three';

// Grey powder-coated steel (room 5555's frames, after a photo of the real ones): a satin
// paint finish over metal, its surface a fine sandy stipple (tiny bumps, and specks a shade
// lighter or darker), with a few faint chalky scuffs. All in world space; the stipple fades
// to smooth where it would be finer than a pixel, so it doesn't shimmer.

const STEEL = /* glsl */ `
uniform float steelGrain;
uniform float steelBump;
varying vec3 vSteel;
float steelHeight; // set by steelAt

float steelHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float steelNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(steelHash(i), steelHash(i + vec3(1, 0, 0)), f.x), mix(steelHash(i + vec3(0, 1, 0)), steelHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(steelHash(i + vec3(0, 0, 1)), steelHash(i + vec3(1, 0, 1)), f.x), mix(steelHash(i + vec3(0, 1, 1)), steelHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float steelFbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * steelNoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
// Brightness (x) and roughness (y) at p.
vec2 steelAt(vec3 p) {
  vec3 q = p / steelGrain;
  float fine = 1.0 - smoothstep(0.4, 1.0, length(fwidth(q)));
  float stipple = steelNoise(q) * 0.6 + steelNoise(q * 2.3 + 7.1) * 0.4;
  float speck = steelHash(floor(q * 1.5));
  steelHeight = stipple * fine;
  float shade = 1.0 + ((stipple - 0.5) * 0.25 + (speck - 0.5) * 0.18) * fine;
  // Scuffs: faint lighter smears, here and there, stretched sideways.
  float smear = smoothstep(0.62, 0.8, steelFbm(p * vec3(3.0, 12.0, 3.0) + 11.0));
  shade *= 1.0 + smear * 0.35;
  // Gentle unevenness in the coat.
  shade *= 0.92 + 0.16 * steelFbm(p * 1.5);
  return vec2(shade, 1.0 - smear * 0.2);
}
vec3 steelBumped(vec3 surfPos, vec3 n) {
  vec3 dpx = dFdx(surfPos);
  vec3 dpy = dFdy(surfPos);
  vec3 r1 = cross(dpy, n);
  vec3 r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(steelHeight) * r1 + dFdy(steelHeight) * r2);
  return normalize(abs(det) * n - steelBump * grad);
}
`;

export function steelMaterial({
  side = THREE.FrontSide,
  colour = 0x8a8c8f,
  metalness = 0.1,
  roughness = 0.55,
  grain = 0.002, // m, how fine the stipple is
  bump = 0.0004,
} = {}) {
  const material = new THREE.MeshStandardMaterial({ side, color: colour, metalness, roughness });
  material.name = 'PowderCoat';
  const uniforms = { steelGrain: { value: grain }, steelBump: { value: bump } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSteel;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSteel = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STEEL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec2 steel = steelAt(vSteel);\ndiffuseColor.rgb *= steel.x;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= steel.y;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = steelBumped(-vViewPosition, normal);');
  };
  material.customProgramCacheKey = () => 'powder-coat';
  return material;
}

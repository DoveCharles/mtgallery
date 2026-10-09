import * as THREE from 'three';

// Shade zones: the sky and bounce light (the environment map and hemisphere light) reach
// every surface equally, roofed or not, so an indoor space looks as bright as outdoors.
// A shade zone is everything underneath an object (a ceiling), within its footprint: there
// surfaces get only `light` of that light, fading back to full over FEATHER outside it.
// Direct light (the sun, which the ceiling already shadows, and area lights) is untouched.
// The zones are shared by every patched material (the worlds are far apart, and some
// materials are shared between them).
// A void (see addVoid) is a wall that shows no light at all: inside its box, surfaces
// facing out of the wall are pure black.

const FEATHER = 0.25; // m
const MAX_ZONES = 4;
const MAX_VOIDS = 2;

const uniforms = {
  shadeMin: { value: Array.from({ length: MAX_ZONES }, () => new THREE.Vector3(1e9, 1e9, 1e9)) },
  shadeMax: { value: Array.from({ length: MAX_ZONES }, () => new THREE.Vector3(-1e9, -1e9, -1e9)) },
  shadeK: { value: Array(MAX_ZONES).fill(1) },
  voidMin: { value: Array.from({ length: MAX_VOIDS }, () => new THREE.Vector3(1e9, 1e9, 1e9)) },
  voidMax: { value: Array.from({ length: MAX_VOIDS }, () => new THREE.Vector3(-1e9, -1e9, -1e9)) },
  voidFacing: { value: Array.from({ length: MAX_VOIDS }, () => new THREE.Vector3()) },
};
let zoneCount = 0;
let voidCount = 0;
const patched = new WeakSet();

// Adds the zones under `objects` (or world boxes; `light` of the light reaches them) and
// patches every standard material under `root`.
export function applyShadeZones(root, objects, light) {
  for (const o of objects) {
    if (zoneCount === MAX_ZONES) break;
    const b = o.isBox3 ? o : new THREE.Box3().setFromObject(o);
    uniforms.shadeMin.value[zoneCount].copy(b.min).setY(-1e4);
    uniforms.shadeMax.value[zoneCount].copy(b.max);
    uniforms.shadeK.value[zoneCount] = light;
    zoneCount++;
  }

  patchMaterials(root);
}

// Makes the surfaces in `box` (world space) that face `facing` (a world direction) pure black,
// in the materials applyShadeZones patches.
export function addVoid(box, facing) {
  if (voidCount === MAX_VOIDS) return;
  uniforms.voidMin.value[voidCount].copy(box.min);
  uniforms.voidMax.value[voidCount].copy(box.max);
  uniforms.voidFacing.value[voidCount].copy(facing).normalize();
  voidCount++;
}

function patchMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [o.material].flat()) {
      if (!m.isMeshStandardMaterial || patched.has(m)) continue;
      patched.add(m);
      // On top of any patch the material has already (the procedural wood's, say).
      const before = m.onBeforeCompile.bind(m);
      const key = m.customProgramCacheKey.bind(m)();
      m.onBeforeCompile = (shader, renderer) => {
        before(shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vShadePos;')
          .replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nvShadePos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
varying vec3 vShadePos;
uniform vec3 shadeMin[${MAX_ZONES}];
uniform vec3 shadeMax[${MAX_ZONES}];
uniform float shadeK[${MAX_ZONES}];
uniform vec3 voidMin[${MAX_VOIDS}];
uniform vec3 voidMax[${MAX_VOIDS}];
uniform vec3 voidFacing[${MAX_VOIDS}];
bool inVoid(vec3 p, vec3 n) {
  for (int i = 0; i < ${MAX_VOIDS}; i++) {
    if (all(greaterThanEqual(p, voidMin[i])) && all(lessThanEqual(p, voidMax[i])) && dot(n, voidFacing[i]) > 0.5) return true;
  }
  return false;
}
float shadeAt(vec3 p) {
  float shade = 1.0;
  for (int i = 0; i < ${MAX_ZONES}; i++) {
    vec3 q = max(shadeMin[i] - p, p - shadeMax[i]);
    float d = max(max(q.x, q.y), q.z); // distance outside the zone (<= 0 inside)
    shade = min(shade, mix(shadeK[i], 1.0, smoothstep(0.0, ${FEATHER.toFixed(2)}, d)));
  }
  return shade;
}`,
          )
          .replace(
            '#include <lights_fragment_maps>',
            `#include <lights_fragment_maps>
{
  float shade = shadeAt(vShadePos);
  irradiance *= shade;
  iblIrradiance *= shade;
  #if defined( RE_IndirectSpecular )
    radiance *= shade;
  #endif
}`,
          )
          .replace(
            '#include <dithering_fragment>',
            `if (inVoid(vShadePos, inverseTransformDirection(normal, viewMatrix))) gl_FragColor.rgb = vec3(0.0);
#include <dithering_fragment>`,
          );
      };
      m.customProgramCacheKey = () => `${key}+shade`;
      m.needsUpdate = true;
    }
  });
}

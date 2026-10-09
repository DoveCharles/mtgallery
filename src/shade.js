import * as THREE from 'three';

// Shade zones: the sky and bounce light (the environment map and hemisphere light) reach
// every surface equally, roofed or not, so an indoor space looks as bright as outdoors.
// A shade zone is everything underneath an object (a ceiling), within its footprint: there
// surfaces get only `light` of that light, fading back to full over FEATHER outside it.
// Direct light (the sun, which the ceiling already shadows, and area lights) is untouched.
// The zones are shared by every patched material (the worlds are far apart, and some
// materials are shared between them).

const FEATHER = 0.25; // m
const MAX_ZONES = 4;

const uniforms = {
  shadeMin: { value: Array.from({ length: MAX_ZONES }, () => new THREE.Vector3(1e9, 1e9, 1e9)) },
  shadeMax: { value: Array.from({ length: MAX_ZONES }, () => new THREE.Vector3(-1e9, -1e9, -1e9)) },
  shadeK: { value: Array(MAX_ZONES).fill(1) },
};
let zoneCount = 0;
const patched = new WeakSet();

// Adds the zones under `objects` (`light` of the light reaches them) and patches every
// standard material under `root`.
export function applyShadeZones(root, objects, light) {
  for (const o of objects) {
    if (zoneCount === MAX_ZONES) break;
    const b = new THREE.Box3().setFromObject(o);
    uniforms.shadeMin.value[zoneCount].copy(b.min).setY(-1e4);
    uniforms.shadeMax.value[zoneCount].copy(b.max);
    uniforms.shadeK.value[zoneCount] = light;
    zoneCount++;
  }

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
          );
      };
      m.customProgramCacheKey = () => `${key}+shade`;
      m.needsUpdate = true;
    }
  });
}

import * as THREE from 'three';

// Shade zones: the sky and bounce light (the environment map and hemisphere light) reach
// every surface equally, roofed or not, so an indoor space looks as bright as outdoors.
// A shade zone is everything underneath an object (a ceiling), within its footprint: there
// surfaces get only `light` of that light, fading back to full over FEATHER outside it.
// Direct light (the sun, which the ceiling already shadows, and area lights) is untouched.

const FEATHER = 0.25; // m
const MAX_ZONES = 4;

// Patches every standard material under `root` with the zones under `objects`.
export function applyShadeZones(root, objects, light) {
  const zones = objects.slice(0, MAX_ZONES).map((o) => {
    const b = new THREE.Box3().setFromObject(o);
    b.min.y = -1e4;
    return b;
  });
  if (!zones.length) return;

  const pad = (a, v) => [...a, ...Array(MAX_ZONES - a.length).fill(v)];
  const uniforms = {
    shadeMin: { value: pad(zones.map((z) => z.min), new THREE.Vector3(1e9, 1e9, 1e9)) },
    shadeMax: { value: pad(zones.map((z) => z.max), new THREE.Vector3(-1e9, -1e9, -1e9)) },
    shadeK: { value: light },
  };

  const patched = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [o.material].flat()) {
      if (!m.isMeshStandardMaterial || patched.has(m)) continue;
      patched.add(m);
      m.onBeforeCompile = (shader) => {
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
uniform float shadeK;
float shadeAt(vec3 p) {
  float d = 1e9; // distance outside the nearest zone (<= 0 inside)
  for (int i = 0; i < ${MAX_ZONES}; i++) {
    vec3 q = max(shadeMin[i] - p, p - shadeMax[i]);
    d = min(d, max(max(q.x, q.y), q.z));
  }
  return mix(shadeK, 1.0, smoothstep(0.0, ${FEATHER.toFixed(2)}, d));
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
      m.customProgramCacheKey = () => 'shade';
      m.needsUpdate = true;
    }
  });
}

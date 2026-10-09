import * as THREE from 'three';

// TV static, for a screen with no UVs: grains of noise laid out across whichever face of
// the mesh they're on (from its local position, on the two axes the face spans), fresh every
// frame of a 30 fps picture, with faint scanlines and a slow brighter band rolling down.
// It glows (unlit, not tone mapped). `time` is shared: set it each frame (see setStaticTime).

const time = { value: 0 };

export function staticMaterial({ grain = 0.004, brightness = 0.85 } = {}) {
  return new THREE.ShaderMaterial({
    name: 'TVStatic',
    toneMapped: false,
    uniforms: { time, grain: { value: grain }, brightness: { value: brightness } },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vNormal;
      void main() {
        vLocal = position;
        vNormal = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform float grain;
      uniform float brightness;
      varying vec3 vLocal;
      varying vec3 vNormal;
      float hash(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      void main() {
        vec3 n = abs(vNormal);
        vec2 face = n.x > max(n.y, n.z) ? vLocal.zy : n.y > n.z ? vLocal.xz : vLocal.xy;
        // Grains a little wider than tall, as a TV's lines.
        vec2 cell = floor(face / vec2(grain * 1.4, grain));
        float frame = floor(time * 30.0);
        float v = hash(vec3(cell, frame));
        v = v * v; // mostly dark, with bright specks
        float line = 0.85 + 0.15 * sin(face.y / grain * 3.14159);
        float roll = 1.0 + 0.25 * smoothstep(0.85, 1.0, sin(face.y * 8.0 - time * 1.7));
        gl_FragColor = vec4(vec3(v * line * roll * brightness), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

export const setStaticTime = (t) => (time.value = t);

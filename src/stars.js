import * as THREE from 'three';

// Space, painted on a mesh (the closed bedroom's Star corridor): every surface shows the
// starry sky in the direction it's seen from the camera, not anything at the surface, so the
// walls and ceiling vanish and walking down the corridor feels like walking through space,
// with stars all round (below the horizon too). Only the floor (faces looking up) is black:
// the ground underfoot.
// The stars are procedural (as the Unity project's ProceduralStarSk): a few layers of cells on
// the sky, each with a chance of one star somewhere inside, drawn at least a pixel across so
// they don't flicker.

const STARS = /* glsl */ `
varying vec3 vWorld;
varying vec3 vWorldNormal;

float starHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
vec3 starHash3(vec3 p) {
  return vec3(starHash(p), starHash(p + 17.31), starHash(p + 41.97));
}
// One layer: cells per unit of direction, the chance a cell has a star, its size (radians)
// and brightness.
vec3 starLayer(vec3 dir, float cells, float chance, float size, float bright, float px) {
  vec3 cell = floor(dir * cells);
  vec3 h = starHash3(cell);
  if (starHash(cell + 7.7) > chance) return vec3(0.0);
  vec3 star = normalize((cell + 0.2 + 0.6 * h) / cells);
  float r = max(size, px);
  float d = length(dir - star) / r;
  // Shrinking a star below a pixel dims it instead, so faint ones fade rather than shimmer.
  float glow = exp(-d * d * 2.5) * bright * (size * size) / (r * r);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.72), h.x); // blue-white to warm
  return tint * glow * (0.4 + 0.6 * h.y);
}
`;

export function starsMaterial({ side = THREE.DoubleSide } = {}) {
  return new THREE.ShaderMaterial({
    name: 'Stars',
    side,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vWorldNormal;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${STARS}
      void main() {
        vec3 dir = normalize(vWorld - cameraPosition);
        float px = length(fwidth(dir)) * 0.9; // a pixel, in radians
        vec3 colour = starLayer(dir, 40.0, 0.3, 0.0008, 1.0, px) // many faint
          + starLayer(dir, 20.0, 0.3, 0.0012, 1.6, px)
          + starLayer(dir, 8.0, 0.25, 0.002, 2.5, px); // a few bright
        vec3 n = gl_FrontFacing ? vWorldNormal : -vWorldNormal; // towards the camera
        if (n.y > 0.7) colour = vec3(0.0); // the floor
        gl_FragColor = vec4(colour, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

import * as THREE from 'three';

// Contact-hardening soft shadows (PCSS) for the sun. three.js's own soft shadows blur
// every edge by the same amount; real shadows are crisp where an object meets the
// ground and soften the further the caster is from the surface. This swaps the
// filtering of BasicShadowMap (which, unlike PCF, can read raw depths) for:
//   1. a blocker search: the average depth of whatever is shading this point,
//   2. a penumbra as wide as the light seen from here: (receiver - blocker) * LIGHT_SIZE,
//   3. a PCF filter of that width.
// Depths are compared in shadow-map units, which assumes the shadow camera's depth range
// equals its width (true for the sun in main.js: 2r wide, near r to far 3r).

const LIGHT_SIZE = 0.025; // tan of the sun's apparent radius; the real sun is ~0.005
const MAX_DIST = 0.5; // farthest caster searched for, as a fraction of the depth range
const BLOCKER_SAMPLES = 16;
const PCF_SAMPLES = 32;

const helpers = /* glsl */ `
  float pcssNoise( vec2 p ) {
    return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
  }
  vec2 pcssDisk( int i, int n, float phi ) {
    float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
    float t = float( i ) * 2.39996323 + phi;
    return vec2( cos( t ), sin( t ) ) * r;
  }
  // How far in front of the receiver (depth z) a stored depth is; > 0 means it shades it.
  float pcssOcclusion( float depth, float z ) {
    #ifdef USE_REVERSED_DEPTH_BUFFER
      return depth - z;
    #else
      return z - depth;
    #endif
  }
  float pcssShadow( sampler2D shadowMap, vec2 shadowMapSize, vec2 uv, float z ) {
    float phi = pcssNoise( gl_FragCoord.xy ) * PI2;
    float search = ${LIGHT_SIZE.toFixed(4)} * ${MAX_DIST.toFixed(4)};
    float sum = 0.0;
    float blockers = 0.0;
    for ( int i = 0; i < ${BLOCKER_SAMPLES}; i ++ ) {
      float d = pcssOcclusion( texture2D( shadowMap, uv + pcssDisk( i, ${BLOCKER_SAMPLES}, phi ) * search ).r, z );
      if ( d > 0.0 ) {
        sum += d;
        blockers += 1.0;
      }
    }
    if ( blockers == 0.0 ) return 1.0;
    float penumbra = clamp( sum / blockers * ${LIGHT_SIZE.toFixed(4)}, 1.5 / shadowMapSize.x, search );
    float lit = 0.0;
    for ( int i = 0; i < ${PCF_SAMPLES}; i ++ ) {
      lit += step( pcssOcclusion( texture2D( shadowMap, uv + pcssDisk( i, ${PCF_SAMPLES}, phi ) * penumbra ).r, z ), 0.0 );
    }
    return lit / float( ${PCF_SAMPLES} );
  }
`;

// Call before any material compiles, with renderer.shadowMap.type = BasicShadowMap.
export function softShadows() {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  // The hard-shadow lookup inside the basic getShadow(), up to the end of its #ifdef.
  const start = chunk.indexOf('float depth = texture2D( shadowMap, shadowCoord.xy ).r;');
  const end = start < 0 ? -1 : chunk.indexOf('#endif', start);
  const fn = start < 0 ? -1 : chunk.lastIndexOf('float getShadow( sampler2D shadowMap', start);
  if (start < 0 || end < 0 || fn < 0) {
    console.warn('softShadows: three.js shadow shader changed; keeping hard shadows');
    return;
  }
  THREE.ShaderChunk.shadowmap_pars_fragment =
    chunk.slice(0, fn) +
    helpers +
    chunk.slice(fn, start) +
    'shadow = pcssShadow( shadowMap, shadowMapSize, shadowCoord.xy, shadowCoord.z );\n' +
    chunk.slice(end + '#endif'.length);
}

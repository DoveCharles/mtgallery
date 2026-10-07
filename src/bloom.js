import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Selective bloom: only the meshes passed in glow (the keypad lights and button rims).
// They are drawn into a half-size buffer over a black, depth-only copy of the scene (so
// walls still hide them), blurred, and added on top of the finished frame. Nothing runs
// while none of them is lit.
const STRENGTH = 0.45;
const RADIUS = 0.2;
const THRESHOLD = 0.1;
const LAYER = 1;

const AddShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  // The bloom is linear; the screen is sRGB.
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec3 c = max(texture2D(tDiffuse, vUv).rgb, 0.0);
      gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
    }`,
};

export class Bloom {
  meshes = [];

  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.pass = new UnrealBloomPass(new THREE.Vector2(1, 1), STRENGTH, RADIUS, THRESHOLD);
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({ ...AddShader, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }),
    );
    this.quad.material.uniforms.tDiffuse.value = this.pass.renderTargetsHorizontal[0].texture;
    this.setSize();
  }

  add(meshes) {
    for (const m of meshes) {
      m.layers.enable(LAYER);
      this.meshes.push(m);
    }
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(0.5).floor();
    this.target.setSize(size.x, size.y);
    this.pass.setSize(size.x, size.y);
  }

  lit() {
    return this.meshes.some((m) => {
      const c = m.material.color;
      return m.visible && Math.max(c.r, c.g, c.b) > THRESHOLD;
    });
  }

  render() {
    if (!this.lit()) return;
    const { renderer, scene, camera } = this;
    const shadows = renderer.shadowMap.autoUpdate;
    const autoClear = renderer.autoClear;
    const background = scene.background;
    const mask = camera.layers.mask;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;

    // Everything black, for depth; then the glowing meshes on top in their own colours.
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.autoClear = false;
    scene.overrideMaterial = this.black;
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    camera.layers.set(LAYER);
    renderer.render(scene, camera);
    camera.layers.mask = mask;

    this.pass.render(renderer, null, this.target);

    renderer.setRenderTarget(null);
    this.quad.render(renderer);

    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadows;
    scene.background = background;
    renderer.setClearColor(clearColor, clearAlpha);
  }
}

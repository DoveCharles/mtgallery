import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Screen-space ambient occlusion (GTAO), multiplied over the finished frame.
// The scene still renders straight to the screen, so tone mapping and the
// toneMapped: false whites (CeilingWhite, the ground) stay exactly as they were.
// Portal views get the same treatment from their own camera (render(camera, target)).
// Portal screens are hidden while it is worked out: they are pictures of somewhere else,
// already shaded, and the doorway around them mustn't darken them.
const RADIUS = 1.2; // world units
const INTENSITY = 0.9;
const SCALE = 0.5; // worked out at half resolution and stretched over the frame: it's soft anyway
const SAMPLES = 8;
// How far in depth a sample may sit from the point and still count as occluding it. At 1, the
// floor beside a wall seen at a glancing angle missed the wall and stayed light along the seam.
const THICKNESS = 3;

export class AmbientOcclusion {
  enabled = true;
  hidden = []; // objects left out of the occlusion (portal screens)

  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(SCALE).floor();
    this.pass = new GTAOPass(scene, camera, size.x, size.y, undefined, {
      radius: RADIUS,
      distanceExponent: 1,
      thickness: THICKNESS,
      scale: 1,
      samples: SAMPLES,
    });
    this.pass.output = GTAOPass.OUTPUT.Off; // only compute; the blend is done below
    this.pass.blendMaterial.uniforms.tDiffuse.value = this.pass.pdRenderTarget.texture;
    this.pass.blendMaterial.uniforms.intensity.value = INTENSITY;
    this.quad = new FullScreenQuad(this.pass.blendMaterial);
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(SCALE).floor();
    this.pass.setSize(size.x, size.y);
  }

  // Darkens what `camera` has just drawn into `target` (null: the screen), only within
  // `scissor` (a pixel Vector4) if given.
  render(camera = this.camera, target = null, scissor = null) {
    if (!this.enabled) return;
    const renderer = this.renderer;
    const pass = this.pass;
    const targets = [pass.normalRenderTarget, pass.gtaoRenderTarget, pass.pdRenderTarget];
    for (const t of targets) {
      t.scissorTest = !!scissor;
      if (scissor) t.scissor.set(Math.floor(scissor.x * SCALE), Math.floor(scissor.y * SCALE), Math.ceil(scissor.z * SCALE) + 1, Math.ceil(scissor.w * SCALE) + 1);
    }
    // The normal/depth pass would otherwise redraw the shadow maps.
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const shown = this.hidden.filter((o) => o.visible);
    for (const o of shown) o.visible = false;
    this.pass.camera = camera;
    this.pass.render(renderer, null, null);
    for (const o of shown) o.visible = true;
    renderer.shadowMap.autoUpdate = shadows;

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
    for (const t of targets) t.scissorTest = false;
  }
}

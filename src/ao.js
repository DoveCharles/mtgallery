import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Screen-space ambient occlusion (GTAO), multiplied over the finished frame.
// The scene still renders straight to the screen, so tone mapping and the
// toneMapped: false whites (CeilingWhite, the ground) stay exactly as they were.
const RADIUS = 1.2; // world units
const INTENSITY = 0.9;

export class AmbientOcclusion {
  enabled = true;

  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.pass = new GTAOPass(scene, camera, size.x, size.y, undefined, {
      radius: RADIUS,
      distanceExponent: 1,
      thickness: 1,
      scale: 1,
      samples: 16,
    });
    this.pass.output = GTAOPass.OUTPUT.Off; // only compute; the blend is done below
    this.pass.blendMaterial.uniforms.tDiffuse.value = this.pass.pdRenderTarget.texture;
    this.pass.blendMaterial.uniforms.intensity.value = INTENSITY;
    this.quad = new FullScreenQuad(this.pass.blendMaterial);
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.pass.setSize(size.x, size.y);
  }

  render() {
    if (!this.enabled) return;
    const renderer = this.renderer;
    // The normal/depth pass would otherwise redraw the shadow maps.
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    this.pass.render(renderer, null, null);
    renderer.shadowMap.autoUpdate = shadows;

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }
}

import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Screen-space ambient occlusion (GTAO), multiplied over the finished frame.
// The scene still renders straight to the screen, so tone mapping and the
// toneMapped: false whites (CeilingWhite, the ground) stay exactly as they were.
// Portal screens are hidden while it is worked out (the doorway around them mustn't be
// darkened by them) and left out of the blend by a stencil mask they write (what's behind
// them in this world, the horizon of the ground plane say, has nothing to do with them).
// Portal views get their own AO instead (renderFactor): they're drawn linear and only
// tone-mapped on their screen, so it's handed to the screen to multiply in after that,
// the same as the main view.
const RADIUS = 1.2; // world units
const INTENSITY = 0.9;
const SCALE = 0.5; // worked out at half resolution and stretched over the frame: it's soft anyway
const SAMPLES = 8;
// How far in depth a sample may sit from the point and still count as occluding it. At 1, the
// floor beside a wall seen at a glancing angle missed the wall and stayed light along the seam.
const THICKNESS = 3;
export const SCREEN_STENCIL = 1; // written by the portal screens: no main-view AO there

export class AmbientOcclusion {
  enabled = true;
  strength = 1; // 0..1, scales INTENSITY (the intro fades it in)
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
    const blend = this.pass.blendMaterial;
    blend.uniforms.tDiffuse.value = this.pass.pdRenderTarget.texture;
    Object.assign(blend, {
      stencilWrite: true, // turns the stencil test on; every op is Keep, so nothing is written
      stencilRef: SCREEN_STENCIL,
      stencilFunc: THREE.NotEqualStencilFunc,
    });
    this.quad = new FullScreenQuad(blend);
    // The same AO factor, written out as is for a portal screen to multiply in.
    this.factorMaterial = blend.clone();
    Object.assign(this.factorMaterial, { blending: THREE.NoBlending, transparent: false, stencilWrite: false });
    this.factorMaterial.uniforms.tDiffuse.value = this.pass.pdRenderTarget.texture;
    this.factorQuad = new FullScreenQuad(this.factorMaterial);
    this.factorTargets = new Map(); // one per portal
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(SCALE).floor();
    this.pass.setSize(size.x, size.y);
    for (const t of this.factorTargets.values()) t.setSize(size.x, size.y);
  }

  // Darkens what the main camera has just drawn to the screen, except the portal screens.
  render() {
    if (!this.compute(this.camera)) return;
    const renderer = this.renderer;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    this.pass.blendMaterial.uniforms.intensity.value = INTENSITY * this.strength;
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  // Works out the AO of what `camera` sees (within `scissor`, a pixel Vector4, if given)
  // and returns it as a texture of darkening factors in screen space, kept per `key`.
  renderFactor(camera, scissor, key) {
    let out = this.factorTargets.get(key);
    if (!out) {
      const { width, height } = this.pass.pdRenderTarget;
      out = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
      this.factorTargets.set(key, out);
    }
    const renderer = this.renderer;
    const on = this.compute(camera, scissor);
    this.setScissor(out, scissor);
    renderer.setRenderTarget(out);
    if (on) {
      this.factorMaterial.uniforms.intensity.value = INTENSITY * this.strength;
      this.factorQuad.render(renderer);
    } else {
      const color = renderer.getClearColor(new THREE.Color());
      const alpha = renderer.getClearAlpha();
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, false, false);
      renderer.setClearColor(color, alpha);
    }
    out.scissorTest = false;
    return out.texture;
  }

  setScissor(target, scissor) {
    target.scissorTest = !!scissor;
    if (scissor) target.scissor.set(Math.floor(scissor.x * SCALE), Math.floor(scissor.y * SCALE), Math.ceil(scissor.z * SCALE) + 1, Math.ceil(scissor.w * SCALE) + 1);
  }

  // Fills the pass's AO texture for `camera`. False if AO is off.
  compute(camera, scissor = null) {
    if (!this.enabled || this.strength <= 0) return false;
    const renderer = this.renderer;
    const pass = this.pass;
    const targets = [pass.normalRenderTarget, pass.gtaoRenderTarget, pass.pdRenderTarget];
    for (const t of targets) this.setScissor(t, scissor);
    // The normal/depth pass would otherwise redraw the shadow maps.
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const shown = this.hidden.filter((o) => o.visible);
    for (const o of shown) o.visible = false;
    this.pass.camera = camera;
    this.pass.render(renderer, null, null);
    for (const o of shown) o.visible = true;
    renderer.shadowMap.autoUpdate = shadows;
    for (const t of targets) t.scissorTest = false;
    return true;
  }
}

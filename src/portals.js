import * as THREE from 'three';
import { SCREEN_STENCIL } from './ao.js';

// How portals work
// ----------------
// Each portal has a "frame": an Object3D at the centre of its plane whose local +Z is
// the portal's front. Looking into portal A shows what you'd see looking *out of* its
// linked portal B, so a virtual camera is placed at  B * rotY(180) * inverse(A) * eye.
// That view is rendered into a texture which A's screen samples in screen space, with
// everything between the virtual camera and B clipped away. Portals visible through
// themselves (a room that loops into itself) are rendered deepest-level first.

const ROT_Y_180 = new THREE.Matrix4().makeRotationY(Math.PI);
const FULL_RECT = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
const SCISSOR_PAD = 16; // pixels around a portal's on-screen rectangle that are drawn too
const SCISSOR_NEAR = 0.5; // closer than this to a portal, its views cover the whole screen

const screenVertex = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  void main() {
    #include <begin_vertex>
    #include <project_vertex>
    #include <clipping_planes_vertex>
  }
`;

const screenFragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 resolution;
  uniform bool enabled;
  uniform vec3 fallback;
  uniform bool useAo;
  uniform sampler2D aoMap;
  #include <common>
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = enabled ? texture2D(map, gl_FragCoord.xy / resolution) : vec4(fallback, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // Ambient occlusion of the view, applied after tone mapping like the main view's.
    if (useAo) gl_FragColor.rgb *= texture2D(aoMap, gl_FragCoord.xy / resolution).r;
  }
`;

const _v = new THREE.Vector3();
const _v4 = new THREE.Vector4();
const _scissor = new THREE.Vector4();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _viewProj = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _normalMatrix = new THREE.Matrix3();
const _box = new THREE.Box3();

class Portal {
  active = true; // false while hidden anyway (behind a closed door): skip rendering it

  constructor({ id, link, world, recursion, mesh }) {
    this.id = id;
    this.linkId = link;
    this.world = world;
    this.recursion = recursion ?? 4;
    this.linked = null;

    // Derive an upright frame from the marker plane: centre, facing and size.
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry;
    _normalMatrix.getNormalMatrix(mesh.matrixWorld);
    _n.fromBufferAttribute(geo.getAttribute('normal'), 0).applyMatrix3(_normalMatrix);
    _n.y = 0;
    _n.normalize();
    _box.setFromObject(mesh);
    const center = _box.getCenter(new THREE.Vector3());

    this.frame = new THREE.Object3D();
    this.frame.name = `PortalFrame_${id}`;
    this.frame.position.copy(center);
    this.frame.lookAt(_v.copy(center).add(_n));
    this.frame.updateMatrixWorld();

    let halfW = 0;
    let halfH = 0;
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      this.frame.worldToLocal(_v);
      halfW = Math.max(halfW, Math.abs(_v.x));
      halfH = Math.max(halfH, Math.abs(_v.y));
    }
    this.width = halfW * 2;
    this.height = halfH * 2;

    this.normal = _n.clone();
    // Clips everything behind this portal when it is the one being looked out of.
    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal, center);

    this.uniforms = {
      map: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      enabled: { value: false },
      fallback: { value: new THREE.Color(0x050506) },
      useAo: { value: false },
      aoMap: { value: null },
    };
    this.aoMap = null; // from afterView, for the view straight through
    this.screen = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: screenVertex,
        fragmentShader: screenFragment,
        clipping: true,
        side: THREE.DoubleSide,
        // Marks its pixels so the main view's AO leaves them alone (see ao.js).
        stencilWrite: true,
        stencilRef: SCREEN_STENCIL,
        stencilZPass: THREE.ReplaceStencilOp,
      }),
    );
    this.screen.scale.set(this.width, this.height, 0.001);
    this.frame.add(this.screen);

    this.toLinked = new THREE.Matrix4();
    this.target = null;
  }

  link(other) {
    this.linked = other;
    this.toLinked
      .copy(other.frame.matrixWorld)
      .multiply(ROT_Y_180)
      .multiply(_m.copy(this.frame.matrixWorld).invert());
  }

  signedDistance(point) {
    return this.plane.distanceToPoint(point);
  }

  // Give the screen depth on the far side so the camera's near plane can't slice
  // through it as you walk through the doorway.
  protectFromNearClip(camera) {
    const halfH = camera.near * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const halfW = halfH * camera.aspect;
    const depth = Math.hypot(halfW, halfH, camera.near);
    const side = this.signedDistance(camera.position) >= 0 ? 1 : -1;
    this.screen.scale.z = depth;
    this.screen.position.z = (-side * depth) / 2;
  }

  // Normalised-device-coordinate rectangle this portal covers for a camera, or null.
  screenRect(viewProj) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      _v.set((sx * this.width) / 2, (sy * this.height) / 2, 0);
      this.frame.localToWorld(_v);
      _v4.set(_v.x, _v.y, _v.z, 1).applyMatrix4(viewProj);
      if (_v4.w <= 0) return FULL_RECT; // straddles the camera: be conservative
      minX = Math.min(minX, _v4.x / _v4.w);
      maxX = Math.max(maxX, _v4.x / _v4.w);
      minY = Math.min(minY, _v4.y / _v4.w);
      maxY = Math.max(maxY, _v4.y / _v4.w);
    }
    if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) return null;
    return { minX, maxX, minY, maxY };
  }
}

function overlaps(a, b) {
  return a && b && a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

// Worlds: levels sharing the scene can each have their own lighting. Every portal knows
// which world it is in; each view is rendered after `setWorld(name)` for the world its
// camera is in, and walking through a portal moves the player into the exit's world.
export class PortalSystem {
  // afterView(camera, target, level, scissor, portal) runs after each portal view is drawn
  // (for post effects); level 0 is the view straight through the portal, deeper ones are
  // portals seen in it, and scissor is the pixel rectangle (Vector4) the view was limited to.
  // For level 0 it may return an AO texture (see ao.js) for the portal's screen to apply.
  constructor(renderer, scene, defs, { world, setWorld, afterView } = {}) {
    this.renderer = renderer;
    this.portals = defs.map((d) => new Portal(d));
    this.world = world;
    this.setWorld = setWorld ?? (() => {});
    this.afterView = afterView ?? (() => {});
    this.screens = this.portals.map((p) => p.screen);

    this.byId = new Map(this.portals.map((p) => [p.id, p]));
    for (const p of this.portals) {
      const other = this.byId.get(p.linkId);
      if (other) p.link(other);
      else if (p.linkId) console.warn(`Portal "${p.id}" links to missing portal "${p.linkId}"`);
      scene.add(p.frame);
    }

    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = true;
    const maxDepth = Math.max(1, ...this.portals.map((p) => p.recursion));
    this.levels = Array.from({ length: maxDepth }, () => new THREE.Matrix4());

    // One texture per portal plus a shared scratch texture to ping-pong recursion levels.
    const makeTarget = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.scratch = makeTarget();
    for (const p of this.portals) p.target = makeTarget();
    this.setSize();
  }

  // Joins two portals both ways (replacing whatever they were linked to).
  connect(a, b) {
    a = this.byId.get(a) ?? a;
    b = this.byId.get(b) ?? b;
    a.link(b);
    b.link(a);
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.scratch.setSize(size.x, size.y);
    for (const p of this.portals) {
      p.target.setSize(size.x, size.y);
      p.uniforms.resolution.value.copy(size);
    }
  }

  // Teleport the player if their eye crossed a portal from front to back this frame.
  handleTraversal(player, prevEye, eye) {
    for (const p of this.portals) {
      if (!p.linked || !p.active) continue;
      const d0 = p.signedDistance(prevEye);
      const d1 = p.signedDistance(eye);
      if (d0 < 0 || d1 >= 0) continue;

      _v.lerpVectors(prevEye, eye, d0 / (d0 - d1));
      p.frame.worldToLocal(_v);
      if (Math.abs(_v.x) > p.width / 2 || Math.abs(_v.y) > p.height / 2) continue;

      player.applyTransform(p.toLinked);
      this.world = p.linked.world;
      return p;
    }
    return null;
  }

  render(scene, mainCamera) {
    _viewProj.multiplyMatrices(mainCamera.projectionMatrix, mainCamera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);

    const visible = [];
    for (const p of this.portals) {
      p.protectFromNearClip(mainCamera);
      p.frame.updateMatrixWorld();
      if (p.linked && p.active && p.signedDistance(mainCamera.position) > 0 && _frustum.intersectsObject(p.screen)) {
        visible.push(p);
      }
    }

    for (const p of visible) {
      this.setWorld(p.linked.world);
      this.renderPortal(p, scene, mainCamera);
    }
    this.setWorld(this.world);

    // Main pass: only portals we are in front of show anything.
    for (const p of this.portals) {
      const show = visible.includes(p);
      p.screen.visible = show;
      p.uniforms.enabled.value = show;
      p.uniforms.useAo.value = show && !!p.aoMap;
      if (show) p.uniforms.map.value = p.target.texture;
      p.uniforms.aoMap.value = p.aoMap;
    }
  }

  // Pixel rectangle the portal covers in the main view, padded.
  scissorFor(portal, mainCamera) {
    const { width, height } = portal.target;
    let rect = FULL_RECT;
    if (portal.signedDistance(mainCamera.position) > SCISSOR_NEAR) {
      _viewProj.multiplyMatrices(mainCamera.projectionMatrix, mainCamera.matrixWorldInverse);
      rect = portal.screenRect(_viewProj) ?? FULL_RECT;
    }
    const x0 = Math.max(0, Math.floor(((rect.minX + 1) / 2) * width) - SCISSOR_PAD);
    const y0 = Math.max(0, Math.floor(((rect.minY + 1) / 2) * height) - SCISSOR_PAD);
    const x1 = Math.min(width, Math.ceil(((rect.maxX + 1) / 2) * width) + SCISSOR_PAD);
    const y1 = Math.min(height, Math.ceil(((rect.maxY + 1) / 2) * height) + SCISSOR_PAD);
    return _scissor.set(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  }

  renderPortal(portal, scene, mainCamera) {
    const renderer = this.renderer;
    const exit = portal.linked;
    const cam = this.camera;
    cam.projectionMatrix.copy(mainCamera.projectionMatrix);
    cam.projectionMatrixInverse.copy(mainCamera.projectionMatrixInverse);

    // Work out how many times this portal can be seen through itself.
    let depth = 0;
    for (let i = 0; i < portal.recursion; i++) {
      this.levels[i].multiplyMatrices(portal.toLinked, i === 0 ? mainCamera.matrixWorld : this.levels[i - 1]);
      depth = i + 1;
      _viewProj.multiplyMatrices(cam.projectionMatrix, _m.copy(this.levels[i]).invert());
      if (!overlaps(portal.screenRect(_viewProj), exit.screenRect(_viewProj))) break;
    }

    // Inside a portal view: the exit is clipped away, other portals show a flat colour.
    for (const p of this.portals) {
      p.screen.visible = p !== exit;
      p.uniforms.enabled.value = p.uniforms.useAo.value = false;
    }
    renderer.clippingPlanes = [exit.plane];

    // Only the part of the screen the portal covers is ever seen (deeper levels too: they
    // show through screens inside it), so draw nothing outside that.
    const scissor = this.scissorFor(portal, mainCamera);
    for (const t of [portal.target, this.scratch]) {
      t.scissor.copy(scissor);
      t.scissorTest = true;
    }

    for (let i = depth - 1; i >= 0; i--) {
      // Level 0 must land in the portal's own target; deeper levels alternate.
      const target = i % 2 === 0 ? portal.target : this.scratch;
      const source = i % 2 === 0 ? this.scratch : portal.target;
      portal.uniforms.enabled.value = i < depth - 1;
      portal.uniforms.map.value = source.texture;

      this.levels[i].decompose(cam.position, cam.quaternion, cam.scale);
      cam.updateMatrixWorld();
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      const ao = this.afterView(cam, target, i, scissor, portal);
      if (i === 0) portal.aoMap = ao || null;
    }

    portal.target.scissorTest = this.scratch.scissorTest = false;
    renderer.setRenderTarget(null);
    renderer.clippingPlanes = [];
  }
}

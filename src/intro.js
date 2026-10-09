import * as THREE from 'three';

// The opening of the starting area.
// Title: the camera hangs far above the M/T, looking straight down through a very
// narrow lens, so the scene reads as a flat logo on white. The button throbs.
// Drop: pressing it lowers the camera to eye height in the corridor while widening the
// lens so the logo keeps its size on screen (a dolly zoom), which turns the flat,
// near-orthographic view into ordinary perspective.
// Tilt: the camera pitches up to look down the corridor, then the player takes over.

const START_HEIGHT = 1500; // above the corridor floor
const FRAME_MARGIN = 2.2; // how much bigger than the M/T the title view is
const DROP_TIME = 3.2;
const TILT_TIME = 1.4;
const THROB_SPEED = 1.5; // matches UIButtonThrob in the Unity project

const smooth = (t) => t * t * (3 - 2 * t);
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class Intro {
  state = 'title';
  time = 0;

  constructor({ camera, dom, player, button, logo, onPress, onLanded, onDone }) {
    this.camera = camera;
    this.dom = dom;
    this.player = player;
    this.button = button;
    this.onPress = onPress;
    this.onLanded = onLanded;
    this.onDone = onDone;
    this.playFov = camera.fov;
    this.playNear = camera.near;
    this.playFar = camera.far;

    // Frame the M/T: its centre, and half its footprint (x across, z along the corridor).
    const box = new THREE.Box3();
    for (const o of logo) box.expandByObject(o);
    this.logoCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.logoHalf = { x: (size.x / 2) * FRAME_MARGIN, y: (size.z / 2) * FRAME_MARGIN };

    this.floorY = player.position.y;
    this.end = player.getEye(new THREE.Vector3());

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hover = false;

    dom.addEventListener('pointermove', (e) => {
      if (this.state !== 'title') return;
      this.hover = this.hitsButton(e);
      dom.style.cursor = this.hover ? 'pointer' : '';
    });
    dom.addEventListener('click', (e) => {
      if (this.state !== 'title' || !this.hitsButton(e)) return;
      dom.style.cursor = '';
      this.button.removeFromParent();
      this.state = 'drop';
      this.time = 0;
      this.onPress?.();
    });

    this.pose(0);
  }

  hitsButton(e) {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObject(this.button, true).length > 0;
  }

  // Lens half-height that frames the logo at distance h.
  framingHalfHeight() {
    return Math.max(this.logoHalf.y, this.logoHalf.x / this.camera.aspect);
  }

  // Camera pose during the drop, u in 0..1.
  pose(u) {
    const cam = this.camera;
    // Descend evenly in log space so the change in perspective feels steady.
    const h = Math.exp(THREE.MathUtils.lerp(Math.log(START_HEIGHT), Math.log(this.end.y - this.floorY), u));
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(this.framingHalfHeight() / h));
    cam.fov = Math.min(this.playFov, fov);
    cam.near = Math.max(this.playNear, h * 0.02);
    cam.far = Math.max(this.playFar, h * 4);
    cam.updateProjectionMatrix();

    // Slide over the button while still high, then drop straight down past it.
    cam.position.lerpVectors(this.logoCenter, this.end, smooth(Math.min(u / 0.55, 1)));
    cam.position.y = this.floorY + h;
    cam.rotation.set(-Math.PI / 2, this.player.yaw, 0, 'YXZ');
    cam.updateMatrixWorld();
  }

  update(dt) {
    this.time += dt;

    if (this.state === 'title') {
      // Black <-> white, brighter while hovered.
      const t = this.hover ? 1 : Math.abs(((this.time * THROB_SPEED) % 2) - 1);
      this.button.material.color.setScalar(t);
      this.pose(0);
    } else if (this.state === 'drop') {
      const t = Math.min(this.time / DROP_TIME, 1);
      this.pose(smoother(t));
      if (t === 1) {
        this.state = 'tilt';
        this.time = 0;
        this.onLanded?.();
      }
    } else if (this.state === 'tilt') {
      const t = Math.min(this.time / TILT_TIME, 1);
      const pitch = THREE.MathUtils.lerp(-Math.PI / 2, 0, smooth(t));
      this.camera.rotation.set(pitch, this.player.yaw, 0, 'YXZ');
      this.camera.updateMatrixWorld();
      if (t === 1) {
        this.state = 'done';
        this.player.pitch = 0;
        this.player.enabled = true;
        this.onDone?.();
      }
    }
    return this.state !== 'done';
  }

  // How much ambient occlusion to draw. None on the title: seen from that high up, the
  // button slab and the M/T would cast soft grey halos onto the white ground. It comes in
  // over the end of the drop, once the view is close to ordinary perspective.
  get aoStrength() {
    if (this.state === 'title') return 0;
    if (this.state === 'drop') return smooth(THREE.MathUtils.clamp((this.time / DROP_TIME - 0.6) / 0.4, 0, 1));
    return 1;
  }

  resize() {
    if (this.state === 'title') this.pose(0);
  }
}

// The walls' second material (the first is CeilingWhite): board-formed concrete, tiled
// as in the Unity project. The maps are 2k exports of the Unity textures in public/textures.
// (Also used for the rooms' concrete, at their own UVs' scale: see main.js.)
const CONCRETE_REPEAT = 10;
export function concreteMaterial(repeat = CONCRETE_REPEAT) {
  const loader = new THREE.TextureLoader();
  const load = (file, srgb) => {
    const t = loader.load(`/textures/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.setScalar(repeat);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return new THREE.MeshStandardMaterial({
    map: load('concrete_layers_02_diff.jpg', true),
    normalMap: load('concrete_layers_02_nor.jpg'),
    roughnessMap: load('concrete_layers_02_rough.jpg'),
  });
}

// The corridor floor (Material.002). It starts pure black so the title reads as a flat
// logo, then fades up to dark worn concrete (the Unity project's Black material used the
// same texture) once the camera is down in the corridor. setReveal(0..1) drives the fade.
const FLOOR_TILE = 2; // metres per texture repeat
function floorMaterial() {
  const loader = new THREE.TextureLoader();
  const load = (file, srgb) => {
    const t = loader.load(`/textures/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const reveal = { value: 0 };
  const m = new THREE.MeshStandardMaterial({
    color: 0xd0d0d0,
    map: load('concrete_floor_worn_001_diff.jpg', true),
    normalMap: load('concrete_floor_worn_001_nor.jpg'),
    roughness: 0.85,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.reveal = reveal;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float reveal;\nvoid main() {')
      .replace('#include <dithering_fragment>', 'gl_FragColor.rgb *= reveal;\n#include <dithering_fragment>');
  };
  m.setReveal = (t) => (reveal.value = t);
  return m;
}

// UVs straight down from above in world space, so the floor tiles at FLOOR_TILE
// whatever its own UVs are.
function planarUvs(mesh) {
  const g = mesh.geometry.clone();
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const uv = new Float32Array(p.count * 2);
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
    uv[i * 2] = v.x / FLOOR_TILE;
    uv[i * 2 + 1] = -v.z / FLOOR_TILE;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  mesh.geometry = g;
}

// Colours the starting area (by Blender object/material names, see tools/build_start.py)
// and adds the black ground and the sky. Returns the button, the meshes forming the M/T
// and the floor material (see floorMaterial).
export function dressStartArea(root, scene, sky) {
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const wall = concreteMaterial();
  const floor = floorMaterial();
  let button = null;
  const logo = [];

  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name;
    if (name === 'Button') {
      o.material = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, side: THREE.DoubleSide });
      button = o;
    } else if (name === 'M') {
      o.material = black;
      logo.push(o);
    } else if (o.material.name === 'CeilingWhite') o.material = white;
    else if (o.material.name === 'Material.002') {
      planarUvs(o);
      o.material = floor;
      logo.push(o);
    }
    else if (o.material.name === 'concrete_layers_02') o.material = wall;
  });

  // The black ground under the starting area.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  scene.add(sky);
  return { button, logo, floor };
}

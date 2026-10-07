import * as THREE from 'three';

// The opening of the starting area.
// Title: the camera hangs far above the M/T, looking straight down through a very
// narrow lens, so the scene reads as a flat logo on white. The button throbs.
// Drop: pressing it lowers the camera to eye height in the corridor while widening the
// lens so the logo keeps its size on screen (a dolly zoom), which turns the flat,
// near-orthographic view into ordinary perspective.
// Tilt: the camera pitches up to look down the corridor, then the player takes over.

const START_HEIGHT = 600; // above the corridor floor
const LOGO_CENTER = new THREE.Vector3(0, 0, -2.8); // middle of the M/T, in three.js coords
const LOGO_HALF_SIZE = { x: 4.2, y: 4.6 }; // half the area to frame from above
const DROP_TIME = 3.2;
const TILT_TIME = 1.4;
const THROB_SPEED = 1.5; // matches UIButtonThrob in the Unity project

const smooth = (t) => t * t * (3 - 2 * t);
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class Intro {
  state = 'title';
  time = 0;

  constructor({ camera, dom, player, button, onPress, onDone }) {
    this.camera = camera;
    this.dom = dom;
    this.player = player;
    this.button = button;
    this.onPress = onPress;
    this.onDone = onDone;
    this.playFov = camera.fov;
    this.playNear = camera.near;
    this.playFar = camera.far;

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
      this.state = 'drop';
      this.time = 0;
      this.onPress?.();
    });

    this.buttonTop = new THREE.Box3().setFromObject(button).max.y + 0.1;
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
    return Math.max(LOGO_HALF_SIZE.y, LOGO_HALF_SIZE.x / this.camera.aspect);
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
    cam.position.lerpVectors(LOGO_CENTER, this.end, smooth(Math.min(u / 0.55, 1)));
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
      this.button.material.color.setScalar(0);
      const t = Math.min(this.time / DROP_TIME, 1);
      this.pose(smoother(t));
      this.button.visible = this.camera.position.y > this.buttonTop;
      if (t === 1) {
        this.state = 'tilt';
        this.time = 0;
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

  resize() {
    if (this.state === 'title') this.pose(0);
  }
}

// Colours the starting area (by Blender object/material names, see tools/build_start.py)
// and adds the white ground and the sky. Returns the button mesh.
export function dressStartArea(root, scene, sky) {
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const wall = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  let button = null;

  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name;
    if (name === 'Button') {
      o.material = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, side: THREE.DoubleSide });
      button = o;
    } else if (name === 'M') o.material = black;
    else if (o.material.name === 'CeilingWhite') o.material = white;
    else if (o.material.name === 'Material.002') o.material = black;
    else if (o.material.name === 'concrete_layers_02') o.material = wall;
  });

  // The ground the white slab top has to disappear into.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), white);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  scene.add(sky);
  return button;
}

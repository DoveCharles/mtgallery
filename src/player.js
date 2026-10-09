import * as THREE from 'three';

const PHYSICS_STEPS = 5;
const NO_KEYS = new Set();

const _segment = new THREE.Line3();
const _box = new THREE.Box3();
const _triPoint = new THREE.Vector3();
const _capsulePoint = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _move = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _rot = new THREE.Matrix3();
const JOY_RADIUS = 50; // px the knob can travel from the base's centre

// First-person walker: pointer-lock mouse look (or the arrow keys), WASD, capsule-vs-level collision.
export class Player {
  radius = 0.3;
  height = 1.95;
  eyeHeight = 1.8;
  eyeTarget = 1.8; // scroll sets this; eyeHeight eases toward it
  minEye = 0.5;
  maxEye = 3;
  walkSpeed = 3.3;
  runSpeed = 6.75;
  gravity = -20;
  lookSpeed = 0.002;
  keyLookSpeed = 2; // rad/s, arrow keys

  position = new THREE.Vector3(); // feet
  velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  enabled = true; // false while a cutscene owns the camera
  blockers = []; // Box3s that move (doors), checked on top of the static collider

  constructor(camera, dom, collider) {
    this.camera = camera;
    this.dom = dom;
    this.collider = collider;
    this.keys = new Set();

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * this.lookSpeed;
      this.pitch -= e.movementY * this.lookSpeed;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5, 1.5);
    });
    // Scroll down raises the camera, scroll up lowers it.
    addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.eyeTarget = THREE.MathUtils.clamp(this.eyeTarget + e.deltaY * 0.002, this.minEye, this.maxEye);
    }, { passive: true });

    this.stick = { x: 0, y: 0 }; // on-screen joystick, -1..1 (y up = forward)
    if (matchMedia('(pointer: coarse)').matches) this.initTouch();
  }

  // Phones: a joystick bottom-left for walking, and dragging anywhere else to look.
  initTouch() {
    const base = (this.joystick = document.createElement('div'));
    base.id = 'joystick';
    const knob = document.createElement('div');
    base.append(knob);
    document.body.append(base);

    let stickId = null;
    let origin = null;
    const moveStick = (e) => {
      let dx = e.clientX - origin.x;
      let dy = e.clientY - origin.y;
      const d = Math.hypot(dx, dy);
      if (d > JOY_RADIUS) {
        dx *= JOY_RADIUS / d;
        dy *= JOY_RADIUS / d;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.stick.x = dx / JOY_RADIUS;
      this.stick.y = -dy / JOY_RADIUS;
    };
    const releaseStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      knob.style.transform = '';
      this.stick.x = this.stick.y = 0;
    };
    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      stickId = e.pointerId;
      base.setPointerCapture(e.pointerId);
      const r = base.getBoundingClientRect();
      origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      moveStick(e);
    });
    base.addEventListener('pointermove', (e) => e.pointerId === stickId && moveStick(e));
    base.addEventListener('pointerup', releaseStick);
    base.addEventListener('pointercancel', releaseStick);

    let lookId = null;
    let last = null;
    this.dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || lookId !== null) return;
      lookId = e.pointerId;
      last = { x: e.clientX, y: e.clientY };
    });
    addEventListener('pointermove', (e) => {
      if (e.pointerId !== lookId) return;
      if (this.enabled) {
        this.yaw -= (e.clientX - last.x) * this.lookSpeed * 2;
        this.pitch -= (e.clientY - last.y) * this.lookSpeed * 2;
        this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5, 1.5);
      }
      last = { x: e.clientX, y: e.clientY };
    });
    const releaseLook = (e) => e.pointerId === lookId && (lookId = null);
    addEventListener('pointerup', releaseLook);
    addEventListener('pointercancel', releaseLook);
  }

  // Start at an object's position, looking along its local -Z (Blender local +Y).
  spawnAt(obj) {
    obj.getWorldPosition(this.position);
    obj.getWorldDirection(_dir);
    this.yaw = Math.atan2(_dir.x, _dir.z);
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.spawnPoint = obj;
  }

  getEye(target) {
    return target.copy(this.position).setY(this.position.y + this.eyeHeight);
  }

  update(dt) {
    const k = this.enabled ? this.keys : NO_KEYS;
    if (this.joystick) this.joystick.hidden = !this.enabled;
    const stick = this.enabled ? this.stick : { x: 0, y: 0 };
    const forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) + stick.y;
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + stick.x;
    const turn = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    const tilt = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    this.yaw += turn * this.keyLookSpeed * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + tilt * this.keyLookSpeed * 0.75 * dt, -1.5, 1.5);
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? this.runSpeed : this.walkSpeed;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    _move.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe);
    if (_move.lengthSq() > 1) _move.normalize();
    _move.multiplyScalar(speed);

    this.eyeHeight += (this.eyeTarget - this.eyeHeight) * (1 - Math.exp(-12 * dt));

    const step = dt / PHYSICS_STEPS;
    for (let i = 0; i < PHYSICS_STEPS; i++) this.step(step, _move);

    if (this.position.y < -50 && this.spawnPoint) this.spawnAt(this.spawnPoint);
  }

  step(dt, move) {
    if (this.onGround) this.velocity.y = dt * this.gravity;
    else this.velocity.y += dt * this.gravity;

    this.position.addScaledVector(this.velocity, dt);
    this.position.addScaledVector(move, dt);

    // Push the capsule out of any triangles it overlaps.
    const r = this.radius;
    _segment.start.copy(this.position).setY(this.position.y + r);
    _segment.end.copy(this.position).setY(this.position.y + this.height - r);
    _box.makeEmpty().expandByPoint(_segment.start).expandByPoint(_segment.end);
    _box.min.addScalar(-r);
    _box.max.addScalar(r);

    this.collider.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        const distance = tri.closestPointToSegment(_segment, _triPoint, _capsulePoint);
        if (distance < r) {
          const depth = r - distance;
          const direction = _capsulePoint.sub(_triPoint).normalize();
          _segment.start.addScaledVector(direction, depth);
          _segment.end.addScaledVector(direction, depth);
        }
      },
    });

    for (const b of this.blockers) this.pushOutOfBox(b, _segment, r);

    _delta.copy(_segment.start).setY(_segment.start.y - r).sub(this.position);
    this.onGround = _delta.y > Math.abs(dt * this.velocity.y * 0.25);

    const offset = Math.max(0, _delta.length() - 1e-5);
    _delta.normalize().multiplyScalar(offset);
    this.position.add(_delta);

    if (!this.onGround) {
      _delta.normalize();
      this.velocity.addScaledVector(_delta, -_delta.dot(this.velocity));
    } else {
      this.velocity.set(0, 0, 0);
    }
  }

  // Sideways push out of an upright box (a door), if the capsule overlaps it.
  pushOutOfBox(b, seg, r) {
    if (seg.end.y + r < b.min.y || seg.start.y - r > b.max.y) return;
    const x = seg.start.x;
    const z = seg.start.z;
    const cx = THREE.MathUtils.clamp(x, b.min.x, b.max.x);
    const cz = THREE.MathUtils.clamp(z, b.min.z, b.max.z);
    let dx = x - cx;
    let dz = z - cz;
    const d = Math.hypot(dx, dz);
    if (d >= r) return;
    if (d > 1e-6) {
      dx = (dx / d) * (r - d);
      dz = (dz / d) * (r - d);
    } else {
      // Centre inside the box: leave by the nearest side.
      const out = [b.min.x - r - x, b.max.x + r - x, b.min.z - r - z, b.max.z + r - z];
      const i = out.reduce((best, v, j) => (Math.abs(v) < Math.abs(out[best]) ? j : best), 0);
      dx = i < 2 ? out[i] : 0;
      dz = i < 2 ? 0 : out[i];
    }
    seg.start.x += dx;
    seg.end.x += dx;
    seg.start.z += dz;
    seg.end.z += dz;
  }

  // Move the player through a portal. The matrix is rigid and only rotates about Y.
  applyTransform(matrix) {
    this.position.applyMatrix4(matrix);
    _dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).transformDirection(matrix);
    this.yaw = Math.atan2(-_dir.x, -_dir.z);
    this.velocity.applyMatrix3(_rot.setFromMatrix4(matrix));
  }

  updateCamera() {
    this.getEye(this.camera.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }
}

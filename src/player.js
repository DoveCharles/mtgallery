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

// First-person walker: pointer-lock mouse look, WASD, capsule-vs-level collision.
export class Player {
  radius = 0.3;
  height = 1.75;
  eyeHeight = 1.6;
  walkSpeed = 2.2;
  runSpeed = 4.5;
  gravity = -20;
  lookSpeed = 0.002;

  position = new THREE.Vector3(); // feet
  velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  enabled = true; // false while a cutscene owns the camera

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
    const forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? this.runSpeed : this.walkSpeed;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    _move.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe);
    if (_move.lengthSq() > 1) _move.normalize();
    _move.multiplyScalar(speed);

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

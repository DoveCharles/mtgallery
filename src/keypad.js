import * as THREE from 'three';

// Keypad-locked doors in the starting area.
// Walk up to a keypad and the camera leaves the player to frame it and frees the cursor.
// Hovering a key lights it; clicking pushes it in and lights the next of the four
// indicator lights green. Four digits are checked: wrong flashes red and fades, right
// returns the camera to the player, recaptures the mouse and opens the door (back, then
// sideways into the wall). It closes again once you're nearer the other door.
// The X key walks away, < clears. The keys carry no printed numbers; which is which
// comes from the Blender names (0Butt..9Butt, XButt, <Butt).
//
// The blend has one keypad (object "Keypad", on "DoorLeft"); the right door gets a copy.

const CODE = '5555';
const APPROACH_DISTANCE = 1.4; // from the keypad, along the floor
const REARM_DISTANCE = 2.2; // walk this far away before it can catch you again
const FILL = 0.6; // how much of the screen the keypad takes up
const MOVE_TIME = 0.8;
const PRESS_DEPTH = 0.004;
const PRESS_TIME = 0.12;
const FEEDBACK_TIME = 1.5; // red/green fade, as in the Unity KeypadController
const DOOR_WAIT = 0.5;
const DOOR_BACK_TIME = 1;
const DOOR_SLIDE_TIME = 1;

const IDLE = new THREE.Color(0x0a0a0a);
const GREEN = new THREE.Color(0x00ff55);
const RED = new THREE.Color(0xff1a1a);

const smooth = (t) => t * t * (3 - 2 * t);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _helper = new THREE.PerspectiveCamera(); // lookAt for a camera faces -Z
const UP = new THREE.Vector3(0, 1, 0);

// "5Butt", "<Emis", ... possibly on a parent if the mesh was split by the exporter.
function keyOf(obj) {
  for (let o = obj; o; o = o.parent) {
    const m = /^([0-9X<])(Butt|Emis)$/.exec(o.name);
    if (m) return { key: m[1], part: m[2] };
  }
  return null;
}

// Doors and the keypad move, so the level loader keeps them out of the static collider.
export const isMovingPart = (o) => /^Door(Left|Right)$/.test(o.name) || o.name === 'Keypad';

class Door {
  constructor(mesh, keypadRoot) {
    this.mesh = mesh;
    this.closed = mesh.position.clone();
    mesh.updateWorldMatrix(true, false);
    this.baseBox = new THREE.Box3().setFromObject(mesh);
    this.box = this.baseBox.clone();
    const size = this.baseBox.getSize(new THREE.Vector3());

    // The keypad is on the door's corridor side, which is also the direction it faces.
    const kpCenter = new THREE.Box3().setFromObject(keypadRoot).getCenter(new THREE.Vector3());
    const doorCenter = this.baseBox.getCenter(new THREE.Vector3());
    _v.subVectors(kpCenter, doorCenter).setY(0);
    this.normal = Math.abs(_v.x) > Math.abs(_v.z) ? new THREE.Vector3(Math.sign(_v.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(_v.z));
    this.left = new THREE.Vector3().crossVectors(this.normal, UP); // to the left as you face the door
    this.thickness = Math.abs(this.normal.x) ? size.x : size.z;
    this.width = Math.abs(this.normal.x) ? size.z : size.x;

    this.state = 'closed';
    this.time = 0;
    this.offset = new THREE.Vector3();
    mesh.attach(keypadRoot); // the keypad rides along with the door
  }

  open() {
    if (this.state === 'closed') {
      this.state = 'opening';
      this.time = 0;
    }
  }

  // The opening in reverse (slide out, then forward), without the wait.
  close() {
    if (this.state === 'open') {
      this.state = 'closing';
      this.time = DOOR_WAIT + DOOR_BACK_TIME + DOOR_SLIDE_TIME;
    }
  }

  update(dt) {
    if (this.state === 'opening') this.time += dt;
    else if (this.state === 'closing') this.time = Math.max(DOOR_WAIT, this.time - dt);
    else return;
    const back = smooth(THREE.MathUtils.clamp((this.time - DOOR_WAIT) / DOOR_BACK_TIME, 0, 1));
    const slide = smooth(THREE.MathUtils.clamp((this.time - DOOR_WAIT - DOOR_BACK_TIME) / DOOR_SLIDE_TIME, 0, 1));
    this.offset
      .copy(this.normal)
      .multiplyScalar(-back * (this.thickness + 0.02))
      .addScaledVector(this.left, slide * (this.width + 0.1));
    this.mesh.position.copy(this.closed).add(this.offset);
    this.box.copy(this.baseBox).translate(this.offset);
    if (this.state === 'opening' && slide === 1) this.state = 'open';
    if (this.state === 'closing' && back === 0) this.state = 'closed';
  }
}

// The speaker ("Mic"): dark perforated metal, a square grid of round holes.
const GRILLE_PITCH = 0.006; // metres between hole centres
function speakerGrille(envMap) {
  const N = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#7a7d80';
  ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(N / 2, N / 2, N * 0.32, 0, Math.PI * 2);
  ctx.fill();
  const holes = new THREE.CanvasTexture(canvas);
  holes.colorSpace = THREE.SRGBColorSpace;
  holes.wrapS = holes.wrapT = THREE.RepeatWrapping;
  holes.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: holes, metalness: 0.8, roughness: 0.45, envMap });
}

// Replaces the UVs of a flat quad with 0..1 over its two longest local axes, and
// records its real size (world scale) so the grille can tile holes at a fixed pitch.
function fillUvs(geometry) {
  const g = geometry.clone();
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  const axes = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
  const [ua, va] = axes;
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  const min = g.boundingBox.min;
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getComponent(i, ua) - min.getComponent(ua)) / size.getComponent(ua);
    uv[i * 2 + 1] = (p.getComponent(i, va) - min.getComponent(va)) / size.getComponent(va);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.userData.uvSize = [size.getComponent(ua), size.getComponent(va)];
  return g;
}

// Light brushed steel for the keypad plates: "Back" and the faceplate ("Material.009").
// The grain is a canvas of fine horizontal streaks used as a bump and roughness map;
// anisotropy stretches the highlights along it. Metal needs something to reflect,
// hence the env map.
function brushedSteel(envMap) {
  const W = 512;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 6000; i++) {
    const v = 128 + (Math.random() - 0.5) * 90;
    ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.fillRect(Math.random() * W - W / 2, Math.random() * H, W * (0.3 + Math.random()), 1);
  }
  const grain = new THREE.CanvasTexture(canvas);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.anisotropy = 8;
  return new THREE.MeshPhysicalMaterial({
    color: 0xe4e7ea,
    metalness: 1,
    roughness: 0.32,
    roughnessMap: grain,
    bumpMap: grain,
    bumpScale: 0.3,
    anisotropy: 0.7,
    envMap,
    envMapIntensity: 1.4,
  });
}

class Keypad {
  constructor(root, door, mats) {
    this.root = root;
    this.door = door;
    this.entered = '';
    this.locked = false; // while showing red/green
    this.feedback = null; // { color, time }
    this.keys = new Map(); // key -> { butt, emis, rest, press }
    this.lights = [];

    root.traverse((o) => {
      if (!o.isMesh) return;
      const k = keyOf(o);
      if (k) {
        const entry = this.keys.get(k.key) ?? { press: 0 };
        if (k.part === 'Butt') {
          entry.butt = o;
          entry.buttRest = o.position.clone();
          o.material = mats.rim;
        } else {
          entry.emis = o;
          entry.emisRest = o.position.clone();
          o.material = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
        }
        this.keys.set(k.key, entry);
        return;
      }
      if (o.material.name === 'Back' || o.material.name === 'Material.009') {
        o.material = mats.steel;
        return;
      }
      if (o.material.name === 'Screws') {
        o.material = mats.screws;
        return;
      }
      if (o.material.name === 'Rim') {
        o.material = mats.rim;
        return;
      }
      if (o.material.name === 'Mic') {
        o.geometry = fillUvs(o.geometry);
        o.material = mats.grille;
        const scale = o.getWorldScale(new THREE.Vector3()).x;
        const [w, h] = o.geometry.userData.uvSize;
        o.material.map.repeat.set((w * scale) / GRILLE_PITCH, (h * scale) / GRILLE_PITCH);
        return;
      }
      const light = /^Light([1-4])$/.exec(o.name) ?? /^Light([1-4])$/.exec(o.parent?.name ?? '');
      if (light) {
        o.material = new THREE.MeshBasicMaterial({ color: IDLE, toneMapped: false });
        this.lights[Number(light[1]) - 1] = o;
      }
    });
    this.clickables = [...this.keys.values()].flatMap((e) => [e.butt, e.emis]).filter(Boolean);
  }

  frame() {
    this.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.root);
    this.center = box.getCenter(new THREE.Vector3());
    this.size = box.getSize(new THREE.Vector3());
  }

  // Where the player's feet should be measured from.
  standPoint(target) {
    return target.copy(this.center).addScaledVector(this.door.normal, 0.6);
  }

  setHover(key) {
    for (const [k, e] of this.keys) e.emis?.material.color.setScalar(k === key ? 1 : 0);
  }

  // Returns 'correct', 'wrong' or null.
  press(key) {
    const e = this.keys.get(key);
    if (e) e.press = PRESS_TIME;
    if (this.locked) return null;
    if (key === '<') this.entered = '';
    else if (/[0-9]/.test(key) && this.entered.length < 4) this.entered += key;
    this.showEntered();

    if (this.entered.length < 4) return null;
    const ok = this.entered === CODE;
    this.entered = '';
    this.locked = true;
    this.feedback = { color: ok ? GREEN : RED, time: 0 };
    return ok ? 'correct' : 'wrong';
  }

  showEntered() {
    this.lights.forEach((l, i) => l?.material.color.copy(i < this.entered.length ? GREEN : IDLE));
  }

  update(dt) {
    // Buttons spring back after being pushed in.
    for (const e of this.keys.values()) {
      if (e.press <= 0) continue;
      e.press = Math.max(0, e.press - dt);
      const depth = Math.sin((e.press / PRESS_TIME) * Math.PI) * PRESS_DEPTH;
      for (const [mesh, rest] of [[e.butt, e.buttRest], [e.emis, e.emisRest]]) {
        if (!mesh) continue;
        // Push along the keypad's facing, expressed in the button's parent space.
        _v.copy(this.door.normal).multiplyScalar(-depth);
        mesh.parent.getWorldQuaternion(_q).invert();
        _v.applyQuaternion(_q);
        mesh.position.copy(rest).add(_v);
      }
    }

    if (this.feedback) {
      this.feedback.time += dt;
      const t = Math.min(this.feedback.time / FEEDBACK_TIME, 1);
      for (const l of this.lights) l?.material.color.lerpColors(this.feedback.color, IDLE, t);
      if (t === 1) {
        this.feedback = null;
        this.locked = false;
        this.showEntered();
      }
    }
  }
}

export class KeypadSystem {
  state = 'idle'; // idle | entering | active | leaving
  active = null;
  time = 0;

  constructor({ root, camera, dom, player, envMap, onEnter, onLeave }) {
    this.onEnter = onEnter;
    this.onLeave = onLeave;
    this.camera = camera;
    this.dom = dom;
    this.player = player;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hoverKey = null;
    this.doors = [];
    this.keypads = [];
    this.blockers = [];

    const keypad = root.getObjectByName('Keypad');
    const doors = ['DoorLeft', 'DoorRight'].map((n) => root.getObjectByName(n)).filter(Boolean);
    if (!keypad || !doors.length) return;

    // The blend's keypad belongs to the nearest door; every other door gets a copy,
    // turned to face that door's corridor the same way.
    root.updateMatrixWorld(true);
    const kpPos = keypad.getWorldPosition(new THREE.Vector3());
    const centerOf = (o) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
    doors.sort((a, b) => centerOf(a).distanceTo(kpPos) - centerOf(b).distanceTo(kpPos));
    const homeBox = new THREE.Box3().setFromObject(doors[0]);
    const homeCenter = homeBox.getCenter(new THREE.Vector3());

    const steel = brushedSteel(envMap);
    // The rim around the faceplate and the buttons: the same steel, darker and rougher.
    const rim = steel.clone();
    rim.color.set(0x4a4d51);
    rim.roughness = 0.6;
    // Polished stainless screw heads.
    const screws = new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 1, roughness: 0.22, envMap, envMapIntensity: 1.4 });
    const mats = { steel, rim, screws, grille: speakerGrille(envMap) };
    doors.forEach((doorMesh, i) => {
      let kp = keypad;
      if (i > 0) {
        kp = keypad.clone(true);
        keypad.parent.add(kp);
        const center = new THREE.Box3().setFromObject(doorMesh).getCenter(new THREE.Vector3());
        // Rotate the original about the vertical line halfway between the two doors.
        const mid = _v.addVectors(homeCenter, center).multiplyScalar(0.5);
        const angle = Math.atan2(center.x - mid.x, center.z - mid.z) - Math.atan2(homeCenter.x - mid.x, homeCenter.z - mid.z);
        const m = new THREE.Matrix4()
          .makeTranslation(mid.x, 0, mid.z)
          .multiply(new THREE.Matrix4().makeRotationY(angle))
          .multiply(new THREE.Matrix4().makeTranslation(-mid.x, 0, -mid.z));
        // Apply it in world space, whatever the keypad's parent is.
        m.multiply(keypad.matrixWorld).premultiply(new THREE.Matrix4().copy(keypad.parent.matrixWorld).invert());
        m.decompose(kp.position, kp.quaternion, kp.scale);
        kp.updateMatrixWorld(true);
      }
      const door = new Door(doorMesh, kp);
      const pad = new Keypad(kp, door, mats);
      pad.frame();
      this.doors.push(door);
      this.keypads.push(pad);
      this.blockers.push(door.box);
      pad.armed = true;
    });

    dom.addEventListener('pointermove', (e) => {
      if (this.state !== 'active') return;
      this.hoverKey = this.pick(e);
      this.active.setHover(this.hoverKey);
      dom.style.cursor = this.hoverKey ? 'pointer' : '';
    });
    dom.addEventListener('click', (e) => {
      if (this.state !== 'active') return;
      const key = this.pick(e);
      this.active.setHover(key);
      if (!key) return;
      if (key === 'X') return this.leave();
      const result = this.active.press(key);
      if (result === 'correct') {
        this.active.door.open();
        this.leave();
      }
    });
  }

  get busy() {
    return this.state !== 'idle';
  }

  // The meshes that light up: the four status lights and the button rims.
  get glowMeshes() {
    return this.keypads.flatMap((p) => [...p.lights, ...[...p.keys.values()].map((e) => e.emis)]).filter(Boolean);
  }

  pick(e) {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.active.clickables, false)[0];
    return hit ? keyOf(hit.object).key : null;
  }

  enter(pad) {
    this.active = pad;
    this.state = 'entering';
    this.time = 0;
    this.player.enabled = false;
    this.player.velocity.set(0, 0, 0);
    document.exitPointerLock?.();
    this.onEnter?.();

    pad.frame();
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const across = Math.abs(pad.door.normal.x) ? pad.size.z : pad.size.x;
    const dist = Math.max(pad.size.y / 2 / (FILL * tan), across / 2 / (FILL * tan * this.camera.aspect));
    _helper.position.copy(pad.center).addScaledVector(pad.door.normal, dist);
    _helper.lookAt(pad.center);
    this.from = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
    this.to = { pos: _helper.position.clone(), quat: _helper.quaternion.clone() };
  }

  // Back to the player's own view. Called from a click, so the mouse can be recaptured.
  leave() {
    this.dom.requestPointerLock()?.catch?.(() => {});
    this.active.setHover(null);
    this.dom.style.cursor = '';
    this.hoverKey = null;
    this.state = 'leaving';
    this.time = 0;
    this.from = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
    this.to = {
      pos: this.player.getEye(new THREE.Vector3()),
      quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ')),
    };
  }

  // An open door shuts by itself once the player is more than halfway to the other door.
  closeDoorsBehind() {
    if (this.doors.length < 2) return;
    const p = this.player.position;
    for (const d of this.doors) {
      if (d.state !== 'open') continue;
      const here = d.baseBox.getCenter(_v).setY(p.y).distanceTo(p);
      const nearest = Math.min(...this.doors.filter((o) => o !== d).map((o) => o.baseBox.getCenter(new THREE.Vector3()).setY(p.y).distanceTo(p)));
      if (here > nearest) d.close();
    }
  }

  // Returns true while it is driving the camera.
  update(dt) {
    for (const d of this.doors) d.update(dt);
    this.closeDoorsBehind();
    for (const p of this.keypads) p.update(dt);

    if (this.state === 'idle') {
      if (!this.player.enabled) return false;
      for (const pad of this.keypads) {
        const d = pad.standPoint(_v).setY(this.player.position.y).distanceTo(this.player.position);
        if (!pad.armed) pad.armed = d > REARM_DISTANCE;
        else if (d < APPROACH_DISTANCE && pad.door.state === 'closed') {
          pad.armed = false;
          this.enter(pad);
          break;
        }
      }
      if (this.state === 'idle') return false;
    }

    if (this.state === 'entering' || this.state === 'leaving') {
      this.time += dt;
      const t = Math.min(this.time / MOVE_TIME, 1);
      const s = smooth(t);
      this.camera.position.lerpVectors(this.from.pos, this.to.pos, s);
      this.camera.quaternion.slerpQuaternions(this.from.quat, this.to.quat, s);
      this.camera.updateMatrixWorld();
      if (t === 1) {
        if (this.state === 'entering') this.state = 'active';
        else {
          this.state = 'idle';
          this.active = null;
          this.player.enabled = true;
          this.onLeave?.();
          return false;
        }
      }
    }
    return true;
  }
}

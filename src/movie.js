import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { loadSentences } from './cards.js';
import { draw } from './screens.js';

// The cinema (room 5555 left): the "CardMovie" screen shows every sentence once, in an order
// shuffled once, each for the same time, so the whole film runs RUNTIME. The "Curtains" in
// front of it (one side in the .blend, mirrored here to the other side of the screen) are
// shut while you're at the back of the cinema and open as you walk down to the screen, all
// the way by OPEN_AT of the way there. The film starts the first time they're all the way
// open, and only runs while you're in the room, so none of it is missed; once it's over the
// screen stays blank.

const RUNTIME = 2 * 60 * 60; // s
const OPEN_AT = 0.5; // of the way from the cinema's back wall to the screen
const BACK_RAY = 3; // m out from the screen the search for the back wall starts (past the curtain rail)
// The curtains' scale across the screen (their local z here; y in the .blend).
const CLOSED = 0.74; // past the middle of the screen, so the two overlap and no sliver shows between their folds
const OPEN = 0.172439;
const CANVAS_W = 2048;
const OFFSET = 0.01; // m the text floats off the screen
const GLOW = 3; // the screen's area light at full (it fades with the curtains)
const GLOW_COLOR = 0xdfe8ff;

export async function addMovie(level, world) {
  const { root } = level;
  const screen = root.getObjectByName('CardMovie');
  const curtain = root.getObjectByName('Curtains');
  if (!screen?.isMesh) return null;
  root.updateMatrixWorld(true);
  const sentences = shuffle([...(await loadSentences())]);
  const interval = RUNTIME / sentences.length;
  RectAreaLightUniformsLib.init();

  // Axes as in screens.js: `front` out of the screen (its thin horizontal axis, towards the
  // entrance), `right` as seen by someone facing it.
  const box = new THREE.Box3().setFromObject(screen);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const front = size.x < size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const entranceMesh = level.portals.find((p) => p.id.endsWith('Entrance'))?.mesh;
  const entrance = entranceMesh ? new THREE.Box3().setFromObject(entranceMesh).getCenter(new THREE.Vector3()) : center.clone().add(front);
  if (entrance.clone().sub(center).dot(front) < 0) front.negate();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, front);
  const width = Math.abs(size.dot(right));
  const height = size.y;
  // How far in you are: 0 at the cinema's back wall, 1 at the screen (along the floor). The
  // back wall is the first thing straight out from near the top of the screen (above the
  // doorways into the cinema), or else the level's entrance.
  const inward = front.clone().negate();
  const solid = [];
  root.traverse((o) => o.isMesh && o !== screen && o !== curtain && solid.push(o));
  const ray = new THREE.Raycaster(center.clone().setY(box.max.y).addScaledVector(front, BACK_RAY), front);
  const back = ray.intersectObjects(solid, false)[0]?.point ?? entrance;
  const start = back.dot(inward);
  const depth = center.dot(inward) - start;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = Math.round((CANVAS_W * height) / width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const text = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color: 0x000000, map: texture, transparent: true, depthWrite: false }),
  );
  text.matrix.makeBasis(right, up, front).setPosition(center.clone().addScaledVector(front, size.dot(front) / 2 + OFFSET));
  text.matrixAutoUpdate = false;
  text.renderOrder = 1;
  const group = new THREE.Group();
  group.name = 'Movie';
  group.add(text);
  root.parent.add(group);

  const light = new THREE.RectAreaLight(GLOW_COLOR, 0, width, height);
  light.position.copy(center).addScaledVector(front, size.dot(front) / 2 + OFFSET * 2);
  light.lookAt(light.position.clone().add(front)); // shines along its -z: out of the screen
  light.userData.intensity = 0;
  group.add(light);
  group.updateMatrixWorld(true);

  // The curtains: the one in the level and its mirror image across the middle of the screen,
  // each sized by its own local matrix (from `base`, with the opening scale put in).
  const curtains = [];
  let sizeCurtains = null;
  if (curtain) {
    const parent = curtain.parent;
    const base = { position: curtain.position.clone(), quaternion: curtain.quaternion.clone(), scale: curtain.scale.clone() };
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(right, center);
    const n = plane.normal;
    const reflect = new THREE.Matrix4()
      .set(1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0, -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0, -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0, 0, 0, 0, 1)
      .multiply(new THREE.Matrix4().makeTranslation(n.clone().multiplyScalar(plane.constant)))
      .premultiply(new THREE.Matrix4().makeTranslation(n.clone().multiplyScalar(-plane.constant)));
    // World mirror, in the parent's space.
    const mirror = parent.matrixWorld.clone().invert().multiply(reflect).multiply(parent.matrixWorld);
    const twin = curtain.clone();
    twin.name = 'CurtainsMirror';
    parent.add(twin);
    for (const [mesh, side] of [[curtain, null], [twin, mirror]]) {
      mesh.matrixAutoUpdate = false;
      curtains.push({ mesh, side });
    }
    sizeCurtains = (s) => {
      for (const { mesh, side } of curtains) {
        mesh.matrix.compose(base.position, base.quaternion, new THREE.Vector3(base.scale.x, base.scale.y, s));
        if (side) mesh.matrix.premultiply(side);
        mesh.matrixWorldNeedsUpdate = true;
      }
    };
    sizeCurtains(CLOSED);
  }

  let state = 'waiting'; // then 'playing', then 'over'
  let time = 0;
  let shown = -1;
  let open = 0;
  const show = (i) => {
    if (i < sentences.length) draw(canvas, sentences[i]);
    else canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
  };

  return {
    meshes: [text],
    lights: [light],
    world,
    // `here`: the player is in this world; `player` for how far in they are.
    update(dt, here, player) {
      if (!here) return;
      const t = THREE.MathUtils.clamp((player.position.dot(inward) - start) / (depth * OPEN_AT), 0, 1);
      if (t !== open) {
        open = t;
        sizeCurtains?.(THREE.MathUtils.lerp(CLOSED, OPEN, open));
        light.userData.intensity = light.intensity = GLOW * open;
      }
      if (state === 'waiting' && open >= 1) state = 'playing';
      if (state !== 'playing') return;
      time += dt;
      const i = Math.min(Math.floor(time / interval), sentences.length);
      if (i !== shown) show((shown = i));
      if (i === sentences.length) state = 'over';
    },
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

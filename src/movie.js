import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { loadSentences } from './cards.js';
import { draw } from './screens.js';
import { applyShadeZones } from './shade.js';

// The cinema (room 5555 left): the "CardMovie" screen shows every sentence once, in an order
// shuffled once, each for the same time, so the whole film runs RUNTIME. The "Curtains" in
// front of it (one side in the .blend, mirrored here to the other side of the screen) are
// shut while you're at the back of the cinema and open as you walk down to the screen, all
// the way by OPEN_AT of the way there. The film starts the first time they're all the way
// open, and only runs while you're in the room, so none of it is missed; once it's over the
// screen stays blank.
// The cinema is dark (a shade zone, see shade.js, from its back wall to the screen): what
// lights it is the screen's glow, once the curtains part, and a strip of light along the
// floor down each side, SIDE_INSET m in from the side walls.

const RUNTIME = 2 * 60 * 60; // s
const OPEN_AT = 0.5; // of the way from the cinema's back wall to the screen
const BACK_RAY = 3; // m out from the screen the search for the back wall starts (past the curtain rail)
// The curtains' scale across the screen (their local z here; y in the .blend).
const CLOSED = 0.74; // past the middle of the screen, so the two overlap and no sliver shows between their folds
const OPEN = 0.172439;
const CANVAS_W = 2048;
const OFFSET = 0.01; // m the text floats off the screen
const GLOW = 0.7; // the screen's area light at full (it fades with the curtains)
const GLOW_COLOR = 0xdfe8ff;
// The screen's bloom (see bloom.js) comes off a copy of it in this colour, seen only by the
// bloom: the screen itself is so big and bright its bloom would fog the whole room.
const HALO = 0x5a6070;
const DARK = 0.01; // of the sky and bounce light that reaches into the cinema
const SIDE_INSET = 0.5; // m
const STRIP = { width: 0.06, height: 0.03, color: 0xffa24a }; // m; the glowing strip itself
const STRIP_LIGHT = { height: 0.25, intensity: 6, tilt: 0.35 }; // its area light (m tall, tilt of its face from straight down, in turns of 90°)

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
  // (The ray keeps the vectors it's made with, and is reused below: copies.)
  const ray = new THREE.Raycaster(center.clone().setY(box.max.y).addScaledVector(front, BACK_RAY), front.clone());
  const back = ray.intersectObjects(solid, false)[0]?.point ?? entrance;
  const start = back.dot(inward);
  const depth = center.dot(inward) - start;

  // The cinema: back wall to screen, side wall to side wall (straight out from the middle of
  // the screen, at its foot), floor to ceiling.
  const hit = (from, dir) => {
    ray.set(from, dir);
    return ray.intersectObjects(solid, false)[0]?.point;
  };
  const foot = center.clone().setY(box.min.y + 0.5).addScaledVector(front, BACK_RAY);
  const sides = [right, right.clone().negate()].map((d) => hit(foot, d) ?? foot.clone().addScaledVector(d, width / 2));
  const ceiling = hit(foot, up)?.y ?? box.max.y;
  const room = new THREE.Box3().setFromPoints([...sides, back, center]).expandByPoint(center.clone().setY(ceiling));
  applyShadeZones(root, [room], DARK);

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

  // The floor strips: down the rake, from the back wall to the screen's wall, each with an
  // area light along it shining down and in across the floor.
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: HALO }));
  halo.matrix.makeBasis(right, up, front).setPosition(center.clone().addScaledVector(front, size.dot(front) / 2 + OFFSET / 2));
  halo.matrixAutoUpdate = false;
  halo.layers.set(1); // the bloom's only
  group.add(halo);
  const glows = [halo];
  const lights = [light];
  const stripMaterial = new THREE.MeshBasicMaterial({ color: STRIP.color });
  for (const side of sides) {
    const across = side.clone().sub(center).projectOnVector(right);
    const out = across.clone().normalize(); // towards this side's wall
    const floorAt = (along) => {
      const p = side.clone().addScaledVector(out, -SIDE_INSET).addScaledVector(inward, along - side.dot(inward)).setY(ceiling - 0.1);
      return hit(p, new THREE.Vector3(0, -1, 0)) ?? p.setY(box.min.y);
    };
    const a = floorAt(start + SIDE_INSET);
    const b = floorAt(center.dot(inward) - size.dot(front) / 2 - SIDE_INSET);
    const along = b.clone().sub(a);
    const length = along.length();
    along.normalize();
    const normal = new THREE.Vector3().crossVectors(along, out).normalize();
    if (normal.y < 0) normal.negate();
    const strip = new THREE.Mesh(new THREE.BoxGeometry(length, STRIP.height, STRIP.width), stripMaterial);
    strip.name = 'FloorStrip';
    strip.matrix.makeBasis(along, normal, new THREE.Vector3().crossVectors(along, normal)).setPosition(a.clone().lerp(b, 0.5).addScaledVector(normal, STRIP.height / 2));
    strip.matrixAutoUpdate = false;
    group.add(strip);
    glows.push(strip);

    const stripLight = new THREE.RectAreaLight(STRIP.color, STRIP_LIGHT.intensity, STRIP_LIGHT.height, length);
    stripLight.position.copy(a.clone().lerp(b, 0.5)).addScaledVector(normal, STRIP.height + STRIP_LIGHT.height / 2);
    // Faces (its -z) down, turned in towards the middle of the room by `tilt`.
    const angle = (STRIP_LIGHT.tilt * Math.PI) / 2;
    const facing = normal.clone().multiplyScalar(-Math.cos(angle)).addScaledVector(out, -Math.sin(angle));
    stripLight.up.copy(along); // its height (local y) along the strip
    stripLight.lookAt(stripLight.position.clone().add(facing));
    stripLight.userData.intensity = STRIP_LIGHT.intensity;
    group.add(stripLight);
    lights.push(stripLight);
  }
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
    lights,
    // For the bloom (see bloom.js): the screen's halo, the text over it (so it stays readable
    // through the glow) and the floor strips.
    glows: [...glows, text],
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

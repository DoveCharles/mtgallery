import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { loadSentences } from './cards.js';
import { draw } from './screens.js';
import { applyShadeZones } from './shade.js';

// The cinema (room 5555 left): the "CardMovie" screen shows every sentence once, in an order
// shuffled once, each for the same time, so the whole film runs RUNTIME. The "Curtains" in
// front of it (one side in the .blend, mirrored here to the other side of the screen) start
// shut, lit by a row of UPLIGHT lamps on the floor in front of them. Once you're TRIGGER of
// the way from the cinema's back wall to the screen the show starts by itself: the house
// lights (the uplights and the floor strips) dim over DIM_TIME, then the curtains part over
// OPEN_TIME, then the film starts. It only runs while you're in the room, so none of it is
// missed; once it's over the screen stays blank. An invisible wall WALL_AT of the way down
// keeps you back from the screen.
// The cinema is dark (a shade zone, see shade.js, from its back wall to the screen): what
// lights it is the screen's glow, once the curtains part, the uplights, and a strip of light
// along the floor down each side, SIDE_INSET m in from the side walls.

const RUNTIME = 2 * 60 * 60; // s
// Of the way from the cinema's back wall to the screen:
const TRIGGER = 0.25; // the show starts
const WALL_AT = 0.5; // the invisible wall
const DIM_TIME = 3; // s
const OPEN_TIME = 6; // s
const STRIP_DIM = 0.15; // of the floor strips' light left once the house lights are down (the uplights go right out)
const BACK_RAY = 3; // m out from the screen the search for the back wall starts (past the curtain rail)
// Closed, each curtain reaches this far past the middle of the screen (m), so the two overlap
// and no sliver shows between their folds. Open, they're as they are in the .blend.
const OVERLAP = 0.4;
const CANVAS_W = 2048;
const COLUMNS = 3; // the screen is split into this many columns, a sentence in each
const DIVIDER = 0.003; // of the screen's width, the line between two columns
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
// The lamps on the floor shining up the closed curtains: `out` m in front of them, evenly
// spaced across the pair of them (half a gap in from each end), aimed `aim` of the way up.
// They graze the curtains: the closer in, the lower down the light starts.
const UPLIGHT = { count: 8, out: 0.12, below: 0.45, aim: 0.85, intensity: 20, decay: 1, angle: 0.4, penumbra: 0.6, color: 0xffc27a };
const LAMP = { radius: 0.07, height: 0.1 }; // m; the lamp itself, a can with a glowing lens on top
// The curtains are velvet: their colour from the .blend, a little deeper (BODY of it), with
// a sheen of it (lighter, see velvet()) that glows where the light grazes the pile, and a
// grain to the pile, a PILE px tile repeated PILE_REPEAT times across them (their UVs span
// the whole curtain).
const BODY = 0.75;
const SHEEN = { roughness: 0.5, lighten: 0.2, desaturate: 0.1 };
const PILE = 256;
const PILE_REPEAT = 10;
const PILE_DEPTH = 1.5; // the grain's normal map strength

export async function addMovie(level, world) {
  const { root } = level;
  const screen = root.getObjectByName('CardMovie');
  const curtain = root.getObjectByName('Curtains');
  if (!screen?.isMesh) return null;
  root.updateMatrixWorld(true);
  // Before the shade zones, which patch it like the rest (and before it's mirrored, below).
  if (curtain?.isMesh) curtain.material = velvet(curtain.material);
  const sentences = shuffle([...(await loadSentences())]);
  // The screen is split into COLUMNS, each showing the next sentence along: a frame is
  // COLUMNS sentences, so every one still shows once over the RUNTIME.
  const frames = Math.ceil(sentences.length / COLUMNS);
  const interval = RUNTIME / frames;
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
  // How far in you are: 0 at the cinema's back wall, 1 at the screen (along the floor).
  const inward = front.clone().negate();
  const solid = [];
  root.traverse((o) => o.isMesh && o !== screen && o !== curtain && solid.push(o));
  // (The ray keeps the vectors it's made with: copies.)
  const ray = new THREE.Raycaster();
  const hitAll = (from, dir, far = Infinity) => {
    ray.set(from, dir);
    ray.far = far;
    return ray.intersectObjects(solid, false);
  };
  const hit = (from, dir) => hitAll(from, dir)[0]?.point;
  const down = new THREE.Vector3(0, -1, 0);
  // The back wall: walk out from the screen in STEPs, keeping HIGH of the way from the floor
  // to the ceiling (both slope with the rake; that high, above the doorways into the
  // cinema), until a wall (not the floor or ceiling) is in the way. `path` keeps the height
  // at each step, for midAt() below. Or else the level's entrance.
  const STEP = 0.5;
  const HIGH = 0.85;
  const path = [];
  let back = null;
  const walker = center.clone().addScaledVector(front, BACK_RAY);
  const normal = new THREE.Vector3();
  for (let i = 0; i < 2000 && !back; i++) {
    const floorY = hit(walker, down)?.y;
    const ceilY = hit(walker, up)?.y;
    if (floorY === undefined || ceilY === undefined) break;
    walker.y = THREE.MathUtils.lerp(floorY, ceilY, HIGH);
    path.push([walker.dot(inward), THREE.MathUtils.lerp(floorY, ceilY, 0.5)]);
    const wall = hitAll(walker, front, STEP).find((h) => Math.abs(normal.copy(h.face.normal).transformDirection(h.object.matrixWorld).y) < 0.5);
    if (wall) back = wall.point;
    else walker.addScaledVector(front, STEP);
  }
  back ??= entrance;
  const start = back.dot(inward);
  const depth = center.dot(inward) - start;
  // Halfway up the room, `along` (as a dot with `inward`) of the way in.
  const midAt = (along) => {
    if (!path.length) return center.y;
    // `path` runs from the screen outwards: `along` falling.
    const i = path.findIndex(([a]) => a <= along);
    if (i <= 0) return path[i === 0 ? 0 : path.length - 1][1];
    const [a0, y0] = path[i - 1];
    const [a1, y1] = path[i];
    return THREE.MathUtils.lerp(y0, y1, (a0 - along) / (a0 - a1));
  };

  // The cinema: back wall to screen, side wall to side wall (straight out from the middle of
  // the screen, at its foot), floor to ceiling.
  const foot = center.clone().setY(box.min.y + 0.5).addScaledVector(front, BACK_RAY);
  const sides = [right, right.clone().negate()].map((d) => hit(foot, d) ?? foot.clone().addScaledVector(d, width / 2));
  const ceiling = hit(foot, up)?.y ?? box.max.y;
  // The seats' side walls, halfway from the back wall to the screen (the room can be wider
  // around the stage): the floor strips run along these.
  const seats = center.clone().addScaledVector(inward, start + depth / 2 - center.dot(inward));
  seats.y = midAt(seats.dot(inward));
  const seatSides = [right, right.clone().negate()].map((d) => hit(seats, d) ?? sides[d === right ? 0 : 1]);
  const room = new THREE.Box3().setFromPoints([...sides, ...seatSides, back, center]).expandByPoint(center.clone().setY(ceiling));
  room.min.y = Math.min(room.min.y, box.min.y - 1); // down to the stage, below the screen's foot
  applyShadeZones(root, [room], DARK);

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = Math.round((CANVAS_W * height) / width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const text = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color: 0x000000, map: texture, transparent: true, depthWrite: false, ...inFront(2) }),
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

  // The floor strips: down the rake, from the back wall to the stage (or screen's wall), each with an
  // area light along it shining down and in across the floor.
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: HALO, ...inFront(1) }));
  halo.matrix.makeBasis(right, up, front).setPosition(center.clone().addScaledVector(front, size.dot(front) / 2 + OFFSET / 2));
  halo.matrixAutoUpdate = false;
  halo.layers.set(1); // the bloom's only
  group.add(halo);
  const glows = [halo];
  const lights = [light];
  const stripMaterial = new THREE.MeshBasicMaterial({ color: STRIP.color });
  const stripLights = [];
  // The floor runs up to the stage's front, if there is one, else the screen's wall.
  const stage = root.getObjectByName('Stage');
  const stageBox = stage && new THREE.Box3().setFromObject(stage);
  const floorEnd = stage ? Math.min(stageBox.min.dot(inward), stageBox.max.dot(inward)) : center.dot(inward) - size.dot(front) / 2;
  for (const side of seatSides) {
    const across = side.clone().sub(center).projectOnVector(right);
    const out = across.clone().normalize(); // towards this side's wall
    // SIDE_INSET in from this side's wall `along` the way in (the walls needn't be square to
    // the screen: they can close in towards the back), on the floor.
    const floorAt = (along) => {
      const middle = center.clone().addScaledVector(inward, along - center.dot(inward)).setY(midAt(along));
      const wall = hit(middle, out) ?? side.clone().addScaledVector(inward, along - side.dot(inward)).setY(middle.y);
      const p = wall.addScaledVector(out, -SIDE_INSET);
      return hit(p, down) ?? p.setY(box.min.y);
    };
    const a = floorAt(start + SIDE_INSET);
    const b = floorAt(floorEnd - SIDE_INSET);
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
    stripLights.push(stripLight);
  }

  // The uplights: a row of lamps on the floor in front of the curtains, each aimed up at them.
  const uplights = [];
  const lensMaterial = new THREE.MeshBasicMaterial({ color: UPLIGHT.color });
  if (curtain) {
    const cb = new THREE.Box3().setFromObject(curtain);
    const face = Math.max(cb.min.dot(front), cb.max.dot(front)); // the curtains' front, along `front`
    // Both curtains together, closed: this one's far edge from the middle of the screen, either side.
    const span = 2 * Math.max(...[cb.min, cb.max].map((c) => Math.abs(c.dot(right) - center.dot(right))));
    const canGeometry = new THREE.CylinderGeometry(LAMP.radius, LAMP.radius * 1.15, LAMP.height, 20);
    const lensGeometry = new THREE.CircleGeometry(LAMP.radius * 0.8, 20).rotateX(-Math.PI / 2);
    const canMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    for (let i = 0; i < UPLIGHT.count; i++) {
      const across = ((i + 0.5) / UPLIGHT.count - 0.5) * span;
      const onFace = center.clone().addScaledVector(front, face - center.dot(front)).addScaledVector(right, across);
      const p = onFace.clone().addScaledVector(front, UPLIGHT.out).setY(center.y);
      const floor = hit(p, new THREE.Vector3(0, -1, 0)) ?? p.setY(cb.min.y);
      const can = new THREE.Mesh(canGeometry, canMaterial);
      can.position.copy(floor).setY(floor.y + LAMP.height / 2);
      const lens = new THREE.Mesh(lensGeometry, lensMaterial);
      lens.position.copy(floor).setY(floor.y + LAMP.height + 0.002);
      group.add(can, lens);
      glows.push(lens);

      // The light itself shines from `below` m under the curtains' foot, wherever the lamp
      // stands (no shadows, so the stage doesn't get in the way): the light starts low on the
      // curtains however high the stage is.
      const source = Math.min(floor.y + LAMP.height + 0.01, cb.min.y - UPLIGHT.below);
      const spot = new THREE.SpotLight(UPLIGHT.color, UPLIGHT.intensity, cb.max.y - source, UPLIGHT.angle, UPLIGHT.penumbra, UPLIGHT.decay);
      spot.position.copy(floor).setY(source);
      spot.target.position.copy(onFace).setY(THREE.MathUtils.lerp(source, cb.max.y, UPLIGHT.aim));
      spot.userData.intensity = UPLIGHT.intensity;
      group.add(spot, spot.target);
      lights.push(spot);
      uplights.push(spot);
    }
  }
  // The house lights at `level` (1 up, 0 down).
  const setHouse = (level) => {
    for (const l of uplights) l.userData.intensity = l.intensity = UPLIGHT.intensity * level;
    lensMaterial.color.setHex(UPLIGHT.color).multiplyScalar(level);
    const strips = THREE.MathUtils.lerp(STRIP_DIM, 1, level);
    for (const l of stripLights) l.userData.intensity = l.intensity = STRIP_LIGHT.intensity * strips;
    stripMaterial.color.setHex(STRIP.color).multiplyScalar(strips);
  };

  // The invisible wall: across the room WALL_AT of the way down, solid from there to past the
  // screen (so it's always pushed back out the near side).
  const axis = Math.abs(inward.x) > 0.5 ? 'x' : 'z';
  const sign = Math.sign(inward[axis]);
  const wallAt = (start + WALL_AT * depth) * sign;
  const beyond = center[axis] + sign;
  const wall = room.clone();
  wall.min[axis] = Math.min(wallAt, beyond);
  wall.max[axis] = Math.max(wallAt, beyond);
  wall.min.y -= 10;
  wall.max.y += 1;
  group.updateMatrixWorld(true);

  // The curtains: the one in the level and its mirror image across the middle of the screen,
  // each sized by its own local matrix (from `base`, with the opening scale put in).
  const curtains = [];
  let sizeCurtains = null;
  let closedScale, openScale; // the curtains' scale along their local z (y in the .blend)
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
    // Each runs from its outer edge (its origin) along its local -z, its length in step with
    // its scale there: closed, from there to OVERLAP past the middle.
    curtain.geometry.computeBoundingBox();
    const local = new THREE.Vector3().setFromMatrixColumn(parent.matrixWorld.clone().multiply(new THREE.Matrix4().makeRotationFromQuaternion(base.quaternion)), 2);
    const perScale = local.length() * -curtain.geometry.boundingBox.min.z;
    const edge = new THREE.Vector3().setFromMatrixPosition(curtain.matrixWorld);
    openScale = base.scale.z;
    closedScale = (Math.abs(edge.dot(right) - center.dot(right)) + OVERLAP) / perScale;
    sizeCurtains(closedScale);
  }

  let state = 'waiting'; // then 'dimming', 'opening', 'playing', and 'over'
  let cue = 0; // s into 'dimming' or 'opening'
  let time = 0;
  let shown = -1;
  const show = (frame) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (frame < frames) {
      const column = canvas.width / COLUMNS;
      for (let c = 0; c < COLUMNS; c++) {
        const s = sentences[frame * COLUMNS + c];
        if (s) draw(canvas, s, c * column, column);
      }
      // The lines between the columns.
      ctx.fillStyle = '#fff';
      const line = canvas.width * DIVIDER;
      for (let c = 1; c < COLUMNS; c++) ctx.fillRect(c * column - line / 2, 0, line, canvas.height);
    }
    texture.needsUpdate = true;
  };

  return {
    meshes: [text],
    lights,
    // For the bloom (see bloom.js): the screen's halo, the text over it (so it stays readable
    // through the glow), the floor strips and the uplights' lenses.
    glows: [...glows, text],
    world,
    blockers: [wall],
    // `here`: the player is in this world; `player` for how far in they are.
    update(dt, here, player) {
      if (!here) return;
      if (state === 'waiting' && (player.position.dot(inward) - start) / depth >= TRIGGER) state = 'dimming';
      if (state === 'dimming') {
        cue = Math.min(cue + dt, DIM_TIME);
        setHouse(1 - THREE.MathUtils.smoothstep(cue, 0, DIM_TIME));
        if (cue === DIM_TIME) [state, cue] = ['opening', 0];
        return;
      }
      if (state === 'opening') {
        cue = Math.min(cue + dt, OPEN_TIME);
        const open = THREE.MathUtils.smoothstep(cue, 0, OPEN_TIME);
        sizeCurtains?.(THREE.MathUtils.lerp(closedScale, openScale, open));
        light.userData.intensity = light.intensity = GLOW * open;
        if (cue === OPEN_TIME) state = 'playing';
        return;
      }
      if (state !== 'playing') return;
      time += dt;
      const i = Math.min(Math.floor(time / interval), frames);
      if (i !== shown) show((shown = i));
      if (i === frames) state = 'over';
    },
  };
}

// The text and the halo lie a hair in front of the screen, but from the seats (40–90 m off)
// the depth buffer can't tell a centimetre apart, so they flickered in and out as you moved:
// pulled towards the camera in the depth test instead, `step` notches each.
function inFront(step) {
  return { polygonOffset: true, polygonOffsetFactor: -step, polygonOffsetUnits: -4 * step };
}

function velvet(from) {
  const color = from.color.clone();
  return new THREE.MeshPhysicalMaterial({
    name: 'Velvet',
    color: color.clone().multiplyScalar(BODY),
    roughness: 1,
    metalness: 0,
    sheen: 1,
    sheenColor: color.clone().offsetHSL(0, -SHEEN.desaturate, SHEEN.lighten),
    sheenRoughness: SHEEN.roughness,
    normalMap: pileNormals(),
    normalScale: new THREE.Vector2(PILE_DEPTH, PILE_DEPTH),
    side: from.side,
  });
}

// A tiling normal map of velvet's pile: per-fibre grain, softened a little, over a gentle
// mottling where the pile lies one way or another.
function pileNormals() {
  const n = PILE;
  const wrap = (i) => (i + n) % n;
  const h = new Float32Array(n * n);
  for (let i = 0; i < h.length; i++) h[i] = Math.random();
  // Soften the grain (a 3×3 box blur, wrapped so it still tiles).
  const soft = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += h[wrap(y + dy) * n + wrap(x + dx)];
      soft[y * n + x] = sum / 9;
    }
  // The mottling: smooth value noise over a CELLS × CELLS lattice, which tiles with the grain.
  const CELLS = 4;
  const lattice = Array.from({ length: CELLS * CELLS }, Math.random);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const gx = (x / n) * CELLS;
      const gy = (y / n) * CELLS;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const at = (i, j) => lattice[((y0 + j) % CELLS) * CELLS + ((x0 + i) % CELLS)];
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const v = THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(0, 0), at(1, 0), tx), THREE.MathUtils.lerp(at(0, 1), at(1, 1), tx), ty);
      soft[y * n + x] += v * 4; // gentle: spread over many pixels, so its slopes stay small
    }
  const data = new Uint8Array(n * n * 4);
  const v = new THREE.Vector3();
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = soft[y * n + wrap(x + 1)] - soft[y * n + wrap(x - 1)];
      const dy = soft[wrap(y + 1) * n + x] - soft[wrap(y - 1) * n + x];
      v.set(-dx, -dy, 1).normalize();
      const i = (y * n + x) * 4;
      data[i] = (v.x * 0.5 + 0.5) * 255;
      data[i + 1] = (v.y * 0.5 + 0.5) * 255;
      data[i + 2] = (v.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  const texture = new THREE.DataTexture(data, n, n);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(PILE_REPEAT, PILE_REPEAT);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

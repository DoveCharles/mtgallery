import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadLevel, buildCollider } from './level.js';
import { Player } from './player.js';
import { PortalSystem } from './portals.js';
import { Intro, dressStartArea, concreteMaterial } from './intro.js';
import { KeypadSystem, isMovingPart } from './keypad.js';
import { AmbientOcclusion } from './ao.js';
import { Bloom } from './bloom.js';
import { softShadows } from './shadows.js';
import { addCards } from './cards.js';
import { addSentenceScreens } from './screens.js';
import { applyShadeZones, addVoid } from './shade.js';
import { addFlickeringBulb } from './bulb.js';
import { addVideoScreen } from './video.js';
import { woodMaterial, oakMaterial } from './wood.js';
import { steelMaterial } from './steel.js';
import { starsMaterial } from './stars.js';
import { staticMaterial, addStatic, setStaticTime } from './static.js';
import { Sfx } from './sfx.js';

const overlay = document.getElementById('overlay');
const status = document.getElementById('status');
const crosshair = document.getElementById('crosshair');

// ?level=test loads the portal prototype instead of the starting area.
const levelName = new URLSearchParams(location.search).get('level') ?? 'start';

const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.prepend(renderer.domElement);

const FLOOR_FADE = 2.5; // seconds
const SKY_LIGHT = 0.08; // the Sky shader is very bright HDR
// Rooms in shadow: in these worlds, everything under the named ceiling gets only `light`
// of the sky and bounce light (see shade.js), so the sentence screens (lit by area
// lights, see screens.js) are what lights it. With `entrance`, the zone reaches on out to the
// room's Entrance portal, over the corridor in from it.
const SHADE = { 'room5555-left': { under: 'Ceiling', light: 0.06 }, 'room5555-right': { under: 'Ceiling', light: 0.12, entrance: true } };
// Room 5555 (right) is in shade, lit by square spotlights (see squareSpot) from its ceiling:
// one straight down on the plinth and its cube (`square` m across on the floor), and one on
// each row of wax frames (with `margin` m round them, from `out` m in front of the wall),
// which comes up from off `far` m from the row (short of the middle of the room, so both are
// off there) to full at `near` m. The frames' covers (their WaxCover material, see
// tools/build_room5555.py) fade right away, over `fade` s, once you're within `reveal` m of
// the row, and come back once you're `hide` m off again.
const GALLERY = {
  world: 'room5555-right',
  plinth: { objects: ['Plinth', 'Cube'], square: 1.8, intensity: 40 },
  frames: { objects: ['WaxFrame', 'WaxFrame001'], margin: 0.3, out: 2.5, intensity: 70, near: 2.5, far: 11, ease: 1.5 },
  covers: { material: 'WaxCover', reveal: 3, hide: 3.5, fade: 2.5 },
};
// Walls that are pure black (see addVoid in shade.js): in each world, the wall the named screen
// hangs on, all along under the ceiling (its doorways stay as they are).
const BLACK_WALLS = { 'room5555-right': { screen: 'Vid', under: 'Ceiling' } };

// Keypad codes and the rooms they open (public/levels/<room>.glb, entered through its
// "Entrance" portal): one room for the code, or one per door (by the door's mesh name).
// Rooms share the scene with the starting area, each moved out of the way, and are lit
// by the shared sky plus their own sun and lights (see setWorld).
// Looking down at the cards in room 5555 (left) zooms in so they can be read.
const ZOOM_WORLD = 'room5555-left';
const ZOOM_PITCH = [0.35, 1.2]; // downward pitch (rad) where the zoom starts, and where it's full
const ZOOM_MAX = 2.5; // magnification at full zoom
const ZOOM_RATE = 6; // how fast the zoom eases toward its target (1/s)

const ROOMS = { 5555: { DoorLeft: 'room5555-left', DoorRight: 'room5555-right' } };
const roomBehind = (door, room) => (typeof room === 'string' ? room : room[door.mesh.name]);
// Worlds reached from inside the rooms rather than through a door, and the portals joining
// them up: the slits through the Dierama's doors (room 5555 right) each lead to one
// configuration of the bedroom (see tools/build_bedroom.py).
const EXTRA_WORLDS = ['bedroom-closed', 'bedroom-open'];
const LINKS = [
  ['room5555-right/SlitClosed', 'bedroom-closed/Exit'],
  ['room5555-right/SlitOpen', 'bedroom-open/Exit'],
];
// Rooms' materials replaced by the starting area's concrete (Blender's had textures from
// elsewhere), at the scale their UVs had it.
const CONCRETE = 'concrete_layers_02';
const ROOM_CONCRETE_REPEAT = 1;
// Meshes given the procedural wood (src/wood.js), cut from one block in the first's space.
const WOOD = ['Dierama', 'DieramaDoors'];
// Frames' finishes: their materials (by name, under the named object) replaced by stained oak
// (src/wood.js) or grey powder-coated steel (src/steel.js), after the real ones. Each keeps its
// name, so the covers (WaxCover, see GALLERY) are still found to fade.
const FINISHES = { oak: oakMaterial, steel: steelMaterial };
const FRAME_FINISHES = [
  { object: 'WaxFrame', materials: ['Material.011'], finish: 'oak' },
  { object: 'WaxFrame001', materials: ['Material.011', 'WaxCover'], finish: 'steel' },
];
// The bedrooms' rug (bare in Bedroom.blend, and exported without UVs): the Unity project's
// carpet material ("Brass 3"), a grey wool zigzag with a worn carpet's normal map, projected
// from above at about the size Unity had it (0.48 of the image across a 0.7 m rug).
const CARPET = ['CarpetClosed', 'CarpetOpen'];
const CARPET_TILE = 1.5; // metres per repeat
// The closed bedroom's TV (Cube): its screen (Material.008) shows static (src/static.js).
// The open bedroom's TV keeps its own material.
const TV = { room: 'bedroom-closed', object: 'Cube', material: 'Material.008' };
const TV_LIGHT = { colour: 0xd6deff, intensity: 2.5, flicker: 0.25 }; // the screen's glow on the room
// Worlds in the dark: no sun, bounce light or lights of their own (from the .blend), and only
// a trace of sky light, so the closed bedroom is lit by its TV.
const DARK = new Set(['bedroom-closed']);
const DARK_SKY = 0.003;
// The closed bedroom's coat hangers: metal shows nothing in the dark (nothing to reflect)
// and they're out of the TV's light, so pale wire with a faint glow of its own, flickering a
// little with the TV's static.
const HANGERS = { name: 'CoatHangerClosed', glow: 0.1, static: 0.5 };
// And its carpet glows very faintly (its own pattern), so it shows in the dark.
const CARPET_GLOW = { CarpetClosed: 0.1 };
// Meshes that show space instead of themselves (src/stars.js): the closed bedroom's Star corridor.
const SPACE = ['Star'];
// The window at the Star corridor's end, the only thing in it besides space (see windowMask).
const SPACE_WINDOW = { corridor: 'Star', window: 'WindowWall' };
// Worlds drawn without the black ground, so their windows show sky all the way down.
const NO_GROUND = new Set(['bedroom-open']);
// Exits (the far end of a LINK) masked down to their slit's opening (see slitMask): with space
// in the closed bedroom's Star corridor, with the white of its walls in the open one's.
const SLIT_MASKED = { 'bedroom-closed/Exit': 'space', 'bedroom-open/Exit': 'wall' };
const WALL_MATERIAL = 'Material'; // the open bedroom corridor's white
const BARE_COLOUR = 0xe7e7e7; // the bedrooms' walls'
// Half the width of the Dierama's face around a slit (each slit is in the middle of one).
const SLIT_FACE = 1.6;
// Room i sits at (1000 * (i + 1), ROOM_HEIGHT, 0): raised clear of the intro's white
// ground plane (y 0) so its floor doesn't fight with it and light can get in from outside.
const ROOM_SPACING = 1000;
const ROOM_HEIGHT = 2;

softShadows();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050506);

const PLAY_FOV = 70;
const camera = new THREE.PerspectiveCamera(PLAY_FOV, innerWidth / innerHeight, 0.05, 500);

// Sky and sky light, shared by every world (the rooms are outdoors too, so the sky shows
// through any openings). The sky itself (blurred into an environment map) lights everything
// the sun doesn't, so shaded walls pick up a cool blue and lit ones a warm white.
const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(40), THREE.MathUtils.degToRad(150));

function carpetMaterial() {
  const loader = new THREE.TextureLoader();
  const load = (file, srgb) => {
    const t = loader.load(`/textures/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return new THREE.MeshStandardMaterial({
    name: 'Carpet',
    map: load('carpet_wool_diff.jpg', true),
    normalMap: load('carpet_wool_nor.jpg'),
    roughness: 0.95,
  });
}

// Space across the end of a corridor (along z, ending at its window, at +z), but for a hole
// just inside the window's casing and sill: they stand proud of the wall, in front of the
// panel, so its edge is hidden and the window and its frame are all that show.
function windowMask(corridor, win, material) {
  const end = new THREE.Box3().setFromObject(corridor);
  const z = end.max.z - 0.04; // just off the wall
  const casing = new THREE.Box3();
  const p = win.geometry.attributes.position;
  const v = new THREE.Vector3();
  win.updateWorldMatrix(true, false);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(win.matrixWorld);
    if (v.z < z) casing.expandByPoint(v);
  }
  const inset = 0.03;
  const shape = new THREE.Shape([
    new THREE.Vector2(end.min.x - 0.01, end.min.y - 0.01),
    new THREE.Vector2(end.max.x + 0.01, end.min.y - 0.01),
    new THREE.Vector2(end.max.x + 0.01, end.max.y + 0.01),
    new THREE.Vector2(end.min.x - 0.01, end.max.y + 0.01),
  ]);
  shape.holes.push(new THREE.Path([
    new THREE.Vector2(casing.min.x + inset, casing.min.y + inset),
    new THREE.Vector2(casing.min.x + inset, casing.max.y - inset),
    new THREE.Vector2(casing.max.x - inset, casing.max.y - inset),
    new THREE.Vector2(casing.max.x - inset, casing.min.y + inset),
  ]));
  const mask = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  mask.name = 'WindowMask';
  mask.position.z = z;
  return mask;
}

// UVs straight down from above (world x, z), CARPET_TILE metres per repeat.
function carpetUvs(mesh) {
  const p = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const uv = new Float32Array(p.count * 2);
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
    uv[i * 2] = v.x / CARPET_TILE;
    uv[i * 2 + 1] = -v.z / CARPET_TILE;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// A panel over an exit, but for a hole the size of its slit (an exit's centre is its slit's
// centre), so from the far side only the slit shows of the way back, as from the room.
function slitMask(exit, slit, material) {
  const w = exit.width / 2 + 0.02;
  const h = exit.height / 2 + 0.02;
  const shape = new THREE.Shape([new THREE.Vector2(-w, -h), new THREE.Vector2(w, -h), new THREE.Vector2(w, h), new THREE.Vector2(-w, h)]);
  const sw = slit.width / 2;
  const sh = slit.height / 2;
  shape.holes.push(new THREE.Path([new THREE.Vector2(-sw, -sh), new THREE.Vector2(-sw, sh), new THREE.Vector2(sw, sh), new THREE.Vector2(sw, -sh)]));
  const mask = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  mask.name = `SlitMask_${exit.id}`;
  exit.frame.matrixWorld.decompose(mask.position, mask.quaternion, mask.scale);
  mask.translateZ(0.003); // just on the near side of the screen
  return mask;
}

function addSky() {
  const sky = new Sky();
  sky.scale.setScalar(1000);
  sky.frustumCulled = false;
  const u = sky.material.uniforms;
  u.turbidity.value = 2;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(SUN_DIR);

  const skyScene = new THREE.Scene();
  skyScene.add(sky);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(skyScene, 0, 0.1, 2000).texture;
  scene.environmentIntensity = SKY_LIGHT;
  // Keep the sky box around whichever camera is drawing (the rooms are 1000s of m away).
  sky.onBeforeRender = (r, s, cam) => {
    sky.position.setFromMatrixPosition(cam.matrixWorld);
    sky.updateMatrixWorld();
  };
  const bounce = new THREE.HemisphereLight(0xf2f0ea, 0x9a9a9a, 0.9); // a little bounce from the ground
  scene.add(bounce);
  sky.userData.bounce = bounce;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap; // filtered by softShadows()
  // Redrawn once a frame (in the loop), not again for every portal view.
  renderer.shadowMap.autoUpdate = false;
  return sky;
}

// A sun for one world, its shadow camera fitted to that world's level.
function addSun(levelRoot, mapSize) {
  const bounds = new THREE.Box3().setFromObject(levelRoot);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const sun = new THREE.DirectionalLight(0xfff1dc, 4);
  sun.position.copy(center).addScaledVector(SUN_DIR, radius * 2);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mapSize, mapSize);
  Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: radius, far: radius * 3 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  levelRoot.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true;
  });
  return sun;
}

// The glow of a TV screen showing static: a wide spotlight just in front of the screen, out
// from the TV (the screen's thinnest axis, on the side away from the TV's middle).
function tvLight(screen) {
  const box = new THREE.Box3().setFromObject(screen);
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  let tv = screen;
  while (tv.parent && tv.name !== TV.object) tv = tv.parent;
  const out = new THREE.Vector3().subVectors(centre, new THREE.Box3().setFromObject(tv).getCenter(new THREE.Vector3()));
  const axis = size.x < Math.min(size.y, size.z) ? 'x' : size.y < size.z ? 'y' : 'z';
  const normal = new THREE.Vector3().setComponent(['x', 'y', 'z'].indexOf(axis), Math.sign(out[axis]) || 1);
  const light = new THREE.SpotLight(TV_LIGHT.colour, TV_LIGHT.intensity, 0, Math.PI / 2.4, 1, 2);
  light.position.copy(centre).addScaledVector(normal, 0.04);
  light.target.position.copy(centre).addScaledVector(normal, 1);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.near = 0.03;
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
  light.userData.intensity = TV_LIGHT.intensity;
  scene.add(light, light.target);
  return light;
}

// A spotlight from `from` whose light falls exactly on the quadrilateral `corners` (four
// points on a surface, in order): the cone just takes them in, and a mask (the light's map,
// projected as its shadow camera sees) cuts the light to their outline, hard edged.
function squareSpot(from, corners, { intensity, colour = 0xfff3e2 }) {
  const target = corners.reduce((sum, c) => sum.add(c), new THREE.Vector3()).divideScalar(corners.length);
  const view = new THREE.PerspectiveCamera(); // as three aims the light's shadow camera
  view.position.copy(from);
  view.lookAt(target);
  view.updateMatrixWorld();
  const flat = corners.map((c) => {
    const p = c.clone().applyMatrix4(view.matrixWorldInverse);
    return new THREE.Vector2(p.x / -p.z, p.y / -p.z);
  });
  const reach = Math.max(...flat.map((p) => p.length())) * 1.05; // tan of the cone's angle
  const size = 512;
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const p of flat) ctx.lineTo((p.x / reach / 2 + 0.5) * size, (0.5 - p.y / reach / 2) * size);
  ctx.fill();
  const light = new THREE.SpotLight(colour, intensity, 0, Math.atan(reach), 0, 2);
  light.map = new THREE.CanvasTexture(canvas);
  light.position.copy(from);
  light.target.position.copy(target);
  light.userData.intensity = intensity;
  scene.add(light, light.target);
  return light;
}

// The wall behind `screen`, under `ceiling`, as a void: its face (just round the screen's plane,
// facing into the room) from the floor up to the ceiling, across the ceiling's whole width.
function blackWall(screen, ceiling) {
  const s = new THREE.Box3().setFromObject(screen);
  const room = new THREE.Box3().setFromObject(ceiling);
  const size = s.getSize(new THREE.Vector3());
  const axis = size.x < size.z ? 'x' : 'z'; // the screen's thin side: across the wall
  const plane = s.getCenter(new THREE.Vector3())[axis];
  const facing = new THREE.Vector3();
  facing[axis] = Math.sign(room.getCenter(new THREE.Vector3())[axis] - plane);
  const box = room.clone();
  box.min.y = -1e4;
  box.max.y = room.min.y + 0.05;
  box.min[axis] = plane - 0.2;
  box.max[axis] = plane + 0.2;
  addVoid(box, facing);
}

// Room 5555 (right)'s spotlights (see GALLERY), and an update for the frames' to brighten as
// the player comes up to them.
function addGallerySpots(room) {
  const ceiling = new THREE.Box3().setFromObject(room.getObjectByName('Ceiling'));
  const top = ceiling.min.y - 0.05;
  const middle = ceiling.getCenter(new THREE.Vector3());
  const { plinth, frames, covers } = GALLERY;

  const stand = new THREE.Box3();
  for (const name of plinth.objects) stand.expandByObject(room.getObjectByName(name));
  const c = stand.getCenter(new THREE.Vector3());
  const h = plinth.square / 2;
  const floorY = stand.min.y;
  const square = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => new THREE.Vector3(c.x + x, floorY, c.z + z));
  const lights = [squareSpot(new THREE.Vector3(c.x, top, c.z + 1e-3), square, plinth)];

  const rows = frames.objects.map((name) => {
    const frame = room.getObjectByName(name);
    const b = new THREE.Box3().setFromObject(frame).expandByScalar(frames.margin);
    // This row's covers, in a material of their own so they fade apart from the other row's.
    let cover = null;
    const coverMeshes = [];
    frame.traverse((o) => {
      if (!o.isMesh || o.material.name !== covers.material) return;
      // (clone() leaves out the shade zones' shader patch: carried over by hand)
      const { onBeforeCompile, customProgramCacheKey } = o.material;
      o.material = cover ??= Object.assign(o.material.clone(), { transparent: true, onBeforeCompile, customProgramCacheKey });
      coverMeshes.push(o);
    });
    const centre = b.getCenter(new THREE.Vector3());
    const facing = Math.sign(middle.z - centre.z); // the frames hang on walls across z
    const z = facing > 0 ? b.min.z + frames.margin : b.max.z - frames.margin; // the wall, behind them
    const rect = [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.max.x, b.max.y], [b.min.x, b.max.y]].map(([x, y]) => new THREE.Vector3(x, y, z));
    const light = squareSpot(new THREE.Vector3(centre.x, top, z + facing * frames.out), rect, frames);
    light.userData.intensity = 0;
    lights.push(light);
    return { light, x: centre.x, halfWidth: (b.max.x - b.min.x) / 2, z, level: 0, cover, coverMeshes, shown: true };
  });

  const update = (dt, eye) => {
    for (const row of rows) {
      const d = Math.hypot(Math.max(0, Math.abs(eye.x - row.x) - row.halfWidth), eye.z - row.z);
      const goal = 1 - THREE.MathUtils.smoothstep(d, frames.near, frames.far);
      row.level += (goal - row.level) * Math.min(1, dt * frames.ease);
      row.light.userData.intensity = frames.intensity * row.level;
      if (!row.cover) continue;
      if (d < covers.reveal) row.shown = false;
      else if (d > covers.hide) row.shown = true;
      const m = row.cover;
      m.opacity = THREE.MathUtils.clamp(m.opacity + (row.shown ? dt : -dt) / covers.fade, 0, 1);
      m.depthWrite = m.opacity === 1;
      for (const o of row.coverMeshes) o.visible = m.opacity > 0;
    }
  };
  return { lights, update };
}

async function start() {
  const isStart = levelName === 'start';
  const level = await loadLevel(`/levels/${levelName}.glb`, scene, (e) => {
    if (e.total) status.textContent = `Loading… ${Math.round((e.loaded / e.total) * 100)}%`;
  }, isMovingPart, isStart ? { world: 'start' } : {});
  const roomNames = isStart ? [...new Set([...Object.values(ROOMS).flatMap((r) => (typeof r === 'string' ? r : Object.values(r))), ...EXTRA_WORLDS])] : [];
  const rooms = await Promise.all(
    roomNames.map((name, i) =>
      loadLevel(`/levels/${name}.glb`, scene, null, undefined, { world: name, offset: new THREE.Vector3(ROOM_SPACING * (i + 1), ROOM_HEIGHT, 0) }),
    ),
  );

  const roomConcrete = {}; // by side
  const bare = {}; // by side
  const spaceMeshes = [];
  const tvScreens = [];
  let tvStatic = null;
  const finishes = {};
  let carpet = null;
  let starry = null;
  for (const room of rooms) {
    room.root.traverse((o) => {
      if (o.isMesh && o.material.name === CONCRETE) {
        const { side } = o.material;
        o.material = roomConcrete[side] ??= Object.assign(concreteMaterial(ROOM_CONCRETE_REPEAT), { side });
      }
      // Meshes with no material in Blender (the beds, the ramps) get glTF's default, which is
      // fully metallic, so they'd mirror the sky: matte white instead, as the walls.
      if (o.isMesh && o.material.name === '' && o.material.metalness === 1) {
        const { side } = o.material;
        o.material = bare[side] ??= new THREE.MeshStandardMaterial({ name: 'Bare', color: BARE_COLOUR, roughness: 0.85, side });
      }
    });
    const block = room.root.getObjectByName(WOOD[0]);
    if (block) {
      const wood = woodMaterial({ space: block, side: block.material.side });
      for (const name of WOOD) {
        const o = room.root.getObjectByName(name);
        if (o?.isMesh) o.material = wood;
      }
    }
    for (const frame of FRAME_FINISHES) {
      room.root.getObjectByName(frame.object)?.traverse((o) => {
        const { name, side } = o.material ?? {};
        if (o.isMesh && frame.materials.includes(name)) o.material = finishes[`${frame.finish}/${name}`] ??= Object.assign(FINISHES[frame.finish]({ side }), { name });
      });
    }
    if (roomNames[rooms.indexOf(room)] === TV.room) room.root.traverse((o) => {
      if (!o.isMesh || o.material.name !== TV.material) return;
      for (let a = o; a && a !== room.root; a = a.parent) {
        if (a.name !== TV.object) continue;
        o.material = tvStatic ??= staticMaterial();
        o.castShadow = false;
        tvScreens.push(o);
        return;
      }
    });
    const hangers = room.root.getObjectByName(HANGERS.name);
    if (hangers?.isMesh) {
      hangers.material = new THREE.MeshStandardMaterial({ name: 'Hangers', color: 0xffffff, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: HANGERS.glow });
      addStatic(hangers.material, { amount: HANGERS.static });
    }
    for (const name of CARPET) {
      const o = room.root.getObjectByName(name);
      if (!o?.isMesh) continue;
      if (!o.geometry.attributes.uv) carpetUvs(o);
      o.material = carpet ??= carpetMaterial();
      if (name in CARPET_GLOW) {
        o.material = o.material.clone();
        Object.assign(o.material, { emissive: new THREE.Color(0xffffff), emissiveMap: o.material.map, emissiveIntensity: CARPET_GLOW[name] });
      }
    }
    for (const name of SPACE) {
      const o = room.root.getObjectByName(name);
      if (!o?.isMesh) continue;
      o.material = starry ??= starsMaterial();
      o.castShadow = false;
      spaceMeshes.push(o);
    }
    const corridor = room.root.getObjectByName(SPACE_WINDOW.corridor);
    const win = room.root.getObjectByName(SPACE_WINDOW.window);
    if (corridor?.isMesh && win?.isMesh) {
      const mask = windowMask(corridor, win, starry ??= starsMaterial());
      scene.add(mask);
      spaceMeshes.push(mask);
    }
  }

  const player = new Player(camera, renderer.domElement, buildCollider([level, ...rooms]));
  if (level.spawn) player.spawnAt(level.spawn);

  const listener = new THREE.AudioListener();
  camera.add(listener);
  const resumeAudio = () => listener.context.state !== 'running' && listener.context.resume();
  addEventListener('pointerdown', resumeAudio);
  addEventListener('keydown', resumeAudio);
  const sfx = isStart ? new Sfx(listener) : null;
  let landed = false; // the drone comes in once the intro's drop is over

  let intro = null;
  let keypads = null;
  let floor = null;
  let floorReveal = 0;
  let setWorld;
  if (isStart) {
    let button, logo, ground;
    const sky = addSky();
    ({ button, logo, floor, ground } = dressStartArea(level.root, scene, sky));

    // Each world keeps its own sun and lights; the others' are switched off while it's drawn.
    const worldLights = { start: [addSun(level.root, 4096)] };
    rooms.forEach((room, i) => {
      worldLights[roomNames[i]] = [addSun(room.root, 2048)];
      room.root.traverse((o) => o.isLight && worldLights[roomNames[i]].push(o));
    });
    for (const [name, lights] of Object.entries(worldLights)) {
      for (const l of lights) l.userData.intensity = DARK.has(name) ? 0 : l.intensity;
    }
    const { bounce } = sky.userData;
    const bounceIntensity = bounce.intensity;
    setWorld = (world) => {
      for (const [name, lights] of Object.entries(worldLights)) {
        for (const l of lights) l.intensity = name === world ? l.userData.intensity : 0;
      }
      const dark = DARK.has(world);
      scene.environmentIntensity = dark ? DARK_SKY : SKY_LIGHT;
      bounce.intensity = dark ? 0 : bounceIntensity;
      ground.visible = !NO_GROUND.has(world);
    };
    setWorld.lights = worldLights;
    rooms.forEach((room, i) => {
      const shade = SHADE[roomNames[i]];
      const ceiling = shade && room.root.getObjectByName(shade.under);
      const entrance = shade?.entrance && room.portals.find((p) => p.id.endsWith('Entrance'))?.mesh;
      const zone = ceiling && new THREE.Box3().setFromObject(ceiling);
      if (entrance) zone.union(new THREE.Box3().setFromObject(entrance));
      if (ceiling) applyShadeZones(room.root, [zone], shade.light);
      const black = BLACK_WALLS[roomNames[i]];
      const screen = black && room.root.getObjectByName(black.screen);
      if (screen) blackWall(screen, room.root.getObjectByName(black.under));
    });

    player.enabled = false;
    intro = new Intro({
      camera,
      dom: renderer.domElement,
      player,
      button,
      logo,
      onPress: () => {
        renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
        sfx.play('drop');
      },
      onLanded: () => (landed = true),
      onDone: () => {
        intro = null;
        crosshair.hidden = false;
      },
    });
    crosshair.hidden = true;
    keypads = new KeypadSystem({
      root: level.root,
      camera,
      dom: renderer.domElement,
      player,
      envMap: new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture,
      codes: ROOMS,
      sfx,
      onOpen: (door, room) => portals.connect(`door${keypads.doors.indexOf(door)}`, `${roomBehind(door, room)}/Entrance`),
      onEnter: () => (crosshair.hidden = true),
      onLeave: () => (crosshair.hidden = false),
    });
    player.blockers = keypads.blockers;
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x222226, 0.6));
  }
  // After the suns, which turn shadows on for everything in a level: the cards only receive them.
  const cards = (await Promise.all([level, ...rooms].map((l) => addCards(l.root)))).filter(Boolean);
  const worldNames = [isStart ? 'start' : undefined, ...roomNames];
  const screens = (
    await Promise.all([level, ...rooms].map((l, i) => addSentenceScreens(l, listener, worldNames[i])))
  ).filter(Boolean);
  // The screens' area lights belong to their world, like its other lights.
  for (const s of screens) {
    for (const l of s.lights) {
      l.userData.intensity = l.intensity;
      setWorld?.lights[s.world]?.push(l);
    }
  }
  const bulbs = (await Promise.all([level, ...rooms].map((l, i) => addFlickeringBulb(l, listener, worldNames[i])))).filter(Boolean);
  for (const b of bulbs) setWorld?.lights[b.world]?.push(b.light);
  const tvLights = tvScreens.map(tvLight);
  for (const l of tvLights) setWorld?.lights[TV.room]?.push(l);
  const galleryRoom = rooms[roomNames.indexOf(GALLERY.world)];
  const gallery = galleryRoom && addGallerySpots(galleryRoom.root);
  for (const l of gallery?.lights ?? []) setWorld?.lights[GALLERY.world]?.push(l);
  const videos = [level, ...rooms].map((l, i) => addVideoScreen(l, listener, worldNames[i])).filter(Boolean);
  const portals = new PortalSystem(renderer, scene, [...level.portals, ...rooms.flatMap((r) => r.portals), ...(keypads?.portalDefs ?? [])], {
    world: isStart ? 'start' : undefined,
    setWorld,
    // AO only on the view straight through a portal: the deeper, smaller views would
    // each cost a whole AO pass.
    afterView: (cam, target, level, scissor, portal) => level === 0 && ao.renderFactor(cam, scissor, portal),
  });
  for (const [a, b] of LINKS) if (portals.byId.has(a) && portals.byId.has(b)) portals.connect(a, b);
  // Funnels into the slits, and into their exits (which show only the slit, see slitMask,
  // and lead to it: an exit's offset from its centre is kept on the far side).
  for (const [a, b] of LINKS) {
    const slit = portals.byId.get(a);
    const exit = portals.byId.get(b);
    if (!slit?.linked || !exit) continue;
    player.addFunnel(slit.frame, slit.width, slit.height, { face: SLIT_FACE });
    if (b in SLIT_MASKED) player.addFunnel(exit.frame, slit.width, slit.height, { face: exit.width / 2 });
  }
  for (const [id, kind] of Object.entries(SLIT_MASKED)) {
    const exit = portals.byId.get(id);
    const slit = exit?.linked;
    if (!slit) continue;
    const outline = { id, frame: exit.frame, width: exit.width, height: exit.height }; // before it narrows
    const mask = (material) => slitMask(outline, slit, material);
    exit.resize(slit.width, slit.height); // only the slit shows the way back, even up close
    if (kind === 'space') {
      const panel = mask(starry ??= starsMaterial());
      scene.add(panel);
      spaceMeshes.push(panel);
    } else {
      const room = rooms[roomNames.indexOf(id.split('/')[0])];
      let wall = null;
      room?.root.traverse((o) => o.isMesh && o.material.name === WALL_MATERIAL && (wall ??= o.material));
      const panel = mask(wall ?? new THREE.MeshStandardMaterial({ color: 0xe7e7e7 }));
      panel.receiveShadow = true;
      scene.add(panel);
    }
  }
  const doorPortals = keypads?.doors.map((_, i) => portals.byId.get(`door${i}`)) ?? [];

  // After the intro (or after Esc), clicking the scene captures the mouse again.
  renderer.domElement.addEventListener('click', () => {
    if (!intro && !keypads?.busy && document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
    }
  });

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    portals.setSize();
    ao.setSize();
    bloom.setSize();
    intro?.resize();
  });

  const ao = new AmbientOcclusion(renderer, scene, camera);
  // Card text too: its letter quads are solid in the AO's normal pass and would come out as black bars.
  ao.hidden = [...portals.screens, ...cards.map((c) => c.getObjectByName('CardText')), ...screens.flatMap((s) => s.meshes), ...bulbs.flatMap((b) => b.meshes), ...videos.flatMap((v) => v.meshes), ...spaceMeshes, ...tvScreens];
  const bloom = new Bloom(renderer, scene, camera);
  if (keypads) bloom.add(keypads.glowMeshes);
  for (const b of bulbs) bloom.add(b.glows);
  await warmUp(portals, ao, bloom);
  overlay.classList.add('hidden');

  const clock = new THREE.Clock();
  const prevEye = new THREE.Vector3();
  const eye = new THREE.Vector3();
  let zoom = 1;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    setStaticTime(clock.elapsedTime);
    gallery?.update(dt, player.position);
    // The glow flickers with the static's frames (30 a second).
    const tvFrame = Math.floor(clock.elapsedTime * 30);
    for (const l of tvLights) {
      if (l.userData.frame === tvFrame) continue;
      l.userData.frame = tvFrame;
      l.userData.intensity = TV_LIGHT.intensity * (1 - TV_LIGHT.flicker * Math.random());
    }
    player.getEye(prevEye);
    player.update(dt);
    if (sfx) {
      // Horizontal speed this frame, before any portal moves the player.
      const speed = Math.hypot(player.getEye(eye).x - prevEye.x, eye.z - prevEye.z) / dt;
      sfx.footsteps(dt, player.enabled && player.onGround && speed > 0.1, speed / player.walkSpeed);
    }
    const cutscene = intro?.update(dt);
    // The floor stays black (part of the logo) until the camera is down in the corridor.
    if (floor && !(intro && (intro.state === 'title' || intro.state === 'drop'))) {
      floorReveal = Math.min(floorReveal + dt / FLOOR_FADE, 1);
      floor.setReveal(floorReveal);
    }
    // A door's portal only needs drawing once the door has started to open.
    keypads?.doors.forEach((d, i) => (doorPortals[i].active = d.state !== 'closed'));
    if (!keypads?.update(dt, portals.world === 'start') && !cutscene) {
      portals.handleTraversal(player, prevEye, player.getEye(eye));
      player.updateCamera();
      const t = portals.world === ZOOM_WORLD ? THREE.MathUtils.smoothstep(-player.pitch, ZOOM_PITCH[0], ZOOM_PITCH[1]) : 0;
      zoom += (THREE.MathUtils.lerp(1, ZOOM_MAX, t) - zoom) * (1 - Math.exp(-ZOOM_RATE * dt));
      const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(PLAY_FOV / 2)) / zoom));
      if (Math.abs(camera.fov - fov) > 1e-3) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }

    for (const s of screens) s.update(dt, portals.world === s.world);
    for (const b of bulbs) b.update(dt, portals.world === b.world);
    for (const v of videos) v.update(dt, portals.world === v.world);
    sfx?.setDrone(landed && portals.world === 'start');
    sfx?.setReverb(portals.world === 'start');
    renderer.shadowMap.needsUpdate = true;
    ao.strength = intro ? intro.aoStrength : 1;
    portals.render(scene, camera);
    renderer.render(scene, camera);
    ao.render();
    bloom.render();
  });

  // DEBUG (remove before the final version): 5 / 6 skip the intro and put the player in
  // room 5555 left / right, just inside its entrance, with the door behind them open.
  const DEBUG_ROOMS = { Digit5: 'room5555-left', Digit6: 'room5555-right', Numpad5: 'room5555-left', Numpad6: 'room5555-right' };
  addEventListener('keydown', (e) => {
    const room = DEBUG_ROOMS[e.code];
    const entrance = room && portals.byId.get(`${room}/Entrance`);
    if (!entrance || keypads?.busy) return;
    intro?.skip();
    const door = keypads?.doors.find((d) => roomBehind(d, ROOMS[5555]) === room);
    if (door) {
      door.open();
      keypads.onOpen(door, ROOMS[5555]);
    }
    const c = entrance.frame.getWorldPosition(new THREE.Vector3());
    player.position.copy(c).addScaledVector(entrance.normal, 1.5).setY(c.y - entrance.height / 2);
    player.velocity.set(0, 0, 0);
    player.yaw = Math.atan2(-entrance.normal.x, -entrance.normal.z);
    player.pitch = 0;
    portals.world = room;
    setWorld?.(room);
    renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
  });

  if (import.meta.env.DEV) window.__mt = { THREE, scene, camera, player, portals, renderer, ao, bloom, intro: () => intro, keypads: () => keypads, sfx };
}

// Compiles every shader and allocates every render target the game can need while still
// loading, so nothing hitches the first time a door opens onto a portal or you walk into a
// room. Portal views are clipped at the exit, a separate variant of every shader, and the
// AO and bloom draw the scene with their own override materials.
async function warmUp(portals, ao, bloom) {
  const overrides = new THREE.Scene();
  for (const m of [ao.pass.normalMaterial, bloom.black]) overrides.add(new THREE.Mesh(new THREE.BoxGeometry(), m));
  const compiling = [];
  for (const planes of [[], [new THREE.Plane()]]) {
    renderer.clippingPlanes = planes;
    compiling.push(renderer.compileAsync(scene, camera), renderer.compileAsync(overrides, camera, scene));
  }
  renderer.clippingPlanes = [];
  await Promise.all(compiling);

  // compileAsync misses the variants a portal view needs (drawn into a target, so linear
  // output and no tone mapping, under a clip plane, then AO under the same plane), so draw
  // one for real, with culling off so every room's textures and buffers are uploaded too.
  const culled = [];
  scene.traverse((o) => o.frustumCulled && culled.push(o));
  for (const o of culled) o.frustumCulled = false;
  renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6)];
  renderer.setRenderTarget(portals.scratch);
  renderer.render(scene, camera);
  ao.renderFactor(camera, null, portals.portals[0]);
  renderer.clippingPlanes = [];
  for (const o of culled) o.frustumCulled = true;

  for (const target of [portals.scratch, ...portals.portals.map((p) => p.target)]) {
    renderer.setRenderTarget(target);
    renderer.clear();
  }
  renderer.setRenderTarget(null);
  bloom.render(true);
}

start().catch((err) => {
  console.error(err);
  status.textContent = 'Failed to load.';
});

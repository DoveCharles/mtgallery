import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadLevel, buildCollider } from './level.js';
import { Player } from './player.js';
import { PortalSystem } from './portals.js';
import { Intro, dressStartArea } from './intro.js';
import { KeypadSystem, isMovingPart } from './keypad.js';
import { AmbientOcclusion } from './ao.js';
import { Bloom } from './bloom.js';
import { softShadows } from './shadows.js';
import { addCards } from './cards.js';

const overlay = document.getElementById('overlay');
const status = document.getElementById('status');
const crosshair = document.getElementById('crosshair');

// ?level=test loads the portal prototype instead of the starting area.
const levelName = new URLSearchParams(location.search).get('level') ?? 'start';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.prepend(renderer.domElement);

const FLOOR_FADE = 2.5; // seconds
const SKY_LIGHT = 0.08; // the Sky shader is very bright HDR

// Keypad codes and the rooms they open (public/levels/<room>.glb, entered through its
// "Entrance" portal): one room for the code, or one per door (by the door's mesh name).
// Rooms share the scene with the starting area, each moved out of the way, and are lit
// by the shared sky plus their own sun and lights (see setWorld).
const ROOMS = { 5555: { DoorLeft: 'room5555-left', DoorRight: 'room5555-right' } };
const roomBehind = (door, room) => (typeof room === 'string' ? room : room[door.mesh.name]);
// Room i sits at (1000 * (i + 1), ROOM_HEIGHT, 0): raised clear of the intro's white
// ground plane (y 0) so its floor doesn't fight with it and light can get in from outside.
const ROOM_SPACING = 1000;
const ROOM_HEIGHT = 2;

softShadows();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050506);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 500);

// Sky and sky light, shared by every world (the rooms are outdoors too, so the sky shows
// through any openings). The sky itself (blurred into an environment map) lights everything
// the sun doesn't, so shaded walls pick up a cool blue and lit ones a warm white.
const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(40), THREE.MathUtils.degToRad(150));

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

async function start() {
  const isStart = levelName === 'start';
  const level = await loadLevel(`/levels/${levelName}.glb`, scene, (e) => {
    if (e.total) status.textContent = `Loading… ${Math.round((e.loaded / e.total) * 100)}%`;
  }, isMovingPart, isStart ? { world: 'start' } : {});
  const roomNames = isStart ? [...new Set(Object.values(ROOMS).flatMap((r) => (typeof r === 'string' ? r : Object.values(r))))] : [];
  const rooms = await Promise.all(
    roomNames.map((name, i) =>
      loadLevel(`/levels/${name}.glb`, scene, null, undefined, { world: name, offset: new THREE.Vector3(ROOM_SPACING * (i + 1), ROOM_HEIGHT, 0) }),
    ),
  );

  const player = new Player(camera, renderer.domElement, buildCollider([level, ...rooms]));
  if (level.spawn) player.spawnAt(level.spawn);

  let intro = null;
  let keypads = null;
  let floor = null;
  let floorReveal = 0;
  let setWorld;
  if (isStart) {
    let button, logo;
    const sky = addSky();
    ({ button, logo, floor } = dressStartArea(level.root, scene, sky));

    // Each world keeps its own sun and lights; the others' are switched off while it's drawn.
    const worldLights = { start: [addSun(level.root, 4096)] };
    rooms.forEach((room, i) => {
      worldLights[roomNames[i]] = [addSun(room.root, 2048)];
      room.root.traverse((o) => o.isLight && worldLights[roomNames[i]].push(o));
    });
    for (const l of Object.values(worldLights).flat()) l.userData.intensity = l.intensity;
    setWorld = (world) => {
      for (const [name, lights] of Object.entries(worldLights)) {
        for (const l of lights) l.intensity = name === world ? l.userData.intensity : 0;
      }
    };

    player.enabled = false;
    intro = new Intro({
      camera,
      dom: renderer.domElement,
      player,
      button,
      logo,
      onPress: () => renderer.domElement.requestPointerLock()?.catch?.(() => {}),
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
      onOpen: (door, room) => portals.connect(`door${keypads.doors.indexOf(door)}`, `${roomBehind(door, room)}/Entrance`),
      onEnter: () => (crosshair.hidden = true),
      onLeave: () => (crosshair.hidden = false),
    });
    player.blockers = keypads.blockers;
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x222226, 0.6));
  }
  // After the suns, which turn shadows on for everything in a level: the cards only receive them.
  await Promise.all([level, ...rooms].map((l) => addCards(l.root)));
  const portals = new PortalSystem(renderer, scene, [...level.portals, ...rooms.flatMap((r) => r.portals), ...(keypads?.portalDefs ?? [])], {
    world: isStart ? 'start' : undefined,
    setWorld,
    // AO only on the view straight through a portal: the deeper, smaller views would
    // each cost a whole AO pass.
    afterView: (cam, target, level, scissor) => level === 0 && ao.render(cam, target, scissor),
  });
  const doorPortals = keypads?.doors.map((_, i) => portals.byId.get(`door${i}`)) ?? [];

  // After the intro (or after Esc), clicking the scene captures the mouse again.
  renderer.domElement.addEventListener('click', () => {
    if (!intro && !keypads?.busy && document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock()?.catch?.(() => {});
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
  ao.hidden = portals.screens;
  const bloom = new Bloom(renderer, scene, camera);
  if (keypads) bloom.add(keypads.glowMeshes);
  await warmUp(portals, ao, bloom);
  overlay.classList.add('hidden');

  const clock = new THREE.Clock();
  const prevEye = new THREE.Vector3();
  const eye = new THREE.Vector3();

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    player.getEye(prevEye);
    player.update(dt);
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
    }

    renderer.shadowMap.needsUpdate = true;
    portals.render(scene, camera);
    renderer.render(scene, camera);
    ao.render();
    bloom.render();
  });

  if (import.meta.env.DEV) window.__mt = { THREE, scene, camera, player, portals, renderer, ao, bloom, intro: () => intro, keypads: () => keypads };
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
  ao.render(camera, portals.scratch);
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

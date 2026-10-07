import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadLevel } from './level.js';
import { Player } from './player.js';
import { PortalSystem } from './portals.js';
import { Intro, dressStartArea } from './intro.js';
import { KeypadSystem, isMovingPart } from './keypad.js';

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

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050506);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 500);

// Sky, sun and sky light for the outdoor starting area. The sun casts shadows over the
// level's bounds, and the sky itself (blurred into an environment map) lights everything
// the sun doesn't, so shaded walls pick up a cool blue and lit ones a warm white.
function addSkyAndSun(levelRoot) {
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(40), THREE.MathUtils.degToRad(150));
  const sky = new Sky();
  sky.scale.setScalar(1000);
  sky.frustumCulled = false;
  const u = sky.material.uniforms;
  u.turbidity.value = 2;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDir);

  const skyScene = new THREE.Scene();
  skyScene.add(sky);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(skyScene, 0, 0.1, 2000).texture;
  scene.environmentIntensity = 0.08; // the Sky shader is very bright HDR
  scene.add(new THREE.HemisphereLight(0xf2f0ea, 0x9a9a9a, 0.9)); // a little bounce from the ground

  // Fit the shadow camera to the level.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const bounds = new THREE.Box3().setFromObject(levelRoot);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const sun = new THREE.DirectionalLight(0xfff1dc, 4);
  sun.position.copy(center).addScaledVector(sunDir, radius * 2);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: radius, far: radius * 3 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  levelRoot.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true;
  });
  return sky;
}

async function start() {
  const level = await loadLevel(`/levels/${levelName}.glb`, scene, (e) => {
    if (e.total) status.textContent = `Loading… ${Math.round((e.loaded / e.total) * 100)}%`;
  }, isMovingPart);

  const player = new Player(camera, renderer.domElement, level.collider);
  if (level.spawn) player.spawnAt(level.spawn);
  const portals = new PortalSystem(renderer, scene, level.portals);

  let intro = null;
  let keypads = null;
  if (levelName === 'start') {
    const { button, logo } = dressStartArea(level.root, scene, addSkyAndSun(level.root));
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
      onEnter: () => (crosshair.hidden = true),
      onLeave: () => (crosshair.hidden = false),
    });
    player.blockers = keypads.blockers;
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x222226, 0.6));
  }
  overlay.classList.add('hidden');

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
    intro?.resize();
  });

  const clock = new THREE.Clock();
  const prevEye = new THREE.Vector3();
  const eye = new THREE.Vector3();

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    player.getEye(prevEye);
    player.update(dt);
    const cutscene = intro?.update(dt);
    if (!keypads?.update(dt) && !cutscene) {
      portals.handleTraversal(player, prevEye, player.getEye(eye));
      player.updateCamera();
    }

    portals.render(scene, camera);
    renderer.render(scene, camera);
  });

  if (import.meta.env.DEV) window.__mt = { THREE, scene, camera, player, portals, renderer, intro: () => intro, keypads: () => keypads };
}

start().catch((err) => {
  console.error(err);
  status.textContent = 'Failed to load.';
});

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { loadLevel } from './level.js';
import { Player } from './player.js';
import { PortalSystem } from './portals.js';
import { Intro, dressStartArea } from './intro.js';

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

function addSkyAndSun() {
  const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(40), THREE.MathUtils.degToRad(150));
  const sky = new Sky();
  sky.scale.setScalar(1000);
  sky.frustumCulled = false;
  const u = sky.material.uniforms;
  u.turbidity.value = 2;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sun);

  scene.add(new THREE.HemisphereLight(0xdde8ff, 0xb0b0b0, 2.2));
  const light = new THREE.DirectionalLight(0xfff4e6, 1.5);
  light.position.copy(sun).multiplyScalar(50);
  scene.add(light);
  return sky;
}

async function start() {
  const level = await loadLevel(`/levels/${levelName}.glb`, scene, (e) => {
    if (e.total) status.textContent = `Loading… ${Math.round((e.loaded / e.total) * 100)}%`;
  });

  const player = new Player(camera, renderer.domElement, level.collider);
  if (level.spawn) player.spawnAt(level.spawn);
  const portals = new PortalSystem(renderer, scene, level.portals);

  let intro = null;
  if (levelName === 'start') {
    const button = dressStartArea(level.root, scene, addSkyAndSun());
    player.enabled = false;
    intro = new Intro({
      camera,
      dom: renderer.domElement,
      player,
      button,
      onPress: () => renderer.domElement.requestPointerLock()?.catch?.(() => {}),
      onDone: () => {
        intro = null;
        crosshair.hidden = false;
      },
    });
    crosshair.hidden = true;
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x222226, 0.6));
  }
  overlay.classList.add('hidden');

  // After the intro (or after Esc), clicking the scene captures the mouse again.
  renderer.domElement.addEventListener('click', () => {
    if (!intro && document.pointerLockElement !== renderer.domElement) {
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
    if (!intro?.update(dt)) {
      portals.handleTraversal(player, prevEye, player.getEye(eye));
      player.updateCamera();
    }

    portals.render(scene, camera);
    renderer.render(scene, camera);
  });

  if (import.meta.env.DEV) window.__mt = { THREE, scene, camera, player, portals, renderer, intro: () => intro };
}

start().catch((err) => {
  console.error(err);
  status.textContent = 'Failed to load.';
});

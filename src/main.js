import * as THREE from 'three';
import { loadLevel } from './level.js';
import { Player } from './player.js';
import { PortalSystem } from './portals.js';

const overlay = document.getElementById('overlay');
const status = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050506);
scene.add(new THREE.HemisphereLight(0xffffff, 0x222226, 0.6));

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 500);

async function start() {
  const level = await loadLevel('/levels/test.glb', scene, (e) => {
    if (e.total) status.textContent = `Loading… ${Math.round((e.loaded / e.total) * 100)}%`;
  });

  const player = new Player(camera, renderer.domElement, level.collider);
  if (level.spawn) player.spawnAt(level.spawn);
  const portals = new PortalSystem(renderer, scene, level.portals);

  status.textContent = 'Click to enter';
  overlay.addEventListener('click', () => renderer.domElement.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    overlay.classList.toggle('hidden', document.pointerLockElement === renderer.domElement);
  });

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    portals.setSize();
  });

  const clock = new THREE.Clock();
  const prevEye = new THREE.Vector3();
  const eye = new THREE.Vector3();

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    player.getEye(prevEye);
    player.update(dt);
    portals.handleTraversal(player, prevEye, player.getEye(eye));
    player.updateCamera();

    portals.render(scene, camera);
    renderer.render(scene, camera);
  });

  if (import.meta.env.DEV) window.__mt = { THREE, scene, camera, player, portals, renderer };
}

start().catch((err) => {
  console.error(err);
  status.textContent = 'Failed to load.';
});

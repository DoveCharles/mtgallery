import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { loadSentences } from './cards.js';

// The sentence screens: the "CardScreens" mesh's panels each show a random sentence, a
// new one every INTERVALS seconds, left to right as seen from the front (the side its
// normals face). As in the old Unity RandomSentenceCycler2, each panel works through its
// own shuffle of every sentence before repeating, and ticks (the hi-hat) on every change.
//
// Each panel's text is drawn into its own canvas, shown on a see-through plane just in
// front of the panel, and only redrawn when the sentence changes. Each panel also lights
// the room in front of it with an area light its size. (The panels are set in a wall, so
// nothing is drawn or lit behind them: area lights cast no shadows and would shine
// straight through it.)

const INTERVALS = [1, 0.5, 0.25]; // seconds, left to right
const FONT = 'bold Georgia, "Times New Roman", serif';
const CANVAS_W = 1024;
const MARGIN = 0.1; // of the panel's width/height, kept clear of text
const MAX_EM = 0.16; // largest text size, as a fraction of the panel's height
const LINE = 1.2; // line height, in ems
const OFFSET = 0.01; // m the text floats off the panel
const TICK_VOLUME = 0.12;
const GLOW = 5; // area light intensity
// The screens' light can't reach their own wall, so a dimmer, wider area light a little in
// front of each panel shines back at it: the light bounced off the floor and ceiling.
const BOUNCE = 0.6; // intensity
const BOUNCE_SIZE = 1.6; // times the panel's size
const BOUNCE_DISTANCE = 3; // m in front of the panel
const GLOW_COLOR = 0xdfe8ff;

let tickBuffer;

export async function addSentenceScreens(level, listener, world) {
  const { root } = level;
  let mesh = null;
  root.traverse((o) => o.isMesh && o.name === 'CardScreens' && (mesh = o));
  if (!mesh) return null;
  root.updateMatrixWorld(true);
  const sentences = await loadSentences();
  tickBuffer ??= new THREE.AudioLoader().loadAsync('/audio/tick.mp3').catch(() => null);
  const buffer = await tickBuffer;
  RectAreaLightUniformsLib.init();

  const pos = mesh.geometry.getAttribute('position');
  const points = [];
  for (let i = 0; i < pos.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));

  // Axes: `front` out of the panels (their thin horizontal axis, towards the room's
  // entrance), `right` as seen by someone facing them.
  const box = new THREE.Box3().setFromPoints(points);
  const size = box.getSize(new THREE.Vector3());
  const front = size.x < size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const entrance = level.portals.find((p) => p.id.endsWith('Entrance'))?.mesh;
  if (entrance && new THREE.Box3().setFromObject(entrance).getCenter(new THREE.Vector3()).sub(box.getCenter(new THREE.Vector3())).dot(front) < 0) front.negate();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, front);

  // The panels are the mesh's separate pieces (vertices joined by faces), left to right.
  const parent = [...points.keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const index = mesh.geometry.index;
  const tris = index ? index.count : pos.count;
  for (let t = 0; t < tris; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => find(index ? index.getX(t + k) : t + k));
    parent[b] = a;
    parent[find(c)] = a;
  }
  const pieces = new Map();
  points.forEach((p, i) => {
    const k = find(i);
    if (!pieces.has(k)) pieces.set(k, []);
    pieces.get(k).push(p);
  });
  const groups = [...pieces.values()].sort((a, b) => a[0].dot(right) - b[0].dot(right));

  const group = new THREE.Group();
  group.name = 'SentenceScreens';
  root.parent.add(group);
  const panels = groups.slice(0, INTERVALS.length).map((pts, i) => {
    const r = pts.map((p) => p.dot(right));
    const u = pts.map((p) => p.dot(up));
    const width = Math.max(...r) - Math.min(...r);
    const height = Math.max(...u) - Math.min(...u);
    const f = pts.map((p) => p.dot(front));
    const depth = Math.max(...f) - Math.min(...f);
    const center = new THREE.Vector3()
      .addScaledVector(right, (Math.max(...r) + Math.min(...r)) / 2)
      .addScaledVector(up, (Math.max(...u) + Math.min(...u)) / 2)
      .addScaledVector(front, (Math.max(...f) + Math.min(...f)) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = Math.round((CANVAS_W * height) / width);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, map: texture, transparent: true, depthWrite: false });
    const geometry = new THREE.PlaneGeometry(width, height);
    const text = new THREE.Mesh(geometry, material);
    text.matrix.makeBasis(right, up, front).setPosition(center.clone().addScaledVector(front, depth / 2 + OFFSET));
    text.matrixAutoUpdate = false;
    text.renderOrder = 1;
    group.add(text);

    const light = new THREE.RectAreaLight(GLOW_COLOR, GLOW, width, height);
    light.position.copy(center).addScaledVector(front, depth / 2 + OFFSET * 2);
    light.lookAt(light.position.clone().add(front)); // shines along its -z: out of the panel
    const bounce = new THREE.RectAreaLight(GLOW_COLOR, BOUNCE, width * BOUNCE_SIZE, height * BOUNCE_SIZE);
    bounce.position.copy(center).addScaledVector(front, BOUNCE_DISTANCE);
    bounce.lookAt(center);
    group.add(light, bounce);

    let sound = null;
    if (buffer) {
      sound = new THREE.PositionalAudio(listener);
      sound.setRefDistance(4);
      sound.setVolume(TICK_VOLUME);
      sound.position.copy(center);
      group.add(sound);
    }
    return { interval: INTERVALS[i], timer: 0, order: [], canvas, texture, text, lights: [light, bounce], sound };
  });
  group.updateMatrixWorld(true);

  const show = (panel) => {
    if (!panel.order.length) panel.order = shuffle([...sentences]);
    draw(panel.canvas, panel.order.pop());
    panel.texture.needsUpdate = true;
  };
  for (const p of panels) show(p);

  return {
    meshes: panels.map((p) => p.text),
    lights: panels.flatMap((p) => p.lights),
    // `here`: the player is in this world, so the ticks can be heard.
    update(dt, here) {
      for (const p of panels) {
        p.timer += dt;
        if (p.timer < p.interval) continue;
        p.timer %= p.interval;
        show(p);
        if (here && p.sound && listener.context.state === 'running') {
          const source = listener.context.createBufferSource();
          source.buffer = buffer;
          source.connect(p.sound.getOutput());
          source.start();
        }
      }
    },
    world,
  };
}

// Word-wrapped and centred, as big as fits (up to MAX_EM of the height).
function draw(canvas, sentence) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width * (1 - MARGIN * 2);
  const h = canvas.height * (1 - MARGIN * 2);
  let size = canvas.height * MAX_EM;
  let lines;
  for (;;) {
    ctx.font = `${size}px ${FONT}`;
    lines = wrap(ctx, sentence, w);
    const wide = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if ((lines.length * size * LINE <= h && wide <= w) || size < 4) break;
    size *= 0.93;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const top = canvas.height / 2 - ((lines.length - 1) * size * LINE) / 2;
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, top + i * size * LINE));
}

function wrap(ctx, sentence, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of sentence.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  return lines;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

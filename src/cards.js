import * as THREE from 'three';

// The sentence cards: one card per line of public/sentences.txt, scattered face up over
// the faces tagged `cardarea` (the room's Floor vertex group), using the level's "Card" mesh as the template.
//
// Thousands of cards would be thousands of draw calls (and thousands of textures) done
// naively, so everything is baked into two static meshes instead: all the cards in one,
// and all the letters in another, each letter a little quad cut out of a single glyph
// atlas. That's two draw calls and one small texture however many cards there are.

const SIZE = 3; // cards are this many times the size of the Blender template
const FONT = 'Georgia, "Times New Roman", serif';
const ATLAS_PX = 96; // glyph size in the atlas
const PAD = 12; // atlas pixels around each glyph, so mipmaps don't bleed into neighbours
const MARGIN = 0.1; // of the card's width/height, kept clear of text
const MAX_EM = 0.1; // largest text size, as a fraction of the card's width
const LINE = 1.2; // line height, in ems
const LIFT = 0.003; // cards float this far above the floor (m)
const INK_LIFT = 0.0006; // and the ink this far above the card

// Every line of public/sentences.txt, parsed the same way as the old Unity
// RandomSentenceCycler. Fetched once, shared with the sentence screens.
let sentenceList;
export function loadSentences() {
  sentenceList ??= fetch('/sentences.txt')
    .then((r) => r.text())
    .then((t) =>
      t
        .split(/\r\n|\n|\r/)
        .map((s) => s.trim().replace(/\\$/, ''))
        .filter(Boolean),
    );
  return sentenceList;
}

export async function addCards(root) {
  let template = null;
  let area = null;
  root.traverse((o) => {
    if (o.isMesh && o.name === 'Card') template = o;
    if (o.userData.cardarea) area = o;
  });
  if (!template || !area) return null;
  root.updateMatrixWorld(true);
  const base = template.matrixWorld.clone().setPosition(0, 0, 0).scale(new THREE.Vector3(SIZE, SIZE, SIZE));

  const sentences = [...(await loadSentences())];

  const rand = mulberry32(5555);
  shuffle(sentences, rand);

  // `base` is the card in its own frame (scaled/rotated like the template, but at the
  // origin): flat on the floor, text running along local X with lines going down local Z.
  const g = template.geometry;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  const scale = new THREE.Vector3().setFromMatrixScale(base);
  const cardW = (max.x - min.x) * scale.x;
  const cardH = (max.z - min.z) * scale.z;

  const atlas = buildAtlas(sentences);
  const placements = scatter(area, sentences.length, Math.hypot(cardW, cardH) / 2, rand);
  template.removeFromParent();
  area.removeFromParent();

  const cards = bakeCards(g, base, placements);
  const ink = bakeInk(sentences, atlas, placements, base, min, max, cardW, cardH);

  const paper = new THREE.Mesh(cards, new THREE.MeshStandardMaterial({ color: 0xf3efe6, roughness: 0.85 }));
  paper.receiveShadow = true;
  const text = new THREE.Mesh(
    ink,
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: atlas.texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  text.name = 'CardText';
  text.renderOrder = 1;
  // Both meshes are in world space already.
  const group = new THREE.Group();
  group.name = 'Cards';
  group.add(paper, text);
  root.parent.add(group);
  return group;
}

// --- Glyph atlas -------------------------------------------------------------------------

function buildAtlas(sentences) {
  const chars = [...new Set(sentences.join(''))].filter((c) => c !== ' ');
  const ctx = document.createElement('canvas').getContext('2d');
  const font = `${ATLAS_PX}px ${FONT}`;
  ctx.font = font;
  const m = ctx.measureText('Hgjy|');
  const ascent = Math.ceil(m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent);
  const descent = Math.ceil(m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent);
  const cellH = ascent + descent + PAD * 2;

  // Pack the glyphs in rows.
  const W = 2048;
  const glyphs = new Map();
  let x = 0;
  let y = 0;
  for (const c of chars) {
    const advance = ctx.measureText(c).width;
    const w = Math.ceil(advance) + PAD * 2;
    if (x + w > W) (x = 0), (y += cellH);
    glyphs.set(c, { advance, x, y, w });
    x += w;
  }
  const H = THREE.MathUtils.ceilPowerOfTwo(y + cellH);

  const canvas = ctx.canvas;
  canvas.width = W;
  canvas.height = H;
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  for (const [c, gl] of glyphs) ctx.fillText(c, gl.x + PAD, gl.y + PAD + ascent);

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8; // the cards are mostly seen at a slant
  const space = ctx.measureText(' ').width;
  return { texture, glyphs, W, H, cellH, ascent, space };
}

// --- Layout --------------------------------------------------------------------------------

// Word-wraps a sentence to `maxWidth` atlas pixels; widths come back in atlas pixels.
function wrap(sentence, atlas, maxWidth) {
  const width = (w) => [...w].reduce((s, c) => s + (atlas.glyphs.get(c)?.advance ?? atlas.space), 0);
  const lines = [];
  let line = '';
  for (const word of sentence.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  return lines.map((l) => ({ text: l, width: width(l) }));
}

// The biggest text size (m per atlas px) that fits the sentence on the card, capped so
// short sentences don't fill the card with huge letters.
function fit(sentence, atlas, w, h) {
  let s = (MAX_EM * w) / ATLAS_PX;
  for (;;) {
    const lines = wrap(sentence, atlas, w / s);
    const tall = lines.length * LINE * ATLAS_PX * s;
    const wide = Math.max(...lines.map((l) => l.width)) * s;
    if ((tall <= h && wide <= w) || s < 1e-6) return { lines, s };
    s *= 0.93;
  }
}

// --- Placement -----------------------------------------------------------------------------

// Jittered grid over the area's bounds, cards never overlapping: [x, y, z, yaw] per card.
// Only cells lying wholly on the area's faces are used (found by dropping rays onto it),
// so the area can be any shape.
function scatter(area, n, radius, rand) {
  area.material.side = THREE.DoubleSide;
  const box = new THREE.Box3().setFromObject(area);
  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const groundAt = (x, z) => {
    ray.set(new THREE.Vector3(x, box.max.y + 1, z), down);
    return ray.intersectObject(area, false)[0]?.point.y;
  };
  // Shrink the grid until enough cells fit on the area.
  for (let cell = Math.sqrt((sizeX * sizeZ) / n); ; cell *= 0.98) {
    const cols = Math.floor(sizeX / cell);
    const rows = Math.floor(sizeZ / cell);
    const cells = [];
    for (let i = 0; i < cols * rows; i++) {
      const x = box.min.x + ((i % cols) + 0.5) * cell;
      const z = box.min.z + (Math.floor(i / cols) + 0.5) * cell;
      const h = cell / 2;
      const y = groundAt(x, z);
      if (y !== undefined && [[-h, -h], [h, -h], [h, h], [-h, h]].every(([dx, dz]) => groundAt(x + dx, z + dz) !== undefined)) {
        cells.push([x, y, z]);
      }
    }
    if (cells.length < n) continue;
    shuffle(cells, rand);
    const room = Math.max(0, cell / 2 - radius);
    return cells.slice(0, n).map(([x, y, z]) => [x + (rand() * 2 - 1) * room, y + LIFT, z + (rand() * 2 - 1) * room, rand() * Math.PI * 2]);
  }
}

const placeMatrix = (m, [x, y, z, yaw], base) => m.makeRotationY(yaw).setPosition(x, y, z).multiply(base);

// --- Baking --------------------------------------------------------------------------------

function bakeCards(template, base, placements) {
  const g = template.index ? template.toNonIndexed() : template;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const n = pos.count;
  const positions = new Float32Array(placements.length * n * 3);
  const normals = new Float32Array(placements.length * n * 3);
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  placements.forEach((p, i) => {
    placeMatrix(m, p, base);
    nm.getNormalMatrix(m);
    for (let j = 0; j < n; j++) {
      v.fromBufferAttribute(pos, j).applyMatrix4(m).toArray(positions, (i * n + j) * 3);
      if (nor) v.fromBufferAttribute(nor, j).applyMatrix3(nm).normalize().toArray(normals, (i * n + j) * 3);
      else normals.set([0, 1, 0], (i * n + j) * 3);
    }
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.computeBoundingSphere();
  return out;
}

function bakeInk(sentences, atlas, placements, base, min, max, cardW, cardH) {
  const scale = new THREE.Vector3().setFromMatrixScale(base);
  const textW = cardW * (1 - MARGIN * 2);
  const textH = cardH * (1 - MARGIN * 2);
  const centerX = (min.x + max.x) / 2;
  const centerZ = (min.z + max.z) / 2;
  const y = max.y + INK_LIFT / scale.y;

  // Every glyph's quad, in card space (local units), then placed per card.
  const quads = [];
  const layout = sentences.map((sentence) => {
    const { lines, s } = fit(sentence, atlas, textW, textH);
    const lineH = LINE * ATLAS_PX * s;
    let top = (-lines.length * lineH) / 2; // metres from the card's centre, down = +
    const start = quads.length;
    for (const line of lines) {
      let pen = (-line.width * s) / 2;
      const glyphTop = top + (lineH - (atlas.cellH - PAD * 2) * s) / 2;
      for (const c of line.text) {
        const gl = atlas.glyphs.get(c);
        if (gl) {
          const x0 = pen - PAD * s;
          const z0 = glyphTop - PAD * s;
          quads.push([x0, z0, x0 + gl.w * s, z0 + atlas.cellH * s, gl]);
          pen += gl.advance * s;
        } else pen += atlas.space * s;
      }
      top += lineH;
    }
    return [start, quads.length];
  });

  const count = quads.length;
  const positions = new Float32Array(count * 4 * 3);
  const uvs = new Float32Array(count * 4 * 2);
  const index = new Uint32Array(count * 6);
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  layout.forEach(([from, to], i) => {
    placeMatrix(m, placements[i], base);
    for (let q = from; q < to; q++) {
      const [x0, z0, x1, z1, gl] = quads[q];
      const corners = [
        [x0, z0, gl.x, gl.y],
        [x1, z0, gl.x + gl.w, gl.y],
        [x1, z1, gl.x + gl.w, gl.y + atlas.cellH],
        [x0, z1, gl.x, gl.y + atlas.cellH],
      ];
      corners.forEach(([cx, cz, u, w], k) => {
        // metres on the card -> template's local units (the template is scaled by `base`)
        v.set(centerX + cx / scale.x, y, centerZ + cz / scale.z).applyMatrix4(m);
        v.toArray(positions, (q * 4 + k) * 3);
        uvs[(q * 4 + k) * 2] = u / atlas.W;
        uvs[(q * 4 + k) * 2 + 1] = w / atlas.H;
      });
      index.set([q * 4, q * 4 + 2, q * 4 + 1, q * 4, q * 4 + 3, q * 4 + 2], q * 6);
    }
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

// --- Helpers -------------------------------------------------------------------------------

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(a, rand) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

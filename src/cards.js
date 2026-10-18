import * as THREE from 'three';

// The sentence cards: one card per line of public/sentences.txt, hung in a tidy grid on
// the walls around the faces tagged `cardarea` (the room's Floor vertex group), using the
// level's "Card" mesh as the template.
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
const LIFT = 0.003; // cards float this far off the wall (m)
const GAP = 0.15; // space between rows, as a fraction of the card's height
const ROWS = 12; // rows of cards up the walls, leaving the tops of the walls bare
const BOTTOM = 0.4; // m above the floor the lowest row starts
const CLEAR = 2.5; // m of open room a wall needs in front of it (so no passages or reveals)
const FIXTURE_REACH = 0.5; // other meshes this close in front of a wall (m) keep cards off it
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
  // The template's size only: the walls decide which way each card faces.
  const base = new THREE.Matrix4().makeScale(...new THREE.Vector3().setFromMatrixScale(template.matrixWorld).multiplyScalar(SIZE).toArray());

  const sentences = [...(await loadSentences())];

  const rand = mulberry32(5555);
  shuffle(sentences, rand);

  // `base` is the card in its own frame: flat, facing local +Y, text running along local X
  // with lines going down local Z.
  const g = template.geometry;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  const scale = new THREE.Vector3().setFromMatrixScale(base);
  const cardW = (max.x - min.x) * scale.x;
  const cardH = (max.z - min.z) * scale.z;

  const atlas = buildAtlas(sentences);
  const placements = hang(findWalls(root, template, area), sentences.length, cardW, cardH, area, rand).map((m) => m.multiply(base));
  if (placements.length < sentences.length) console.warn(`Room for only ${placements.length} of ${sentences.length} cards on the walls`);
  sentences.length = placements.length;
  template.removeFromParent();
  area.removeFromParent();

  const cards = bakeCards(g, placements);
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

// The walls the cards can hang on: the room shell's upright faces around the card area,
// grouped by plane. Only the parts of them that face open floor count (not the sides of
// passages, reveals, or faces hidden in the shell), and anything else in the level just in
// front of a wall (the sentence screens, the ceiling's edge) is kept clear as a rectangle.
// Each wall comes back in its own 2D frame: u along it (left to right, facing it), v up.
function findWalls(root, template, area) {
  const floorBox = new THREE.Box3().setFromObject(area);
  const floorCenter = floorBox.getCenter(new THREE.Vector3());
  const meshes = [];
  root.traverse((o) => o.isMesh && o.visible && o !== template && o !== area && meshes.push(o));
  const boxes = new Map(meshes.map((m) => [m, new THREE.Box3().setFromObject(m)]));
  // The shell: whatever encloses the middle of the floor. The rest are fixtures.
  const isShell = (m) => {
    const b = boxes.get(m);
    return floorCenter.x >= b.min.x && floorCenter.x <= b.max.x && floorCenter.z >= b.min.z && floorCenter.z <= b.max.z;
  };
  const shell = meshes.filter(isShell);
  const fixtures = meshes.filter((m) => !isShell(m));

  // Every face counts as a blocker whichever way it faces. (Fixtures in front of a wall
  // don't count here: they only keep cards off the part they cover.)
  const sides = new Map();
  for (const m of meshes) for (const mat of [m.material].flat()) sides.set(mat, mat.side);
  for (const mat of sides.keys()) mat.side = THREE.DoubleSide;
  area.material.side = THREE.DoubleSide;
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const firstHit = (from, dir, objects, far = Infinity) => {
    ray.set(from, dir);
    ray.far = far;
    return ray.intersectObjects(objects, false)[0]?.distance;
  };
  // Open floor in front of a point on a wall facing `n`.
  const facesRoom = (p, n) => {
    const from = p.clone().addScaledVector(n, 0.01);
    if (firstHit(from, n, shell, CLEAR) !== undefined) return false;
    const front = p.clone().addScaledVector(n, CLEAR / 2);
    const floor = firstHit(front, down, [area]);
    return floor !== undefined && !(firstHit(front, down, meshes) < floor - 0.05);
  };

  const walls = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const e = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  for (const mesh of shell) {
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const [ia, ib, ic] = index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2];
      a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
      n.subVectors(c, b).cross(e.subVectors(a, b));
      if (n.length() < 1e-6) continue;
      n.normalize();
      if (Math.abs(n.y) > 0.01) continue;
      centroid.copy(a).add(b).add(c).divideScalar(3);
      if (centroid.x < floorBox.min.x - 0.3 || centroid.x > floorBox.max.x + 0.3 || centroid.z < floorBox.min.z - 0.3 || centroid.z > floorBox.max.z + 0.3) continue;
      if (!facesRoom(centroid, n)) continue;
      const d = n.dot(a);
      let wall = walls.find((w) => w.n.dot(n) > 0.999 && Math.abs(w.d - d) < 0.01);
      if (!wall) {
        const u = new THREE.Vector3(n.z, 0, -n.x); // up x n: rightwards, facing the wall
        wall = { n: n.clone(), d, u, tris: [], umin: Infinity, umax: -Infinity, vmax: -Infinity, keepOut: [] };
        walls.push(wall);
      }
      const tri = [a, b, c].map((p) => [p.dot(wall.u), p.y]);
      wall.tris.push(tri);
      for (const [pu, pv] of tri) {
        wall.umin = Math.min(wall.umin, pu);
        wall.umax = Math.max(wall.umax, pu);
        wall.vmax = Math.max(wall.vmax, pv);
      }
    }
  }
  for (const [mat, side] of sides) mat.side = side;

  for (const wall of walls) {
    for (const f of fixtures) {
      const corners = boxCorners(boxes.get(f));
      const dist = corners.map((p) => p.dot(wall.n) - wall.d);
      if (Math.max(...dist) < -0.05 || Math.min(...dist) > FIXTURE_REACH) continue;
      const us = corners.map((p) => p.dot(wall.u));
      const vs = corners.map((p) => p.y);
      const rect = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
      if (rect[1] > wall.umin && rect[0] < wall.umax) wall.keepOut.push(rect);
    }
  }
  return walls;
}

// A grid of card-sized cells over the walls, ROWS rows level all the way round the room,
// each wall's columns centred on it and spaced as widely as still gives every card a cell.
// Fills from the bottom row up, any spare cells being scattered along the top row. Returns each card's world matrix (without the card's scale).
function hang(walls, n, cardW, cardH, area, rand) {
  const floorY = new THREE.Box3().setFromObject(area).max.y;
  const inTri = (pu, pv, [[ax, ay], [bx, by], [cx, cy]]) => {
    const d1 = (pu - bx) * (ay - by) - (ax - bx) * (pv - by);
    const d2 = (pu - cx) * (by - cy) - (bx - cx) * (pv - cy);
    const d3 = (pu - ax) * (cy - ay) - (cx - ax) * (pv - ay);
    return !((d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9) && (d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9));
  };
  const onWall = (w, pu, pv) => w.tris.some((t) => inTri(pu, pv, t));
  const ph = cardH * (1 + GAP);
  const cellsAt = (k) => {
    const pw = cardW * k;
    const cells = [];
    for (const w of walls) {
      const cols = Math.floor((w.umax - w.umin) / pw);
      const u0 = (w.umin + w.umax - cols * pw) / 2;
      for (let row = 0; row < ROWS && floorY + BOTTOM + (row + 1) * ph <= w.vmax; row++) {
        const v0 = floorY + BOTTOM + row * ph;
        for (let col = 0; col < cols; col++) {
          const ua = u0 + col * pw + 1e-4;
          const ub = ua + pw - 2e-4;
          const va = v0 + 1e-4;
          const vb = v0 + ph - 2e-4;
          if (w.keepOut.some(([r0, r1, r2, r3]) => ub > r0 && ua < r1 && vb > r2 && va < r3)) continue;
          if ([[ua, va], [ub, va], [ub, vb], [ua, vb], [(ua + ub) / 2, (va + vb) / 2]].every(([pu, pv]) => onWall(w, pu, pv))) {
            cells.push({ w, u: (ua + ub) / 2, v: (va + vb) / 2, row });
          }
        }
      }
    }
    return cells;
  };

  // Widest spacing k (in card widths) that still fits n cards, bisecting between too wide
  // and wide enough. At k = 1 the cards touch: if even that's not enough, some are left out.
  let lo = 1;
  let hi = 4;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (cellsAt(mid).length >= n) lo = mid;
    else hi = mid;
  }
  const cells = cellsAt(lo);

  shuffle(cells, rand);
  cells.sort((p, q) => p.row - q.row);
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Vector3(0, -1, 0);
  return cells.slice(0, n).map(({ w, u, v }) =>
    // Card +X along the wall, +Y out of it, +Z down it.
    new THREE.Matrix4().makeBasis(w.u, w.n, down).setPosition(w.n.clone().multiplyScalar(w.d + LIFT).addScaledVector(w.u, u).addScaledVector(up, v)),
  );
}

function boxCorners(box) {
  const out = [];
  for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  return out;
}

// --- Baking --------------------------------------------------------------------------------

function bakeCards(template, placements) {
  const g = template.index ? template.toNonIndexed() : template;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const n = pos.count;
  const positions = new Float32Array(placements.length * n * 3);
  const normals = new Float32Array(placements.length * n * 3);
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  placements.forEach((m, i) => {
    nm.getNormalMatrix(m);
    for (let j = 0; j < n; j++) {
      v.fromBufferAttribute(pos, j).applyMatrix4(m).toArray(positions, (i * n + j) * 3);
      if (nor) v.fromBufferAttribute(nor, j).applyMatrix3(nm).normalize().toArray(normals, (i * n + j) * 3);
      else v.set(0, 1, 0).applyMatrix3(nm).normalize().toArray(normals, (i * n + j) * 3);
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
  const v = new THREE.Vector3();
  layout.forEach(([from, to], i) => {
    const m = placements[i];
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

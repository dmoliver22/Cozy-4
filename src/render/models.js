// Small procedural, toy-like models built from primitives with vertex colours.
// Everything here is seen from far away: shapes are kept simple and soft.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function colorize(geo, hex, jitter = 0, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const j = 1 + ((s / 2147483647) * 2 - 1) * jitter;
    col[i * 3] = c.r * j;
    col[i * 3 + 1] = c.g * j;
    col[i * 3 + 2] = c.b * j;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

/** Vertical gradient colouring (bottom -> top) for foliage. */
function gradient(geo, bottom, top, y0, y1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const a = new THREE.Color(bottom);
  const b = new THREE.Color(top);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) - y0) / (y1 - y0), 0, 1);
    tmp.copy(a).lerp(b, t);
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

function merge(list) {
  const geo = mergeGeometries(list, false);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export function treeGeometry(kind) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.09, 0.14, 1.1, 5);
  trunk.translate(0, 0.55, 0);
  parts.push(colorize(trunk, '#7a5a3e', 0.08, 3));
  if (kind === 0) {
    // round broadleaf canopy of a few soft blobs
    const blobs = [
      [0, 1.55, 0, 0.82],
      [0.42, 1.3, 0.2, 0.58],
      [-0.36, 1.35, -0.25, 0.6],
      [0.05, 2.0, -0.1, 0.55],
    ];
    for (const [x, y, z, r] of blobs) {
      const b = new THREE.IcosahedronGeometry(r, 1);
      b.translate(x, y, z);
      parts.push(gradient(b, '#4f7a3d', '#86ad5a', 0.8, 2.5));
    }
  } else {
    // tall, slender canopy (hillside alder / eucalyptus-like silhouette)
    const b = new THREE.IcosahedronGeometry(0.62, 1);
    b.scale(0.85, 2.0, 0.85);
    b.translate(0, 2.05, 0);
    parts.push(gradient(b, '#3f6a3c', '#7ea561', 1.0, 3.3));
    const b2 = new THREE.IcosahedronGeometry(0.42, 1);
    b2.scale(1, 1.4, 1);
    b2.translate(0.25, 1.4, 0.1);
    parts.push(gradient(b2, '#46703d', '#80a862', 0.9, 2.2));
  }
  return merge(parts);
}

export function riceGeometry() {
  const parts = [];
  const blades = 7;
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2 + k * 0.37;
    const h = 0.5 + ((k * 37) % 7) * 0.035;
    const lean = 0.12 + ((k * 13) % 5) * 0.025;
    const w = 0.035;
    const g = new THREE.BufferGeometry();
    const tx = Math.cos(a) * lean;
    const tz = Math.sin(a) * lean;
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    const mx = tx * 0.45;
    const mz = tz * 0.45;
    const verts = new Float32Array([
      -px, 0, -pz, px, 0, pz, mx + px * 0.8, h * 0.55, mz + pz * 0.8,
      -px, 0, -pz, mx + px * 0.8, h * 0.55, mz + pz * 0.8, mx - px * 0.8, h * 0.55, mz - pz * 0.8,
      mx - px * 0.8, h * 0.55, mz - pz * 0.8, mx + px * 0.8, h * 0.55, mz + pz * 0.8, tx, h, tz,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    parts.push(gradient(g, '#5c8a3e', '#d8e6a6', 0, 0.7));
  }
  const geo = mergeGeometries(parts, false);
  // normals pointing mostly up read best from above
  const n = geo.attributes.position.count;
  const nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.computeBoundingSphere();
  return geo;
}

export function teaGeometry() {
  const b = new THREE.IcosahedronGeometry(0.42, 1);
  b.scale(1.15, 0.72, 1.15);
  b.translate(0, 0.3, 0);
  const g = gradient(b, '#2f5a32', '#6f9c4f', 0.0, 0.62);
  return merge([g]);
}

export function flowerStemGeometry() {
  const s = new THREE.CylinderGeometry(0.018, 0.022, 0.42, 4);
  s.translate(0, 0.21, 0);
  const leaf = new THREE.IcosahedronGeometry(0.09, 0);
  leaf.scale(1.4, 0.4, 0.7);
  leaf.translate(0.06, 0.12, 0);
  return merge([colorize(s, '#5d8a45'), colorize(leaf, '#6a9a4a')]);
}

export function flowerHeadGeometry() {
  const h = new THREE.IcosahedronGeometry(0.11, 0);
  h.scale(1.3, 0.6, 1.3);
  h.translate(0, 0.45, 0);
  return merge([colorize(h, '#ffffff', 0.05)]);
}

export function houseBodyGeometry() {
  const parts = [];
  for (const [x, z] of [
    [-0.5, -0.4],
    [0.5, -0.4],
    [-0.5, 0.4],
    [0.5, 0.4],
  ]) {
    const st = new THREE.CylinderGeometry(0.06, 0.07, 2.0, 5);
    st.translate(x, -0.25, z); // stilts reach well below to stand on slopes
    parts.push(colorize(st, '#6e523a', 0.06, 5));
  }
  const floor = new THREE.BoxGeometry(1.42, 0.12, 1.22);
  floor.translate(0, 0.78, 0);
  parts.push(colorize(floor, '#8a6a4b', 0.05, 7));
  const walls = new THREE.BoxGeometry(1.18, 0.72, 0.98);
  walls.translate(0, 1.2, 0);
  parts.push(colorize(walls, '#b08a62', 0.05, 9));
  const door = new THREE.BoxGeometry(0.28, 0.46, 0.04);
  door.translate(0.15, 1.07, 0.5);
  parts.push(colorize(door, '#4a3526'));
  const ladder = new THREE.BoxGeometry(0.22, 0.05, 0.75);
  ladder.rotateX(-0.75);
  ladder.translate(0.15, 0.45, 0.85);
  parts.push(colorize(ladder, '#7a5a3e'));
  return merge(parts);
}

/** Pyramidal roof with gently flared, curving eaves (a lathe with 4 sides). */
export function houseRoofGeometry() {
  const pts = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = 1.18 * (1 - t) ** 1.35 + 0.0;
    const y = 1.05 * t + 0.1 * Math.sin(t * Math.PI) * 0.4 - (t < 0.12 ? (0.12 - t) * 0.7 : 0);
    pts.push(new THREE.Vector2(Math.max(r, 0.001), y));
  }
  const roof = new THREE.LatheGeometry(pts, 4);
  roof.rotateY(Math.PI / 4);
  roof.scale(1.12, 1, 1);
  roof.translate(0, 1.5, 0);
  const finial = new THREE.ConeGeometry(0.05, 0.22, 4);
  finial.translate(0, 2.62, 0);
  const g = gradient(roof, '#d9d2c4', '#ffffff', 1.5, 2.6);
  return merge([g, colorize(finial, '#e8e2d6')]);
}

export function windowGeometry() {
  const w = new THREE.PlaneGeometry(0.22, 0.2);
  w.translate(-0.3, 1.25, 0.5);
  const w2 = new THREE.PlaneGeometry(0.22, 0.2);
  w2.rotateY(Math.PI / 2);
  w2.translate(0.6, 1.25, 0);
  return mergeGeometries([w, w2], false);
}

export function villagerGeometry() {
  const body = new THREE.CylinderGeometry(0.07, 0.13, 0.36, 6);
  body.translate(0, 0.18, 0);
  const head = new THREE.IcosahedronGeometry(0.075, 1);
  head.translate(0, 0.44, 0);
  const hat = new THREE.ConeGeometry(0.17, 0.09, 8);
  hat.translate(0, 0.53, 0);
  return merge([colorize(body, '#ffffff', 0.04), colorize(head, '#c69a76'), colorize(hat, '#e2d0a0')]);
}

export function buffaloGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(0.5, 0.42, 1.05, 1, 1, 1);
  body.translate(0, 0.55, 0);
  parts.push(colorize(body, '#4d4a4a', 0.05));
  const head = new THREE.BoxGeometry(0.3, 0.28, 0.36);
  head.translate(0, 0.6, 0.66);
  parts.push(colorize(head, '#3f3c3c'));
  for (const s of [-1, 1]) {
    const horn = new THREE.CylinderGeometry(0.02, 0.04, 0.42, 4);
    horn.rotateZ(s * 1.1);
    horn.translate(s * 0.25, 0.8, 0.62);
    parts.push(colorize(horn, '#cfc6b4'));
  }
  for (const [x, z] of [
    [-0.17, -0.38],
    [0.17, -0.38],
    [-0.17, 0.38],
    [0.17, 0.38],
  ]) {
    const leg = new THREE.BoxGeometry(0.1, 0.38, 0.1);
    leg.translate(x, 0.19, z);
    parts.push(colorize(leg, '#3a3737'));
  }
  return merge(parts);
}

export function birdGeometry() {
  const g = new THREE.BufferGeometry();
  // a soft V: body at origin, wings out along x
  const v = new Float32Array([
    0, 0, 0.18, -0.55, 0.02, -0.05, 0, 0, -0.12,
    0, 0, 0.18, 0, 0, -0.12, 0.55, 0.02, -0.05,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return colorize(g, '#3b3a3f');
}

export function clodGeometry() {
  const g = new THREE.DodecahedronGeometry(0.28, 0);
  return colorize(g, '#8a6c4c', 0.12, 11);
}

export function seedGeometry() {
  const g = new THREE.IcosahedronGeometry(0.09, 0);
  g.scale(1, 0.7, 1.4);
  return colorize(g, '#e3cf8a', 0.05);
}

export function petalGeometry() {
  const g = new THREE.CircleGeometry(0.16, 5);
  g.rotateX(-Math.PI / 2);
  return colorize(g, '#ffffff');
}

export function leafGeometry() {
  const g = new THREE.CircleGeometry(0.22, 4);
  g.scale(1, 1.8, 1);
  g.rotateX(-Math.PI / 2);
  return colorize(g, '#ffffff');
}

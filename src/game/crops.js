// Rice, tea and flowers. Each plant grows by how well the water suits it:
// rice wants standing water, tea wants soil that is moist but drained (the
// seepage below a paddy), flowers just want a drink. Nothing ever dies — a
// thirsty plant only waits, pale, until water reaches it.
import * as THREE from 'three';
import { N, DX, HALF } from '../sim/constants.js';
import { patchMaterial } from '../render/shaders.js';
import { riceGeometry, teaGeometry, flowerStemGeometry, flowerHeadGeometry } from '../render/models.js';

export const RICE = 0;
export const TEA = 1;
export const FLOWER = 2;
export const CROP_NAMES = ['Rice', 'Tea', 'Flowers'];

const CAP = [4, 1, 2]; // plants per cell
const ROUGH = [0.9, 1.7, 1.6]; // how uneven the ground may be for each crop
const FLOWER_COLORS = ['#f6b8c8', '#fbe3e8', '#f7d679', '#c9b6e8', '#f2a48a', '#ffffff'].map((h) => new THREE.Color(h));

class Pool {
  constructor(type, max) {
    this.type = type;
    this.max = max;
    this.n = 0;
    this.x = new Float32Array(max);
    this.z = new Float32Array(max);
    this.y = new Float32Array(max);
    this.cell = new Int32Array(max);
    this.growth = new Float32Array(max);
    this.ripe = new Float32Array(max);
    this.hold = new Float32Array(max);
    this.health = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.size = new Float32Array(max);
    this.hue = new Uint8Array(max);
    this.id = new Int32Array(max);
  }
}

export class Crops {
  constructor(scene, terrain, water, ground) {
    this.terrain = terrain;
    this.water = water;
    this.ground = ground;
    this.perCell = new Uint8Array(N * N);
    this.pools = [new Pool(RICE, 5000), new Pool(TEA, 1600), new Pool(FLOWER, 1800)];
    this.nextId = 1;
    this.byId = new Map(); // id -> [type, index]
    this.harvests = 0;
    this.dirty = true;
    this.matrixTimer = 0;
    this.growTimer = 0;
    this.stats = { rice: 0, tea: 0, flowers: 0, riceMature: 0, teaMature: 0, flowersMature: 0, ripe: 0 };
    this.onBloom = null; // (x, y, z, color) petal fall

    const swayMat = (key, h) =>
      patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), {
        key,
        sway: 1,
        swayHeight: h,
      });
    this.riceMesh = new THREE.InstancedMesh(riceGeometry(), swayMat('rice', 0.6), this.pools[0].max);
    this.teaMesh = new THREE.InstancedMesh(teaGeometry(), swayMat('tea', 1.6), this.pools[1].max);
    this.stemMesh = new THREE.InstancedMesh(flowerStemGeometry(), swayMat('stem', 0.5), this.pools[2].max);
    this.headMesh = new THREE.InstancedMesh(flowerHeadGeometry(), swayMat('head', 0.5), this.pools[2].max);
    for (const m of [this.riceMesh, this.teaMesh, this.stemMesh, this.headMesh]) {
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
    }
    this.riceMesh.castShadow = false;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  cellAt(x, z) {
    const i = Math.round((x + HALF) / DX);
    const j = Math.round((z + HALF) / DX);
    if (i < 1 || j < 1 || i > N - 2 || j > N - 2) return -1;
    return i + j * N;
  }

  /** Can a seed of this type take root here? */
  canPlant(type, x, z) {
    const c = this.cellAt(x, z);
    if (c < 0) return -1;
    const t = this.terrain;
    if (t.channel[c]) return -1;
    if (t.roughness(c) > ROUGH[type]) return -1;
    if (this.perCell[c] >= CAP[type]) return -1;
    if (this.water.d[c] > 1.1) return -1;
    return c;
  }

  plant(type, x, z, opts = {}) {
    const c = opts.force ? this.cellAt(x, z) : this.canPlant(type, x, z);
    if (c < 0) return 0;
    const p = this.pools[type];
    if (p.n >= p.max) return 0;
    const k = p.n++;
    p.x[k] = x;
    p.z[k] = z;
    p.y[k] = this.groundAt(x, z);
    p.cell[k] = c;
    p.growth[k] = opts.growth ?? 0.04;
    p.ripe[k] = 0;
    p.hold[k] = 0;
    p.health[k] = 1;
    p.rot[k] = Math.random() * Math.PI * 2;
    p.size[k] = 0.85 + Math.random() * 0.35;
    p.hue[k] = Math.floor(Math.random() * FLOWER_COLORS.length);
    const id = this.nextId++;
    p.id[k] = id;
    this.byId.set(id, [type, k]);
    this.perCell[c]++;
    this.dirty = true;
    return id;
  }

  groundAt(x, z) {
    if (this.ground) return this.ground(x, z);
    const H = this.terrain.H;
    let gx = Math.min(N - 1.001, Math.max(0, (x + HALF) / DX));
    let gz = Math.min(N - 1.001, Math.max(0, (z + HALF) / DX));
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const c = i + j * N;
    const a = H[c] + (H[c + 1] - H[c]) * fx;
    const b = H[c + N] + (H[c + N + 1] - H[c + N]) * fx;
    return a + (b - a) * fz;
  }

  removeAt(type, k) {
    const p = this.pools[type];
    const last = --p.n;
    this.perCell[p.cell[k]]--;
    this.byId.delete(p.id[k]);
    if (k !== last) {
      for (const arr of [p.x, p.z, p.y, p.cell, p.growth, p.ripe, p.hold, p.health, p.rot, p.size, p.hue, p.id]) arr[k] = arr[last];
      this.byId.set(p.id[k], [type, k]);
    }
    this.dirty = true;
  }

  removeById(id) {
    const e = this.byId.get(id);
    if (!e) return null;
    const [type, k] = e;
    const p = this.pools[type];
    const pos = { x: p.x[k], y: p.y[k], z: p.z[k], type };
    this.removeAt(type, k);
    return pos;
  }

  /** Uproot plants on reshaped cells. Returns removed positions (for leaf puffs). */
  uproot(cells) {
    if (!cells.length) return [];
    const mark = new Uint8Array(N * N);
    for (const c of cells) mark[c] = 1;
    const out = [];
    for (let type = 0; type < 3; type++) {
      const p = this.pools[type];
      for (let k = p.n - 1; k >= 0; k--) {
        if (mark[p.cell[k]]) {
          out.push({ x: p.x[k], y: p.y[k], z: p.z[k], type });
          this.removeAt(type, k);
        }
      }
    }
    return out;
  }

  suitability(type, c) {
    const d = this.water.d[c];
    const m = this.water.moist[c];
    if (type === RICE) {
      if (d > 0.025 && d < 0.9) return 1;
      if (m > 0.9) return 0.3;
      return 0;
    }
    if (type === TEA) {
      if (d > 0.05) return 0;
      if (m > 0.22) return Math.min(1, (m - 0.15) * 2.2);
      return 0.04;
    }
    if (d > 0.12) return 0.1;
    return m > 0.12 ? 1 : 0.2;
  }

  update(dt, villageNear) {
    this.growTimer += dt;
    if (this.growTimer >= 0.5) {
      const step = this.growTimer;
      this.growTimer = 0;
      this._grow(step, villageNear);
    }
    this.matrixTimer += dt;
    if (this.dirty && this.matrixTimer > 0.2) {
      this.matrixTimer = 0;
      this.dirty = false;
      this._writeInstances();
    }
  }

  _grow(dt, villageNear) {
    const fert = this.water.fert;
    const st = this.stats;
    st.rice = this.pools[0].n;
    st.tea = this.pools[1].n;
    st.flowers = this.pools[2].n;
    st.riceMature = 0;
    st.teaMature = 0;
    st.flowersMature = 0;
    st.ripe = 0;
    const rates = [1 / 38, 1 / 55, 1 / 30];
    for (let type = 0; type < 3; type++) {
      const p = this.pools[type];
      for (let k = 0; k < p.n; k++) {
        const c = p.cell[k];
        const s = this.suitability(type, c);
        const g0 = p.growth[k];
        if (s > 0.05) {
          p.growth[k] = Math.min(1, g0 + rates[type] * s * (1 + fert[c] * 0.8) * dt);
          p.health[k] = Math.min(1, p.health[k] + 0.08 * dt);
        } else {
          p.health[k] = Math.max(0.35, p.health[k] - 0.02 * dt);
        }
        if (Math.abs(p.growth[k] - g0) > 0.002) this.dirty = true;
        if (p.growth[k] > 0.85) {
          if (type === RICE) {
            st.riceMature++;
            if (s > 0.05) p.ripe[k] = Math.min(1, p.ripe[k] + dt / 70);
            if (p.ripe[k] >= 1) {
              st.ripe++;
              p.hold[k] += dt;
            }
            this.dirty = true;
          } else if (type === TEA) {
            st.teaMature++;
          } else {
            st.flowersMature++;
            if (this.onBloom && Math.random() < dt * 0.012) {
              this.onBloom(p.x[k], p.y[k] + 0.45, p.z[k], FLOWER_COLORS[p.hue[k]]);
            }
          }
        }
      }
    }
  }

  /** Ripe rice near (x, z) for a villager to harvest; returns pool index or -1. */
  findRipe(x, z, r) {
    const p = this.pools[0];
    let best = -1;
    let bd = r * r;
    for (let k = 0; k < p.n; k++) {
      if (p.ripe[k] < 1 || p.hold[k] < 6) continue;
      const d = (p.x[k] - x) ** 2 + (p.z[k] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best >= 0 ? p.id[best] : 0;
  }

  /** Harvest ripe rice around an id; the field is replanted young and green. */
  harvest(id, radius = 1.6) {
    const e = this.byId.get(id);
    if (!e) return 0;
    const p = this.pools[0];
    const k0 = e[1];
    const x = p.x[k0];
    const z = p.z[k0];
    let n = 0;
    for (let k = 0; k < p.n; k++) {
      if (p.ripe[k] < 1) continue;
      if ((p.x[k] - x) ** 2 + (p.z[k] - z) ** 2 > radius * radius) continue;
      p.growth[k] = 0.3;
      p.ripe[k] = 0;
      p.hold[k] = 0;
      n++;
    }
    this.harvests += n;
    this.dirty = true;
    return n;
  }

  positionOf(id) {
    const e = this.byId.get(id);
    if (!e) return null;
    const p = this.pools[e[0]];
    return { x: p.x[e[1]], y: p.y[e[1]], z: p.z[e[1]] };
  }

  /** Coarse yield grid (8x8-cell blocks) used by the village. */
  yieldAround(x, z, r) {
    let y = 0;
    const r2 = r * r;
    const w = [1, 0.6, 0.25];
    for (let type = 0; type < 3; type++) {
      const p = this.pools[type];
      for (let k = 0; k < p.n; k++) {
        if (p.growth[k] < 0.85) continue;
        if ((p.x[k] - x) ** 2 + (p.z[k] - z) ** 2 < r2) y += w[type];
      }
    }
    return y;
  }

  totalYield() {
    return this.stats.riceMature + this.stats.teaMature * 0.6 + this.stats.flowersMature * 0.25;
  }

  /** Random mature plant position (weighted toward rice) — where homes may appear. */
  randomMature(rand = Math.random) {
    for (let tries = 0; tries < 12; tries++) {
      const type = rand() < 0.7 ? RICE : rand() < 0.6 ? TEA : FLOWER;
      const p = this.pools[type];
      if (!p.n) continue;
      const k = Math.floor(rand() * p.n);
      if (p.growth[k] >= 0.85) return { x: p.x[k], z: p.z[k], type };
    }
    return null;
  }

  refreshHeights(x0, z0, x1, z1) {
    for (let type = 0; type < 3; type++) {
      const p = this.pools[type];
      for (let k = 0; k < p.n; k++) {
        const c = p.cell[k];
        const i = c % N;
        const j = (c - i) / N;
        if (i < x0 - 1 || i > x1 + 1 || j < z0 - 1 || j > z1 + 1) continue;
        p.y[k] = this.groundAt(p.x[k], p.z[k]);
      }
    }
    this.dirty = true;
  }

  _writeInstances() {
    const m = this._m;
    const q = this._q;
    const s = this._s;
    const pos = this._p;
    const col = this._c;
    const up = this._up;
    // rice
    {
      const p = this.pools[0];
      const young = new THREE.Color('#79ad4c');
      const lush = new THREE.Color('#a3cf62');
      const gold = new THREE.Color('#e6c35c');
      const pale = new THREE.Color('#c9c58a');
      for (let k = 0; k < p.n; k++) {
        const g = p.growth[k];
        const sc = (0.3 + 0.7 * Math.pow(g, 0.7)) * p.size[k] * 1.55;
        q.setFromAxisAngle(up, p.rot[k]);
        s.set(sc * 1.25, sc * (0.6 + 0.4 * g + p.ripe[k] * 0.1), sc * 1.25);
        pos.set(p.x[k], p.y[k] - 0.02, p.z[k]);
        m.compose(pos, q, s);
        this.riceMesh.setMatrixAt(k, m);
        col.copy(young).lerp(lush, g).lerp(gold, p.ripe[k]);
        col.lerp(pale, 1 - p.health[k]);
        this.riceMesh.setColorAt(k, col);
      }
      this.riceMesh.count = p.n;
    }
    // tea
    {
      const p = this.pools[1];
      const base = new THREE.Color('#ffffff');
      const pale = new THREE.Color('#d8d08a');
      for (let k = 0; k < p.n; k++) {
        const g = p.growth[k];
        const sc = (0.2 + 0.8 * Math.pow(g, 0.8)) * p.size[k];
        q.setFromAxisAngle(up, p.rot[k]);
        s.set(sc, sc, sc);
        pos.set(p.x[k], p.y[k] - 0.05, p.z[k]);
        m.compose(pos, q, s);
        this.teaMesh.setMatrixAt(k, m);
        col.copy(base).lerp(pale, (1 - p.health[k]) * 0.7);
        this.teaMesh.setColorAt(k, col);
      }
      this.teaMesh.count = p.n;
    }
    // flowers
    {
      const p = this.pools[2];
      const bud = new THREE.Color('#9cc070');
      for (let k = 0; k < p.n; k++) {
        const g = p.growth[k];
        const sc = (0.25 + 0.75 * g) * p.size[k];
        q.setFromAxisAngle(up, p.rot[k]);
        s.set(sc, sc, sc);
        pos.set(p.x[k], p.y[k] - 0.02, p.z[k]);
        m.compose(pos, q, s);
        this.stemMesh.setMatrixAt(k, m);
        const bloom = Math.max(0, (g - 0.55) / 0.45);
        s.set(sc * (0.3 + 0.7 * bloom), sc, sc * (0.3 + 0.7 * bloom));
        m.compose(pos, q, s);
        this.headMesh.setMatrixAt(k, m);
        col.copy(bud).lerp(FLOWER_COLORS[p.hue[k]], bloom);
        col.multiplyScalar(0.75 + 0.25 * p.health[k]);
        this.headMesh.setColorAt(k, col);
      }
      this.stemMesh.count = p.n;
      this.headMesh.count = p.n;
    }
    for (const mesh of [this.riceMesh, this.teaMesh, this.stemMesh, this.headMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  serialize() {
    const out = [];
    for (let type = 0; type < 3; type++) {
      const p = this.pools[type];
      for (let k = 0; k < p.n; k++) out.push([type, +p.x[k].toFixed(2), +p.z[k].toFixed(2), +p.growth[k].toFixed(3), +p.ripe[k].toFixed(3)]);
    }
    return out;
  }

  load(list) {
    for (const [type, x, z, g, r] of list) {
      const id = this.plant(type, x, z, { force: true, growth: g });
      if (id && type === RICE) {
        const [, k] = this.byId.get(id);
        this.pools[0].ripe[k] = r;
      }
    }
  }
}

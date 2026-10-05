// Hamlets grow on their own wherever the fields prosper. Homes spring up on
// dry, level ground beside mature crops (with a little spring-damper bounce),
// cluster into hamlets, send up cooking smoke, light their windows at night,
// and send villagers (and the odd water buffalo) out to the fields.
import * as THREE from 'three';
import { N, DX, HALF } from '../sim/constants.js';
import { patchMaterial } from '../render/shaders.js';
import { houseBodyGeometry, houseRoofGeometry, windowGeometry, villagerGeometry, buffaloGeometry } from '../render/models.js';
import { P_SMOKE, P_DUST } from '../render/particles.js';

const MAX_HOUSES = 140;
const MAX_PEOPLE = 90;
const MAX_BUFFALO = 24;
const ROOFS = ['#b8603e', '#c47a52', '#a9894f', '#b8603e', '#9c6b3f'].map((h) => new THREE.Color(h));
const CLOTHES = ['#3f5c8a', '#7a4b6a', '#c96f4a', '#e8dcc0', '#4f7a5a', '#2f3f5f', '#a63f3a'].map((h) => new THREE.Color(h));

export class Village {
  constructor(scene, terrain, water, crops, particles) {
    this.terrain = terrain;
    this.water = water;
    this.crops = crops;
    this.particles = particles;
    this.houses = [];
    this.people = [];
    this.buffalo = [];
    this.hamlets = []; // [{houses:[...], cx, cz}]
    this.timer = 0;
    this.onHouse = null; // (house) callback for sound/feedback
    this.onHarvest = null;
    this.trees = null;

    const mat = (key) => patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), { key });
    this.bodyMesh = new THREE.InstancedMesh(houseBodyGeometry(), mat('house'), MAX_HOUSES);
    this.roofMesh = new THREE.InstancedMesh(houseRoofGeometry(), mat('roof'), MAX_HOUSES);
    this.windowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb85c'), side: THREE.DoubleSide, transparent: true, opacity: 0 });
    this.windowMesh = new THREE.InstancedMesh(windowGeometry(), this.windowMat, MAX_HOUSES);
    this.peopleMesh = new THREE.InstancedMesh(villagerGeometry(), mat('person'), MAX_PEOPLE);
    this.buffaloMesh = new THREE.InstancedMesh(buffaloGeometry(), mat('buffalo'), MAX_BUFFALO);
    for (const m of [this.bodyMesh, this.roofMesh, this.windowMesh, this.peopleMesh, this.buffaloMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = m !== this.windowMesh;
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
    this.roofMesh.setColorAt(0, ROOFS[0]);
    this.peopleMesh.setColorAt(0, CLOTHES[0]);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._ws = { depth: 0, ground: 0, surface: 0, u: 0, v: 0 };
  }

  get count() {
    return this.houses.length;
  }

  ground(x, z) {
    return this.crops.groundAt(x, z);
  }

  cell(x, z) {
    const i = Math.round((x + HALF) / DX);
    const j = Math.round((z + HALF) / DX);
    if (i < 2 || j < 2 || i > N - 3 || j > N - 3) return -1;
    return i + j * N;
  }

  siteOk(x, z) {
    const c = this.cell(x, z);
    if (c < 0) return false;
    const t = this.terrain;
    if (t.terrace[c] || t.channel[c] || t.wall[c]) return false;
    if (t.roughness(c) > 1.1) return false;
    for (const o of [0, -1, 1, -N, N, -N - 1, -N + 1, N - 1, N + 1]) {
      if (this.water.d[c + o] > 0.03) return false;
      if (t.channel[c + o] || t.terrace[c + o]) return false;
    }
    for (const h of this.houses) if ((h.x - x) ** 2 + (h.z - z) ** 2 < 2.6 * 2.6) return false;
    return true;
  }

  /** Houses supported by the current harvest. */
  capacity() {
    return Math.floor(this.crops.totalYield() / 6.5);
  }

  update(dt, ctx) {
    this.timer += dt;
    if (this.timer > 3.2) {
      this.timer = 0;
      this._evict();
      if (this.houses.length < Math.min(MAX_HOUSES, this.capacity())) this._grow(ctx);
    }
    this._animate(dt, ctx);
    this._agents(dt, ctx);
    this._write(ctx);
  }

  /** Homes on land that got reshaped or flooded pack up (and will regrow elsewhere). */
  _evict() {
    for (let k = this.houses.length - 1; k >= 0; k--) {
      const h = this.houses[k];
      const c = this.cell(h.x, h.z);
      if (c < 0) continue;
      const g = this.ground(h.x, h.z);
      if (this.water.d[c] > 0.18 || Math.abs(g - h.baseY) > 0.6 || this.terrain.terrace[c] || this.terrain.channel[c]) {
        this.particlesPuff(h.x, h.y + 1, h.z, 14);
        this.houses.splice(k, 1);
        this.people = this.people.filter((p) => p.home !== h);
        this._rehamlet();
      }
    }
  }

  removeHousesOn(cells) {
    if (!cells.length) return;
    const set = new Set(cells);
    let changed = false;
    for (let k = this.houses.length - 1; k >= 0; k--) {
      const h = this.houses[k];
      const c = this.cell(h.x, h.z);
      if (set.has(c) || set.has(c + 1) || set.has(c - 1) || set.has(c + N) || set.has(c - N)) {
        this.particlesPuff(h.x, h.y + 1, h.z, 14);
        this.houses.splice(k, 1);
        this.people = this.people.filter((p) => p.home !== h);
        changed = true;
      }
    }
    if (changed) this._rehamlet();
  }

  particlesPuff(x, y, z, n) {
    for (let i = 0; i < n; i++) {
      this.particles.spawn(P_DUST, x + (Math.random() - 0.5), y + Math.random() * 0.6, z + (Math.random() - 0.5), (Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3, 1.2 + Math.random(), 0.6 + Math.random() * 0.5, 0.86, 0.8, 0.7, 0.55, 0.5);
    }
  }

  _grow(ctx) {
    let best = null;
    let bestScore = -Infinity;
    for (let tries = 0; tries < 26; tries++) {
      const src = this.crops.randomMature();
      if (!src) return;
      const a = Math.random() * Math.PI * 2;
      const r = 2.2 + Math.random() * 6;
      const x = src.x + Math.cos(a) * r;
      const z = src.z + Math.sin(a) * r;
      if (!this.siteOk(x, z)) continue;
      let score = -this.terrain.roughness(this.cell(x, z)) * 2;
      // cluster: prefer being near another home, but not cramped
      let nearest = Infinity;
      for (const h of this.houses) nearest = Math.min(nearest, Math.hypot(h.x - x, h.z - z));
      if (nearest < 7) score += 3 - Math.abs(nearest - 3.4) * 0.6;
      else if (this.houses.length > 0 && nearest > 12) score += 1.5; // or found a new hamlet further off
      const c = this.cell(x, z);
      for (const o of [-2, 2, -2 * N, 2 * N]) if (this.terrain.path[c + o]) score += 1.2;
      score += this.crops.yieldAround(x, z, 8) * 0.05;
      score += Math.random() * 0.8;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    if (!best) return;
    const y = this.ground(best.x, best.z);
    // face downhill, toward the fields
    const gx = this.ground(best.x + 1, best.z) - this.ground(best.x - 1, best.z);
    const gz = this.ground(best.x, best.z + 1) - this.ground(best.x, best.z - 1);
    const rot = Math.atan2(-gx, -gz) + (Math.random() - 0.5) * 0.5;
    const h = {
      x: best.x,
      z: best.z,
      y: y + 0.0,
      baseY: y,
      rot,
      scale: 0.82 + Math.random() * 0.3,
      roof: Math.floor(Math.random() * ROOFS.length),
      s: 0,
      sv: 0,
      smoke: Math.random() * 3,
      hamlet: -1,
      born: ctx.time,
    };
    this.houses.push(h);
    if (this.trees) this.trees.clearAround(best.x, best.z, 1.6);
    this.particlesPuff(h.x, y + 0.5, h.z, 18);
    this._rehamlet();
    if (this.people.length < MAX_PEOPLE) this._spawnPerson(h);
    if (this.onHouse) this.onHouse(h);
  }

  _spawnPerson(home) {
    this.people.push({
      home,
      x: home.x + 0.8,
      z: home.z + 0.8,
      y: home.y,
      heading: Math.random() * 6.28,
      state: 'home',
      wait: 2 + Math.random() * 6,
      tx: home.x,
      tz: home.z,
      target: 0,
      color: Math.floor(Math.random() * CLOTHES.length),
      bob: Math.random() * 6,
    });
  }

  _rehamlet() {
    const hs = this.houses;
    const parent = hs.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let a = 0; a < hs.length; a++) {
      for (let b = a + 1; b < hs.length; b++) {
        if ((hs[a].x - hs[b].x) ** 2 + (hs[a].z - hs[b].z) ** 2 < 7.5 * 7.5) parent[find(a)] = find(b);
      }
    }
    const groups = new Map();
    hs.forEach((h, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(h);
    });
    this.hamlets = [...groups.values()].map((houses, idx) => {
      let cx = 0;
      let cz = 0;
      for (const h of houses) {
        h.hamlet = idx;
        cx += h.x;
        cz += h.z;
      }
      return { houses, cx: cx / houses.length, cz: cz / houses.length };
    });
    // a water buffalo for every hamlet of three homes or more
    const want = this.hamlets.filter((hm) => hm.houses.length >= 3);
    while (this.buffalo.length < Math.min(MAX_BUFFALO, want.length)) {
      const hm = want[this.buffalo.length];
      this.buffalo.push({ hamlet: hm, x: hm.cx + 1, z: hm.cz + 1, y: this.ground(hm.cx + 1, hm.cz + 1), heading: 0, tx: hm.cx, tz: hm.cz, wait: 3, bob: 0 });
    }
    for (let i = 0; i < this.buffalo.length && i < want.length; i++) this.buffalo[i].hamlet = want[i];
    if (this.buffalo.length > want.length) this.buffalo.length = want.length;
  }

  largestHamlet() {
    let m = 0;
    for (const h of this.hamlets) m = Math.max(m, h.houses.length);
    return m;
  }

  _animate(dt, ctx) {
    const night = ctx.night;
    const hour = ctx.hour;
    // cooking fires: mornings and evenings
    const cooking = Math.exp(-(((hour - 6.8) / 1.2) ** 2)) + Math.exp(-(((hour - 18.3) / 1.4) ** 2)) * 1.1 + 0.18;
    for (const h of this.houses) {
      // spring-damper pop-in (slightly underdamped so homes land with a bounce)
      const k = 140;
      const c = 11;
      h.sv += (-k * (h.s - 1) - c * h.sv) * dt;
      h.s += h.sv * dt;
      h.smoke -= dt * cooking;
      if (h.smoke <= 0 && h.s > 0.9) {
        h.smoke = 0.22 + Math.random() * 0.25;
        const sc = h.scale;
        this.particles.spawn(
          P_SMOKE,
          h.x + (Math.random() - 0.5) * 0.1,
          h.y + 2.65 * sc,
          h.z + (Math.random() - 0.5) * 0.1,
          (Math.random() - 0.5) * 0.2,
          0.6 + Math.random() * 0.3,
          (Math.random() - 0.5) * 0.2,
          6 + Math.random() * 3,
          0.5,
          0.86,
          0.86,
          0.88,
          0.2,
          0.9
        );
      }
    }
    this.windowMat.opacity = Math.min(1, night * 1.4 + Math.max(0, Math.exp(-(((hour - 19.2) / 0.8) ** 2)) * 0.6));
    this.windowMat.color.setRGB(1.6, 1.05, 0.5);
  }

  _agents(dt, ctx) {
    const ws = this._ws;
    for (const p of this.people) {
      p.bob += dt * 6;
      if (p.state === 'home' || p.state === 'work') {
        p.wait -= dt;
        if (p.wait <= 0) {
          if (p.state === 'home') {
            // head out: harvest ripe rice if any, otherwise tend a nearby plant
            let id = this.crops.findRipe(p.home.x, p.home.z, 22);
            let target = id ? this.crops.positionOf(id) : null;
            if (!target) {
              const m = this.crops.randomMature();
              if (m && Math.hypot(m.x - p.home.x, m.z - p.home.z) < 22) target = m;
              id = 0;
            }
            if (!target) {
              const a = Math.random() * 6.28;
              target = { x: p.home.x + Math.cos(a) * 4, z: p.home.z + Math.sin(a) * 4 };
            }
            p.tx = target.x;
            p.tz = target.z;
            p.target = id;
            p.state = 'walk';
          } else {
            if (p.target) {
              const n = this.crops.harvest(p.target);
              if (n && this.onHarvest) this.onHarvest(p.x, p.y, p.z, n);
              p.target = 0;
            }
            p.tx = p.home.x + 0.7;
            p.tz = p.home.z + 0.7;
            p.state = 'return';
          }
        }
      } else {
        const dx = p.tx - p.x;
        const dz = p.tz - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.4) {
          p.state = p.state === 'walk' ? 'work' : 'home';
          p.wait = p.state === 'work' ? 4 + Math.random() * 6 : 6 + Math.random() * 14;
          // nobody wanders out at night
          if (ctx.night > 0.6 && p.state === 'home') p.wait += 20;
          continue;
        }
        this._steer(p, dx / d, dz / d, dt, 0.9);
      }
      this.water.sample(p.x, p.z, ws);
      const deck = this.structures ? this.structures.heightAt(p.x, p.z) : -Infinity;
      p.y = Math.max(this.ground(p.x, p.z), deck);
      p.step = (p.step || 0) - dt;
      if (ws.depth > 0.05 && deck === -Infinity && (p.state === 'walk' || p.state === 'return') && p.step <= 0) {
        p.step = 0.4;
        this.water.splash(p.x, p.z, 0.35);
      }
    }
    for (const b of this.buffalo) {
      b.bob += dt * 2.5;
      const dx = b.tx - b.x;
      const dz = b.tz - b.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6) {
        b.wait -= dt;
        if (b.wait <= 0) {
          // wander toward a muddy paddy near home
          const hm = b.hamlet;
          let tx = hm.cx;
          let tz = hm.cz;
          for (let tries = 0; tries < 20; tries++) {
            const x = hm.cx + (Math.random() - 0.5) * 22;
            const z = hm.cz + (Math.random() - 0.5) * 22;
            const c = this.cell(x, z);
            if (c < 0) continue;
            if (this.terrain.terrace[c] && this.water.d[c] > 0.03) {
              tx = x;
              tz = z;
              break;
            }
          }
          b.tx = tx;
          b.tz = tz;
          b.wait = 8 + Math.random() * 12;
        }
      } else {
        this._steer(b, dx / d, dz / d, dt, 0.42);
      }
      this.water.sample(b.x, b.z, ws);
      b.y = ws.ground - Math.min(ws.depth, 0.35) * 0.4;
      // wading stirs the paddy: each step pushes a ring of real waves outward
      b.step = (b.step || 0) - dt;
      if (ws.depth > 0.05 && d >= 0.6 && b.step <= 0) {
        b.step = 0.55;
        this.water.splash(b.x + Math.sin(b.heading) * 0.5, b.z + Math.cos(b.heading) * 0.5, 0.9);
      }
    }
  }

  /** Greedy local steering over the heightfield: prefers paths, avoids drops and deep water. */
  _steer(a, dx, dz, dt, speed) {
    const t = this.terrain;
    let bestX = dx;
    let bestZ = dz;
    let bestS = -Infinity;
    const h0 = this.ground(a.x, a.z);
    for (const ang of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const vx = dx * ca - dz * sa;
      const vz = dx * sa + dz * ca;
      const nx = a.x + vx * 0.9;
      const nz = a.z + vz * 0.9;
      const c = this.cell(nx, nz);
      if (c < 0) continue;
      const dh = Math.abs(this.ground(nx, nz) - h0);
      let s = Math.cos(ang) * 2 - dh * 2.2 - (t.path[c] ? 0 : Math.min(this.water.d[c], 1) * 3);
      if (t.path[c]) s += 0.8;
      if (dh > 1.3) s -= 6;
      if (s > bestS) {
        bestS = s;
        bestX = vx;
        bestZ = vz;
      }
    }
    const c = this.cell(a.x, a.z);
    const onPath = c >= 0 && t.path[c];
    const wade = c >= 0 && !t.path[c] ? Math.min(this.water.d[c], 0.5) : 0;
    const v = speed * (onPath ? 1.7 : 1) * (1 - wade);
    a.heading = Math.atan2(bestX, bestZ);
    a.x += bestX * v * dt;
    a.z += bestZ * v * dt;
  }

  _write(ctx) {
    const m = this._m;
    const q = this._q;
    const s = this._s;
    const p = this._p;
    const e = this._e;
    const n = this.houses.length;
    for (let k = 0; k < n; k++) {
      const h = this.houses[k];
      const sc = h.scale * Math.max(0.001, h.s);
      e.set(0, h.rot, 0);
      q.setFromEuler(e);
      // squash & stretch on landing
      const stretch = 1 + h.sv * 0.02;
      s.set(sc / Math.sqrt(Math.max(0.3, stretch)), sc * stretch, sc / Math.sqrt(Math.max(0.3, stretch)));
      p.set(h.x, h.y, h.z);
      m.compose(p, q, s);
      this.bodyMesh.setMatrixAt(k, m);
      this.roofMesh.setMatrixAt(k, m);
      this.windowMesh.setMatrixAt(k, m);
      this.roofMesh.setColorAt(k, ROOFS[h.roof]);
    }
    this.bodyMesh.count = n;
    this.roofMesh.count = n;
    this.windowMesh.count = n;
    for (const mesh of [this.bodyMesh, this.roofMesh, this.windowMesh]) mesh.instanceMatrix.needsUpdate = true;
    if (this.roofMesh.instanceColor) this.roofMesh.instanceColor.needsUpdate = true;

    let k = 0;
    for (const person of this.people) {
      if (k >= MAX_PEOPLE) break;
      const visible = person.state !== 'home' || person.wait < 1.5;
      e.set(0, person.heading, 0);
      q.setFromEuler(e);
      const moving = person.state === 'walk' || person.state === 'return';
      const bob = moving ? Math.abs(Math.sin(person.bob)) * 0.05 : 0;
      const bend = person.state === 'work' ? 0.82 + 0.06 * Math.sin(person.bob * 0.4) : 1;
      s.set(visible ? 1 : 0.0001, visible ? bend : 0.0001, visible ? 1 : 0.0001);
      p.set(person.x, person.y + bob, person.z);
      m.compose(p, q, s);
      this.peopleMesh.setMatrixAt(k, m);
      this.peopleMesh.setColorAt(k, CLOTHES[person.color]);
      k++;
    }
    this.peopleMesh.count = k;
    this.peopleMesh.instanceMatrix.needsUpdate = true;
    if (this.peopleMesh.instanceColor) this.peopleMesh.instanceColor.needsUpdate = true;

    k = 0;
    for (const b of this.buffalo) {
      e.set(Math.sin(b.bob) * 0.03, b.heading, 0);
      q.setFromEuler(e);
      s.set(1, 1, 1);
      p.set(b.x, b.y, b.z);
      m.compose(p, q, s);
      this.buffaloMesh.setMatrixAt(k++, m);
    }
    this.buffaloMesh.count = k;
    this.buffaloMesh.instanceMatrix.needsUpdate = true;
  }

  serialize() {
    return this.houses.map((h) => [+h.x.toFixed(2), +h.z.toFixed(2), +h.rot.toFixed(2), +h.scale.toFixed(2), h.roof]);
  }

  load(list, time) {
    for (const [x, z, rot, scale, roof] of list) {
      const y = this.ground(x, z);
      const h = { x, z, y, baseY: y, rot, scale, roof, s: 1, sv: 0, smoke: Math.random() * 3, hamlet: -1, born: time };
      this.houses.push(h);
      this._spawnPerson(h);
    }
    this._rehamlet();
  }
}

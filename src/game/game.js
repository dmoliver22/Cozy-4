// Ties the simulation, physics, rendering and gameplay together.
import * as THREE from 'three';
import { N, DX, HALF } from '../sim/constants.js';
import { generateMountain } from '../sim/mountain.js';
import { WaterSim } from '../sim/water.js';
import { Ecology } from '../sim/ecology.js';
import { Wind } from '../sim/wind.js';
import { Physics } from '../physics/physics.js';
import { shared, patchMaterial } from '../render/shaders.js';
import { Sky } from '../render/sky.js';
import { TerrainView } from '../render/terrainView.js';
import { WaterView } from '../render/waterView.js';
import { Atmosphere } from '../render/atmosphere.js';
import { Particles, P_SPRAY, P_DUST, P_RAIN, P_PETAL, P_FIREFLY, P_MIST, P_SPARK } from '../render/particles.js';
import { Cursor } from '../render/cursor.js';
import { clodGeometry, seedGeometry, petalGeometry } from '../render/models.js';
import { Crops, RICE, TEA, FLOWER } from './crops.js';
import { Village } from './village.js';
import { Trees, Birds } from './nature.js';
import { Goals, wateredTerraces, hamletsJoined } from './goals.js';
import { Tools } from './tools.js';

export const TIME_SCALE = 3; // the water runs a little faster than life

const PETAL_COLORS = ['#f6b8c8', '#fbe3e8', '#ffffff', '#f7d679', '#f2a48a'].map((c) => new THREE.Color(c));
const LEAF_COLORS = ['#7aa557', '#9bbd5c', '#c9b458', '#6f9a4e'].map((c) => new THREE.Color(c));

export class Game {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.time = 0;
    this.paused = false;
    const m = generateMountain(opts.seed ?? 7);
    this.mountain = m;
    this.terrain = m.terrain;
    this.water = new WaterSim(this.terrain);
    this.water.d.set(m.water0);
    for (let c = 0; c < this.terrain.n; c++) if (m.water0[c] > 0.02) this.water.moist[c] = 1;
    for (const s of m.springs) this.water.addSpring(s.x, s.z, s.rate, s.name);
    this.eco = new Ecology(this.terrain, this.water);
    this.wind = new Wind();
    this.physics = new Physics(this.terrain, this.water, TIME_SCALE);
    this.physics.wind = this.wind;
    this.audio = null;
    this.ui = null;

    this.sky = new Sky(scene);
    this.terrainView = new TerrainView(scene, this.terrain, this.water, this.eco, opts.meshDetail ?? 2);
    this.waterView = new WaterView(scene, this.terrain, this.water, this.terrainView);
    this.atmo = new Atmosphere(scene, this.terrain);
    this.particles = new Particles(scene, 5000, false);
    this.glows = new Particles(scene, 700, true);
    this.cursor = new Cursor(scene, (x, z) => this.groundAt(x, z));
    this.crops = new Crops(scene, this.terrain, this.water, (x, z) => this.groundAt(x, z));
    this.trees = new Trees(scene, m.trees, (x, z) => this.groundAt(x, z), this.particles);
    this.village = new Village(scene, this.terrain, this.water, this.crops, this.particles);
    this.village.trees = this.trees;
    this.birds = new Birds(scene);
    this.goals = new Goals();
    this.tools = new Tools(this);

    // the wind-spring field, uploaded for vertex shaders
    this.swayData = new Uint16Array(this.wind.G * this.wind.G * 4);
    this.swayTex = new THREE.DataTexture(this.swayData, this.wind.G, this.wind.G, THREE.RGBAFormat, THREE.HalfFloatType);
    this.swayTex.magFilter = THREE.LinearFilter;
    this.swayTex.minFilter = THREE.LinearFilter;
    shared.uSway.value = this.swayTex;
    shared.uWorldSize.value = (N - 1) * DX;

    // rigid bodies
    const bodyMat = (key) => patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), { key });
    this.bodyMeshes = {
      clod: new THREE.InstancedMesh(clodGeometry(), bodyMat('clod'), 90),
      seed: new THREE.InstancedMesh(seedGeometry(), bodyMat('seed'), 220),
      petal: new THREE.InstancedMesh(petalGeometry(), bodyMat('petal'), 140),
    };
    for (const mesh of Object.values(this.bodyMeshes)) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
    }
    this.bodyMeshes.petal.setColorAt(0, new THREE.Color(1, 1, 1));

    this._wireEvents();

    this.falls = [];
    this.fallTimer = 0;
    this.goalTimer = 0;
    this.attrTimer = 0;
    this.heightTimer = 0;
    this.thermalTimer = 0;
    this.waterAcc = 0;
    this.weather = { rain: 0, target: 0, next: 200 + Math.random() * 200, until: 0 };
    this.fallEnergy = 0;
    this.stats = { watered: 0, wateredList: [] };
    this.hintShown = false;
    this.firstCascade = false;
    this.lastStrokeAt = -100;
    this.celebrating = 0;

    // let the streams run for a while so the mountain starts alive
    for (let k = 0; k < 700; k++) this.water.step();
    this.terrainView.updateAttributes();
  }

  _wireEvents() {
    const ph = this.physics;
    ph.onSettle = (e) => {
      if (e.kind === 'seed') {
        const b = e.body;
        const v = b.linvel();
        const slow = Math.hypot(v.x, v.y, v.z) < 0.5;
        if (e.still > 0.22 || (e.wet && e.wetTime > 0.7 && slow)) {
          const p = b.translation();
          const id = this.crops.plant(e.data.seed, p.x, p.z);
          if (id) {
            if (e.data.tag) e.data.tag.ids.push(id);
            this.glows.spawn(P_SPARK, p.x, p.y + 0.15, p.z, 0, 0.6, 0, 0.7, 0.35, 0.75, 0.95, 0.5, 0.8);
            this.audio?.sprout(e.data.seed);
          }
          return true;
        }
        return false;
      }
      if (e.kind === 'clod') {
        if (e.still > 1.1 || (e.wet && e.wetTime > 2.5)) {
          const p = e.body.translation();
          const c = this.cellAt(p.x, p.z);
          if (c >= 0) {
            if (this.terrain.terrace[c] || this.water.d[c] > 0.05) {
              this.water.fert[c] = Math.min(1, this.water.fert[c] + 0.15);
            } else {
              this.terrain.depositSoil(p.x, p.z, 0.05);
            }
          }
          return true;
        }
        return false;
      }
      return false;
    };
    ph.onSplash = (x, y, z, r, speed, e) => {
      const n = Math.min(26, Math.floor(speed * r * 9) + 3);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = Math.random() * speed * 0.25;
        this.particles.spawn(P_SPRAY, x, y + 0.05, z, Math.cos(a) * s, 1.5 + Math.random() * speed * 0.45, Math.sin(a) * s, 0.9, 0.16 + Math.random() * 0.1, 0.93, 0.97, 1.0, 0.75);
      }
      this.audio?.splash(r, speed);
    };
    ph.onImpact = (x, y, z, r, speed, e) => {
      if (e.kind === 'clod') {
        for (let i = 0; i < 5; i++) {
          this.particles.spawn(P_DUST, x, y, z, (Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2, 0.9 + Math.random() * 0.5, 0.3 + Math.random() * 0.3, 0.72, 0.6, 0.47, 0.5, 0.5);
        }
      }
      this.audio?.thud(r, speed, e.kind);
    };
    this.crops.onBloom = (x, y, z, color) => {
      if (this.physics.count('petal') > 110) return;
      const w = this.wind.at(x, z);
      this.physics.add('petal', x, y, z, {
        r: 0.13,
        density: 0.3,
        damping: 2.2,
        angularDamping: 1,
        vel: { x: w.x * 0.8, y: 0.4, z: w.z * 0.8 },
        life: 45,
        data: { color },
      });
    };
    this.village.onHouse = (h) => {
      this.audio?.house();
      this.ui?.pulse('hamlet');
    };
    this.village.onHarvest = (x, y, z, n) => {
      for (let i = 0; i < 6; i++) {
        this.glows.spawn(P_SPARK, x + (Math.random() - 0.5), y + 0.6, z + (Math.random() - 0.5), 0, 0.8, 0, 0.9, 0.3, 1.0, 0.85, 0.4, 0.8);
      }
      this.audio?.harvest();
    };
    this.goals.onComplete = (g) => {
      this.audio?.goal();
      this.ui?.goalDone(g);
    };
    this.goals.onTier = (tier) => {
      this.celebrate();
      this.ui?.tierDone(tier);
    };
  }

  // ---------------------------------------------------------------- queries

  /** Height of the land as drawn (smooth terrace edges). */
  groundAt(x, z) {
    return this.terrainView ? this.terrainView.groundAt(x, z) : this.coarseGroundAt(x, z);
  }

  coarseGroundAt(x, z) {
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

  surfaceAt(x, z) {
    const gx = Math.round((x + HALF) / DX);
    const gz = Math.round((z + HALF) / DX);
    if (gx < 0 || gz < 0 || gx >= N || gz >= N) return -2.4;
    return this.groundAt(x, z) + this.water.d[gx + gz * N];
  }

  cellAt(x, z) {
    const i = Math.round((x + HALF) / DX);
    const j = Math.round((z + HALF) / DX);
    if (i < 0 || j < 0 || i >= N || j >= N) return -1;
    return i + j * N;
  }

  /** Ray-march the heightfield. */
  pick(ray) {
    const o = ray.origin;
    const d = ray.direction;
    let t = 0;
    // jump to the top of the terrain volume
    if (o.y > 60 && d.y < 0) t = (o.y - 60) / -d.y;
    let prevT = t;
    let prevAbove = true;
    for (let k = 0; k < 1500; k++) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      if (Math.abs(x) > HALF || Math.abs(z) > HALF) {
        if ((d.y >= 0 && y > 60) || t > 1500) return null;
      } else {
        const g = this.groundAt(x, z);
        if (y <= g) {
          if (!prevAbove) return null;
          // refine
          let lo = prevT;
          let hi = t;
          for (let r = 0; r < 18; r++) {
            const mid = (lo + hi) / 2;
            const yy = o.y + d.y * mid;
            if (yy <= this.groundAt(o.x + d.x * mid, o.z + d.z * mid)) hi = mid;
            else lo = mid;
          }
          return { x: o.x + d.x * hi, y: o.y + d.y * hi, z: o.z + d.z * hi };
        }
      }
      prevT = t;
      t += 0.35;
      if (o.y + d.y * t < -10) return null;
    }
    return null;
  }

  // ---------------------------------------------------------------- events

  onSculpt(tool, hit, res, stroke) {
    this.lastStrokeAt = this.time;
    if (tool === 'terrace' || tool === 'channel') {
      stroke.spoil = (stroke.spoil || 0) + res.cut * 0.15;
      let spawned = 0;
      while (stroke.spoil > 0.3 && spawned < 3) {
        stroke.spoil -= 0.3;
        spawned++;
        this._spawnClod(hit, stroke);
      }
      const dust = Math.min(6, Math.floor(res.cut * 0.8));
      for (let i = 0; i < dust; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * stroke.R;
        const x = hit.x + Math.cos(a) * r;
        const z = hit.z + Math.sin(a) * r;
        this.particles.spawn(P_DUST, x, this.groundAt(x, z) + 0.2, z, (Math.random() - 0.5) * 1.5, 0.8 + Math.random(), (Math.random() - 0.5) * 1.5, 1 + Math.random(), 0.4 + Math.random() * 0.4, 0.78, 0.66, 0.52, 0.4, 0.6);
      }
    }
    this.audio?.carve(Math.min(1, (res.cut + res.fill) * 0.15), tool);
  }

  _spawnClod(hit, stroke) {
    // tumble from the brush edge, downhill
    const a = Math.random() * Math.PI * 2;
    const r = stroke.R * (0.6 + Math.random() * 0.5);
    const x = hit.x + Math.cos(a) * r;
    const z = hit.z + Math.sin(a) * r;
    const gx = this.groundAt(x + 0.6, z) - this.groundAt(x - 0.6, z);
    const gz = this.groundAt(x, z + 0.6) - this.groundAt(x, z - 0.6);
    const len = Math.hypot(gx, gz) || 1;
    const y = Math.max(this.groundAt(x, z), stroke.level || -99) + 0.6;
    const s = 1.5 + Math.random() * 2;
    this.physics.add('clod', x, y, z, {
      r: 0.18 + Math.random() * 0.16,
      density: 1.7,
      vel: { x: (-gx / len) * s + Math.cos(a) * 0.8, y: 1.5 + Math.random() * 1.5, z: (-gz / len) * s + Math.sin(a) * 0.8 },
      life: 14,
      restitution: 0.15,
    });
    if (this.physics.count('clod') > 80) {
      const old = this.physics.oldest('clod');
      if (old) this.physics.dissolve(old);
    }
  }

  celebrate() {
    this.celebrating = 12;
    this.wind.gust1();
    this.birds.excite = 1;
    this.audio?.celebrate();
    // a gust of blossom over the whole mountain
    for (let i = 0; i < 420; i++) {
      const x = (Math.random() - 0.5) * 140;
      const z = (Math.random() - 0.5) * 140;
      const c = PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)];
      this.particles.spawn(P_PETAL, x, this.groundAt(x, z) + 6 + Math.random() * 14, z, this.wind.vec.x * 3, Math.random(), this.wind.vec.z * 3, 7 + Math.random() * 5, 0.3 + Math.random() * 0.15, c.r, c.g, c.b, 0.95);
    }
    // and some real petals that land and drift on the water
    for (let i = 0; i < 50; i++) {
      const terr = this.stats.wateredList;
      let x = (Math.random() - 0.5) * 60;
      let z = (Math.random() - 0.5) * 60 + 15;
      if (terr.length) {
        const tid = terr[Math.floor(Math.random() * terr.length)];
        for (let tries = 0; tries < 40; tries++) {
          const c = Math.floor(Math.random() * this.terrain.n);
          if (this.terrain.terrace[c] === tid) {
            x = (c % N) * DX - HALF;
            z = Math.floor(c / N) * DX - HALF;
            break;
          }
        }
      }
      const c = PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)];
      this.physics.add('petal', x, this.groundAt(x, z) + 5 + Math.random() * 4, z, {
        r: 0.13,
        density: 0.3,
        damping: 2.2,
        angularDamping: 1,
        vel: { x: this.wind.vec.x, y: 0, z: this.wind.vec.z },
        life: 50,
        data: { color: c },
      });
    }
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    this.time += dt;
    shared.uTime.value = this.time;
    const t = this.terrain;

    this.sky.update(dt);
    this._weather(dt);
    this.wind.update(dt);
    this._uploadSway();

    this.tools.update(dt);
    t.animate(dt);
    if (t.disturbed.length) {
      const cells = t.disturbed;
      t.disturbed = [];
      const gone = this.crops.uproot(cells);
      for (const p of gone.slice(0, 40)) {
        for (let i = 0; i < 2; i++) {
          this.particles.spawn(P_PETAL, p.x, p.y + 0.3, p.z, (Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2, 2, 0.22, 0.5, 0.7, 0.32, 0.9);
        }
      }
      this.trees.clearCells(cells, (x, z) => this.cellAt(x, z));
      this.village.removeHousesOn(cells);
    }

    // water on its own clock
    this.waterAcc += dt * TIME_SCALE;
    const wdt = this.water.p.dt;
    let steps = 0;
    while (this.waterAcc >= wdt && steps < 8) {
      this.water.step();
      this.waterAcc -= wdt;
      steps++;
    }
    if (steps === 8) this.waterAcc = 0;
    this.thermalTimer += dt;
    if (this.thermalTimer > 0.5) {
      this.thermalTimer = 0;
      t.thermal();
    }

    // physics follows the land
    if (!t.dirtyPhys.empty && this.physics.sinceRebuild > 0.12) {
      t.dirtyPhys.reset();
      this.physics.rebuildGround();
    }
    this.physics.step(dt);

    this.eco.update(dt, 0.12);
    this.crops.update(dt);
    this.village.update(dt, { time: this.time, night: shared.uNight.value, hour: this.sky.hour });
    this.trees.update();
    this.birds.update(dt, (x, z) => this.groundAt(x, z), this.wind.vec);

    this._fallsAndSpray(dt);
    this._ambient(dt);

    const env = { windVec: this.wind.at(0, 0), t: this.time, ground: (x, z) => this.surfaceAt(x, z) };
    this.particles.update(dt, env);
    this.glows.update(dt, env);

    this.goalTimer += dt;
    if (this.goalTimer > 0.5) {
      this.goalTimer = 0;
      this._checkGoals();
    }
    this.celebrating = Math.max(0, this.celebrating - dt);

    // views (slow erosion is folded in a few times a second)
    this.erodeTimer = (this.erodeTimer || 0) + dt;
    if (!t.dirtyErode.empty && this.erodeTimer > 2.5 && !(this.terrainView.bands && this.terrainView.bands.length)) {
      this.erodeTimer = 0;
      const e = t.dirtyErode.take();
      this.terrainView.queue(e.x0, e.z0, e.x1, e.z1);
      this.crops.refreshHeights(e.x0, e.z0, e.x1, e.z1);
    }
    const hadMeshDirty = !t.dirtyMesh.empty;
    if (hadMeshDirty) {
      const b = { x0: t.dirtyMesh.x0, z0: t.dirtyMesh.z0, x1: t.dirtyMesh.x1, z1: t.dirtyMesh.z1 };
      this.terrainView.update();
      this.crops.refreshHeights(b.x0, b.z0, b.x1, b.z1);
      if (t.sculptVersion !== this.lastSculpt) {
        this.lastSculpt = t.sculptVersion;
        this.trees.refreshHeights();
        this.heightDirty = true;
      }
    }
    this.attrTimer += dt;
    if (this.attrTimer > 0.25) {
      this.attrTimer = 0;
      this.terrainView.updateAttributes();
    }
    this.heightTimer += dt;
    if (this.heightDirty && this.heightTimer > 0.6) {
      this.heightTimer = 0;
      this.heightDirty = false;
      this.atmo.updateHeight();
    }
    this.waterView.update(this.falls);
    this.waterView.uniforms.uRain.value = this.weather.rain;
    this.atmo.update(dt, this.wind.vec, 1 + this.weather.rain * 0.6);
    this._writeBodies();
    this.cursor.animate(this.time);

    this.audio?.update(dt, {
      flow: this.water.flowEnergy(),
      falls: this.fallEnergy,
      rain: this.weather.rain,
      night: shared.uNight.value,
      hour: this.sky.hour,
      wind: this.wind.strength,
      houses: this.village.count,
    });
  }

  _uploadSway() {
    const w = this.wind;
    const d = this.swayData;
    const toH = THREE.DataUtils.toHalfFloat;
    for (let k = 0; k < w.G * w.G; k++) {
      d[k * 4] = toH(w.dx[k]);
      d[k * 4 + 1] = toH(w.dz[k]);
    }
    this.swayTex.needsUpdate = true;
  }

  _weather(dt) {
    const w = this.weather;
    w.next -= dt;
    if (w.next <= 0 && w.target === 0) {
      w.target = 1;
      w.until = 40 + Math.random() * 35;
      w.next = 280 + Math.random() * 260;
    }
    if (w.target === 1) {
      w.until -= dt;
      if (w.until <= 0) w.target = 0;
    }
    w.rain += (w.target - w.rain) * Math.min(1, dt * 0.15);
    if (w.rain < 0.002) w.rain = 0;
    this.water.rain = w.rain * 0.0022;
    if (w.rain > 0) {
      // grey the light while it rains
      const grey = new THREE.Color('#b9c2c8');
      const k = w.rain * 0.55;
      shared.uHorizon.value.lerp(grey, k);
      shared.uZenith.value.lerp(new THREE.Color('#9eaab4'), k);
      shared.uFogColor.value.lerp(grey, k * 0.8);
      this.sky.sun.intensity *= 1 - w.rain * 0.65;
      // raindrops around the view
      const n = Math.floor(w.rain * 90 * dt * 60);
      const cx = this.camTarget ? this.camTarget.x : 0;
      const cz = this.camTarget ? this.camTarget.z : 0;
      for (let i = 0; i < n; i++) {
        const x = cx + (Math.random() - 0.5) * 120;
        const z = cz + (Math.random() - 0.5) * 120;
        this.particles.spawn(P_RAIN, x, 45 + Math.random() * 10, z, this.wind.vec.x * 2, -18, this.wind.vec.z * 2, 3, 0.09, 0.82, 0.88, 0.95, 0.45);
      }
    }
  }

  forceRain(on) {
    this.weather.target = on ? 1 : 0;
    this.weather.until = 60;
  }

  _fallsAndSpray(dt) {
    this.fallTimer += dt;
    if (this.fallTimer > 0.12) {
      this.fallTimer = 0;
      this.water.findFalls(this.falls, 220);
    }
    const f = this.falls;
    let energy = 0;
    const u = this.water.u;
    const v = this.water.v;
    for (let k = 0; k < f.length; k += 4) {
      const c = f[k];
      const n = f[k + 1];
      const flux = f[k + 2];
      const drop = f[k + 3];
      energy += flux * drop;
      const p = flux * drop * dt * 1.6;
      if (Math.random() > p) continue;
      const i = c % N;
      const j = (c - i) / N;
      const ni = n % N;
      const nj = (n - ni) / N;
      const x = i * DX - HALF + (ni - i) * 0.5 + (Math.random() - 0.5) * 0.6;
      const z = j * DX - HALF + (nj - j) * 0.5 + (Math.random() - 0.5) * 0.6;
      const y = this.terrain.H[c] + this.water.d[c];
      const sp = TIME_SCALE * 0.35;
      this.particles.spawn(P_SPRAY, x, y, z, (ni - i) * 1.4 + u[c] * sp + (Math.random() - 0.5), 0.6 + Math.random() * 1.2, (nj - j) * 1.4 + v[c] * sp + (Math.random() - 0.5), 0.8 + Math.random() * 0.4, 0.14 + Math.random() * 0.14, 0.95, 0.98, 1.0, 0.7);
      if (drop > 1.6 && Math.random() < 0.15) {
        const by = this.terrain.H[n] + 0.4;
        this.particles.spawn(P_MIST, x + (ni - i) * drop * 0.5, by, z + (nj - j) * drop * 0.5, 0, 0.3, 0, 2.5, 0.9, 0.95, 0.97, 1.0, 0.18, 0.6);
      }
    }
    this.fallEnergy = energy;
  }

  _ambient(dt) {
    const night = shared.uNight.value;
    // gusts shake leaves loose: real bodies that flutter down and drift on the water
    if (this.wind.strength > 0.95 && this.physics.count('petal') < 90 && Math.random() < dt * (this.wind.strength - 0.8) * 1.6) {
      const alive = this.trees.list.filter((t) => t.alive);
      if (alive.length) {
        const t = alive[Math.floor(Math.random() * alive.length)];
        const w = this.wind.at(t.x, t.z);
        const c = LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)];
        this.physics.add('petal', t.x + (Math.random() - 0.5), this.groundAt(t.x, t.z) + 2.2 * t.s, t.z + (Math.random() - 0.5), {
          r: 0.16,
          density: 0.35,
          damping: 2.4,
          angularDamping: 0.8,
          vel: { x: w.x * 1.5, y: 0.2, z: w.z * 1.5 },
          life: 40,
          data: { color: c },
        });
      }
    }
    // fireflies over watered paddies at night
    if (night > 0.4 && this.glows.count < 260 && this.stats.wateredList.length && Math.random() < dt * 14) {
      const tid = this.stats.wateredList[Math.floor(Math.random() * this.stats.wateredList.length)];
      for (let tries = 0; tries < 30; tries++) {
        const c = Math.floor(Math.random() * this.terrain.n);
        if (this.terrain.terrace[c] !== tid) continue;
        const x = (c % N) * DX - HALF;
        const z = Math.floor(c / N) * DX - HALF;
        this.glows.spawn(P_FIREFLY, x, this.terrain.H[c] + 0.6 + Math.random(), z, 0, 0, 0, 8 + Math.random() * 6, 0.32, 0.9, 1.0, 0.45, 0.9);
        break;
      }
    }
    // mist wisps drifting over the flanks
    if (this.particles.count < 4800 && Math.random() < dt * 0.9) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 50;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = Math.max(this.groundAt(x, z), 2) + 2 + Math.random() * 7;
      this.particles.spawn(P_MIST, x, y, z, this.wind.vec.x * 0.8, 0, this.wind.vec.z * 0.8, 25 + Math.random() * 15, 12 + Math.random() * 14, 0.97, 0.98, 1.0, 0.07, 0.25);
    }
  }

  _checkGoals() {
    const wt = wateredTerraces(this.terrain, this.water);
    this.stats.watered = wt.count;
    this.stats.wateredList = wt.list;
    this.goals.set('cascade', wt.count);
    this.goals.set('rice', this.crops.stats.riceMature);
    this.goals.set('hamlet', this.village.largestHamlet());
    this.goals.set('tea', this.crops.stats.teaMature);
    this.goals.set('flowers', this.crops.stats.flowersMature);
    if (this.goals.tier >= 1 && this.village.hamlets.length >= 2) {
      if (hamletsJoined(this.terrain, this.village.hamlets, (x, z) => this.village.cell(x, z))) this.goals.set('join', 1);
    }
    if (!this.firstCascade && wt.count >= 3) {
      this.firstCascade = true;
      this.ui?.firstCascade();
    }
    this.ui?.updateGoals();
  }

  _writeBodies() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const kind of ['clod', 'seed', 'petal']) {
      const mesh = this.bodyMeshes[kind];
      let k = 0;
      this.physics.forEach(kind, (pos, quat, scale, e) => {
        if (k >= mesh.instanceMatrix.count) return;
        const sc = e.r / (kind === 'clod' ? 0.28 : kind === 'seed' ? 0.09 : 0.16) * scale;
        p.set(pos.x, pos.y, pos.z);
        q.set(quat.x, quat.y, quat.z, quat.w);
        s.set(sc, sc, sc);
        m.compose(p, q, s);
        mesh.setMatrixAt(k, m);
        if (kind === 'petal' && e.data?.color) mesh.setColorAt(k, e.data.color);
        k++;
      });
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

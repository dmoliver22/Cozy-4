// A small pure-JS rigid-body integrator with the same interface as Physics,
// used only when the Rapier WebAssembly module can't start (for example a page
// sandbox that forbids compiling WebAssembly). Bodies are spheres colliding
// with the live heightfield: gravity, restitution, Coulomb-ish friction and
// rolling, plus the same coupling to the water as the Rapier path (Archimedes
// buoyancy, drag toward the current, splash ripples) and wind drag on petals.
// It has no joints, so rope bridges and water wheels are skipped.
import { N, DX, HALF } from '../sim/constants.js';
import { GRAVITY } from './physics.js';

const RHO_WATER = 1;
let nextId = 1;

function makeBody(e) {
  return {
    translation: () => e.pos,
    rotation: () => e.quat,
    linvel: () => e.vel,
    angvel: () => e.spin,
    mass: () => e.mass,
    isSleeping: () => e.still > 0.5,
    wakeUp: () => {
      e.still = 0;
    },
    setTranslation: (p) => {
      e.pos.x = p.x;
      e.pos.y = p.y;
      e.pos.z = p.z;
    },
    setRotation: (q) => {
      e.quat.x = q.x;
      e.quat.y = q.y;
      e.quat.z = q.z;
      e.quat.w = q.w;
    },
    resetForces: () => {},
    addForce: (f) => {
      e.force.x += f.x;
      e.force.y += f.y;
      e.force.z += f.z;
    },
  };
}

export class FallbackPhysics {
  constructor(terrain, water, timeScale = 1) {
    this.terrain = terrain;
    this.water = water;
    this.waterTimeScale = timeScale;
    this.supportsJoints = false;
    this.world = null;
    this.entries = [];
    this.accum = 0;
    this.sinceRebuild = 0;
    this._ws = { depth: 0, ground: 0, surface: 0, u: 0, v: 0 };
    this.onSplash = null;
    this.onImpact = null;
    this.onSettle = null;
    this.extraForces = null;
    this.wind = null;
  }

  rebuildGround() {
    // heights are sampled live; just lift anything the land rose through
    for (const e of this.entries) {
      if (!e.body) continue;
      const g = this.groundAt(e.pos.x, e.pos.z);
      if (e.pos.y < g + e.r * 0.6) e.pos.y = g + e.r + 0.02;
      e.still = 0;
    }
    this.sinceRebuild = 0;
  }

  groundAt(x, z) {
    let gx = Math.min(N - 1.001, Math.max(0, (x + HALF) / DX));
    let gz = Math.min(N - 1.001, Math.max(0, (z + HALF) / DX));
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const H = this.terrain.H;
    const c = i + j * N;
    const a = H[c] + (H[c + 1] - H[c]) * fx;
    const b = H[c + N] + (H[c + N + 1] - H[c + N]) * fx;
    return a + (b - a) * fz;
  }

  add(kind, x, y, z, opts = {}) {
    const r = opts.r ?? 0.25;
    const density = opts.density ?? 1.5;
    const v = opts.vel ?? { x: 0, y: 0, z: 0 };
    const flat = kind === 'petal' || kind === 'leaf';
    const volume = flat ? 8 * r * r * r * 0.12 : (4 / 3) * Math.PI * r * r * r;
    const e = {
      id: nextId++,
      kind,
      body: null,
      r,
      volume,
      density,
      mass: density * volume,
      age: 0,
      life: opts.life ?? 60,
      still: 0,
      wet: false,
      wetTime: 0,
      lastVy: v.y,
      scale: 1,
      dissolving: -1,
      data: opts.data ?? null,
      pos: { x, y, z },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: v.x, y: v.y, z: v.z },
      spin: opts.spin ? { ...opts.spin } : { x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 },
      force: { x: 0, y: 0, z: 0 },
      damping: opts.damping ?? 0.05,
      angularDamping: opts.angularDamping ?? 0.4,
      restitution: opts.restitution ?? 0.2,
      friction: opts.friction ?? 0.9,
    };
    e.body = makeBody(e);
    this.entries.push(e);
    return e;
  }

  remove(e) {
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
    e.body = null;
  }

  count(kind) {
    let n = 0;
    for (const e of this.entries) if (e.kind === kind && e.dissolving < 0) n++;
    return n;
  }

  oldest(kind) {
    let best = null;
    for (const e of this.entries) if (e.kind === kind && e.dissolving < 0 && (!best || e.age > best.age)) best = e;
    return best;
  }

  dissolve(e) {
    if (e.dissolving >= 0) return;
    e.dissolving = 0;
    e.body = null;
  }

  step(dt) {
    this.accum += Math.min(dt, 0.1);
    const h = 1 / 60;
    let steps = 0;
    while (this.accum >= h && steps < 3) {
      this._integrate(h);
      this.accum -= h;
      steps++;
    }
    if (steps === 3) this.accum = 0;
    for (let k = this.entries.length - 1; k >= 0; k--) {
      const e = this.entries[k];
      if (e.dissolving >= 0) {
        e.dissolving += dt;
        e.scale = Math.max(0, 1 - e.dissolving / 0.7);
        if (e.dissolving >= 0.7) this.entries.splice(k, 1);
      }
    }
    this.sinceRebuild += dt;
  }

  _integrate(h) {
    const ws = this._ws;
    const ts = this.waterTimeScale;
    for (let k = this.entries.length - 1; k >= 0; k--) {
      const e = this.entries[k];
      if (!e.body) continue;
      const p = e.pos;
      const v = e.vel;
      const m = e.mass;
      let fx = 0;
      let fy = -GRAVITY * m;
      let fz = 0;
      this.water.sample(p.x, p.z, ws);
      const bottom = p.y - e.r;
      if (ws.depth > 0.012 && bottom < ws.surface) {
        const sub = Math.min(1, (ws.surface - bottom) / (2 * e.r));
        fy += RHO_WATER * GRAVITY * e.volume * sub;
        const kd = (e.kind === 'petal' || e.kind === 'leaf' ? 4.5 : 2.2) * sub * m;
        fx += (ws.u * ts - v.x) * kd;
        fz += (ws.v * ts - v.z) * kd;
        fy += -v.y * kd * 0.8;
        if (!e.wet) {
          e.wet = true;
          const speed = Math.hypot(v.x, v.y, v.z);
          if (speed > 2.2) {
            if (this.onSplash) this.onSplash(p.x, ws.surface, p.z, e.r, speed, e);
            this.water.splash(p.x, p.z, m * speed * 2);
          }
        }
        e.wetTime += h;
      } else {
        e.wet = false;
        e.wetTime = 0;
        if (this.wind && (e.kind === 'petal' || e.kind === 'leaf')) {
          const w = this.wind.at(p.x, p.z);
          const kw = 1.8 * m;
          fx += (w.x * 2.2 - v.x) * kw;
          fz += (w.z * 2.2 - v.z) * kw;
          fy += Math.sin(e.age * 7 + e.id) * m * 3;
        }
      }
      fx += e.force.x;
      fy += e.force.y;
      fz += e.force.z;
      e.force.x = e.force.y = e.force.z = 0;
      const damp = Math.max(0, 1 - e.damping * h);
      v.x = (v.x + (fx / m) * h) * damp;
      v.y = (v.y + (fy / m) * h) * damp;
      v.z = (v.z + (fz / m) * h) * damp;
      p.x += v.x * h;
      p.y += v.y * h;
      p.z += v.z * h;

      // contact with the land
      const g = this.groundAt(p.x, p.z);
      const vyBefore = v.y;
      if (p.y - e.r < g) {
        const ex = 0.5;
        let nx = this.groundAt(p.x - ex, p.z) - this.groundAt(p.x + ex, p.z);
        let ny = 2 * ex;
        let nz = this.groundAt(p.x, p.z - ex) - this.groundAt(p.x, p.z + ex);
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        p.y = g + e.r;
        const vn = v.x * nx + v.y * ny + v.z * nz;
        if (vn < 0) {
          v.x -= (1 + e.restitution) * vn * nx;
          v.y -= (1 + e.restitution) * vn * ny;
          v.z -= (1 + e.restitution) * vn * nz;
          // friction removes tangential speed in proportion to the contact impulse;
          // round bodies keep rolling, grains and flat petals grip
          const vtx = v.x - (v.x * nx + v.y * ny + v.z * nz) * nx;
          const vty = v.y - (v.x * nx + v.y * ny + v.z * nz) * ny;
          const vtz = v.z - (v.x * nx + v.y * ny + v.z * nz) * nz;
          const vt = Math.hypot(vtx, vty, vtz);
          if (vt > 1e-5) {
            const grip = e.kind === 'clod' ? 0.35 : 1;
            const loss = Math.min(vt, e.friction * grip * Math.abs(vn) * 1.2 + e.friction * grip * 6 * h);
            v.x -= (vtx / vt) * loss;
            v.y -= (vty / vt) * loss;
            v.z -= (vtz / vt) * loss;
            // rolling: spin about (n x vt)
            e.spin.x = ((ny * vtz - nz * vty) / e.r) * 0.8;
            e.spin.y = ((nz * vtx - nx * vtz) / e.r) * 0.8;
            e.spin.z = ((nx * vty - ny * vtx) / e.r) * 0.8;
          }
        }
        if (e.lastVy < -3.5 && v.y - vyBefore > 3 && !e.wet && this.onImpact) this.onImpact(p.x, p.y, p.z, e.r, -e.lastVy, e);
      }
      e.lastVy = v.y;

      // integrate orientation from the spin
      const s = e.spin;
      const ad = Math.max(0, 1 - e.angularDamping * h);
      s.x *= ad;
      s.y *= ad;
      s.z *= ad;
      const q = e.quat;
      const hx = 0.5 * h * s.x;
      const hy = 0.5 * h * s.y;
      const hz = 0.5 * h * s.z;
      const qx = q.x + hx * q.w + hy * q.z - hz * q.y;
      const qy = q.y + hy * q.w + hz * q.x - hx * q.z;
      const qz = q.z + hz * q.w + hx * q.y - hy * q.x;
      const qw = q.w - hx * q.x - hy * q.y - hz * q.z;
      const ql = Math.hypot(qx, qy, qz, qw) || 1;
      q.x = qx / ql;
      q.y = qy / ql;
      q.z = qz / ql;
      q.w = qw / ql;

      e.age += h;
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < 0.22) e.still += h;
      else e.still = 0;
      if (p.y < -12 || Math.abs(p.x) > HALF + 4 || Math.abs(p.z) > HALF + 4) {
        this.remove(e);
        continue;
      }
      if (this.onSettle && (e.age > e.life || this.onSettle(e) === true)) this.dissolve(e);
    }
  }

  forEach(kind, fn) {
    for (const e of this.entries) if (e.kind === kind) fn(e.pos, e.quat, e.scale, e);
  }
}

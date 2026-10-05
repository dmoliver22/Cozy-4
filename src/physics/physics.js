// Rigid-body physics with Rapier. The sculpted heightfield is mirrored into a
// Rapier heightfield collider (rebuilt whenever the land changes), and every
// body is coupled to the shallow-water simulation: Archimedes buoyancy from
// the submerged volume, drag toward the local current (so petals ride the
// flow over bunds and down waterfalls), and splash impulses that push water
// outward as ripples.
import RAPIER from '@dimforge/rapier3d-compat';
import { N, DX, HALF } from '../sim/constants.js';

export const GRAVITY = 18; // a little stronger than Earth: things feel miniature
const RHO_WATER = 1;

export async function initRapier() {
  await RAPIER.init();
}

let nextId = 1;

export class Physics {
  constructor(terrain, water, timeScale = 1) {
    this.terrain = terrain;
    this.water = water;
    this.waterTimeScale = timeScale;
    this.supportsJoints = true;
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = 1 / 60;
    this.world.numSolverIterations = 6;
    this.hf = new Float32Array(N * N);
    this.ground = null;
    this.entries = [];
    this.accum = 0;
    this.sinceRebuild = 0;
    this._ws = { depth: 0, ground: 0, surface: 0, u: 0, v: 0 };
    this.onSplash = null; // (x, y, z, size, speed)
    this.onImpact = null; // (x, y, z, size, speed, kind)
    this.onSettle = null; // (entry) -> true to remove
    this.rebuildGround();
  }

  rebuildGround() {
    const H = this.terrain.H;
    const hf = this.hf;
    // Rapier wants a column-major matrix: rows along z, columns along x
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) hf[j + i * N] = H[i + j * N];
    }
    if (this.ground) this.world.removeCollider(this.ground, false);
    const desc = RAPIER.ColliderDesc.heightfield(N - 1, N - 1, hf, { x: (N - 1) * DX, y: 1, z: (N - 1) * DX })
      .setFriction(0.85)
      .setRestitution(0.12);
    this.ground = this.world.createCollider(desc);
    // anything the land rose through gets lifted back onto the surface
    for (const e of this.entries) {
      if (!e.body) continue;
      const p = e.body.translation();
      const g = this.groundAt(p.x, p.z);
      if (p.y < g + e.r * 0.6) {
        e.body.setTranslation({ x: p.x, y: g + e.r + 0.02, z: p.z }, true);
      }
      e.body.wakeUp();
    }
    this.sinceRebuild = 0;
  }

  groundAt(x, z) {
    let gx = (x + HALF) / DX;
    let gz = (z + HALF) / DX;
    gx = Math.min(N - 1.001, Math.max(0, gx));
    gz = Math.min(N - 1.001, Math.max(0, gz));
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

  /**
   * kind: 'clod' | 'seed' | 'petal' | 'leaf' | 'stone'
   * opts: { r, density, vel, spin, data, life, damping }
   */
  add(kind, x, y, z, opts = {}) {
    const r = opts.r ?? 0.25;
    const density = opts.density ?? 1.5;
    const v = opts.vel ?? { x: 0, y: 0, z: 0 };
    const spin = opts.spin ?? { x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 };
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinvel(v.x, v.y, v.z)
      .setAngvel(spin)
      .setLinearDamping(opts.damping ?? 0.05)
      .setAngularDamping(opts.angularDamping ?? 0.4)
      .setCcdEnabled(!!opts.ccd);
    const body = this.world.createRigidBody(bd);
    let cd;
    if (opts.shape) {
      cd = opts.shape;
    } else if (kind === 'petal' || kind === 'leaf') {
      cd = RAPIER.ColliderDesc.cuboid(r, r * 0.12, r);
    } else if (kind === 'clod' || kind === 'stone') {
      cd = RAPIER.ColliderDesc.roundCuboid(r * 0.62, r * 0.55, r * 0.62, r * 0.3);
    } else if (kind === 'seed') {
      // grain-shaped, so it tumbles and comes to rest rather than rolling away
      cd = RAPIER.ColliderDesc.roundCuboid(r * 0.9, r * 0.35, r * 0.5, r * 0.25);
    } else {
      cd = RAPIER.ColliderDesc.ball(r);
    }
    cd.setDensity(density).setFriction(opts.friction ?? 0.9).setRestitution(opts.restitution ?? 0.2);
    this.world.createCollider(cd, body);
    const volume = kind === 'petal' || kind === 'leaf' ? 8 * r * r * r * 0.12 : (4 / 3) * Math.PI * r * r * r;
    const e = {
      id: nextId++,
      kind,
      body,
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
      quat: { x: 0, y: 0, z: 0, w: 1 },
      pos: { x, y, z },
    };
    this.entries.push(e);
    return e;
  }

  remove(e) {
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
    if (e.body) {
      this.world.removeRigidBody(e.body);
      e.body = null;
    }
  }

  count(kind) {
    let n = 0;
    for (const e of this.entries) if (e.kind === kind && e.dissolving < 0) n++;
    return n;
  }

  /** Oldest live body of a kind (to recycle when over budget). */
  oldest(kind) {
    let best = null;
    for (const e of this.entries) if (e.kind === kind && e.dissolving < 0 && (!best || e.age > best.age)) best = e;
    return best;
  }

  dissolve(e) {
    if (e.dissolving >= 0) return;
    e.dissolving = 0;
    if (e.body) {
      const p = e.body.translation();
      const q = e.body.rotation();
      e.pos = { x: p.x, y: p.y, z: p.z };
      e.quat = { x: q.x, y: q.y, z: q.z, w: q.w };
      this.world.removeRigidBody(e.body);
      e.body = null;
    }
  }

  step(dt) {
    this.accum += Math.min(dt, 0.1);
    const h = this.world.timestep;
    let steps = 0;
    while (this.accum >= h && steps < 3) {
      this._applyForces(h);
      if (this.extraForces) this.extraForces(h);
      this.world.step();
      this._post(h);
      this.accum -= h;
      steps++;
    }
    if (steps === 3) this.accum = 0;
    // dissolve animations
    for (let k = this.entries.length - 1; k >= 0; k--) {
      const e = this.entries[k];
      if (e.dissolving >= 0) {
        e.dissolving += dt;
        e.scale = Math.max(0, 1 - e.dissolving / 0.7);
        if (e.dissolving >= 0.7) this.entries.splice(k, 1);
      }
    }
  }

  _applyForces(h) {
    const ws = this._ws;
    const ts = this.waterTimeScale;
    for (const e of this.entries) {
      const b = e.body;
      if (!b) continue;
      b.resetForces(false);
      const p = b.translation();
      this.water.sample(p.x, p.z, ws);
      const bottom = p.y - e.r;
      if (ws.depth > 0.012 && bottom < ws.surface) {
        const sub = Math.min(1, (ws.surface - bottom) / (2 * e.r));
        const v = b.linvel();
        const m = b.mass() || e.mass;
        // Archimedes: weight of displaced water (volume taken from the collider's mass)
        const fb = RHO_WATER * GRAVITY * (m / e.density) * sub;
        // drag toward the current (water velocities run on the sim clock)
        const kd = (e.kind === 'petal' || e.kind === 'leaf' ? 4.5 : 2.2) * sub * m;
        const fx = (ws.u * ts - v.x) * kd;
        const fz = (ws.v * ts - v.z) * kd;
        const fy = -v.y * kd * 0.8;
        b.addForce({ x: fx, y: fb + fy, z: fz }, true);
        if (!e.wet) {
          e.wet = true;
          const speed = Math.hypot(v.x, v.y, v.z);
          if (speed > 2.2 && this.onSplash) this.onSplash(p.x, ws.surface, p.z, e.r, speed, e);
          if (speed > 2.2) this.water.splash(p.x, p.z, m * speed * 2);
        }
        e.wetTime += h;
      } else {
        e.wet = false;
        e.wetTime = 0;
        if (this.wind && (e.kind === 'petal' || e.kind === 'leaf')) {
          // airborne: aerodynamic drag toward the wind, plus a little flutter lift
          const v = b.linvel();
          const w = this.wind.at(p.x, p.z);
          const m = b.mass() || e.mass;
          const k = 1.8 * m;
          b.addForce({ x: (w.x * 2.2 - v.x) * k, y: Math.sin(e.age * 7 + e.id) * m * 3, z: (w.z * 2.2 - v.z) * k }, true);
        }
      }
    }
  }

  _post(h) {
    for (let k = this.entries.length - 1; k >= 0; k--) {
      const e = this.entries[k];
      const b = e.body;
      if (!b) continue;
      e.age += h;
      const p = b.translation();
      const v = b.linvel();
      // impacts: a sudden upward change in vertical velocity
      if (e.lastVy < -3.5 && v.y - e.lastVy > 3 && !e.wet && this.onImpact) {
        this.onImpact(p.x, p.y, p.z, e.r, -e.lastVy, e);
      }
      e.lastVy = v.y;
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < 0.22 || b.isSleeping()) e.still += h;
      else e.still = 0;
      const out = p.y < -12 || Math.abs(p.x) > HALF + 4 || Math.abs(p.z) > HALF + 4;
      if (out) {
        this.remove(e);
        continue;
      }
      if (this.onSettle && (e.age > e.life || this.onSettle(e) === true)) {
        this.dissolve(e);
      }
    }
    this.sinceRebuild += h;
  }

  /** Walk entries of a kind for rendering: fn(pos, quat, scale, entry). */
  forEach(kind, fn) {
    for (const e of this.entries) {
      if (e.kind !== kind) continue;
      if (e.body) {
        const p = e.body.translation();
        const q = e.body.rotation();
        fn(p, q, e.scale, e);
      } else {
        fn(e.pos, e.quat, e.scale, e);
      }
    }
  }
}

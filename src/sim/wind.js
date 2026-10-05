// Wind: a slowly veering breeze with gust fronts that sweep across the
// mountain. Plants don't just wave on a sine: a grid of damped spring
// oscillators is driven by the local gust force, so gusts roll across a
// paddy as a travelling wave and stalks overshoot and settle.
import { makeSimplex2D } from './noise.js';

export class Wind {
  constructor(size = 160, grid = 32, seed = 5) {
    this.size = size;
    this.G = grid;
    const n = grid * grid;
    this.dx = new Float32Array(n);
    this.dz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.noise = makeSimplex2D(seed);
    this.t = 0;
    this.angle = 0.6;
    this.strength = 1;
    this.gustBoost = 0;
    this.vec = { x: 1, z: 0 };
    this.omega = 2 * Math.PI * 0.75; // natural frequency of a rice stalk
    this.zeta = 0.18;
  }

  gust(x, z) {
    const ca = Math.cos(this.angle);
    const sa = Math.sin(this.angle);
    const along = x * ca + z * sa;
    const across = -x * sa + z * ca;
    const g = this.noise(along * 0.035 - this.t * 0.55, across * 0.02 + this.t * 0.03);
    return 0.45 + 0.55 * Math.max(0, g) + 0.25 * this.noise(x * 0.08 + this.t * 0.3, z * 0.08);
  }

  /** Global wind (with local gust) at a world position. */
  at(x, z) {
    const g = this.gust(x, z) * this.strength;
    return { x: this.vec.x * g, z: this.vec.z * g };
  }

  update(dt) {
    this.t += dt;
    this.angle += Math.sin(this.t * 0.013) * 0.004 * dt * 60 * 0.05;
    this.strength = 0.7 + 0.35 * Math.sin(this.t * 0.07) + 0.25 * Math.sin(this.t * 0.19 + 1) + this.gustBoost;
    this.gustBoost *= Math.exp(-dt * 0.4);
    this.vec.x = Math.cos(this.angle);
    this.vec.z = Math.sin(this.angle);

    const { G, dx, dz, vx, vz } = this;
    const w2 = this.omega * this.omega;
    const c = 2 * this.zeta * this.omega;
    const cell = this.size / G;
    if (!this.fx) {
      this.fx = new Float32Array(G * G);
      this.fz = new Float32Array(G * G);
    }
    const { fx, fz } = this;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const k = i + j * G;
        const g = this.gust((i + 0.5) * cell - this.size / 2, (j + 0.5) * cell - this.size / 2) * this.strength;
        // drag force on the stalk ~ wind speed; the spring pulls it back upright
        fx[k] = this.vec.x * g * 0.11 * w2;
        fz[k] = this.vec.z * g * 0.11 * w2;
      }
    }
    const sub = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      for (let k = 0; k < G * G; k++) {
        vx[k] += (fx[k] - w2 * dx[k] - c * vx[k]) * h;
        vz[k] += (fz[k] - w2 * dz[k] - c * vz[k]) * h;
        dx[k] += vx[k] * h;
        dz[k] += vz[k] * h;
      }
    }
  }

  gust1() {
    this.gustBoost = 1.4;
  }
}

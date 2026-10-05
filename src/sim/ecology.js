// Wild vegetation cover: grass greens where soil stays moist and slowly
// fades back to golden where it dries out. Purely cosmetic, but it makes the
// mountain visibly answer to where the water goes.
import { N } from './constants.js';
import { makeSimplex2D } from './noise.js';

export class Ecology {
  constructor(terrain, water, seed = 3) {
    this.t = terrain;
    this.w = water;
    const n = N * N;
    this.green = new Float32Array(n);
    this.base = new Float32Array(n);
    const noise = makeSimplex2D(seed);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = i + j * N;
        const h = terrain.H[c];
        const sl = terrain.slopeAt(c);
        let g = 0.5 + 0.2 * noise(i * 0.05, j * 0.05) + 0.1 * noise(i * 0.17 + 9, j * 0.17);
        g += 0.22 * Math.exp(-(((h - 16) / 14) ** 2)); // lush mid-slopes
        g -= Math.max(0, (h - 38) / 12); // rocky summit
        g -= Math.max(0, sl - 1.1) * 0.5;
        g = Math.min(0.85, Math.max(0.05, g));
        this.base[c] = g;
        this.green[c] = g;
      }
    }
    this.cursor = 0;
  }

  /** Update a slice of the grid each call (spreads the cost over frames). */
  update(dt, fraction = 0.25) {
    const { green, base } = this;
    const moist = this.w.moist;
    const d = this.w.d;
    const terrace = this.t.terrace;
    const n = green.length;
    const count = Math.ceil(n * fraction);
    const step = dt / fraction;
    for (let k = 0; k < count; k++) {
      const c = this.cursor;
      this.cursor = (this.cursor + 1) % n;
      if (terrace[c]) {
        green[c] = 0;
        continue;
      }
      const m = moist[c];
      let target = Math.max(base[c] * 0.85, Math.min(1, m * 1.25));
      if (d[c] > 0.25) target *= 0.4; // drowned grass
      const g = green[c];
      const rate = target > g ? 0.035 : 0.008;
      green[c] = g + (target - g) * Math.min(1, rate * step);
    }
  }
}

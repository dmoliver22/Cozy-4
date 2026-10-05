// Shallow-water simulation on the heightfield using the "virtual pipes" model
// (O'Brien & Hodgins 1995; Mei, Decaudin & Hu 2007): every cell exchanges
// water with its four neighbours through pipes whose flux is accelerated by
// the difference in water-surface height (hydrostatic pressure + gravity) and
// slowed by depth-dependent bed friction. On top of that:
//   * infiltration into soil + groundwater seepage (moisture field)
//   * evaporation, springs and rain
//   * suspended-sediment erosion / transport / deposition (silt fertilises
//     paddies instead of filling them)
//   * splash impulses from rigid bodies that ripple outward as real waves

import { N, DX, HALF, clamp } from './constants.js';

export class WaterSim {
  constructor(terrain, params = {}) {
    this.t = terrain;
    const n = N * N;
    this.n = n;
    this.d = new Float32Array(n); // water depth
    this.fL = new Float32Array(n); // outflow flux toward -x
    this.fR = new Float32Array(n); // +x
    this.fT = new Float32Array(n); // -z
    this.fB = new Float32Array(n); // +z
    this.u = new Float32Array(n); // velocity x
    this.v = new Float32Array(n); // velocity z
    this.sed = new Float32Array(n); // suspended sediment volume
    this.sedTmp = new Float32Array(n);
    this.moist = new Float32Array(n); // soil moisture 0..1
    this.moistTmp = new Float32Array(n);
    this.fert = new Float32Array(n); // deposited silt (fertility) 0..1
    this.wetAge = new Float32Array(n); // seconds a cell has been continuously wet
    this.springs = [];
    this.rain = 0; // depth per second
    this.p = {
      g: 9.81,
      dt: 0.02,
      friction: 0.24, // bed friction coefficient (stronger for thin films)
      evap: 0.0012,
      infil: 0.035, // infiltration rate into dry soil (depth/s)
      soilCap: 0.45, // water depth that saturates the soil column
      seep: 0.05, // downhill groundwater seepage
      moistDiff: 0.04,
      moistDecay: 0.0035,
      kc: 0.02, // sediment capacity constant
      ks: 0.2, // dissolving rate
      kd: 0.9, // deposition rate
      erosion: true,
      maxSpeed: 9,
      ...params,
    };
    this.steps = 0;
    this.drained = 0; // volume that left the map
    this.added = 0;
    this.erodedBox = { x0: N, z0: N, x1: -1, z1: -1 };
  }

  addSpring(x, z, rate, name = '') {
    const i = clamp(Math.round((x + HALF) / DX), 1, N - 2);
    const j = clamp(Math.round((z + HALF) / DX), 1, N - 2);
    const s = { i, j, x: i * DX - HALF, z: j * DX - HALF, rate, name, flowing: 0 };
    this.springs.push(s);
    return s;
  }

  totalVolume() {
    let v = 0;
    const d = this.d;
    for (let c = 0; c < this.n; c++) v += d[c];
    return v * DX * DX;
  }

  /** Advance by one fixed step. */
  step() {
    const p = this.p;
    const dt = p.dt;
    this._flux(dt);
    this._depth(dt);
    this._sources(dt);
    this.steps++;
    if (this.steps % 2 === 0 && p.erosion) this._sediment(dt * 2);
    if (this.steps % 5 === 0) this._moisture(dt * 5);
  }

  _flux(dt) {
    const { d, fL, fR, fT, fB } = this;
    const H = this.t.H;
    const coef = dt * this.p.g * DX; // A*g/l with A = DX^2, l = DX
    const fr = this.p.friction * dt;
    const area = DX * DX;
    for (let j = 0; j < N; j++) {
      const row = j * N;
      for (let i = 0; i < N; i++) {
        const c = row + i;
        const dc = d[c];
        if (dc <= 1e-5) {
          fL[c] = 0;
          fR[c] = 0;
          fT[c] = 0;
          fB[c] = 0;
          continue;
        }
        const hc = H[c] + dc;
        const damp = 1 / (1 + fr / (dc + 0.015));
        let l = fL[c] * damp + coef * (i > 0 ? hc - H[c - 1] - d[c - 1] : dc);
        let r = fR[c] * damp + coef * (i < N - 1 ? hc - H[c + 1] - d[c + 1] : dc);
        let t = fT[c] * damp + coef * (j > 0 ? hc - H[c - N] - d[c - N] : dc);
        let b = fB[c] * damp + coef * (j < N - 1 ? hc - H[c + N] - d[c + N] : dc);
        if (l < 0) l = 0;
        if (r < 0) r = 0;
        if (t < 0) t = 0;
        if (b < 0) b = 0;
        const sum = l + r + t + b;
        if (sum > 0) {
          const k = (dc * area) / (sum * dt);
          if (k < 1) {
            l *= k;
            r *= k;
            t *= k;
            b *= k;
          }
        }
        fL[c] = l;
        fR[c] = r;
        fT[c] = t;
        fB[c] = b;
      }
    }
  }

  _depth(dt) {
    const { d, fL, fR, fT, fB, u, v } = this;
    const inv = dt / (DX * DX);
    const maxS = this.p.maxSpeed;
    let drained = 0;
    for (let j = 0; j < N; j++) {
      const row = j * N;
      for (let i = 0; i < N; i++) {
        const c = row + i;
        const inL = i > 0 ? fR[c - 1] : 0;
        const inR = i < N - 1 ? fL[c + 1] : 0;
        const inT = j > 0 ? fB[c - N] : 0;
        const inB = j < N - 1 ? fT[c + N] : 0;
        const outL = fL[c];
        const outR = fR[c];
        const outT = fT[c];
        const outB = fB[c];
        if (i === 0) drained += outL;
        else if (i === N - 1) drained += outR;
        if (j === 0) drained += outT;
        else if (j === N - 1) drained += outB;
        const d0 = d[c];
        let d1 = d0 + (inL + inR + inT + inB - outL - outR - outT - outB) * inv;
        if (d1 < 1e-7) d1 = 0;
        d[c] = d1;
        const dm = 0.5 * (d0 + d1);
        if (dm > 0.002) {
          let vx = (inL - outL + outR - inR) / (2 * DX * dm);
          let vz = (inT - outT + outB - inB) / (2 * DX * dm);
          const s2 = vx * vx + vz * vz;
          if (s2 > maxS * maxS) {
            const k = maxS / Math.sqrt(s2);
            vx *= k;
            vz *= k;
          }
          u[c] = vx;
          v[c] = vz;
        } else {
          u[c] = 0;
          v[c] = 0;
        }
      }
    }
    this.drained += drained * dt;
  }

  _sources(dt) {
    const { d, moist, wetAge } = this;
    const t = this.t;
    const terrace = t.terrace;
    const wall = t.wall;
    const channel = t.channel;
    const p = this.p;
    const rain = this.rain * dt;
    const evap = p.evap * dt;
    const infil = p.infil * dt;
    const invCap = 1 / p.soilCap;
    for (let c = 0; c < this.n; c++) {
      let dc = d[c] + rain;
      if (dc > 0) {
        dc -= evap;
        if (dc < 0) dc = 0;
        // infiltration into the soil column; paddies have a puddled hardpan
        const perm = terrace[c] ? 0.06 : channel[c] ? 0.05 : wall[c] ? 0.35 : 1;
        const m = moist[c];
        if (m < 1) {
          let a = infil * perm * (1 - m);
          if (a > dc) a = dc;
          dc -= a;
          let mm = m + a * invCap;
          moist[c] = mm > 1 ? 1 : mm;
        }
        if (dc > 0.01) wetAge[c] += dt;
        else wetAge[c] = 0;
      } else if (wetAge[c] !== 0) {
        wetAge[c] = 0;
      }
      d[c] = dc;
    }
    if (rain > 0) this.added += rain * this.n * DX * DX;
    // springs: spread over a small disc so the source isn't a single spike
    for (const s of this.springs) {
      if (s.rate <= 0) continue;
      const vol = s.rate * dt;
      this.added += vol;
      const share = vol / (DX * DX * 5);
      const c = s.i + s.j * N;
      d[c] += share;
      d[c - 1] += share;
      d[c + 1] += share;
      d[c - N] += share;
      d[c + N] += share;
    }
  }

  _sediment(dt) {
    const { d, u, v, sed, sedTmp, fert } = this;
    const t = this.t;
    const { H, soil, rock, bund, terrace, wall, channel } = t;
    const p = this.p;
    let x0 = N;
    let z0 = N;
    let x1 = -1;
    let z1 = -1;
    for (let j = 1; j < N - 1; j++) {
      const row = j * N;
      for (let i = 1; i < N - 1; i++) {
        const c = row + i;
        const s = sed[c];
        const dc = d[c];
        if (dc < 0.004) {
          if (s > 0) {
            // water vanished: drop whatever it carried
            if (terrace[c] || wall[c] || channel[c]) fert[c] = Math.min(1, fert[c] + s * 2);
            else {
              soil[c] += s;
              H[c] = rock[c] + soil[c] + bund[c];
            }
            sed[c] = 0;
          }
          continue;
        }
        const gx = (H[c + 1] - H[c - 1]) * (0.5 / DX);
        const gz = (H[c + N] - H[c - N]) * (0.5 / DX);
        const sl = Math.sqrt(gx * gx + gz * gz);
        const sinA = sl / Math.sqrt(1 + sl * sl);
        const speed = Math.sqrt(u[c] * u[c] + v[c] * v[c]);
        const depthF = dc < 0.25 ? dc / 0.25 : 1;
        const cap = p.kc * (sinA > 0.05 ? sinA : 0.05) * speed * depthF;
        const retained = terrace[c] || wall[c] || channel[c];
        if (cap > s) {
          if (!retained && soil[c] > 0) {
            let a = p.ks * (cap - s) * dt;
            if (a > soil[c]) a = soil[c];
            soil[c] -= a;
            sed[c] = s + a;
            H[c] = rock[c] + soil[c] + bund[c];
            if (a > 1e-5) {
              if (i < x0) x0 = i;
              if (i > x1) x1 = i;
              if (j < z0) z0 = j;
              if (j > z1) z1 = j;
            }
          }
        } else {
          const a = p.kd * (s - cap) * dt;
          sed[c] = s - a;
          if (retained) {
            fert[c] = Math.min(1, fert[c] + a * 2);
          } else {
            soil[c] += a;
            H[c] = rock[c] + soil[c] + bund[c];
            if (a > 1e-5) {
              if (i < x0) x0 = i;
              if (i > x1) x1 = i;
              if (j < z0) z0 = j;
              if (j > z1) z1 = j;
            }
          }
        }
      }
    }
    // semi-Lagrangian advection of suspended sediment along the flow
    const lim = N - 1.001;
    for (let j = 0; j < N; j++) {
      const row = j * N;
      for (let i = 0; i < N; i++) {
        const c = row + i;
        if (d[c] < 0.004) {
          sedTmp[c] = 0;
          continue;
        }
        let gx = i - (u[c] * dt) / DX;
        let gz = j - (v[c] * dt) / DX;
        if (gx < 0) gx = 0;
        else if (gx > lim) gx = lim;
        if (gz < 0) gz = 0;
        else if (gz > lim) gz = lim;
        const ii = gx | 0;
        const jj = gz | 0;
        const fx = gx - ii;
        const fz = gz - jj;
        const k = ii + jj * N;
        const a = sed[k] + (sed[k + 1] - sed[k]) * fx;
        const b = sed[k + N] + (sed[k + N + 1] - sed[k + N]) * fx;
        sedTmp[c] = a + (b - a) * fz;
      }
    }
    this.sed = sedTmp;
    this.sedTmp = sed;
    if (x1 >= x0) {
      t.dirtyErode.add(x0 - 1, z0 - 1, x1 + 1, z1 + 1);
      t.version++;
    }
  }

  _moisture(dt) {
    const { d, moist, moistTmp } = this;
    const t = this.t;
    const H = t.H;
    const terrace = t.terrace;
    const p = this.p;
    const kSeep = p.seep * dt;
    const kDiff = p.moistDiff * dt;
    const decay = 1 - p.moistDecay * dt;
    for (let j = 0; j < N; j++) {
      const row = j * N;
      for (let i = 0; i < N; i++) {
        const c = row + i;
        if (d[c] > 0.02) {
          moistTmp[c] = 1;
          continue;
        }
        const m = moist[c];
        const h = H[c];
        let acc = 0;
        // four neighbours: diffusion + Darcy-like downhill seepage
        if (i > 0) acc += this._exch(c, c - 1, m, h, kSeep, kDiff, terrace);
        if (i < N - 1) acc += this._exch(c, c + 1, m, h, kSeep, kDiff, terrace);
        if (j > 0) acc += this._exch(c, c - N, m, h, kSeep, kDiff, terrace);
        if (j < N - 1) acc += this._exch(c, c + N, m, h, kSeep, kDiff, terrace);
        let nm = (m + acc) * decay;
        moistTmp[c] = nm < 0 ? 0 : nm > 1 ? 1 : nm;
      }
    }
    this.moist = moistTmp;
    this.moistTmp = moist;
  }

  _exch(c, n, m, h, kSeep, kDiff, terrace) {
    const mn = this.moist[n];
    const hn = this.t.H[n];
    let q = (mn - m) * kDiff;
    const dh = hn - h;
    if (dh > 0) {
      // water seeps in from the higher neighbour (slower out of hardpan paddies)
      const perm = terrace[n] ? 0.35 : 1;
      q += mn * kSeep * perm * (dh > 2 ? 2 : dh);
    } else if (dh < 0) {
      const perm = terrace[c] ? 0.35 : 1;
      q -= m * kSeep * perm * (-dh > 2 ? 2 : -dh);
    }
    return q;
  }

  /**
   * A body hitting the water pushes it outward: remove a little volume at the
   * impact and pile it on a ring — the pipe model turns that into ripples.
   */
  splash(x, z, strength) {
    const gi = Math.round((x + HALF) / DX);
    const gj = Math.round((z + HALF) / DX);
    if (gi < 3 || gj < 3 || gi > N - 4 || gj > N - 4) return;
    const c = gi + gj * N;
    const take = Math.min(this.d[c] * 0.6, strength * 0.05);
    if (take <= 0) return;
    this.d[c] -= take;
    const ring = [-2, 2, -2 * N, 2 * N, -1 - N, 1 - N, -1 + N, 1 + N];
    const share = take / ring.length;
    for (const o of ring) this.d[c + o] += share;
  }

  /** Bilinear water query used by physics (buoyancy, currents) and gameplay. */
  sample(x, z, out) {
    let gx = (x + HALF) / DX;
    let gz = (z + HALF) / DX;
    if (gx < 0) gx = 0;
    else if (gx > N - 1.001) gx = N - 1.001;
    if (gz < 0) gz = 0;
    else if (gz > N - 1.001) gz = N - 1.001;
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const c = i + j * N;
    const w00 = (1 - fx) * (1 - fz);
    const w10 = fx * (1 - fz);
    const w01 = (1 - fx) * fz;
    const w11 = fx * fz;
    const d = this.d;
    const H = this.t.H;
    const u = this.u;
    const v = this.v;
    out.depth = d[c] * w00 + d[c + 1] * w10 + d[c + N] * w01 + d[c + N + 1] * w11;
    out.ground = H[c] * w00 + H[c + 1] * w10 + H[c + N] * w01 + H[c + N + 1] * w11;
    out.surface = out.ground + out.depth;
    out.u = u[c] * w00 + u[c + 1] * w10 + u[c + N] * w01 + u[c + N + 1] * w11;
    out.v = v[c] * w00 + v[c + 1] * w10 + v[c + N] * w01 + v[c + N + 1] * w11;
    return out;
  }

  /** Water drops/falls: wet cells pouring over a ledge — used for spray + sound. */
  findFalls(out, maxCount = 256) {
    out.length = 0;
    const { d, fL, fR, fT, fB } = this;
    const H = this.t.H;
    for (let j = 1; j < N - 1; j++) {
      const row = j * N;
      for (let i = 1; i < N - 1; i++) {
        const c = row + i;
        if (d[c] < 0.008) continue;
        const h = H[c];
        let best = 0;
        let bn = -1;
        let drop = 0;
        let f = fL[c];
        if (f > best && h - H[c - 1] > 0.7) {
          best = f;
          bn = c - 1;
        }
        f = fR[c];
        if (f > best && h - H[c + 1] > 0.7) {
          best = f;
          bn = c + 1;
        }
        f = fT[c];
        if (f > best && h - H[c - N] > 0.7) {
          best = f;
          bn = c - N;
        }
        f = fB[c];
        if (f > best && h - H[c + N] > 0.7) {
          best = f;
          bn = c + N;
        }
        if (bn >= 0 && best > 0.04) {
          drop = h - H[bn];
          out.push(c, bn, best, drop);
          if (out.length >= maxCount * 4) return out;
        }
      }
    }
    return out;
  }

  /** Kinetic-energy-ish measure of moving water, for audio. */
  flowEnergy() {
    const { d, u, v } = this;
    let e = 0;
    for (let c = 0; c < this.n; c += 3) {
      const dc = d[c];
      if (dc < 0.004) continue;
      e += dc * (u[c] * u[c] + v[c] * v[c]);
    }
    return e * 3;
  }
}

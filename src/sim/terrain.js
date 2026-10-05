// The sculptable mountain: a layered heightfield (bedrock + loose soil) plus
// terrace bookkeeping. Terraces are flat shelves at a fixed level; their rim
// cells get an earthen bund so they hold water and spill at the lowest point.

import {
  N,
  DX,
  HALF,
  MAX_TERRACES,
  BUND_H,
  RISER_W,
  MERGE_EPS,
  TALUS,
  clamp,
} from './constants.js';
import { makeSimplex2D } from './noise.js';

export const SDF_FAR = 4;

function emptyBox() {
  return { x0: N, z0: N, x1: -1, z1: -1 };
}

export class DirtyBox {
  constructor() {
    this.reset();
  }
  reset() {
    this.x0 = N;
    this.z0 = N;
    this.x1 = -1;
    this.z1 = -1;
  }
  add(i0, j0, i1, j1) {
    if (i0 < this.x0) this.x0 = i0;
    if (j0 < this.z0) this.z0 = j0;
    if (i1 > this.x1) this.x1 = i1;
    if (j1 > this.z1) this.z1 = j1;
  }
  addCell(c) {
    const i = c % N;
    const j = (c - i) / N;
    this.add(i, j, i, j);
  }
  get empty() {
    return this.x1 < this.x0;
  }
  take() {
    const b = { x0: Math.max(0, this.x0), z0: Math.max(0, this.z0), x1: Math.min(N - 1, this.x1), z1: Math.min(N - 1, this.z1) };
    this.reset();
    return b;
  }
}

export class Terrain {
  constructor() {
    const n = N * N;
    this.n = n;
    this.rock = new Float32Array(n);
    this.soil = new Float32Array(n);
    this.bund = new Float32Array(n);
    this.H = new Float32Array(n); // solid surface = rock + soil + bund
    this.base = new Float32Array(n); // the untouched mountain, for "soften"
    this.terrace = new Int16Array(n);
    this.wall = new Uint8Array(n); // retained (stone-faced) cells: no slumping or erosion
    this.path = new Uint8Array(n);
    this.channel = new Uint8Array(n);
    this.bundNoise = new Float32Array(n);
    // Signed distance to the edge of the cell's own terrace (negative inside),
    // or for loose ground the distance to the nearest terrace edge. Built from
    // the brush discs themselves, so renderers can draw terrace edges as the
    // smooth curves they were cut as rather than as grid cells.
    this.sdf = new Float32Array(n).fill(SDF_FAR);
    this.levels = new Float32Array(MAX_TERRACES);
    this.counts = new Int32Array(MAX_TERRACES);
    this.nextTerrace = 1;

    // sculpt animation: cells ease toward a target ground height
    this.tgt = new Float32Array(n);
    this.activeFlag = new Uint8Array(n);
    this.active = [];
    this.sculptRate = 9;

    // consumers each keep their own dirty box
    this.dirtyMesh = new DirtyBox();
    this.dirtyPhys = new DirtyBox();
    this.dirtyBund = new DirtyBox();
    this.dirtyErode = new DirtyBox(); // slow natural change (erosion, slumping)
    this.sculptVersion = 0; // bumps only when the land is deliberately reshaped
    this.disturbed = []; // cells whose ground was reshaped (plants/houses there get displaced)
    this.version = 0;

    // per-stroke scratch
    this._g0 = new Float32Array(n);
    this._w = new Float32Array(n);

    const noise = makeSimplex2D(911);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = noise(i * 0.31, j * 0.31) * 0.6 + noise(i * 0.9 + 40, j * 0.9) * 0.4;
        this.bundNoise[i + j * N] = 0.8 + 0.2 * v; // 0.6 .. 1.0 ish
      }
    }
  }

  ground(c) {
    return this.rock[c] + this.soil[c];
  }

  /** Recompute bunds + H in a grid box (inclusive), expanded by one cell. */
  refresh(x0, z0, x1, z1) {
    x0 = Math.max(0, x0 - 1);
    z0 = Math.max(0, z0 - 1);
    x1 = Math.min(N - 1, x1 + 1);
    z1 = Math.min(N - 1, z1 + 1);
    const { rock, soil, bund, H, terrace, levels, bundNoise } = this;
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const c = i + j * N;
        const t = terrace[c];
        let b = 0;
        if (t > 0) {
          const lim = levels[t] + BUND_H * 0.9;
          // A rim faces a lower neighbour that isn't part of this terrace. Open
          // waterways (channels, the spring pool) never get a bund: touching
          // one connects the paddy to it.
          let rim = i === 0 || j === 0 || i === N - 1 || j === N - 1;
          if (!rim) {
            const ch = this.channel;
            rim =
              (terrace[c - 1] !== t && !ch[c - 1] && rock[c - 1] + soil[c - 1] < lim) ||
              (terrace[c + 1] !== t && !ch[c + 1] && rock[c + 1] + soil[c + 1] < lim) ||
              (terrace[c - N] !== t && !ch[c - N] && rock[c - N] + soil[c - N] < lim) ||
              (terrace[c + N] !== t && !ch[c + N] && rock[c + N] + soil[c + N] < lim);
          }
          if (rim) b = BUND_H * bundNoise[c];
        }
        bund[c] = b;
        H[c] = rock[c] + soil[c] + b;
      }
    }
    this.dirtyMesh.add(x0, z0, x1, z1);
    this.dirtyPhys.add(x0, z0, x1, z1);
    this.version++;
    this.sculptVersion++;
  }

  refreshAll() {
    this.refresh(0, 0, N - 1, N - 1);
  }

  recount() {
    this.counts.fill(0);
    const { terrace, counts } = this;
    for (let c = 0; c < this.n; c++) counts[terrace[c]]++;
  }

  setTerrace(c, id) {
    const old = this.terrace[c];
    if (old === id) return;
    this.counts[old]--;
    this.counts[id]++;
    this.terrace[c] = id;
    this.dirtyBund.addCell(c);
  }

  allocTerrace(level) {
    for (let k = 0; k < MAX_TERRACES - 1; k++) {
      const id = ((this.nextTerrace + k - 1) % (MAX_TERRACES - 1)) + 1;
      if (this.counts[id] === 0) {
        this.levels[id] = level;
        this.nextTerrace = id + 1;
        return id;
      }
    }
    return 1; // grid is full of terraces; reuse
  }

  mergeTerrace(from, into) {
    const { terrace } = this;
    for (let c = 0; c < this.n; c++) {
      if (terrace[c] === from) {
        terrace[c] = into;
        this.dirtyBund.addCell(c);
      }
    }
    this.counts[into] += this.counts[from];
    this.counts[from] = 0;
  }

  /** Find a terrace to snap to near (x, z) whose level is within tol of h. */
  findTerraceNear(x, z, radius, h, tol) {
    const gi = (x + HALF) / DX;
    const gj = (z + HALF) / DX;
    const r = radius / DX;
    let best = 0;
    let bestScore = Infinity;
    const i0 = Math.max(0, Math.floor(gi - r));
    const i1 = Math.min(N - 1, Math.ceil(gi + r));
    const j0 = Math.max(0, Math.floor(gj - r));
    const j1 = Math.min(N - 1, Math.ceil(gj + r));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const t = this.terrace[i + j * N];
        if (!t) continue;
        const dh = Math.abs(this.levels[t] - h);
        if (dh > tol) continue;
        const d2 = (i - gi) ** 2 + (j - gj) ** 2;
        if (d2 > r * r) continue;
        const score = dh * 4 + Math.sqrt(d2) * DX * 0.05;
        if (score < bestScore) {
          bestScore = score;
          best = t;
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ sculpt animation

  setTarget(c, h) {
    // retained/reshaped cells keep no loose soil: fold it into the rock layer
    if (this.soil[c] !== 0) {
      this.rock[c] += this.soil[c];
      this.soil[c] = 0;
    }
    this.tgt[c] = h;
    if (!this.activeFlag[c]) {
      this.activeFlag[c] = 1;
      this.active.push(c);
    }
  }

  /** Ease reshaped cells toward their targets. Returns true while animating. */
  animate(dt) {
    const list = this.active;
    if (list.length === 0) return false;
    const k = Math.min(1, this.sculptRate * dt);
    const minStep = 3.5 * dt;
    const { rock, soil, tgt, activeFlag } = this;
    let x0 = N;
    let z0 = N;
    let x1 = -1;
    let z1 = -1;
    let w = 0;
    for (let r = 0; r < list.length; r++) {
      const c = list[r];
      const g = rock[c] + soil[c];
      const diff = tgt[c] - g;
      const ad = Math.abs(diff);
      let step = diff * k;
      if (Math.abs(step) < minStep) step = Math.sign(diff) * Math.min(ad, minStep);
      if (ad < 0.004) {
        rock[c] = tgt[c] - soil[c];
        activeFlag[c] = 0;
      } else {
        rock[c] += step;
        list[w++] = c;
      }
      const i = c % N;
      const j = (c - i) / N;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < z0) z0 = j;
      if (j > z1) z1 = j;
    }
    list.length = w;
    if (x1 >= x0) this.refresh(x0, z0, x1, z1);
    return w > 0;
  }

  /** Jump all pending sculpt targets to completion. */
  settle() {
    const { rock, soil, tgt, activeFlag } = this;
    let x0 = N;
    let z0 = N;
    let x1 = -1;
    let z1 = -1;
    for (const c of this.active) {
      rock[c] = tgt[c] - soil[c];
      activeFlag[c] = 0;
      const i = c % N;
      const j = (c - i) / N;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < z0) z0 = j;
      if (j > z1) z1 = j;
    }
    this.active.length = 0;
    if (x1 >= x0) this.refresh(x0, z0, x1, z1);
    this.flushBunds();
  }

  flushBunds() {
    if (!this.dirtyBund.empty) {
      const b = this.dirtyBund.take();
      this.refresh(b.x0, b.z0, b.x1, b.z1);
    }
  }

  /** Current (or pending) ground height for a cell. */
  futureGround(c) {
    return this.activeFlag[c] ? this.tgt[c] : this.rock[c] + this.soil[c];
  }

  // ------------------------------------------------------------------ strokes

  beginStroke(tool, x, z, opts = {}) {
    this.settle();
    const { rock, soil, _g0, _w } = this;
    for (let c = 0; c < this.n; c++) _g0[c] = rock[c] + soil[c];
    _w.fill(0);
    const stroke = {
      tool,
      R: opts.radius ?? 3,
      level: 0,
      tid: 0,
      cut: 0,
      fill: 0,
      lastX: x,
      lastZ: z,
      bed: 0,
      started: false,
      cells: 0,
    };
    const h0 = this.sampleGround(x, z);
    if (tool === 'terrace' && opts.level !== undefined) {
      stroke.level = opts.level;
      stroke.tid = this.allocTerrace(opts.level);
    } else if (tool === 'terrace') {
      const gi = Math.round((x + HALF) / DX);
      const gj = Math.round((z + HALF) / DX);
      const c = clamp(gi, 0, N - 1) + clamp(gj, 0, N - 1) * N;
      let tid = this.terrace[c];
      if (!tid) tid = this.findTerraceNear(x, z, stroke.R + 2.5, h0, 0.45);
      if (tid) {
        stroke.tid = tid;
        stroke.level = this.levels[tid];
      } else {
        stroke.level = Math.round(h0 * 20) / 20;
        stroke.tid = this.allocTerrace(stroke.level);
      }
    } else if (tool === 'channel') {
      stroke.depth = opts.depth ?? 0.7;
      stroke.width = opts.width ?? 0;
      stroke.lined = opts.lined ?? true;
      stroke.bed = h0 - stroke.depth;
    } else if (tool === 'raise') {
      stroke.level = opts.level ?? h0 + 1;
    }
    return stroke;
  }

  /** The level a terrace stroke started here would cut at (for the cursor preview). */
  previewLevel(x, z, radius) {
    const gi = clamp(Math.round((x + HALF) / DX), 0, N - 1);
    const gj = clamp(Math.round((z + HALF) / DX), 0, N - 1);
    const h0 = this.sampleGround(x, z);
    let tid = this.terrace[gi + gj * N];
    if (!tid) tid = this.findTerraceNear(x, z, radius + 2.5, h0, 0.45);
    return tid ? this.levels[tid] : Math.round(h0 * 20) / 20;
  }

  sampleGround(x, z) {
    let gx = clamp((x + HALF) / DX, 0, N - 1.001);
    let gz = clamp((z + HALF) / DX, 0, N - 1.001);
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const c = i + j * N;
    const g = (k) => this.rock[k] + this.soil[k];
    const a = g(c) + (g(c + 1) - g(c)) * fx;
    const b = g(c + N) + (g(c + N + 1) - g(c + N)) * fx;
    return a + (b - a) * fz;
  }

  sampleG0(x, z) {
    let gx = clamp((x + HALF) / DX, 0, N - 1.001);
    let gz = clamp((z + HALF) / DX, 0, N - 1.001);
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const c = i + j * N;
    const g = this._g0;
    const a = g[c] + (g[c + 1] - g[c]) * fx;
    const b = g[c + N] + (g[c + N + 1] - g[c + N]) * fx;
    return a + (b - a) * fz;
  }

  _markDisturbed(c, oldH, newH) {
    if (Math.abs(oldH - newH) > 0.12) this.disturbed.push(c);
  }

  /**
   * Continue a stroke to (x, z). Interpolates dabs along the segment so fast
   * drags still produce continuous terraces. Returns { cut, fill } volume for
   * this segment (cut material can be spawned as tumbling clods).
   */
  strokeTo(stroke, x, z) {
    const sx = stroke.started ? stroke.lastX : x;
    const sz = stroke.started ? stroke.lastZ : z;
    const dist = Math.hypot(x - sx, z - sz);
    const spacing = stroke.tool === 'channel' ? 0.4 : Math.max(0.5, stroke.R * 0.35);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    let cut = 0;
    let fill = 0;
    for (let s = stroke.started ? 1 : 0; s <= steps; s++) {
      const t = s / steps;
      const px = sx + (x - sx) * t;
      const pz = sz + (z - sz) * t;
      let r;
      if (stroke.tool === 'terrace') r = this.terraceDab(stroke, px, pz);
      else if (stroke.tool === 'channel') r = this.channelDab(stroke, px, pz);
      else if (stroke.tool === 'path') r = this.pathDab(stroke, px, pz);
      else if (stroke.tool === 'soften') r = this.softenDab(stroke, px, pz);
      else if (stroke.tool === 'raise') r = this.raiseDab(stroke, px, pz);
      if (r) {
        cut += r.cut;
        fill += r.fill;
      }
    }
    stroke.started = true;
    stroke.lastX = x;
    stroke.lastZ = z;
    stroke.cut += cut;
    stroke.fill += fill;
    this.flushBunds();
    return { cut, fill };
  }

  _box(x, z, reach) {
    const gi = (x + HALF) / DX;
    const gj = (z + HALF) / DX;
    const r = reach / DX;
    return {
      gi,
      gj,
      i0: Math.max(0, Math.floor(gi - r)),
      i1: Math.min(N - 1, Math.ceil(gi + r)),
      j0: Math.max(0, Math.floor(gj - r)),
      j1: Math.min(N - 1, Math.ceil(gj + r)),
    };
  }

  terraceDab(stroke, x, z) {
    const R = stroke.R;
    const L = stroke.level;
    let tid = stroke.tid;
    const reach = R + RISER_W;
    const { gi, gj, i0, i1, j0, j1 } = this._box(x, z, reach);
    const { _w, _g0, terrace, levels } = this;
    let cut = 0;
    let fill = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - gi, j - gj) * DX;
        if (d > reach) continue;
        const c = i + j * N;
        // signed distance bookkeeping (CSG on discs): union into this terrace,
        // subtraction from any other terrace, distance-to-edge for loose ground
        const sd = d - R;
        const tc = terrace[c];
        if (sd <= 0) this.sdf[c] = tc === tid ? Math.min(this.sdf[c], sd) : sd;
        else if (tc === tid || tc === 0) this.sdf[c] = Math.min(this.sdf[c], sd);
        else this.sdf[c] = Math.max(this.sdf[c], -sd);
        const w = d <= R ? 1 : 1 - (d - R) / RISER_W;
        if (w <= _w[c]) continue;
        const prev = this.futureGround(c);
        let target;
        if (d <= R) {
          const t = terrace[c];
          if (t !== tid) {
            if (t > 0 && Math.abs(levels[t] - L) < MERGE_EPS && this.counts[t] > 0) {
              this.mergeTerrace(t, tid);
            } else {
              this.setTerrace(c, tid);
            }
          }
          this.wall[c] = 0;
          this.channel[c] = 0;
          target = L;
          _w[c] = 1;
        } else {
          const t = terrace[c];
          if (t > 0) continue; // never deform neighbouring terrace beds with a riser
          const ws = w * w * (3 - 2 * w);
          target = _g0[c] + (L - _g0[c]) * ws * 0.9;
          this.wall[c] = 1;
          _w[c] = w;
        }
        const dv = (prev - target) * DX * DX;
        if (dv > 0) cut += dv;
        else fill -= dv;
        this._markDisturbed(c, _g0[c], target);
        this.setTarget(c, target);
        this.dirtyBund.add(i, j, i, j);
      }
    }
    return { cut, fill };
  }

  /**
   * Channels keep a bed that only ever descends along the stroke, so water
   * always runs from where you started digging toward where you stopped —
   * dragging uphill simply cuts deeper (up to a limit).
   */
  channelDab(stroke, x, z) {
    const r = stroke.width || Math.max(1.0, Math.min(stroke.R * 0.45, 1.8));
    const depth = stroke.depth;
    const natural = this.sampleG0(x, z);
    let bed = Math.min(stroke.bed - 0.012, natural - depth);
    bed = Math.max(bed, natural - 3.2); // don't tunnel absurdly deep through ridges
    stroke.bed = bed;
    const reach = r + 0.9;
    const { gi, gj, i0, i1, j0, j1 } = this._box(x, z, reach);
    let cut = 0;
    let fill = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - gi, j - gj) * DX;
        if (d > reach) continue;
        const c = i + j * N;
        const prev = this.futureGround(c);
        const profile = d <= r ? bed + (d / r) ** 2 * depth * 0.6 : bed + depth * 0.6 + (d - r) * 1.4;
        if (profile >= prev - 0.003) continue;
        if (stroke.lined) {
          const sd = d - r * 0.8;
          if (this.terrace[c] && sd > 0) this.sdf[c] = Math.max(this.sdf[c], -sd);
          else if (sd <= 0) this.sdf[c] = this.terrace[c] ? -sd : Math.min(this.sdf[c], -sd);
        }
        if (!stroke.lined) {
          // natural gully: plain soil, keeps whatever it was
        } else if (d <= r * 0.8) {
          this.channel[c] = 1;
          if (this.terrace[c]) this.setTerrace(c, 0);
        } else {
          this.wall[c] = 1;
        }
        cut += (prev - profile) * DX * DX;
        this._markDisturbed(c, this._g0[c], profile);
        this.setTarget(c, profile);
        this.dirtyBund.add(i, j, i, j);
      }
    }
    return { cut, fill };
  }

  pathDab(stroke, x, z) {
    const r = 0.95;
    const { gi, gj, i0, i1, j0, j1 } = this._box(x, z, r + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - gi, j - gj) * DX;
        if (d > r) continue;
        const c = i + j * N;
        if (this.path[c]) continue;
        this.path[c] = 1;
        this.dirtyMesh.add(i, j, i, j);
        // gently smooth raw ground under new paths (not terraces or channels)
        if (!this.terrace[c] && !this.channel[c] && i > 0 && j > 0 && i < N - 1 && j < N - 1) {
          const g = this.futureGround(c);
          const avg =
            (this.futureGround(c - 1) + this.futureGround(c + 1) + this.futureGround(c - N) + this.futureGround(c + N)) * 0.25;
          const target = g + (avg - g) * 0.5;
          if (Math.abs(target - g) > 0.01) this.setTarget(c, target);
        }
      }
    }
    this.version++;
    return { cut: 0, fill: 0 };
  }

  softenDab(stroke, x, z) {
    const R = stroke.R;
    const { gi, gj, i0, i1, j0, j1 } = this._box(x, z, R);
    let cut = 0;
    let fill = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - gi, j - gj) * DX;
        if (d > R) continue;
        const c = i + j * N;
        const w = 1 - d / R;
        const prev = this.futureGround(c);
        const target = prev + (this.base[c] - prev) * Math.min(1, 0.35 * w + 0.08);
        const sd = d - R * 0.75;
        if (sd <= 0) this.sdf[c] = this.terrace[c] ? -sd : Math.min(this.sdf[c], -sd);
        else if (this.terrace[c]) this.sdf[c] = Math.max(this.sdf[c], -sd);
        if (w > 0.25) {
          if (this.terrace[c]) this.setTerrace(c, 0);
          this.wall[c] = 0;
          this.channel[c] = 0;
          this.path[c] = 0;
        }
        const dv = (prev - target) * DX * DX;
        if (dv > 0) cut += dv;
        else fill -= dv;
        if (Math.abs(target - prev) > 0.002) {
          this._markDisturbed(c, prev, target);
          this.setTarget(c, target);
        }
        this.dirtyBund.add(i, j, i, j);
      }
    }
    this.dirtyMesh.add(i0, j0, i1, j1);
    return { cut, fill };
  }

  /** Used by world generation: raise ground to at least h (retained rock). */
  raiseDab(stroke, x, z) {
    const R = stroke.R;
    const { gi, gj, i0, i1, j0, j1 } = this._box(x, z, R);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - gi, j - gj) * DX;
        if (d > R) continue;
        const c = i + j * N;
        const target = stroke.level - (d / R) ** 2 * 0.6;
        if (target > this.futureGround(c)) {
          this.setTarget(c, target);
          this.wall[c] = 1;
        }
      }
    }
    return { cut: 0, fill: 0 };
  }

  endStroke() {
    this.flushBunds();
  }

  // ------------------------------------------------------------------ undo

  snapshot() {
    return {
      rock: this.rock.slice(),
      soil: this.soil.slice(),
      terrace: this.terrace.slice(),
      wall: this.wall.slice(),
      path: this.path.slice(),
      channel: this.channel.slice(),
      sdf: this.sdf.slice(),
      levels: this.levels.slice(),
    };
  }

  /** State as it will be once pending sculpting finishes. */
  futureSnapshot() {
    const s = this.snapshot();
    for (const c of this.active) s.rock[c] = this.tgt[c] - this.soil[c];
    return s;
  }

  /** Compact before/after record for undo; null if nothing changed. */
  diff(before, after) {
    let x0 = N;
    let z0 = N;
    let x1 = -1;
    let z1 = -1;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = i + j * N;
        if (
          Math.abs(before.rock[c] - after.rock[c]) > 1e-5 ||
          Math.abs(before.soil[c] - after.soil[c]) > 1e-5 ||
          before.terrace[c] !== after.terrace[c] ||
          before.wall[c] !== after.wall[c] ||
          before.path[c] !== after.path[c] ||
          before.channel[c] !== after.channel[c] ||
          before.sdf[c] !== after.sdf[c]
        ) {
          if (i < x0) x0 = i;
          if (i > x1) x1 = i;
          if (j < z0) z0 = j;
          if (j > z1) z1 = j;
        }
      }
    }
    if (x1 < x0) return null;
    const pick = (s) => {
      const w = x1 - x0 + 1;
      const h = z1 - z0 + 1;
      const out = {
        rock: new Float32Array(w * h),
        soil: new Float32Array(w * h),
        terrace: new Int16Array(w * h),
        wall: new Uint8Array(w * h),
        path: new Uint8Array(w * h),
        channel: new Uint8Array(w * h),
        sdf: new Float32Array(w * h),
      };
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const c = x0 + i + (z0 + j) * N;
          const k = i + j * w;
          out.rock[k] = s.rock[c];
          out.soil[k] = s.soil[c];
          out.terrace[k] = s.terrace[c];
          out.wall[k] = s.wall[c];
          out.path[k] = s.path[c];
          out.channel[k] = s.channel[c];
          out.sdf[k] = s.sdf[c];
        }
      }
      return out;
    };
    return {
      box: { x0, z0, x1, z1 },
      before: pick(before),
      after: pick(after),
      levelsBefore: before.levels,
      levelsAfter: after.levels,
    };
  }

  /** Apply one side of an undo record; the land eases into shape. */
  applyRecord(rec, side) {
    this.settle();
    const data = side === 'before' ? rec.before : rec.after;
    const levels = side === 'before' ? rec.levelsBefore : rec.levelsAfter;
    this.levels.set(levels);
    const { x0, z0, x1, z1 } = rec.box;
    const w = x1 - x0 + 1;
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const c = i + j * N;
        const k = i - x0 + (j - z0) * w;
        const target = data.rock[k] + data.soil[k];
        const prev = this.rock[c] + this.soil[c];
        this.terrace[c] = data.terrace[k];
        this.wall[c] = data.wall[k];
        this.path[c] = data.path[k];
        this.channel[c] = data.channel[k];
        this.sdf[c] = data.sdf[k];
        if (Math.abs(target - prev) > 1e-4) {
          this._markDisturbed(c, prev, target);
          // keep the recorded soil layer; ease the rock
          this.rock[c] = prev - data.soil[k];
          this.soil[c] = data.soil[k];
          this.tgt[c] = target;
          if (!this.activeFlag[c]) {
            this.activeFlag[c] = 1;
            this.active.push(c);
          }
        } else {
          this.rock[c] = data.rock[k];
          this.soil[c] = data.soil[k];
        }
      }
    }
    this.recount();
    this.refresh(x0, z0, x1, z1);
  }

  // ------------------------------------------------------------------ granular physics

  /**
   * Angle-of-repose relaxation: loose soil steeper than TALUS slumps downhill.
   * Retained cells (terraces, walls, channels) neither shed nor accept soil.
   */
  thermal(iterFrac = 0.22) {
    const { rock, soil, H, terrace, wall, channel } = this;
    let x0 = N;
    let z0 = N;
    let x1 = -1;
    let z1 = -1;
    const lim = TALUS * DX;
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const c = i + j * N;
        const s = soil[c];
        if (s <= 0.0005 || terrace[c] || wall[c] || channel[c]) continue;
        const h = H[c];
        // steepest lower neighbour
        let best = -1;
        let bestDrop = lim;
        let n = c - 1;
        if (h - H[n] > bestDrop && !terrace[n] && !wall[n] && !channel[n]) {
          bestDrop = h - H[n];
          best = n;
        }
        n = c + 1;
        if (h - H[n] > bestDrop && !terrace[n] && !wall[n] && !channel[n]) {
          bestDrop = h - H[n];
          best = n;
        }
        n = c - N;
        if (h - H[n] > bestDrop && !terrace[n] && !wall[n] && !channel[n]) {
          bestDrop = h - H[n];
          best = n;
        }
        n = c + N;
        if (h - H[n] > bestDrop && !terrace[n] && !wall[n] && !channel[n]) {
          bestDrop = h - H[n];
          best = n;
        }
        if (best < 0) continue;
        const m = Math.min(s, (bestDrop - lim) * iterFrac);
        if (m < 1e-4) continue;
        soil[c] -= m;
        soil[best] += m;
        H[c] = rock[c] + soil[c] + this.bund[c];
        H[best] = rock[best] + soil[best] + this.bund[best];
        if (i < x0) x0 = i;
        if (i > x1) x1 = i;
        if (j < z0) z0 = j;
        if (j > z1) z1 = j;
      }
    }
    if (x1 >= x0) {
      this.dirtyErode.add(x0 - 1, z0 - 1, x1 + 1, z1 + 1);
      this.version++;
      return true;
    }
    return false;
  }

  /** Drop a small mound of soil (e.g. a dissolved clod) at a world position. */
  depositSoil(x, z, volume) {
    const gi = Math.round((x + HALF) / DX);
    const gj = Math.round((z + HALF) / DX);
    if (gi < 1 || gj < 1 || gi > N - 2 || gj > N - 2) return false;
    const c0 = gi + gj * N;
    if (this.terrace[c0] || this.channel[c0]) return false;
    const share = volume / (DX * DX * 5);
    const cells = [c0, c0 - 1, c0 + 1, c0 - N, c0 + N];
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      if (this.terrace[c] || this.channel[c] || this.wall[c]) continue;
      this.soil[c] += k === 0 ? share * 1.6 : share * 0.85;
      this.H[c] = this.rock[c] + this.soil[c] + this.bund[c];
    }
    this.dirtyMesh.add(gi - 1, gj - 1, gi + 1, gj + 1);
    this.dirtyPhys.add(gi - 1, gj - 1, gi + 1, gj + 1);
    this.version++;
    return true;
  }

  /** Terrain slope magnitude (rise/run) at a cell. */
  slopeAt(c) {
    const i = c % N;
    const j = (c - i) / N;
    const H = this.H;
    const l = H[i > 0 ? c - 1 : c];
    const r = H[i < N - 1 ? c + 1 : c];
    const t = H[j > 0 ? c - N : c];
    const b = H[j < N - 1 ? c + N : c];
    return Math.hypot((r - l) / (2 * DX), (b - t) / (2 * DX));
  }

  /** Max |dh| from a cell to its 8 neighbours — "how flat is it here". */
  roughness(c) {
    const i = c % N;
    const j = (c - i) / N;
    if (i < 1 || j < 1 || i > N - 2 || j > N - 2) return 99;
    const H = this.H;
    const h = H[c];
    let m = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const d = Math.abs(H[c + di + dj * N] - h);
        if (d > m) m = d;
      }
    }
    return m;
  }
}

export { emptyBox };

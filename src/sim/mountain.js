// Procedural mountain: a misty peak with spurs and gullies, a spring pool held
// back by an old stone berm, five abandoned terraces waiting below it, a
// stream down to a lake at the foot, and a second free-flowing spring.

import { N, DX, HALF, BUND_H, clamp, toWorld } from './constants.js';
import { makeSimplex2D, fbm, ridged, smoothstep, mulberry32 } from './noise.js';
import { Terrain } from './terrain.js';

export const SUMMIT = { x: -4, z: -12 };

function polar(r, th) {
  return { x: SUMMIT.x + r * Math.sin(th), z: SUMMIT.z + r * Math.cos(th) };
}

function bilinear(arr, x, z) {
  const gx = clamp((x + HALF) / DX, 0, N - 1.001);
  const gz = clamp((z + HALF) / DX, 0, N - 1.001);
  const i = gx | 0;
  const j = gz | 0;
  const fx = gx - i;
  const fz = gz - j;
  const c = i + j * N;
  const a = arr[c] + (arr[c + 1] - arr[c]) * fx;
  const b = arr[c + N] + (arr[c + N + 1] - arr[c + N]) * fx;
  return a + (b - a) * fz;
}

/** First radius (walking outward from the summit) where height drops to `level`. */
function contourRadius(nat, th, level, rMin = 4, rMax = 76) {
  let prev = null;
  for (let r = rMin; r <= rMax; r += 0.25) {
    const p = polar(r, th);
    const h = bilinear(nat, p.x, p.z);
    if (h <= level) {
      if (prev === null) return r;
      // linear refine
      const t = (prev.h - level) / (prev.h - h);
      return prev.r + (r - prev.r) * t;
    }
    prev = { r, h };
  }
  return null;
}

export function naturalHeights(seed) {
  const noise = makeSimplex2D(seed);
  const noise2 = makeSimplex2D(seed + 101);
  const nat = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = toWorld(i);
      const z = toWorld(j);
      const wx = x + 9 * fbm(noise, x * 0.011, z * 0.011, 3);
      const wz = z + 9 * fbm(noise, x * 0.011 + 50, z * 0.011 - 20, 3);
      const r = Math.hypot(wx - SUMMIT.x, wz - SUMMIT.z);
      let h = 38 * Math.exp(-((r / 39) ** 2));
      h += 6 * Math.exp(-((r / 11) ** 2));
      const rg = ridged(noise2, wx * 0.03, wz * 0.03, 4);
      const mid = Math.exp(-((r / 46) ** 2)) * smoothstep(4, 16, r);
      h += (rg - 0.42) * 8 * mid;
      // a lower shoulder to the north-east
      h += 12 * Math.exp(-((Math.hypot(x - 40, z + 34) / 19) ** 2));
      // and a low ridge to the west, so the foot isn't a plain disc
      h += 5 * Math.exp(-((Math.hypot(x + 55, z + 5) / 16) ** 2));
      h += 1.1 * fbm(noise, x * 0.035, z * 0.035, 3) + 1.4;
      const e = Math.max(Math.abs(x), Math.abs(z));
      h -= 2.6 * smoothstep(60, 79, e);
      nat[i + j * N] = h;
    }
  }
  // soften cell-scale noise
  const tmp = new Float32Array(N * N);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let s = 0;
        let w = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
            const k = di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1;
            s += nat[ii + jj * N] * k;
            w += k;
          }
        }
        tmp[i + j * N] = s / w;
      }
    }
    nat.set(tmp);
  }
  return nat;
}

/** Follow the fall line from (x, z), steering away from given cells. */
function fallLine(terrain, x, z, opts = {}) {
  const pts = [{ x, z }];
  let dx = opts.dirX ?? 0;
  let dz = opts.dirZ ?? 0;
  const g = (px, pz) => terrain.sampleGround(px, pz);
  for (let k = 0; k < 260; k++) {
    const e = 0.8;
    let gx = (g(x + e, z) - g(x - e, z)) / (2 * e);
    let gz = (g(x, z + e) - g(x, z - e)) / (2 * e);
    let len = Math.hypot(gx, gz) || 1;
    let nx = -gx / len;
    let nz = -gz / len;
    const bias = opts.bias ? opts.bias(k, x, z) : null;
    if (bias) {
      nx += bias.x;
      nz += bias.z;
    }
    const inertia = k === 0 && opts.dirX !== undefined ? 1 : 0.55;
    nx = dx * inertia + nx * (1 - inertia * 0.5);
    nz = dz * inertia + nz * (1 - inertia * 0.5);
    len = Math.hypot(nx, nz) || 1;
    dx = nx / len;
    dz = nz / len;
    x += dx * 0.7;
    z += dz * 0.7;
    if (Math.abs(x) > HALF - 1 || Math.abs(z) > HALF - 1) break;
    pts.push({ x, z });
    if (opts.stopBelow !== undefined && g(x, z) < opts.stopBelow) break;
  }
  return pts;
}

/** Priority-flood: water surface each depression would hold if filled to spill. */
export function fillLevels(H) {
  const filled = new Float32Array(H.length);
  const done = new Uint8Array(H.length);
  // binary heap of [height, cell]
  const heapH = [];
  const heapC = [];
  const push = (h, c) => {
    heapH.push(h);
    heapC.push(c);
    let i = heapH.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapH[p] <= heapH[i]) break;
      [heapH[p], heapH[i]] = [heapH[i], heapH[p]];
      [heapC[p], heapC[i]] = [heapC[i], heapC[p]];
      i = p;
    }
  };
  const pop = () => {
    const h = heapH[0];
    const c = heapC[0];
    const lh = heapH.pop();
    const lc = heapC.pop();
    if (heapH.length) {
      heapH[0] = lh;
      heapC[0] = lc;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapH.length && heapH[l] < heapH[m]) m = l;
        if (r < heapH.length && heapH[r] < heapH[m]) m = r;
        if (m === i) break;
        [heapH[m], heapH[i]] = [heapH[i], heapH[m]];
        [heapC[m], heapC[i]] = [heapC[i], heapC[m]];
        i = m;
      }
    }
    return [h, c];
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (i === 0 || j === 0 || i === N - 1 || j === N - 1) {
        const c = i + j * N;
        done[c] = 1;
        filled[c] = H[c];
        push(H[c], c);
      }
    }
  }
  while (heapH.length) {
    const [h, c] = pop();
    const i = c % N;
    const j = (c - i) / N;
    const nb = [i > 0 ? c - 1 : -1, i < N - 1 ? c + 1 : -1, j > 0 ? c - N : -1, j < N - 1 ? c + N : -1];
    for (const n of nb) {
      if (n < 0 || done[n]) continue;
      done[n] = 1;
      const fh = Math.max(H[n], h);
      filled[n] = fh;
      push(fh, n);
    }
  }
  return filled;
}

/**
 * Build the demo mountain. Returns { terrain, springs, features, trees, water0 }.
 * water0 is an initial depth field (lake + pools pre-filled).
 */
export function generateMountain(seed = 7) {
  const terrain = new Terrain();
  const nat = naturalHeights(seed);
  const rand = mulberry32(seed * 31 + 5);
  terrain.rock.set(nat);
  terrain.soil.fill(0);
  terrain.refreshAll();

  // ------------------------------------------------ the old terraces
  const thPool = 0.16; // the spring pool sits on the south flank (facing the camera)
  const rPool = 30;
  const poolC = polar(rPool, thPool);
  const hPool = bilinear(nat, poolC.x, poolC.z);
  const P = hPool - 0.9; // pool floor
  const down = { x: Math.sin(thPool), z: Math.cos(thPool) }; // away from summit
  const along = { x: Math.cos(thPool), z: -Math.sin(thPool) }; // east along the contour
  const poolLen = 4.2; // half-length along the contour
  const poolW = 2.1;

  // the stream: follow the natural fall line from the pool's east outlet first,
  // so the old terraces can be laid out safely to the west of it
  const outlet = { x: poolC.x + along.x * (poolLen + 0.4), z: poolC.z + along.z * (poolLen + 0.4) };
  const sill = P + 0.2;
  const gullyStart = { x: outlet.x + along.x * 2.6 + down.x * 1.0, z: outlet.z + along.z * 2.6 + down.z * 1.0 };
  const gully = fallLine(terrain, gullyStart.x, gullyStart.z, {
    dirX: down.x * 0.5 + along.x * 0.85,
    dirZ: down.z * 0.5 + along.z * 0.85,
    stopBelow: 2.6,
    bias: (k) => (k < 10 ? { x: along.x * 0.6, z: along.z * 0.6 } : null),
  });
  const gullyPolar = gully.map((p) => ({
    r: Math.hypot(p.x - SUMMIT.x, p.z - SUMMIT.z),
    th: Math.atan2(p.x - SUMMIT.x, p.z - SUMMIT.z),
  }));
  const eastLimit = (r) => {
    let lim = Infinity;
    for (const g of gullyPolar) if (Math.abs(g.r - r) < 3) lim = Math.min(lim, g.th);
    return lim;
  };

  const R = 2.4;
  const thSpan = [
    [thPool - 0.5, thPool + 0.1],
    [thPool - 0.46, thPool + 0.14],
    [thPool - 0.5, thPool + 0.12],
    [thPool - 0.42, thPool + 0.16],
    [thPool - 0.36, thPool + 0.1],
  ];
  const ancient = [];
  let level = P - 3.4;
  const clearOfPool = (p) => {
    const rx = p.x - poolC.x;
    const rz = p.z - poolC.z;
    const a = rx * along.x + rz * along.z;
    const b = rx * down.x + rz * down.z;
    return Math.hypot(a / (poolLen + R + 1.4), b / (poolW * 1.9 + R + 1.2)) >= 1;
  };
  for (let k = 0; k < 5; k++) {
    const [a, b] = thSpan[k];
    const pts = [];
    for (let th = a; th <= b + 1e-6; th += 0.01) {
      const r = contourRadius(nat, th, level, rPool - 6);
      if (r === null) continue;
      if (th > eastLimit(r) - (R + 4) / r) continue;
      const p = polar(r, th);
      if (!clearOfPool(p)) continue;
      pts.push(p);
    }
    if (pts.length < 3) break;
    const s = terrain.beginStroke('terrace', pts[0].x, pts[0].z, { radius: R, level });
    for (const p of pts) terrain.strokeTo(s, p.x, p.z);
    terrain.endStroke();
    terrain.settle();
    ancient.push({ tid: s.tid, level, pts });
    // next terrace: one riser further down the fall line
    const thMid = (a + b) / 2;
    const rMid = contourRadius(nat, thMid, level, rPool - 6) ?? rPool;
    const pNext = polar(rMid + 2 * R + 0.9, thMid);
    const step = clamp(level - bilinear(nat, pNext.x, pNext.z), 1.5, 2.8);
    level -= step;
  }

  // ------------------------------------------------ spring pool + berm
  const poolCells = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = toWorld(i);
      const z = toWorld(j);
      const rx = x - poolC.x;
      const rz = z - poolC.z;
      const a = rx * along.x + rz * along.z;
      const b = rx * down.x + rz * down.z;
      const e = Math.hypot(a / poolLen, b / poolW);
      const c = i + j * N;
      if (terrain.terrace[c]) continue;
      if (e <= 1) {
        const floor = P + e * e * 0.2;
        terrain.setTarget(c, floor);
        terrain.channel[c] = 1; // open water: terraces never bund against it
        poolCells.push(c);
      } else if (e <= 1.9) {
        // a stone rim all the way round: a berm on the downhill side, a cut
        // face on the uphill side, never lower than the retaining crest
        const crest = P + 1.45 - Math.max(0, e - 1.3) * 1.5;
        let target = Math.max(terrain.futureGround(c), crest);
        if (b < -0.4 * poolW) target = Math.min(target, Math.max(crest, P + 1.5 + (e - 1) * 3));
        if (Math.abs(target - terrain.futureGround(c)) > 1e-3) terrain.setTarget(c, target);
        terrain.wall[c] = 1;
      }
    }
  }
  terrain.settle();

  // outlet notch at the east end with its sill a touch above the floor
  {
    const s = terrain.beginStroke('channel', outlet.x, outlet.z, { depth: 0, width: 1.8, lined: true });
    s.bed = sill;
    terrain.strokeTo(s, outlet.x, outlet.z);
    terrain.strokeTo(s, gullyStart.x, gullyStart.z);
    terrain.endStroke();
    terrain.settle();
  }
  {
    const s = terrain.beginStroke('channel', gully[0].x, gully[0].z, { depth: 0.9, width: 1.9, lined: false });
    s.bed = sill - 0.2;
    for (const p of gully) terrain.strokeTo(s, p.x, p.z);
    terrain.endStroke();
    terrain.settle();
  }

  // ------------------------------------------------ lake at the foot of the stream
  const end = gully[gully.length - 1];
  let lake = null;
  if (Math.abs(end.x) < 70 && Math.abs(end.z) < 70 && terrain.sampleGround(end.x, end.z) < 6) {
    const last = gully[Math.max(0, gully.length - 6)];
    const dirx = end.x - last.x;
    const dirz = end.z - last.z;
    const dl = Math.hypot(dirx, dirz) || 1;
    lake = { x: clamp(end.x + (dirx / dl) * 7, -62, 62), z: clamp(end.z + (dirz / dl) * 7, -62, 62), r: 10 };
    const floorL = terrain.sampleGround(end.x, end.z) - 2.4;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = toWorld(i);
        const z = toWorld(j);
        const d = Math.hypot((x - lake.x) * 0.85, z - lake.z);
        if (d > lake.r + 4) continue;
        const c = i + j * N;
        if (terrain.terrace[c]) continue;
        const t = d / (lake.r + 4);
        const h = floorL + t * t * 3.2;
        if (h < terrain.futureGround(c)) terrain.setTarget(c, h);
      }
    }
    terrain.settle();
  }

  // ------------------------------------------------ second spring (north-west), free flowing
  const thB = -2.35;
  const springB = polar(13, thB);
  const gullyB = fallLine(terrain, springB.x, springB.z, { stopBelow: 2.5 });
  {
    const s = terrain.beginStroke('channel', gullyB[0].x, gullyB[0].z, { depth: 0.6, width: 1.6, lined: false });
    for (const p of gullyB) terrain.strokeTo(s, p.x, p.z);
    terrain.endStroke();
    terrain.settle();
  }

  // ------------------------------------------------ soil
  // loose soil everywhere that isn't stone-faced; thin on steep ground
  const { rock, soil, terrace, wall, channel } = terrain;
  for (let c = 0; c < terrain.n; c++) {
    if (terrace[c] || wall[c] || channel[c]) continue;
    const sl = terrain.slopeAt(c);
    const s = 0.65 * (1 - smoothstep(0.45, 1.3, sl)) + 0.05;
    const g = rock[c] + soil[c];
    soil[c] = s;
    rock[c] = g - s;
  }
  terrain.refreshAll();
  for (let k = 0; k < 60; k++) terrain.thermal(0.3);
  terrain.refreshAll();
  terrain.recount();
  for (let c = 0; c < terrain.n; c++) terrain.base[c] = rock[c] + soil[c];

  // ------------------------------------------------ initial water
  const water0 = new Float32Array(terrain.n);
  const filled = fillLevels(terrain.H);
  for (let c = 0; c < terrain.n; c++) {
    const d = filled[c] - terrain.H[c];
    if (d > 0.04) water0[c] = d;
  }
  // old terraces hold a little stale rainwater — not enough to spill
  for (const a of ancient) {
    for (let c = 0; c < terrain.n; c++) {
      if (terrace[c] === a.tid) water0[c] = Math.max(0, a.level + BUND_H * 0.32 - terrain.H[c]);
    }
  }

  // ------------------------------------------------ trees
  const trees = [];
  const noiseT = makeSimplex2D(seed + 77);
  const near = (c, r) => {
    const i = c % N;
    const j = (c - i) / N;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) return true;
        const k = ii + jj * N;
        if (terrace[k] || wall[k] || channel[k] || water0[k] > 0.05) return true;
      }
    }
    return false;
  };
  for (let tries = 0; tries < 9000 && trees.length < 520; tries++) {
    const x = (rand() * 2 - 1) * (HALF - 4);
    const z = (rand() * 2 - 1) * (HALF - 4);
    const gi = Math.round((x + HALF) / DX);
    const gj = Math.round((z + HALF) / DX);
    const c = gi + gj * N;
    const h = terrain.H[c];
    const sl = terrain.slopeAt(c);
    if (h < 3.2 || sl > 1.15) continue;
    const forest = fbm(noiseT, x * 0.03, z * 0.03, 3);
    const band = smoothstep(6, 16, h) * (1 - smoothstep(36, 44, h));
    const p = band * smoothstep(-0.25, 0.35, forest) + 0.06;
    if (rand() > p) continue;
    if (near(c, 2)) continue;
    // keep the camera-facing approach to the old terraces open
    const dx = x - poolC.x;
    const dz = z - poolC.z;
    if (Math.hypot(dx, dz) < 9) continue;
    let ok = true;
    for (const t of trees) {
      if ((t.x - x) ** 2 + (t.z - z) ** 2 < 2.4) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    trees.push({ x, z, s: 0.75 + rand() * 0.6, kind: rand() < 0.3 + 0.4 * smoothstep(20, 34, h) ? 1 : 0, seed: rand() });
  }

  const springs = [
    { x: poolC.x - along.x * 2.2, z: poolC.z - along.z * 2.2, rate: 5.5, name: 'Morning Spring' },
    { x: springB.x, z: springB.z, rate: 2.2, name: 'Mossy Spring' },
  ];

  return {
    terrain,
    springs,
    water0,
    trees,
    features: {
      pool: { x: poolC.x, z: poolC.z, level: P, sill, cells: poolCells, along, down, len: poolLen, w: poolW },
      ancient,
      gully,
      lake,
      // a suggested first cut: from the spring straight down into the top old terrace
      hintCut: (() => {
        const a = ancient[0];
        const start = { x: poolC.x - along.x * 1.6, z: poolC.z - along.z * 1.6 };
        let best = a.pts[0];
        let bd = Infinity;
        for (const p of a.pts) {
          const d = (p.x - start.x) ** 2 + (p.z - start.z) ** 2;
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return { from: start, to: best };
      })(),
    },
  };
}

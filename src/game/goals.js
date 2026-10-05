// Light goals for the mountain. Nothing is ever lost; goals only ever tick
// forward, and once all are met the mountain is simply yours.
import { N, BUND_H } from '../sim/constants.js';

export function wateredTerraces(terrain, water) {
  const n = terrain.counts;
  // a terrace counts as watered once it holds most of a full paddy's worth
  const vol = new Float32Array(n.length);
  const { terrace } = terrain;
  const d = water.d;
  for (let c = 0; c < terrain.n; c++) {
    const t = terrace[c];
    if (t) vol[t] += Math.min(d[c], BUND_H * 1.5);
  }
  let count = 0;
  const list = [];
  for (let t = 1; t < n.length; t++) {
    if (n[t] >= 14 && vol[t] / (n[t] * BUND_H) > 0.5) {
      count++;
      list.push(t);
    }
  }
  return { count, list };
}

/** Do two hamlets share a footpath? BFS over path cells between them. */
export function hamletsJoined(terrain, hamlets, cellOf) {
  const big = hamlets.filter((h) => h.houses.length >= 2);
  if (big.length < 2) return false;
  const path = terrain.path;
  const label = new Int16Array(N * N).fill(-1);
  const touches = new Map();
  for (let hi = 0; hi < big.length; hi++) {
    for (const h of big[hi].houses) {
      const c0 = cellOf(h.x, h.z);
      if (c0 < 0) continue;
      for (let dj = -3; dj <= 3; dj++) {
        for (let di = -3; di <= 3; di++) {
          const c = c0 + di + dj * N;
          if (c < 0 || c >= N * N || !path[c]) continue;
          if (!touches.has(c)) touches.set(c, new Set());
          touches.get(c).add(hi);
        }
      }
    }
  }
  let comp = 0;
  for (const start of touches.keys()) {
    if (label[start] >= 0) continue;
    const seen = new Set();
    const q = [start];
    label[start] = comp;
    while (q.length) {
      const c = q.pop();
      const t = touches.get(c);
      if (t) for (const h of t) seen.add(h);
      if (seen.size >= 2) return true;
      const i = c % N;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          if ((i === 0 && di < 0) || (i === N - 1 && di > 0)) continue;
          const n = c + di + dj * N;
          if (n < 0 || n >= N * N || !path[n] || label[n] >= 0) continue;
          label[n] = comp;
          q.push(n);
        }
      }
    }
    comp++;
  }
  return false;
}

export class Goals {
  constructor() {
    this.tiers = [
      {
        name: 'The Morning Spring',
        goals: [
          { id: 'cascade', text: 'Lead the spring down five terraces', target: 5, value: 0, done: false },
          { id: 'rice', text: 'Grow forty rice plants in flooded paddies', target: 40, value: 0, done: false },
          { id: 'hamlet', text: 'Welcome a hamlet of six homes', target: 6, value: 0, done: false },
        ],
      },
      {
        name: 'A Living Mountain',
        goals: [
          { id: 'tea', text: 'Grow twenty tea bushes where water seeps but never pools', target: 20, value: 0, done: false },
          { id: 'flowers', text: 'Let thirty flowers bloom', target: 30, value: 0, done: false },
          { id: 'join', text: 'Join two hamlets with a footpath', target: 1, value: 0, done: false },
        ],
      },
    ];
    this.tier = 0;
    this.finished = false;
    this.onComplete = null; // (goal)
    this.onTier = null; // (tier)
  }

  get current() {
    return this.tiers[Math.min(this.tier, this.tiers.length - 1)];
  }

  set(id, value) {
    for (const tier of this.tiers) {
      for (const g of tier.goals) {
        if (g.id !== id) continue;
        g.value = Math.max(g.value, Math.min(value, g.target));
        if (!g.done && g.value >= g.target) {
          g.done = true;
          if (this.onComplete) this.onComplete(g);
        }
      }
    }
    const cur = this.tiers[this.tier];
    if (cur && cur.goals.every((g) => g.done)) {
      const finished = this.tier;
      this.tier++;
      if (this.tier >= this.tiers.length) this.finished = true;
      if (this.onTier) this.onTier(finished);
    }
  }

  serialize() {
    return { tier: this.tier, values: this.tiers.map((t) => t.goals.map((g) => [g.value, g.done])) };
  }

  load(s) {
    if (!s) return;
    this.tier = s.tier;
    this.finished = this.tier >= this.tiers.length;
    s.values.forEach((tv, ti) =>
      tv.forEach(([v, d], gi) => {
        const g = this.tiers[ti]?.goals[gi];
        if (g) {
          g.value = v;
          g.done = d;
        }
      })
    );
  }
}

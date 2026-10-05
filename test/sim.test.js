import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/sim/terrain.js';
import { WaterSim } from '../src/sim/water.js';
import { generateMountain } from '../src/sim/mountain.js';
import { N, DX, HALF, BUND_H } from '../src/sim/constants.js';

function bowl() {
  const t = new Terrain();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = i * DX - HALF;
      const z = j * DX - HALF;
      t.rock[i + j * N] = 10 + (x * x + z * z) * 0.002;
    }
  }
  t.refreshAll();
  return t;
}

function slope() {
  const t = new Terrain();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      t.rock[i + j * N] = 40 - j * DX * 0.5; // descends toward +z
    }
  }
  t.refreshAll();
  return t;
}

test('pipe model conserves water in a closed bowl', () => {
  const t = bowl();
  const w = new WaterSim(t, { evap: 0, infil: 0, erosion: false });
  // a column of water off-centre sloshes around
  for (let j = 70; j < 80; j++) for (let i = 50; i < 60; i++) w.d[i + j * N] = 2;
  const v0 = w.totalVolume();
  for (let k = 0; k < 6000; k++) w.step();
  const v1 = w.totalVolume();
  assert.ok(Math.abs(v1 - v0) / v0 < 1e-4, `volume drifted ${v0} -> ${v1}`);
  assert.equal(w.drained, 0);
  // and it settles toward a flat surface in the middle
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 75; j < 85; j++) {
    for (let i = 75; i < 85; i++) {
      const c = i + j * N;
      lo = Math.min(lo, t.H[c] + w.d[c]);
      hi = Math.max(hi, t.H[c] + w.d[c]);
    }
  }
  assert.ok(hi - lo < 0.05, `surface not flat: ${hi - lo}`);
  for (let c = 0; c < t.n; c++) assert.ok(w.d[c] >= 0);
});

test('a carved terrace holds water up to its bund and spills over', () => {
  const t = slope();
  const s = t.beginStroke('terrace', 0, 0, { radius: 3 });
  for (let x = -12; x <= 12; x += 1) t.strokeTo(s, x, 0);
  t.endStroke();
  t.settle();
  const tid = s.tid;
  assert.ok(tid > 0);
  assert.ok(t.counts[tid] > 100, 'terrace has cells');
  // interior is flat at the level
  const c0 = Math.round(HALF / DX) + Math.round(HALF / DX) * N;
  assert.equal(t.terrace[c0], tid);
  assert.ok(Math.abs(t.H[c0] - s.level) < 1e-3);
  // downhill rim has a bund, uphill side does not need one
  let rims = 0;
  for (let c = 0; c < t.n; c++) if (t.terrace[c] === tid && t.bund[c] > 0) rims++;
  assert.ok(rims > 10, 'bunds were raised');

  const w = new WaterSim(t, { evap: 0, infil: 0, erosion: false });
  w.addSpring(0, -1, 3);
  for (let k = 0; k < 2500; k++) w.step();
  // the paddy should be full to (roughly) its lowest bund, with water escaping downhill
  let vol = 0;
  let n = 0;
  for (let c = 0; c < t.n; c++) {
    if (t.terrace[c] === tid) {
      vol += w.d[c];
      n++;
    }
  }
  const fill = vol / (n * BUND_H);
  assert.ok(fill > 0.4, `paddy should be flooded, fill=${fill}`);
  let below = 0;
  for (let j = Math.round(HALF / DX) + 6; j < N - 2; j++) below += w.d[Math.round(HALF / DX) + j * N];
  assert.ok(below > 0 || w.drained > 0, 'overflow continues downhill');
});

test('channel bed only ever descends along the stroke', () => {
  const t = slope();
  // drag uphill (within the depth limit): the channel cuts deeper instead of climbing
  const s = t.beginStroke('channel', 0, 10, {});
  for (let z = 10; z >= 5.5; z -= 0.5) t.strokeTo(s, 0, z);
  t.endStroke();
  t.settle();
  const i = Math.round(HALF / DX);
  let prev = Infinity;
  for (let z = 10; z >= 6; z -= 1) {
    const j = Math.round((z + HALF) / DX);
    const h = t.H[i + j * N];
    assert.ok(h <= prev + 0.05, `bed rose at z=${z}: ${h} > ${prev}`);
    prev = h;
  }
});

test('undo restores the land', () => {
  const t = slope();
  const before = t.snapshot();
  const s = t.beginStroke('terrace', 0, 0, { radius: 3 });
  t.strokeTo(s, 5, 0);
  t.endStroke();
  const rec = t.diff(before, t.futureSnapshot());
  assert.ok(rec);
  t.settle();
  t.applyRecord(rec, 'before');
  t.settle();
  for (let c = 0; c < t.n; c++) {
    assert.ok(Math.abs(t.rock[c] + t.soil[c] - (before.rock[c] + before.soil[c])) < 1e-4);
    assert.equal(t.terrace[c], 0);
  }
});

test('undo records only what the stroke touched, not erosion elsewhere', () => {
  const t = slope();
  const before = t.snapshot();
  const s = t.beginStroke('terrace', 0, 0, { radius: 3 });
  t.strokeTo(s, 4, 0);
  // meanwhile a stream far away moves a little soil
  for (let k = 0; k < 50; k++) t.soil[5 + (140 - k) * N] += 0.05;
  t.endStroke();
  const rec = t.diff(before, t.futureSnapshot());
  assert.ok(rec);
  const { x0, z0, x1, z1 } = rec.box;
  assert.ok(x1 - x0 < 20 && z1 - z0 < 20, `record box should stay local: ${JSON.stringify(rec.box)}`);
});

test('demo mountain: the spring stays in its pool until a cut leads it to the old terraces', () => {
  const m = generateMountain(7);
  const { terrain, features } = m;
  assert.equal(features.ancient.length, 5);
  const w = new WaterSim(terrain);
  w.d.set(m.water0);
  for (const s of m.springs) w.addSpring(s.x, s.z, s.rate, s.name);
  const fill = () =>
    features.ancient.map((a) => {
      let vol = 0;
      let n = 0;
      for (let c = 0; c < terrain.n; c++) {
        if (terrain.terrace[c] === a.tid) {
          vol += w.d[c];
          n++;
        }
      }
      return vol / (n * BUND_H);
    });
  for (let k = 0; k < 1500; k++) w.step();
  const dry = fill();
  for (const f of dry) assert.ok(f < 0.35, `old terraces stay unwatered before the cut: ${dry}`);

  const h = features.hintCut;
  const s = terrain.beginStroke('channel', h.from.x, h.from.z, {});
  for (let k = 0; k <= 20; k++) {
    const f = k / 20;
    terrain.strokeTo(s, h.from.x + (h.to.x - h.from.x) * f, h.from.z + (h.to.z - h.from.z) * f);
  }
  terrain.endStroke();
  terrain.settle();
  for (let k = 0; k < 4000; k++) w.step();
  const wet = fill();
  for (const f of wet) assert.ok(f > 0.5, `all five terraces flood after the cut: ${wet}`);
});

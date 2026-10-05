// Tools: shape the land (terrace, channel, path, soften) or sow seeds from
// the pouch. Seeds are real rigid bodies — they arc, bounce, roll downhill
// off slopes that are too steep, sink in paddies, and take root where they
// come to rest. Every stroke can be undone.
import { RICE, TEA, FLOWER } from './crops.js';

export const TOOLS = {
  terrace: { label: 'Terrace', radius: 3, min: 1.6, max: 6, color: '#fff3df' },
  channel: { label: 'Channel', radius: 1.6, min: 1, max: 3, color: '#cfe8f2' },
  plant: { label: 'Sow', radius: 2.4, min: 1, max: 6, color: '#e7f5c8' },
  path: { label: 'Path', radius: 1, min: 1, max: 1, color: '#f5e1bc' },
  soften: { label: 'Soften', radius: 4, min: 2, max: 8, color: '#e9dff5' },
};

export class Tools {
  constructor(game) {
    this.g = game;
    this.tool = 'terrace';
    this.seed = RICE;
    this.radius = {};
    for (const k in TOOLS) this.radius[k] = TOOLS[k].radius;
    this.stroke = null;
    this.before = null;
    this.down = false;
    this.hit = null;
    this.sowAcc = 0;
    this.sowIds = null;
    this.undoStack = [];
    this.redoStack = [];
    this.strokeCount = 0;
    this.onChange = null;
    this.onStroke = null; // (tool, info)
  }

  get r() {
    return this.radius[this.tool];
  }

  setRadius(v) {
    const t = TOOLS[this.tool];
    this.radius[this.tool] = Math.min(t.max, Math.max(t.min, v));
    if (this.onChange) this.onChange();
  }

  setTool(t) {
    if (this.down) this.end();
    this.tool = t;
    if (this.onChange) this.onChange();
  }

  setSeed(s) {
    this.seed = s;
    if (this.onChange) this.onChange();
  }

  begin(hit) {
    this.down = true;
    this.hit = hit;
    const g = this.g;
    if (this.tool === 'plant') {
      this.sowIds = { type: 'plant', ids: [], seedTag: ++this.strokeCount };
      this.sowAcc = 0.99;
      return;
    }
    this.before = g.terrain.snapshot();
    this.stroke = g.terrain.beginStroke(this.tool, hit.x, hit.z, { radius: this.r });
    this.strokeCount++;
    if (this.onStroke) this.onStroke('begin', this.tool, this.stroke);
  }

  move(hit) {
    this.hit = hit;
  }

  /** Called every frame while held: apply dabs / throw seeds. */
  update(dt) {
    if (!this.down || !this.hit) return;
    const g = this.g;
    if (this.tool === 'plant') {
      this.sowAcc += dt * 22;
      while (this.sowAcc >= 1) {
        this.sowAcc -= 1;
        this._throwSeed();
      }
      return;
    }
    if (!this.stroke) return;
    if (this.tool === 'path') {
      const pts = (this.stroke.pts = this.stroke.pts || []);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - this.hit.x, last.z - this.hit.z) > 0.3) pts.push({ x: this.hit.x, z: this.hit.z });
    }
    const res = g.terrain.strokeTo(this.stroke, this.hit.x, this.hit.z);
    if (res.cut > 0 || res.fill > 0) g.onSculpt(this.tool, this.hit, res, this.stroke);
  }

  _throwSeed() {
    const g = this.g;
    const h = this.hit;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * this.r;
    const tx = h.x + Math.cos(a) * r;
    const tz = h.z + Math.sin(a) * r;
    // toss from above the cursor so seeds visibly arc down
    const sx = h.x + (Math.random() - 0.5) * 0.4;
    const sz = h.z + (Math.random() - 0.5) * 0.4;
    const sy = g.groundAt(sx, sz) + 3.2;
    const T = 0.62; // time to land, roughly
    const gy = 18;
    const ty = g.groundAt(tx, tz);
    const vy = (ty - sy + 0.5 * gy * T * T) / T;
    if (this.sowIds) this.sowIds.thrown = (this.sowIds.thrown || 0) + 1;
    const e = g.physics.add('seed', sx, sy, sz, {
      r: this.seed === TEA ? 0.11 : 0.085,
      density: this.seed === FLOWER ? 0.8 : 1.25,
      vel: { x: (tx - sx) / T, y: vy, z: (tz - sz) / T },
      damping: 0.15,
      angularDamping: 2.5,
      restitution: 0.18,
      friction: 1.6,
      life: 10,
      data: { seed: this.seed, tag: this.sowIds },
    });
    if (g.physics.count('seed') > 160) {
      const old = g.physics.oldest('seed');
      if (old && old !== e) g.physics.dissolve(old);
    }
    g.audio?.seed();
  }

  end() {
    if (!this.down) return;
    this.down = false;
    const g = this.g;
    if (this.tool === 'plant') {
      if (this.sowIds && this.sowIds.thrown) {
        this.undoStack.push(this.sowIds);
        this.redoStack.length = 0;
      }
      this.sowIds = null;
      if (this.onChange) this.onChange();
      return;
    }
    if (!this.stroke) return;
    g.terrain.endStroke();
    const rec = g.terrain.diff(this.before, g.terrain.futureSnapshot());
    if (rec) {
      this.undoStack.push({ type: 'land', rec });
      if (this.undoStack.length > 80) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    if (this.onStroke) this.onStroke('end', this.tool, this.stroke);
    if (this.tool === 'path' && this.stroke.pts) g.structures?.pathStroke(this.stroke.pts);
    this.stroke = null;
    this.before = null;
    if (this.onChange) this.onChange();
  }

  /** Abort a stroke that turned into a two-finger gesture. */
  cancel() {
    if (!this.down) return;
    const before = this.undoStack.length;
    this.end();
    if (this.undoStack.length > before) {
      this.undo();
      this.redoStack.pop();
    }
  }

  undo() {
    if (this.down) this.end();
    const e = this.undoStack.pop();
    if (!e) return false;
    const g = this.g;
    if (e.type === 'land') {
      g.terrain.applyRecord(e.rec, 'before');
    } else if (e.type === 'plant') {
      e.removed = [];
      for (const id of e.ids) {
        const p = g.crops.removeById(id);
        if (p) e.removed.push(p);
      }
    }
    this.redoStack.push(e);
    if (this.onChange) this.onChange();
    return true;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    const g = this.g;
    if (e.type === 'land') {
      g.terrain.applyRecord(e.rec, 'after');
    } else if (e.type === 'plant') {
      e.ids = [];
      for (const p of e.removed || []) {
        const id = g.crops.plant(p.type, p.x, p.z, { force: true });
        if (id) e.ids.push(id);
      }
    }
    this.undoStack.push(e);
    if (this.onChange) this.onChange();
    return true;
  }
}

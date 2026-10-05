// Trees that sway on the wind-spring field, and a small flock of birds
// steering as boids (separation / alignment / cohesion) around the peak.
import * as THREE from 'three';
import { HALF } from '../sim/constants.js';
import { patchMaterial } from '../render/shaders.js';
import { treeGeometry, birdGeometry } from '../render/models.js';
import { P_PETAL } from '../render/particles.js';

export class Trees {
  constructor(scene, list, ground, particles) {
    this.ground = ground;
    this.particles = particles;
    this.list = list.map((t) => ({ ...t, alive: true }));
    this.meshes = [0, 1].map((kind) => {
      const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), {
        key: 'tree' + kind,
        sway: 0.22,
        swayHeight: 3.0,
      });
      const m = new THREE.InstancedMesh(treeGeometry(kind), mat, this.list.length + 1);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
      return m;
    });
    this.dirty = true;
  }

  /** Remove trees on reshaped cells (they drop their leaves as they go). */
  clearCells(cells, cellOf) {
    if (!cells.length) return;
    const set = new Set(cells);
    for (const t of this.list) {
      if (!t.alive) continue;
      if (set.has(cellOf(t.x, t.z))) this._fell(t);
    }
  }

  clearAround(x, z, r) {
    for (const t of this.list) {
      if (t.alive && (t.x - x) ** 2 + (t.z - z) ** 2 < r * r) this._fell(t);
    }
  }

  _fell(t) {
    t.alive = false;
    this.dirty = true;
    const y = this.ground(t.x, t.z) + 1.5 * t.s;
    for (let i = 0; i < 16; i++) {
      this.particles.spawn(P_PETAL, t.x + (Math.random() - 0.5) * 1.5, y + Math.random(), t.z + (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2, 3 + Math.random() * 2, 0.32, 0.42 + Math.random() * 0.15, 0.6 + Math.random() * 0.15, 0.3, 0.9);
    }
  }

  refreshHeights() {
    this.dirty = true;
  }

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const counts = [0, 0];
    for (const t of this.list) {
      if (!t.alive) continue;
      const mesh = this.meshes[t.kind];
      const k = counts[t.kind]++;
      q.setFromAxisAngle(up, t.seed * 6.28);
      s.set(t.s, t.s * (0.9 + t.seed * 0.25), t.s);
      p.set(t.x, this.ground(t.x, t.z) - 0.1, t.z);
      m.compose(p, q, s);
      mesh.setMatrixAt(k, m);
      c.setHSL(0.25 + t.seed * 0.06, 0.25 + t.seed * 0.15, 0.5 + t.seed * 0.08);
      c.multiplyScalar(1.6);
      mesh.setColorAt(k, c);
    }
    this.meshes.forEach((mesh, kind) => {
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  serialize() {
    return this.list.map((t) => (t.alive ? 1 : 0));
  }

  load(alive) {
    alive.forEach((a, i) => {
      if (this.list[i]) this.list[i].alive = !!a;
    });
    this.dirty = true;
  }
}

export class Birds {
  constructor(scene, count = 22) {
    this.b = [];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.b.push({
        p: new THREE.Vector3(Math.cos(a) * 60, 38 + Math.random() * 8, Math.sin(a) * 60),
        v: new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(6),
        phase: Math.random() * 10,
      });
    }
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 }), {
      key: 'bird',
      extraVertex: '',
      onShader: (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float flap = sin(uTime * 9.0 + float(gl_InstanceID) * 1.7);
           transformed.y += abs(transformed.x) * flap * 0.55;`
        );
      },
    });
    this.mesh = new THREE.InstancedMesh(birdGeometry(), mat, count);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.goal = new THREE.Vector3();
    this.t = 0;
    this.excite = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1.3, 1.3, 1.3);
    this._f = new THREE.Vector3(0, 0, 1);
  }

  update(dt, ground, wind) {
    this.t += dt;
    this.excite = Math.max(0, this.excite - dt * 0.05);
    const r = 55 - this.excite * 25;
    this.goal.set(Math.cos(this.t * 0.05) * r, 34 + Math.sin(this.t * 0.13) * 6 - this.excite * 6, Math.sin(this.t * 0.05) * r);
    const sep = new THREE.Vector3();
    const ali = new THREE.Vector3();
    const coh = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    for (const a of this.b) {
      sep.set(0, 0, 0);
      ali.set(0, 0, 0);
      coh.set(0, 0, 0);
      let n = 0;
      for (const o of this.b) {
        if (o === a) continue;
        const d2 = a.p.distanceToSquared(o.p);
        if (d2 > 144) continue;
        n++;
        ali.add(o.v);
        coh.add(o.p);
        if (d2 < 6) sep.add(tmp.subVectors(a.p, o.p).divideScalar(d2 + 0.1));
      }
      const acc = new THREE.Vector3();
      if (n) {
        ali.divideScalar(n).sub(a.v).multiplyScalar(0.6);
        coh.divideScalar(n).sub(a.p).multiplyScalar(0.25);
        acc.add(ali).add(coh);
      }
      acc.add(sep.multiplyScalar(5));
      acc.add(tmp.subVectors(this.goal, a.p).multiplyScalar(0.04));
      // keep clear of the mountain
      const g = ground(a.p.x, a.p.z);
      if (a.p.y < g + 9) acc.y += (g + 9 - a.p.y) * 2;
      acc.x += wind.x * 0.3;
      acc.z += wind.z * 0.3;
      a.v.addScaledVector(acc, dt);
      const sp = a.v.length();
      const maxS = 9;
      const minS = 4.5;
      if (sp > maxS) a.v.multiplyScalar(maxS / sp);
      if (sp < minS) a.v.multiplyScalar(minS / Math.max(sp, 0.01));
      a.p.addScaledVector(a.v, dt);
      if (Math.abs(a.p.x) > HALF * 2.2 || Math.abs(a.p.z) > HALF * 2.2) a.p.multiplyScalar(0.98);
    }
    this.b.forEach((a, k) => {
      this._q.setFromUnitVectors(this._f, tmp.copy(a.v).normalize());
      this._m.compose(a.p, this._q, this._s);
      this.mesh.setMatrixAt(k, this._m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

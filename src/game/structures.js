// Little physical structures the villagers build on their own:
//  * rope bridges wherever a footpath crosses running water — wooden planks
//    hung on Rapier spherical joints, so the deck sags into a catenary, sways
//    in the wind and (if you dig away a bank) collapses and floats off;
//  * water wheels beside hamlets — a rigid wheel on a revolute joint, turned
//    by drag from the simulated current on each submerged paddle.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { N, DX, HALF } from '../sim/constants.js';
import { patchMaterial } from '../render/shaders.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const PLANK_GROUP = (0x0002 << 16) | (0xffff & ~0x0002); // planks ignore each other
const GHOST_GROUP = (0x0004 << 16) | 0x0000; // driven purely by forces, touches nothing
const MAX_POSTS = 64;
const WIDTH = 0.85;

function wheelGeometry(r, w) {
  const parts = [];
  const wood = new THREE.Color('#7a5a3e');
  const paddle = new THREE.Color('#8f6d4c');
  const add = (g, col) => {
    const ng = g.toNonIndexed();
    const n = ng.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = col.r;
      c[i * 3 + 1] = col.g;
      c[i * 3 + 2] = col.b;
    }
    ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
    ng.deleteAttribute('uv');
    parts.push(ng);
  };
  for (const side of [-1, 1]) {
    const rim = new THREE.TorusGeometry(r * 0.78, 0.04, 5, 20);
    rim.translate(0, 0, side * w * 0.5);
    add(rim, wood);
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(r * 0.78, 0.05, 0.05);
    spoke.translate(r * 0.39, 0, 0);
    spoke.rotateZ(a);
    const s1 = spoke.clone().translate(0, 0, -w * 0.5);
    const s2 = spoke.clone().translate(0, 0, w * 0.5);
    add(s1, wood);
    add(s2, wood);
    const pad = new THREE.BoxGeometry(r * 0.42, 0.05, w * 1.05);
    pad.translate(r * 0.78, 0, 0);
    pad.rotateZ(a);
    add(pad, paddle);
  }
  const hub = new THREE.CylinderGeometry(0.09, 0.09, w + 0.5, 8);
  hub.rotateX(Math.PI / 2);
  add(hub, new THREE.Color('#5d4430'));
  const g = mergeGeometries(parts, false);
  g.computeVertexNormals();
  return g;
}

export class Structures {
  constructor(scene, game) {
    this.scene = scene;
    this.g = game;
    this.world = game.physics.world;
    this.bridges = [];
    this.wheels = [];
    this.timer = 0;
    this.wheelTimer = 0;
    this._ws = { depth: 0, ground: 0, surface: 0, u: 0, v: 0 };

    const woodMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: false, color: new THREE.Color('#8a6a4b'), roughness: 0.9 }), { key: 'post' });
    this.posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.08, 1.2, 6), woodMat, MAX_POSTS);
    this.posts.count = 0;
    this.posts.castShadow = true;
    this.posts.frustumCulled = false;
    scene.add(this.posts);
    this.ropePos = new Float32Array(6000 * 3);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.ropePos, 3).setUsage(THREE.DynamicDrawUsage));
    rg.setDrawRange(0, 0);
    this.ropes = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: new THREE.Color('#5b4634'), transparent: true, opacity: 0.85 }));
    this.ropes.frustumCulled = false;
    scene.add(this.ropes);
    this.wheelGeo = wheelGeometry(0.95, 0.5);
    this.wheelMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), { key: 'wheel' });
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  // ------------------------------------------------------------ bridges

  /** After a footpath stroke: span any stretch of running water it crossed. */
  pathStroke(points) {
    if (points.length < 2) return;
    const g = this.g;
    const samples = [];
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k];
      const b = points[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / 0.35));
      for (let s = 0; s < n; s++) samples.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
    }
    samples.push(points[points.length - 1]);
    const wet = samples.map((p) => {
      const c = g.cellAt(p.x, p.z);
      if (c < 0) return false;
      return (g.water.d[c] > 0.07 && !g.terrain.terrace[c]) || g.terrain.channel[c] === 1;
    });
    let k = 0;
    while (k < samples.length) {
      if (!wet[k]) {
        k++;
        continue;
      }
      let e = k;
      while (e < samples.length && wet[e]) e++;
      if (k > 0 && e < samples.length) {
        const A = samples[Math.max(0, k - 2)];
        const B = samples[Math.min(samples.length - 1, e + 1)];
        const L = Math.hypot(B.x - A.x, B.z - A.z);
        if (L > 1.4 && L < 16 && Math.abs(g.groundAt(A.x, A.z) - g.groundAt(B.x, B.z)) < 3.5) this.buildBridge(A, B);
      }
      k = e;
    }
  }

  buildBridge(A, B) {
    const g = this.g;
    for (const b of this.bridges) {
      const d1 = Math.hypot(b.A.x - A.x, b.A.z - A.z) + Math.hypot(b.B.x - B.x, b.B.z - B.z);
      const d2 = Math.hypot(b.A.x - B.x, b.A.z - B.z) + Math.hypot(b.B.x - A.x, b.B.z - A.z);
      if (Math.min(d1, d2) < 3) return null; // already bridged here
    }
    const yA = g.groundAt(A.x, A.z) + 0.3;
    const yB = g.groundAt(B.x, B.z) + 0.3;
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const L = Math.hypot(dx, dz);
    const dir = { x: dx / L, z: dz / L };
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    const n = Math.max(4, Math.min(34, Math.round(L / 0.42)));
    const sag = L * Math.sqrt((3 * 0.03) / 8); // ~3% slack in the ropes
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      pts.push(new THREE.Vector3(A.x + dx * u, yA + (yB - yA) * u - 4 * sag * u * (1 - u), A.z + dz * u));
    }
    const bridge = { A: { x: A.x, z: A.z, y: yA }, B: { x: B.x, z: B.z, y: yB }, L, dir, across, planks: [], joints: [], anchors: [], alive: true, n };
    const mk = (p) => this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z));
    const anchorA = mk(pts[0]);
    const anchorB = mk(pts[n]);
    bridge.anchors.push(anchorA, anchorB);
    const half = [];
    for (let k = 0; k < n; k++) {
      const p0 = pts[k];
      const p1 = pts[k + 1];
      const t = new THREE.Vector3().subVectors(p1, p0);
      const len = t.length();
      t.normalize();
      const y = new THREE.Vector3().crossVectors(across, t);
      const m = new THREE.Matrix4().makeBasis(t, y, across);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const c = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const e = g.physics.add('plank', c.x, c.y, c.z, {
        r: len * 0.5,
        density: 0.5,
        vel: { x: 0, y: 0, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
        damping: 0.35,
        angularDamping: 0.9,
        life: Infinity,
        shape: RAPIER.ColliderDesc.cuboid(len * 0.46, 0.035, WIDTH / 2).setCollisionGroups(PLANK_GROUP),
        data: { size: new THREE.Vector3(len * 0.92, 0.07, WIDTH), bridge },
      });
      e.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      bridge.planks.push(e);
      half.push(len * 0.5);
    }
    const joint = (b1, a1, b2, a2) => {
      const j = this.world.createImpulseJoint(RAPIER.JointData.spherical(a1, a2), b1, b2, true);
      j.setContactsEnabled(false);
      bridge.joints.push(j);
      return j;
    };
    const w2 = WIDTH / 2;
    for (const side of [-1, 1]) {
      const off = across.clone().multiplyScalar(side * w2);
      joint(anchorA, { x: off.x, y: 0, z: off.z }, bridge.planks[0].body, { x: -half[0], y: 0, z: side * w2 });
      for (let k = 0; k < n - 1; k++) {
        joint(bridge.planks[k].body, { x: half[k], y: 0, z: side * w2 }, bridge.planks[k + 1].body, { x: -half[k + 1], y: 0, z: side * w2 });
      }
      joint(bridge.planks[n - 1].body, { x: half[n - 1], y: 0, z: side * w2 }, anchorB, { x: off.x, y: 0, z: off.z });
    }
    this.bridges.push(bridge);
    g.audio?.house();
    return bridge;
  }

  collapse(bridge) {
    if (!bridge.alive) return;
    bridge.alive = false;
    for (const j of bridge.joints) this.world.removeImpulseJoint(j, true);
    for (const a of bridge.anchors) this.world.removeRigidBody(a);
    bridge.joints = [];
    bridge.anchors = [];
    // the loose planks fall in, float, and drift off with the current
    for (const e of bridge.planks) {
      e.life = e.age + 16 + Math.random() * 6;
      e.body?.wakeUp();
    }
    this.bridges.splice(this.bridges.indexOf(bridge), 1);
  }

  /** Deck height under a walker, or -Infinity if not on a bridge. */
  heightAt(x, z) {
    let best = -Infinity;
    for (const b of this.bridges) {
      const rx = x - b.A.x;
      const rz = z - b.A.z;
      const u = (rx * b.dir.x + rz * b.dir.z) / b.L;
      if (u < 0 || u > 1) continue;
      const lat = Math.abs(rx * b.across.x + rz * b.across.z);
      if (lat > WIDTH / 2 + 0.2) continue;
      const k = Math.min(b.planks.length - 1, Math.floor(u * b.planks.length));
      const body = b.planks[k].body;
      if (!body) continue;
      best = Math.max(best, body.translation().y + 0.04);
    }
    return best;
  }

  // ------------------------------------------------------------ water wheels

  placeWheel(x, z, fx, fz) {
    const g = this.g;
    const ws = g.water.sample(x, z, this._ws);
    const r = 0.95;
    const y = ws.surface + r * 0.55;
    const axis = new THREE.Vector3(-fz, 0, fx).normalize(); // turn with the flow
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(fx, 0, fz).normalize(), new THREE.Vector3(0, 1, 0), axis);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const rot = { x: q.x, y: q.y, z: q.z, w: q.w };
    const axle = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(rot));
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation(rot).setAngularDamping(2.2).setLinearDamping(0.5)
    );
    const paddles = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const local = new THREE.Vector3(Math.cos(a) * r * 0.78, Math.sin(a) * r * 0.78, 0);
      const pq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(r * 0.21, 0.03, 0.27).setTranslation(local.x, local.y, local.z).setRotation({ x: pq.x, y: pq.y, z: pq.z, w: pq.w }).setDensity(0.6).setCollisionGroups(GHOST_GROUP),
        body
      );
      paddles.push(local);
    }
    const joint = this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), axle, body, true);
    joint.setContactsEnabled(false);
    const mesh = new THREE.Mesh(this.wheelGeo, this.wheelMat);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const wheel = { x, z, y, axis, axle, body, joint, paddles, mesh, baseGround: g.groundAt(x, z), lastAngle: 0, spin: 0, knock: 0 };
    this.wheels.push(wheel);
    return wheel;
  }

  removeWheel(w) {
    this.world.removeImpulseJoint(w.joint, true);
    this.world.removeRigidBody(w.body);
    this.world.removeRigidBody(w.axle);
    this.scene.remove(w.mesh);
    this.wheels.splice(this.wheels.indexOf(w), 1);
  }

  /** Called before each physics step: current drag on every submerged paddle. */
  applyForces() {
    const g = this.g;
    const ws = this._ws;
    const ts = g.physics.waterTimeScale;
    for (const w of this.wheels) {
      const b = w.body;
      b.resetForces(false);
      const t = b.translation();
      const r = b.rotation();
      const q = this._q.set(r.x, r.y, r.z, r.w);
      const av = b.angvel();
      for (const local of w.paddles) {
        const p = this._v.copy(local).applyQuaternion(q);
        const px = t.x + p.x;
        const py = t.y + p.y;
        const pz = t.z + p.z;
        g.water.sample(px, pz, ws);
        if (ws.depth < 0.02 || py - 0.15 > ws.surface) continue;
        const sub = Math.min(1, (ws.surface - (py - 0.15)) / 0.35);
        // paddle velocity = omega x r
        const vx = av.y * p.z - av.z * p.y;
        const vy = av.z * p.x - av.x * p.z;
        const vz = av.x * p.y - av.y * p.x;
        // the mill's load: the wheel can't run faster than a calm walk of the current
        let fu = ws.u * ts;
        let fv = ws.v * ts;
        const fs = Math.hypot(fu, fv);
        if (fs > 4.5) {
          fu *= 4.5 / fs;
          fv *= 4.5 / fs;
        }
        const k = 1.6 * sub;
        b.addForceAtPoint({ x: (fu - vx) * k, y: -vy * k * 0.3, z: (fv - vz) * k }, { x: px, y: py, z: pz }, true);
      }
    }
    for (const br of this.bridges) {
      const wnd = g.wind.at(br.A.x, br.A.z);
      const side = wnd.x * br.across.x + wnd.z * br.across.z;
      for (const e of br.planks) {
        if (!e.body) continue;
        const m = e.body.mass();
        e.body.addForce({ x: br.across.x * side * m * 0.9, y: Math.sin(g.time * 2.3 + e.id) * m * 0.4, z: br.across.z * side * m * 0.9 }, true);
      }
    }
  }

  update(dt) {
    const g = this.g;
    this.timer += dt;
    if (this.timer > 1.2) {
      this.timer = 0;
      // a bridge gives way if its path is erased or a bank is dug out
      for (const b of [...this.bridges]) {
        const ca = g.cellAt(b.A.x, b.A.z);
        const cb = g.cellAt(b.B.x, b.B.z);
        const pathGone = ca >= 0 && cb >= 0 && !g.terrain.path[ca] && !g.terrain.path[cb];
        const bankGone = Math.abs(g.groundAt(b.A.x, b.A.z) + 0.3 - b.A.y) > 0.9 || Math.abs(g.groundAt(b.B.x, b.B.z) + 0.3 - b.B.y) > 0.9;
        if (pathGone || bankGone) this.collapse(b);
      }
      for (const w of [...this.wheels]) {
        if (Math.abs(g.groundAt(w.x, w.z) - w.baseGround) > 0.7) this.removeWheel(w);
      }
    }
    this.wheelTimer += dt;
    if (this.wheelTimer > 4) {
      this.wheelTimer = 0;
      this._maybeWheel();
    }
    // render wheels; a soft knock each time a paddle meets the water
    for (const w of this.wheels) {
      const t = w.body.translation();
      const r = w.body.rotation();
      w.mesh.position.set(t.x, t.y, t.z);
      w.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const av = w.body.angvel();
      const omega = av.x * w.axis.x + av.y * w.axis.y + av.z * w.axis.z;
      w.spin = omega;
      w.knock += Math.abs(omega) * dt * (8 / (Math.PI * 2));
      if (w.knock >= 1) {
        w.knock -= 1;
        if (Math.abs(omega) > 0.3) g.audio?.knock(Math.min(1, Math.abs(omega) / 3));
      }
    }
    this._writeBridges();
  }

  _maybeWheel() {
    const g = this.g;
    if (this.wheels.length >= 4 || g.village.count < 2) return;
    let best = null;
    let bestSpeed = 0.7;
    for (const h of g.village.houses) {
      for (let tries = 0; tries < 24; tries++) {
        const a = Math.random() * Math.PI * 2;
        const rr = 1.5 + Math.random() * 3.5;
        const x = h.x + Math.cos(a) * rr;
        const z = h.z + Math.sin(a) * rr;
        const c = g.cellAt(x, z);
        if (c < 0 || g.terrain.terrace[c]) continue;
        const d = g.water.d[c];
        if (d < 0.06 || d > 0.8) continue;
        const sp = Math.hypot(g.water.u[c], g.water.v[c]);
        if (sp <= bestSpeed) continue;
        if (this.wheels.some((w) => Math.hypot(w.x - x, w.z - z) < 14)) continue;
        if (this.bridges.some((b) => Math.hypot(b.A.x - x, b.A.z - z) < 3 || Math.hypot(b.B.x - x, b.B.z - z) < 3)) continue;
        bestSpeed = sp;
        best = { x, z, fx: g.water.u[c] / sp, fz: g.water.v[c] / sp };
      }
    }
    if (best) this.placeWheel(best.x, best.z, best.fx, best.fz);
  }

  _writeBridges() {
    const pos = this.ropePos;
    let n = 0;
    let posts = 0;
    const m = this._m;
    const q = this._q;
    const v = this._v;
    const one = new THREE.Vector3(1, 1, 1);
    const push = (a, b) => {
      if (n + 6 > pos.length) return;
      pos[n++] = a.x;
      pos[n++] = a.y;
      pos[n++] = a.z;
      pos[n++] = b.x;
      pos[n++] = b.y;
      pos[n++] = b.z;
    };
    for (const br of this.bridges) {
      for (const side of [-1, 1]) {
        let prev = null;
        const ax = br.across.x * side * (WIDTH / 2);
        const az = br.across.z * side * (WIDTH / 2);
        const start = new THREE.Vector3(br.A.x + ax, br.A.y + 0.8, br.A.z + az);
        prev = start;
        for (const e of br.planks) {
          if (!e.body) continue;
          const t = e.body.translation();
          const r = e.body.rotation();
          q.set(r.x, r.y, r.z, r.w);
          v.set(0, 0, side * (WIDTH / 2)).applyQuaternion(q);
          const deck = new THREE.Vector3(t.x + v.x, t.y + v.y, t.z + v.z);
          const rail = deck.clone();
          rail.y += 0.55;
          push(prev, rail);
          push(rail, deck);
          prev = rail;
        }
        push(prev, new THREE.Vector3(br.B.x + ax, br.B.y + 0.8, br.B.z + az));
        if (posts + 2 <= MAX_POSTS) {
          for (const P of [br.A, br.B]) {
            m.compose(new THREE.Vector3(P.x + ax, P.y + 0.3, P.z + az), new THREE.Quaternion(), one);
            this.posts.setMatrixAt(posts++, m);
          }
        }
      }
    }
    this.ropes.geometry.setDrawRange(0, n / 3);
    this.ropes.geometry.attributes.position.needsUpdate = true;
    this.posts.count = posts;
    this.posts.instanceMatrix.needsUpdate = true;
  }
}

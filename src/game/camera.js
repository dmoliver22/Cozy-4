// Orbiting overhead camera with gentle inertia: right-drag (or two fingers)
// to orbit, wheel / pinch to zoom toward the cursor, middle-drag or
// shift-drag to pan. Keyboard: WASD pan, Q/E orbit, R/F tilt, +/- zoom.
import * as THREE from 'three';
import { HALF } from '../sim/constants.js';

export class OrbitCam {
  constructor(camera) {
    this.camera = camera;
    this.goal = { az: 0.28, el: 0.6, dist: 190, tx: 2, ty: 6, tz: 10 };
    this.cur = { ...this.goal };
    this.autoRotate = 0;
    this.keys = new Set();
    this.minDist = 38;
    this.maxDist = 270;
  }

  rotate(dAz, dEl) {
    this.goal.az += dAz;
    this.goal.el = THREE.MathUtils.clamp(this.goal.el + dEl, 0.22, 1.32);
  }

  zoom(factor, toward) {
    const g = this.goal;
    const nd = THREE.MathUtils.clamp(g.dist * factor, this.minDist, this.maxDist);
    if (toward && nd < g.dist) {
      // zoom toward the point under the cursor
      const k = (1 - nd / g.dist) * 0.9;
      g.tx += (toward.x - g.tx) * k;
      g.tz += (toward.z - g.tz) * k;
      g.ty += (toward.y - g.ty) * k * 0.6;
    } else if (nd > g.dist) {
      // drift back toward the mountain when zooming out
      const k = (nd / g.dist - 1) * 0.5;
      g.tx += (2 - g.tx) * k;
      g.tz += (10 - g.tz) * k;
      g.ty += (6 - g.ty) * k;
    }
    g.dist = nd;
    this.clamp();
  }

  /** Pan in screen space (pixels), scaled by distance. */
  pan(dx, dy) {
    const g = this.goal;
    const s = g.dist * 0.0016;
    const ca = Math.cos(g.az);
    const sa = Math.sin(g.az);
    // screen right = (cos, 0, -sin); forward on the ground = (-sin, 0, -cos)
    g.tx += (-dx * ca - dy * sa) * s;
    g.tz += (dx * sa - dy * ca) * s;
    this.clamp();
  }

  clamp() {
    const g = this.goal;
    g.tx = THREE.MathUtils.clamp(g.tx, -HALF * 0.8, HALF * 0.8);
    g.tz = THREE.MathUtils.clamp(g.tz, -HALF * 0.8, HALF * 0.8);
    g.ty = THREE.MathUtils.clamp(g.ty, -2, 40);
  }

  update(dt) {
    const g = this.goal;
    const k = this.keys;
    const sp = dt * g.dist * 0.6;
    if (k.has('KeyW') || k.has('ArrowUp')) this.pan(0, sp * 6);
    if (k.has('KeyS') || k.has('ArrowDown')) this.pan(0, -sp * 6);
    if (k.has('KeyA') || k.has('ArrowLeft')) this.pan(sp * 6, 0);
    if (k.has('KeyD') || k.has('ArrowRight')) this.pan(-sp * 6, 0);
    if (k.has('KeyQ')) this.rotate(dt * 1.1, 0);
    if (k.has('KeyE')) this.rotate(-dt * 1.1, 0);
    if (k.has('KeyR')) this.rotate(0, dt * 0.8);
    if (k.has('KeyF')) this.rotate(0, -dt * 0.8);
    if (k.has('Equal') || k.has('NumpadAdd')) this.zoom(1 - dt * 1.2);
    if (k.has('Minus') || k.has('NumpadSubtract')) this.zoom(1 + dt * 1.2);
    g.az += this.autoRotate * dt;

    const c = this.cur;
    const a = 1 - Math.exp(-dt * 7);
    c.az += (g.az - c.az) * a;
    c.el += (g.el - c.el) * a;
    c.dist += (g.dist - c.dist) * a;
    c.tx += (g.tx - c.tx) * a;
    c.ty += (g.ty - c.ty) * a;
    c.tz += (g.tz - c.tz) * a;
    const ce = Math.cos(c.el);
    this.camera.position.set(c.tx + Math.sin(c.az) * ce * c.dist, c.ty + Math.sin(c.el) * c.dist, c.tz + Math.cos(c.az) * ce * c.dist);
    this.camera.lookAt(c.tx, c.ty, c.tz);
  }
}

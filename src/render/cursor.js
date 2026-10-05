// Brush cursor: a ring draped on the land, a translucent shelf preview at the
// level a terrace will be cut, and a dashed hint path for the first cut.
import * as THREE from 'three';
import { shared } from './shaders.js';

const SEG = 72;

export class Cursor {
  constructor(scene, ground) {
    this.ground = ground;
    const pos = new Float32Array(SEG * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.ringMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false });
    this.ring = new THREE.LineLoop(geo, this.ringMat);
    this.ring.renderOrder = 10;
    this.ring.frustumCulled = false;
    scene.add(this.ring);

    const disc = new THREE.CircleGeometry(1, 48);
    disc.rotateX(-Math.PI / 2);
    this.discMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    this.disc = new THREE.Mesh(disc, this.discMat);
    this.disc.renderOrder = 9;
    scene.add(this.disc);

    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.dot.renderOrder = 11;
    scene.add(this.dot);

    this.hint = null;
    this.visible = false;
    this.setVisible(false);
  }

  setVisible(v) {
    this.visible = v;
    this.ring.visible = v;
    this.dot.visible = v;
    if (!v) this.disc.visible = false;
  }

  update(x, z, radius, color, level = null) {
    const pos = this.ring.geometry.attributes.position.array;
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const px = x + Math.cos(a) * radius;
      const pz = z + Math.sin(a) * radius;
      pos[k * 3] = px;
      pos[k * 3 + 1] = this.ground(px, pz) + 0.15;
      pos[k * 3 + 2] = pz;
    }
    this.ring.geometry.attributes.position.needsUpdate = true;
    this.ringMat.color.set(color);
    this.dot.position.set(x, this.ground(x, z) + 0.2, z);
    this.dot.material.color.set(color);
    if (level !== null) {
      this.disc.visible = true;
      this.disc.position.set(x, level + 0.06, z);
      this.disc.scale.setScalar(radius);
      this.discMat.color.set(color);
    } else {
      this.disc.visible = false;
    }
  }

  /** Dashed, flowing guide line from a to b, draped over the land. */
  showHint(scene, a, b) {
    this.clearHint(scene);
    const pts = [];
    const n = 40;
    let dist = 0;
    const dists = [];
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = Math.max(this.ground(x, z), this.ground(a.x, a.z) * (1 - t) + this.ground(b.x, b.z) * t) + 0.5 + Math.sin(t * Math.PI) * 0.8;
      const p = new THREE.Vector3(x, y, z);
      if (prev) dist += p.distanceTo(prev);
      prev = p;
      pts.push(p);
      dists.push(dist);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(dists), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: { uTime: shared.uTime, uLen: { value: dist } },
      vertexShader: /* glsl */ `
        attribute float aDist;
        varying float vD;
        void main() { vD = aDist; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uLen;
        varying float vD;
        void main() {
          float dash = step(0.5, fract(vD * 0.9 - uTime * 1.4));
          float ends = smoothstep(0.0, 1.0, vD) * smoothstep(uLen, uLen - 1.5, vD);
          float pulse = 0.65 + 0.35 * sin(uTime * 3.0);
          gl_FragColor = vec4(1.0, 0.97, 0.9, dash * ends * pulse);
        }`,
    });
    this.hint = new THREE.Line(geo, mat);
    this.hint.renderOrder = 12;
    this.hint.frustumCulled = false;
    scene.add(this.hint);
    // ring at the destination
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.7, 40), new THREE.MeshBasicMaterial({ color: 0xfff6e8, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(b.x, this.ground(b.x, b.z) + 0.3, b.z);
    ring.renderOrder = 12;
    this.hintRing = ring;
    scene.add(ring);
  }

  clearHint(scene) {
    if (this.hint) {
      scene.remove(this.hint);
      this.hint.geometry.dispose();
      this.hint = null;
    }
    if (this.hintRing) {
      scene.remove(this.hintRing);
      this.hintRing = null;
    }
  }

  animate(t) {
    if (this.hintRing) {
      const s = 1 + Math.sin(t * 2.5) * 0.12;
      this.hintRing.scale.setScalar(s);
      this.hintRing.material.opacity = 0.45 + 0.3 * Math.sin(t * 2.5);
    }
  }
}

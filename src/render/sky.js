// Sky dome, sun and the slow day cycle. The cycle lingers in dawn and dusk:
// those long golden shadows are the look of the game.
import * as THREE from 'three';
import { shared, SKY_GLSL } from './shaders.js';

const C = (hex) => new THREE.Color(hex);

// key frames by sun elevation (degrees)
const KEYS = [
  { e: -14, zen: C('#1d2b4c'), hor: C('#3e4c6e'), fog: C('#34415e'), sun: C('#7f8fb8'), sunI: 0.0, amb: 0.32 },
  { e: -4, zen: C('#5b6f9a'), hor: C('#d79a8c'), fog: C('#9aa3b8'), sun: C('#ff9f7a'), sunI: 0.15, amb: 0.42 },
  { e: 3, zen: C('#86afd0'), hor: C('#f4b88e'), fog: C('#ead2c2'), sun: C('#ffaa6c'), sunI: 2.2, amb: 0.52 },
  { e: 10, zen: C('#8fc0dc'), hor: C('#f3c9a8'), fog: C('#ecdfd3'), sun: C('#ffc38a'), sunI: 2.8, amb: 0.62 },
  { e: 24, zen: C('#86bddc'), hor: C('#dce9ee'), fog: C('#e6eef0'), sun: C('#ffeedd'), sunI: 3.0, amb: 0.8 },
  { e: 50, zen: C('#79b3d8'), hor: C('#d6e8f0'), fog: C('#e6eef0'), sun: C('#fffaf0'), sunI: 3.1, amb: 0.9 },
];

function sampleKeys(e) {
  if (e <= KEYS[0].e) return KEYS[0];
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i];
    const b = KEYS[i + 1];
    if (e <= b.e) {
      const t = (e - a.e) / (b.e - a.e);
      return {
        zen: a.zen.clone().lerp(b.zen, t),
        hor: a.hor.clone().lerp(b.hor, t),
        fog: a.fog.clone().lerp(b.fog, t),
        sun: a.sun.clone().lerp(b.sun, t),
        sunI: a.sunI + (b.sunI - a.sunI) * t,
        amb: a.amb + (b.amb - a.amb) * t,
      };
    }
  }
  return KEYS[KEYS.length - 1];
}

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.hour = 6.55; // start in the golden hour after sunrise
    this.speed = 1; // multiplier
    this.hold = false;
    this.dayLength = 14 * 60; // seconds for a full day at speed 1

    const geo = new THREE.SphereGeometry(1400, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uZenith: shared.uZenith,
        uHorizon: shared.uHorizon,
        uFogColor: shared.uFogColor,
        uNight: shared.uNight,
        uTime: shared.uTime,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * p;
          gl_Position.z = gl_Position.w; // pin to far plane
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform float uTime;
        ${SKY_GLSL}
        float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyColor(d);
          // stars at night
          if (uNight > 0.01 && d.y > 0.0) {
            vec3 q = floor(d * 260.0);
            float s = step(0.9975, h31(q));
            float tw = 0.6 + 0.4 * sin(uTime * 2.0 + h31(q + 3.0) * 30.0);
            col += vec3(0.9, 0.95, 1.0) * s * tw * uNight * smoothstep(0.0, 0.3, d.y) * 0.9;
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -95;
    sc.right = 95;
    sc.top = 95;
    sc.bottom = -95;
    sc.near = 10;
    sc.far = 420;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 3;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd8ea, 0x7a6a50, 0.8);
    scene.add(this.hemi);
    this.elevation = 0;
    this.update(0);
  }

  /** Hours advance slower around sunrise and sunset. */
  update(dt) {
    if (!this.hold) {
      const h = this.hour;
      const golden = Math.exp(-(((h - 6.4) / 1.4) ** 2)) + Math.exp(-(((h - 18.0) / 1.3) ** 2));
      const night = h < 5 || h > 19.6 ? 1 : 0;
      const rate = (24 / this.dayLength) * this.speed * (1 - 0.6 * Math.min(1, golden)) * (night ? 2.2 : 1);
      this.hour = (this.hour + dt * rate) % 24;
    }
    const h = this.hour;
    // sun path: rises east (+x) around 5:45, highest in the south (+z) at noon
    const dayFrac = (h - 5.75) / (18.75 - 5.75);
    const elev = Math.sin(Math.PI * dayFrac) * 58; // degrees, negative at night
    const az = Math.PI * dayFrac; // 0 = east, pi/2 = south, pi = west
    const e = THREE.MathUtils.degToRad(Math.max(elev, -20));
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e));
    if (dayFrac < 0 || dayFrac > 1) {
      // night: let a moon stand in, high in the south-west
      dir.set(-0.35, 0.75, 0.55).normalize();
    }
    this.elevation = elev;
    const k = sampleKeys(dayFrac < 0 || dayFrac > 1 ? -20 : elev);
    const night = THREE.MathUtils.clamp((-elev - 2) / 10, 0, 1);
    shared.uSunDir.value.copy(dayFrac < 0 || dayFrac > 1 ? new THREE.Vector3(Math.cos(az), Math.sin(e), Math.sin(az)).normalize() : dir);
    shared.uSunColor.value.copy(k.sun);
    shared.uZenith.value.copy(k.zen);
    shared.uHorizon.value.copy(k.hor);
    shared.uFogColor.value.copy(k.fog);
    shared.uNight.value = night;

    this.sun.position.copy(dir).multiplyScalar(220);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.copy(night > 0.5 ? new THREE.Color('#9fb0d8') : k.sun);
    this.sun.intensity = night > 0.5 ? 0.35 : k.sunI;
    this.hemi.color.copy(k.zen).lerp(new THREE.Color('#ffffff'), 0.25);
    this.hemi.groundColor.copy(k.hor).multiplyScalar(0.45);
    this.hemi.intensity = k.amb;
  }

  get isNight() {
    return this.hour < 5.6 || this.hour > 19.2;
  }

  get label() {
    const h = this.hour;
    if (h < 5) return 'Night';
    if (h < 7.5) return 'Dawn';
    if (h < 11) return 'Morning';
    if (h < 14.5) return 'Midday';
    if (h < 17) return 'Afternoon';
    if (h < 19.4) return 'Dusk';
    return 'Night';
  }
}

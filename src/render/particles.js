// CPU particle physics (gravity, drag, buoyancy, wind) drawn as soft sprites.
// Used for waterfall spray, chimney smoke, dust, rain, leaves and fireflies.
import * as THREE from 'three';
import { shared, FOG_GLSL } from './shaders.js';

export const P_SPRAY = 0;
export const P_SMOKE = 1;
export const P_DUST = 2;
export const P_RAIN = 3;
export const P_PETAL = 4;
export const P_FIREFLY = 5;
export const P_MIST = 6;
export const P_SPARK = 7;

export class Particles {
  constructor(scene, max = 4000, additive = false) {
    this.max = max;
    this.count = 0;
    this.px = new Float32Array(max);
    this.py = new Float32Array(max);
    this.pz = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.type = new Uint8Array(max);
    this.r = new Float32Array(max);
    this.g = new Float32Array(max);
    this.b = new Float32Array(max);
    this.a = new Float32Array(max);
    this.seed = new Float32Array(max);

    this.posBuf = new Float32Array(max * 3);
    this.colBuf = new Float32Array(max * 4);
    this.sizeBuf = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posBuf, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colBuf, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizeBuf, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aColor', this.colAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setDrawRange(0, 0);
    this.uniforms = {
      uScale: { value: 600 },
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uFogColor: shared.uFogColor,
      uFogDensity: shared.uFogDensity,
      uFogBase: shared.uFogBase,
      uFogFalloff: shared.uFogFalloff,
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec4 vColor;
        varying vec3 vWorld;
        void main() {
          vColor = aColor;
          vWorld = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uFogColor;
        varying vec4 vColor;
        varying vec3 vWorld;
        ${FOG_GLSL}
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float r2 = dot(q, q);
          if (r2 > 0.25) discard;
          float soft = smoothstep(0.25, 0.0, r2);
          vec3 col = ${additive ? 'vColor.rgb' : 'applyFog(vColor.rgb, vWorld)'};
          gl_FragColor = vec4(col, vColor.a * soft);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  spawn(type, x, y, z, vx, vy, vz, life, size, r, g, b, a, grow = 0) {
    if (this.count >= this.max) return -1;
    const i = this.count++;
    this.type[i] = type;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
    this.a[i] = a;
    this.seed[i] = Math.random() * 100;
    return i;
  }

  _kill(i) {
    const j = --this.count;
    if (i === j) return;
    this.type[i] = this.type[j];
    this.px[i] = this.px[j];
    this.py[i] = this.py[j];
    this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.life[i] = this.life[j];
    this.maxLife[i] = this.maxLife[j];
    this.size[i] = this.size[j];
    this.grow[i] = this.grow[j];
    this.r[i] = this.r[j];
    this.g[i] = this.g[j];
    this.b[i] = this.b[j];
    this.a[i] = this.a[j];
    this.seed[i] = this.seed[j];
  }

  /**
   * Integrate. env: { wind(x,z) -> {x,z}, ground(x,z) -> surface height, t }
   */
  update(dt, env) {
    const { px, py, pz, vx, vy, vz, life, maxLife, type, size, grow, seed } = this;
    const pos = this.posBuf;
    const col = this.colBuf;
    const sz = this.sizeBuf;
    const wind = env.windVec;
    const t = env.t;
    for (let i = 0; i < this.count; i++) {
      life[i] -= dt;
      if (life[i] <= 0) {
        this._kill(i);
        i--;
        continue;
      }
      const ty = type[i];
      let ax = 0;
      let ay = 0;
      let az = 0;
      let drag = 0.2;
      if (ty === P_SPRAY) {
        ay = -14;
        drag = 1.2;
      } else if (ty === P_SMOKE) {
        // hot air rises, slows as it cools, wanders with turbulence
        const heat = life[i] / maxLife[i];
        ay = 1.6 * heat - 0.2;
        ax = wind.x * 0.6 + Math.sin(t * 1.3 + seed[i]) * 0.4;
        az = wind.z * 0.6 + Math.cos(t * 1.1 + seed[i] * 1.7) * 0.4;
        drag = 0.9;
      } else if (ty === P_DUST) {
        ay = -3;
        ax = wind.x * 0.3;
        az = wind.z * 0.3;
        drag = 1.6;
      } else if (ty === P_RAIN) {
        ay = -30;
        drag = 0.05;
      } else if (ty === P_PETAL) {
        // fluttering: lift oscillates as the petal tumbles
        ay = -1.2 + Math.sin(t * 5 + seed[i]) * 1.1;
        ax = wind.x * 1.2 + Math.cos(t * 3 + seed[i]) * 0.8;
        az = wind.z * 1.2 + Math.sin(t * 2.6 + seed[i]) * 0.8;
        drag = 1.4;
      } else if (ty === P_FIREFLY) {
        ax = Math.sin(t * 0.9 + seed[i] * 3) * 0.8;
        ay = Math.sin(t * 1.4 + seed[i]) * 0.5;
        az = Math.cos(t * 0.7 + seed[i] * 2) * 0.8;
        drag = 0.8;
      } else if (ty === P_MIST) {
        ax = wind.x * 0.25;
        az = wind.z * 0.25;
        ay = 0.05;
        drag = 0.5;
      } else if (ty === P_SPARK) {
        ay = -2;
        drag = 1;
      }
      const k = Math.max(0, 1 - drag * dt);
      vx[i] = (vx[i] + ax * dt) * k;
      vy[i] = (vy[i] + ay * dt) * k;
      vz[i] = (vz[i] + az * dt) * k;
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;
      size[i] += grow[i] * dt;
      if (ty === P_SPRAY || ty === P_RAIN || ty === P_DUST || ty === P_PETAL) {
        const g = env.ground(px[i], pz[i]);
        if (py[i] < g) {
          if (ty === P_RAIN && env.onRain) env.onRain(px[i], pz[i]);
          if (ty === P_PETAL) {
            py[i] = g + 0.02;
            vx[i] *= 0.3;
            vy[i] = 0;
            vz[i] *= 0.3;
            if (life[i] > 1.5) life[i] = 1.5;
          } else {
            this._kill(i);
            i--;
            continue;
          }
        }
      }
      const fade = Math.min(1, life[i] / Math.min(0.6, maxLife[i] * 0.4)) * Math.min(1, (maxLife[i] - life[i]) * 6);
      const o = i * 3;
      pos[o] = px[i];
      pos[o + 1] = py[i];
      pos[o + 2] = pz[i];
      const o4 = i * 4;
      col[o4] = this.r[i];
      col[o4 + 1] = this.g[i];
      col[o4 + 2] = this.b[i];
      let a = this.a[i] * fade;
      if (ty === P_FIREFLY) a *= 0.55 + 0.45 * Math.sin(t * 3 + seed[i] * 5);
      col[o4 + 3] = a;
      sz[i] = size[i];
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.count);
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, this.count * 3);
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(0, this.count * 4);
    this.sizeAttr.clearUpdateRanges();
    this.sizeAttr.addUpdateRange(0, this.count);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }
}

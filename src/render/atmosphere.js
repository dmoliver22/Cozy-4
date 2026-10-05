// Valley mist layers that softly meet the terrain, and layered ridgelines
// fading into the haze beyond the mountain.
import * as THREE from 'three';
import { N, HALF } from '../sim/constants.js';
import { shared, NOISE_GLSL } from './shaders.js';
import { makeSimplex2D, fbm } from '../sim/noise.js';

export class Atmosphere {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.heightData = new Uint16Array(N * N);
    this.heightTex = new THREE.DataTexture(this.heightData, N, N, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.updateHeight();
    this.wind = new THREE.Vector2(1, 0.3);
    this.focus = { value: 160 };

    this.layers = [];
    const layerDefs = [
      { y: 0.4, o: 0.42, s: 0.016 },
      { y: 2.2, o: 0.26, s: 0.021 },
      { y: 4.6, o: 0.14, s: 0.027 },
      { y: 8.5, o: 0.06, s: 0.034 },
    ];
    for (const def of layerDefs) {
      const geo = new THREE.PlaneGeometry(1600, 1600, 1, 1);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uHeight: { value: this.heightTex },
          uHalf: { value: HALF },
          uTime: shared.uTime,
          uWind: { value: this.wind },
          uOpacity: { value: def.o },
          uScale: { value: def.s },
          uFogColor: shared.uFogColor,
          uSunColor: shared.uSunColor,
          uSunDir: shared.uSunDir,
          uNight: shared.uNight,
          uDensity: { value: 1 },
          uFocus: this.focus,
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uHeight;
          uniform float uHalf;
          uniform float uTime;
          uniform vec2 uWind;
          uniform float uOpacity;
          uniform float uScale;
          uniform vec3 uFogColor;
          uniform vec3 uSunColor;
          uniform vec3 uSunDir;
          uniform float uNight;
          uniform float uDensity;
          uniform float uFocus;
          varying vec3 vWorld;
          ${NOISE_GLSL}
          void main() {
            vec2 uv = vWorld.xz / (2.0 * uHalf) + 0.5;
            float th = -2.4;
            if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) th = texture2D(uHeight, uv).r;
            float soft = smoothstep(0.0, 2.6, vWorld.y - th);
            vec2 p = vWorld.xz * uScale + uWind * uTime * 0.012;
            float n = fbm3(p) + fbm3(p * 2.3 - uWind.yx * uTime * 0.02) * 0.45;
            n = smoothstep(0.55, 1.05, n);
            float dist = length(vWorld - cameraPosition);
            float nearFade = smoothstep(uFocus * 0.55, uFocus * 1.15, dist);
            float a = n * soft * nearFade * uOpacity * uDensity;
            vec3 col = mix(uFogColor, vec3(1.0), 0.35 * (1.0 - uNight));
            vec3 v = normalize(vWorld - cameraPosition);
            col += uSunColor * pow(max(dot(v, uSunDir), 0.0), 4.0) * 0.3 * (1.0 - uNight);
            gl_FragColor = vec4(col, a);
          }`,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = def.y;
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.layers.push(mesh);
    }

    // distant ridgelines
    const noise = makeSimplex2D(42);
    const ridgeDefs = [
      { r: 240, h: 26, seed: 1, k: 0.35 },
      { r: 360, h: 44, seed: 2, k: 0.55 },
      { r: 520, h: 70, seed: 3, k: 0.72 },
      { r: 760, h: 110, seed: 4, k: 0.86 },
    ];
    this.ridges = [];
    for (const def of ridgeDefs) {
      const seg = 220;
      const pos = new Float32Array((seg + 1) * 2 * 3);
      const tAttr = new Float32Array((seg + 1) * 2);
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const x = Math.cos(a);
        const z = Math.sin(a);
        let h = fbm(noise, x * 2.2 + def.seed * 10, z * 2.2, 4) * 0.5 + 0.5;
        h = Math.pow(h, 1.6) * def.h + def.h * 0.12;
        const o = s * 6;
        pos[o] = x * def.r;
        pos[o + 1] = -6;
        pos[o + 2] = z * def.r;
        pos[o + 3] = x * def.r;
        pos[o + 4] = h;
        pos[o + 5] = z * def.r;
        tAttr[s * 2] = 0;
        tAttr[s * 2 + 1] = 1;
      }
      const idx = [];
      for (let s = 0; s < seg; s++) {
        const a = s * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aT', new THREE.BufferAttribute(tAttr, 1));
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: {
          uFogColor: shared.uFogColor,
          uZenith: shared.uZenith,
          uHorizon: shared.uHorizon,
          uSunColor: shared.uSunColor,
          uSunDir: shared.uSunDir,
          uK: { value: def.k },
          uNight: shared.uNight,
        },
        vertexShader: /* glsl */ `
          attribute float aT;
          varying float vT;
          varying vec3 vWorld;
          void main() {
            vT = aT;
            vWorld = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uFogColor;
          uniform vec3 uZenith;
          uniform vec3 uHorizon;
          uniform vec3 uSunColor;
          uniform vec3 uSunDir;
          uniform float uK;
          uniform float uNight;
          varying float vT;
          varying vec3 vWorld;
          void main() {
            vec3 ridge = mix(vec3(0.24, 0.33, 0.30), uZenith * 0.75, 0.35);
            vec3 col = mix(ridge, uFogColor, uK);
            col = mix(uFogColor, col, smoothstep(0.0, 0.55, vT)); // mist pools at the base
            vec3 v = normalize(vWorld - cameraPosition);
            col += uSunColor * pow(max(dot(v, uSunDir), 0.0), 5.0) * 0.25 * uK;
            gl_FragColor = vec4(col, 1.0);
          }`,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = -5 + def.k;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.ridges.push(mesh);
    }
  }

  updateHeight() {
    const H = this.terrain.H;
    const data = this.heightData;
    for (let c = 0; c < H.length; c++) data[c] = THREE.DataUtils.toHalfFloat(H[c]);
    this.heightTex.needsUpdate = true;
  }

  update(dt, wind, density = 1) {
    this.wind.set(wind.x, wind.z);
    for (const l of this.layers) l.material.uniforms.uDensity.value = density;
  }
}

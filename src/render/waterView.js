// Water surface rendered straight from the simulation: every frame the depth
// and velocity fields are uploaded as a float texture; the vertex shader lifts
// a grid onto the water surface and the fragment shader reflects the sky,
// glitters in the sun, foams over ledges and scrolls ripples along the flow.
import * as THREE from 'three';
import { N, DX, HALF } from '../sim/constants.js';
import { shared, SKY_GLSL, FOG_GLSL, NOISE_GLSL } from './shaders.js';

export class WaterView {
  constructor(scene, terrain, water, terrainView) {
    this.terrain = terrain;
    this.terrainView = terrainView;
    this.water = water;
    const n = N * N;
    this.data = new Float32Array(n * 4);
    this.tex = new THREE.DataTexture(this.data, N, N, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.data2 = new Uint8Array(n * 4);
    this.tex2 = new THREE.DataTexture(this.data2, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex2.magFilter = THREE.NearestFilter;
    this.tex2.minFilter = THREE.NearestFilter;
    this.tex2.needsUpdate = true;

    const pos = new Float32Array(n * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = i + j * N;
        pos[c * 3] = i;
        pos[c * 3 + 2] = j;
      }
    }
    const index = new Uint32Array((N - 1) * (N - 1) * 6);
    let k = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = i + j * N;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        if ((i + j) % 2 === 0) {
          index.set([a, c, b, b, c, d], k);
        } else {
          index.set([a, c, d, a, d, b], k);
        }
        k += 6;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), HALF * 1.6);

    this.uniforms = {
      uWater: { value: this.tex },
      uWater2: { value: this.tex2 },
      uN: { value: N },
      uDX: { value: DX },
      uHalf: { value: HALF },
      uTime: shared.uTime,
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uZenith: shared.uZenith,
      uHorizon: shared.uHorizon,
      uFogColor: shared.uFogColor,
      uFogDensity: shared.uFogDensity,
      uFogBase: shared.uFogBase,
      uFogFalloff: shared.uFogFalloff,
      uNight: shared.uNight,
      uShallow: { value: new THREE.Color('#6f9aa0') },
      uDeep: { value: new THREE.Color('#2e5868') },
      uMuddy: { value: new THREE.Color('#9a8460') },
      uRain: { value: 0 },
      uGround: { value: terrainView.groundTex },
      uNF: { value: terrainView.NF },
      uDXF: { value: terrainView.dxf },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: true,
      fog: false,
      vertexShader: /* glsl */ `
        uniform sampler2D uWater;
        uniform sampler2D uWater2;
        uniform float uN;
        uniform float uDX;
        uniform float uHalf;
        varying float vSurf;
        varying float vGround;
        varying vec2 vVel;
        varying vec3 vWorld;
        varying vec3 vNrm;
        varying float vFoam;
        varying float vSed;
        const float WET = 0.004;
        const ivec2 OFFS[8] = ivec2[8](ivec2(-1, -1), ivec2(0, -1), ivec2(1, -1), ivec2(-1, 0), ivec2(1, 0), ivec2(-1, 1), ivec2(0, 1), ivec2(1, 1));
        vec4 cellAt(ivec2 c) {
          return texelFetch(uWater, clamp(c, ivec2(0), ivec2(int(uN) - 1)), 0);
        }
        float surf(ivec2 c, float fallback) {
          vec4 w = cellAt(c);
          return w.g > WET ? w.r + w.g : fallback;
        }
        void main() {
          ivec2 ij = ivec2(position.xz + 0.5);
          vec4 w = cellAt(ij);
          vec4 w2 = texelFetch(uWater2, ij, 0);
          float H = w.r;
          float d = w.g;
          float s = H + d;
          float y = H - 1.2;
          vec2 vel = w.ba;
          if (d > WET) {
            y = s;
          } else {
            // dry vertex beside water: carry the flat water surface over it so the
            // shoreline is cut by the real terrain contour, not by grid cells.
            // Never over a drop (that would leave a ledge of water in the air).
            float sum = 0.0;
            float cnt = 0.0;
            for (int k = 0; k < 8; k++) {
              vec4 n = cellAt(ij + OFFS[k]);
              if (n.g > WET) {
                sum += n.r + n.g;
                cnt += 1.0;
              }
            }
            if (cnt > 0.0) {
              float S = sum / cnt;
              if (H > S - 0.45) y = S;
            }
            s = y;
          }
          float sl = surf(ij + ivec2(-1, 0), s);
          float sr = surf(ij + ivec2(1, 0), s);
          float st = surf(ij + ivec2(0, -1), s);
          float sb = surf(ij + ivec2(0, 1), s);
          vec3 nrm = normalize(vec3(sl - sr, 2.0 * uDX, st - sb));
          float grad = length(vec2(sl - sr, st - sb)) / (2.0 * uDX);
          float speed = length(vel);
          vSurf = y;
          vGround = H;
          vVel = vel;
          vNrm = nrm;
          vSed = w2.r;
          vFoam = clamp(smoothstep(0.35, 1.4, grad) * smoothstep(WET, 0.03, d) + smoothstep(2.5, 6.0, speed) * 0.6 + w2.g * 0.8, 0.0, 1.0);
          vec3 wp = vec3(position.x * uDX - uHalf, y, position.z * uDX - uHalf);
          vWorld = wp;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        uniform vec3 uMuddy;
        uniform float uRain;
        uniform sampler2D uGround;
        uniform float uNF;
        uniform float uDXF;
        varying float vSurf;
        varying float vGround;
        varying vec2 vVel;
        varying vec3 vWorld;
        varying vec3 vNrm;
        varying float vFoam;
        varying float vSed;
        ${SKY_GLSL}
        ${FOG_GLSL}
        ${NOISE_GLSL}
        float ripple(vec2 p) {
          return vnoise(p) * 0.6 + vnoise(p * 2.3 + 4.1) * 0.3 + vnoise(p * 5.1 - 2.0) * 0.1;
        }
        vec2 rippleGrad(vec2 p) {
          float e = 0.08;
          float c = ripple(p);
          return vec2(ripple(p + vec2(e, 0.0)) - c, ripple(p + vec2(0.0, e)) - c) / e;
        }
        float fineGround(vec2 xz) {
          vec2 g = clamp((xz + vec2(${HALF.toFixed(4)})) / uDXF, vec2(0.0), vec2(uNF - 1.001));
          ivec2 i = ivec2(floor(g));
          vec2 f = g - vec2(i);
          float a = texelFetch(uGround, i, 0).r;
          float b = texelFetch(uGround, i + ivec2(1, 0), 0).r;
          float c = texelFetch(uGround, i + ivec2(0, 1), 0).r;
          float d = texelFetch(uGround, i + ivec2(1, 1), 0).r;
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        void main() {
          // per-pixel depth against the finely drawn terrain: smooth shorelines
          float depth = vSurf - fineGround(vWorld.xz);
          float a0 = smoothstep(0.0, 0.045, depth);
          if (a0 < 0.01) discard;
          vec3 V = normalize(cameraPosition - vWorld);
          float speed = length(vVel);

          // flow-advected ripples, two phases cross-faded to hide stretching
          vec2 flow = vVel * 0.35;
          float t = uTime * 0.5;
          float p0 = fract(t);
          float p1 = fract(t + 0.5);
          float wgt = abs(p0 - 0.5) * 2.0;
          vec2 base = vWorld.xz * 1.3;
          vec2 g0 = rippleGrad(base - flow * p0 * 1.6);
          vec2 g1 = rippleGrad(base + 3.7 - flow * p1 * 1.6);
          vec2 g = mix(g0, g1, wgt);
          // still paddies are glassy; moving water and rain roughen it
          float rough = 0.035 + smoothstep(0.1, 2.5, speed) * 0.32 + uRain * 0.22;
          // rain rings
          if (uRain > 0.01) {
            vec2 rc = floor(vWorld.xz * 1.5);
            vec2 rf = fract(vWorld.xz * 1.5) - 0.5;
            float ph = fract(uTime * 0.8 + hash12(rc) * 7.0);
            float ring = sin((length(rf) - ph * 0.5) * 40.0) * smoothstep(0.5, 0.0, length(rf)) * (1.0 - ph);
            g += normalize(rf + 1e-4) * ring * uRain * 0.5;
          }
          vec3 N = normalize(vNrm + vec3(g.x, 0.0, g.y) * rough);

          vec3 R = reflect(-V, N);
          R.y = abs(R.y) + 0.02;
          R = normalize(R);
          vec3 refl = skyColor(R);
          float ndv = max(dot(N, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          // still water over dark mud reads as a mirror
          float mirror = 0.62 * (1.0 - smoothstep(0.4, 3.0, speed)) * smoothstep(0.02, 0.2, depth);
          float rw = clamp(fres + mirror, 0.0, 0.97);

          float depthT = smoothstep(0.0, 1.4, depth);
          vec3 body = mix(uShallow, uDeep, depthT);
          body = mix(body, uMuddy, clamp(vSed * 3.0, 0.0, 0.7));
          float light = 0.45 + 0.55 * max(uSunDir.y, 0.0);
          vec3 col = mix(body * light * (0.55 + 0.45 * uSunColor), refl, rw);

          // sun glitter: a sharp highlight plus twinkling glints over a broad lobe
          float sunUp = smoothstep(-0.05, 0.08, uSunDir.y);
          float sd = max(dot(R, uSunDir), 0.0);
          vec2 gc = floor(vWorld.xz * 9.0);
          float tw = hash12(gc + floor(uTime * 3.0 + hash12(gc) * 3.0));
          float glints = step(0.965, tw) * pow(max(dot(normalize(V + uSunDir), N), 0.0), 2.0);
          float spec = pow(sd, 700.0) * 22.0 + pow(sd, 60.0) * 0.7 + glints * pow(sd, 3.0) * 6.0;
          col += uSunColor * spec * sunUp * (1.0 - uRain * 0.7);

          // white water over ledges and in fast runs
          float foamN = vnoise(vWorld.xz * 3.0 - vVel * uTime * 0.8) * 0.5 + vnoise(vWorld.xz * 7.0 + uTime * 2.0) * 0.5;
          float foam = smoothstep(0.35, 0.75, vFoam * (0.6 + 0.8 * foamN));
          col = mix(col, vec3(1.0, 0.99, 0.97) * (0.7 + 0.3 * light), foam * 0.85);

          col = applyFog(col, vWorld);
          float alpha = mix(0.5, 0.94, smoothstep(0.02, 0.8, depth));
          alpha = clamp(alpha + rw * 0.35 + foam * 0.6, 0.0, 1.0) * a0;
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(foamCells) {
    const w = this.water;
    const H = this.terrain.H;
    const d = w.d;
    const u = w.u;
    const v = w.v;
    const sed = w.sed;
    const data = this.data;
    const data2 = this.data2;
    const n = N * N;
    for (let c = 0; c < n; c++) {
      const o = c * 4;
      data[o] = H[c];
      data[o + 1] = d[c];
      data[o + 2] = u[c];
      data[o + 3] = v[c];
      const s = d[c] > 0.004 ? sed[c] / d[c] : 0;
      data2[o] = s > 1 ? 255 : s * 255;
      data2[o + 1] = data2[o + 1] * 0.9; // foam decays
    }
    if (foamCells) {
      for (let k = 0; k < foamCells.length; k += 4) {
        const c = foamCells[k + 1];
        const f = Math.min(255, foamCells[k + 2] * 60);
        if (data2[c * 4 + 1] < f) data2[c * 4 + 1] = f;
      }
    }
    this.tex.needsUpdate = true;
    this.tex2.needsUpdate = true;
  }
}

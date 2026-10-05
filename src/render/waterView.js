// Water surface rendered straight from the simulation. Every frame the depth
// and velocity fields are uploaded as a float texture. The surface is drawn on
// the same fine grid as the terrain: still water (paddies, ponds, the lake) is
// a flat plane whose shoreline is resolved per pixel against the drawn land,
// while thin sheets (water spilling over a ledge, running down a riser) hug
// the terrain surface. The fragment shader reflects the sky, glitters in the
// sun, foams over ledges and scrolls ripples along the flow.
import * as THREE from 'three';
import { N, HALF } from '../sim/constants.js';
import { shared, SKY_GLSL, FOG_GLSL, NOISE_GLSL } from './shaders.js';

const WET = 0.004;
const INVALID = -10000;

export class WaterView {
  constructor(scene, terrain, water, terrainView) {
    this.terrain = terrain;
    this.terrainView = terrainView;
    this.water = water;
    const n = N * N;
    this.data = new Float32Array(n * 4); // virtual surface, depth, u, v
    this.tex = new THREE.DataTexture(this.data, N, N, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.data2 = new Uint8Array(n * 4); // sediment, foam
    this.tex2 = new THREE.DataTexture(this.data2, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex2.magFilter = THREE.NearestFilter;
    this.tex2.minFilter = THREE.NearestFilter;
    this.tex2.needsUpdate = true;

    const S = terrainView.S;
    const NF = terrainView.NF;
    const nf = NF * NF;
    const pos = new Float32Array(nf * 3);
    for (let j = 0; j < NF; j++) {
      for (let i = 0; i < NF; i++) {
        const v = i + j * NF;
        pos[v * 3] = i;
        pos[v * 3 + 2] = j;
      }
    }
    const index = new Uint32Array((NF - 1) * (NF - 1) * 6);
    let k = 0;
    for (let j = 0; j < NF - 1; j++) {
      for (let i = 0; i < NF - 1; i++) {
        const a = i + j * NF;
        const b = a + 1;
        const c = a + NF;
        const d = c + 1;
        if ((i + j) % 2 === 0) {
          index[k++] = a;
          index[k++] = c;
          index[k++] = b;
          index[k++] = b;
          index[k++] = c;
          index[k++] = d;
        } else {
          index[k++] = a;
          index[k++] = c;
          index[k++] = d;
          index[k++] = a;
          index[k++] = d;
          index[k++] = b;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), HALF * 1.6);

    this.uniforms = {
      uWater: { value: this.tex },
      uWater2: { value: this.tex2 },
      uGround: { value: terrainView.groundTex },
      uN: { value: N },
      uS: { value: S },
      uNF: { value: NF },
      uDXF: { value: terrainView.dxf },
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
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: true,
      fog: false,
      vertexShader: /* glsl */ `
        uniform sampler2D uWater;
        uniform sampler2D uWater2;
        uniform sampler2D uGround;
        uniform float uN;
        uniform float uS;
        uniform float uNF;
        uniform float uDXF;
        varying vec2 vVel;
        varying vec3 vWorld;
        varying float vFoam;
        varying float vSed;
        varying float vFilm;
        void main() {
          ivec2 fij = ivec2(position.xz + 0.5);
          float G = texelFetch(uGround, fij, 0).r;
          vec2 g = vec2(fij) / uS;
          ivec2 c0 = min(ivec2(floor(g)), ivec2(int(uN) - 2));
          vec2 f = g - vec2(c0);
          vec4 a = texelFetch(uWater, c0, 0);
          vec4 b = texelFetch(uWater, c0 + ivec2(1, 0), 0);
          vec4 c = texelFetch(uWater, c0 + ivec2(0, 1), 0);
          vec4 d = texelFetch(uWater, c0 + ivec2(1, 1), 0);
          float wa = (1.0 - f.x) * (1.0 - f.y);
          float wb = f.x * (1.0 - f.y);
          float wc = (1.0 - f.x) * f.y;
          float wd = f.x * f.y;
          float depth = a.g * wa + b.g * wb + c.g * wc + d.g * wd;
          float dmax = max(max(a.g, b.g), max(c.g, d.g));
          vec2 vel = a.ba * wa + b.ba * wb + c.ba * wc + d.ba * wd;
          // flat surface from the corners that carry (or border) water
          float sw = 0.0;
          float ss = 0.0;
          if (a.r > -1000.0) { sw += wa; ss += wa * a.r; }
          if (b.r > -1000.0) { sw += wb; ss += wb * b.r; }
          if (c.r > -1000.0) { sw += wc; ss += wc * c.r; }
          if (d.r > -1000.0) { sw += wd; ss += wd * d.r; }
          float y = G - 1.0;
          float film = 0.0;
          if (sw > 0.001 && dmax > ${WET.toFixed(4)}) {
            float S = ss / sw;
            float pond = smoothstep(0.05, 0.18, dmax);
            if (depth > 0.12 || G > S - 0.5) {
              // standing water, or its shore: flat at the water level (the shore is
              // clipped per pixel), unless all there is here is a thin sheet
              y = G >= S - 0.02 ? S : mix(G + depth, S, pond);
              film = G >= S - 0.02 ? 0.0 : 1.0 - pond;
            } else {
              // over a drop: only a thin sheet running down the face
              y = depth > 0.003 ? G + depth : G - 1.0;
              film = 1.0;
            }
          }
          vec4 w2 = texelFetch(uWater2, c0 + ivec2(int(f.x + 0.5), int(f.y + 0.5)), 0);
          vVel = vel;
          vSed = w2.r;
          vFilm = film;
          float speed = length(vel);
          vFoam = clamp(smoothstep(2.6, 6.0, speed) * 0.55 + w2.g * 0.85, 0.0, 1.0);
          vec3 wp = vec3(position.x * uDXF - ${HALF.toFixed(4)}, y, position.z * uDXF - ${HALF.toFixed(4)});
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
        varying vec2 vVel;
        varying vec3 vWorld;
        varying float vFoam;
        varying float vSed;
        varying float vFilm;
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
          float depth = vWorld.y - fineGround(vWorld.xz);
          float a0 = smoothstep(0.0, mix(0.045, 0.02, vFilm), depth);
          if (a0 < 0.01) discard;
          vec3 V = normalize(cameraPosition - vWorld);
          float speed = length(vVel);
          // facet normal of the surface itself (flat on ponds, tilted on falls)
          vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          if (fn.y < 0.0) fn = -fn;
          float steep = 1.0 - fn.y;

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
          float rough = 0.035 + smoothstep(0.1, 2.5, speed) * 0.32 + uRain * 0.22;
          if (uRain > 0.01) {
            vec2 rc = floor(vWorld.xz * 1.5);
            vec2 rf = fract(vWorld.xz * 1.5) - 0.5;
            float ph = fract(uTime * 0.8 + hash12(rc) * 7.0);
            float ring = sin((length(rf) - ph * 0.5) * 40.0) * smoothstep(0.5, 0.0, length(rf)) * (1.0 - ph);
            g += normalize(rf + 1e-4) * ring * uRain * 0.5;
          }
          vec3 N = normalize(fn + vec3(g.x, 0.0, g.y) * rough);

          vec3 R = reflect(-V, N);
          R.y = abs(R.y) + 0.02;
          R = normalize(R);
          vec3 refl = skyColor(R);
          float ndv = max(dot(N, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          // still water over dark mud reads as a mirror
          float mirror = mix(0.5, 0.62, smoothstep(0.4, 1.5, depth)) * (1.0 - smoothstep(0.4, 3.0, speed)) * smoothstep(0.02, 0.2, depth) * (1.0 - vFilm);
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

          // white water: sheets tumbling down a face, fast runs, the foot of falls
          float foamN = vnoise(vWorld.xz * 3.0 - vVel * uTime * 0.8) * 0.5 + vnoise(vWorld.xz * 7.0 + vec2(0.0, uTime * 2.0)) * 0.5;
          float foamSrc = clamp(vFoam + smoothstep(0.25, 0.7, steep) * 0.9 * smoothstep(0.25, 1.0, speed), 0.0, 1.0);
          float foam = smoothstep(0.35, 0.75, foamSrc * (0.6 + 0.8 * foamN));
          col = mix(col, vec3(1.0, 0.99, 0.97) * (0.7 + 0.3 * light) * (0.55 + 0.45 * (1.0 - uNight)), foam * 0.85);

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
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = i + j * N;
        const o = c * 4;
        const dc = d[c];
        let vs = INVALID;
        if (dc > WET) {
          vs = H[c] + dc;
        } else {
          // a dry cell beside water carries the water level, so the flat surface
          // reaches the true shoreline; never over a drop
          let sum = 0;
          let cnt = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= N) continue;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              if (ii < 0 || ii >= N || (!di && !dj)) continue;
              const k = ii + jj * N;
              if (d[k] > WET) {
                sum += H[k] + d[k];
                cnt++;
              }
            }
          }
          if (cnt) {
            const S = sum / cnt;
            if (H[c] > S - 0.45) vs = S;
          }
        }
        data[o] = vs;
        data[o + 1] = dc;
        data[o + 2] = u[c];
        data[o + 3] = v[c];
        const s = dc > WET ? sed[c] / dc : 0;
        data2[o] = s > 1 ? 255 : s * 255;
        data2[o + 1] = data2[o + 1] * 0.9; // foam decays
      }
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

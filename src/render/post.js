// Post: soft bloom for glints, tilt-shift blur so the mountain reads as a
// miniature, then a gentle grade + vignette.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const TiltShift = {
  uniforms: {
    tDiffuse: { value: null },
    uDir: { value: new THREE.Vector2(1, 0) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uFocus: { value: 0.5 },
    uBand: { value: 0.18 },
    uAmount: { value: 2.2 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uDir;
    uniform vec2 uRes;
    uniform float uFocus;
    uniform float uBand;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      float d = abs(vUv.y - uFocus);
      float blur = smoothstep(uBand, uBand + 0.32, d) * uAmount;
      vec2 stepv = uDir / uRes * blur;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
      sum += texture2D(tDiffuse, vUv + stepv * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv - stepv * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv + stepv * 3.2307692308) * 0.0702702703;
      sum += texture2D(tDiffuse, vUv - stepv * 3.2307692308) * 0.0702702703;
      gl_FragColor = sum;
    }`,
};

const Grade = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.28 },
    uWarm: { value: 0.5 },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uFade: { value: 0 },
  },
  vertexShader: TiltShift.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uWarm;
    uniform float uNight;
    uniform float uTime;
    uniform float uFade;
    varying vec2 vUv;
    float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      // soft pastel lift: raise blacks a touch, ease saturation down
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, 1.04);
      col = col * 0.96 + vec3(0.012, 0.011, 0.014);
      // warm highlights / cool shadows (split toning)
      col += (vec3(0.03, 0.012, -0.02) * smoothstep(0.3, 1.0, l) + vec3(-0.01, 0.0, 0.02) * (1.0 - smoothstep(0.0, 0.35, l))) * uWarm;
      col = mix(col, col * vec3(0.78, 0.86, 1.08), uNight * 0.45);
      vec2 q = vUv - 0.5;
      float vig = 1.0 - dot(q, q) * uVignette * 2.2;
      col *= vig;
      col += (h12(vUv * 1024.0 + uTime) - 0.5) * 0.006;
      col = mix(col, vec3(0.9, 0.93, 0.94), uFade);
      gl_FragColor = vec4(col, c.a);
    }`,
};

export class Post {
  constructor(renderer, scene, camera, quality = 'high') {
    this.renderer = renderer;
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const low = quality !== 'high';
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
      type: THREE.HalfFloatType,
      samples: low ? 0 : 4,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 0.92);
    this.bloom.enabled = !low;
    this.composer.addPass(this.bloom);
    this.tiltH = new ShaderPass(TiltShift);
    this.tiltV = new ShaderPass(TiltShift);
    this.tiltV.uniforms.uDir.value.set(0, 1);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.grade = new ShaderPass(Grade);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.setSize(size.x, size.y);
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    for (const p of [this.tiltH, this.tiltV]) p.uniforms.uRes.value.set(w * pr, h * pr);
  }

  setTilt(amount, focus = 0.52, band = 0.16) {
    for (const p of [this.tiltH, this.tiltV]) {
      p.uniforms.uAmount.value = amount;
      p.uniforms.uFocus.value = focus;
      p.uniforms.uBand.value = band;
    }
  }

  render(dt) {
    this.composer.render(dt);
  }
}

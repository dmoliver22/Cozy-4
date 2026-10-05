// Shared GLSL chunks and uniforms: sky gradient, height fog, value noise.
import * as THREE from 'three';

export const shared = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.5, 0.3, 0.2).normalize() },
  uSunColor: { value: new THREE.Color('#ffd2a8') },
  uZenith: { value: new THREE.Color('#8fc0dc') },
  uHorizon: { value: new THREE.Color('#f3c9a8') },
  uFogColor: { value: new THREE.Color('#e6eef0') },
  uFogDensity: { value: 0.0016 },
  uFogBase: { value: -3.0 },
  uFogFalloff: { value: 0.28 },
  uNight: { value: 0 },
  uSway: { value: null },
  uWorldSize: { value: 160 },
};

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return s;
}
`;

export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFogColor;
uniform float uNight;
float skyHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float skyNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), u.x), mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 skyColor(vec3 dir) {
  float h = dir.y;
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.02, 0.65, h), 0.55));
  // soft, slow clouds lit by the sun
  if (h > 0.01) {
    vec2 cp = dir.xz / (h + 0.18) * 1.6;
    float cl = skyNoise(cp) * 0.55 + skyNoise(cp * 2.3 + 7.0) * 0.3 + skyNoise(cp * 5.1 - 3.0) * 0.15;
    cl = smoothstep(0.52, 0.85, cl) * smoothstep(0.01, 0.25, h);
    vec3 cloudCol = mix(uHorizon * 1.08, vec3(1.0), 0.45) + uSunColor * 0.12;
    col = mix(col, cloudCol, cl * 0.55 * (1.0 - uNight * 0.7));
  }
  col = mix(uFogColor, col, smoothstep(-0.25, 0.04, h));
  float sd = max(dot(dir, uSunDir), 0.0);
  float sunUp = smoothstep(-0.12, 0.05, uSunDir.y);
  col += uSunColor * (pow(sd, 6.0) * 0.22 + pow(sd, 48.0) * 0.45) * sunUp;
  col += uSunColor * smoothstep(0.99955, 0.99975, sd) * 6.0 * sunUp;
  return col;
}
`;

export const FOG_GLSL = /* glsl */ `
uniform float uFogDensity;
uniform float uFogBase;
uniform float uFogFalloff;
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 toP = wp - cameraPosition;
  float dist = length(toP);
  float hf = exp(-max(wp.y - uFogBase, 0.0) * uFogFalloff);
  float f = 1.0 - exp(-dist * uFogDensity * (0.3 + 2.6 * hf));
  vec3 v = toP / max(dist, 1e-4);
  float sunAmt = pow(max(dot(v, uSunDir), 0.0), 6.0) * smoothstep(-0.1, 0.1, uSunDir.y);
  vec3 fc = mix(uFogColor, uSunColor * 1.05, sunAmt * 0.45);
  return mix(col, fc, clamp(f, 0.0, 1.0));
}
`;

/**
 * Patch a built-in material: world-space height fog, optional wind sway
 * driven by the physical wind-spring field, optional extra hooks.
 */
export function patchMaterial(material, opts = {}) {
  const { sway = 0, swayHeight = 1, extraVertex = '', extraFragmentHead = '', colorFn = null } = opts;
  material.fog = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = shared.uSunDir;
    shader.uniforms.uSunColor = shared.uSunColor;
    shader.uniforms.uZenith = shared.uZenith;
    shader.uniforms.uHorizon = shared.uHorizon;
    shader.uniforms.uFogColor = shared.uFogColor;
    shader.uniforms.uFogDensity = shared.uFogDensity;
    shader.uniforms.uFogBase = shared.uFogBase;
    shader.uniforms.uFogFalloff = shared.uFogFalloff;
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uSway = shared.uSway;
    shader.uniforms.uWorldSize = shared.uWorldSize;
    if (opts.uniforms) Object.assign(shader.uniforms, opts.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
uniform sampler2D uSway;
uniform float uWorldSize;
uniform float uTime;
${opts.vertexHead || ''}`
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
mvPosition = instanceMatrix * mvPosition;
#endif
vec4 wPos = modelMatrix * mvPosition;
${
  sway
    ? `{
  float hh = clamp(position.y / ${swayHeight.toFixed(3)}, 0.0, 1.6);
  vec2 sw = texture2D(uSway, wPos.xz / uWorldSize + 0.5).rg;
  float k = hh * hh * ${sway.toFixed(3)};
  wPos.xz += sw * k;
  wPos.y -= dot(sw, sw) * k * 0.35;
}`
    : ''
}
${extraVertex}
vWorldPos = wPos.xyz;
mvPosition = viewMatrix * wPos;
gl_Position = projectionMatrix * mvPosition;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
uniform float uTime;
${SKY_GLSL}
${FOG_GLSL}
${NOISE_GLSL}
${extraFragmentHead}`
      )
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWorldPos);');
    if (colorFn) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', colorFn);
    if (opts.onShader) opts.onShader(shader);
  };
  material.customProgramCacheKey = () => `patched-${sway}-${swayHeight}-${opts.key || ''}`;
  return material;
}

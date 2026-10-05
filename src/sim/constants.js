// Shared simulation constants. Everything in src/sim is plain JS with no
// rendering dependencies so it can be unit-tested in node.

export const N = 160; // grid vertices per side (heightfield resolution)
export const DX = 1; // world units between grid vertices
export const HALF = ((N - 1) * DX) / 2; // world extent is [-HALF, HALF] on x and z

export const MAX_TERRACES = 2048;
export const BUND_H = 0.3; // height of the earthen lip (bund) that holds water in a paddy
export const RISER_W = 1.3; // width of the blended riser band around a cut terrace
export const MERGE_EPS = 0.14; // terraces closer than this in level merge into one

export const TALUS = 0.78; // angle of repose for loose soil (rise over run)

export const FLAG_TERRACE = 1;
export const FLAG_RIM = 2;
export const FLAG_WALL = 4;
export const FLAG_PATH = 8;
export const FLAG_CHANNEL = 16;

export function idx(i, j) {
  return i + j * N;
}

export function toGrid(w) {
  return (w + HALF) / DX;
}

export function toWorld(g) {
  return g * DX - HALF;
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** Bilinear sample of a per-vertex field at world position (x, z). */
export function sampleField(arr, x, z) {
  let gx = (x + HALF) / DX;
  let gz = (z + HALF) / DX;
  if (gx < 0) gx = 0;
  else if (gx > N - 1.001) gx = N - 1.001;
  if (gz < 0) gz = 0;
  else if (gz > N - 1.001) gz = N - 1.001;
  const i = gx | 0;
  const j = gz | 0;
  const fx = gx - i;
  const fz = gz - j;
  const c = i + j * N;
  const a = arr[c] + (arr[c + 1] - arr[c]) * fx;
  const b = arr[c + N] + (arr[c + N + 1] - arr[c + N]) * fx;
  return a + (b - a) * fz;
}

/** Same as sampleField but over the sum of two arrays (e.g. ground + water). */
export function sampleSum(a1, a2, x, z) {
  let gx = (x + HALF) / DX;
  let gz = (z + HALF) / DX;
  if (gx < 0) gx = 0;
  else if (gx > N - 1.001) gx = N - 1.001;
  if (gz < 0) gz = 0;
  else if (gz > N - 1.001) gz = N - 1.001;
  const i = gx | 0;
  const j = gz | 0;
  const fx = gx - i;
  const fz = gz - j;
  const c = i + j * N;
  const v00 = a1[c] + a2[c];
  const v10 = a1[c + 1] + a2[c + 1];
  const v01 = a1[c + N] + a2[c + N];
  const v11 = a1[c + N + 1] + a2[c + N + 1];
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fz;
}

export function inside(x, z, margin = 0) {
  return x >= -HALF + margin && x <= HALF - margin && z >= -HALF + margin && z <= HALF - margin;
}

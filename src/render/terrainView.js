// Terrain mesh. The simulation runs on a coarse grid, but the mesh is drawn at
// a finer resolution: terrace edges are reconstructed from the signed-distance
// field the brush strokes leave behind, so shelves come out as smooth curves
// with a crisp earthen lip instead of grid steps. Moisture, greenery and silt
// come from small textures sampled per pixel; the fragment shader paints soft
// mottled grass, mud paddies, dry-stone risers and packed-earth paths.
import * as THREE from 'three';
import { N, DX, HALF } from '../sim/constants.js';
import { patchMaterial } from './shaders.js';

const lin = (hex) => new THREE.Color(hex);

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class TerrainView {
  constructor(scene, terrain, water, eco, sub = 2) {
    this.terrain = terrain;
    this.water = water;
    this.eco = eco;
    this.S = sub;
    const NF = (N - 1) * sub + 1;
    this.NF = NF;
    this.dxf = DX / sub;
    const nf = NF * NF;
    this.fineH = new Float32Array(nf);
    const pos = new Float32Array(nf * 3);
    const nor = new Float32Array(nf * 3);
    for (let j = 0; j < NF; j++) {
      for (let i = 0; i < NF; i++) {
        const v = i + j * NF;
        pos[v * 3] = i * this.dxf - HALF;
        pos[v * 3 + 2] = j * this.dxf - HALF;
        nor[v * 3 + 1] = 1;
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
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
    this.terrAttr = new THREE.BufferAttribute(new Uint8Array(nf * 2), 2, true).setUsage(THREE.DynamicDrawUsage); // terrace bed, bund lip
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.norAttr);
    geo.setAttribute('aTerr', this.terrAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), HALF * 1.5);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-HALF, -10, -HALF), new THREE.Vector3(HALF, 60, HALF));

    // coarse per-cell data, filtered per pixel in the shader
    this.ecoData = new Uint8Array(N * N * 4); // moist, green, fert, -
    this.ecoTex = new THREE.DataTexture(this.ecoData, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.kindData = new Uint8Array(N * N * 4); // wall, path, channel, -
    this.kindTex = new THREE.DataTexture(this.kindData, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    for (const t of [this.ecoTex, this.kindTex]) {
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
    }
    // fine ground heights for the water shader's per-pixel shoreline
    this.groundTex = new THREE.DataTexture(this.fineH, NF, NF, THREE.RedFormat, THREE.FloatType);
    this.groundTex.magFilter = THREE.NearestFilter;
    this.groundTex.minFilter = THREE.NearestFilter;

    const material = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
    const uniforms = {
      uGrassDry: { value: lin('#bcb47c') },
      uGrassLush: { value: lin('#86b862') },
      uForest: { value: lin('#5f8f4f') },
      uSoil: { value: lin('#b39c7c') },
      uClay: { value: lin('#b48d66') },
      uMud: { value: lin('#6b5a46') },
      uBund: { value: lin('#9cc76c') },
      uStone: { value: lin('#8c8c84') },
      uPath: { value: lin('#dccaa6') },
      uChannel: { value: lin('#8f9690') },
      uEcoTex: { value: this.ecoTex },
      uKindTex: { value: this.kindTex },
      uSpan: { value: (N - 1) * DX },
      uCell: { value: N },
    };
    patchMaterial(material, {
      key: 'terrain-fine',
      uniforms,
      vertexHead: `attribute vec2 aTerr; varying vec2 vTerr; varying vec3 vWN;`,
      extraVertex: `vTerr = aTerr; vWN = normalize(mat3(modelMatrix) * objectNormal);`,
      extraFragmentHead: `
        uniform vec3 uGrassDry, uGrassLush, uForest, uSoil, uClay, uMud, uBund, uStone, uPath, uChannel;
        uniform sampler2D uEcoTex;
        uniform sampler2D uKindTex;
        uniform float uSpan;
        uniform float uCell;
        varying vec2 vTerr; varying vec3 vWN;
      `,
      colorFn: /* glsl */ `
        {
          vec3 wp = vWorldPos;
          vec2 tuv = (wp.xz / uSpan + 0.5) * (uCell - 1.0) / uCell + 0.5 / uCell;
          vec4 eco = texture2D(uEcoTex, tuv);
          vec4 kind = texture2D(uKindTex, tuv);
          float moist = eco.x;
          float green = eco.y;
          float fert = eco.z;
          float terr = vTerr.x;
          float rim = vTerr.y;
          float steep = 1.0 - clamp(vWN.y, 0.0, 1.0);
          float n1 = vnoise(wp.xz * 0.21);
          float n2 = vnoise(wp.xz * 0.9 + 7.0);
          float n3 = vnoise(wp.xz * 3.1 - 3.0);
          float mott = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;

          vec3 grass = mix(uGrassDry, uGrassLush, smoothstep(0.1, 0.85, green + (mott - 0.5) * 0.35));
          grass = mix(grass, uForest, smoothstep(0.75, 1.0, green) * 0.55);
          grass *= 0.88 + 0.24 * mott;
          vec3 bare = mix(mix(uSoil, uGrassDry, 0.35), uStone, smoothstep(30.0, 42.0, wp.y) * 0.65);
          vec3 col = mix(bare * (0.9 + 0.2 * n2), grass, smoothstep(0.08, 0.45, green + n3 * 0.1));

          // terrace beds: mud when wet, warm clay when dry, a little richer with silt
          vec3 bed = mix(uClay * (0.92 + 0.12 * n3), uMud, smoothstep(0.25, 0.9, moist));
          bed = mix(bed, bed * vec3(0.86, 0.95, 0.78), fert * 0.6);
          col = mix(col, bed, terr * (1.0 - rim));
          col = mix(col, uBund * (0.9 + 0.2 * n2), rim);

          // dry-stone risers and bare rock on steep ground
          float rocky = smoothstep(0.32, 0.52, steep + (n2 - 0.5) * 0.12) * (1.0 - terr);
          float riser = max(kind.x, rim * 0.0) * smoothstep(0.1, 0.3, steep) * (1.0 - terr);
          vec2 sp = vec2(wp.x + wp.z, wp.y * 2.2);
          float stones = vnoise(sp * 2.6) * 0.6 + vnoise(sp * 5.7) * 0.4;
          float mortar = smoothstep(0.42, 0.36, abs(fract(wp.y * 1.6 + vnoise(sp * 1.3) * 0.6) - 0.5));
          vec3 stone = uStone * (0.78 + 0.38 * stones) * (1.0 - 0.18 * mortar);
          col = mix(col, uStone * (0.8 + 0.3 * mott), rocky * (1.0 - kind.x));
          col = mix(col, stone, clamp(riser * 1.2, 0.0, 1.0));

          // channels are stone-lined, paths are packed earth with scattered stones
          col = mix(col, uChannel * (0.85 + 0.25 * stones), smoothstep(0.35, 0.7, kind.z) * 0.85);
          vec3 pathCol = uPath * (0.86 + 0.2 * n3) * (1.0 - 0.15 * step(0.72, n3));
          col = mix(col, pathCol, smoothstep(0.3, 0.6, kind.y) * (1.0 - terr * 0.4));

          // moisture darkens soil and grass
          col *= mix(1.0, 0.7, moist * (1.0 - 0.45 * terr));
          diffuseColor.rgb = col;
        }
      `,
    });
    this.material = material;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // a floor so the edge of the world sinks into valley mist
    const floorGeo = new THREE.CircleGeometry(1200, 64);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = patchMaterial(new THREE.MeshStandardMaterial({ color: lin('#9fb67c'), roughness: 1 }), { key: 'floor' });
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.position.y = -2.4;
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    this.updateGeometry(0, 0, N - 1, N - 1);
    this.updateAttributes();
    this._buildApron(scene, floorMat);
  }

  /** Low hills rolling from the edge of the sculptable land down to the valley floor. */
  _buildApron(scene, material) {
    const NF = this.NF;
    const fh = this.fineH;
    const perim = [];
    const step = 2;
    for (let i = 0; i < NF - 1; i += step) perim.push([i, 0]);
    for (let j = 0; j < NF - 1; j += step) perim.push([NF - 1, j]);
    for (let i = NF - 1; i > 0; i -= step) perim.push([i, NF - 1]);
    for (let j = NF - 1; j > 0; j -= step) perim.push([0, j]);
    const rings = [0, 5, 14, 30, 60, 110];
    const pos = [];
    const idx = [];
    const P = perim.length;
    for (let r = 0; r < rings.length; r++) {
      for (let k = 0; k < P; k++) {
        const [i, j] = perim[k];
        const x = i * this.dxf - HALF;
        const z = j * this.dxf - HALF;
        const l = Math.hypot(x, z) || 1;
        const d = rings[r];
        const h0 = fh[i + j * NF];
        const t = Math.min(1, d / 70);
        const bump = Math.sin(k * 0.37 + r * 1.3) * 0.6 * (1 - t) * Math.min(1, d / 5);
        const y = h0 + (-2.6 - h0) * (t * t * (3 - 2 * t)) + bump;
        pos.push(x + (x / l) * d, y, z + (z / l) * d);
      }
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let k = 0; k < P; k++) {
        const a = r * P + k;
        const b = r * P + ((k + 1) % P);
        const c = (r + 1) * P + k;
        const d = (r + 1) * P + ((k + 1) % P);
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.apron = new THREE.Mesh(geo, material);
    this.apron.receiveShadow = true;
    scene.add(this.apron);
  }

  /**
   * Height of the fine mesh at grid coordinates (gx, gz) (in coarse cells).
   * Writes terrace/bund flags into this._flags.
   */
  _fine(gx, gz) {
    const t = this.terrain;
    const H = t.H;
    const terrace = t.terrace;
    const sdf = t.sdf;
    const bund = t.bund;
    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i > N - 2) i = N - 2;
    if (j > N - 2) j = N - 2;
    const fx = gx - i;
    const fz = gz - j;
    const c0 = i + j * N;
    const cs = this._cs;
    cs[0] = c0;
    cs[1] = c0 + 1;
    cs[2] = c0 + N;
    cs[3] = c0 + N + 1;
    const ws = this._ws;
    ws[0] = (1 - fx) * (1 - fz);
    ws[1] = fx * (1 - fz);
    ws[2] = (1 - fx) * fz;
    ws[3] = fx * fz;
    // which terrace (if any) owns this spot: the one with the most weight
    let T = 0;
    let best = 0;
    for (let k = 0; k < 4; k++) {
      const tk = terrace[cs[k]];
      if (!tk || tk === T) continue;
      let s = 0;
      for (let m = 0; m < 4; m++) if (terrace[cs[m]] === tk) s += ws[m];
      if (s > best) {
        best = s;
        T = tk;
      }
    }
    const f = this._flags;
    if (!T) {
      f[0] = 0;
      f[1] = 0;
      return H[cs[0]] * ws[0] + H[cs[1]] * ws[1] + H[cs[2]] * ws[2] + H[cs[3]] * ws[3];
    }
    let wT = 0;
    let hT = 0;
    let bT = 0;
    let wB = 0;
    let s = 0;
    let wo = 0;
    let ho = 0;
    for (let k = 0; k < 4; k++) {
      const c = cs[k];
      const w = ws[k];
      if (terrace[c] === T) {
        wT += w;
        hT += w * (H[c] - bund[c]);
        if (bund[c] > 0) {
          bT += w * bund[c];
          wB += w;
        }
        s += w * sdf[c];
      } else {
        // distance from this corner to T's edge, measured through T's own
        // corners (exact for an edge square to the grid, smooth otherwise)
        let sk = 9;
        for (let m = 0; m < 4; m++) {
          if (terrace[cs[m]] !== T) continue;
          const v = ((k ^ m) === 3 ? 1.41421 : 1) * DX + sdf[cs[m]];
          if (v < sk) sk = v;
        }
        wo += w;
        ho += w * H[c];
        s += w * sk;
      }
    }
    hT /= wT;
    bT = wB > 0 ? bT / wB : 0;
    if (s <= 0) {
      const lip = smooth(-0.95, -0.38, s);
      f[0] = 1;
      f[1] = bT > 0.04 ? lip : 0;
      return hT + bT * lip;
    }
    f[0] = 0;
    f[1] = 0;
    if (wo < 1e-5) return hT + bT;
    ho /= wo;
    const edge = hT + bT;
    return edge + (ho - edge) * smooth(0, 0.95, s);
  }

  updateGeometry(x0, z0, x1, z1) {
    if (!this._cs) {
      this._cs = new Int32Array(4);
      this._ws = new Float32Array(4);
      this._flags = new Float32Array(2);
    }
    const S = this.S;
    const NF = this.NF;
    const fh = this.fineH;
    const pos = this.posAttr.array;
    const nor = this.norAttr.array;
    const terr = this.terrAttr.array;
    // fine vertex range covering the coarse box (+1 cell margin)
    const fi0 = Math.max(0, (x0 - 1) * S);
    const fj0 = Math.max(0, (z0 - 1) * S);
    const fi1 = Math.min(NF - 1, (x1 + 1) * S);
    const fj1 = Math.min(NF - 1, (z1 + 1) * S);
    const flags = this._flags;
    for (let j = fj0; j <= fj1; j++) {
      for (let i = fi0; i <= fi1; i++) {
        const v = i + j * NF;
        const h = this._fine(i / S, j / S);
        fh[v] = h;
        pos[v * 3 + 1] = h;
        terr[v * 2] = flags[0] * 255;
        terr[v * 2 + 1] = flags[1] * 255;
      }
    }
    // normals (one extra ring so seams stay smooth)
    const a0 = Math.max(0, fi0 - 1);
    const b0 = Math.max(0, fj0 - 1);
    const a1 = Math.min(NF - 1, fi1 + 1);
    const b1 = Math.min(NF - 1, fj1 + 1);
    const d2 = 2 * this.dxf;
    for (let j = b0; j <= b1; j++) {
      for (let i = a0; i <= a1; i++) {
        const v = i + j * NF;
        const l = fh[i > 0 ? v - 1 : v];
        const r = fh[i < NF - 1 ? v + 1 : v];
        const t = fh[j > 0 ? v - NF : v];
        const b = fh[j < NF - 1 ? v + NF : v];
        const nx = l - r;
        const nz = t - b;
        const len = Math.hypot(nx, d2, nz);
        nor[v * 3] = nx / len;
        nor[v * 3 + 1] = d2 / len;
        nor[v * 3 + 2] = nz / len;
      }
    }
    const first = b0 * NF;
    const count = (b1 - b0 + 1) * NF;
    for (const [attr, size] of [
      [this.posAttr, 3],
      [this.norAttr, 3],
      [this.terrAttr, 2],
    ]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(first * size, count * size);
      attr.needsUpdate = true;
    }
    this.groundTex.needsUpdate = true;
  }

  updateAttributes() {
    const t = this.terrain;
    const w = this.water;
    const eco = this.ecoData;
    const kind = this.kindData;
    const green = this.eco.green;
    const moist = w.moist;
    const fert = w.fert;
    for (let c = 0; c < t.n; c++) {
      const o = c * 4;
      eco[o] = moist[c] * 255;
      eco[o + 1] = green[c] * 255;
      eco[o + 2] = fert[c] * 255;
      kind[o] = t.wall[c] ? 255 : 0;
      kind[o + 1] = t.path[c] ? 255 : 0;
      kind[o + 2] = t.channel[c] ? 255 : 0;
    }
    this.ecoTex.needsUpdate = true;
    this.kindTex.needsUpdate = true;
  }

  /** Bilinear height of the drawn (fine) surface. */
  groundAt(x, z) {
    const NF = this.NF;
    let gx = (x + HALF) / this.dxf;
    let gz = (z + HALF) / this.dxf;
    if (gx < 0) gx = 0;
    else if (gx > NF - 1.001) gx = NF - 1.001;
    if (gz < 0) gz = 0;
    else if (gz > NF - 1.001) gz = NF - 1.001;
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const v = i + j * NF;
    const h = this.fineH;
    const a = h[v] + (h[v + 1] - h[v]) * fx;
    const b = h[v + NF] + (h[v + NF + 1] - h[v + NF]) * fx;
    return a + (b - a) * fz;
  }

  /** Queue a large, low-priority region (slow erosion) in thin bands. */
  queue(x0, z0, x1, z1) {
    this.bands = this.bands || [];
    for (let z = z0; z <= z1; z += 6) this.bands.push([x0, z, x1, Math.min(z1, z + 5)]);
  }

  update() {
    const t = this.terrain;
    if (!t.dirtyMesh.empty) {
      const b = t.dirtyMesh.take();
      this.updateGeometry(b.x0, b.z0, b.x1, b.z1);
    }
    if (this.bands && this.bands.length) {
      const b = this.bands.shift();
      this.updateGeometry(b[0], b[1], b[2], b[3]);
    }
  }
}

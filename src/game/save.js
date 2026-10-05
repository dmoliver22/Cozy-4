// Autosave to localStorage (gzip-compressed when the browser can).
const KEY = 'terraces-save-v1';

function toB64(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(str, Type) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

async function gzip(text) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('gzip');
  const stream = new Blob([text]).stream().pipeThrough(cs);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return toB64(buf);
}

async function gunzip(b64) {
  const bytes = fromB64(b64, Uint8Array);
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

export function hasSave() {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function saveGame(game) {
  const t = game.terrain;
  const w = game.water;
  const s = t.futureSnapshot();
  const data = {
    v: 1,
    hour: game.sky.hour,
    hold: game.sky.hold,
    rock: toB64(s.rock),
    soil: toB64(s.soil),
    terrace: toB64(s.terrace),
    wall: toB64(s.wall),
    path: toB64(s.path),
    channel: toB64(s.channel),
    levels: toB64(s.levels),
    sdf: toB64(s.sdf),
    water: toB64(w.d),
    moist: toB64(w.moist),
    fert: toB64(w.fert),
    green: toB64(game.eco.green),
    crops: game.crops.serialize(),
    houses: game.village.serialize(),
    trees: game.trees.serialize(),
    goals: game.goals.serialize(),
    flags: game.ui?.flags ?? {},
    firstCascade: game.firstCascade,
    bridges: game.structures.bridges.map((b) => [b.A.x, b.A.z, b.B.x, b.B.z].map((v) => +v.toFixed(2))),
  };
  const json = JSON.stringify(data);
  const packed = await gzip(json);
  try {
    localStorage.setItem(KEY, packed ? 'gz:' + packed : json);
  } catch {
    /* quota or private mode: the mountain just won't persist */
  }
}

export async function loadGame(game) {
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  const json = raw.startsWith('gz:') ? await gunzip(raw.slice(3)) : raw;
  const d = JSON.parse(json);
  if (d.v !== 1) return false;
  const t = game.terrain;
  const w = game.water;
  t.rock.set(fromB64(d.rock, Float32Array));
  t.soil.set(fromB64(d.soil, Float32Array));
  t.terrace.set(fromB64(d.terrace, Int16Array));
  t.wall.set(fromB64(d.wall, Uint8Array));
  t.path.set(fromB64(d.path, Uint8Array));
  t.channel.set(fromB64(d.channel, Uint8Array));
  t.levels.set(fromB64(d.levels, Float32Array));
  if (d.sdf) t.sdf.set(fromB64(d.sdf, Float32Array));
  t.recount();
  t.refreshAll();
  w.d.set(fromB64(d.water, Float32Array));
  w.moist.set(fromB64(d.moist, Float32Array));
  w.fert.set(fromB64(d.fert, Float32Array));
  game.eco.green.set(fromB64(d.green, Float32Array));
  w.fL.fill(0);
  w.fR.fill(0);
  w.fT.fill(0);
  w.fB.fill(0);
  game.physics.rebuildGround();
  game.terrainView.updateGeometry(0, 0, 159, 159);
  game.terrainView.updateAttributes();
  game.atmo.updateHeight();
  game.trees.load(d.trees || []);
  game.crops.load(d.crops || []);
  game.village.load(d.houses || [], game.time);
  game.goals.load(d.goals);
  game.sky.hour = d.hour ?? game.sky.hour;
  game.sky.hold = !!d.hold;
  game.ui?.setHold(game.sky.hold);
  if (game.ui && d.flags) Object.assign(game.ui.flags, d.flags);
  game.firstCascade = !!d.firstCascade;
  for (const [ax, az, bx, bz] of d.bridges || []) game.structures.buildBridge({ x: ax, z: az }, { x: bx, z: bz });
  return true;
}

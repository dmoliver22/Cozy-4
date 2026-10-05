import '@fontsource/jost/300.css';
import '@fontsource/jost/400.css';
import '@fontsource/jost/500.css';
import './ui/style.css';
import * as THREE from 'three';
import { initRapier } from './physics/physics.js';
import { Game } from './game/game.js';
import { OrbitCam } from './game/camera.js';
import { Post } from './render/post.js';
import { UI } from './ui/ui.js';
import { TOOLS } from './game/tools.js';
import { saveGame, loadGame, hasSave, clearSave } from './game/save.js';
import { AudioEngine } from './audio/audio.js';

// How a photo reaches the player. A hosted build runs in a sandbox that blocks
// plain downloads, so it offers the picture through the host's save prompt,
// and shows no photo button when the host can't do that.
let savePhoto = null;
if (import.meta.env.VITE_ARTIFACT) {
  Promise.resolve(window.claude?.use?.('downloads'))
    .then((downloads) => {
      if (!downloads) return;
      savePhoto = (blob, filename) =>
        downloads.save({ filename, data: blob }).catch((err) => {
          const code = err?.code;
          if (code === 'declined') return;
          if (code === 'rate_limited') ui?.toast('A photo is already waiting to be saved');
          else if (code === 'too_large' || code === 'bad_request' || code === 'transform_error') ui?.toast('That photo could not be saved');
          else {
            savePhoto = null;
            ui?.setPhoto(false);
          }
        });
      ui?.setPhoto(true);
    })
    .catch(() => {});
} else {
  savePhoto = (blob, filename) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
}
const canvas = document.getElementById('scene');
const root = document.getElementById('ui');
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(innerWidth, innerHeight) < 600;
const quality = new URLSearchParams(location.search).get('quality') || (coarse || small ? 'low' : 'high');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
} catch (err) {
  root.innerHTML = '<div class="title"><h1>Terraces</h1><p>This toy needs WebGL 2. Try a recent Chrome, Edge, Firefox or Safari.</p></div>';
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'low' ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const tm = new URLSearchParams(location.search).get('tm');
renderer.toneMapping = tm === 'agx' ? THREE.AgXToneMapping : tm === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
renderer.toneMappingExposure = tm === 'agx' ? 1.1 : tm === 'aces' ? 0.95 : 1.04;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 3000);
const cam = new OrbitCam(camera);
cam.autoRotate = 0.035;
Object.assign(cam.goal, { el: 0.3, dist: 215, ty: 14 });
Object.assign(cam.cur, cam.goal);

let game = null;
let post = null;
let ui = null;
let audio = null;
let started = false;
let photoPending = false;
let uiHidden = false;
let lastSave = 0;

function fitCamera() {
  const aspect = innerWidth / innerHeight;
  camera.aspect = aspect;
  camera.fov = aspect < 1 ? Math.min(58, 30 / Math.max(aspect, 0.45)) : 30;
  camera.updateProjectionMatrix();
}
fitCamera();

async function boot() {
  let rapier = true;
  try {
    await initRapier();
  } catch (err) {
    // e.g. a sandbox that forbids compiling WebAssembly: use the JS integrator
    rapier = false;
    console.warn('Rapier unavailable, using the fallback physics', err);
  }
  game = new Game(scene, { seed: 7, meshDetail: quality === 'potato' ? 1 : 2, rapier });
  if (quality !== 'high') game.sky.sun.shadow.mapSize.set(1024, 1024);
  if (quality === 'potato') renderer.shadowMap.enabled = false;
  post = new Post(renderer, scene, camera, quality);
  ui = new UI(root, game, hooks, { photo: !!savePhoto });
  ui.ready(hasSave());
  requestAnimationFrame(frame);
}

const hooks = {
  async start(fresh) {
    if (started) return;
    started = true;
    // create the audio context synchronously, inside the click
    let actx = null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC();
      actx.resume();
    } catch {
      actx = null;
    }
    if (fresh) clearSave();
    else if (hasSave()) {
      try {
        await loadGame(game);
      } catch (err) {
        console.warn('Could not restore the saved mountain', err);
      }
    }
    cam.autoRotate = 0;
    cam.goal.az = 0.22;
    cam.goal.el = 0.62;
    cam.goal.dist = 150;
    cam.goal.tx = 0;
    cam.goal.tz = 14;
    cam.goal.ty = 8;
    ui.start();
    try {
      if (!actx) throw new Error('no AudioContext');
      audio = new AudioEngine();
      await audio.start(actx);
      game.audio = audio;
      ui.setSound(true);
    } catch (err) {
      console.warn('Audio unavailable', err);
      ui.setSound(false);
    }
    if (!game.firstCascade && game.stats.watered < 3) {
      const h = game.mountain.features.hintCut;
      game.cursor.showHint(scene, h.from, h.to);
      setTimeout(() => ui.hint('The Morning Spring is held back by an old stone berm. Drag from the spring pool down to the old terraces below — one cut is enough.', 12000), 1600);
    }
  },
  toggleSound() {
    if (!audio) return;
    audio.setMuted(!audio.muted);
    ui.setSound(!audio.muted);
  },
  toggleHold() {
    game.sky.hold = !game.sky.hold;
    ui.setHold(game.sky.hold);
    ui.toast(game.sky.hold ? 'Holding the light' : 'The day moves on', 2200);
  },
  toggleRain() {
    const on = game.weather.target === 0;
    game.forceRain(on);
    ui.setRain(on);
  },
  photo() {
    photoPending = true;
  },
  newGame() {
    clearSave();
    location.reload();
  },
  click() {
    audio?.click();
  },
};

// ---------------------------------------------------------------- input

const pointers = new Map();
let mode = null;
let toolStart = 0;
let hover = null;
let gesture = null;
const ndc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

function hitAt(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return game.pick(raycaster.ray);
}

function gestureState() {
  const pts = [...pointers.values()];
  const a = pts[0];
  const b = pts[1];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (!game) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!started) return;
  if (pointers.size >= 2) {
    if (mode === 'tool') {
      if (performance.now() - toolStart < 300) game.tools.cancel();
      else game.tools.end();
    }
    mode = 'gesture';
    gesture = gestureState();
    return;
  }
  if (e.pointerType === 'mouse' && e.button === 2) mode = 'orbit';
  else if (e.pointerType === 'mouse' && (e.button === 1 || (e.button === 0 && (e.shiftKey || e.altKey)))) mode = 'pan';
  else if (e.button === 0 || e.pointerType !== 'mouse') {
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) {
      mode = 'tool';
      toolStart = performance.now();
      hover = hit;
      game.tools.begin(hit);
    } else {
      mode = 'orbit';
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!game) return;
  const p = pointers.get(e.pointerId);
  const dx = p ? e.clientX - p.x : 0;
  const dy = p ? e.clientY - p.y : 0;
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }
  if (!started) return;
  if (mode === 'gesture' && pointers.size >= 2) {
    const g = gestureState();
    cam.zoom(gesture.d / Math.max(g.d, 1), hitAt(g.cx, g.cy));
    cam.rotate((g.cx - gesture.cx) * -0.006 + (g.ang - gesture.ang) * -1, (g.cy - gesture.cy) * 0.004);
    gesture = g;
  } else if (mode === 'orbit' && p) {
    cam.rotate(-dx * 0.006, dy * 0.004);
  } else if (mode === 'pan' && p) {
    cam.pan(dx, dy);
  } else if (mode === 'tool' && p) {
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) {
      hover = hit;
      game.tools.move(hit);
    }
  } else if (e.pointerType === 'mouse') {
    hover = hitAt(e.clientX, e.clientY);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (mode === 'tool') game?.tools.end();
  if (pointers.size === 0) mode = null;
  else if (mode === 'gesture' && pointers.size === 1) mode = 'none';
  if (e.pointerType !== 'mouse') hover = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && mode !== 'tool') hover = null;
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!game || !started) return;
    if (e.ctrlKey && mode !== 'tool') {
      cam.zoom(Math.exp(e.deltaY * 0.01), hitAt(e.clientX, e.clientY));
      return;
    }
    if (e.altKey) {
      const t = game.tools;
      t.setRadius(t.r - Math.sign(e.deltaY) * 0.25);
      return;
    }
    cam.zoom(Math.exp(e.deltaY * 0.0012), hitAt(e.clientX, e.clientY));
  },
  { passive: false }
);

addEventListener('keydown', (e) => {
  if (!game || !started) return;
  const t = game.tools;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) t.redo();
    else t.undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
    e.preventDefault();
    t.redo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const toolKeys = { Digit1: 'terrace', Digit2: 'channel', Digit3: 'plant', Digit4: 'path', Digit5: 'soften' };
  if (toolKeys[e.code]) {
    t.setTool(toolKeys[e.code]);
    audio?.click();
    return;
  }
  if (e.code === 'BracketLeft') t.setRadius(t.r - 0.4);
  else if (e.code === 'BracketRight') t.setRadius(t.r + 0.4);
  else if (e.code === 'KeyH') {
    uiHidden = !uiHidden;
    document.body.classList.toggle('hidden-ui', uiHidden);
  } else if (e.code === 'KeyP' && savePhoto) photoPending = true;
  else if (e.code === 'KeyM') hooks.toggleSound();
  else if (e.code === 'KeyC' || e.code === 'Home') Object.assign(cam.goal, { az: 0.22, el: 0.62, dist: 150, tx: 0, tz: 14, ty: 8 });
  else if (e.code === 'Escape') ui.toggleHelp(false);
  else cam.keys.add(e.code);
});
addEventListener('keyup', (e) => cam.keys.delete(e.code));
addEventListener('blur', () => cam.keys.clear());

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  fitCamera();
  post?.setSize(innerWidth, innerHeight);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    audio?.suspend();
    if (started && game) saveGame(game).catch(() => {});
  } else audio?.resume();
});

// ---------------------------------------------------------------- loop

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  game.update(dt);
  cam.update(dt);
  game.camTarget = { x: cam.cur.tx, z: cam.cur.tz };
  game.atmo.focus.value = cam.cur.dist;

  // brush cursor
  const tools = game.tools;
  const showCursor = started && hover && !uiHidden && !photoPending && mode !== 'orbit' && mode !== 'pan' && mode !== 'gesture';
  game.cursor.setVisible(!!showCursor);
  if (showCursor) {
    let level = null;
    if (tools.tool === 'terrace') level = tools.stroke ? tools.stroke.level : game.terrain.previewLevel(hover.x, hover.z, tools.r);
    game.cursor.update(hover.x, hover.z, tools.r, TOOLS[tools.tool].color, level);
  }

  // more tilt-shift when you pull back: the mountain reads as a model
  const zt = THREE.MathUtils.clamp((cam.cur.dist - 40) / 220, 0, 1);
  post.setTilt(0.8 + zt * 2.4, 0.5, 0.14 + (1 - zt) * 0.1);
  post.grade.uniforms.uNight.value = game.sky ? Math.min(1, game.sky.elevation < 0 ? -game.sky.elevation / 10 : 0) : 0;
  post.grade.uniforms.uTime.value = now * 0.001;
  const wasHidden = uiHidden;
  if (photoPending) {
    game.cursor.setVisible(false);
    game.cursor.clearHint && game.cursor.hint && (game.cursor.hint.visible = false);
  }
  post.render(dt);
  if (photoPending) {
    photoPending = false;
    const name = `terraces-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    canvas.toBlob((blob) => {
      if (blob && savePhoto) savePhoto(blob, name);
    });
    if (game.cursor.hint) game.cursor.hint.visible = true;
    ui.photoFlash();
    audio?.shutter();
    uiHidden = wasHidden;
  }

  if (started && now - lastSave > 30000) {
    lastSave = now;
    saveGame(game).catch(() => {});
  }
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  root.innerHTML = `<div class="title"><h1>Terraces</h1><p>Something went wrong while shaping the mountain.<br/><small>${String(err.message || err)}</small></p></div>`;
});

// handy for debugging and automated checks
window.__terraces = () => ({ game, cam, camera, renderer, save: () => saveGame(game) });

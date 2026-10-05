// Minimal interface: a slim tool tray, a seed pouch, a small goal card and
// gentle hints. Everything else is landscape.
import { TOOLS } from '../game/tools.js';
import { RICE, TEA, FLOWER } from '../game/crops.js';

const ICONS = {
  terrace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19h18M5 19v-4h5v-4h5V7h4"/><path d="M15 7c1-1.6 2.6-2.4 4-2.4" opacity=".6"/></svg>',
  channel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6c3 0 3 4 6 4s3 4 6 4 3 4 4 4"/><path d="M3 9.5c3 0 3 4 6 4s3 4 6 4" opacity=".45"/></svg>',
  plant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21v-8"/><path d="M12 13c0-4 3-6 7-6 0 4-3 6-7 6z"/><path d="M12 15c0-3-2.4-5-6-5 0 3 2.4 5 6 5z"/></svg>',
  path: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="7" cy="17" rx="2" ry="3"/><ellipse cx="13" cy="11" rx="2" ry="3"/><ellipse cx="18" cy="5" rx="1.6" ry="2.4"/></svg>',
  soften: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3-6 6-8 9-5s6 1 9-5"/><path d="M3 21h18" opacity=".5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12" transform="translate(0 -6)"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12" transform="translate(0 -6)"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15a4 4 0 01-.4-8A5.5 5.5 0 0117 8a3.5 3.5 0 01.5 7z"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 014.8.9c0 1.7-2.4 2.1-2.4 3.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>',
};

const TOOL_DESC = {
  terrace: 'Cut a level shelf at the height where you start. Drag along the slope; water fills it and spills to the next.',
  channel: 'Dig a groove that only ever runs downhill from where you start — lead water where you want it.',
  plant: 'Scatter seeds from the pouch. They tumble, settle, and sprout if the water suits them.',
  path: 'Lay a footpath. Villagers walk faster on paths, and paths can join hamlets.',
  soften: 'Ease the land back toward its natural slope.',
};

const SEEDS = [
  { id: RICE, label: 'Rice', color: '#8dbf6a', tip: 'Rice grows in standing water.' },
  { id: TEA, label: 'Tea', color: '#3f6f45', tip: 'Tea likes damp slopes that drain — just below a paddy.' },
  { id: FLOWER, label: 'Flowers', color: '#f2a8bd', tip: 'Flowers bloom almost anywhere with a little water.' },
];

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class UI {
  constructor(root, game, hooks) {
    this.root = root;
    this.g = game;
    this.hooks = hooks;
    this.hintQueue = [];
    this.flags = {};
    this.started = false;
    this._build();
    game.ui = this;
    game.tools.onChange = () => this.refreshTray();
  }

  _build() {
    const r = this.root;
    // title
    this.title = el('div', 'title');
    this.title.innerHTML = `
      <h1>Terraces</h1>
      <p>Sculpt a misty mountainside into terraced fields.<br/>The water cascades from step to step, and villages grow wherever it reaches.</p>
      <div class="actions"></div>
      <div class="credit">Headphones recommended · no timers, nothing to lose</div>`;
    this.titleActions = this.title.querySelector('.actions');
    this.loadingEl = el('div', 'loading', 'Shaping the mountain…');
    this.titleActions.appendChild(this.loadingEl);
    r.appendChild(this.title);

    // goal card
    this.goalsEl = el('section', 'goals');
    this.goalsEl.innerHTML = `<header><h2></h2><span class="time"></span></header><ul class="goal-list"></ul>`;
    this.goalsEl.querySelector('header').addEventListener('click', () => this.goalsEl.classList.toggle('collapsed'));
    this.goalsEl.style.opacity = 0;
    r.appendChild(this.goalsEl);

    // top bar
    this.topbar = el('div', 'topbar');
    this.btnSound = this._iconBtn('sound', 'Sound', () => this.hooks.toggleSound());
    this.btnSun = this._iconBtn('sun', 'Hold the light (pause the day)', () => this.hooks.toggleHold());
    this.btnRain = this._iconBtn('rain', 'Call a rain shower', () => this.hooks.toggleRain());
    this.btnPhoto = this._iconBtn('photo', 'Photo (hides the interface)', () => this.hooks.photo());
    this.btnHelp = this._iconBtn('help', 'How to play', () => this.toggleHelp());
    this.topbar.append(this.btnSound, this.btnSun, this.btnRain, this.btnPhoto, this.btnHelp);
    this.topbar.style.opacity = 0;
    r.appendChild(this.topbar);

    // tray
    this.trayWrap = el('div', 'tray-wrap');
    this.sub = el('div', 'subtray');
    this.seedBtns = SEEDS.map((s) => {
      const b = el('button', 'seed', `<span class="dot" style="background:${s.color}"></span>${s.label}`);
      b.title = s.tip;
      b.addEventListener('click', () => {
        this.g.tools.setSeed(s.id);
        this.hint(s.tip, 3500);
      });
      return b;
    });
    this.seedWrap = el('div', 'seeds');
    this.seedWrap.style.display = 'flex';
    this.seedWrap.style.gap = '2px';
    this.seedWrap.append(...this.seedBtns);
    this.size = el('label', 'size', `Size <input type="range" min="0" max="100" step="1" />`);
    this.sizeInput = this.size.querySelector('input');
    this.sizeInput.addEventListener('input', () => {
      const t = TOOLS[this.g.tools.tool];
      this.g.tools.setRadius(t.min + (t.max - t.min) * (this.sizeInput.value / 100));
    });
    this.desc = el('div', 'tool-desc');
    this.sub.append(this.seedWrap, this.size, this.desc);

    this.tray = el('div', 'tray');
    this.toolBtns = {};
    for (const k of Object.keys(TOOLS)) {
      const b = el('button', 'tool', `${ICONS[k]}<span>${TOOLS[k].label}</span>`);
      b.title = `${TOOLS[k].label} — ${TOOL_DESC[k]}`;
      b.addEventListener('click', () => {
        this.g.tools.setTool(k);
        this.hooks.click?.();
      });
      this.toolBtns[k] = b;
      this.tray.appendChild(b);
    }
    this.tray.appendChild(el('div', 'sep'));
    this.undoBtn = el('button', 'tool small', `${ICONS.undo}<span>Undo</span>`);
    this.undoBtn.title = 'Undo (Ctrl+Z)';
    this.undoBtn.addEventListener('click', () => this.g.tools.undo());
    this.redoBtn = el('button', 'tool small', `${ICONS.redo}<span>Redo</span>`);
    this.redoBtn.title = 'Redo (Ctrl+Shift+Z)';
    this.redoBtn.addEventListener('click', () => this.g.tools.redo());
    this.tray.append(this.undoBtn, this.redoBtn);
    this.trayWrap.append(this.sub, this.tray);
    this.trayWrap.style.opacity = 0;
    r.appendChild(this.trayWrap);

    this.hintEl = el('div', 'hint');
    r.appendChild(this.hintEl);
    this.toastEl = el('div', 'toast');
    r.appendChild(this.toastEl);
    this.banner = el('div', 'banner', '<h3></h3><p></p>');
    r.appendChild(this.banner);
    this.flash = el('div', 'photo-flash');
    r.appendChild(this.flash);

    this.help = el('div', 'panel');
    this.help.innerHTML = `
      <h2>Terraces</h2>
      <p>You don't place buildings — you shape the land. Cut terraces into the slope and the spring water fills them, spilling from step to step. Sow along the water and hamlets appear on their own.</p>
      <ul>
        <li><b>Terrace</b> — drag to cut a level shelf at the height where you start. Start on an existing terrace to extend it.</li>
        <li><b>Channel</b> — a groove that always runs downhill from where you begin.</li>
        <li><b>Sow</b> — rice in standing water, tea on damp drained slopes, flowers nearly anywhere.</li>
        <li><b>Path</b> — villagers love a path; join two hamlets for the second set of goals.</li>
        <li><b>Soften</b> — return the land toward its natural shape. Undo is always there too.</li>
      </ul>
      <p><kbd>Left drag</kbd> use tool · <kbd>Right drag</kbd> orbit · <kbd>Wheel</kbd> zoom · <kbd>Middle</kbd>/<kbd>Shift</kbd>+drag pan<br/>
      Touch: one finger uses the tool, two fingers orbit and pinch to zoom.<br/>
      <kbd>1</kbd>–<kbd>5</kbd> tools · <kbd>[</kbd> <kbd>]</kbd> size · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>H</kbd> hide interface · <kbd>P</kbd> photo</p>
      <p style="font-size:13px">Made as a love letter to the rice terraces of Southeast Asia and the Andes. Architecture and music here are gentle placeholders — the full game is to be made with people from those places.</p>
      <div class="row"><button class="btn" data-close>Back to the mountain</button><button class="btn ghost" data-new>New mountain</button></div>`;
    this.help.querySelector('[data-close]').addEventListener('click', () => this.toggleHelp(false));
    this.help.querySelector('[data-new]').addEventListener('click', () => this.hooks.newGame());
    r.appendChild(this.help);
    this.refreshTray();
  }

  _iconBtn(icon, title, fn) {
    const b = el('button', 'icon-btn', ICONS[icon]);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  }

  ready(hasSave) {
    this.loadingEl.remove();
    const begin = el('button', 'btn', hasSave ? 'Continue' : 'Begin');
    begin.addEventListener('click', () => this.hooks.start(false));
    this.titleActions.appendChild(begin);
    if (hasSave) {
      const fresh = el('button', 'btn ghost', 'New mountain');
      fresh.addEventListener('click', () => this.hooks.start(true));
      this.titleActions.appendChild(fresh);
    }
    begin.focus();
  }

  start() {
    this.started = true;
    this.title.classList.add('gone');
    for (const e of [this.goalsEl, this.topbar, this.trayWrap]) {
      e.style.transition = 'opacity 1.2s ease 0.6s';
      e.style.opacity = 1;
    }
    this.updateGoals();
  }

  setSound(on) {
    this.btnSound.innerHTML = on ? ICONS.sound : ICONS.mute;
    this.btnSound.classList.toggle('off', !on);
  }

  setHold(on) {
    this.btnSun.classList.toggle('on', on);
  }

  setRain(on) {
    this.btnRain.classList.toggle('on', on);
  }

  refreshTray() {
    const tools = this.g.tools;
    for (const [k, b] of Object.entries(this.toolBtns)) b.classList.toggle('active', tools.tool === k);
    this.seedBtns.forEach((b, i) => b.classList.toggle('active', tools.seed === SEEDS[i].id));
    this.seedWrap.style.display = tools.tool === 'plant' ? 'flex' : 'none';
    const t = TOOLS[tools.tool];
    const adjustable = t.max > t.min;
    this.size.style.display = adjustable ? 'flex' : 'none';
    if (adjustable) this.sizeInput.value = String(Math.round(((tools.r - t.min) / (t.max - t.min)) * 100));
    this.desc.textContent = tools.tool === 'plant' ? '' : TOOL_DESC[tools.tool];
    this.desc.style.display = tools.tool === 'plant' ? 'none' : '';
    this.undoBtn.disabled = tools.undoStack.length === 0;
    this.redoBtn.disabled = tools.redoStack.length === 0;
  }

  updateGoals() {
    const goals = this.g.goals;
    const tier = goals.current;
    const h2 = this.goalsEl.querySelector('h2');
    h2.textContent = goals.finished ? 'The mountain is yours' : tier.name;
    this.goalsEl.querySelector('.time').textContent = this.g.sky.label;
    const ul = this.goalsEl.querySelector('.goal-list');
    if (ul.dataset.tier !== String(goals.tier)) {
      ul.dataset.tier = String(goals.tier);
      ul.innerHTML = '';
      const list = goals.finished ? [] : tier.goals;
      for (const g of list) {
        const li = el('li', 'goal');
        li.dataset.id = g.id;
        li.innerHTML = `<span class="tick">${ICONS.check}</span><span class="txt">${g.text}</span><span class="prog"></span><span class="bar"><i></i></span>`;
        ul.appendChild(li);
      }
      if (goals.finished) {
        const li = el('li', 'goal done');
        li.innerHTML = `<span class="tick">${ICONS.check}</span><span class="txt">Keep shaping — there is no rush, and nothing to lose.</span><span></span>`;
        ul.appendChild(li);
      }
    }
    if (goals.finished) return;
    for (const g of tier.goals) {
      const li = ul.querySelector(`[data-id="${g.id}"]`);
      if (!li) continue;
      li.classList.toggle('done', g.done);
      li.querySelector('.prog').textContent = g.target > 1 ? `${Math.floor(g.value)}/${g.target}` : g.done ? '✓' : '';
      li.querySelector('.bar i').style.width = `${(g.value / g.target) * 100}%`;
    }
    this._advanceHints();
  }

  pulse() {
    this.goalsEl.classList.remove('pulse');
    void this.goalsEl.offsetWidth;
    this.goalsEl.classList.add('pulse');
  }

  goalDone(g) {
    this.toast(`<span class="leaf">❀</span>${g.text}`);
    this.pulse();
    this.updateGoals();
  }

  tierDone(tier) {
    const names = ['The mountain wakes', 'A living mountain'];
    const sub = tier === 0 ? 'New goals are on the card — or simply keep shaping.' : 'Every goal is met. The mountain is yours to keep shaping.';
    this.showBanner(names[tier] || 'Well done', sub);
    this.updateGoals();
  }

  showBanner(title, sub) {
    this.banner.querySelector('h3').textContent = title;
    this.banner.querySelector('p').textContent = sub;
    this.banner.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => this.banner.classList.remove('show'), 6500);
  }

  toast(html, ms = 4200) {
    this.toastEl.innerHTML = html;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  hint(text, ms = 7000) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('show');
    clearTimeout(this._hintT);
    if (ms > 0) this._hintT = setTimeout(() => this.hintEl.classList.remove('show'), ms);
  }

  clearHint() {
    this.hintEl.classList.remove('show');
  }

  toggleHelp(force) {
    const show = force ?? !this.help.classList.contains('show');
    this.help.classList.toggle('show', show);
  }

  firstCascade() {
    if (this.flags.cascade) return;
    this.flags.cascade = true;
    this.flags.cascadeAt = this.g.time;
    this.g.cursor.clearHint(this.g.scene);
    setTimeout(() => this.hint('The old terraces wake. Open the seed pouch (Sow → Rice) and scatter seeds into the flooded paddies.', 9000), 2500);
  }

  /** A few contextual nudges, each shown once. */
  _advanceHints() {
    if (!this.started) return;
    const g = this.g;
    const f = this.flags;
    const st = g.crops.stats;
    if (!f.firstStroke && g.tools.strokeCount > 0) f.firstStroke = g.time;
    if (f.firstStroke && !f.cascade && !f.nudge && g.time - f.firstStroke > 14 && g.stats.watered < 2) {
      f.nudge = true;
      this.hint('Tip: start your cut inside the spring pool, so the new shelf sits level with the water. The Channel tool always runs downhill, too.', 9000);
    }
    if (!f.riceTip && st.rice > 0) {
      f.riceTip = true;
      setTimeout(() => this.hint('Rice grows where water stands. Tea likes the damp slopes just below a paddy; flowers grow almost anywhere.', 8000), 1500);
    }
    if (!f.homeTip && st.riceMature >= 8 && g.village.count === 0) {
      f.homeTip = true;
      this.hint('When the fields prosper, a hamlet appears on its own — on dry, level ground near the crops.', 8000);
    }
    if (!f.firstHome && g.village.count > 0) {
      f.firstHome = true;
      this.hint('A hamlet has begun. More terraces and fields will help it grow.', 7000);
    }
    if (!f.camTip && f.cascade && g.time - (f.cascadeAt || g.time) > 25) {
      f.camTip = true;
      const touch = matchMedia('(pointer: coarse)').matches;
      this.hint(touch ? 'Two fingers turn the mountain; pinch to look closer.' : 'Right-drag to turn the mountain, scroll to look closer, Shift-drag to pan.', 6500);
    }
    if (!f.tier2Tip && g.goals.tier >= 1) {
      f.tier2Tip = true;
      setTimeout(() => this.hint('Footpaths that cross a stream become little rope bridges. Join two hamlets to finish the mountain.', 9000), 8000);
    }
  }

  photoFlash() {
    this.flash.style.transition = 'none';
    this.flash.style.opacity = 0.85;
    requestAnimationFrame(() => {
      this.flash.style.transition = 'opacity 0.7s ease';
      this.flash.style.opacity = 0;
    });
  }
}

// All sound is synthesised at runtime — much of it with physical models:
//   * plucked strings by Karplus–Strong (a delay line with a damped average)
//   * bells and gongs by modal synthesis (sums of decaying inharmonic modes)
//   * water "plips" at the Minnaert resonance of the trapped bubble
//   * running water, wind and rain from shaped noise driven by the simulation
// Music is generative and sparse: a few pentatonic notes, lots of space.

const PENTA = [0, 2, 4, 7, 9]; // major pentatonic steps
const ROOT = 146.83; // D3

function noteFreq(step, octave = 0) {
  const idx = ((step % 5) + 5) % 5;
  const oct = Math.floor(step / 5) + octave;
  return ROOT * Math.pow(2, (PENTA[idx] + oct * 12) / 12);
}

export class AudioEngine {
  constructor() {
    this.muted = false;
    this.ctx = null;
    this.limits = {};
    this.musicT = 3;
    this.birdT = 2;
    this.bellT = 20;
    this.cricketT = 1;
    this.dropT = 0;
    this.lastCarve = 0;
  }

  /** Pass a context created inside the user's click so strict browsers allow sound. */
  async start(existing) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = existing || new AC();
    this.ctx = ctx;
    if (ctx.state !== 'running') await ctx.resume();
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 2.5);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(3.2, 2.4);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.55;
    this.reverb.connect(this.wet).connect(this.master);
    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.master);

    this.noise = this._noiseBuffer(4);
    this.pink = this._pinkBuffer(6);

    // running water: two band-passed pink noise layers
    this.water = this._loop(this.pink, 'bandpass', 900, 0.6, 0);
    this.water2 = this._loop(this.pink, 'bandpass', 2600, 1.4, 0);
    this.wind = this._loop(this.pink, 'lowpass', 380, 0.7, 0);
    this.rain = this._loop(this.noise, 'highpass', 2200, 0.5, 0);

    // pre-render physically modelled instrument tones
    this.plucks = [];
    for (let s = 0; s < 11; s++) this.plucks.push(this._karplus(noteFreq(s, 1), 3.2, 0.996, 0.45));
    this.highPlucks = [];
    for (let s = 0; s < 8; s++) this.highPlucks.push(this._karplus(noteFreq(s, 3), 1.4, 0.994, 0.25));
    this.bells = [
      this._modal(noteFreq(0, 1), [1, 2.01, 2.76, 4.07, 5.42, 6.8], [1, 0.55, 0.42, 0.25, 0.15, 0.08], 5.5),
      this._modal(noteFreq(3, 1), [1, 2.01, 2.76, 4.07, 5.42], [1, 0.5, 0.4, 0.22, 0.12], 4.5),
      this._modal(noteFreq(0, 0), [1, 1.5, 2.0, 2.76, 3.4], [1, 0.3, 0.5, 0.3, 0.2], 7),
    ];
    this.tinkle = this._modal(1650, [1, 2.4, 3.9, 5.6], [1, 0.4, 0.25, 0.1], 1.2);
    this.gong = this._modal(noteFreq(0, -1), [1, 1.48, 1.98, 2.43, 2.9, 3.6, 4.4], [1, 0.6, 0.55, 0.4, 0.3, 0.2, 0.12], 9);
  }

  // ------------------------------------------------------------ buffers

  _noiseBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _pinkBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
    return b;
  }

  _impulse(sec, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 120 ? i / 120 : 1);
      }
    }
    return b;
  }

  /** Karplus–Strong plucked string: noise burst through a damped delay loop. */
  _karplus(freq, sec, decay, bright) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * sec);
    const b = ctx.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    const period = sr / freq;
    const P = Math.floor(period);
    const frac = period - P;
    const line = new Float32Array(P + 2);
    // soft excitation (low-passed noise) = a gentle finger pluck
    let lp = 0;
    for (let i = 0; i < line.length; i++) {
      lp += ((Math.random() * 2 - 1) - lp) * bright;
      line[i] = lp;
    }
    let idx = 0;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const a = line[idx];
      const nextIdx = (idx + 1) % line.length;
      const bb = line[nextIdx];
      // averaging filter (string loss) with fractional delay
      const y = (a * (1 - frac) + bb * frac + prev) * 0.5 * decay;
      prev = a;
      line[idx] = y;
      d[i] = y;
      idx = nextIdx;
    }
    // fade out tail
    for (let i = n - 2000; i < n; i++) d[i] *= (n - i) / 2000;
    return b;
  }

  /** Modal synthesis: a struck bell is a sum of exponentially decaying modes. */
  _modal(freq, ratios, amps, sec) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * sec);
    const b = ctx.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    for (let m = 0; m < ratios.length; m++) {
      const f = freq * ratios[m];
      const tau = sec / (1 + m * 0.9);
      const amp = amps[m] * 0.3;
      const w = (2 * Math.PI * f) / sr;
      const ph = Math.random() * 6.28;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        d[i] += Math.sin(w * i + ph) * amp * Math.exp(-t / tau) * Math.min(1, i / 60);
      }
    }
    return b;
  }

  _loop(buffer, type, freq, q, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = Math.random();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(f).connect(g);
    if (pan) {
      g.connect(pan).connect(this.dry);
      pan.connect(this.reverb);
    } else {
      g.connect(this.dry);
    }
    src.start(ctx.currentTime + Math.random() * 0.1, Math.random() * buffer.duration);
    return { src, f, g, pan };
  }

  _play(buffer, { gain = 0.3, rate = 1, pan = 0, wet = 0.5, when = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let out = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      out = p;
    }
    src.connect(g);
    out.connect(this.dry);
    if (wet > 0) {
      const w = ctx.createGain();
      w.gain.value = wet;
      out.connect(w).connect(this.reverb);
    }
    src.start(ctx.currentTime + when);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  _limit(key, ms) {
    const now = performance.now();
    if ((this.limits[key] || 0) > now) return false;
    this.limits[key] = now + ms;
    return true;
  }

  _blip(freq, dur, gain, { type = 'sine', glide = 1, wet = 0.4, pan = 0, when = 0, attack = 0.004 } = {}) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * glide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      out = p;
    }
    o.connect(g);
    out.connect(this.dry);
    if (wet) {
      const w = ctx.createGain();
      w.gain.value = wet;
      out.connect(w).connect(this.reverb);
    }
    o.start(t);
    o.stop(t + dur + 0.05);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }

  _noiseHit(freq, q, dur, gain, { type = 'bandpass', wet = 0.2, pan = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g);
    let out = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      out = p;
    }
    out.connect(this.dry);
    if (wet) {
      const w = ctx.createGain();
      w.gain.value = wet;
      out.connect(w).connect(this.reverb);
    }
    src.start(t, Math.random() * 3);
    src.stop(t + dur + 0.05);
    src.onended = () => src.disconnect();
  }

  // ------------------------------------------------------------ events

  carve(intensity, tool) {
    if (!this._limit('carve', 55)) return;
    const i = Math.max(0.15, intensity);
    this._noiseHit(320 + Math.random() * 600, 1.2, 0.09 + Math.random() * 0.06, 0.12 * i, { wet: 0.1, pan: (Math.random() - 0.5) * 0.4 });
    if (Math.random() < 0.3) this._noiseHit(1600 + Math.random() * 1500, 3, 0.04, 0.05 * i, { wet: 0.05 });
  }

  seed() {
    if (!this._limit('seed', 70)) return;
    this._noiseHit(4200 + Math.random() * 2500, 6, 0.03, 0.035, { wet: 0.05, pan: (Math.random() - 0.5) * 0.6 });
  }

  sprout(type) {
    if (!this._limit('sprout', 110)) return;
    const b = this.highPlucks[Math.floor(Math.random() * this.highPlucks.length)];
    this._play(b, { gain: 0.07, wet: 0.5, pan: (Math.random() - 0.5) * 0.8 });
  }

  /** Minnaert resonance of the bubble a falling body traps: f = 3.26 / radius. */
  splash(r, speed) {
    if (!this._limit('splash', 40)) return;
    const bubble = Math.max(0.0012, r * 0.016 * (0.7 + Math.random() * 0.6));
    const f = Math.min(2600, Math.max(260, 3.26 / bubble));
    this._blip(f, 0.09 + r * 0.25, Math.min(0.2, 0.05 + speed * 0.015), { glide: 1.5, wet: 0.35, pan: (Math.random() - 0.5) * 0.6 });
    this._noiseHit(2500, 0.8, 0.12, Math.min(0.08, speed * 0.008), { wet: 0.2 });
  }

  thud(r, speed, kind) {
    if (!this._limit('thud', 50)) return;
    const g = Math.min(0.22, speed * r * 0.12);
    this._blip(90 + Math.random() * 60, 0.16, g, { glide: 0.6, wet: 0.15 });
    this._noiseHit(450, 0.7, 0.08, g * 0.6, { type: 'lowpass', wet: 0.1 });
  }

  house() {
    this._noiseHit(900, 4, 0.06, 0.08, { wet: 0.3 });
    this._noiseHit(700, 4, 0.06, 0.07, { wet: 0.3 });
    this._play(this.bells[1], { gain: 0.08, wet: 0.8, when: 0.15, pan: (Math.random() - 0.5) * 0.6 });
  }

  harvest() {
    if (!this._limit('harvest', 400)) return;
    this._noiseHit(3000, 0.6, 0.25, 0.04, { wet: 0.2 });
    this._play(this.plucks[5 + Math.floor(Math.random() * 4)], { gain: 0.08, wet: 0.5 });
  }

  goal() {
    [0, 2, 4, 7].forEach((s, k) => this._play(this.plucks[Math.min(10, s + 2)], { gain: 0.16, wet: 0.6, when: k * 0.16, pan: -0.3 + k * 0.2 }));
    this._play(this.bells[0], { gain: 0.14, wet: 0.9, when: 0.7 });
  }

  celebrate() {
    this._play(this.gong, { gain: 0.25, wet: 1 });
    [0, 2, 4, 5, 7, 9, 10].forEach((s, k) => this._play(this.plucks[s], { gain: 0.14, wet: 0.6, when: 1.2 + k * 0.22, pan: Math.sin(k) * 0.5 }));
    this._flute([7, 9, 7, 4, 2, 4], 3.2);
  }

  /** A paddle slapping the water and the axle's wooden knock. */
  knock(intensity) {
    if (!this._limit('knock', 90)) return;
    this._noiseHit(650 + Math.random() * 200, 5, 0.05, 0.05 * intensity, { wet: 0.35, pan: (Math.random() - 0.5) * 0.6 });
    this._noiseHit(2200, 1.5, 0.06, 0.03 * intensity, { wet: 0.2 });
  }

  click() {
    this._noiseHit(2200, 5, 0.03, 0.06, { wet: 0.05 });
  }

  shutter() {
    this._noiseHit(3000, 2, 0.05, 0.1, { wet: 0 });
    this._noiseHit(1500, 2, 0.07, 0.08, { wet: 0 });
  }

  /** A breathy end-blown flute: sine + vibrato + band-passed breath noise. */
  _flute(steps, when = 0) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    let t = ctx.currentTime + when;
    for (const s of steps) {
      const f = noteFreq(s, 2);
      const dur = 0.55 + Math.random() * 0.4;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.2;
      const vg = ctx.createGain();
      vg.gain.value = f * 0.008;
      vib.connect(vg).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.12);
      g.gain.setValueAtTime(0.06, t + dur - 0.15);
      g.gain.linearRampToValueAtTime(0, t + dur);
      const br = ctx.createBufferSource();
      br.buffer = this.noise;
      const bf = ctx.createBiquadFilter();
      bf.type = 'bandpass';
      bf.frequency.value = f * 2;
      bf.Q.value = 3;
      const bg = ctx.createGain();
      bg.gain.value = 0.25;
      br.connect(bf).connect(bg).connect(g);
      o.connect(g);
      g.connect(this.dry);
      const w = ctx.createGain();
      w.gain.value = 0.8;
      g.connect(w).connect(this.reverb);
      o.start(t);
      vib.start(t);
      br.start(t, Math.random() * 2);
      o.stop(t + dur + 0.05);
      vib.stop(t + dur + 0.05);
      br.stop(t + dur + 0.05);
      o.onended = () => {
        o.disconnect();
        g.disconnect();
        br.disconnect();
        vib.disconnect();
      };
      t += dur * 0.92;
    }
  }

  _bird() {
    // a short phrase of FM-ish chirps
    const n = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1800;
    const pan = (Math.random() - 0.5) * 1.4;
    for (let i = 0; i < n; i++) {
      const f = base * (0.9 + Math.random() * 0.3);
      this._blip(f, 0.06 + Math.random() * 0.07, 0.025, { glide: Math.random() < 0.5 ? 1.35 : 0.75, wet: 0.5, pan, when: i * (0.09 + Math.random() * 0.06), attack: 0.01 });
    }
  }

  _cricket() {
    const pan = (Math.random() - 0.5) * 1.6;
    for (let i = 0; i < 3; i++) this._blip(4300 + Math.random() * 200, 0.035, 0.012, { wet: 0.3, pan, when: i * 0.06 });
  }

  // ------------------------------------------------------------ ambience

  update(dt, s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const flowAmt = Math.min(1, Math.sqrt(s.flow) * 0.045 + s.falls * 0.0025);
    this.water.g.gain.setTargetAtTime(this.muted ? 0 : 0.05 + flowAmt * 0.3, t, 0.4);
    this.water2.g.gain.setTargetAtTime(this.muted ? 0 : flowAmt * 0.12, t, 0.4);
    this.wind.g.gain.setTargetAtTime(this.muted ? 0 : 0.03 + s.wind * 0.05, t, 0.8);
    this.wind.f.frequency.setTargetAtTime(260 + s.wind * 220, t, 0.8);
    this.rain.g.gain.setTargetAtTime(this.muted ? 0 : s.rain * 0.16, t, 0.8);
    if (this.muted) return;

    // droplets: little "plinks" where water spills over ledges
    this.dropT -= dt;
    const dropRate = Math.min(12, s.falls * 0.12) + s.rain * 8;
    if (this.dropT <= 0 && dropRate > 0.05) {
      this.dropT = (0.4 + Math.random()) / dropRate;
      this._blip(900 + Math.random() * 1700, 0.05 + Math.random() * 0.05, 0.02 + Math.random() * 0.02, { glide: 1.6, wet: 0.45, pan: (Math.random() - 0.5) * 1.2 });
    }

    const day = s.night < 0.5;
    const dawn = Math.exp(-(((s.hour - 6.5) / 1.6) ** 2));
    this.birdT -= dt * (day ? 0.6 + dawn * 1.6 : 0.05) * (1 - s.rain * 0.8);
    if (this.birdT <= 0) {
      this.birdT = 2 + Math.random() * 7;
      this._bird();
    }
    if (s.night > 0.4) {
      this.cricketT -= dt;
      if (this.cricketT <= 0) {
        this.cricketT = 0.4 + Math.random() * 1.2;
        this._cricket();
      }
    }
    // distant bells (buffalo bells, a far-off chime) once people live here
    this.bellT -= dt;
    if (this.bellT <= 0) {
      this.bellT = 18 + Math.random() * 30;
      if (s.houses > 0) {
        if (Math.random() < 0.6) {
          for (let i = 0; i < 3; i++) this._play(this.tinkle, { gain: 0.03, rate: 0.95 + Math.random() * 0.1, wet: 0.7, when: i * (0.25 + Math.random() * 0.2), pan: (Math.random() - 0.5) * 1.2 });
        } else {
          this._play(this.bells[2], { gain: 0.06, wet: 1, pan: (Math.random() - 0.5) * 0.8 });
        }
      }
    }
    // generative pentatonic music: sparse plucked phrases
    this.musicT -= dt;
    if (this.musicT <= 0) {
      this.musicT = 4 + Math.random() * 7;
      const phrase = 1 + Math.floor(Math.random() * 4);
      let step = Math.floor(Math.random() * 6) + 2;
      for (let i = 0; i < phrase; i++) {
        step = Math.max(0, Math.min(10, step + Math.floor(Math.random() * 5) - 2));
        this._play(this.plucks[step], { gain: s.night > 0.5 ? 0.05 : 0.08, wet: 0.65, when: i * (0.32 + Math.random() * 0.25), pan: (Math.random() - 0.5) * 0.7 });
      }
      if (Math.random() < 0.12) this._flute([4, 2, 0], 2 + phrase * 0.4);
    }
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.3);
  }

  suspend() {
    this.ctx?.suspend();
  }

  resume() {
    this.ctx?.resume();
  }
}

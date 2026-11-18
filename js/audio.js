// 音避け：音（Web Audio API）
const AC = window.AudioContext || window.webkitAudioContext;

export const Audio = {
  ctx: null,
  master: null,
  musicGain: null,
  sfxGain: null,
  analyser: null,
  spectrum: null,
  music: null,
  hitBus: null,
  buffers: {},

  init() {
    if (this.ctx) return;
    // iPhone のマナーモードでも鳴らす（Safari 16.4+）
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    this.spectrum = new Uint8Array(this.analyser.frequencyBinCount);
    this.musicGain.connect(this.analyser);
    this.analyser.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.8;
    this.sfxGain.connect(this.master);
  },

  // 画面に触れたときに呼ぶ（iOS の制限を解く）
  unlock() {
    this.init();
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.master);
    s.start(0);
  },

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  },

  // 出力の遅れ（画面と音を合わせる）
  get latency() {
    if (!this.ctx) return 0;
    const l = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.min(0.25, Math.max(0, l));
  },

  async load(url) {
    if (this.buffers[url]) return this.buffers[url];
    this.init();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} を読めませんでした（${res.status}）`);
    const data = await res.arrayBuffer();
    const buf = await new Promise((ok, ng) => {
      const p = this.ctx.decodeAudioData(data, ok, ng);
      if (p && p.then) p.then(ok, ng);
    });
    this.buffers[url] = buf;
    return buf;
  },

  playMusic(buf, when) {
    this.stopMusic(0);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 1;
    s.connect(g);
    g.connect(this.musicGain);
    s.start(when);
    this.music = { src: s, gain: g };
    this.hitBus = this.ctx.createGain();
    this.hitBus.connect(this.sfxGain);
  },

  stopMusic(fade = 0.3) {
    if (this.hitBus) {
      const hb = this.hitBus;
      try { hb.disconnect(); } catch {}
      this.hitBus = null;
    }
    if (!this.music) return;
    const { src, gain } = this.music;
    this.music = null;
    const t = this.ctx.currentTime;
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fade));
      src.stop(t + Math.max(0.02, fade) + 0.05);
    } catch {}
  },

  sfx(name, vol = 1, when = 0, bus = null) {
    const buf = this.buffers[`sfx/${name}.mp3`];
    if (!buf || !this.ctx) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    s.connect(g);
    g.connect(bus || this.sfxGain);
    s.start(Math.max(when, this.ctx.currentTime));
  },

  readSpectrum() {
    if (!this.analyser || !this.music) return null;
    this.analyser.getByteFrequencyData(this.spectrum);
    return this.spectrum;
  },
};

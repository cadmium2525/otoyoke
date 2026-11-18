// 音避け：手持ちの曲（MP3 など）を解析する。テンポ・拍の位置・音の立ち上がり（オンセット）・明るさ・盛り上がり。
import { spawnSync } from 'node:child_process';

export const SR = 22050;
const N = 1024; // 窓
export const HOP = 256; // 約 11.6ms

export function decode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('ffmpeg で読めませんでした: ' + r.stderr);
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** フレームごとの特徴：帯域別のスペクトルフラックス、音量、明るさ（重心） */
export function features(x) {
  const frames = Math.floor((x.length - N) / HOP);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const hz = (k) => (k * SR) / N;
  const bandOf = (k) => (hz(k) < 150 ? 0 : hz(k) < 2000 ? 1 : 2);
  const flux = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
  const rms = new Float32Array(frames), cent = new Float32Array(frames), low = new Float32Array(frames);
  let prev = new Float32Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    const cur = new Float32Array(N / 2);
    let cs = 0, ws = 0, le = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const lm = Math.log1p(m * 20);
      cur[k] = lm;
      const d = lm - prev[k];
      if (d > 0) flux[bandOf(k)][f] += d;
      cs += hz(k) * m; ws += m;
      if (hz(k) < 150) le += m * m;
    }
    cent[f] = ws > 0 ? cs / ws : 0;
    low[f] = Math.sqrt(le);
    prev = cur;
  }
  const total = new Float32Array(frames);
  for (let f = 0; f < frames; f++) total[f] = flux[0][f] * 1.5 + flux[1][f] + flux[2][f] * 0.7;
  return { frames, flux, total, rms, cent, low, fps: SR / HOP };
}

// 局所平均を引いて正の部分だけ残す（オンセットらしさ）
export function novelty(env, radius = 16) {
  const out = new Float32Array(env.length);
  let s = 0;
  const q = [];
  for (let i = 0; i < env.length + radius; i++) {
    if (i < env.length) { s += env[i]; q.push(env[i]); }
    if (q.length > 2 * radius + 1) s -= q.shift();
    const c = i - radius;
    if (c >= 0) out[c] = Math.max(0, env[c] - s / q.length);
  }
  return out;
}

/** テンポと拍の位置（一定テンポを仮定） */
export function beatTrack(nov, fps, { min = 70, max = 210 } = {}) {
  const n = nov.length;
  // 自己相関でテンポの候補
  const cand = [];
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    const l0 = Math.floor(lag), fr = lag - l0;
    let s = 0;
    for (let i = 0; i + l0 + 1 < n; i++) s += nov[i] * (nov[i + l0] * (1 - fr) + nov[i + l0 + 1] * fr);
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2)); // 125 前後を少しだけ好む
    cand.push({ bpm, s: s * w, raw: s });
  }
  cand.sort((a, b) => b.s - a.s);
  // 細かく合わせる：くし形の和（位相も同時に）
  const comb = (bpm) => {
    const per = (60 / bpm) * fps;
    let best = { s: -1, ph: 0 };
    for (let ph = 0; ph < per; ph += 0.5) {
      let s = 0;
      for (let t = ph; t < n - 1; t += per) { const i = Math.floor(t), f = t - i; s += nov[i] * (1 - f) + nov[i + 1] * f; }
      if (s > best.s) best = { s, ph };
    }
    return best;
  };
  let best = null;
  for (const c of cand.slice(0, 3)) {
    for (let d = -0.6; d <= 0.6; d += 0.02) {
      const bpm = c.bpm + d;
      const r = comb(bpm);
      if (!best || r.s > best.s) best = { bpm, ...r };
    }
  }
  return { bpm: best.bpm, offset: best.ph / fps, candidates: cand.slice(0, 6) };
}

/** 山を拾う */
export function peaks(nov, fps, minGapSec = 0.07) {
  const out = [];
  const g = Math.round(minGapSec * fps);
  let mean = 0;
  for (const v of nov) mean += v;
  mean /= nov.length;
  for (let i = 1; i < nov.length - 1; i++) {
    if (nov[i] <= mean * 1.2 || nov[i] < nov[i - 1] || nov[i] < nov[i + 1]) continue;
    let ok = true;
    for (let k = Math.max(0, i - g); k <= Math.min(nov.length - 1, i + g); k++) if (nov[k] > nov[i]) { ok = false; break; }
    if (ok) out.push({ t: i / fps, v: nov[i] / mean });
  }
  return out;
}

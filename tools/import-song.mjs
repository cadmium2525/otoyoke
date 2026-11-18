#!/usr/bin/env node
/*
 * 音避け：手持ちの曲（MP3 など）を解析して、ゲームに入れる。
 *
 *   node tools/import-song.mjs 曲.mp3 --id myso --title "My Song" [--diff MASTER] [--level 13] [--color "#ffffff"]
 *
 * テンポが途中で変わる曲にも対応（拍の位置を曲全体でたどる）。
 * 出力：songs/<id>.mp3（128kbps に変換・タグ削除）、songs/<id>.json（譜面）、songs/index.json に追加。ffmpeg が必要。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, features, novelty, HOP, SR } from './audio-analyze.mjs';
import { placeNotes, writeIndex, DIFF } from './chartgen.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const def = {
  id: flag('--id', 'custom'),
  title: flag('--title', 'Custom'),
  diff: flag('--diff', 'MASTER'),
  level: Number(flag('--level', 13)),
  color: flag('--color', '#ffffff'),
};
const [input] = args;
if (!input || !DIFF[def.diff]) {
  console.error(`使い方: node tools/import-song.mjs 曲.mp3 --id ID --title 曲名 [--diff ${Object.keys(DIFF).join('|')}] [--level 13]`);
  process.exit(1);
}

// 1) 128kbps の MP3 に（メタデータは消す）
mkdirSync(join(ROOT, 'songs'), { recursive: true });
const out = join(ROOT, `songs/${def.id}.mp3`);
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', out], { stdio: 'inherit' });
if (r.status !== 0) process.exit(1);

// 2) 解析（ゲームで鳴らすのと同じファイルを解析する）
const x = decode(out);
const F = features(x);
const fps = F.fps;
const dur = x.length / SR;
const z = (a) => {
  const s = Array.from(a).filter((v) => v > 0).sort((p, q) => p - q);
  const p95 = s[Math.floor(s.length * 0.95)] || 1;
  return a.map((v) => v / p95);
};
const nov = z(novelty(F.total));
const nb = F.flux.map((b) => z(novelty(b)));

// 2a) 細かい脈（8 分音符）の周期：自己相関の一番の山（0.2〜0.5 秒）
function acfPeak(env, lo, hi) {
  let best = 0, bl = lo;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    if (s > best) { best = s; bl = lag; }
  }
  return bl;
}
const lag8 = acfPeak(nov, Math.round(0.2 * fps), Math.round(0.5 * fps));
const gBpm8 = (60 * fps) / lag8;

// 2b) 区間ごとのテンポ（ゆっくり変わる曲に対応）
const comb = (per, a, b) => {
  let best = { s: -1, ph: 0 };
  for (let ph = 0; ph < per; ph += 0.25) {
    let s = 0, c = 0;
    for (let t = a + ph; t < b - 1; t += per) { const i = Math.floor(t), f = t - i; s += nov[i] * (1 - f) + nov[i + 1] * f; c++; }
    s /= c;
    if (s > best.s) best = { s, ph };
  }
  return best;
};
const W = Math.round(12 * fps), STEP = Math.round(6 * fps);
const local = [];
for (let s = 0; s + W <= nov.length; s += STEP) {
  let best = null;
  for (let b = gBpm8 * 0.93; b <= gBpm8 * 1.07; b += 0.1) {
    const r2 = comb((60 / b) * fps, s, s + W);
    if (!best || r2.s > best.s) best = { b, s: r2.s };
  }
  local.push({ c: s + W / 2, per: (60 / best.b) * fps });
}
// なめらかに（前後の区間と平均）
const sm = local.map((p, i) => ({ c: p.c, per: (local[Math.max(0, i - 1)].per + p.per * 2 + local[Math.min(local.length - 1, i + 1)].per) / 4 }));
const perAt = (f) => {
  if (f <= sm[0].c) return sm[0].per;
  for (let i = 1; i < sm.length; i++) if (f <= sm[i].c) { const k = (f - sm[i - 1].c) / (sm[i].c - sm[i - 1].c); return sm[i - 1].per * (1 - k) + sm[i].per * k; }
  return sm[sm.length - 1].per;
};

// 2c) 動的計画法で拍（8 分）をたどる（Ellis 2007 の方式）
const n = nov.length;
const C = new Float64Array(n), back = new Int32Array(n).fill(-1);
const ALPHA = 300;
for (let t = 0; t < n; t++) {
  const tau = perAt(t);
  let best = 0, bi = -1;
  for (let p = Math.max(0, Math.round(t - 1.5 * tau)); p <= t - Math.round(0.66 * tau); p++) {
    const v = C[p] - ALPHA * Math.pow(Math.log((t - p) / tau), 2);
    if (bi < 0 || v > best) { best = v; bi = p; }
  }
  C[t] = nov[t] + (bi >= 0 ? Math.max(0, best) : 0);
  back[t] = bi >= 0 && best > 0 ? bi : -1;
}
let end = n - 1;
const lastTau = perAt(n - 1);
for (let t = Math.max(0, Math.round(n - 1 - lastTau)); t < n; t++) if (C[t] > C[end]) end = t;
const pulses = [];
for (let t = end; t >= 0; t = back[t]) { pulses.push(t); if (back[t] < 0) break; }
pulses.reverse();
// 最初の拍より前も周期で埋める（イントロ）
while (pulses[0] - perAt(pulses[0]) > 0) pulses.unshift(Math.round(pulses[0] - perAt(pulses[0])));

// 2d) 4 分音符はどちらの 8 分か：低音（キック）が多い方。小節の頭：4 通りのうち低音とクラッシュが強い方
const at = (arr, f) => { let m = 0; for (let k = -2; k <= 2; k++) m = Math.max(m, arr[Math.min(arr.length - 1, Math.max(0, f + k))] || 0); return m; };
const parityScore = [0, 1].map((p) => pulses.filter((_, i) => i % 2 === p).reduce((s, f) => s + at(nb[0], f), 0));
const par = parityScore[1] > parityScore[0] ? 1 : 0;
const quarters = pulses.filter((_, i) => i % 2 === par);
const barScore = [0, 1, 2, 3].map((p) => quarters.filter((_, i) => i % 4 === p).reduce((s, f) => s + at(nb[0], f) + at(nb[2], f) * 0.5, 0));
const bar0 = barScore.indexOf(Math.max(...barScore));
// 拍 0 = 最初の小節の頭。その前の拍は捨てる
const qFrames = quarters.slice(bar0);
const beatTimes = qFrames.map((f) => (f * HOP) / SR);
const timeOf = (b) => {
  const i = Math.floor(b), k = b - i;
  if (i < 0) return beatTimes[0] + b * (beatTimes[1] - beatTimes[0]);
  if (i >= beatTimes.length - 1) { const L = beatTimes.length - 1; return beatTimes[L] + (b - L) * (beatTimes[L] - beatTimes[L - 1]); }
  return beatTimes[i] * (1 - k) + beatTimes[i + 1] * k;
};
const nBeats = beatTimes.length;
const bpms = beatTimes.slice(1).map((t, i) => 60 / (t - beatTimes[i]));
const avgBpm = (60 * (nBeats - 1)) / (beatTimes[nBeats - 1] - beatTimes[0]);

// 3) 16 分ごとの候補
const slots = [];
const strengths = [];
for (let b = 0; b < nBeats - 1; b += 0.25) {
  const f = Math.round((timeOf(b) * SR) / HOP);
  const lo = at(nb[0], f), mi = at(nb[1], f), hi = at(nb[2], f);
  const s = 2.2 * lo + 1.6 * mi + 0.8 * hi;
  const c = F.cent[Math.min(F.cent.length - 1, f)] || 500;
  slots.push({ b, s, lo, mi, hi, pitch: 12 * Math.log2(Math.max(50, c) / 100), mel: null, kick: lo > 0.55, crash: hi > 1.0 && b % 4 === 0 });
  strengths.push(s);
}
// 強さをそろえる：上位 1/4 の境目が 2.6 になるように
const sorted = strengths.slice().sort((a, b) => a - b);
const q75 = sorted[Math.floor(sorted.length * 0.75)] || 1;
for (const s of slots) s.s = (s.s / q75) * 2.6;
// 伸ばす音：強い音のあと 1.5 拍以上、強い音が来ない
for (let i = 0; i < slots.length; i++) {
  const s = slots[i];
  if (s.s < 3 || s.mi < 0.6) continue;
  let j = i + 1;
  while (j < slots.length && slots[j].s < 2.2) j++;
  const d = (j - i) * 0.25;
  if (d >= 1.5) s.mel = { d: Math.min(d, 4) };
}

// 4) 場面：小節ごとの音量で、盛り上がり（B）・静か（bridge）・それ以外（A）
const bars = Math.floor(nBeats / 4);
const barE = [];
for (let k = 0; k < bars; k++) {
  const f0 = Math.round((timeOf(k * 4) * SR) / HOP), f1 = Math.round((timeOf(k * 4 + 4) * SR) / HOP);
  let e = 0;
  for (let f = f0; f < f1; f++) e += F.rms[f] * F.rms[f] + 0.5 * F.low[f] * F.low[f] * 1e-4;
  barE.push(Math.sqrt(e / Math.max(1, f1 - f0)));
}
if (process.env.DEBUG) console.log(barE.map((e) => e.toFixed(3)).join(" "));
const smE = barE.map((_, k) => { let s = 0, c = 0; for (let j = k - 1; j <= k + 1; j++) if (j >= 0 && j < bars) { s += barE[j]; c++; } return s / c; });
// 曲全体でだんだん大きくなる曲もあるので、傾き（一次式）を引いた残りで判断する
const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
const xs = smE.map((_, k) => k), mx = mean(xs), my = mean(smE);
let sxy = 0, sxx = 0;
for (let k = 0; k < bars; k++) { sxy += (k - mx) * (smE[k] - my); sxx += (k - mx) ** 2; }
const slope = sxy / sxx;
const resid = smE.map((e, k) => e - (my + slope * (k - mx)));
const med = barE.slice().sort((a, b) => a - b)[Math.floor(bars / 2)];
const labels = [];
for (let k = 0; k < bars; k++) labels.push(barE[k] < med * 0.45 ? 'bridge' : 'A');
// 8 小節ずつのまとまりで、傾きより大きいところはサビ
for (let k0 = 0; k0 < bars; k0 += 8) {
  const blk = resid.slice(k0, k0 + 8);
  if (mean(blk) > 0.012) for (let k = k0; k < Math.min(bars, k0 + 8); k++) if (labels[k] === 'A') labels[k] = 'B';
}
// 静かなところの前後 1 小節もブリッジに
for (let k = 0; k < bars; k++) if (barE[k] < med * 0.45) { if (k > 0 && labels[k - 1] !== 'bridge') labels[k - 1] = 'bridge'; }
let introEnd = 0;
while (introEnd < bars && barE[introEnd] < med * 0.5) introEnd++;
for (let k = 0; k < Math.max(2, introEnd + 1); k++) labels[k] = 'intro';
const NAMES = { intro: 'イントロ', A: 'A', B: 'サビ', bridge: 'ブリッジ', outro: 'アウトロ' };
const sections = [];
for (let k = 0; k < bars; k++) {
  if (!sections.length || sections[sections.length - 1].name !== labels[k]) sections.push({ at: k * 4, len: 0, name: labels[k], label: NAMES[labels[k]] });
  sections[sections.length - 1].len += 4;
}
// 最後の音が消えるあたりは「エンディング」
const lastLoud = (() => { for (let k = bars - 1; k >= 0; k--) if (barE[k] > med * 0.35) return k; return bars - 1; })();
const endBeat = Math.min(bars, lastLoud + 1) * 4;
for (const s of sections) if (s.at + s.len > endBeat) s.len = Math.max(0, endBeat - s.at);
const secs = sections.filter((s) => s.len > 0);
secs.push({ at: endBeat, len: 4, name: 'ending', label: 'エンディング' });

// 5) 譜面
// 難しさごとの目安の密度（個/秒）になるよう、しきい値を合わせる
const TARGET = { EASY: 1.2, NORMAL: 1.8, HARD: 2.4, EXPERT: 2.8, MASTER: Number(process.env.DENSITY || 3.3) }[def.diff];
const opts = { slots, sections: secs, bpb: 4, timeOf, seed: 20251118 + def.id.length, def, bpm: +avgBpm.toFixed(2), bias: { intro: 0.8, bridge: 0.6, A: 0.2, B: -0.2 } };
let lo = -3, hi = 4, chart = null;
for (let it = 0; it < 14; it++) {
  const mid = (lo + hi) / 2;
  const c = placeNotes({ ...opts, shift: mid });
  if (c.notes.length / c.length > TARGET) lo = mid; else hi = mid;
  if (!chart || Math.abs(c.notes.length / c.length - TARGET) < Math.abs(chart.notes.length / chart.length - TARGET)) chart = c;
}
chart.length = Math.min(chart.length, +(dur - 0.3).toFixed(3));
chart.beatTimes = beatTimes.map((t) => +t.toFixed(4));
chart.duration = +dur.toFixed(3);
writeFileSync(join(ROOT, `songs/${def.id}.json`), JSON.stringify(chart));
writeIndex(ROOT, [{ id: def.id, title: def.title, diff: def.diff, level: def.level, color: def.color, bpm: Math.round(avgBpm), length: Math.round(chart.length), notes: chart.notes.length }]);

const cnt = { tap: 0, long: 0, sweep: 0, gate: 0, double: 0 };
for (const nt of chart.notes) { cnt[nt.type]++; if (nt.type === 'tap' && nt.lanes.length === 2) cnt.double++; }
console.log(`長さ ${dur.toFixed(1)} 秒／ 8 分の周期 ${(lag8 / fps).toFixed(3)} 秒`);
console.log(`テンポ：平均 ${avgBpm.toFixed(2)} BPM（${Math.min(...bpms.slice(4, -4)).toFixed(1)}〜${Math.max(...bpms.slice(4, -4)).toFixed(1)}）、最初の小節の頭 ${beatTimes[0].toFixed(3)} 秒、${bars} 小節`);
console.log('場面：' + secs.map((s) => `${s.label}@${timeOf(s.at).toFixed(1)}s`).join(' → '));
console.log(`譜面 ${def.diff}: ${chart.notes.length} ノーツ（タップ ${cnt.tap}・2列 ${cnt.double}・ロング ${cnt.long}・スライド ${cnt.sweep}・くぐる ${cnt.gate}）、平均 ${(chart.notes.length / chart.length).toFixed(2)} 個/秒`);

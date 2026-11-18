#!/usr/bin/env node
/*
 * 音避け：BGM と譜面を作るスクリプト。
 *
 * BGM は「かなでる」（https://github.com/cadmium2525/mp4mp3 の daw/）のエンジンで作曲・書き出しする。
 * 譜面は、その曲の音符（メロディ・ドラム・ベース）から自動で作るので、音と完全に同期する。
 *
 *   git clone https://github.com/cadmium2525/mp4mp3 ../mp4mp3
 *   node tools/build-songs.mjs ../mp4mp3            # 全曲
 *   node tools/build-songs.mjs ../mp4mp3 normal     # 1 曲だけ
 *   node tools/build-songs.mjs ../mp4mp3 --chart-only   # 曲はそのまま、譜面だけ作り直す
 *
 * 出力：songs/<id>.mp3（BGM）、songs/<id>.json（譜面）、songs/src/<id>.song.json（曲の JSON）、songs/index.json（曲の一覧）
 * ffmpeg が必要（MP3 への変換）。
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const chartOnly = args.includes('--chart-only');
const pos = args.filter((a) => !a.startsWith('--'));
const daw = resolve(pos[0] || '../mp4mp3', 'daw');
if (!existsSync(join(daw, 'js/engine/arranger.js'))) {
  console.error(`かなでるが見つかりません: ${daw}\n使い方: node tools/build-songs.mjs <mp4mp3 のフォルダ> [曲ID]`);
  process.exit(1);
}
const only = pos[1];
const imp = (p) => import(pathToFileURL(join(daw, p)).href);
const { compose, bake } = await imp('js/engine/arranger.js');
const { trackNotes, noteToMidi, beatsPerBar } = await imp('js/engine/song.js');
const { renderSong } = await imp('js/engine/mix.js');
const { encodeWav } = await imp('js/engine/wav.js');
const { renderAnySfx } = await imp('js/engine/sfx.js');

// ─── 曲の一覧 ────────────────────────────────────────────
// diff: 譜面の難しさ。style / bpm / seconds / seed は「かなでる」のおまかせ作曲の設定。
export const SONGS = [
  { id: 'easy', title: 'Neon Step', diff: 'EASY', level: 3, color: '#29e6ff', style: 'pop', bpm: 112, seconds: 80, seed: 2 },
  { id: 'normal', title: 'Laser Parade', diff: 'NORMAL', level: 6, color: '#ff3fd0', style: 'edm', bpm: 126, seconds: 92, seed: 3 },
  { id: 'hard', title: 'Pixel Overdrive', diff: 'HARD', level: 9, color: '#ffb52e', style: '8bit', bpm: 152, seconds: 90, seed: 5 },
];

// 難しさごとの譜面の作り方
const DIFF = {
  EASY: { grid: 1, threshold: 2.9, minGap: 0.5, moveTime: 0.24, doubles: 99, gateEvery: 32, longMin: 2, lead: 2.0, gateClear: 0.7, intro: 0.3 },
  NORMAL: { grid: 0.5, threshold: 2.3, minGap: 0.3, moveTime: 0.17, doubles: 5.5, gateEvery: 12, longMin: 1.5, lead: 1.7, gateClear: 0.45, intro: 0.5 },
  HARD: { grid: 0.25, threshold: 2.2, minGap: 0.2, moveTime: 0.13, doubles: 4.5, gateEvery: 8, longMin: 1.5, lead: 1.45, gateClear: 0.35, intro: 0.7 },
};
// 場面ごとの「しきい値」の足し引き（大きいほど音符が少ない）
const SECTION_BIAS = { intro: 1.6, A: 0.4, B: -0.3, bridge: 1.0, outro: 0.8, ending: 99 };

// 効果音（かなでるの効果音プリセット）
const SFX = {
  hit: { preset: 'tap', pitch: 7, length: 0.6, tone: 0.6, space: 0.1 },
  damage: { preset: 'damage', space: 0.2 },
  slide: { preset: 'swish', length: 0.9, tone: 0.2 },
  move: { preset: 'swipe', length: 0.5, tone: 0.4 },
  go: { preset: 'kettei', pitch: 5 },
  clear: { preset: 'levelup', space: 0.3 },
  fail: { preset: 'gameover', space: 0.3 },
  select: { preset: 'cursor' },
};

function toMp3(L, R, sr, out, kbps) {
  const tmp = out + '.tmp.wav';
  writeFileSync(tmp, encodeWav(L, R, sr, 16));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, out], { stdio: 'inherit' });
  unlinkSync(tmp);
  if (r.status !== 0) throw new Error('ffmpeg での変換に失敗しました');
}

// 再現できる乱数
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function midiOf(n) {
  try {
    const m = noteToMidi(n);
    return Number.isFinite(m) ? m : null;
  } catch {
    return null;
  }
}

/** 曲の音符から譜面を作る */
function makeChart(song, def) {
  const P = DIFF[def.diff];
  const spb = 60 / song.bpm;
  const bpb = beatsPerBar(song);
  const sections = song.sections || [{ at: 0, len: song.bars * bpb, name: 'A' }];
  const sectionAt = (b) => sections.find((s) => b >= s.at - 1e-6 && b < s.at + s.len - 1e-6) || sections[sections.length - 1];
  const rand = rng(song.seed * 7919 + def.id.length);

  // 拍ごとの「強さ」と音の高さを集める
  const slots = new Map(); // key: 16分単位の位置
  const slot = (b) => {
    const k = Math.round(b * 4);
    if (!slots.has(k)) slots.set(k, { b: k / 4, s: 0, pitch: null, mel: null, crash: false, kick: false });
    return slots.get(k);
  };
  for (const tr of song.tracks) {
    if (tr.type === 'sfx' || tr.mute) continue;
    const id = String(tr.id || '');
    const drums = !!tr.kit || tr.type === 'drums';
    const notes = trackNotes(song, tr);
    let last = -1;
    for (const n of notes) {
      const s = slot(n.t);
      if (drums) {
        const p = String(n.n);
        if (p === 'kick' || p === 'kick808') { s.s += 2 * n.v + 0.4; s.kick = true; }
        else if (p === 'snare' || p === 'clap') s.s += 1.8 * n.v + 0.3;
        else if (p === 'crash') { s.s += 1; s.crash = true; }
        else if (p.startsWith('tom')) s.s += 0.8;
        continue;
      }
      if (Math.abs(n.t - last) < 1e-6) continue; // 和音は 1 回だけ数える
      last = n.t;
      const m = midiOf(n.n);
      if (id === 'mel') {
        s.s += 3;
        s.mel = { m, d: n.d };
        if (m != null) s.pitch = m;
      } else if (id === 'bass') {
        s.s += 0.8;
        if (s.pitch == null && m != null) s.pitch = m + 24;
      } else if (id === 'arp') {
        s.s += 0.3;
        if (s.pitch == null && m != null) s.pitch = m;
      } else {
        s.s += 0.6;
      }
    }
  }
  const all = [...slots.values()].sort((a, b) => a.b - b.b);

  // 候補を選ぶ：グリッド・しきい値・拍頭のボーナス
  const cands = [];
  for (const s of all) {
    const sec = sectionAt(s.b);
    if (sec.name === 'ending') continue;
    if (s.b * spb < 2.2) continue; // 最初の少しは何も来ない
    const onGrid = Math.abs(s.b / P.grid - Math.round(s.b / P.grid)) < 1e-6;
    if (!onGrid && !(s.mel && P.grid <= 0.5)) continue;
    let score = s.s;
    const inBar = s.b % bpb;
    if (Math.abs(inBar) < 1e-6) score += 1;
    else if (Math.abs(inBar - Math.round(inBar)) < 1e-6) score += 0.4;
    if (score < P.threshold + (SECTION_BIAS[sec.name] ?? 0)) continue;
    cands.push({ ...s, score, sec });
  }

  // 「くぐるバー」（スライドでよける）を置く拍：場面の頭（クラッシュ）と、サビで gateEvery 拍ごと
  const gateBeats = new Set();
  for (const sec of sections) {
    if (sec.name === 'ending' || sec.at * spb < 3) continue;
    gateBeats.add(sec.at);
    if (sec.name === 'B' || (P.gateEvery <= 8 && sec.name === 'A'))
      for (let b = sec.at + P.gateEvery; b < sec.at + sec.len - 1; b += P.gateEvery) gateBeats.add(b);
  }

  // 置いていく。プレイヤーが必ずよけられるかを、たどり着ける列の集合で確かめる。
  const LANES = 4;
  let F = new Set([0, 1, 2, 3]);
  let tPrev = 0;
  const longs = []; // { lane, t0, t1 }
  const notes = [];
  let lastGate = -99;
  let prevLane = 1;
  let prevPitch = null;

  const reach = (from, steps, walls) => {
    let cur = new Set([...from].filter((l) => !walls.has(l)));
    for (let i = 0; i < steps; i++) {
      const nx = new Set(cur);
      for (const l of cur) for (const d of [-1, 1]) { const k = l + d; if (k >= 0 && k < LANES && !walls.has(k)) nx.add(k); }
      if (nx.size === cur.size) break;
      cur = nx;
    }
    return cur;
  };
  const tryPlace = (t, lanes, isLong, dur) => {
    const g = t - tPrev;
    const steps = Math.floor(g / P.moveTime);
    const walls = new Set(longs.filter((L) => L.t0 < t + 0.05 && L.t1 > tPrev - 0.05).map((L) => L.lane));
    const R = reach(F, steps, walls);
    const blocked = new Set(lanes);
    for (const L of longs) if (L.t0 <= t && L.t1 >= t - 0.05) blocked.add(L.lane);
    const F2 = new Set([...R].filter((l) => !blocked.has(l)));
    if (!F2.size) return false;
    // 長いノーツは、その間ずっと別の列にいられること（列をまたげない）
    if (isLong && [...F2].every((l) => l === lanes[0])) return false;
    F = F2;
    tPrev = t;
    if (isLong) longs.push({ lane: lanes[0], t0: t, t1: t + dur });
    return true;
  };

  for (const c of cands) {
    const t = c.b * spb;
    const prev = notes[notes.length - 1];
    const gap = prev ? t - prev.t : 99;
    const minGap = prev && prev.type === 'gate' ? Math.max(P.minGap, P.gateClear) : P.minGap;
    if (gap < minGap - 1e-6) continue;

    // くぐるバー
    const nearGate = [...gateBeats].some((gb) => Math.abs(gb - c.b) < 1e-6);
    if (nearGate && t - lastGate > 1.2 && (c.crash || c.kick || c.score > P.threshold + 1)) {
      const activeLong = longs.some((L) => L.t1 > t - P.gateClear);
      if (!activeLong) {
        notes.push({ t, type: 'gate', lanes: [0, 1, 2, 3] });
        lastGate = t;
        continue;
      }
    }
    if (t - lastGate < P.gateClear) continue;

    // 列を決める：メロディの高さで左右に（上がれば右、下がれば左）
    let want;
    if (c.pitch != null && prevPitch != null) {
      const dlt = c.pitch - prevPitch;
      if (dlt > 0) want = prevLane + (dlt > 4 ? 2 : 1);
      else if (dlt < 0) want = prevLane - (dlt < -4 ? 2 : 1);
      else want = prevLane;
      if (want > 3) want = 3 - (want - 3) - 1;
      if (want < 0) want = -want;
      want = Math.max(0, Math.min(3, want));
    } else {
      want = Math.floor(rand() * 4);
    }
    const isLong = !!(c.mel && c.mel.d >= P.longMin && c.sec.name !== 'intro');
    const dur = isLong ? Math.min(c.mel.d * spb * 0.85, 2.4) : 0;
    const double = !isLong && c.score >= P.doubles;

    // 候補の列を、望ましい順に試す
    const order = [want, want + 1, want - 1, want + 2, want - 2, want + 3, want - 3].filter((l) => l >= 0 && l < 4);
    let placed = false;
    for (const l of order) {
      let lanes = [l];
      if (double) {
        const other = l <= 1 ? l + 1 + (rand() < 0.5 ? 1 : 0) : l - 1 - (rand() < 0.5 ? 1 : 0);
        lanes = [l, Math.max(0, Math.min(3, other))].filter((v, i, a) => a.indexOf(v) === i).sort();
      }
      if (tryPlace(t, lanes, isLong, dur)) {
        const n = { t, type: isLong ? 'long' : 'tap', lanes };
        if (isLong) n.d = dur;
        notes.push(n);
        prevLane = l;
        if (c.pitch != null) prevPitch = c.pitch;
        placed = true;
        break;
      }
    }
    if (!placed && double) {
      // 2 列が無理なら 1 列で
      for (const l of order) if (tryPlace(t, [l], false, 0)) { notes.push({ t, type: 'tap', lanes: [l] }); prevLane = l; break; }
    }
  }
  // 長いノーツの最中に「くぐるバー」が重なっていたら、長いノーツを短くする
  for (const n of notes) {
    if (n.type !== 'long') continue;
    const g = notes.find((x) => x.type === 'gate' && x.t > n.t && x.t < n.t + n.d + 0.3);
    if (g) n.d = Math.max(0.2, g.t - n.t - 0.4);
  }
  for (const n of notes) { n.t = +n.t.toFixed(4); if (n.d) n.d = +n.d.toFixed(4); }

  const beats = sections.reduce((m, s) => Math.max(m, s.at + s.len), 0);
  return {
    id: def.id,
    title: def.title,
    diff: def.diff,
    level: def.level,
    color: def.color,
    bpm: song.bpm,
    beatsPerBar: bpb,
    lead: P.lead,
    length: +(beats * spb).toFixed(3),
    sections: sections.map((s) => ({ t: +(s.at * spb).toFixed(3), name: s.name, label: s.label })),
    notes,
  };
}

mkdirSync(join(ROOT, 'songs/src'), { recursive: true });
mkdirSync(join(ROOT, 'sfx'), { recursive: true });

const list = [];
for (const def of SONGS) {
  const srcPath = join(ROOT, `songs/src/${def.id}.song.json`);
  let song;
  if (only && only !== def.id) {
    if (existsSync(join(ROOT, `songs/${def.id}.json`))) {
      const c = JSON.parse(readFileSync(join(ROOT, `songs/${def.id}.json`), 'utf8'));
      list.push(summary(def, c));
    }
    continue;
  }
  if (chartOnly && existsSync(srcPath)) {
    song = JSON.parse(readFileSync(srcPath, 'utf8'));
  } else {
    song = bake(compose({ style: def.style, bpm: def.bpm, seconds: def.seconds, seed: def.seed }));
    song.name = def.title;
    writeFileSync(srcPath, JSON.stringify(song));
    process.stdout.write(`♪ ${def.title}（${def.style} / ${song.bpm} BPM）を書き出し中…`);
    const { L, R, sr } = renderSong(song, {});
    toMp3(L, R, sr, join(ROOT, `songs/${def.id}.mp3`), 128);
    console.log(` ${(L.length / sr).toFixed(1)} 秒`);
  }
  const chart = makeChart(song, def);
  chart.duration = +(song.bars * beatsPerBar(song) * 60 / song.bpm + (song.tail ?? 3)).toFixed(3);
  writeFileSync(join(ROOT, `songs/${def.id}.json`), JSON.stringify(chart));
  const c = { tap: 0, long: 0, gate: 0, double: 0 };
  for (const n of chart.notes) { c[n.type]++; if (n.lanes.length === 2) c.double++; }
  console.log(`  譜面 ${def.diff}: ${chart.notes.length} ノーツ（タップ ${c.tap}・2列 ${c.double}・ロング ${c.long}・くぐる ${c.gate}）`);
  list.push(summary(def, chart));
}
writeFileSync(join(ROOT, 'songs/index.json'), JSON.stringify(list, null, 1));

function summary(def, chart) {
  return { id: def.id, title: def.title, diff: def.diff, level: def.level, color: def.color, bpm: Math.round(chart.bpm), length: Math.round(chart.length), notes: chart.notes.length };
}

if (!chartOnly && !only) {
  for (const [name, d] of Object.entries(SFX)) {
    const [L, R] = renderAnySfx(d, 48000);
    toMp3(L, R, 48000, join(ROOT, `sfx/${name}.mp3`), 96);
  }
  console.log(`効果音 ${Object.keys(SFX).length} 個を書き出し`);
}

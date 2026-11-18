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
import { placeNotes, writeIndex } from './chartgen.mjs';

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
  { id: 'sugar', title: 'Sugar Rush', diff: 'EASY', level: 2, color: '#7dffb0', style: 'kawaii', bpm: 124, seconds: 78, seed: 4 },
  { id: 'sakura', title: 'Sakura Drift', diff: 'NORMAL', level: 5, color: '#ff8fb8', style: 'wafu', bpm: 96, seconds: 88, seed: 7 },
  { id: 'funk', title: 'Midnight Groove', diff: 'NORMAL', level: 7, color: '#b066ff', style: 'funk', bpm: 112, seconds: 90, seed: 2 },
  { id: 'rock', title: 'Thunder Riff', diff: 'HARD', level: 8, color: '#ff6b3b', style: 'rock', bpm: 140, seconds: 92, seed: 4 },
  { id: 'trap', title: 'Dark Pulse', diff: 'EXPERT', level: 11, color: '#ff3b6b', style: 'trap', bpm: 142, seconds: 92, seed: 6 },
];

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
  const spb = 60 / song.bpm;
  const bpb = beatsPerBar(song);
  const sections = song.sections || [{ at: 0, len: song.bars * bpb, name: 'A' }];

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
  return placeNotes({ slots: [...slots.values()], sections, bpb, timeOf: (b) => b * spb, seed: song.seed * 7919 + def.id.length, def, bpm: song.bpm });
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
  const c = { tap: 0, long: 0, sweep: 0, gate: 0, double: 0 };
  for (const n of chart.notes) { c[n.type]++; if (n.type === 'tap' && n.lanes.length === 2) c.double++; }
  console.log(`  譜面 ${def.diff}: ${chart.notes.length} ノーツ（タップ ${c.tap}・2列 ${c.double}・ロング ${c.long}・スライド ${c.sweep}・くぐる ${c.gate}）`);
  list.push(summary(def, chart));
}
writeIndex(ROOT, list);

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

// 音避け：譜面を作る共通部分（かなでるの曲・手持ちの曲の両方で使う）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 難しさごとの譜面の作り方
export const DIFF = {
  // sweepBars: 何小節ごとにスライドノーツ（斜めに流れる）を置くか、sweepBeats: その長さ（拍）、sweepSpan: 何列ぶん動くか
  EASY: { grid: 1, threshold: 2.9, minGap: 0.5, moveTime: 0.24, doubles: 99, gateEvery: 32, longMin: 2, lead: 2.0, gateClear: 0.7, intro: 0.3, sweepBars: 4, sweepBeats: 2, sweepSpan: [1, 1] },
  NORMAL: { grid: 0.5, threshold: 2.3, minGap: 0.3, moveTime: 0.17, doubles: 5.5, gateEvery: 12, longMin: 1.5, lead: 1.7, gateClear: 0.45, intro: 0.5, sweepBars: 4, sweepBeats: 2, sweepSpan: [1, 2] },
  HARD: { grid: 0.25, threshold: 2.2, minGap: 0.2, moveTime: 0.13, doubles: 4.5, gateEvery: 8, longMin: 1.5, lead: 1.45, gateClear: 0.35, intro: 0.7, sweepBars: 2, sweepBeats: 1.5, sweepSpan: [1, 2] },
  EXPERT: { grid: 0.25, threshold: 1.9, minGap: 0.17, moveTime: 0.11, doubles: 4, gateEvery: 8, longMin: 1.5, lead: 1.3, gateClear: 0.32, intro: 0.8, sweepBars: 2, sweepBeats: 1, sweepSpan: [2, 2] },
  MASTER: { grid: 0.25, threshold: 2.2, minGap: 0.16, moveTime: 0.1, doubles: 3.6, gateEvery: 8, longMin: 1.5, lead: 1.2, gateClear: 0.3, intro: 0.9, sweepBars: 2, sweepBeats: 1, sweepSpan: [1, 2] },
};
// 場面ごとの「しきい値」の足し引き（大きいほど音符が少ない）
export const SECTION_BIAS = { intro: 1.6, A: 0.4, B: -0.3, bridge: 1.0, outro: 0.8, ending: 99 };

// 再現できる乱数
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}


/**
 * 拍ごとの候補（slots）から譜面を作る。
 * slots: [{ b: 拍, s: 強さ, pitch, mel: { d: 伸ばす拍 } | null, crash, kick }]
 * sections: [{ at: 拍, len: 拍, name, label }]、timeOf(拍) → 秒（テンポが変わる曲にも対応）
 */
export function placeNotes({ slots, sections, bpb, timeOf, seed, def, bpm, shift = 0, bias = null }) {
  const P = { ...DIFF[def.diff] };
  P.threshold += shift;
  const BIAS = { ...SECTION_BIAS, ...(bias || {}) };
  const sectionAt = (b) => sections.find((s) => b >= s.at - 1e-6 && b < s.at + s.len - 1e-6) || sections[sections.length - 1];
  const rand = rng(seed);
  const all = slots.slice().sort((a, b) => a.b - b.b);

  // 候補を選ぶ：グリッド・しきい値・拍頭のボーナス
  const cands = [];
  for (const s of all) {
    const sec = sectionAt(s.b);
    if (sec.name === 'ending') continue;
    if (timeOf(s.b) < 2.2) continue; // 最初の少しは何も来ない
    const onGrid = Math.abs(s.b / P.grid - Math.round(s.b / P.grid)) < 1e-6;
    if (!onGrid && !(s.mel && P.grid <= 0.5)) continue;
    let score = s.s;
    const inBar = s.b % bpb;
    if (Math.abs(inBar) < 1e-6) score += 1;
    else if (Math.abs(inBar - Math.round(inBar)) < 1e-6) score += 0.4;
    if (score < P.threshold + (BIAS[sec.name] ?? 0)) continue;
    cands.push({ ...s, score, sec });
  }

  // 「くぐるバー」（スライドでよける）を置く拍：場面の頭（クラッシュ）と、サビで gateEvery 拍ごと
  const gateBeats = new Set();
  for (const sec of sections) {
    if (sec.name === 'ending' || timeOf(sec.at) < 3) continue;
    gateBeats.add(sec.at);
    if (sec.name === 'B' || (P.gateEvery <= 8 && sec.name === 'A'))
      for (let b = sec.at + P.gateEvery; b < sec.at + sec.len - 1; b += P.gateEvery) gateBeats.add(b);
  }

  // 置いていく。プレイヤーが必ずよけられるかを、たどり着ける列の集合で確かめる。
  const LANES = 4;
  let F = new Set([0, 1, 2, 3]);
  let tPrev = 0;
  const longs = []; // ロング・スライドノーツ { lanes, t0, t1 }
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
    const walls = new Set(longs.filter((L) => L.t0 < t + 0.05 && L.t1 > tPrev - 0.05).flatMap((L) => L.lanes));
    const R = reach(F, steps, walls);
    const blocked = new Set(lanes);
    for (const L of longs) if (L.t0 <= t && L.t1 >= t - 0.05) for (const l of L.lanes) blocked.add(l);
    const F2 = new Set([...R].filter((l) => !blocked.has(l)));
    if (!F2.size) return false;
    F = F2;
    tPrev = t;
    if (isLong) longs.push({ lanes, t0: t, t1: t + dur });
    return true;
  };

  for (const c of cands) {
    const t = timeOf(c.b);
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
    let isLong = !!(c.mel && c.mel.d >= P.longMin && c.sec.name !== 'intro');
    let dur = isLong ? Math.min((timeOf(c.b + c.mel.d) - t) * 0.85, 2.4) : 0;
    // スライドノーツ：フレーズの終わりの小節の頭、または伸ばすメロディの半分
    const inBar = c.b % bpb, bar = Math.floor(c.b / bpb + 1e-6);
    const phraseEnd = Math.abs(inBar) < 1e-6 && (bar - Math.round(c.sec.at / bpb)) % P.sweepBars === P.sweepBars - 1 && (c.sec.name === 'A' || c.sec.name === 'B' || c.sec.name === 'outro');
    const isSweep = c.sec.name !== 'intro' && (phraseEnd || (isLong && rand() < 0.5));
    if (isSweep && !isLong) dur = Math.max(0.75, timeOf(c.b + P.sweepBeats) - t);
    if (isSweep) isLong = true;
    if (isSweep && [...gateBeats].some((gb) => gb > c.b && timeOf(gb) < t + dur + P.gateClear)) continue;
    const double = !isLong && c.score >= P.doubles;

    // 候補の列を、望ましい順に試す
    const order = [want, want + 1, want - 1, want + 2, want - 2, want + 3, want - 3].filter((l) => l >= 0 && l < 4);
    let placed = false;
    for (let l of order) {
      let lanes = [l];
      let sweep = null;
      if (isSweep) {
        const span = P.sweepSpan[0] + Math.floor(rand() * (P.sweepSpan[1] - P.sweepSpan[0] + 1));
        let dir = c.pitch != null && prevPitch != null ? Math.sign(c.pitch - prevPitch) || (rand() < 0.5 ? -1 : 1) : rand() < 0.5 ? -1 : 1;
        if (l + dir * span < 0 || l + dir * span > 3) dir = -dir;
        const to = Math.max(0, Math.min(3, l + dir * span));
        if (to === l) continue;
        sweep = { from: l, to };
        lanes = [];
        for (let k = Math.min(l, to); k <= Math.max(l, to); k++) lanes.push(k);
      } else if (double) {
        const other = l <= 1 ? l + 1 + (rand() < 0.5 ? 1 : 0) : l - 1 - (rand() < 0.5 ? 1 : 0);
        lanes = [l, Math.max(0, Math.min(3, other))].filter((v, i, a) => a.indexOf(v) === i).sort();
      }
      if (tryPlace(t, lanes, isLong, dur)) {
        const n = { t, type: sweep ? 'sweep' : isLong ? 'long' : 'tap', lanes };
        if (isLong) n.d = dur;
        if (sweep) Object.assign(n, sweep);
        if (sweep) l = sweep.to;
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
    if (n.type !== 'long' && n.type !== 'sweep') continue;
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
    bpm,
    beatsPerBar: bpb,
    lead: P.lead,
    length: +timeOf(beats).toFixed(3),
    sections: sections.map((s) => ({ t: +timeOf(s.at).toFixed(3), name: s.name, label: s.label })),
    notes,
  };
}

/** 曲の一覧（songs/index.json）を書く。ここに無い曲（手持ちの曲など）はそのまま残す */
export function writeIndex(root, list) {
  const path = join(root, 'songs/index.json');
  const old = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const ids = new Set(list.map((s) => s.id));
  const all = list.concat(old.filter((s) => !ids.has(s.id)));
  all.sort((a, b) => a.level - b.level);
  writeFileSync(path, JSON.stringify(all, null, 1));
}

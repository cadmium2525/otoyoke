#!/usr/bin/env node
// 譜面が「よけきれる」かを確かめる（列ごとの到達可能性を時間順にたどる）
//   node tools/check-charts.mjs [1 列動くのにかかる秒数 = 0.12]
import { readFileSync } from 'node:fs';
const per = Number(process.argv[2] || 0.12);
const list = JSON.parse(readFileSync(new URL('../songs/index.json', import.meta.url)));
let bad = 0;
for (const s of list) {
  const c = JSON.parse(readFileSync(new URL(`../songs/${s.id}.json`, import.meta.url)));
  let F = new Set([0, 1, 2, 3]);
  let tp = 0;
  const longs = c.notes.filter((n) => n.type === 'long' || n.type === 'sweep');
  let minGap = 9, worst = null;
  for (const n of c.notes) {
    if (n.type === 'gate') continue;
    const g = n.t - tp;
    if (g < minGap) { minGap = g; worst = n.t; }
    const walls = new Set(longs.filter((L) => L.t < n.t && L.t + L.d > tp).flatMap((L) => L.lanes));
    let cur = new Set([...F].filter((l) => !walls.has(l)));
    for (let i = 0; i < Math.floor(g / per); i++) {
      const nx = new Set(cur);
      for (const l of cur) for (const d of [-1, 1]) { const k = l + d; if (k >= 0 && k < 4 && !walls.has(k)) nx.add(k); }
      cur = nx;
    }
    const blocked = new Set(n.lanes);
    for (const L of longs) if (L !== n && L.t <= n.t && L.t + L.d >= n.t) for (const l of L.lanes) blocked.add(l);
    const F2 = new Set([...cur].filter((l) => !blocked.has(l)));
    if (!F2.size) { console.log(`  ✗ ${s.id} ${n.t.toFixed(2)}s でよけられない`, [...F], n.lanes); bad++; F2.add(...cur); }
    F = F2.size ? F2 : new Set([0, 1, 2, 3]);
    tp = n.t;
  }
  const cnt = (t) => c.notes.filter((n) => n.type === t).length;
  console.log(`${s.id} [${c.diff}]: ${c.notes.length} ノーツ, 最短間隔 ${minGap.toFixed(3)}s, ロング ${cnt('long')}, スライド ${cnt('sweep')}, くぐる ${cnt('gate')}`);
}
process.exit(bad ? 1 : 0);

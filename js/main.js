// 音避け：ゲームの進行・操作
import { Renderer, LANE_COLORS, GATE_COLOR, laneX, holdX, timeToBeat } from './render.js';
import { Audio } from './audio.js';

const $ = (s) => document.querySelector(s);
const cv = $('#game');
const R = new Renderer(cv);

const SFX_NAMES = ['hit', 'damage', 'slide', 'move', 'go', 'clear', 'fail', 'select'];
const COUNT_IN = 3; // 曲が始まるまでの秒数
const MAX_HP = 5;
const SLIDE_TIME = 0.62;
const MOVE_SPEED = 13; // 列/秒
const HIT_RANGE = 0.42;

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('otoyoke.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('otoyoke.' + k, JSON.stringify(v)); } catch {}
  },
};
const settings = { hitsound: store.get('hitsound', true), vibe: store.get('vibe', true) };

// 状態
const S = {
  time: 0,
  dt: 0,
  screen: 'title',
  playing: false,
  paused: false,
  beat: 0,
  songTime: 0,
  chart: null,
  lead: 1.7,
  visible: [],
  player: null,
  spectrum: null,
  energy: 0.5,
};
let songs = [];
let current = null; // 選んだ曲
let run = null; // 1 回のプレイ

// ─── 画面の切り替え ──────────────────────────────────────
function show(id) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== id;
  S.screen = id;
  document.body.dataset.screen = id;
}

function newPlayer() {
  return { lane: 1, x: laneX(1), vx: 0, face: 1, slide: 0, slideAmt: 0, invuln: 0, hurt: 0, hp: MAX_HP, dead: false, deadAmt: 0 };
}
S.player = newPlayer();
S.player.lane = 1;
S.player.x = 0;

// ─── 曲の一覧 ───────────────────────────────────────────
async function loadSongs() {
  const res = await fetch('songs/index.json');
  songs = await res.json();
  const box = $('#songs');
  box.innerHTML = '';
  for (const s of songs) {
    const best = store.get('best.' + s.id, null);
    const b = document.createElement('button');
    b.className = 'song';
    b.style.setProperty('--c', s.color);
    b.innerHTML = `
      <span class="diff">${s.diff}<small>Lv.${s.level}</small></span>
      <span class="info"><b>${s.title}</b><small>${s.bpm} BPM ・ ${Math.floor(s.length / 60)}:${String(s.length % 60).padStart(2, '0')} ・ ${s.notes} ノーツ</small></span>
      <span class="best">${best ? `<i class="rank r${best.rank}">${best.rank}</i>` : '<i class="rank none">−</i>'}</span>`;
    b.addEventListener('click', () => start(s));
    box.appendChild(b);
  }
}

function renderSettings() {
  $('#opt-hit').textContent = `ヒット音：${settings.hitsound ? 'ON' : 'OFF'}`;
  $('#opt-vibe').textContent = `振動：${settings.vibe ? 'ON' : 'OFF'}`;
}

// ─── プレイ開始 ─────────────────────────────────────────
async function start(song) {
  Audio.unlock();
  current = song;
  show('loading');
  $('#loading-title').textContent = song.title;
  try {
    const [chart, buf] = await Promise.all([
      fetch(`songs/${song.id}.json`).then((r) => r.json()),
      Audio.load(`songs/${song.id}.mp3`),
      ...SFX_NAMES.map((n) => Audio.load(`sfx/${n}.mp3`).catch(() => null)),
    ]);
    current.chart = chart;
    current.buffer = buf;
  } catch (e) {
    console.error(e);
    alert('読み込みに失敗しました。通信状態を確認してください。\n' + e.message);
    show('title');
    return;
  }
  begin();
}

function begin() {
  const chart = current.chart;
  Audio.unlock();
  const notes = chart.notes.map((n) => ({ ...n, judged: false, done: false, hitPlayer: false, sound: false }));
  let total = 0;
  for (const n of notes) total += isHold(n) ? 2 : 1;
  const t0 = Audio.now + COUNT_IN + 0.1;
  run = {
    t0,
    notes,
    first: 0,
    total,
    judged: 0,
    combo: 0,
    hits: 0,
    prevT: -COUNT_IN - 1,
    soundIdx: 0,
    secIdx: 0,
    ended: false,
    endAt: 0,
  };
  S.chart = chart;
  S.lead = chart.lead;
  S.player = newPlayer();
  S.playing = true;
  S.paused = false;
  R.particles = [];
  R.popups = [];
  Audio.playMusic(current.buffer, t0);
  for (let i = COUNT_IN; i >= 1; i--) Audio.sfx('select', 0.9, t0 - i);
  Audio.sfx('go', 0.8, t0);
  updateHud(true);
  show('play');
}

function retry() {
  Audio.stopMusic(0.05);
  if (Audio.ctx.state !== 'running') Audio.ctx.resume();
  begin();
}

function quit() {
  Audio.stopMusic(0.2);
  if (Audio.ctx && Audio.ctx.state !== 'running') Audio.ctx.resume();
  S.playing = false;
  S.paused = false;
  S.chart = null;
  run = null;
  S.player = newPlayer();
  loadSongs();
  show('title');
}

function pause() {
  if (!S.playing || S.paused || run?.ended) return;
  S.paused = true;
  Audio.ctx.suspend();
  show('pause');
}

function resume() {
  if (!S.paused) return;
  S.paused = false;
  Audio.ctx.resume();
  show('play');
}

// ─── 操作 ──────────────────────────────────────────────
function canControl() {
  return S.playing && !S.paused && S.player && !S.player.dead && S.screen === 'play';
}

function move(d) {
  if (!canControl()) return;
  const p = S.player;
  const nl = Math.max(0, Math.min(3, p.lane + d));
  if (nl === p.lane) return;
  p.lane = nl;
  p.face = d;
  Audio.sfx('move', 0.35);
}

function slide() {
  if (!canControl()) return;
  const p = S.player;
  p.slide = SLIDE_TIME;
  Audio.sfx('slide', 0.6);
}

for (const [id, fn] of [['#btn-left', () => move(-1)], ['#btn-right', () => move(1)], ['#btn-slide', slide]]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.classList.add('on');
    fn();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => el.classList.remove('on'));
}

// スワイプ（画面のどこでも）
const swipe = { id: null, x: 0, y: 0, used: false, t: 0 };
$('#touch').addEventListener('pointerdown', (e) => {
  swipe.id = e.pointerId;
  swipe.x = e.clientX;
  swipe.y = e.clientY;
  swipe.used = false;
  swipe.t = performance.now();
});
$('#touch').addEventListener('pointermove', (e) => {
  if (e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  const th = 26;
  if (Math.abs(dx) > th && Math.abs(dx) > Math.abs(dy)) {
    move(Math.sign(dx));
    swipe.x = e.clientX;
    swipe.y = e.clientY;
    swipe.used = true;
  } else if (dy > th && dy > Math.abs(dx)) {
    slide();
    swipe.x = e.clientX;
    swipe.y = e.clientY + 9999; // 1 回のスワイプで 1 回だけ
    swipe.used = true;
  }
});
$('#touch').addEventListener('pointerup', (e) => {
  if (e.pointerId !== swipe.id) return;
  swipe.id = null;
  // 短いタップ：画面の左右半分で移動
  if (!swipe.used && performance.now() - swipe.t < 300) {
    const r = cv.getBoundingClientRect();
    move(e.clientX < r.left + r.width / 2 ? -1 : 1);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') move(-1);
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') move(1);
  else if (k === 'ArrowDown' || k === 's' || k === 'S' || k === ' ') { slide(); e.preventDefault(); }
  else if (k === 'Escape' || k === 'p' || k === 'P') (S.paused ? resume : pause)();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

// ─── 1 フレームごと ───────────────────────────────────────
function overlap(lane) {
  return Math.abs(S.player.x - laneX(lane)) < HIT_RANGE;
}
// ロングノーツとスライドノーツ（斜めに流れる）は、しばらく判定ラインに残る
const isHold = (n) => n.type === 'long' || n.type === 'sweep';

function damage(n) {
  const p = S.player;
  if (p.invuln > 0 || p.dead) return;
  n.hitPlayer = true;
  p.hp--;
  run.hits++;
  p.invuln = 1.2;
  p.hurt = 0.45;
  R.shake = 1;
  R.flash = 1;
  R.popup(p.lane, 'OUCH!', '#ff3b6b', 1.1);
  Audio.sfx('damage', 1);
  if (settings.vibe && navigator.vibrate) navigator.vibrate(90);
  updateHud();
  if (p.hp <= 0) {
    p.dead = true;
    p.invuln = 0;
    run.ended = true;
    run.endAt = S.time + 1.8;
    run.result = 'fail';
    Audio.stopMusic(1.2);
    Audio.sfx('fail', 0.9);
  }
}

function judge(n, end = false) {
  run.judged++;
  run.combo++;
  if (n.type === 'gate') {
    R.gateBurst();
    R.popup(null, 'PERFECT', GATE_COLOR, 1.2);
  } else {
    const lanes = n.type === 'sweep' ? [end ? n.to : n.from] : n.lanes;
    for (const l of lanes) R.burst(l, LANE_COLORS[l], !end);
    R.popup(lanes[0], 'PERFECT', LANE_COLORS[lanes[0]]);
  }
  updateHud();
}

function step() {
  const c = S.chart;
  const t = Audio.now - run.t0 - Audio.latency;
  S.songTime = t;
  S.beat = timeToBeat(c, t);
  const p = S.player;
  const prev = run.prevT;
  run.prevT = t;

  // ヒット音（少し先まで予約）
  if (settings.hitsound && Audio.hitBus) {
    const ahead = Audio.now - run.t0 + 0.3;
    while (run.soundIdx < run.notes.length && run.notes[run.soundIdx].t < ahead) {
      const n = run.notes[run.soundIdx++];
      if (p.dead) continue;
      const when = run.t0 + n.t;
      if (when > Audio.now - 0.02) Audio.sfx('hit', n.type === 'gate' ? 0.55 : 0.4, when, Audio.hitBus);
      if (isHold(n)) Audio.sfx('hit', 0.3, run.t0 + n.t + n.d, Audio.hitBus);
    }
  }

  // 場面（サビで盛り上がる）
  while (run.secIdx < c.sections.length && c.sections[run.secIdx].t <= t) {
    const sec = c.sections[run.secIdx++];
    S.energy = sec.name === 'B' ? 1 : sec.name === 'A' ? 0.6 : 0.4;
    if (sec.name === 'B' && t > 1) R.popups.push({ x: R.W / 2, y: R.H * 0.42, text: 'FEVER!!', color: '#ffb52e', life: 1.2, max: 1.2, size: R.W * 0.12 });
  }

  // ノーツ
  while (run.first < run.notes.length && run.notes[run.first].t < t - 3) run.first++;
  const vis = [];
  for (let i = run.first; i < run.notes.length; i++) {
    const n = run.notes[i];
    if (n.t > t + S.lead + 0.1) break;
    if (!n.judged && n.t <= t) {
      n.judged = true;
      if (!isHold(n)) n.done = true;
      if (!p.dead) {
        judge(n);
        if (n.type === 'tap' && n.lanes.some(overlap)) damage(n);
        if (n.type === 'gate' && !(p.slide > 0 || p.slideAmt > 0.6)) damage(n);
      }
    }
    if (isHold(n) && n.judged && !n.done) {
      if (t >= n.t + n.d) {
        n.done = true;
        if (!p.dead) judge(n, true);
      } else if (!p.dead) {
        const hx = holdX(n, t);
        if (!n.hitPlayer && Math.abs(p.x - hx) < HIT_RANGE) damage(n);
        const ln = Math.max(0, Math.min(3, Math.round(hx + 1.5)));
        R.laneFlash[ln] = Math.max(R.laneFlash[ln], 0.7);
        if (Math.random() < 0.5) {
          const [x, y] = R.proj(hx, 0.05, 0);
          R.particles.push({ x: x + (Math.random() - 0.5) * 30, y, vx: (Math.random() - 0.5) * 120, vy: -150 - Math.random() * 200, life: 0.4, max: 0.4, c: LANE_COLORS[ln], r: 2.5 });
        }
      }
    }
    if (!(n.done && !isHold(n))) vis.push(n);
  }
  S.visible = vis;

  // 終わり
  if (!run.ended && t > c.length + 0.4 && run.notes.every((n) => n.done)) {
    run.ended = true;
    run.result = 'clear';
    run.endAt = S.time + 1.2;
    Audio.stopMusic(2.5);
    Audio.sfx('clear', 0.9);
    R.popups.push({ x: R.W / 2, y: R.H * 0.42, text: 'CLEAR!!', color: '#29e6ff', life: 1.6, max: 1.6, size: R.W * 0.14 });
  }
  if (run.ended && S.time > run.endAt && S.screen === 'play') showResult();

  // カウントダウン
  const cd = $('#countdown');
  if (t < 0) {
    const k = Math.ceil(-t);
    cd.hidden = false;
    cd.textContent = k <= COUNT_IN ? String(k) : '';
  } else if (t < 0.6) {
    cd.hidden = false;
    cd.textContent = 'GO!';
  } else cd.hidden = true;

  // 「くぐれ！」の合図
  const warn = run.notes.some((n) => n.type === 'gate' && !n.judged && n.t - t < 0.7 && n.t - t > 0);
  $('#warn').hidden = !warn || p.dead;

  // 進み具合
  $('#progress i').style.width = `${Math.max(0, Math.min(1, t / c.length)) * 100}%`;
}

// テスト用の自動回避（URL に ?bot を付けると動く）：譜面から通り道を先に決めて、その通りに動く
const BOT = new URLSearchParams(location.search).has('bot');
if (BOT || new URLSearchParams(location.search).has('debug')) window.__S = S;
let botPlan = null;
function planRoute(notes) {
  const per = 0.1;
  const longs = notes.filter(isHold);
  const ev = notes.filter((n) => n.type !== 'gate');
  const Fs = [];
  let F = [0, 1, 2, 3], tp = 0;
  for (const n of ev) {
    const walls = longs.filter((L) => L.t < n.t && L.t + L.d > tp).flatMap((L) => L.lanes);
    const steps = Math.floor((n.t - tp) / per);
    const blocked = new Set(n.lanes);
    for (const L of longs) if (L !== n && L.t <= n.t && L.t + L.d >= n.t) for (const l of L.lanes) blocked.add(l);
    const ok = [];
    for (let l = 0; l < 4; l++) {
      if (blocked.has(l) || walls.includes(l)) continue;
      if (F.some((f) => Math.abs(f - l) <= steps && !walls.some((w) => w > Math.min(f, l) && w < Math.max(f, l)))) ok.push(l);
    }
    Fs.push(ok.length ? ok : [0, 1, 2, 3].filter((l) => !blocked.has(l)));
    F = Fs[Fs.length - 1];
    tp = n.t;
  }
  const lanes = new Array(ev.length);
  let next = null;
  for (let i = ev.length - 1; i >= 0; i--) {
    const c = Fs[i].slice().sort((a, b) => (next == null ? 0 : Math.abs(a - next) - Math.abs(b - next)));
    lanes[i] = next = c[0];
  }
  return ev.map((n, i) => ({ t: n.t, lane: lanes[i] }));
}
let botNext = 0;
function bot() {
  const p = S.player;
  const t = S.songTime;
  if (p.dead) return;
  if (!botPlan || botPlan.run !== run) botPlan = { run, route: planRoute(run.notes), i: 0 };
  if (run.notes.some((n) => n.type === 'gate' && !n.judged && n.t - t < 0.25) && p.slide <= 0) slide();
  const R2 = botPlan.route;
  while (botPlan.i < R2.length && R2[botPlan.i].t < t - 0.03) botPlan.i++;
  if (botPlan.i >= R2.length || S.time < botNext) return;
  const want = R2[botPlan.i].lane;
  if (want !== p.lane) { move(Math.sign(want - p.lane)); botNext = S.time + 0.07; }
}

function updatePlayer(dt) {
  const p = S.player;
  const tx = laneX(p.lane);
  const dx = tx - p.x;
  const stepX = Math.sign(dx) * Math.min(Math.abs(dx), MOVE_SPEED * dt);
  p.vx = dt > 0 ? stepX / dt : 0;
  p.x += stepX;
  p.slide = Math.max(0, p.slide - dt);
  const target = p.slide > 0 ? 1 : 0;
  p.slideAmt += Math.sign(target - p.slideAmt) * Math.min(Math.abs(target - p.slideAmt), dt * 12);
  p.invuln = Math.max(0, p.invuln - dt);
  p.hurt = Math.max(0, p.hurt - dt);
  if (p.dead) p.deadAmt = Math.min(1, p.deadAmt + dt * 4);
}

// ─── HUD ──────────────────────────────────────────────
function updateHud(reset = false) {
  if (!run) return;
  const score = run.judged >= run.total ? 1000000 : Math.floor((1000000 * run.judged) / run.total);
  $('#score').textContent = String(score).padStart(7, '0');
  const cb = $('#combo');
  cb.textContent = run.combo;
  if (!reset) {
    cb.classList.remove('bump');
    void cb.offsetWidth;
    cb.classList.add('bump');
  }
  const hp = S.player ? S.player.hp : MAX_HP;
  $('#hp').innerHTML = Array.from({ length: MAX_HP }, (_, i) => `<i class="${i < hp ? 'on' : ''}"></i>`).join('');
}

function rankOf(hits, cleared) {
  if (!cleared) return 'F';
  if (hits === 0) return 'S';
  if (hits === 1) return 'A';
  if (hits === 2) return 'B';
  return 'C';
}

function showResult() {
  const cleared = run.result === 'clear';
  const rank = rankOf(run.hits, cleared);
  const passed = run.notes.filter((n) => n.judged).length;
  const dodge = passed ? Math.round(((passed - run.hits) / passed) * 1000) / 10 : 0;
  $('#res-title').textContent = cleared ? (run.hits === 0 ? 'NO DAMAGE!' : 'STAGE CLEAR') : 'FAILED…';
  $('#res-title').className = cleared ? 'clear' : 'fail';
  $('#res-song').textContent = `${current.title}［${current.diff}］`;
  $('#res-rank').textContent = rank;
  $('#res-rank').className = `rank big r${rank}`;
  $('#res-auto').innerHTML = cleared
    ? `<b>FULL COMBO</b> ${run.combo} / ${run.total}　SCORE 1000000`
    : `COMBO ${run.combo} / ${run.total}`;
  $('#res-hits').textContent = `${run.hits} 回`;
  $('#res-dodge').textContent = `${dodge}%`;
  $('#res-hp').textContent = `${Math.max(0, S.player.hp)} / ${MAX_HP}`;
  const key = 'best.' + current.id;
  const best = store.get(key, null);
  const order = 'SABCF';
  let nb = false;
  if (!best || order.indexOf(rank) < order.indexOf(best.rank)) {
    store.set(key, { rank, hits: run.hits });
    nb = !!best || rank !== 'F';
  }
  $('#res-new').hidden = !nb;
  S.playing = false;
  show('result');
}

// ─── ループ ────────────────────────────────────────────
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  S.time += dt;
  S.dt = S.paused ? 0 : dt;
  if (S.playing && run && !S.paused) {
    step();
    if (BOT) bot();
  }
  if (!S.paused) updatePlayer(dt);
  if (!S.playing && S.screen !== 'result') {
    // タイトル：棒人間はゆっくり左右に動く
    S.beat = S.time * 2;
    S.energy = 0.5;
    if (S.screen === 'title' && Math.random() < 0.008) S.player.lane = Math.max(0, Math.min(3, S.player.lane + (Math.random() < 0.5 ? -1 : 1)));
  }
  S.spectrum = Audio.readSpectrum();
  R.draw(S);
  requestAnimationFrame(frame);
}

// ─── ボタン ────────────────────────────────────────────
$('#btn-pause').addEventListener('click', pause);
$('#btn-resume').addEventListener('click', resume);
$('#btn-retry').addEventListener('click', () => { show('play'); S.paused = false; retry(); });
$('#btn-quit').addEventListener('click', quit);
$('#btn-again').addEventListener('click', () => retry());
$('#btn-back').addEventListener('click', quit);
$('#opt-hit').addEventListener('click', () => { settings.hitsound = !settings.hitsound; store.set('hitsound', settings.hitsound); renderSettings(); });
$('#opt-vibe').addEventListener('click', () => { settings.vibe = !settings.vibe; store.set('vibe', settings.vibe); renderSettings(); });
$('#btn-howto').addEventListener('click', () => { $('#howto').hidden = false; });
$('#btn-howto-close').addEventListener('click', () => { $('#howto').hidden = true; });

window.addEventListener('resize', () => R.resize());
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => R.resize());
// ダブルタップでの拡大を防ぐ
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (S.screen === 'play') e.preventDefault(); }, { passive: false });
document.addEventListener('pointerdown', () => Audio.unlock(), { once: true });

renderSettings();
show('title');
loadSongs().catch((e) => {
  console.error(e);
  $('#songs').textContent = '曲の一覧を読めませんでした。';
});
requestAnimationFrame(frame);

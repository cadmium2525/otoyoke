// 音避け：描画（Canvas 2D の疑似 3D）
// 世界座標：x = 左右（列の幅 = 1、4 列で -2〜2）、y = 高さ、z = 奥行き（0 = 判定ライン＝棒人間の位置）

export const LANE_COLORS = ['#29e6ff', '#ff3fd0', '#b066ff', '#ffb52e'];
export const GATE_COLOR = '#ff3b6b';
export const laneX = (l) => l - 1.5;

export const Z_FAR = 34;
const CAM_D = 5.5;
const ROAD_HALF = 2.12;
export const GATE_BOTTOM = 0.8;
const GATE_TOP = 1.02;

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.bg = document.createElement('canvas');
    this.particles = [];
    this.popups = [];
    this.laneFlash = [0, 0, 0, 0];
    this.shake = 0;
    this.flash = 0;
    this.trail = [];
    this.scarf = null;
    this.resize();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.cv.width = Math.round(this.W * dpr);
    this.cv.height = Math.round(this.H * dpr);
    const W = this.W, H = this.H;
    this.cx = W / 2;
    this.hy = H * 0.25; // 地平線
    this.judgeY = H * 0.71;
    this.s0 = Math.min((W * 0.86) / 4, H * 0.12);
    this.K = this.s0 * CAM_D;
    this.camH = (this.judgeY - this.hy) / this.s0;
    // 画面の下端に当たる z
    this.zNear = Math.max(-CAM_D * 0.8, (this.camH * this.K) / (H - this.hy + 4) - CAM_D);
    this.buildBackground();
  }

  proj(x, y, z) {
    const s = this.K / (z + CAM_D);
    return [this.cx + x * s, this.hy + (this.camH - y) * s, s];
  }

  // ─── 動かない背景（空・ステージ・観客）を一度だけ描く ────────────
  buildBackground() {
    const { W, H, cx, hy } = this;
    const dpr = this.dpr;
    const bg = this.bg;
    bg.width = Math.round(W * dpr);
    bg.height = Math.round(H * dpr);
    const g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#07041a');
    sky.addColorStop(0.25, '#1b0b45');
    sky.addColorStop(0.5, '#120a35');
    sky.addColorStop(1, '#090619');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);

    // 奥の光
    const glow = g.createRadialGradient(cx, hy, 0, cx, hy, W * 0.9);
    glow.addColorStop(0, 'rgba(190,80,255,0.55)');
    glow.addColorStop(0.35, 'rgba(120,40,220,0.22)');
    glow.addColorStop(1, 'rgba(60,0,120,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);

    // トラス（骨組み）
    g.strokeStyle = 'rgba(150,120,220,0.35)';
    g.lineWidth = 1.5;
    const trussY = hy - H * 0.17;
    for (const side of [-1, 1]) {
      const x0 = cx + side * W * 0.36;
      g.beginPath();
      g.moveTo(x0, trussY);
      g.lineTo(x0, hy + 10);
      g.moveTo(x0 + side * 10, trussY);
      g.lineTo(x0 + side * 10, hy + 10);
      for (let y = trussY; y < hy; y += 10) {
        g.moveTo(x0, y);
        g.lineTo(x0 + side * 10, y + 10);
      }
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - W * 0.36, trussY);
    g.lineTo(cx + W * 0.36, trussY);
    g.moveTo(cx - W * 0.36, trussY + 9);
    g.lineTo(cx + W * 0.36, trussY + 9);
    for (let x = cx - W * 0.36; x < cx + W * 0.36; x += 9) {
      g.moveTo(x, trussY);
      g.lineTo(x + 9, trussY + 9);
    }
    g.stroke();

    // ステージ（バンドのシルエット）
    const stY = hy + 2;
    g.fillStyle = '#0a0618';
    g.fillRect(cx - W * 0.3, stY - 4, W * 0.6, 8);
    g.fillStyle = '#05030c';
    const band = (x, h, kind) => {
      const s = h / 30;
      g.save();
      g.translate(x, stY - 4);
      g.scale(s, s);
      g.beginPath();
      g.arc(0, -26, 3.2, 0, TAU);
      g.fill();
      g.fillRect(-3, -23, 6, 12);
      g.fillRect(-3, -11, 2.4, 11);
      g.fillRect(0.6, -11, 2.4, 11);
      if (kind === 'g') {
        g.save();
        g.translate(0, -15);
        g.rotate(-0.4);
        g.fillRect(-9, -1.2, 16, 2.4);
        g.beginPath();
        g.ellipse(-6, 0, 4, 3, 0, 0, TAU);
        g.fill();
        g.restore();
      }
      if (kind === 'd') {
        g.beginPath();
        g.ellipse(0, -6, 9, 6, 0, 0, TAU);
        g.fill();
        g.fillRect(-14, -14, 6, 2);
        g.fillRect(8, -16, 6, 2);
      }
      g.restore();
    };
    band(cx - W * 0.17, H * 0.035, 'g');
    band(cx, H * 0.03, 'd');
    band(cx + W * 0.17, H * 0.035, 'g');

    // スピーカー
    for (const side of [-1, 1]) {
      const x = cx + side * W * 0.42;
      const w = W * 0.13, h = H * 0.1;
      const y = hy - h * 0.55;
      g.fillStyle = '#0c0820';
      g.strokeStyle = 'rgba(160,120,255,0.5)';
      g.lineWidth = 1.2;
      g.fillRect(x - w / 2, y, w, h);
      g.strokeRect(x - w / 2, y, w, h);
      g.beginPath();
      g.arc(x, y + h * 0.33, w * 0.28, 0, TAU);
      g.arc(x, y + h * 0.75, w * 0.18, 0, TAU);
      g.stroke();
    }

    // 観客（左右の下側）
    const crowdTop = hy + (this.judgeY - hy) * 0.25;
    for (const side of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        const yBase = crowdTop + row * H * 0.06;
        g.fillStyle = ['#140c2e', '#0e0822', '#080516'][row];
        for (let i = 0; i < 12; i++) {
          const fy = yBase + H * 0.06 + ((i * 37) % 11);
          const t = (fy - hy) / (this.judgeY - hy);
          const roadEdge = cx + side * ROAD_HALF * this.s0 * lerp(0.07, 1, clamp(t, 0, 1.4)) * 1.04;
          const xx = side < 0 ? lerp(0, roadEdge - 6, ((i * 53) % 97) / 97) : lerp(roadEdge + 6, W, ((i * 53) % 97) / 97);
          const s = H * 0.012 * (1 + row * 0.35);
          g.beginPath();
          g.arc(xx, fy - s * 2.4, s, 0, TAU);
          g.fill();
          g.beginPath();
          g.ellipse(xx, fy + s * 0.6, s * 1.6, s * 2.6, 0, 0, TAU);
          g.fill();
        }
      }
    }
    // 観客の位置（サイリウム用）
    this.fans = [];
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1;
      const fy = crowdTop + ((i * 29) % 100) / 100 * H * 0.17 + H * 0.03;
      const t = (fy - hy) / (this.judgeY - hy);
      const roadEdge = cx + side * ROAD_HALF * this.s0 * lerp(0.07, 1, clamp(t, 0, 1.4)) * 1.04;
      const xx = side < 0 ? lerp(4, roadEdge - 12, ((i * 61) % 89) / 89) : lerp(roadEdge + 12, W - 4, ((i * 61) % 89) / 89);
      this.fans.push({ x: xx, y: fy, ph: i * 1.7, c: LANE_COLORS[i % 4], s: 0.7 + t * 0.6 });
    }
  }

  // ─── 毎フレーム ────────────────────────────────────────────
  draw(S) {
    const g = this.g;
    const { W, H, dpr } = this;
    const t = S.time;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let sx = 0, sy = 0;
    if (this.shake > 0) {
      sx = (Math.random() - 0.5) * this.shake * 14;
      sy = (Math.random() - 0.5) * this.shake * 14;
      this.shake = Math.max(0, this.shake - S.dt * 3);
    }
    g.drawImage(this.bg, 0, 0, W, H);
    g.save();
    g.translate(sx, sy);

    const beat = S.beat; // 拍（小数）
    const ph = beat - Math.floor(beat);
    const pulse = S.playing ? Math.exp(-ph * 5) : 0.3 + 0.2 * Math.sin(t * 2);
    const energy = S.energy ?? 0.5;

    this.drawStageFx(g, S, pulse, energy);
    this.drawRoad(g, S, pulse);
    this.drawNotes(g, S);
    this.drawPlayer(g, S);
    this.drawParticles(g, S.dt);
    this.drawPopups(g, S.dt);
    g.restore();

    // 被弾のフラッシュ
    if (this.flash > 0) {
      const v = g.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
      v.addColorStop(0, 'rgba(255,0,60,0)');
      v.addColorStop(1, `rgba(255,0,60,${this.flash * 0.6})`);
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
      this.flash = Math.max(0, this.flash - S.dt * 2);
    }
  }

  drawStageFx(g, S, pulse, energy) {
    const { W, H, cx, hy } = this;
    const t = S.time;
    g.save();
    g.globalCompositeOperation = 'lighter';

    // スポットライト
    const n = 4;
    for (let i = 0; i < n; i++) {
      const left = i < n / 2;
      const ox = left ? W * (0.08 + i * 0.12) : W * (0.92 - (i - 2) * 0.12);
      const oy = hy - H * 0.17;
      const ang = Math.PI / 2 + Math.sin(t * (0.6 + i * 0.17) + i) * 0.5 + (left ? -0.15 : 0.15);
      const len = H * 0.8;
      const spread = 0.09;
      const c = LANE_COLORS[(((i + Math.floor(S.beat / 8)) % 4) + 4) % 4];
      const gr = g.createLinearGradient(ox, oy, ox + Math.cos(ang) * len, oy + Math.sin(ang) * len);
      const a = (0.1 + energy * 0.12) * (0.7 + pulse * 0.5);
      gr.addColorStop(0, hexA(c, a * 1.6));
      gr.addColorStop(1, hexA(c, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ox + Math.cos(ang - spread) * len, oy + Math.sin(ang - spread) * len);
      g.lineTo(ox + Math.cos(ang + spread) * len, oy + Math.sin(ang + spread) * len);
      g.closePath();
      g.fill();
      g.fillStyle = hexA('#ffffff', 0.7);
      g.beginPath();
      g.arc(ox, oy, 3 + pulse * 2, 0, TAU);
      g.fill();
    }

    // 音の柱（スペクトラム）：地平線の上
    const spec = S.spectrum;
    const bars = 24;
    const bw = (W * 0.9) / bars;
    for (let i = 0; i < bars; i++) {
      const k = Math.abs(i - (bars - 1) / 2) / (bars / 2);
      let v;
      if (spec) v = spec[Math.floor(2 + (1 - k) * 40 + (i % 3))] / 255;
      else v = 0.25 + 0.2 * Math.sin(t * 2 + i * 0.7);
      const h = (H * 0.02 + v * v * H * 0.11) * (1 - k * 0.3);
      const x = cx - (W * 0.9) / 2 + i * bw;
      const c = i % 2 ? '#9a4dff' : '#ff3fd0';
      g.fillStyle = hexA(c, 0.25);
      for (let y = 0; y < h; y += 5) g.fillRect(x + 1, hy - 8 - y, bw - 2, 3);
    }

    // 中央のリング
    const ry = hy - H * 0.09;
    const rr = W * 0.12 * (1 + pulse * 0.06);
    for (let k = 0; k < 3; k++) {
      g.strokeStyle = hexA(k === 1 ? '#29e6ff' : '#d06bff', 0.35 + pulse * 0.4 - k * 0.08);
      g.lineWidth = 2.5 - k * 0.6;
      g.beginPath();
      g.arc(cx, ry, rr * (1 + k * 0.28), 0, TAU);
      g.stroke();
    }
    g.fillStyle = hexA('#f3c8ff', 0.6 + pulse * 0.4);
    g.font = `bold ${Math.round(rr * 1.1)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('♫', cx, ry + rr * 0.05);

    // 左右の LED 画面
    for (const side of [-1, 1]) {
      const w = W * 0.2, h = H * 0.075;
      const x = side < 0 ? W * 0.02 : W * 0.78;
      const y = hy - H * 0.13;
      g.strokeStyle = hexA('#b066ff', 0.6);
      g.lineWidth = 1.5;
      g.strokeRect(x, y, w, h);
      const cols = 8;
      for (let i = 0; i < cols; i++) {
        let v = spec ? spec[3 + i * 5] / 255 : 0.3 + 0.25 * Math.sin(t * 3 + i);
        v = clamp(v * 1.1, 0.05, 1);
        const cc = LANE_COLORS[(i + (side > 0 ? 2 : 0)) % 4];
        g.fillStyle = hexA(cc, 0.55);
        const bh = v * (h - 6);
        const cw = (w - 6) / cols;
        for (let yy = 0; yy < bh; yy += 4) g.fillRect(x + 3 + i * cw + 1, y + h - 3 - yy - 3, cw - 2, 3);
      }
    }

    // サイリウム
    for (const f of this.fans) {
      const a = Math.sin(S.beat * Math.PI + f.ph) * 0.6;
      const L = 12 * f.s;
      const jump = S.playing && energy > 0.7 ? Math.max(0, Math.sin(S.beat * Math.PI * 2 + f.ph)) * 4 : 0;
      const x0 = f.x, y0 = f.y - jump;
      const x1 = x0 + Math.sin(a) * L, y1 = y0 - Math.cos(a) * L;
      g.strokeStyle = hexA(f.c, 0.35);
      g.lineWidth = 6 * f.s;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.strokeStyle = hexA(f.c, 0.95);
      g.lineWidth = 2.2 * f.s;
      g.stroke();
    }
    g.restore();
  }

  drawRoad(g, S, pulse) {
    const zN = this.zNear;
    const zF = Z_FAR;
    const P = (x, y, z) => this.proj(x, y, z);
    // 床
    const [ax, ay] = P(-ROAD_HALF, 0, zN), [bx] = P(ROAD_HALF, 0, zN);
    const [cx_, cy] = P(ROAD_HALF, 0, zF), [dx] = P(-ROAD_HALF, 0, zF);
    const fl = g.createLinearGradient(0, cy, 0, ay);
    fl.addColorStop(0, '#2a1458');
    fl.addColorStop(0.4, '#160c36');
    fl.addColorStop(1, '#0d0824');
    g.fillStyle = fl;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, ay);
    g.lineTo(cx_, cy);
    g.lineTo(dx, cy);
    g.closePath();
    g.fill();

    g.save();
    g.globalCompositeOperation = 'lighter';
    // 列の光（ノーツを処理した直後に光る）
    for (let l = 0; l < 4; l++) {
      const f = this.laneFlash[l];
      const base = 0.05;
      const a = base + f * 0.5;
      const x0 = laneX(l) - 0.5, x1 = laneX(l) + 0.5;
      const [p0x, p0y] = P(x0, 0, zN), [p1x] = P(x1, 0, zN);
      const [p2x, p2y] = P(x1, 0, 14), [p3x] = P(x0, 0, 14);
      const gr = g.createLinearGradient(0, p0y, 0, p2y);
      gr.addColorStop(0, hexA(LANE_COLORS[l], a));
      gr.addColorStop(1, hexA(LANE_COLORS[l], 0));
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.lineTo(p1x, p0y);
      g.lineTo(p2x, p2y);
      g.lineTo(p3x, p2y);
      g.closePath();
      g.fill();
      this.laneFlash[l] = Math.max(0, f - S.dt * 5);
    }

    // 拍の線（小節線は明るく）
    if (S.chart) {
      const spb = 60 / S.chart.bpm;
      const b0 = Math.ceil((S.songTime - 0.3) / spb);
      const b1 = Math.floor((S.songTime + S.lead) / spb);
      for (let b = b0; b <= b1; b++) {
        const z = ((b * spb - S.songTime) / S.lead) * zF;
        if (z < zN || z > zF) continue;
        const bar = b % S.chart.beatsPerBar === 0;
        const [l0x, l0y] = P(-ROAD_HALF, 0, z), [l1x] = P(ROAD_HALF, 0, z);
        const fade = clamp(1 - z / zF, 0, 1);
        g.strokeStyle = hexA(bar ? '#d9a6ff' : '#7a55d6', (bar ? 0.55 : 0.22) * fade);
        g.lineWidth = bar ? 2 : 1;
        g.beginPath();
        g.moveTo(l0x, l0y);
        g.lineTo(l1x, l0y);
        g.stroke();
      }
    } else {
      // タイトル画面：流れる格子
      for (let k = 0; k < 14; k++) {
        const z = zF - (((S.time * 6 + k * 3) % zF + zF) % zF);
        const [l0x, l0y] = P(-ROAD_HALF, 0, z), [l1x] = P(ROAD_HALF, 0, z);
        g.strokeStyle = hexA('#7a55d6', 0.3 * clamp(1 - z / zF, 0, 1));
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(l0x, l0y);
        g.lineTo(l1x, l0y);
        g.stroke();
      }
    }

    // 列の区切り
    for (let i = -2; i <= 2; i++) {
      const edge = Math.abs(i) === 2;
      const [x0, y0] = P(i * (edge ? ROAD_HALF / 2 : 1), 0, zN);
      const [x1, y1] = P(i * (edge ? ROAD_HALF / 2 : 1), 0, zF);
      const c = edge ? (i < 0 ? '#29e6ff' : '#ff3fd0') : '#8f6bff';
      g.strokeStyle = hexA(c, edge ? 0.35 : 0.12);
      g.lineWidth = edge ? 7 : 3;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.strokeStyle = hexA(c, edge ? 0.95 : 0.4);
      g.lineWidth = edge ? 2 : 1;
      g.stroke();
    }

    // 道の脇の光（流れてくる）
    const spd = S.chart ? zF / S.lead : 6;
    const st = S.chart ? S.songTime : S.time;
    for (let k = 0; k < 12; k++) {
      const z = (((k * 4 - st * spd) % 48) + 48) % 48 - 2;
      if (z < zN || z > zF) continue;
      for (const side of [-1, 1]) {
        const x = side * (ROAD_HALF + 0.25);
        const [p0x, p0y, s] = P(x, 0.05, z);
        const [, p1y] = P(x, 0.05, z + 1.2);
        const w = s * 0.18;
        const a = clamp(1 - z / zF, 0, 1) * (0.6 + pulse * 0.4);
        g.fillStyle = hexA(side < 0 ? '#29e6ff' : '#ff3fd0', a);
        g.fillRect(p0x - w / 2, p1y, w, Math.max(1, p0y - p1y));
      }
    }

    // 判定ライン
    const [jx0, jy] = P(-ROAD_HALF, 0, 0), [jx1] = P(ROAD_HALF, 0, 0);
    g.strokeStyle = hexA('#ffffff', 0.25 + pulse * 0.3);
    g.lineWidth = 8;
    g.beginPath();
    g.moveTo(jx0, jy);
    g.lineTo(jx1, jy);
    g.stroke();
    g.strokeStyle = hexA('#ffffff', 0.9);
    g.lineWidth = 2;
    g.stroke();
    g.restore();
  }

  // ─── ノーツ ─────────────────────────────────────────────
  drawNotes(g, S) {
    if (!S.chart) return;
    const zF = Z_FAR;
    const list = S.visible;
    // 奥から順に
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const z = ((n.t - S.songTime) / S.lead) * zF;
      if (n.type === 'long') {
        const z1 = ((n.t + n.d - S.songTime) / S.lead) * zF;
        if (z1 < 0) continue;
        this.drawLong(g, n, Math.max(0, z), Math.min(z1, zF), z < 0);
      } else if (n.type === 'gate') {
        if (z < -0.2 || n.done) continue;
        this.drawGate(g, z, S);
      } else {
        if (z < -0.2 || n.done) continue;
        if (n.lanes.length > 1) this.drawLink(g, n, z);
        for (const l of n.lanes) this.drawTap(g, l, z);
      }
    }
  }

  quad(g, pts) {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
  }

  drawTap(g, lane, z) {
    const c = LANE_COLORS[lane];
    const x0 = laneX(lane) - 0.43, x1 = laneX(lane) + 0.43;
    const h = 0.16, dz = 0.42;
    const fade = clamp((Z_FAR - z) / 6, 0, 1);
    const P = (x, y, zz) => this.proj(x, y, zz);
    const top = [P(x0, h, z), P(x1, h, z), P(x1, h, z + dz), P(x0, h, z + dz)];
    const front = [P(x0, 0, z), P(x1, 0, z), P(x1, h, z), P(x0, h, z)];
    g.save();
    g.globalAlpha = fade;
    g.fillStyle = hexA(c, 0.28);
    this.quad(g, top);
    g.fill();
    g.fillStyle = hexA(c, 0.55);
    this.quad(g, front);
    g.fill();
    g.globalCompositeOperation = 'lighter';
    const s = top[0][2];
    g.lineJoin = 'round';
    g.strokeStyle = hexA(c, 0.45);
    g.lineWidth = Math.max(2, s * 0.16);
    this.quad(g, top);
    g.stroke();
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1, s * 0.035);
    this.quad(g, top);
    g.stroke();
    g.strokeStyle = hexA(c, 0.9);
    g.lineWidth = Math.max(1, s * 0.05);
    this.quad(g, front);
    g.stroke();
    // 矢印（手前向き）
    if (s > 10) {
      g.strokeStyle = hexA(c, 0.95);
      g.lineWidth = Math.max(1.5, s * 0.05);
      const xm = laneX(lane);
      for (let k = 0; k < 2; k++) {
        const zz = z + dz * (0.3 + k * 0.32);
        const a = P(xm - 0.16, h, zz + 0.12), b = P(xm, h, zz), d = P(xm + 0.16, h, zz + 0.12);
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.lineTo(d[0], d[1]);
        g.stroke();
      }
    }
    g.restore();
  }

  drawLink(g, n, z) {
    const a = this.proj(laneX(n.lanes[0]), 0.08, z + 0.2);
    const b = this.proj(laneX(n.lanes[n.lanes.length - 1]), 0.08, z + 0.2);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = clamp((Z_FAR - z) / 6, 0, 1);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = Math.max(1, a[2] * 0.04);
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
    g.restore();
  }

  drawLong(g, n, z0, z1, active) {
    const lane = n.lanes[0];
    const c = LANE_COLORS[lane];
    const x0 = laneX(lane) - 0.34, x1 = laneX(lane) + 0.34;
    const P = (x, y, zz) => this.proj(x, y, zz);
    const pts = [P(x0, 0.02, z0), P(x1, 0.02, z0), P(x1, 0.02, z1), P(x0, 0.02, z1)];
    g.save();
    g.globalAlpha = clamp((Z_FAR - z0) / 6, 0, 1);
    const gr = g.createLinearGradient(0, pts[0][1], 0, pts[2][1]);
    gr.addColorStop(0, hexA(c, active ? 0.75 : 0.5));
    gr.addColorStop(1, hexA(c, 0.25));
    g.fillStyle = gr;
    this.quad(g, pts);
    g.fill();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = hexA(c, 0.9);
    g.lineWidth = Math.max(1, pts[0][2] * 0.04);
    this.quad(g, pts);
    g.stroke();
    // 中の格子
    g.strokeStyle = hexA('#ffffff', 0.18);
    g.lineWidth = 1;
    for (let zz = Math.ceil(z0 / 0.8) * 0.8; zz < z1; zz += 0.8) {
      const a = P(x0, 0.02, zz), b = P(x1, 0.02, zz);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    }
    g.restore();
    if (!active) this.drawTap(g, lane, z0);
    if (z1 < Z_FAR) this.drawCap(g, lane, z1);
  }

  drawCap(g, lane, z) {
    const c = LANE_COLORS[lane];
    const a = this.proj(laneX(lane) - 0.36, 0.02, z), b = this.proj(laneX(lane) + 0.36, 0.02, z);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = hexA(c, 1);
    g.lineWidth = Math.max(2, a[2] * 0.08);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
    g.restore();
  }

  drawGate(g, z, S) {
    const c = GATE_COLOR;
    const P = (x, y, zz) => this.proj(x, y, zz);
    const xa = -ROAD_HALF - 0.05, xb = ROAD_HALF + 0.05;
    const dz = 0.3;
    const fade = clamp((Z_FAR - z) / 6, 0, 1);
    g.save();
    g.globalAlpha = fade;
    // 床の影
    const sh = [P(xa, 0, z), P(xb, 0, z), P(xb, 0, z + dz), P(xa, 0, z + dz)];
    g.fillStyle = 'rgba(0,0,0,0.45)';
    this.quad(g, sh);
    g.fill();
    // 柱
    for (const x of [xa, xb]) {
      const a = P(x, 0, z), b = P(x, GATE_TOP, z);
      g.strokeStyle = hexA('#ffffff', 0.85);
      g.lineWidth = Math.max(2, a[2] * 0.07);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    }
    // バー
    const front = [P(xa, GATE_BOTTOM, z), P(xb, GATE_BOTTOM, z), P(xb, GATE_TOP, z), P(xa, GATE_TOP, z)];
    const top = [P(xa, GATE_TOP, z), P(xb, GATE_TOP, z), P(xb, GATE_TOP, z + dz), P(xa, GATE_TOP, z + dz)];
    g.fillStyle = hexA(c, 0.6);
    this.quad(g, front);
    g.fill();
    g.fillStyle = hexA(c, 0.35);
    this.quad(g, top);
    g.fill();
    // 斜めのしま
    const s = front[0][2];
    g.save();
    this.quad(g, front);
    g.clip();
    g.fillStyle = 'rgba(20,0,20,0.45)';
    const fy0 = front[2][1], fy1 = front[0][1];
    const hh = fy1 - fy0;
    for (let x = front[0][0] - hh; x < front[1][0]; x += hh * 1.6) {
      g.beginPath();
      g.moveTo(x, fy1);
      g.lineTo(x + hh * 0.7, fy1);
      g.lineTo(x + hh * 1.4, fy0);
      g.lineTo(x + hh * 0.7, fy0);
      g.closePath();
      g.fill();
    }
    g.restore();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = hexA(c, 0.5);
    g.lineWidth = Math.max(3, s * 0.18);
    this.quad(g, front);
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = Math.max(1, s * 0.04);
    this.quad(g, front);
    g.stroke();
    // 下向き矢印
    if (s > 14) {
      g.fillStyle = '#ffffff';
      g.font = `900 ${Math.round(s * 0.2)}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const my = (fy0 + fy1) / 2;
      for (const x of [-1.5, 0, 1.5]) {
        const p = P(x, 0, z);
        g.fillText(x === 0 ? '▼ SLIDE ▼' : '▼', p[0], my);
      }
    }
    g.restore();
  }

  // ─── 棒人間 ──────────────────────────────────────────────
  drawPlayer(g, S) {
    const p = S.player;
    if (!p) return;
    const [px, py, s] = this.proj(p.x, 0, 0);
    const H = 1.3 * s; // 身長（画面上）
    const t = S.time;

    // 影
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath();
    g.ellipse(px, py, s * 0.42, s * 0.09, 0, 0, TAU);
    g.fill();
    g.restore();

    // 横移動の残像
    if (Math.abs(p.vx) > 2) this.trail.push({ x: px, y: py, a: 0.4, s: Math.sign(p.vx) });
    for (const tr of this.trail) {
      g.save();
      g.globalAlpha = tr.a;
      g.fillStyle = '#ff3fd0';
      g.beginPath();
      g.ellipse(tr.x, py - H * 0.5, H * 0.12, H * 0.42, 0, 0, TAU);
      g.fill();
      g.restore();
      tr.a -= S.dt * 3;
    }
    this.trail = this.trail.filter((x) => x.a > 0);

    if (p.invuln > 0 && Math.floor(p.invuln * 14) % 2 === 0 && !p.dead) return;

    const J = this.pose(S);
    const T = (q) => [px + q[0] * H, py - q[1] * H];

    // マフラー（首に結んで、後ろへなびく）
    const neck = T(J.neck);
    const dir = p.vx > 1 ? -1 : p.vx < -1 ? 1 : p.face;
    const pts = [];
    const segs = 9;
    for (let i = 0; i <= segs; i++) {
      const k = i / segs;
      const wave = Math.sin(t * 13 - i * 0.9) * k * H * 0.05;
      const lift = p.slide > 0 ? H * 0.06 * k : H * 0.12 * k;
      pts.push([neck[0] + dir * k * H * (p.slide > 0 ? 0.7 : 0.55), neck[1] - lift + wave + Math.sin(t * 7 + i) * k * 2]);
    }
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const [w, col] of [[H * 0.09, '#ffffff'], [H * 0.065, '#ff3f7f']]) {
      g.strokeStyle = col;
      for (let i = 0; i < segs; i++) {
        g.lineWidth = w * (1 - (i / segs) * 0.55);
        g.beginPath();
        g.moveTo(pts[i][0], pts[i][1]);
        g.lineTo(pts[i + 1][0], pts[i + 1][1]);
        g.stroke();
      }
    }
    g.restore();

    // 体：白いふち → 黒
    const limbs = [
      [J.neck, J.hip],
      [J.sh, J.le, J.lh],
      [J.sh, J.re, J.rh],
      [J.hip, J.lk, J.lf],
      [J.hip, J.rk, J.rf],
    ];
    const lw = H * 0.075;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const hit = p.hurt > 0;
    for (const [w, col] of [[lw + H * 0.035, hit ? '#ff3b6b' : '#ffffff'], [lw, '#05030a']]) {
      g.strokeStyle = col;
      g.lineWidth = w;
      for (const L of limbs) {
        g.beginPath();
        const a = T(L[0]);
        g.moveTo(a[0], a[1]);
        for (let i = 1; i < L.length; i++) {
          const b = T(L[i]);
          g.lineTo(b[0], b[1]);
        }
        g.stroke();
      }
      const hd = T(J.head);
      g.fillStyle = col;
      g.beginPath();
      g.arc(hd[0], hd[1], H * 0.115 + (w - lw) / 2, 0, TAU);
      g.fill();
    }
    // 目（つり目）
    const hd = T(J.head);
    const r = H * 0.115;
    const look = clamp(p.vx * 0.02, -0.3, 0.3) + (p.slide > 0 ? -p.face * 0.15 : 0);
    g.fillStyle = '#ffffff';
    for (const side of [-1, 1]) {
      const ex = hd[0] + (side * 0.42 + look) * r;
      const ey = hd[1] + 0.05 * r;
      g.beginPath();
      g.moveTo(ex - side * 0.28 * r, ey - 0.2 * r);
      g.lineTo(ex + side * 0.28 * r, ey + 0.02 * r);
      g.lineTo(ex - side * 0.1 * r, ey + 0.2 * r);
      g.closePath();
      g.fill();
    }
    g.restore();

    // スライディングの火花
    if (p.slide > 0 && Math.random() < 0.9) {
      const f = T(J.lh);
      for (let i = 0; i < 2; i++)
        this.particles.push({ x: f[0], y: f[1], vx: (Math.random() - 0.5) * 160 + dir * 140, vy: -Math.random() * 160, life: 0.35, max: 0.35, c: '#ffd36b', r: 2 });
    }
  }

  pose(S) {
    const p = S.player;
    const beat = S.playing ? S.beat : S.time * 2;
    const ph = beat * Math.PI; // 1 拍で半周（2 拍で 1 歩ずつ左右）
    const bob = Math.abs(Math.sin(ph)) * 0.03;
    const lean = clamp(p.vx * 0.012, -0.12, 0.12);
    const run = {};
    run.hip = [lean * 0.3, 0.46 + bob];
    run.neck = [lean, 0.8 + bob];
    run.head = [lean * 1.3, 0.92 + bob];
    run.sh = [lean * 0.9, 0.76 + bob];
    for (const sd of [-1, 1]) {
      const ps = ph + (sd < 0 ? 0 : Math.PI);
      const lift = Math.max(0, Math.sin(ps));
      const k = sd < 0 ? 'l' : 'r';
      run[k + 'k'] = [run.hip[0] + sd * (0.09 + lift * 0.05), 0.24 + bob + lift * 0.12];
      run[k + 'f'] = [run[k + 'k'][0] + sd * (0.02 - lift * 0.05), 0.0 + lift * 0.14];
      const sw = Math.sin(ps + Math.PI);
      run[k + 'e'] = [run.sh[0] + sd * 0.16, 0.62 + bob + sw * 0.03];
      run[k + 'h'] = [run[k + 'e'][0] + sd * 0.03, 0.72 + bob + sw * 0.07];
    }
    // スライディング（画像のような低い体勢）
    const f = p.face; // 進む向き
    const sl = {
      hip: [0.05 * f, 0.16],
      neck: [-0.16 * f, 0.36],
      head: [-0.26 * f, 0.45],
      sh: [-0.13 * f, 0.33],
      lk: [0.32 * f, 0.1],
      lf: [0.6 * f, 0.02],
      rk: [-0.06 * f, 0.03],
      rf: [0.18 * f, 0.0],
      le: [-0.36 * f, 0.2],
      lh: [-0.5 * f, 0.01],
      re: [0.08 * f, 0.42],
      rh: [0.34 * f, 0.5],
    };
    let k = p.slideAmt;
    if (p.dead) {
      // 倒れる
      const dn = {
        hip: [0, 0.08], neck: [-0.35, 0.08], head: [-0.5, 0.1], sh: [-0.3, 0.08],
        lk: [0.2, 0.12], lf: [0.4, 0.02], rk: [0.22, 0.03], rf: [0.45, 0.0],
        le: [-0.2, 0.25], lh: [-0.1, 0.35], re: [-0.45, 0.25], rh: [-0.6, 0.3],
      };
      const out = {};
      for (const key in run) out[key] = [lerp(run[key][0], dn[key][0], p.deadAmt), lerp(run[key][1], dn[key][1], p.deadAmt)];
      return out;
    }
    const out = {};
    const ease = k * k * (3 - 2 * k);
    for (const key in run) out[key] = [lerp(run[key][0], sl[key][0], ease), lerp(run[key][1], sl[key][1], ease)];
    if (p.hurt > 0) {
      const w = p.hurt;
      out.head = [out.head[0] + Math.sin(S.time * 60) * 0.03 * w, out.head[1] - 0.03 * w];
      out.lh = [out.lh[0] - 0.12 * w, out.lh[1] + 0.2 * w];
      out.rh = [out.rh[0] + 0.12 * w, out.rh[1] + 0.2 * w];
    }
    return out;
  }

  // ─── 効果 ───────────────────────────────────────────────
  burst(lane, color, big) {
    const [x, y, s] = this.proj(laneX(lane), 0.1, 0);
    this.laneFlash[lane] = 1;
    for (let i = 0; i < (big ? 18 : 10); i++) {
      const a = -Math.PI * Math.random();
      const v = (80 + Math.random() * 260) * (s / 80);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5, max: 0.5, c: color, r: 2 + Math.random() * 2.5 });
    }
    this.particles.push({ ring: true, x, y, life: 0.35, max: 0.35, c: color, r: s * 0.5 });
  }

  gateBurst() {
    for (let l = 0; l < 4; l++) this.burst(l, GATE_COLOR, false);
  }

  popup(lane, text, color, size = 1) {
    const [x, y, s] = this.proj(lane == null ? 0 : laneX(lane), 0, 0);
    this.popups.push({ x, y: y - s * 1.6, text, color, life: 0.6, max: 0.6, size: s * 0.3 * size });
  }

  drawParticles(g, dt) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      p.life -= dt;
      const a = clamp(p.life / p.max, 0, 1);
      if (p.ring) {
        g.strokeStyle = hexA(p.c, a);
        g.lineWidth = 3 * a + 1;
        g.beginPath();
        g.ellipse(p.x, p.y, p.r * (1.6 - a), p.r * (1.6 - a) * 0.35, 0, 0, TAU);
        g.stroke();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 500 * dt;
      g.fillStyle = hexA(p.c, a);
      g.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    g.restore();
  }

  drawPopups(g, dt) {
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const p of this.popups) {
      p.life -= dt;
      const k = 1 - p.life / p.max;
      const a = clamp(p.life / p.max * 2, 0, 1);
      const sz = Math.max(10, p.size * (1 + (k < 0.15 ? (0.15 - k) * 3 : 0)));
      g.font = `italic 900 ${Math.round(sz)}px "Exo 2", Orbitron, "Arial Black", sans-serif`;
      g.globalAlpha = a;
      g.lineWidth = 4;
      g.strokeStyle = hexA(p.color, 0.6);
      g.strokeText(p.text, p.x, p.y - k * 30);
      g.fillStyle = '#ffffff';
      g.fillText(p.text, p.x, p.y - k * 30);
    }
    this.popups = this.popups.filter((p) => p.life > 0);
    g.restore();
  }
}

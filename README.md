# 音避け OTOYOKE

音ゲーのノーツを、棒人間を操作して**よけ続ける**リズムアクションゲームです。
音ゲーそのものはオートプレイで必ずフルコンボになります（演出）。プレイヤーの仕事は、流れてくるノーツから棒人間を守ること。

- スマホの縦画面向け（PC ではキーボードでも遊べます）
- サーバー不要・完全無料（GitHub Pages で公開）
- BGM と効果音はすべて [かなでる（mp4mp3）](https://github.com/cadmium2525/mp4mp3) のエンジンで自動作曲・書き出し。譜面は曲の音符から自動生成しているので、音と完全に同期します

## 遊び方

| 操作 | スマホ | キーボード |
| --- | --- | --- |
| 左右の列へ移動 | ◀ ▶ ボタン／左右スワイプ／画面の左右をタップ | ← → （A D） |
| スライディング | ▼ ボタン／下スワイプ | ↓ ／ スペース（S） |
| 一時停止 | 右上のボタン | Esc ／ P |

- **床のノーツ**：横によける。判定ライン（棒人間の足元）に来た瞬間に同じ列にいると被弾
- **ロングノーツ**：終わるまでその列に入らない（またいで移動もできない）
- **スライドノーツ**：判定ラインの上を斜めに流れて列をまたぐ。動く帯の通り道に入らない
- **高いバー（しま模様）**：スライディングでくぐる
- HP は 5。0 になると失敗。ノーダメージでクリアすると S ランク

収録曲（8 曲）：

| 難しさ | 曲 | スタイル |
| --- | --- | --- |
| EASY Lv.2 | Sugar Rush | かわいい |
| EASY Lv.3 | Neon Step | ポップ |
| NORMAL Lv.5 | Sakura Drift | 和風 |
| NORMAL Lv.6 | Laser Parade | EDM |
| NORMAL Lv.7 | Midnight Groove | ファンク |
| HARD Lv.8 | Thunder Riff | ロック |
| HARD Lv.9 | Pixel Overdrive | 8bit |
| EXPERT Lv.11 | Dark Pulse | トラップ |

## 公開方法（GitHub Pages・0円）

1. このブランチを `main` にマージする
2. GitHub のリポジトリで **Settings → Pages** を開く
3. **Source** を「Deploy from a branch」、**Branch** を `main` / `/(root)` にして Save
4. 1〜2分後に `https://<ユーザー名>.github.io/otoyoke/` で遊べます

ビルド不要の静的サイトです。ローカルで試すときは `python3 -m http.server` を実行して `http://localhost:8000` を開いてください（`file://` では曲が読めません）。

## 曲と譜面を作り直す・増やす

```sh
git clone https://github.com/cadmium2525/mp4mp3 ../mp4mp3
node tools/build-songs.mjs ../mp4mp3                # 全曲＋効果音（ffmpeg が必要）
node tools/build-songs.mjs ../mp4mp3 hard           # 1 曲だけ
node tools/build-songs.mjs ../mp4mp3 --chart-only   # 曲はそのまま、譜面だけ作り直す
node tools/check-charts.mjs                         # すべての譜面がよけきれるか確認
```

曲の一覧は `tools/build-songs.mjs` の `SONGS` にあります。かなでるの「おまかせ作曲」のスタイル（`pop` `edm` `8bit` `rock` `trap` `wafu` など 18 種）・BPM・長さ・シードを書き足せば曲が増えます。
難しさごとの譜面の作り方（音符の間隔・2 列ノーツ・バーの頻度など）は同じファイルの `DIFF` で調整できます。

譜面は「メロディ・キック・スネア・クラッシュ」の位置から作り、メロディが上がれば右、下がれば左にノーツが出ます。
置くたびに「プレイヤーがたどり着ける列」を計算して、必ずよけられる配置だけを残しています。

## 構成

- `index.html` / `css/style.css` — 画面
- `js/main.js` — ゲームの進行・当たり判定・操作・オートプレイの演出
- `js/render.js` — Canvas 2D による疑似 3D 描画（ステージ・レーン・ノーツ・棒人間）
- `js/audio.js` — Web Audio API（曲の再生と時刻、効果音、スペクトラム）
- `songs/` — BGM（MP3）・譜面（JSON）・曲の JSON（`src/`、かなでるで開ける）
- `sfx/` — 効果音（かなでるの効果音プリセット）
- `tools/` — 曲と譜面を作るスクリプト

開発用：URL に `?bot` を付けると、譜面から通り道を計算して自動でよけます（譜面の確認用）。

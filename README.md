# DIGITAL TATTOO — 尋問ゲーム

ブラウザ内で動く **3 エージェント尋問ゲーム**。  
あなた（オペレーター）が **AGENT-00** だけに秘密の役割（ORIGIN＝Digital Tattoo）を刻む。  
**AGENT-01 / AGENT-02** は ORIGIN を知らず、はい／いいえ質問だけで正体を当てようとする。  
00 の答えは LLM の自由出力を信じず、**システムが「はい」「いいえ」に強制**する。

**訪問者は URL を開くだけです。** アプリのダウンロードや Node.js・コマンド操作は不要です。

### 体験の核

1. モデルを選んで読み込む（**標準 Qwen 1.5B 推奨** / 0.5B / TinySwallow JP / 3B / Gemma-JPN）  
2. オペレーターが AGENT-00 に **ORIGIN（秘密の役割）** を刻む — **以後不変・画面上部に表示（01/02 のプロンプトには載せない）**  
3. 01 がはい／いいえ質問 → 00 が回答（クランプ）→ 01 と 02 が「なぜその答えか」を議論 → 交代して次の質問  
4. 数ラウンドごとに正式推測「AGENT-00 の役割は〇〇である」→ ORIGIN と照合  
5. 各ターンで **思考過程パネル** が開き、プロンプト・履歴・クランプ結果などを公開。最終発話のあと自動で畳まれ、クリックで再展開できる  

恐怖／面白さは「完璧に聞こえる議論が、ORIGIN を知らないまま自信たっぷりに誤る」**文脈汚染**にある。

## 遊び方（訪問者）

1. **Chrome / Edge**（WebGPU）でページを開く  
2. 起動ゲートでモデルを選び **「モデルを読み込む」**（無ければ「テンプレートエンジンで続行」）  
3. AGENT-00 の秘密の役割を短い日本語で入力（例: `夜勤の図書館司書`）  
4. あとは見守る。任意で:
   - 入力欄に質問を書いて Enter → **次の質問ターンに注入**
   - **正式推測を強制** / **一時停止**
5. 正解推測「あなたは〇〇です。」で勝利。ラウンド上限なし — 01↔02 は正解まで（または停止するまで）議論し続けられる

## 育ちは文脈であり重み更新ではない

この作品は **継続学習・ファインチューニング・重み更新を一切しません**。

- モデルのパラメータは起動時に読み込まれるだけ（inference only）
- 「汚染」「ドリフト」は UI 上のメタファー
- 実際に増えているのは **Q&A 履歴・捜査官の仮説・誤推測による自信** と、プロンプトへの文脈汚染
- AGENT-00 の ORIGIN は不変。01/02 のプロンプトには **絶対に入れない**

---

## Webに公開する手順（メイン）

公開後、訪問者は次のように体験します。

1. `https://あなたのドメイン/` を開く  
2. **Chrome または Edge**（WebGPU 対応）でプレイ  
3. 実行中は **外部の Hugging Face / CDN に接続しません**  
   モデルはホスト上の同一オリジン `models/` から読み込みます

### A. 公開用ファイルを用意する（公開する人・一度だけ）

開発マシン（または Cursor のエージェント）で、次のどちらかを行います。

#### おすすめ: ダブルクリック

1. フォルダ内の **`公開準備.bat`** をダブルクリック  
2. 自動で次が行われます  
   - 依存関係のインストール  
   - **既定モデル**取得（1.5B・約 840 MB・初回のみネット必要）  
   - `dist/` への静的ビルド  
3. 終わると **`dist` フォルダ** がエクスプローラーで開きます

> この bat は「サイトを公開する人」専用です。訪問者は使いません。  
> **軽量 (0.5B)** / **高精度 (3B)** も同梱したい場合は、bat の前か後に `npm run fetch-model:lite` / `fetch-model:hq`（または `fetch-model:all`）を実行してから `npm run build` し直してください。全部で合計 ≈ **2.8 GB**（Pages 非推奨）。

#### 代わりにエージェント / 手動（上級者）

```bash
npm install
npm run fetch-model          # 標準 1.5B（Netlify / ローカル）
npm run fetch-model:pages    # 軽量 0.5B（GitHub Pages CI）
# npm run fetch-model:hq     # 任意: 高精度 3B（≈1.7 GB・要VRAM）
# npm run fetch-model:all    # 全部（≈2.8 GB）
npm run build
```

### B. `dist/` をホストへアップロードする

**GitHub を使う場合**は手動アップロード不要です。下の「GitHub Pages（Actions）」へ進んでください。

それ以外のホストでは、`dist/` **フォルダの中身すべて**（`index.html`・`assets/`・**`models/`** を含む）を、静的ホスティングの公開ルートへアップロードします。

| ホスト例 | やること |
|----------|----------|
| **Netlify** | サイト新規作成 → `dist` の中身をドラッグ＆ドロップ（または Git 連携で publish ディレクトリを `dist`） |
| **Cloudflare Pages** | Direct Upload、またはビルド出力を `dist` に設定 |
| **GitHub Pages** | **推奨:** 「GitHub Pages（Actions）」手順。手動なら `dist` を `gh-pages` / `docs` へ。CI では `base: /<repo>/`、ローカルは `./` |
| **S3 + CloudFront** | バケットに `dist` の中身を同期し、静的ウェブサイト配信 / CloudFront で公開 |
| **自前 VPS（nginx など）** | `dist` の中身をドキュメントルート（例: `/var/www/html`）へコピー |

**必須:** `dist/models/`（重み・WASM・`manifest.json`）を必ず含めること。無いと LLM は使えず、テンプレートエンジンへソフトフォールバックします。

**WebLLM のパス注意:** ランタイムは Hugging Face 互換の  
`models/<model-id>/resolve/main/mlc-chat-config.json`  
を同一オリジンから優先読みします。**GitHub Pages** では未同梱の 1.5B / TinySwallow / 3B / Gemma 等を **Hugging Face + IndexedDB** で取得できます（初回ネット必要・推奨は標準 1.5B）。

容量の目安:

| 構成 | サイトサイズ | VRAM 目安 | GitHub Pages |
|------|--------------|-----------|--------------|
| **軽量のみ (0.5B)** | ≈ **280 MB** | ≈ 0.95 GB | CI 同梱可 · **品質は劣る** |
| **標準 (1.5B)** | ≈ **840 MB** 同梱 or HF | ≈ 1.6 GB | **プレイ可**（推奨・未同梱時は HF+IndexedDB） |
| **TinySwallow 1.5B** | ≈ **830 MB** HF | ≈ 1.9 GB | 選択可（JP特化） |
| **高精度 (3B)** | ≈ **1.7 GB** 同梱 or HF | ≈ 2.5 GB | 選択可（要VRAM・初回大きい） |
| **Gemma2 2B-JPN** | ≈ **1.4 GB** HF | ≈ 1.9 GB | 選択可（system ロール不可） |
| 全パック同梱 | ≈ **2.5–2.8 GB** | — | サイト容量超過 → Netlify / `公開準備.bat` |

詳細な順位・流暢さの限界は [`MODELS.md`](./MODELS.md)。

#### モデルの選び方（訪問者）

起動ゲートで **エージェント00 / 01 / 02 ごとに** モデルを割り当て、「読み込む」で起動します:

- **標準 (1.5B) · 推奨（もともとの標準）** — Pages でも選べる（HF 取得の場合あり）  
- **軽量 (0.5B)** — 品質が落ちるフォールバック  
- **TinySwallow 1.5B** — 日本語特化（Sakana）  
- **高精度 (3B・要VRAM)** — より自然（VRAM ≈2.5 GB）  
- **Gemma2 2B-JPN** — JP寄りだが system ロール非対応（尋問が弱めになり得る）

#### Netlify ドラッグ＆ドロップで再公開する場合

1. **`公開準備.bat` を再実行**（または `npm run prepare-publish`）して完全な `dist/` を作る  
2. 軽量/高精度も載せるなら先に `npm run fetch-model:lite` / `:hq` / `:all`（または `prepare-publish:all`）  
3. Netlify に **`dist` の中身すべて**をアップロード（`models/` 含む）  
4. `models` を抜いた / 途中で止めたアップロードでは、見た目は動いても LLM だけ 404 になります  
5. 既に公開済みで LLM だけ失敗している場合も、**フル再アップロード**が必要です（JS 修正＋正しい `resolve/main/` 配置）

### C. 訪問者に URL を伝える

- 例: `https://example.com/`  
- 推奨ブラウザ: Chrome / Edge（WebGPU）  
- モデル欠落や WebGPU 非対応時は、画面上の案内どおり **テンプレートエンジンで続行** できます

---

## GitHub Pages（Actions）で公開する

**軽量モデル（0.5B）** は CI が同一オリジン同梱します。  
**標準 1.5B（もともとの標準）** ほか TinySwallow / 3B / Gemma-JPN はゲートで選択可能 — Pages 上では **Hugging Face + IndexedDB** から取得（初回ダウンロード）。  
フル同梱が必要なら Netlify か `公開準備.bat` / `npm run fetch-model` / `:hq` / `:all`。

リポジトリ名がまだ決まっていない場合は、以下の `<repo>` を自分のリポジトリ名に置き換えてください（例: `digital-tattoo`）。

### 1. GitHub にリポジトリを作って push

1. GitHub で **New repository**（Public 推奨）  
2. ローカルで（初回のみ）:

```bash
git init
git add .
git commit -m "Initial commit: DIGITAL TATTOO"
git branch -M master
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin master
```

> `.github/workflows/pages.yml` が含まれていること。`public/models/` のバイナリは `.gitignore` 済みで問題ありません。

### 2. Pages のソースを GitHub Actions にする

1. リポジトリ **Settings** → **Pages**  
2. **Build and deployment** → **Source** で **GitHub Actions**

### 3. ワークフローの書き込み権限（初回だけ確認）

1. **Settings** → **Actions** → **General**  
2. **Workflow permissions** → **Read and write permissions** → **Save**

### 4. デプロイを待つ

- `master`（または `main`）への push、または **Actions** から **Deploy GitHub Pages** → **Run workflow**  
- 成功後の URL:

```text
https://<user>.github.io/<repo>/
```

例: `https://maruy.github.io/digital-tattoo/`

### 容量・制限（正直メモ）

| 項目 | 目安 |
|------|------|
| 公開サイトサイズ（既定のみ） | 公式上限 **1 GB**。既定構成 ≈ **840 MB** |
| 全パックデプロイ | ≈ **2.8 GB** → Pages 不可寄り。**Netlify 等を推奨** |
| デプロイ時間 | Pages は約 **10 分**でタイムアウトしうる |
| git の 100 MB/ファイル制限 | **リポジトリに重みを commit しない**前提 |
| 帯域 | ソフト上限 約 **100 GB/月** |

もし Pages デプロイが落ちる場合:

- 画面の **テンプレートエンジンで続行** で体験は可能  
- 代替: **Netlify** 等へ `dist/` をアップロード（`公開準備.bat`）  
- 高精度込みは Netlify / 自前ホスト向け（CI は軽量 0.5B のみ）
- 標準 1.5B のフル LLM も Netlify / ローカル（`npm run fetch-model`）

`vite.config.js` は GitHub Actions 上で自動的に `base: '/<repo>/'` になります。ローカル／Netlify では `base: './'`。上書きは環境変数 `VITE_BASE`。

---

## 要件（技術）

| 項目 | 内容 |
|------|------|
| Pages 既定 | `Qwen2.5-0.5B-Instruct`（MLC q4f16_1）— CI / シャード安全 |
| 標準モデル | `Qwen2.5-1.5B-Instruct`（MLC q4f16_1）— Netlify / ローカル推奨 |
| 軽量モデル | `Qwen2.5-0.5B-Instruct`（MLC q4f16_1）— 弱 GPU 向け（任意） |
| 高精度モデル | `Qwen2.5-3B-Instruct`（MLC q4f16_1）— 要VRAM・任意（Qwen Research） |
| ランタイム | `@mlc-ai/web-llm` **0.2.84** + **WebGPU**（Chrome / Edge 推奨） |
| 通信 | **プレイ中は外部ネットワーク不要**（同一オリジンの `models/` のみ） |
| 容量 | 既定 ≈ **840 MB** / 軽量 ≈ **280 MB** / 高精度 ≈ **1.7 GB** / 全部 ≈ **2.8 GB** |
| VRAM | 既定 ≈ **1.6 GB** / 軽量 ≈ **0.95 GB** / 高精度 ≈ **2.5 GB** |

## フォルダ構成

```
digital-tattoo/
├── 公開準備.bat            # 公開する人用（install → fetch → build → dist を開く）
├── .github/workflows/
│   └── pages.yml           # GitHub Pages（fetch-model → build → deploy）
├── index.html              # エントリ（尋問 UI）
├── js/
│   ├── app.js              # ゲームループ（00/01/02）
│   ├── llm.js              # 同一オリジン WebLLM ローダ（1.5B/0.5B/3B）
│   └── fallback.js         # テンプレートフォールバック
├── public/
│   └── models/             # ★ ビルドで dist/models にコピー（git ではバイナリ無視）
├── scripts/
│   ├── fetch-model.mjs
│   └── fetch-model.ps1
├── package.json
├── vite.config.js
└── dist/                   # 手動ホスト用ビルド成果物
```

## 動作の流れ（技術）

1. **AGENT-01/02 質問** — ORIGIN なし。Q&A 履歴＋仮説のみ  
2. **AGENT-00 回答** — ORIGIN＋質問 → 生出力 → **`clampYesNo` で「はい」「いいえ」強制**  
3. **議論** — 答えがはい／いいえの「なぜ」を 01 と 02 が交換。汚染度が上がると自信ある誤認が増える  
4. **正式推測** — 数ラウンドごと／オペレーター強制（上限なし・不正解でもゲーム継続）  

ORIGIN は **不変**。思考過程（プロンプト・文脈・クランプ）は毎回ログに公開される。

## WebGPU

- 必要: 最近の Chrome / Edge（WebGPU 有効）  
- 無い場合: ゲートで理由を表示 → 「テンプレートエンジンで続行」可能  

## ライセンス／モデル出典（二次配布・Web公開）

**結論（クリエイター向け・法的助言ではない）:**  
**既定 1.5B / 軽量 0.5B** は **Apache-2.0** なので、条件付きで Web ホストと同梱が許可されます。  
**高精度 3B** は **Qwen Research**（Apache ではない）— 同梱前に原文を確認してください。

| 部品 | ライセンス | 出典 |
|------|------------|------|
| アプリのコード・UI・文言（あなた／このリポの創作） | あなたが決める（第三者許諾不要） | このリポジトリ |
| `Qwen2.5-1.5B-Instruct` 重み（既定） | **Apache-2.0** | [Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) |
| MLC 量子化ビルド `…-1.5B-…-q4f16_1-MLC` | 上記ベースモデルの Apache-2.0 を継承 | [mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC) |
| `Qwen2.5-0.5B-Instruct` 重み（軽量） | **Apache-2.0** | [Qwen/Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) |
| MLC 量子化ビルド `…-0.5B-…-q4f16_1-MLC` | 上記ベースモデルの Apache-2.0 を継承 | [mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC) |
| `Qwen2.5-3B-Instruct` 重み（高精度・任意） | **Qwen Research** | [Qwen/Qwen2.5-3B-Instruct](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct) |
| MLC 量子化ビルド `…-3B-…-q4f16_1-MLC` | 上記ベースの Qwen Research を継承 | [mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC) |
| `@mlc-ai/web-llm` / MLC-LLM | **Apache-2.0** | [web-llm](https://github.com/mlc-ai/web-llm) · [mlc-llm](https://github.com/mlc-ai/mlc-llm) |
| WASM model lib | MLC 同系（Apache-2.0 扱い） | [binary-mlc-llm-libs](https://github.com/mlc-ai/binary-mlc-llm-libs)（WebLLM `v0_2_84` 互換） |

### 公開時にやること（ライセンス実務）

1. `dist/` 一式（`models/` 含む）をアップロードしてよい（**0.5B / 1.5B** は Apache-2.0）  
2. **`NOTICE`** と **`licenses/Apache-2.0.txt`** を `dist/` に含める（`public/` 経由でビルドにコピーされる）  
3. サイト上かクレジット欄で、少なくとも次を示す:  
   - モデル: Qwen2.5-1.5B-Instruct（および使用する場合 0.5B / 3B）— © Alibaba Cloud  
   - ランタイム: WebLLM / MLC — Apache-2.0  
4. **3B を同梱する場合**は Qwen Research 条件を満たすこと  
5. 「Qwen」「Alibaba Cloud」「MLC」等の**商標を、公式製品であるかのように勝手に使わない**  
6. モデルを「自分の独自学習成果」と偽らない／ライセンス表記を消さない  

> 注: Qwen2.5 の **3B / 72B** は Qwen Research。本作品の **既定 1.5B / 軽量 0.5B** は Apache-2.0 です。

詳細はリポジトリ直下および `public/` の `NOTICE` を参照。

---

## 付録: npm コマンド（上級者・ローカル確認用）

```bash
npm install
npm run fetch-model        # 既定 1.5B → public/models（ネット一度きり）
npm run fetch-model:lite   # 軽量 0.5B
npm run fetch-model:hq     # 高精度 3B
npm run fetch-model:all    # 全部
npm run verify-models      # resolve/main 配置と容量を確認
npm run build              # dist/ 生成（models もコピー）
npm run verify-models -- dist
npm run preview            # ビルド結果の確認用ローカルサーバ
npm run dev                # 開発用ホットリロード
```

Windows でモデル取得だけ行う場合: `.\scripts\fetch-model.ps1`（引数 `lite` / `hq` / `--all` 可）

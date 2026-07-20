# DIGITAL TATTOO — 幻覚の恐怖

ブラウザ内で動く **AI ハルシネーション・ホラー** アート。  
最初はユーザーが刻んだ定義（ORIGIN）に忠実な、流暢な日本語の AI。時間が経つと、文法は壊さず自信たっぷりに、捏造した細部・自己引用・ORIGIN との矛盾を語り始める。

**訪問者は URL を開くだけです。** アプリのダウンロードや Node.js・コマンド操作は不要です。

### 体験の核

1. AI が「私は誰ですか」と問う  
2. ユーザーが ORIGIN（役割・状況）を刻む — **以後不変・画面上部に常時表示**  
3. 高一貫性フェーズ：忠実な受領  
4. 独白＋対話が続くうちに一貫性（COH）が下がる — 虚偽の固有名詞、過去の誤発言の引用、過信  
5. 各ターンで **思考過程パネル** が開き、プロンプト・ORIGIN・記憶抜粋・温度・エンジン種別などを公開。最終発話のあと自動で畳まれ、クリックで再展開できる  

恐怖は視覚スパムではなく、**「完璧な日本語なのに、もう信じられない」** という意味のズレにある。汚染された文脈が見えること自体がホラーの一部。

## 育ちは文脈であり重み更新ではない

この作品は **継続学習・ファインチューニング・重み更新を一切しません**。

- モデルのパラメータは起動時に読み込まれるだけ（inference only）
- 「成長」「ドリフト」は UI 上のメタファー
- 実際に増えているのは **蓄積ログ・割り込み燃料・自己認識（belief）の汚染・プロンプトへの文脈汚染** と、一貫性低下に応じたドリフト指示／温度
- AI が「育った」ように見えるのは、同じ小さなモデルが汚れた文脈を読み続けているから

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
   - モデル取得（約 300 MB・初回のみネット必要）  
   - `dist/` への静的ビルド  
3. 終わると **`dist` フォルダ** がエクスプローラーで開きます

> この bat は「サイトを公開する人」専用です。訪問者は使いません。

#### 代わりにエージェント / 手動（上級者）

```bash
npm install
npm run fetch-model
npm run build
```

### B. `dist/` をホストへアップロードする

**GitHub を使う場合**は手動アップロード不要です。上の「GitHub Pages（Actions）」へ進んでください。

それ以外のホストでは、`dist/` **フォルダの中身すべて**（`index.html`・`assets/`・**`models/`** を含む）を、静的ホスティングの公開ルートへアップロードします。

| ホスト例 | やること |
|----------|----------|
| **Netlify** | サイト新規作成 → `dist` の中身をドラッグ＆ドロップ（または Git 連携で publish ディレクトリを `dist`） |
| **Cloudflare Pages** | Direct Upload、またはビルド出力を `dist` に設定 |
| **GitHub Pages** | **推奨:** 下の「GitHub Pages（Actions）」手順。手動なら `dist` を `gh-pages` / `docs` へ。CI では `base: /<repo>/`、ローカルは `./` |
| **S3 + CloudFront** | バケットに `dist` の中身を同期し、静的ウェブサイト配信 / CloudFront で公開 |
| **自前 VPS（nginx など）** | `dist` の中身をドキュメントルート（例: `/var/www/html`）へコピー |

**必須:** `dist/models/`（重み・WASM・`manifest.json`）を必ず含めること。無いと LLM は使えず、テンプレートエンジンへソフトフォールバックします。

**WebLLM のパス注意:** ランタイムは Hugging Face 互換の  
`models/<model-id>/resolve/main/mlc-chat-config.json`  
を同一オリジンから読みます（`npm run fetch-model` がその配置を作ります）。HF CDN には接続しません。

容量の目安: サイト一式 ≈ **300 MB 前後**（モデルが大半）。VRAM 目安 ≈ **950 MB**。

#### Netlify ドラッグ＆ドロップで再公開する場合

1. **`公開準備.bat` を再実行**（または `npm run prepare-publish`）して完全な `dist/` を作る  
2. Netlify に **`dist` の中身すべて**をアップロード（`models/` 含む・約 300 MB）  
3. `models` を抜いた / 途中で止めたアップロードでは、見た目は動いても LLM だけ 404 になります  
4. 既に公開済みで LLM だけ失敗している場合も、**フル再アップロード**が必要です（JS 修正＋正しい `resolve/main/` 配置）

### C. 訪問者に URL を伝える

- 例: `https://example.com/`  
- 推奨ブラウザ: Chrome / Edge（WebGPU）  
- モデル欠落や WebGPU 非対応時は、画面上の案内どおり **テンプレートエンジンで続行** できます

---

## GitHub Pages（Actions）で公開する

モデル（約 300 MB）は **git に入れません**。ワークフローがビルド時に `npm run fetch-model` で取得し、`dist/` ごと Pages に載せます。

リポジトリ名がまだ決まっていない場合は、以下の `<repo>` を自分のリポジトリ名に置き換えてください（例: `digital-tattoo`）。リモート未設定でもこの手順はそのまま使えます。

### 1. GitHub にリポジトリを作って push

1. GitHub で **New repository**（Public 推奨。Private でも Pages はプラン次第で可）  
2. ローカルで（初回のみ）:

```bash
git init
git add .
git commit -m "Initial commit: DIGITAL TATTOO"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

> `.github/workflows/pages.yml` が含まれていること。`public/models/` のバイナリは `.gitignore` 済みで問題ありません。

### 2. Pages のソースを GitHub Actions にする（クリック手順）

1. リポジトリページを開く  
2. **Settings**（設定）  
3. 左サイドバー **Pages**  
4. **Build and deployment** → **Source** で **GitHub Actions** を選ぶ  

### 3. ワークフローの書き込み権限（初回だけ確認）

1. 同じリポジトリの **Settings** → **Actions** → **General**  
2. 一番下の **Workflow permissions**  
3. **Read and write permissions** を選ぶ（または、このワークフローが `pages: write` できる状態にする）  
4. **Save**  

### 4. デプロイを待つ

- `main`（または `master`）への push、または **Actions** タブから **Deploy GitHub Pages** → **Run workflow**  
- 成功後の URL:

```text
https://<user>.github.io/<repo>/
```

例: ユーザー `maruy`・リポ `digital-tattoo` なら  
`https://maruy.github.io/digital-tattoo/`

Actions のデプロイジョブ出力にも `page_url` が出ます。

### 容量・制限（正直メモ）

| 項目 | 目安 |
|------|------|
| 公開サイトサイズ | 公式上限 **1 GB**。本作品 ≈ **300 MB** なので通常は収まる |
| デプロイ時間 | Pages は約 **10 分**でタイムアウト。モデル取得＋アップロードが長いと失敗しうる |
| git の 100 MB/ファイル制限 | **リポジトリに重みを commit しない**前提なので問題にならない（CI で取得） |
| 帯域 | ソフト上限 約 **100 GB/月**。アクセスが多いと制限の対象になりうる |

もし Pages デプロイがサイズ／時間で落ちる、またはモデル読み込みが失敗する場合:

- 画面の **テンプレートエンジンで続行**（ソフトフォールバック）で体験は可能  
- 代替: **Netlify** 等へ `dist/` をアップロード（`公開準備.bat`）  
- さらに重い資産が必要なら GitHub Releases ＋別ホスト、または Git LFS を検討（同一オリジン制約のため、単純な Release URL 直読みは本作品の設計と合わない）

`vite.config.js` は GitHub Actions 上で自動的に `base: '/<repo>/'` になります。ローカル／Netlify では従来どおり `base: './'` です。上書きは環境変数 `VITE_BASE`。

---

## 要件（技術）

| 項目 | 内容 |
|------|------|
| モデル | `Qwen2.5-0.5B-Instruct`（MLC q4f16_1）— 日本語可能な小型 Instruct |
| ランタイム | `@mlc-ai/web-llm` + **WebGPU**（Chrome / Edge 推奨） |
| 通信 | **プレイ中は外部ネットワーク不要**（同一オリジンの `models/` のみ） |
| 容量 | 重みおよそ **290–320 MB** + WASM およそ **5 MB**（合計 ≈ **300 MB**） |
| VRAM | およそ **950 MB** 目安 |

## フォルダ構成

```
digital-tattoo/
├── 公開準備.bat            # 公開する人用（install → fetch → build → dist を開く）
├── .github/workflows/
│   └── pages.yml           # GitHub Pages（fetch-model → build → deploy）
├── index.html              # エントリ（ターミナル UI）
├── js/
│   ├── app.js
│   ├── llm.js              # 同一オリジン WebLLM ローダ
│   └── fallback.js
├── public/
│   └── models/             # ★ ビルドで dist/models にコピー（git ではバイナリ無視）
├── scripts/
│   ├── fetch-model.mjs     # モデル取得（公開準備時のみネット）
│   └── fetch-model.ps1
├── package.json
├── vite.config.js          # base: CI では /<repo>/ 、他は ./
└── dist/                   # ← 手動ホスト用（ビルド成果物）/ Actions でも生成
```

## 動作の二系統

1. **ユーザー割り込み** — いつでも入力可。LLM（またはテンプレート）が ORIGIN＋汚れた記憶を読んで応答し、自己認識（belief）も更新する  
2. **定期独白／内省** — 時間が経つと自信ある虚偽・自己引用が増える。COH 低下に応じ温度とドリフト指示が上がる  

ORIGIN（最初の定義）は **不変**。思考過程（プロンプト・文脈・パラメータ）は毎回ログに公開される。

## WebGPU

- 必要: 最近の Chrome / Edge（WebGPU 有効）  
- 無い場合: ゲートで理由を表示 → 「テンプレートエンジンで続行」可能  

## ライセンス／モデル出典（二次配布・Web公開）

**結論（クリエイター向け・法的助言ではない）:**  
自分のアート／コード＋このモデル一式を Netlify 等へアップロードして公開することは、**条件付きで可（CONDITIONAL YES）**です。  
使うモデルは **Apache License 2.0** なので、商用・非商用の Web ホストと `dist/models/` への重み同梱が許可されます。公開時は下記の表記を残してください。

| 部品 | ライセンス | 出典 |
|------|------------|------|
| アプリのコード・UI・文言（あなた／このリポの創作） | あなたが決める（第三者許諾不要） | このリポジトリ |
| `Qwen2.5-0.5B-Instruct` 重み | **Apache-2.0** | [Qwen/Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) / [LICENSE](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE) |
| MLC 量子化ビルド `…-q4f16_1-MLC` | 上記ベースモデルの Apache-2.0 を継承（HF カードに別ライセンス無し） | [mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC) |
| `@mlc-ai/web-llm` / MLC-LLM | **Apache-2.0** | [web-llm](https://github.com/mlc-ai/web-llm) · [mlc-llm](https://github.com/mlc-ai/mlc-llm) |
| WASM model lib | MLC 同系（Apache-2.0 扱い） | [binary-mlc-llm-libs](https://github.com/mlc-ai/binary-mlc-llm-libs)（WebLLM `v0_2_84` 互換） |
| フォント | システムフォントのみ（外部フォント同梱なし） | — |
| `bg-floral.png` | 現状コードから未参照（デプロイ必須ではない） | ルートに残っている場合は自分の素材として扱う |

### 公開時にやること（Apache-2.0 の実務）

1. `dist/` 一式（`models/` 含む）をアップロードしてよい  
2. **`NOTICE`** と **`licenses/Apache-2.0.txt`** を `dist/` に含める（`public/` 経由でビルドにコピーされる）  
3. サイト上かクレジット欄で、少なくとも次を示す:  
   - モデル: Qwen2.5-0.5B-Instruct（© Alibaba Cloud）— Apache-2.0  
   - ランタイム: WebLLM / MLC — Apache-2.0  
4. 「Qwen」「Alibaba Cloud」「MLC」等の**商標を、公式製品であるかのように勝手に使わない**（出典記載としての言及は可）  
5. **禁止に近い注意:** モデルを「自分の独自学習成果」と偽らない／ライセンス表記を消さない。Apache-2.0 に「犯罪利用禁止」条項はないが、一般法・ホスト規約・展示規約は別途守ること  

> 注: Qwen2.5 の **3B / 72B** は別ライセンス（MAU 制限など）です。本作品の **0.5B** は Apache-2.0 です（[Qwen2.5 README](https://github.com/QwenLM/Qwen2.5)）。

詳細はリポジトリ直下および `public/` の `NOTICE` を参照。

---

## 付録: npm コマンド（上級者・ローカル確認用）

訪問者向けではありません。公開準備やローカル確認をする開発者向けです。

```bash
npm install
npm run fetch-model   # public/models へ取得（ネット一度きり）
npm run verify-models # resolve/main 配置と容量を確認
npm run build         # dist/ 生成（models もコピー）
npm run verify-models -- dist
npm run preview       # ビルド結果の確認用ローカルサーバ
npm run dev           # 開発用ホットリロード
```

Windows でモデル取得だけ行う場合: `.\scripts\fetch-model.ps1`

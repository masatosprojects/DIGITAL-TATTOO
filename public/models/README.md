# 同一オリジン WebLLM モデル（バイナリは gitignore）

ランタイムは **このフォルダ配下の同一オリジンパスだけ** から読み込みます。  
プレイ中に Hugging Face / CDN へは接続しません。

**育ちは文脈であり重み更新ではない** — 重みは読み取り専用の推論用アーティファクトです。

## モデル 2 種

| キー | モデル ID | 取得 | 容量目安 | VRAM |
|------|-----------|------|----------|------|
| **default（既定）** | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` | `npm run fetch-model` | ≈ **300 MB** | ≈ 950 MB |
| **plus（日本語プラス）** | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | `npm run fetch-model:plus` | ≈ **830 MB** | ≈ 1.6 GB |

両方: `npm run fetch-model:all` → 合計 ≈ **1.1 GB**（GitHub Pages の快適枠 1 GB を超えがち）。

UI で未配置のプラスはグレーアウトされ、`fetch-model:plus` の案内が出ます。

## 必須レイアウト（WebLLM）

`@mlc-ai/web-llm` はモデル URL に必ず `resolve/<branch>/` を付けます。  
そのため重みは次のパスに置きます（フラット配置ではない）:

```
models/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json
models/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json   # 任意
models/libs/*.wasm
```

`npm run fetch-model` / `fetch-model:plus` がこの配置を作成・移行します。

## 公開する人が用意する

リポジトリ直下の **`公開準備.bat`** をダブルクリック（既定 0.5B のみ）するか:

```bash
npm run fetch-model          # 既定のみ（Pages 向け）
npm run fetch-model:plus     # プラスのみ追加
npm run fetch-model:all      # 両方
npm run verify-models
npm run build
npm run verify-models -- dist
```

`vite build` により内容は **`dist/models/`** へコピーされます。  
静的ホストへは **`dist/` 一式**（この `models/` を含む）をアップロードしてください。

バイナリは git にコミットせず、デプロイ成果物にだけ含めます。

**Netlify drag-drop:** `dist` を丸ごと（models 付き）再アップロードすること。models 無しデプロイでは LLM が 404 になります。

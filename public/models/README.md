# 同一オリジン WebLLM モデル（バイナリは gitignore）

ランタイムは **このフォルダ配下の同一オリジンパスだけ** から読み込みます。  
プレイ中に Hugging Face / CDN へは接続しません。

**育ちは文脈であり重み更新ではない** — 重みは読み取り専用の推論用アーティファクトです。

## 必須レイアウト（WebLLM）

`@mlc-ai/web-llm` はモデル URL に必ず `resolve/<branch>/` を付けます。  
そのため重みは次のパスに置きます（フラット配置ではない）:

```
models/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json
models/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/params_shard_*.bin
models/libs/*.wasm
```

`npm run fetch-model` がこの配置を作成・移行します。

## 公開する人が用意する

リポジトリ直下の **`公開準備.bat`** をダブルクリックするか:

```bash
npm run fetch-model
npm run verify-models
npm run build
npm run verify-models -- dist
```

`vite build` により内容は **`dist/models/`** へコピーされます。  
静的ホストへは **`dist/` 一式**（この `models/` を含む・約 300 MB）をアップロードしてください。

| パス | おおよそ |
|------|----------|
| `Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/` | ~290–320 MB |
| `libs/*.wasm` | ~5 MB |
| `manifest.json` | ごく小さい |

合計 ≈ **300 MB**。実行時 VRAM ≈ **950 MB**。

バイナリは git にコミットせず、デプロイ成果物にだけ含めます。

**Netlify drag-drop:** `dist` を丸ごと（models 付き）再アップロードすること。models 無しデプロイでは LLM が 404 になります。

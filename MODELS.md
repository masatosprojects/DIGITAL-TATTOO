# モデルカタログ（オフライン WebLLM）

WebLLM **0.2.84** 互換の MLC ビルド。  
ランタイムは **同一オリジン優先**。未同梱時は **Hugging Face + IndexedDB**（`cacheBackend: "indexeddb"`）で取得可（`remoteOk`）。

## ランキング（ゲート表示順）

| 順位 | key | model_id | ディスク | VRAM目安 | 備考 | usable |
|------|-----|----------|----------|----------|------|--------|
| 1 | `hq` | `Qwen2.5-3B-Instruct-q4f16_1-MLC` | ≈**1.7 GB** | ≈**2.5 GB** | Qwen 高精度 | **maybe** |
| 2 | `gemma-jpn` | `gemma-2-2b-jpn-it-q4f16_1-MLC` | ≈**1.4 GB** | ≈**1.9 GB** | JP寄り · **system ロール不可** | **maybe** |
| 3 | `swallow` | `TinySwallow-1.5B-Instruct-q4f32_1-MLC` | ≈**830 MB** | ≈**1.9 GB** | **JP特化**（Sakana HF `SakanaAI/TinySwallow-1.5B-Instruct-q4f32_1-MLC` · q4f32 WASM=`Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm`） | **yes** |
| 4 | `default` | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | ≈**840 MB** | ≈**1.6 GB** | **★ 推奨 · もともとの標準** | **yes** |
| 5 | `lite` | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` | ≈**280 MB** | ≈**0.95 GB** | Pages CI 同梱 · 品質劣る | **yes** |

### usable / 選び方

| key | 判定 | 理由 |
|-----|------|------|
| `default` (Qwen 1.5B) | **yes** | **推奨（もともとの標準）**。Pages でも HF+IndexedDB で選択可。 |
| `swallow` | **yes** | 日本語特化。VRAM は 1.5B q4f16 よりやや高め（q4f32）。 |
| `lite` | **yes** | 品質劣る。Pages CI 同梱用フォールバック。 |
| `hq` | **maybe** | 最良級だが VRAM ≈2.5 GB。統合GPUでは厳しい。 |
| `gemma-jpn` | **maybe** | WebLLM 公式。system 非対応 → 尋問プロンプトは user 文へ折り込み（弱めになり得る）。 |
| 7B 級 | **no** | ブラウザ前提から除外。 |

**既定:** 全エージェント **標準 Qwen 1.5B**。Pages で「1.5B できない」は廃止 — 未同梱でもゲートから選択し HF 取得。

## デプロイ

| 構成 | GitHub Pages |
|------|--------------|
| CI 同梱 | **lite (0.5B)** のみ |
| ゲート選択 | 1.5B / Swallow / 3B / Gemma-JPN — 未同梱なら **初回は HF から取得** |

```bash
npm run fetch-model:pages      # 0.5B（CI）
npm run fetch-model            # 標準 1.5B
npm run fetch-model:swallow    # TinySwallow（任意・同梱用）
npm run fetch-model:gemma-jpn  # Gemma-JPN（任意）
npm run fetch-model:hq         # 3B
npm run fetch-model:extras     # swallow + gemma-jpn
```

レイアウト: `public/models/<id>/resolve/main/…` + `public/models/libs/<wasm>`.

## Gate DOM

- `#gateAgentAssign` — エージェント00/01/02 ごとのモデルボックス（`listModels()`）
- 推奨タグ = `default` · JP特化タグ = `swallow` / `gemma-jpn`

このファイルと `scripts/fetch-model.mjs` / `js/llm.js` のカタログを同期すること。

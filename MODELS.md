# モデルカタログ（オフライン WebLLM）

WebLLM **0.2.84** 互換の MLC ビルド（`mlc-ai/*-q4f16_1-MLC`）。  
ランタイムは同一オリジン `models/<id>/resolve/main/` のみ — **プレイ中の外部ネットはゼロ**。

## ランキング（知能・日本語品質）

| 順位 | key | model_id | ディスク | VRAM目安 | 日本語 | usable | 既定 |
|------|-----|----------|----------|----------|--------|--------|------|
| 1 | `hq` | `Qwen2.5-3B-Instruct-q4f16_1-MLC` | ≈**1.7 GB** | ≈**2.5 GB** | ★★★ 最も自然 | **maybe** | — |
| 2 | `default` | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | ≈**840 MB** | ≈**1.6 GB** | ★★ 実用十分 | **yes** | **★ CI/推奨** |
| 3 | `lite` | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` | ≈**280 MB** | ≈**0.95 GB** | ★ 短文向き | **yes** | 弱GPU用 |

### usable の正直評価

| key | 判定 | 理由 |
|-----|------|------|
| `default` (1.5B) | **yes** | 一般的な WebGPU ノート（専用GPU / 余裕のある iGPU）で安定。Pages 1 GB ソフト枠内。 |
| `lite` (0.5B) | **yes** | 弱GPUでも動きやすい。ただし質問・議論の日本語は崩れやすい。 |
| `hq` (3B) | **maybe** | 品質は最良候補だが ≈2.5 GB VRAM・≈1.7 GB 配信。統合GPUや Pages では現実的でないことが多い。 |
| 7B 級 | **no** | WebLLM にビルドはあるが ≈5 GB VRAM・数 GB 配信 → 本作品のブラウザ前提から除外。 |

### 日本語流暢さの限界（期待値を下げる）

- **0.5B**: はい／いいえや短い定型は可。自由な議論・仮説更新は英語混入や意味崩れが増える。
- **1.5B**: 尋問ゲーム用途では「十分に読める日本語」。長文の論理一貫性や固有表現はまだ弱い。
- **3B**: 1.5B より明らかに自然で指示追従も良いが、クラウド級の流暢さではない。ブラウザ小型量子化の上限に近い。

**既定を 1.5B にした理由:** 「実際に使える中で最も賢い」＝ 3B は多くのユーザーで VRAM/容量が厳しいため、推奨デフォルトは 1.5B。0.5B は軽量オプションとして残す。

### ライセンス

| サイズ | ライセンス | 二次配布メモ |
|--------|------------|--------------|
| 0.5B / 1.5B | **Apache-2.0** | Netlify 等への同梱は条件付きで可（NOTICE 維持） |
| 3B (`hq`) | **Qwen Research** | Apache ではない。商用・再配布条件を必ず原文確認。 |

## デプロイどれを載せるか

| 構成 | サイズ | GitHub Pages | 推奨ホスト |
|------|--------|--------------|------------|
| **default のみ (1.5B)** | ≈840 MB | **OK（CI 既定）** | Pages / Netlify |
| lite 追加 | +≈280 MB ≈1.1 GB | きつめ・超過しやすい | Netlify |
| hq 追加 | +≈1.7 GB | **不可寄り** | Netlify / 自前 |
| **全パック** | ≈**2.8 GB** | **不可** | Netlify / 自前のみ |

複数の大型モデルを Pages に載せないこと。CI は **default のみ**。

## `js/llm.js` — 使う API

```js
import {
  listModels,              // → ModelInfo[]（rank 昇順）
  listModelAvailability,   // → + available / reason
  resolveModel,
  getDefaultModelKey,      // "default"
  loadModel,               // ★ 推奨
  createLlmQueue,
  hasWebGPU,
  MODELS,
  MODEL_CATALOG,
  STORAGE_KEY,
} from "./llm.js";

const catalog = await listModelAvailability();
// 未配置 → available:false・UI で無効化

const { engine, model } = await loadModel("default", {
  onProgress: ({ text, progress }) => {},
  prevEngine: engineRef.current,
});
```

`ModelInfo` フィールド: `key`, `rank`, `label`, `sizeMB`, `vramMB`, `minVramHint`, `usable`, `jpQuality`, `license`, `isDefault?`.

選択キーは `STORAGE_KEY`（`digital-tattoo-model`）に `"default"` | `"lite"` | `"hq"`。  
旧 `"plus"` は 1.5B として `"default"` にマップ。

## Fetch（公開準備）

```bash
npm run fetch-model          # default 1.5B（必須・Pages）
npm run fetch-model:lite     # 0.5B
npm run fetch-model:hq       # 3B
npm run fetch-model:all      # 全部 ≈2.8 GB
npm run verify-models        # default 必須・他はあれば検証
```

レイアウト: `public/models/<id>/resolve/main/mlc-chat-config.json` + `public/models/libs/<wasm>`.

## Gate DOM

`#gateModelPick` は `listModels()` から動的生成。未配置は disabled + サイズ表示。

## `app.js`

ゲームループは `app.js` 所有。モデルは上記 API のみ。yes/no クランプと単一エンジン設計は維持。

このファイルと `scripts/fetch-model.mjs` / `js/llm.js` のカタログを同期すること。

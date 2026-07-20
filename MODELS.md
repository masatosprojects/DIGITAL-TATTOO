# モデルカタログ（オフライン WebLLM）

WebLLM **0.2.84** 互換の MLC ビルド（`mlc-ai/*-q4f16_1-MLC`）。  
ランタイムは **同一オリジン優先**。GitHub Pages で未同梱の 1.5B/3B は **Hugging Face + IndexedDB**（`cacheBackend: "indexeddb"`）で取得可。

## ランキング（知能・日本語品質）

| 順位 | key | model_id | ディスク | VRAM目安 | 日本語 | usable | 既定 |
|------|-----|----------|----------|----------|--------|--------|------|
| 1 | `hq` | `Qwen2.5-3B-Instruct-q4f16_1-MLC` | ≈**1.7 GB** | ≈**2.5 GB** | ★★★ 最も自然 | **maybe** | — |
| 2 | `default` | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | ≈**840 MB** | ≈**1.6 GB** | ★★ 実用十分 | **yes** | **★ Netlify/ローカル推奨** |
| 3 | `lite` | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` | ≈**280 MB** | ≈**0.95 GB** | ★ 短文向き | **yes** | **★ GitHub Pages CI** |

### usable の正直評価

| key | 判定 | 理由 |
|-----|------|------|
| `default` (1.5B) | **yes** | **推奨**。Pages では同一オリジン未同梱時 **HF+IndexedDB** で取得。Netlify/ローカルは `fetch-model` で同梱可。 |
| `lite` (0.5B) | **yes** | **品質劣る**。Pages CI 同梱用。弱GPU向けフォールバック。 |
| `hq` (3B) | **maybe** | 最良候補だが ≈2.5 GB VRAM。Pages では HF 取得可・統合GPUでは厳しい。 |
| 7B 級 | **no** | WebLLM にビルドはあるが ≈5 GB VRAM・数 GB 配信 → 本作品のブラウザ前提から除外。 |

### 日本語流暢さの限界（期待値を下げる）

- **0.5B**: はい／いいえや短い定型は可。自由な議論・仮説更新は英語混入や意味崩れが増える。
- **1.5B**: 尋問ゲーム用途では「十分に読める日本語」。長文の論理一貫性や固有表現はまだ弱い。
- **3B**: 1.5B より明らかに自然で指示追従も良いが、クラウド級の流暢さではない。ブラウザ小型量子化の上限に近い。

**既定の使い分け:** **標準 1.5B を推奨**（実用日本語）。GitHub Pages でも **Hugging Face + IndexedDB** で 1.5B / 3B を選択可（初回ダウンロードあり。CI は容量のため 0.5B のみ同一オリジン同梱）。0.5B は品質が落ちるフォールバック。

### ライセンス

| サイズ | ライセンス | 二次配布メモ |
|--------|------------|--------------|
| 0.5B / 1.5B | **Apache-2.0** | Netlify 等への同梱は条件付きで可（NOTICE 維持） |
| 3B (`hq`) | **Qwen Research** | Apache ではない。商用・再配布条件を必ず原文確認。 |

## エンジンモード（マルチエンジン）

ゲート UI で選択。選択キーは `ENGINE_MODE_KEY`（`digital-tattoo-engine-mode`）。

| mode id | UI ラベル | エンジン数 | ディスク | VRAM 目安 | 備考 |
|---------|-----------|------------|----------|-----------|------|
| `triple-1.5` | 実験: 1.5B×3同時 | **3** | **1.5B を1セットのみ** | ≈**4 GB+**（1.5B×3） | 実験。タブ落ちあり得る |
| `switch-1` | 推奨: 単一エンジン切替 | **1** | 選んだモデル1つ | モデル表どおり | **最も安全・推奨** |
| `strong-weak` | 00強+01/02弱 | **2** | 1.5B + 0.5B | ≈1.6+0.95 GB | 両方のファイルが必要 |

### `triple-1.5` が意味すること（正直）

- **やること:** 同じ `Qwen2.5-1.5B-Instruct-…` の重みファイルを、**ランタイムで WebLLM エンジンを3つ**立ち上げる。  
  AGENT-00 → engine A、AGENT-01 → B、AGENT-02 → C。
- **やらないこと:** ディスクに重みを3コピーしない。`fetch-model` を3回する必要はない。
- **成功時:** 各エージェントが独立エンジン。ゲームループが許す範囲で真の並列推論が可能（現状のループは主に逐次だが、エンジン間の待ち行列は分離）。
- **失敗時:** 途中まで載ったエンジンはすべて unload。メッセージで **switch-1** か **strong-weak** を案内。ゲートは安全側（単一）に寄せられる。
- **現実:** 多くのノート PC / 統合 GPU では VRAM 不足でクラッシュしやすい。専用 GPU で余裕があるときだけ試す実験パス。

### `switch-1`（推奨）

エンジンは1つ。話者ごとの差は **システムプロンプト／役割** で切替（モデル重みは共有）。VRAM と安定性が最良。

### `strong-weak`

- AGENT-00 = 1.5B（強）
- AGENT-01 / 02 = 0.5B（弱・共有エンジン）
- ディスクに `default` と `lite` の両方が必要（`npm run fetch-model` + `fetch-model:lite`）

## デプロイどれを載せるか

| 構成 | サイズ | 最大シャード | GitHub Pages | 推奨ホスト |
|------|--------|--------------|--------------|------------|
| **lite のみ (0.5B)** | ≈280 MB | ≈**65 MB** | **OK（CI 既定）** | **Pages** |
| **default のみ (1.5B)** | ≈840 MB | ≈**111 MB** | **不可寄り**（Cache.add network error） | **Netlify / ローカル** |
| lite + default | ≈1.1 GB | 111 MB | 不可 | Netlify |
| hq 追加 | +≈1.7 GB | 大 | **不可** | Netlify / 自前 |
| **全パック** | ≈**2.8 GB** | 大 | **不可** | Netlify / 自前のみ |

**重要:** 1.5B の `params_shard_0.bin` ≈111 MB は Pages の目安 100 MB/ファイルを超え、WebLLM の `Cache.add()` が network error になりやすい。CI は **`npm run fetch-model:pages`（= lite）** のみ。フル LLM が必要なら Netlify か `npm run fetch-model` のローカル。

キャッシュは WebLLM `cacheBackend: "indexeddb"`（Cache API の Cache.add を回避）。

## `js/llm.js` — 使う API

```js
import {
  listModels,
  listModelAvailability,
  listEngineModes,
  resolveModel,
  getDefaultModelKey,
  getSelectedEngineMode,
  setSelectedEngineMode,
  loadModel,
  createEngine,
  loadTripleEngines,
  loadStrongWeakEngines,
  loadSwitchEngine,
  generateWithEngine,
  createLlmQueue,
  createAgentLlmRouter,
  hasWebGPU,
  MODELS,
  MODEL_CATALOG,
  STORAGE_KEY,
  ENGINE_MODE_KEY,
} from "./llm.js";

const { engines, agentMap } = await loadTripleEngines("default", ({ text, progress }) => {});
// engines.A/B/C — same on-disk weights, three runtimes
const router = createAgentLlmRouter(agentMap);
await router.chat("01", messages, { onDelta, stream: true });
```

`ModelInfo` フィールド: `key`, `rank`, `label`, `sizeMB`, `vramMB`, `minVramHint`, `usable`, `jpQuality`, `license`, `isDefault?`.

選択キーは `STORAGE_KEY`（`digital-tattoo-model`）に `"default"` | `"lite"` | `"hq"`。  
旧 `"plus"` は 1.5B として `"default"` にマップ。

## Fetch（公開準備）

```bash
npm run fetch-model:pages    # 0.5B のみ（GitHub Pages CI 既定）
npm run fetch-model          # default 1.5B（Netlify / ローカル）
npm run fetch-model:lite     # 0.5B（明示）
npm run fetch-model:hq       # 3B
npm run fetch-model:all      # 全部 ≈2.8 GB（公開準備.bat）
npm run verify-models        # default 必須・他はあれば検証
```

レイアウト: `public/models/<id>/resolve/main/mlc-chat-config.json` + `public/models/libs/<wasm>`.

## Gate DOM

- `#gateModePick` — エンジンモード（triple / switch / strong-weak）
- `#gateModeWarn` — triple などの警告文
- `#gateModelPick` — `switch-1` 時のみモデル選択（`listModels()`）

未配置は disabled。triple は 1.5B がローカルにあるときだけ有効。

## `app.js`

ゲームループは `app.js` 所有。モードに応じて 00/01/02 を `createAgentLlmRouter` 経由で正しいエンジンへ。  
思考パネルに `engine A|B|C · model_id` を表示。yes/no クランプと 3-panel UI・同一オリジンは維持。

このファイルと `scripts/fetch-model.mjs` / `js/llm.js` のカタログを同期すること。

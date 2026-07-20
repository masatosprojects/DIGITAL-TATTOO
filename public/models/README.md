# 同一オリジン WebLLM モデル（バイナリは gitignore）

ランタイムは **このフォルダ配下の同一オリジンパスだけ** から読み込みます。  
プレイ中に Hugging Face / CDN へは接続しません。

**育ちは文脈であり重み更新ではない** — 重みは読み取り専用の推論用アーティファクトです。

詳細な順位・流暢さ・Pages 警告はリポ直下の [`MODELS.md`](../../MODELS.md) を参照。

## カタログ（知能順）

| キー | モデル ID | 取得 | 容量目安 | VRAM | usable |
|------|-----------|------|----------|------|--------|
| **hq** | `Qwen2.5-3B-Instruct-q4f16_1-MLC` | `npm run fetch-model:hq` | ≈ **1.7 GB** | ≈ 2.5 GB | maybe |
| **default（既定）** | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | `npm run fetch-model` | ≈ **840 MB** | ≈ 1.6 GB | yes |
| **lite** | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` | `npm run fetch-model:lite` | ≈ **280 MB** | ≈ 0.95 GB | yes |

全部: `npm run fetch-model:all` → ≈ **2.8 GB**（GitHub Pages 不可寄り → Netlify / 自前）。

UI で未配置モデルはグレーアウトされます。

## 必須レイアウト（WebLLM）

```
models/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json   # 既定
models/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/…                    # 任意
models/Qwen2.5-3B-Instruct-q4f16_1-MLC/resolve/main/…                      # 任意
models/libs/*.wasm
```

## 公開する人が用意する

```bash
npm run fetch-model          # 既定 1.5B（Pages / CI）
npm run fetch-model:lite     # 軽量 0.5B
npm run fetch-model:hq       # 高精度 3B
npm run fetch-model:all      # 全部
npm run verify-models
npm run build
```

バイナリは git にコミットせず、デプロイ成果物にだけ含めます。

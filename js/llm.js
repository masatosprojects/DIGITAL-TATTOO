/**
 * Same-origin WebLLM loader. No CDN / no remote model URLs at runtime.
 * Weights are inference-only — no training / no parameter updates.
 */

import { CreateMLCEngine } from "@mlc-ai/web-llm";

/** Keep in sync with scripts/fetch-model.mjs */
export const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
export const MODEL_WASM = "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm";

/**
 * WebLLM's cleanModelUrl() ALWAYS appends `resolve/<branch>/` unless the
 * model URL already matches `.+/resolve/.+/`. Hugging Face hosts use that
 * shape; for same-origin static files we mirror it on disk under
 * `models/<id>/resolve/main/` so production never hits the HF CDN.
 */
export const MODEL_HF_COMPAT_PREFIX = "resolve/main/";

function modelsBase() {
  // Prefer Vite BASE_URL (`/<repo>/` on GitHub Pages CI, else `./`) so nested
  // project URLs like https://user.github.io/repo/ resolve models correctly.
  const viteBase = import.meta.env.BASE_URL || "./";
  return new URL("models/", new URL(viteBase, window.location.href)).href;
}

/** Absolute same-origin base where mlc-chat-config.json and shards live. */
export function modelWeightsBase() {
  return modelsBase() + MODEL_ID + "/" + MODEL_HF_COMPAT_PREFIX;
}

export function localAppConfig() {
  const base = modelsBase();
  return {
    // Cache same-origin fetches in the browser; never points at Hugging Face at runtime.
    cacheBackend: "cache",
    model_list: [
      {
        // Must already end with resolve/<branch>/ so cleanModelUrl does not append again.
        model: modelWeightsBase(),
        model_id: MODEL_ID,
        model_lib: base + "libs/" + MODEL_WASM,
        low_resource_required: true,
        vram_required_MB: 945,
        required_features: ["shader-f16"],
        overrides: {
          context_window_size: 2048,
        },
      },
    ],
  };
}

export function hasWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/** Probe that local artifacts exist (same path WebLLM will request). */
export async function probeLocalModel() {
  const configUrl = modelWeightsBase() + "mlc-chat-config.json";
  const wasmUrl = modelsBase() + "libs/" + MODEL_WASM;
  try {
    const [c, w] = await Promise.all([
      fetch(configUrl, { method: "GET", cache: "no-cache" }),
      fetch(wasmUrl, { method: "HEAD", cache: "no-cache" }),
    ]);
    if (!c.ok || !w.ok) {
      return {
        ok: false,
        reason:
          "ローカルモデルが見つかりません（models/…/resolve/main/）。`npm run fetch-model` のあと再読み込みしてください。",
      };
    }
    const ct = (c.headers.get("content-type") || "").toLowerCase();
    const body = await c.text();
    // Static hosts may SPA-fallback missing paths to index.html (200 HTML).
    if (ct.includes("text/html") || !body.includes("model_type")) {
      return {
        ok: false,
        reason:
          "モデル設定が JSON ではありません（配置不足の可能性）。公開準備.bat で dist/models を作り直してください。",
      };
    }
    return { ok: true, configUrl, wasmUrl };
  } catch (e) {
    return {
      ok: false,
      reason: "ローカルモデルの確認に失敗しました: " + (e && e.message ? e.message : String(e)),
    };
  }
}

/**
 * @param {(p: { text: string, progress: number }) => void} onProgress
 * @returns {Promise<import("@mlc-ai/web-llm").MLCEngineInterface>}
 */
export async function createLocalEngine(onProgress) {
  const engine = await CreateMLCEngine(MODEL_ID, {
    appConfig: localAppConfig(),
    initProgressCallback: (report) => {
      const progress = typeof report.progress === "number" ? report.progress : 0;
      const text = report.text || "モデルを読み込み中…";
      if (onProgress) onProgress({ text, progress });
    },
  });
  return engine;
}

/** Serialize LLM calls — WebLLM is single-flight per engine. */
export function createLlmQueue(engineRef) {
  let chain = Promise.resolve();

  async function chat(messages, opts = {}) {
    const run = async () => {
      const engine = engineRef.current;
      if (!engine) throw new Error("LLM engine not ready");
      const reply = await engine.chat.completions.create({
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.max_tokens ?? 120,
        top_p: opts.top_p ?? 0.9,
      });
      const text = reply?.choices?.[0]?.message?.content;
      return String(text || "").trim();
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  return { chat };
}

export function driftTemperature(level) {
  // 0..3 → coherence collapse / confident hallucination
  return Math.min(1.35, 0.35 + level * 0.28);
}

export function driftLabel(level) {
  return ["忠実", "軽微な補完", "自信ある逸脱", "過信ハルシネーション"][level] || "ドリフト";
}

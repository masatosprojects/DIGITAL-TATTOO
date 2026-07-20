/**
 * Same-origin WebLLM loader. No CDN / no remote model URLs at runtime.
 * Weights are inference-only — no training / no parameter updates.
 *
 * Public API (game / gate should use these):
 *   listModels()              — catalog (default + plus)
 *   resolveModel(idOrKey)     — look up by key ("default"|"plus") or full model_id
 *   getSelectedModelKey() / setSelectedModelKey(key)
 *   probeModel / isModelAvailable / listModelAvailability
 *   loadModel(idOrKey, opts)  — unload previous, load selected, persist preference
 *   createLlmQueue(engineRef)
 *
 * Keep catalog in sync with scripts/fetch-model.mjs (web-llm 0.2.84).
 * See MODELS.md for deploy sizes and gate wiring notes.
 */

import { CreateMLCEngine } from "@mlc-ai/web-llm";

export const STORAGE_KEY = "digital-tattoo-model";

/**
 * WebLLM's cleanModelUrl() ALWAYS appends `resolve/<branch>/` unless the
 * model URL already matches `.+/resolve/.+/`. Same-origin files live under
 * `models/<id>/resolve/main/` — never Hugging Face at runtime.
 */
export const MODEL_HF_COMPAT_PREFIX = "resolve/main/";

/** @typedef {{
 *   key: "default" | "plus",
 *   label: string,
 *   shortLabel: string,
 *   id: string,
 *   wasm: string,
 *   vramMB: number,
 *   approxMB: number,
 *   hint: string,
 *   isDefault?: boolean,
 * }} ModelInfo */

/** @type {Record<"default"|"plus", ModelInfo>} */
export const MODELS = {
  default: {
    key: "default",
    label: "標準 (0.5B)",
    shortLabel: "標準",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 945,
    approxMB: 300,
    hint: "高速・既定。GitHub Pages 向け。",
    isDefault: true,
  },
  plus: {
    key: "plus",
    label: "日本語プラス (1.5B)",
    shortLabel: "プラス",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 1630,
    approxMB: 830,
    hint: "より自然な日本語。要 npm run fetch-model:plus（約 830 MB）。",
  },
};

/** @deprecated prefer resolveModel / getActiveModel().id */
export const MODEL_ID = MODELS.default.id;
/** @deprecated prefer getActiveModel().wasm */
export const MODEL_WASM = MODELS.default.wasm;

/** Ordered catalog for UI pickers. */
export function listModels() {
  return [MODELS.default, MODELS.plus];
}

/**
 * Resolve by short key (`default`|`plus`) or full WebLLM model_id.
 * @param {string} [idOrKey]
 * @returns {ModelInfo | null}
 */
export function resolveModel(idOrKey) {
  if (!idOrKey) return null;
  if (idOrKey === "default" || idOrKey === "plus") return MODELS[idOrKey];
  for (const m of listModels()) {
    if (m.id === idOrKey) return m;
  }
  return null;
}

export function modelsBase() {
  const viteBase = import.meta.env.BASE_URL || "./";
  return new URL("models/", new URL(viteBase, window.location.href)).href;
}

export function getSelectedModelKey() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "plus" || v === "default") return v;
  } catch (_) {
    /* private mode */
  }
  return "default";
}

export function setSelectedModelKey(key) {
  const resolved = resolveModel(key);
  const k = resolved ? resolved.key : "default";
  try {
    localStorage.setItem(STORAGE_KEY, k);
  } catch (_) {
    /* ignore */
  }
  return k;
}

export function getActiveModel() {
  return MODELS[getSelectedModelKey()] || MODELS.default;
}

/** Absolute same-origin base where mlc-chat-config.json and shards live. */
export function modelWeightsBase(model = getActiveModel()) {
  const m = typeof model === "string" ? resolveModel(model) || getActiveModel() : model;
  return modelsBase() + m.id + "/" + MODEL_HF_COMPAT_PREFIX;
}

export function localAppConfig(model = getActiveModel()) {
  const m = typeof model === "string" ? resolveModel(model) || getActiveModel() : model;
  const base = modelsBase();
  return {
    cacheBackend: "cache",
    model_list: [
      {
        model: modelWeightsBase(m),
        model_id: m.id,
        model_lib: base + "libs/" + m.wasm,
        low_resource_required: true,
        vram_required_MB: m.vramMB,
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

/**
 * @param {ModelInfo | string} modelOrKey
 * @returns {Promise<{ ok: boolean, model: ModelInfo, reason?: string, configUrl?: string, wasmUrl?: string }>}
 */
export async function probeModel(modelOrKey) {
  const model =
    typeof modelOrKey === "string" ? resolveModel(modelOrKey) : modelOrKey;
  if (!model) {
    return {
      ok: false,
      model: MODELS.default,
      reason: "不明なモデル指定です。",
    };
  }
  const configUrl = modelWeightsBase(model) + "mlc-chat-config.json";
  const wasmUrl = modelsBase() + "libs/" + model.wasm;
  try {
    const [c, w] = await Promise.all([
      fetch(configUrl, { method: "GET", cache: "no-cache" }),
      fetch(wasmUrl, { method: "HEAD", cache: "no-cache" }),
    ]);
    if (!c.ok || !w.ok) {
      return {
        ok: false,
        model,
        reason:
          model.key === "plus"
            ? "日本語プラス用ファイルがありません。公開者が `npm run fetch-model:plus` を実行してください。"
            : "ローカルモデルが見つかりません（models/…/resolve/main/）。`npm run fetch-model` のあと再読み込みしてください。",
      };
    }
    const ct = (c.headers.get("content-type") || "").toLowerCase();
    const body = await c.text();
    if (ct.includes("text/html") || !body.includes("model_type")) {
      return {
        ok: false,
        model,
        reason:
          "モデル設定が JSON ではありません（配置不足の可能性）。公開準備.bat で dist/models を作り直してください。",
      };
    }
    return { ok: true, model, configUrl, wasmUrl };
  } catch (e) {
    return {
      ok: false,
      model,
      reason: "ローカルモデルの確認に失敗しました: " + (e && e.message ? e.message : String(e)),
    };
  }
}

/** @param {string} idOrKey */
export async function isModelAvailable(idOrKey) {
  const r = await probeModel(idOrKey);
  return r.ok;
}

/**
 * Availability for every catalog entry (for gate radio enable/disable).
 * @returns {Promise<Array<ModelInfo & { available: boolean, reason?: string }>>}
 */
export async function listModelAvailability() {
  const probes = await Promise.all(listModels().map((m) => probeModel(m)));
  return probes.map((p) => ({
    ...p.model,
    available: p.ok,
    reason: p.ok ? undefined : p.reason,
  }));
}

/** @deprecated prefer listModelAvailability() */
export async function probeAllModels() {
  const [defaultProbe, plusProbe] = await Promise.all([
    probeModel(MODELS.default),
    probeModel(MODELS.plus),
  ]);
  return { default: defaultProbe, plus: plusProbe };
}

/** @deprecated use probeModel(getActiveModel()) */
export async function probeLocalModel() {
  return probeModel(getActiveModel());
}

/**
 * Best-effort unload (GPU / cache cleanup before switch).
 * @param {import("@mlc-ai/web-llm").MLCEngineInterface | null | undefined} engine
 */
export async function unloadEngine(engine) {
  if (!engine) return;
  try {
    if (typeof engine.unload === "function") await engine.unload();
  } catch (_) {
    /* best-effort */
  }
}

/**
 * Create engine for a model (does not persist preference by itself).
 *
 * @param {(p: { text: string, progress: number }) => void} [onProgress]
 * @param {ModelInfo | string} [model]
 * @param {import("@mlc-ai/web-llm").MLCEngineInterface | null} [prevEngine]
 * @returns {Promise<import("@mlc-ai/web-llm").MLCEngineInterface>}
 */
export async function createLocalEngine(onProgress, model = getActiveModel(), prevEngine = null) {
  const m = typeof model === "string" ? resolveModel(model) : model;
  if (!m) throw new Error("Unknown model: " + String(model));
  await unloadEngine(prevEngine);
  return CreateMLCEngine(m.id, {
    appConfig: localAppConfig(m),
    initProgressCallback: (report) => {
      const progress = typeof report.progress === "number" ? report.progress : 0;
      const text = report.text || "モデルを読み込み中…";
      if (onProgress) onProgress({ text, progress });
    },
  });
}

/**
 * Preferred entry: resolve → persist preference → probe → load engine.
 * Mid-session switch: call again with prevEngine, or reload the page.
 *
 * @param {string} idOrKey  `"default"` | `"plus"` | full model_id
 * @param {{
 *   onProgress?: (p: { text: string, progress: number }) => void,
 *   prevEngine?: import("@mlc-ai/web-llm").MLCEngineInterface | null,
 *   persist?: boolean,
 *   requireAvailable?: boolean,
 * }} [opts]
 * @returns {Promise<{
 *   engine: import("@mlc-ai/web-llm").MLCEngineInterface,
 *   model: ModelInfo,
 * }>}
 */
export async function loadModel(idOrKey, opts = {}) {
  const model = resolveModel(idOrKey) || MODELS.default;
  const persist = opts.persist !== false;
  const requireAvailable = opts.requireAvailable !== false;

  if (persist) setSelectedModelKey(model.key);

  if (requireAvailable) {
    const probe = await probeModel(model);
    if (!probe.ok) {
      const err = new Error(probe.reason || "Model not available");
      err.code = "MODEL_UNAVAILABLE";
      err.model = model;
      throw err;
    }
  }

  const engine = await createLocalEngine(opts.onProgress, model, opts.prevEngine || null);
  return { engine, model };
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
  return Math.min(1.35, 0.35 + level * 0.28);
}

export function driftLabel(level) {
  return ["忠実", "軽微な補完", "自信ある逸脱", "過信ハルシネーション"][level] || "ドリフト";
}

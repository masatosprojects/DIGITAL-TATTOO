/**
 * Same-origin WebLLM loader. No CDN / no remote model URLs at runtime.
 * Weights are inference-only — no training / no parameter updates.
 *
 * Public API (game / gate should use these):
 *   listModels()              — catalog sorted by intelligence rank
 *   resolveModel(idOrKey)     — look up by key or full model_id
 *   getDefaultModelKey()      — smartest *usable* model (1.5B)
 *   getSelectedModelKey() / setSelectedModelKey(key)
 *   probeModel / isModelAvailable / listModelAvailability
 *   loadModel(idOrKey, opts)  — unload previous, load selected, persist preference
 *   createLlmQueue(engineRef)
 *
 * Keep catalog in sync with scripts/fetch-model.mjs (web-llm 0.2.84).
 * See MODELS.md for ranking, deploy sizes, and fluency honesty.
 */

import { CreateMLCEngine } from "@mlc-ai/web-llm";

export const STORAGE_KEY = "digital-tattoo-model";

/**
 * WebLLM's cleanModelUrl() ALWAYS appends `resolve/<branch>/` unless the
 * model URL already matches `.+/resolve/.+/`. Same-origin files live under
 * `models/<id>/resolve/main/` — never Hugging Face at runtime.
 */
export const MODEL_HF_COMPAT_PREFIX = "resolve/main/";

/**
 * @typedef {"yes" | "maybe" | "no"} UsableFlag
 *
 * @typedef {{
 *   key: string,
 *   rank: number,
 *   label: string,
 *   shortLabel: string,
 *   id: string,
 *   wasm: string,
 *   sizeMB: number,
 *   vramMB: number,
 *   minVramHint: number,
 *   usable: UsableFlag,
 *   jpQuality: number,
 *   hint: string,
 *   license: string,
 *   isDefault?: boolean,
 * }} ModelInfo
 */

/**
 * Ranked by intelligence / JP quality (1 = smartest).
 * Default = smartest *usable* on common WebGPU laptops + Pages (~1 GB soft).
 *   hq (3B)   — smarter but heavy / maybe; Qwen Research license
 *   default (1.5B) — recommended default
 *   lite (0.5B) — weak-GPU fallback
 */
/** @type {ModelInfo[]} */
export const MODEL_CATALOG = [
  {
    key: "hq",
    rank: 1,
    label: "高精度 (3B・要VRAM)",
    shortLabel: "高精度",
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 1670,
    vramMB: 2505,
    minVramHint: 2800,
    usable: "maybe",
    jpQuality: 1,
    license: "Qwen Research",
    hint: "最も賢い候補。≈1.7 GB · VRAM ≈2.5 GB。統合GPUでは厳しい。Pages非推奨。",
  },
  {
    key: "default",
    rank: 2,
    label: "標準 (1.5B) · 推奨",
    shortLabel: "標準",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 840,
    vramMB: 1630,
    minVramHint: 1800,
    usable: "yes",
    jpQuality: 2,
    license: "Apache-2.0",
    isDefault: true,
    hint: "実用的な日本語の最推奨。≈840 MB · VRAM ≈1.6 GB。CI / Pages 既定。",
  },
  {
    key: "lite",
    rank: 3,
    label: "軽量 (0.5B)",
    shortLabel: "軽量",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 280,
    vramMB: 945,
    minVramHint: 1100,
    usable: "yes",
    jpQuality: 3,
    license: "Apache-2.0",
    hint: "弱GPU向け。≈280 MB · VRAM ≈950 MB。短文は可・流暢さは限定的。",
  },
];

/** @type {Record<string, ModelInfo>} */
export const MODELS = Object.fromEntries(MODEL_CATALOG.map((m) => [m.key, m]));

/** Key of the smartest *usable* model (not the largest/maybe). */
export const DEFAULT_MODEL_KEY = "default";

/** @deprecated old dual-catalog alias — was 1.5B “plus”; now equals default */
MODELS.plus = MODELS.default;

/** @deprecated prefer resolveModel / getActiveModel().id */
export const MODEL_ID = MODELS[DEFAULT_MODEL_KEY].id;
/** @deprecated prefer getActiveModel().wasm */
export const MODEL_WASM = MODELS[DEFAULT_MODEL_KEY].wasm;

/** Legacy storage values → current keys. */
const LEGACY_KEY_MAP = {
  plus: "default", // old “日本語プラス” was 1.5B
};

/**
 * Ordered catalog for UI pickers (intelligence rank ascending).
 * @returns {ModelInfo[]}
 */
export function listModels() {
  return MODEL_CATALOG.slice().sort((a, b) => a.rank - b.rank);
}

export function getDefaultModelKey() {
  return DEFAULT_MODEL_KEY;
}

/**
 * Resolve by short key (`default`|`lite`|`hq`|legacy `plus`) or full WebLLM model_id.
 * @param {string} [idOrKey]
 * @returns {ModelInfo | null}
 */
export function resolveModel(idOrKey) {
  if (!idOrKey) return null;
  const mapped = LEGACY_KEY_MAP[idOrKey] || idOrKey;
  if (MODELS[mapped] && mapped !== "plus") return MODELS[mapped];
  if (mapped === "plus") return MODELS.default;
  for (const m of MODEL_CATALOG) {
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
    const resolved = resolveModel(v);
    if (resolved) return resolved.key;
  } catch (_) {
    /* private mode */
  }
  return DEFAULT_MODEL_KEY;
}

export function setSelectedModelKey(key) {
  const resolved = resolveModel(key);
  const k = resolved ? resolved.key : DEFAULT_MODEL_KEY;
  try {
    localStorage.setItem(STORAGE_KEY, k);
  } catch (_) {
    /* ignore */
  }
  return k;
}

export function getActiveModel() {
  return MODELS[getSelectedModelKey()] || MODELS[DEFAULT_MODEL_KEY];
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
        low_resource_required: m.usable === "yes",
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

function missingReason(model) {
  if (model.key === "hq") {
    return (
      "高精度用ファイルがありません。公開者が `npm run fetch-model:hq` " +
      "（または `fetch-model:all`）を実行してください。≈1.7 GB・要VRAM。"
    );
  }
  if (model.key === "lite") {
    return (
      "軽量モデルがありません。公開者が `npm run fetch-model:lite` を実行してください。"
    );
  }
  return (
    "ローカルモデルが見つかりません（models/…/resolve/main/）。" +
    "`npm run fetch-model` のあと再読み込みしてください。"
  );
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
      model: MODELS[DEFAULT_MODEL_KEY],
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
        reason: missingReason(model),
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
 * Availability for every catalog entry (for gate enable/disable), sorted by rank.
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

/**
 * @deprecated prefer listModelAvailability()
 * Shape kept for older gate code: { default, lite?, hq?, plus? }
 */
export async function probeAllModels() {
  const list = await listModelAvailability();
  /** @type {Record<string, { ok: boolean, model: ModelInfo, reason?: string }>} */
  const out = {};
  for (const m of list) {
    out[m.key] = { ok: m.available, model: m, reason: m.reason };
  }
  // legacy alias
  out.plus = out.default;
  return out;
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
 * @param {string} idOrKey  key | full model_id
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
  const model = resolveModel(idOrKey) || MODELS[DEFAULT_MODEL_KEY];
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

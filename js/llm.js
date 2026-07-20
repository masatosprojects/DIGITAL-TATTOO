/**
 * Same-origin WebLLM loader. No CDN / no remote model URLs at runtime.
 * Weights are inference-only — no training / no parameter updates.
 *
 * Public API (game / gate should use these):
 *   listModels()              — catalog sorted by intelligence rank
 *   resolveModel(idOrKey)     — look up by key or full model_id
 *   getDefaultModelKey()      — smartest *usable* model (1.5B)
 *   getSelectedModelKey() / setSelectedModelKey(key)
 *   getSelectedEngineMode() / setSelectedEngineMode(mode)
 *   probeModel / isModelAvailable / listModelAvailability
 *   loadModel(idOrKey, opts)  — unload previous, load selected, persist preference
 *   createEngine(modelKey, opts)
 *   loadTripleEngines(modelKey, onProgress)  — 1.5B × 3 runtime engines (same disk files)
 *   loadStrongWeakEngines(onProgress)        — 00=1.5B, 01/02=0.5B
 *   generateWithEngine(engine, messages, opts)
 *   createLlmQueue(engineRef) / createAgentLlmRouter(binding)
 *
 * Keep catalog in sync with scripts/fetch-model.mjs (web-llm 0.2.84).
 * See MODELS.md for ranking, deploy sizes, engine modes, and fluency honesty.
 */

import { CreateMLCEngine } from "@mlc-ai/web-llm";

export const STORAGE_KEY = "digital-tattoo-model";
export const ENGINE_MODE_KEY = "digital-tattoo-engine-mode";

/**
 * @typedef {"triple-1.5" | "switch-1" | "strong-weak"} EngineModeId
 *
 * @typedef {{
 *   id: EngineModeId,
 *   label: string,
 *   shortLabel: string,
 *   experimental?: boolean,
 *   recommended?: boolean,
 *   warn: string,
 *   hint: string,
 * }} EngineModeInfo
 */

/** @type {EngineModeInfo[]} */
export const ENGINE_MODE_CATALOG = [
  {
    id: "triple-1.5",
    label: "実験: 1.5B×3同時",
    shortLabel: "1.5×3",
    experimental: true,
    warn:
      "VRAM を大量に使います（目安 ≈4 GB+）。タブが落ちる・固まる可能性があります。ディスク上の重みは1セットのまま、ランタイムだけ3エンジンです。",
    hint: "AGENT-00/01/02 が各エンジン（同じ 1.5B ファイル）。真の並列は VRAM 次第。",
  },
  {
    id: "switch-1",
    label: "推奨: 単一エンジン切替",
    shortLabel: "単一",
    recommended: true,
    warn: "",
    hint: "エンジン1つ。話者ごとにプロンプト／役割だけ切替。VRAM は最も安全。",
  },
  {
    id: "strong-weak",
    label: "00強+01/02弱",
    shortLabel: "強弱",
    warn: "1.5B と 0.5B の両方のファイルが必要です。",
    hint: "00=1.5B、01/02=0.5B（2エンジン）。弱GPU向けの折衷。",
  },
];

/** Default gate selection: try experimental triple first when files allow. */
export const DEFAULT_ENGINE_MODE = "triple-1.5";

/** Safer fallback when triple fails or is unavailable. */
export const SAFE_ENGINE_MODE = "switch-1";

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

/**
 * Same-origin `models/` root. Must survive GitHub project Pages quirks:
 * - absolute base `/DIGITAL-TATTOO/` (CI) even when the page URL has no trailing slash
 * - relative base `./` on domain roots — resolve against the page *directory*
 *   (…/DIGITAL-TATTOO without slash is a directory, not a file)
 */
export function modelsBase() {
  const raw = import.meta.env.BASE_URL || "./";
  let base;
  if (raw === "./" || raw === "." || raw === "") {
    const path = window.location.pathname;
    let dir;
    if (path.endsWith("/")) {
      dir = path;
    } else {
      const last = path.split("/").pop() || "";
      // Strip only real files (index.html); bare /repo names are directories on Pages
      dir = last.includes(".")
        ? path.replace(/\/[^/]*$/, "/") || "/"
        : path + "/";
    }
    base = new URL(dir, window.location.origin);
  } else {
    base = new URL(raw, window.location.href);
  }
  if (!base.pathname.endsWith("/")) {
    base.pathname += "/";
  }
  return new URL("models/", base).href;
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

/**
 * @param {string} [id]
 * @returns {EngineModeInfo | null}
 */
export function resolveEngineMode(id) {
  if (!id) return null;
  return ENGINE_MODE_CATALOG.find((m) => m.id === id) || null;
}

export function listEngineModes() {
  return ENGINE_MODE_CATALOG.slice();
}

export function getSelectedEngineMode() {
  try {
    const v = localStorage.getItem(ENGINE_MODE_KEY);
    if (resolveEngineMode(v)) return /** @type {EngineModeId} */ (v);
  } catch (_) {
    /* private mode */
  }
  return DEFAULT_ENGINE_MODE;
}

/**
 * @param {string} mode
 * @returns {EngineModeId}
 */
export function setSelectedEngineMode(mode) {
  const resolved = resolveEngineMode(mode);
  const id = /** @type {EngineModeId} */ (
    resolved ? resolved.id : DEFAULT_ENGINE_MODE
  );
  try {
    localStorage.setItem(ENGINE_MODE_KEY, id);
  } catch (_) {
    /* ignore */
  }
  return id;
}

/**
 * Whether a mode can be attempted given local file probes.
 * @param {EngineModeId | string} modeId
 * @param {Array<ModelInfo & { available: boolean, reason?: string }>} [avail]
 */
export async function isEngineModeAvailable(modeId, avail) {
  const list = avail || (await listModelAvailability());
  const byKey = new Map(list.map((m) => [m.key, m]));
  const defOk = !!byKey.get("default")?.available;
  const liteOk = !!byKey.get("lite")?.available;
  if (modeId === "triple-1.5") {
    return {
      ok: defOk,
      reason: defOk
        ? undefined
        : "1.5B モデルがありません（`npm run fetch-model`）。triple には同一オリジンの 1.5B が必要です。",
    };
  }
  if (modeId === "strong-weak") {
    if (defOk && liteOk) return { ok: true };
    const parts = [];
    if (!defOk) parts.push("1.5B なし");
    if (!liteOk) parts.push("0.5B なし（`npm run fetch-model:lite`）");
    return { ok: false, reason: parts.join(" · ") };
  }
  // switch-1: any available model works (gate still picks one)
  const any = list.some((m) => m.available);
  return {
    ok: any,
    reason: any ? undefined : "利用可能なモデルがありません。",
  };
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

function missingReason(model, configUrl) {
  const pathHint = configUrl
    ? " 期待パス: " + configUrl.replace(/^https?:\/\/[^/]+/, "")
    : "";
  if (model.key === "hq") {
    return (
      "高精度モデルがこの公開に含まれていません（≈1.7 GB）。" +
      "「テンプレートで続行」で遊べます。配布に含める場合は公開者が `npm run fetch-model:hq`。" +
      pathHint
    );
  }
  if (model.key === "lite") {
    return (
      "軽量モデルがこの公開に含まれていません。" +
      "標準モデルを選ぶか、「テンプレートで続行」を使ってください。" +
      "（公開者: `npm run fetch-model:lite`）" +
      pathHint
    );
  }
  return (
    "モデルデータが読めません（models/…/resolve/main/mlc-chat-config.json）。" +
    "GitHub Pages では CI が 1.5B を配置します。しばらく待つか「テンプレートで続行」を使ってください。" +
    pathHint
  );
}

/** HEAD can fail on some hosts; fall back to a tiny ranged GET. */
async function probeWasm(wasmUrl) {
  try {
    const head = await fetch(wasmUrl, { method: "HEAD", cache: "no-cache" });
    if (head.ok) {
      const ct = (head.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("text/html")) return { ok: false };
      return { ok: true };
    }
  } catch (_) {
    /* try GET */
  }
  try {
    const get = await fetch(wasmUrl, {
      method: "GET",
      cache: "no-cache",
      headers: { Range: "bytes=0-15" },
    });
    if (!(get.ok || get.status === 206)) return { ok: false };
    const ct = (get.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html")) return { ok: false };
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
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
      probeWasm(wasmUrl),
    ]);
    if (!c.ok || !w.ok) {
      return {
        ok: false,
        model,
        reason: missingReason(model, configUrl),
        configUrl,
        wasmUrl,
      };
    }
    const ct = (c.headers.get("content-type") || "").toLowerCase();
    const body = await c.text();
    if (ct.includes("text/html") || !body.includes("model_type")) {
      return {
        ok: false,
        model,
        reason:
          "モデル設定が JSON ではありません（404 の HTML フォールバックの可能性）。" +
          "「テンプレートで続行」で遊べます。配置: models/…/resolve/main/",
        configUrl,
        wasmUrl,
      };
    }
    return { ok: true, model, configUrl, wasmUrl };
  } catch (e) {
    return {
      ok: false,
      model,
      reason:
        "ローカルモデルの確認に失敗しました。「テンプレートで続行」が使えます。（" +
        (e && e.message ? e.message : String(e)) +
        "）",
      configUrl,
      wasmUrl,
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
 * Preferred create API: `createEngine(modelKey, { onProgress, prevEngine })`.
 *
 * @param {string | ModelInfo} modelKey
 * @param {{
 *   onProgress?: (p: { text: string, progress: number, engineIndex?: number, engineTotal?: number }) => void,
 *   prevEngine?: import("@mlc-ai/web-llm").MLCEngineInterface | null,
 * }} [opts]
 */
export async function createEngine(modelKey, opts = {}) {
  return createLocalEngine(opts.onProgress, modelKey, opts.prevEngine || null);
}

/**
 * @param {Array<import("@mlc-ai/web-llm").MLCEngineInterface | null | undefined>} engines
 */
export async function unloadAllEngines(engines) {
  if (!engines || !engines.length) return;
  for (const e of engines) {
    await unloadEngine(e);
  }
}

/**
 * Streaming (or non-streaming) completion against one engine.
 *
 * @param {import("@mlc-ai/web-llm").MLCEngineInterface} engine
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{
 *   temperature?: number,
 *   max_tokens?: number,
 *   top_p?: number,
 *   stream?: boolean,
 *   onDelta?: (delta: string, full: string) => void,
 * }} [opts]
 * @returns {Promise<string>}
 */
export async function generateWithEngine(engine, messages, opts = {}) {
  if (!engine) throw new Error("LLM engine not ready");
  const wantStream = opts.stream !== false && typeof opts.onDelta === "function";
  const base = {
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 120,
    top_p: opts.top_p ?? 0.9,
  };

  if (!wantStream) {
    const reply = await engine.chat.completions.create(base);
    const text = reply?.choices?.[0]?.message?.content;
    return String(text || "").trim();
  }

  const chunks = await engine.chat.completions.create({
    ...base,
    stream: true,
  });
  let full = "";
  for await (const chunk of chunks) {
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      opts.onDelta(delta, full);
    }
  }
  return String(full || "").trim();
}

/**
 * Load three separate runtime engines for the same on-disk model (default: 1.5B).
 * Progress reports as 1/3, 2/3, 3/3. On mid-way failure: unload all and throw
 * with a suggestion to use switch-1 or strong-weak.
 *
 * @param {string} [modelKey]
 * @param {(p: {
 *   text: string,
 *   progress: number,
 *   engineIndex: number,
 *   engineTotal: number,
 * }) => void} [onProgress]
 * @returns {Promise<{
 *   engines: {
 *     A: import("@mlc-ai/web-llm").MLCEngineInterface,
 *     B: import("@mlc-ai/web-llm").MLCEngineInterface,
 *     C: import("@mlc-ai/web-llm").MLCEngineInterface,
 *   },
 *   model: ModelInfo,
 *   mode: "triple-1.5",
 *   agentMap: Record<"00"|"01"|"02", { engineId: string, model: ModelInfo, engine: import("@mlc-ai/web-llm").MLCEngineInterface }>,
 * }>}
 */
export async function loadTripleEngines(modelKey = DEFAULT_MODEL_KEY, onProgress) {
  const model = resolveModel(modelKey) || MODELS[DEFAULT_MODEL_KEY];
  const probe = await probeModel(model);
  if (!probe.ok) {
    const err = new Error(probe.reason || "Model not available for triple-1.5");
    err.code = "MODEL_UNAVAILABLE";
    err.model = model;
    throw err;
  }

  const total = 3;
  /** @type {Array<import("@mlc-ai/web-llm").MLCEngineInterface | null>} */
  const loaded = [null, null, null];
  const labels = ["A", "B", "C"];

  try {
    for (let i = 0; i < total; i++) {
      const idx = i + 1;
      const engine = await createEngine(model, {
        onProgress: (p) => {
          const slice = (i + Math.max(0, Math.min(1, p.progress))) / total;
          if (onProgress) {
            onProgress({
              text:
                "エンジン" +
                labels[i] +
                " (" +
                idx +
                "/" +
                total +
                ") · " +
                (p.text || model.shortLabel),
              progress: slice,
              engineIndex: idx,
              engineTotal: total,
            });
          }
        },
      });
      loaded[i] = engine;
      if (onProgress) {
        onProgress({
          text: "エンジン" + labels[i] + " 準備完了 (" + idx + "/" + total + ")",
          progress: idx / total,
          engineIndex: idx,
          engineTotal: total,
        });
      }
    }
  } catch (e) {
    await unloadAllEngines(loaded);
    const detail = e && e.message ? e.message : String(e);
    const err = new Error(
      "1.5B×3 の読み込みに失敗しました（" +
        detail +
        "）。VRAM 不足の可能性が高いです。「推奨: 単一エンジン切替」または「00強+01/02弱」を試してください。"
    );
    err.code = "TRIPLE_LOAD_FAILED";
    err.cause = e;
    throw err;
  }

  const engines = { A: loaded[0], B: loaded[1], C: loaded[2] };
  const agentMap = {
    "00": { engineId: "A", model, engine: engines.A },
    "01": { engineId: "B", model, engine: engines.B },
    "02": { engineId: "C", model, engine: engines.C },
  };
  return { engines, model, mode: "triple-1.5", agentMap };
}

/**
 * 00 = 1.5B, 01 & 02 share 0.5B (two runtime engines; one disk copy each).
 *
 * @param {(p: { text: string, progress: number, engineIndex?: number, engineTotal?: number }) => void} [onProgress]
 */
export async function loadStrongWeakEngines(onProgress) {
  const strong = MODELS.default;
  const weak = MODELS.lite;
  const [pStrong, pWeak] = await Promise.all([probeModel(strong), probeModel(weak)]);
  if (!pStrong.ok || !pWeak.ok) {
    const bits = [];
    if (!pStrong.ok) bits.push(pStrong.reason || "1.5B なし");
    if (!pWeak.ok) bits.push(pWeak.reason || "0.5B なし");
    const err = new Error(bits.join(" "));
    err.code = "MODEL_UNAVAILABLE";
    throw err;
  }

  /** @type {import("@mlc-ai/web-llm").MLCEngineInterface | null} */
  let engineStrong = null;
  /** @type {import("@mlc-ai/web-llm").MLCEngineInterface | null} */
  let engineWeak = null;

  try {
    engineStrong = await createEngine(strong, {
      onProgress: (p) => {
        if (onProgress) {
          onProgress({
            text: "強エンジン (1/2) · " + (p.text || strong.shortLabel),
            progress: p.progress * 0.5,
            engineIndex: 1,
            engineTotal: 2,
          });
        }
      },
    });
    engineWeak = await createEngine(weak, {
      onProgress: (p) => {
        if (onProgress) {
          onProgress({
            text: "弱エンジン (2/2) · " + (p.text || weak.shortLabel),
            progress: 0.5 + p.progress * 0.5,
            engineIndex: 2,
            engineTotal: 2,
          });
        }
      },
    });
  } catch (e) {
    await unloadAllEngines([engineStrong, engineWeak]);
    const detail = e && e.message ? e.message : String(e);
    const err = new Error(
      "強弱エンジンの読み込みに失敗しました（" +
        detail +
        "）。「推奨: 単一エンジン切替」を試してください。"
    );
    err.code = "STRONG_WEAK_LOAD_FAILED";
    err.cause = e;
    throw err;
  }

  const agentMap = {
    "00": { engineId: "strong", model: strong, engine: engineStrong },
    "01": { engineId: "weak", model: weak, engine: engineWeak },
    "02": { engineId: "weak", model: weak, engine: engineWeak },
  };
  return {
    engines: { strong: engineStrong, weak: engineWeak },
    strong,
    weak,
    mode: "strong-weak",
    agentMap,
  };
}

/**
 * Single-engine mode (safest). Role/context switch is done via prompts in app.js.
 *
 * @param {string} [modelKey]
 * @param {(p: { text: string, progress: number }) => void} [onProgress]
 * @param {import("@mlc-ai/web-llm").MLCEngineInterface | null} [prevEngine]
 */
export async function loadSwitchEngine(modelKey, onProgress, prevEngine = null) {
  const { engine, model } = await loadModel(modelKey || getSelectedModelKey(), {
    onProgress,
    prevEngine,
    persist: true,
  });
  const agentMap = {
    "00": { engineId: "main", model, engine },
    "01": { engineId: "main", model, engine },
    "02": { engineId: "main", model, engine },
  };
  return {
    engines: { main: engine },
    model,
    mode: "switch-1",
    agentMap,
  };
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

/**
 * Serialize LLM calls — WebLLM is single-flight per engine.
 * Supports streaming via opts.onDelta(delta, fullSoFar) when stream !== false.
 */
export function createLlmQueue(engineRef) {
  let chain = Promise.resolve();

  async function chat(messages, opts = {}) {
    const run = async () => {
      const engine = engineRef.current;
      if (!engine) throw new Error("LLM engine not ready");
      return generateWithEngine(engine, messages, opts);
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  return { chat };
}

/**
 * Per-agent routing: each unique engine instance gets its own serialize queue
 * so distinct engines can run in true parallel when the game loop allows.
 *
 * @param {Record<"00"|"01"|"02", {
 *   engineId: string,
 *   model: ModelInfo,
 *   engine: import("@mlc-ai/web-llm").MLCEngineInterface,
 * }>} agentMap
 */
export function createAgentLlmRouter(agentMap) {
  /** @type {Map<import("@mlc-ai/web-llm").MLCEngineInterface, ReturnType<typeof createLlmQueue>>} */
  const queues = new Map();

  function queueFor(engine) {
    let q = queues.get(engine);
    if (!q) {
      q = createLlmQueue({ current: engine });
      queues.set(engine, q);
    }
    return q;
  }

  /**
   * @param {"00"|"01"|"02"|string} agent
   * @param {Array<{ role: string, content: string }>} messages
   * @param {object} [opts]
   */
  async function chat(agent, messages, opts = {}) {
    const binding = agentMap[agent];
    if (!binding || !binding.engine) {
      throw new Error("No engine bound for AGENT-" + agent);
    }
    return queueFor(binding.engine).chat(messages, opts);
  }

  function infoFor(agent) {
    const binding = agentMap[agent];
    if (!binding) return null;
    return {
      agent,
      engineId: binding.engineId,
      modelKey: binding.model.key,
      modelId: binding.model.id,
      shortLabel: binding.model.shortLabel,
    };
  }

  return { chat, infoFor, agentMap };
}

export function driftTemperature(level) {
  return Math.min(1.35, 0.35 + level * 0.28);
}

export function driftLabel(level) {
  return ["忠実", "軽微な補完", "自信ある逸脱", "過信ハルシネーション"][level] || "ドリフト";
}

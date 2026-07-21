/**
 * WebLLM loader — same-origin preferred; GitHub Pages may fall back to Hugging Face.
 * Weights are inference-only — no training / no parameter updates.
 *
 * Public API (game / gate should use these):
 *   listModels()              — catalog sorted by intelligence rank
 *   resolveModel(idOrKey)     — look up by key or full model_id
 *   getDefaultModelKey()      — recommended usable model (1.5B; Pages may load via HF)
 *   isGitHubPagesHost() / preferPagesSafeModel()
 *   getSelectedModelKey() / setSelectedModelKey(key)
 *   getAgentAssignments() / setAgentAssignments(map) / setAgentAssignment(agent, key)
 *   loadAgentAssignments(map, onProgress) — per-agent models; share engine when same key
 *   probeModel / isModelAvailable / listModelAvailability
 *   loadModel(idOrKey, opts)  — unload previous, load selected, persist preference
 *   createEngine(modelKey, opts)
 *   loadTripleEngines / loadStrongWeakEngines / loadSwitchEngine (legacy presets)
 *   explainLoadError(err)     — JP message for Cache / network / VRAM
 *   generateWithEngine(engine, messages, opts)
 *   isLlmDeadError(err)
 *   createLlmQueue(engineRef) / createAgentLlmRouter(binding, opts?)
 *     — shared-engine safe; auto reload/recreate on dispose
 *
 * Keep catalog in sync with scripts/fetch-model.mjs (web-llm 0.2.84).
 * See MODELS.md for ranking, deploy sizes, engine modes, and fluency honesty.
 *
 * GitHub Pages notes:
 *   Soft site cap ≈1 GB → CI ships lite (0.5B) same-origin by default.
 *   default (1.5B) / hq / swallow / gemma-jpn stay selectable via HF + IndexedDB.
 *   Full multi-model same-origin pack → Netlify / local fetch-model.
 */

import {
  CreateMLCEngine,
  prebuiltAppConfig,
  modelLibURLPrefix,
  modelVersion,
} from "@mlc-ai/web-llm";

export const STORAGE_KEY = "digital-tattoo-model";
export const ENGINE_MODE_KEY = "digital-tattoo-engine-mode";
/** JSON: { "00": "default", "01": "default", "02": "lite" } */
export const AGENT_ASSIGN_KEY = "digital-tattoo-agent-models";

/** @typedef {"00"|"01"|"02"} AgentId */
/** @type {readonly AgentId[]} */
export const AGENT_IDS = Object.freeze(["00", "01", "02"]);

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
 * @typedef {"local" | "remote"} ModelSource
 *
 * @typedef {{
 *   key: string,
 *   rank: number,
 *   label: string,
 *   shortLabel: string,
 *   id: string,
 *   idAliases?: string[],
 *   hfRepo: string,
 *   wasm: string,
 *   sizeMB: number,
 *   vramMB: number,
 *   minVramHint: number,
 *   usable: UsableFlag,
 *   jpQuality: number,
 *   hint: string,
 *   license: string,
 *   isDefault?: boolean,
 *   jpSpecialized?: boolean,
 *   requiresF16?: boolean,
 *   noSystemRole?: boolean,
 *   remoteOk?: boolean,
 * }} ModelInfo
 */

/**
 * Ranked by intelligence / size (1 = smartest). Keep in sync with fetch-model.mjs.
 * Recommended default remains Qwen 1.5B (もともとの標準).
 * Pages CI ships lite same-origin; other keys load via HF+IndexedDB when missing.
 */
/** @type {ModelInfo[]} */
export const MODEL_CATALOG = [
  {
    key: "hq",
    rank: 1,
    label: "高精度 Qwen 3B（要VRAM）",
    shortLabel: "Qwen3B",
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 1670,
    vramMB: 2505,
    minVramHint: 2800,
    usable: "maybe",
    jpQuality: 2,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Qwen Research",
    hint: "最も賢い候補。≈1.7 GB · VRAM ≈2.5 GB。統合GPUでは厳しい。未同梱時は初回は HF から取得。",
  },
  {
    key: "gemma-jpn",
    rank: 2,
    label: "Gemma2 2B-JPN（system不可）",
    shortLabel: "GemmaJPN",
    id: "gemma-2-2b-jpn-it-q4f16_1-MLC",
    hfRepo: "mlc-ai/gemma-2-2b-jpn-it-q4f16_1-MLC",
    wasm: "gemma-2-2b-jpn-it-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 1400,
    vramMB: 1895,
    minVramHint: 2100,
    usable: "maybe",
    jpQuality: 2,
    jpSpecialized: true,
    requiresF16: true,
    noSystemRole: true,
    remoteOk: true,
    license: "Gemma",
    hint:
      "JP寄り 2B。WebLLM 公式。system ロール非対応のため尋問プロンプトは弱めになり得る。" +
      "≈1.4 GB · VRAM ≈1.9 GB。初回は HF から取得。",
  },
  {
    key: "swallow",
    rank: 3,
    label: "TinySwallow 1.5B（JP特化）· 推奨",
    shortLabel: "Swallow",
    // WebLLM model_id (custom appConfig). Sakana ChatUI uses short "TinySwallow-1.5B";
    // we keep the MLC repo suffix so IndexedDB keys match the HF artifact name.
    id: "TinySwallow-1.5B-Instruct-q4f32_1-MLC",
    /** @type {string[]} alternate ids accepted by resolveModel / appConfig aliases */
    idAliases: ["TinySwallow-1.5B", "tinyswallow"],
    hfRepo: "SakanaAI/TinySwallow-1.5B-Instruct-q4f32_1-MLC",
    // Same arch as official Qwen2.5-1.5B-q4f32 (ndarray layout matches 311/311).
    // web-llm 0.2.84 wasm name (Sakana ChatUI@0.2.48 used older *-ctx4k_cs1k-*).
    wasm: "Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm",
    sizeMB: 830,
    vramMB: 1889,
    minVramHint: 2100,
    usable: "yes",
    jpQuality: 1,
    jpSpecialized: true,
    requiresF16: false,
    remoteOk: true,
    license: "Apache-2.0",
    isDefault: true,
    hint:
      "Sakana JP特化蒸留・最推奨。初回 ≈830 MB（HF+IndexedDB）· VRAM ≈1.9 GB（q4f32）。" +
      "WASM は同一オリジン優先（無ければ jsDelivr）。",
  },
  {
    key: "default",
    rank: 4,
    label: "標準 Qwen 1.5B（もともとの標準）",
    shortLabel: "標準1.5B",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 840,
    vramMB: 1630,
    minVramHint: 1800,
    usable: "yes",
    jpQuality: 2,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Apache-2.0",
    hint:
      "もともとの標準。≈840 MB · VRAM ≈1.6 GB。" +
      "Pages でも選択可（未同梱時は初回は HF から取得 · IndexedDB）。",
  },
  {
    key: "qwen3-1.7b",
    rank: 4.5,
    label: "Qwen3 1.7B（新世代・多言語強化）",
    shortLabel: "Qwen3-1.7B",
    id: "Qwen3-1.7B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3-1.7B-q4f16_1-MLC",
    wasm: "Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 984,
    vramMB: 2037,
    minVramHint: 2200,
    usable: "yes",
    jpQuality: 2,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Apache-2.0",
    hint:
      "Qwen2.5 の後継。多言語対応を強化した新世代・標準1.5Bとほぼ同格サイズ。" +
      "≈984 MB · VRAM ≈2.0 GB。初回は HF から取得。",
  },
  {
    key: "qwen3-0.6b",
    rank: 5.5,
    label: "Qwen3 0.6B（軽量・新世代）",
    shortLabel: "Qwen3-0.6B",
    id: "Qwen3-0.6B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3-0.6B-q4f16_1-MLC",
    wasm: "Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 335,
    vramMB: 1403,
    minVramHint: 1600,
    usable: "yes",
    jpQuality: 2,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Apache-2.0",
    hint:
      "軽量 Qwen 0.5B の新世代版。多言語対応が改善。≈335 MB · VRAM ≈1.4 GB。初回は HF から取得。",
  },
  {
    key: "ministral3b",
    rank: 1.2,
    label: "Ministral 3 3B Instruct（新世代・多言語）",
    shortLabel: "Ministral3B",
    id: "Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC",
    hfRepo: "mlc-ai/Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC",
    wasm: "Ministral-3-3B-Instruct-2512-BF16-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 1856,
    vramMB: 2864,
    minVramHint: 3100,
    usable: "maybe",
    jpQuality: 2,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Apache-2.0",
    hint:
      "Mistral AI の新世代小型モデル（2025年12月・エッジ向け）。日本語を含む公式対応言語リストあり。" +
      "≈1.9 GB · VRAM ≈2.9 GB（要VRAM）。初回は HF から取得。",
  },
  {
    key: "llama32-3b",
    rank: 1.5,
    label: "Llama 3.2 3B Instruct（日本語は弱め）",
    shortLabel: "Llama3.2-3B",
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC",
    wasm: "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 1733,
    vramMB: 2264,
    minVramHint: 2500,
    usable: "maybe",
    jpQuality: 3,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Llama 3.2 Community License",
    hint:
      "Meta公式・多言語だが公式サポート言語に日本語は含まれず、日本語品質は他候補より劣る。" +
      "≈1.7 GB · VRAM ≈2.3 GB。初回は HF から取得。",
  },
  {
    key: "qwen35-2b",
    rank: 4.7,
    label: "Qwen3.5 2B（最新世代・多言語強化）",
    shortLabel: "Qwen3.5-2B",
    id: "Qwen3.5-2B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3.5-2B-q4f16_1-MLC",
    wasm: "Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 1032,
    vramMB: 2245,
    minVramHint: 2400,
    usable: "yes",
    jpQuality: 2,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Apache-2.0",
    hint:
      "Qwen3 のさらに後継（2026年3月）。201言語対応で多言語エンコード効率が改善。" +
      "≈1.0 GB · VRAM ≈2.2 GB。初回は HF から取得。",
  },
  {
    key: "qwen35-0.8b",
    rank: 5.7,
    label: "Qwen3.5 0.8B（最新世代・軽量）",
    shortLabel: "Qwen3.5-0.8B",
    id: "Qwen3.5-0.8B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3.5-0.8B-q4f16_1-MLC",
    wasm: "Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 426,
    vramMB: 1629,
    minVramHint: 1800,
    usable: "yes",
    jpQuality: 2,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Apache-2.0",
    hint:
      "Qwen3.5 系の最軽量。Qwen2.5/Qwen3 の軽量枠より新しい世代。" +
      "≈426 MB · VRAM ≈1.6 GB。初回は HF から取得。",
  },
  {
    key: "llama32-1b",
    rank: 6,
    label: "Llama 3.2 1B Instruct（日本語は弱め）",
    shortLabel: "Llama3.2-1B",
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
    wasm: "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 672,
    vramMB: 879,
    minVramHint: 1000,
    usable: "yes",
    jpQuality: 3,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Llama 3.2 Community License",
    hint:
      "最軽量級。公式サポート言語に日本語は含まれず、日本語品質は他候補より劣る。" +
      "≈672 MB · VRAM ≈0.9 GB。初回は HF から取得。",
  },
  {
    key: "lite",
    rank: 7,
    label: "軽量 Qwen 0.5B（品質劣る）",
    shortLabel: "軽量0.5B",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    sizeMB: 280,
    vramMB: 945,
    minVramHint: 1100,
    usable: "yes",
    jpQuality: 3,
    jpSpecialized: false,
    requiresF16: true,
    remoteOk: true,
    license: "Apache-2.0",
    hint:
      "品質は劣る（会話が崩れやすい）。≈280 MB。Pages CI 同一オリジン同梱。" +
      "推奨は TinySwallow。",
  },
];

/** @type {Record<string, ModelInfo>} */
export const MODELS = Object.fromEntries(MODEL_CATALOG.map((m) => [m.key, m]));

/** Recommended pick — JP-specialized and usable=yes. */
export const DEFAULT_MODEL_KEY = "default";

/** Pages CI publishes this same-origin by default (fits ≈1 GB soft cap). */
export const PAGES_MODEL_KEY = "lite";

/**
 * @deprecated Large shards are fine with IndexedDB; kept for docs / optional logging.
 * Formerly blocked ≥100 MB shards on github.io because of Cache.add failures.
 */
export const PAGES_MAX_SHARD_BYTES = 100 * 1024 * 1024;

/**
 * WASM libs CDN (web-llm 0.2.84).
 * Prefer jsDelivr — raw.githubusercontent.com is often blocked/slow from JP/Asia
 * and is a common cause of 「Failed to fetch」 / モデル取得失敗 for remote models.
 */
export const MODEL_LIB_CDN_BASE =
  "https://cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@main/web-llm-models/" +
  modelVersion +
  "/";

/** Official WebLLM CDN fallback if jsDelivr is unreachable. */
export const MODEL_LIB_CDN_FALLBACK = modelLibURLPrefix + modelVersion + "/";

/** @deprecated old dual-catalog alias — was 1.5B “plus”; now equals default */
MODELS.plus = MODELS.default;

/** @deprecated prefer resolveModel / getActiveModel().id */
export const MODEL_ID = MODELS[DEFAULT_MODEL_KEY].id;
/** @deprecated prefer getActiveModel().wasm */
export const MODEL_WASM = MODELS[DEFAULT_MODEL_KEY].wasm;

/** Legacy storage values → current keys. */
const LEGACY_KEY_MAP = {
  plus: "default", // old “日本語プラス” was 1.5B
  tinyswallow: "swallow",
  "TinySwallow-1.5B": "swallow",
};

/**
 * Ordered catalog for UI pickers (intelligence rank ascending).
 * @returns {ModelInfo[]}
 */
export function listModels() {
  return MODEL_CATALOG.slice().sort((a, b) => a.rank - b.rank);
}

/** True on github.io project/user Pages (and *.github.io custom preview hosts). */
export function isGitHubPagesHost() {
  if (typeof window === "undefined" || !window.location) return false;
  const host = String(window.location.hostname || "").toLowerCase();
  return host === "github.io" || host.endsWith(".github.io");
}

/**
 * Prefer 1.5B whenever available (including Pages remote/HF).
 * Fall back to lite only if 1.5B cannot load.
 * @param {Array<ModelInfo & { available?: boolean }> | null | undefined} [avail]
 */
export function preferPagesSafeModel(avail) {
  if (Array.isArray(avail) && avail.length) {
    const def = avail.find((m) => m.key === DEFAULT_MODEL_KEY && m.available !== false);
    if (def) return DEFAULT_MODEL_KEY;
    const lite = avail.find((m) => m.key === PAGES_MODEL_KEY && m.available !== false);
    if (lite) return PAGES_MODEL_KEY;
    const any = avail.find((m) => m.available !== false);
    return any ? any.key : DEFAULT_MODEL_KEY;
  }
  return DEFAULT_MODEL_KEY;
}

/** Recommended default: always 1.5B (Pages loads via HF+IndexedDB when not shipped). */
export function getDefaultModelKey() {
  return DEFAULT_MODEL_KEY;
}

/**
 * Resolve by short key (`default`|`lite`|`hq`|`swallow`|legacy `plus`) or full WebLLM model_id.
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
    if (m.idAliases && m.idAliases.includes(idOrKey)) return m;
    if (m.hfRepo === idOrKey || m.hfRepo.endsWith("/" + idOrKey)) return m;
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
    if (resolved) {
      return resolved.key;
    }
  } catch (_) {
    /* private mode */
  }
  return getDefaultModelKey();
}

export function setSelectedModelKey(key) {
  const resolved = resolveModel(key);
  const k = resolved ? resolved.key : getDefaultModelKey();
  try {
    localStorage.setItem(STORAGE_KEY, k);
  } catch (_) {
    /* ignore */
  }
  return k;
}

export function getActiveModel() {
  return MODELS[getSelectedModelKey()] || MODELS[getDefaultModelKey()];
}

/**
 * Normalize / fill a per-agent model-key map.
 * @param {Partial<Record<AgentId, string>> | null | undefined} map
 * @param {string} [fallbackKey]
 * @returns {Record<AgentId, string>}
 */
export function normalizeAgentAssignments(map, fallbackKey = getDefaultModelKey()) {
  const fb = resolveModel(fallbackKey)?.key || getDefaultModelKey();
  /** @type {Record<AgentId, string>} */
  const out = { "00": fb, "01": fb, "02": fb };
  if (!map || typeof map !== "object") return out;
  for (const agent of AGENT_IDS) {
    const resolved = resolveModel(map[agent]);
    out[agent] = resolved ? resolved.key : fb;
  }
  return out;
}

/**
 * Defaults: all agents use the recommended 1.5B when possible.
 * Migrates legacy engine-mode prefs (triple / strong-weak / switch-1) once.
 * @returns {Record<AgentId, string>}
 */
export function getDefaultAgentAssignments() {
  const k = getDefaultModelKey();
  return { "00": k, "01": k, "02": k };
}

/**
 * @returns {Record<AgentId, string>}
 */
export function getAgentAssignments() {
  try {
    const raw = localStorage.getItem(AGENT_ASSIGN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return normalizeAgentAssignments(parsed);
      }
    }
  } catch (_) {
    /* private mode / bad JSON */
  }

  // One-shot migration from legacy engine-mode + single-model prefs
  try {
    const mode = localStorage.getItem(ENGINE_MODE_KEY);
    if (mode === "strong-weak") {
      return normalizeAgentAssignments({
        "00": DEFAULT_MODEL_KEY,
        "01": "lite",
        "02": "lite",
      });
    }
    if (mode === "switch-1" || mode === "triple-1.5") {
      const k = getSelectedModelKey();
      return normalizeAgentAssignments({ "00": k, "01": k, "02": k });
    }
  } catch (_) {
    /* ignore */
  }

  return getDefaultAgentAssignments();
}

/**
 * @param {Partial<Record<AgentId, string>>} map
 * @returns {Record<AgentId, string>}
 */
export function setAgentAssignments(map) {
  const normalized = normalizeAgentAssignments(map);
  try {
    localStorage.setItem(AGENT_ASSIGN_KEY, JSON.stringify(normalized));
  } catch (_) {
    /* ignore */
  }
  // Keep legacy single-model key in sync with AGENT-00 (status / docs)
  setSelectedModelKey(normalized["00"]);
  return normalized;
}

/**
 * @param {AgentId | string} agent
 * @param {string} modelKey
 * @returns {Record<AgentId, string>}
 */
export function setAgentAssignment(agent, modelKey) {
  const current = getAgentAssignments();
  if (AGENT_IDS.includes(/** @type {AgentId} */ (agent))) {
    current[/** @type {AgentId} */ (agent)] = modelKey;
  }
  return setAgentAssignments(current);
}

/**
 * Snap unavailable picks to the best available catalog key.
 * @param {Record<AgentId, string>} assignments
 * @param {Array<ModelInfo & { available: boolean }>} avail
 * @returns {Record<AgentId, string>}
 */
export function coerceAssignmentsToAvailable(assignments, avail) {
  const byKey = new Map((avail || []).map((m) => [m.key, m]));
  // Prefer 1.5B (incl. Pages HF remote), then lite, then any available.
  const preferred =
    (byKey.get(DEFAULT_MODEL_KEY)?.available && DEFAULT_MODEL_KEY) ||
    (byKey.get(preferPagesSafeModel(avail))?.available && preferPagesSafeModel(avail)) ||
    (byKey.get(PAGES_MODEL_KEY)?.available && PAGES_MODEL_KEY) ||
    (avail || []).find((m) => m.available)?.key ||
    null;
  /** @type {Record<AgentId, string>} */
  const out = { ...normalizeAgentAssignments(assignments) };
  if (!preferred) return out;
  for (const agent of AGENT_IDS) {
    if (!byKey.get(out[agent])?.available) out[agent] = preferred;
  }
  return out;
}

/**
 * Unique model keys in first-seen agent order (00 → 01 → 02).
 * @param {Record<AgentId, string>} assignments
 * @returns {string[]}
 */
export function uniqueAssignmentKeys(assignments) {
  const seen = new Set();
  /** @type {string[]} */
  const keys = [];
  const map = normalizeAgentAssignments(assignments);
  for (const agent of AGENT_IDS) {
    const k = map[agent];
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

/**
 * Rough VRAM sum for distinct engines (shared keys count once).
 * @param {Record<AgentId, string>} assignments
 */
export function estimateAssignmentVramMB(assignments) {
  let sum = 0;
  for (const key of uniqueAssignmentKeys(assignments)) {
    const m = resolveModel(key);
    if (m) sum += m.vramMB;
  }
  return sum;
}

/**
 * @param {Record<AgentId, string>} assignments
 * @param {Array<ModelInfo & { available: boolean, reason?: string }>} [avail]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function areAssignmentsAvailable(assignments, avail) {
  const list = avail || (await listModelAvailability());
  const byKey = new Map(list.map((m) => [m.key, m]));
  const map = normalizeAgentAssignments(assignments);
  const missing = [];
  for (const agent of AGENT_IDS) {
    const info = byKey.get(map[agent]);
    if (!info?.available) {
      missing.push(
        "AGENT-" +
          agent +
          ": " +
          (info?.reason || map[agent] + " がありません")
      );
    }
  }
  if (missing.length) return { ok: false, reason: missing.join(" · ") };
  return { ok: true };
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

/**
 * Hugging Face repo root — matches WebLLM prebuilt + Sakana ChatUI.
 * WebLLM `cleanModelUrl` appends `resolve/main/` when missing (do not double-append).
 */
export function remoteWeightsBase(model = getActiveModel()) {
  const m = typeof model === "string" ? resolveModel(model) || getActiveModel() : model;
  return "https://huggingface.co/" + m.hfRepo + "/";
}

/** Same-origin WASM URL as an absolute href (must not resolve against HF model URL). */
export function localWasmUrl(model = getActiveModel()) {
  const m = typeof model === "string" ? resolveModel(model) || getActiveModel() : model;
  const rel = modelsBase() + "libs/" + m.wasm;
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URL(rel, window.location.href).href;
    }
  } catch (_) {
    /* fall through */
  }
  return rel;
}

/**
 * @param {ModelInfo | string} [model]
 * @param {"primary" | "fallback"} [which]
 */
export function remoteWasmUrl(model = getActiveModel(), which = "primary") {
  const m = typeof model === "string" ? resolveModel(model) || getActiveModel() : model;
  const base = which === "fallback" ? MODEL_LIB_CDN_FALLBACK : MODEL_LIB_CDN_BASE;
  return base + m.wasm;
}

/**
 * Pick WASM URL: same-origin first (Pages ships libs for HF models), then jsDelivr, then raw GH.
 * @param {ModelInfo | string} model
 * @param {ModelSource} [source]
 */
export async function resolveWasmUrl(model, source = "local") {
  const m = typeof model === "string" ? resolveModel(model) || getActiveModel() : model;
  const local = localWasmUrl(m);
  if (source !== "remote") return local;
  if ((await probeWasm(local)).ok) return local;
  const primary = remoteWasmUrl(m, "primary");
  if ((await probeWasm(primary)).ok) return primary;
  return remoteWasmUrl(m, "fallback");
}

/**
 * WebLLM 0.2.84 cache backends: "cache" | "indexeddb" | "cross-origin" | "opfs".
 * IndexedDB avoids Cache.add() failures on large Pages shards (≥100 MB).
 */
export function preferredCacheBackend() {
  return "indexeddb";
}

/**
 * Missing same-origin weights may load from Hugging Face + IndexedDB.
 * Default: yes when model.remoteOk (catalog) or on GitHub Pages.
 * @param {ModelInfo | string} [model]
 */
export function allowsRemoteFallback(model) {
  const m = typeof model === "string" ? resolveModel(model) : model;
  if (m && m.remoteOk === false) return false;
  if (m && m.remoteOk === true) return true;
  return isGitHubPagesHost();
}

/** @deprecated use allowsRemoteFallback(model) */
export function pagesAllowsRemoteModels() {
  return isGitHubPagesHost();
}

/**
 * @param {ModelInfo | string} [model]
 * @param {ModelSource} [source]
 * @param {{ modelLib?: string }} [opts]
 */
export function buildAppConfig(model = getActiveModel(), source = "local", opts = {}) {
  const m = typeof model === "string" ? resolveModel(model) || getActiveModel() : model;
  const useRemote = source === "remote";
  /** @type {Record<string, unknown>} */
  const entry = {
    // remoteWeightsBase is HF repo root; WebLLM cleanModelUrl appends resolve/main/
    model: useRemote ? remoteWeightsBase(m) : modelWeightsBase(m),
    model_id: m.id,
    model_lib:
      opts.modelLib ||
      (useRemote ? remoteWasmUrl(m) : localWasmUrl(m)),
    low_resource_required: m.usable === "yes",
    vram_required_MB: m.vramMB,
    // Compiled default is 32768 (see mlc-chat-config.json) — we cap well below
    // that to shrink the KV-cache VRAM preallocation. Repeated WebGPU "device
    // lost" (DXGI_ERROR_DEVICE_REMOVED) reports trace to shared/integrated GPU
    // VRAM pressure; smaller preallocation leaves more headroom before the
    // driver resets the device. Game prompts (shared-memory block capped at
    // 12 Q&A pairs, max_tokens=500) stay well under 3072 tokens even in wolf
    // mode's heavier multi-discussant context, so this shouldn't truncate.
    overrides: {
      context_window_size: 3072,
    },
  };
  // q4f16 needs shader-f16; q4f32 (TinySwallow) must not require it.
  if (m.requiresF16 !== false) {
    entry.required_features = ["shader-f16"];
  }

  // Merge into prebuilt list so findModelRecord never falls back to an empty
  // custom-only config if anything internal expects the registry shape.
  const aliasIds = Array.isArray(m.idAliases) ? m.idAliases : [];
  const ourIds = new Set([m.id, ...aliasIds]);
  const baseList = (prebuiltAppConfig.model_list || []).filter(
    (r) => !ourIds.has(r.model_id)
  );
  /** @type {Record<string, unknown>[]} */
  const ours = [entry];
  for (const alias of aliasIds) {
    if (!alias || alias === m.id) continue;
    ours.push({ ...entry, model_id: alias });
  }

  return {
    ...prebuiltAppConfig,
    cacheBackend: preferredCacheBackend(),
    model_list: [...baseList, ...ours],
  };
}

/**
 * Gemma-style templates reject role:"system". Fold into the first user turn.
 * @param {ModelInfo} model
 * @param {Array<{ role: string, content: string }>} messages
 */
export function adaptMessagesForModel(model, messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!model || !model.noSystemRole) return list;
  const systems = [];
  const rest = [];
  for (const msg of list) {
    if (msg && msg.role === "system") systems.push(String(msg.content || ""));
    else rest.push(msg);
  }
  if (!systems.length) return rest;
  const preface = systems.filter(Boolean).join("\n\n");
  if (!rest.length) {
    return [{ role: "user", content: preface }];
  }
  const firstUserIdx = rest.findIndex((m) => m && m.role === "user");
  if (firstUserIdx >= 0) {
    const u = rest[firstUserIdx];
    rest[firstUserIdx] = {
      ...u,
      content: preface + "\n\n" + String(u.content || ""),
    };
    return rest;
  }
  return [{ role: "user", content: preface }, ...rest];
}

/** @deprecated prefer buildAppConfig(model, "local") */
export function localAppConfig(model = getActiveModel()) {
  return buildAppConfig(model, "local");
}

export function hasWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

function missingReason(model, configUrl) {
  const pathHint = configUrl
    ? " 期待パス: " + configUrl.replace(/^https?:\/\/[^/]+/, "")
    : "";
  const remoteHint = allowsRemoteFallback(model)
    ? " Hugging Face + IndexedDB でも取得できます（初回 ≈" +
      model.sizeMB +
      " MB）。"
    : "";
  if (model.key === "hq") {
    return (
      "このホストに 3B ファイルがありません（≈1.7 GB）。" +
      "配置: `npm run fetch-model:hq`。" +
      remoteHint +
      pathHint
    );
  }
  if (model.key === "lite") {
    return (
      "このホストに 0.5B ファイルがありません（≈280 MB）。" +
      "GitHub Pages では CI が 0.5B を配置します。" +
      remoteHint +
      "（`npm run fetch-model:lite`）" +
      pathHint
    );
  }
  if (model.key === "default") {
    return (
      "このホストに標準 1.5B がありません（≈840 MB）。" +
      (allowsRemoteFallback(model)
        ? "選択可 — Hugging Face + IndexedDB で取得（初回ダウンロード・もともとの標準）。"
        : "`npm run fetch-model` で同一オリジン配置してください。") +
      pathHint
    );
  }
  if (model.key === "swallow" || model.key === "gemma-jpn") {
    return (
      model.shortLabel +
      "（" +
      model.hfRepo +
      "）の同一オリジン配置がありません（≈" +
      model.sizeMB +
      " MB）。" +
      remoteHint +
      pathHint
    );
  }
  return (
    "モデルデータが読めません（models/…/resolve/main/mlc-chat-config.json）。" +
    "公開者がモデルを配置するか、別モデルを選んでください。" +
    pathHint
  );
}

/**
 * User-facing Japanese explanation for WebLLM / Cache failures.
 * @param {unknown} err
 */
export function explainLoadError(err) {
  const raw =
    err && typeof err === "object" && "message" in err && err.message
      ? String(err.message)
      : String(err || "error");
  const lower = raw.toLowerCase();
  if (lower.includes("tensor-cache.json")) {
    return (
      "このモデルの配布元に tensor-cache.json が無く、リモート（Hugging Face）からは読み込めません。" +
      "TinySwallow は次回サイト更新で同一オリジン配置に切り替わります。" +
      "今は標準 Qwen 1.5B や Qwen3 系など他モデルを選んでください。" +
      "（" +
      raw +
      "）"
    );
  }
  if (
    lower.includes("cannot find model record") ||
    lower.includes("modelnotfound") ||
    (lower.includes("model_list") && lower.includes("model id"))
  ) {
    return (
      "選択したモデル ID が WebLLM の設定に見つかりませんでした。" +
      "ページを再読み込みしてから、もう一度 TinySwallow / 標準 1.5B などを選んでください。" +
      "（" +
      raw +
      "）"
    );
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("load failed") ||
    lower.includes("net::err")
  ) {
    return (
      "モデルの取得に失敗しました（ネットワーク / WASM / Hugging Face）。" +
      "通信を確認し、再読み込みするか、標準 Qwen 1.5B や軽量 0.5B を試してください。" +
      "TinySwallow 初回は ≈830 MB のダウンロードが必要です。" +
      "（" +
      raw +
      "）"
    );
  }
  if (
    lower.includes("cache.add") ||
    lower.includes("encountered a network error") ||
    (lower.includes("cache") && lower.includes("network"))
  ) {
    if (isGitHubPagesHost()) {
      return (
        "モデル読み込みに失敗しました（Cache / ネットワーク）。" +
        "IndexedDB キャッシュを使っています。通信・容量・VRAM を確認し、" +
        "軽量 (0.5B) や別モデルを試してください。"
      );
    }
    return (
      "モデル読み込みに失敗しました（Cache / ネットワーク）。" +
      "通信切断・容量不足・破損ファイルの可能性があります。再読み込みしてください。" +
      "（" +
      raw +
      "）"
    );
  }
  if (err && typeof err === "object" && "code" in err && err.code === "MODEL_UNAVAILABLE") {
    return raw + " 別モデルを選ぶか再読み込みしてください。";
  }
  return (
    "モデル読み込みに失敗しました。別モデルを選ぶか再読み込みしてください。（" + raw + "）"
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
 * Probe mlc-chat-config.json. Distinguishes hard 404 from CORS/network ambiguity.
 * @param {string} configUrl
 * @returns {Promise<{ ok: boolean, hardMiss?: boolean, reason?: string }>}
 */
async function probeConfigJson(configUrl) {
  try {
    const c = await fetch(configUrl, { method: "GET", cache: "no-cache" });
    if (c.status === 404 || c.status === 401 || c.status === 403) {
      return {
        ok: false,
        hardMiss: true,
        reason: "設定ファイルがありません（HTTP " + c.status + "）。",
      };
    }
    if (!c.ok) {
      return {
        ok: false,
        hardMiss: false,
        reason: "設定の確認に失敗（HTTP " + c.status + "）。",
      };
    }
    const ct = (c.headers.get("content-type") || "").toLowerCase();
    const body = await c.text();
    if (ct.includes("text/html") || !body.includes("model_type")) {
      return {
        ok: false,
        hardMiss: true,
        reason: "モデル設定が JSON ではありません（404 HTML の可能性）。",
      };
    }
    return { ok: true };
  } catch (e) {
    // CORS / offline / transient — do not treat as "model missing"
    return {
      ok: false,
      hardMiss: false,
      reason: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * @param {ModelInfo} model
 * @returns {Promise<{
 *   ok: boolean,
 *   model: ModelInfo,
 *   source?: ModelSource,
 *   reason?: string,
 *   configUrl?: string,
 *   wasmUrl?: string,
 * }>}
 */
async function probeRemoteModel(model) {
  const configUrl = remoteWeightsBase(model) + "mlc-chat-config.json";
  // After cleanModelUrl this is the same path WebLLM will request.
  const configUrlResolved =
    remoteWeightsBase(model).includes("resolve/")
      ? remoteWeightsBase(model) + "mlc-chat-config.json"
      : remoteWeightsBase(model) + "resolve/main/mlc-chat-config.json";
  const wasmUrl = await resolveWasmUrl(model, "remote");
  const [cfg, wasm] = await Promise.all([
    probeConfigJson(configUrlResolved),
    probeWasm(wasmUrl),
  ]);

  // Definitive missing config on HF → unavailable with accurate JP reason
  if (cfg.hardMiss) {
    return {
      ok: false,
      model,
      source: "remote",
      configUrl: configUrlResolved,
      wasmUrl,
      reason:
        model.shortLabel +
        " は Hugging Face（" +
        model.hfRepo +
        "）で見つかりません。" +
        (cfg.reason || "") +
        " 別モデルを選んでください。",
    };
  }

  // Config OK (or ambiguous network) + remoteOk → allow load attempt.
  // Do not grey out solely because HEAD/CORS failed on wasm CDN.
  if (cfg.ok || allowsRemoteFallback(model)) {
    const notes = [];
    if (!cfg.ok) notes.push("HF設定の事前確認は不完全（読み込み時に再試行）");
    if (!wasm.ok) notes.push("WASM の事前確認は不完全（読み込み時に再試行）");
    return {
      ok: true,
      model,
      source: "remote",
      configUrl: configUrlResolved,
      wasmUrl,
      reason:
        model.shortLabel +
        " は同一オリジンに無いため Hugging Face から取得します（初回 ≈" +
        model.sizeMB +
        " MB · IndexedDB にキャッシュ · VRAM 目安 ≈" +
        Math.round(model.vramMB / 100) / 10 +
        " GB）" +
        (notes.length ? " · " + notes.join(" · ") : "") +
        "。",
    };
  }

  return {
    ok: false,
    model,
    configUrl: configUrlResolved,
    wasmUrl,
    reason: missingReason(model, configUrl),
  };
}

/**
 * @param {ModelInfo | string} modelOrKey
 * @returns {Promise<{
 *   ok: boolean,
 *   model: ModelInfo,
 *   source?: ModelSource,
 *   reason?: string,
 *   configUrl?: string,
 *   wasmUrl?: string,
 * }>}
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
  const wasmUrl = localWasmUrl(model);
  try {
    const [c, w] = await Promise.all([
      probeConfigJson(configUrl),
      probeWasm(wasmUrl),
    ]);
    if (c.ok && w.ok) {
      return {
        ok: true,
        model,
        source: "local",
        configUrl,
        wasmUrl,
      };
    }

    // Missing / incomplete same-origin → Hugging Face + IndexedDB
    if (allowsRemoteFallback(model)) {
      return probeRemoteModel(model);
    }

    return {
      ok: false,
      model,
      reason: c.reason || missingReason(model, configUrl),
      configUrl,
      wasmUrl,
    };
  } catch (e) {
    if (allowsRemoteFallback(model)) {
      return probeRemoteModel(model);
    }
    return {
      ok: false,
      model,
      reason:
        "ローカルモデルの確認に失敗しました。再読み込みしてください。（" +
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
    source: p.source || (p.ok ? "local" : undefined),
    // Keep remote caveat visible in the gate (not a hard disable).
    reason: p.ok ? (p.source === "remote" ? p.reason : undefined) : p.reason,
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
export async function createLocalEngine(
  onProgress,
  model = getActiveModel(),
  prevEngine = null,
  source = "local"
) {
  const m = typeof model === "string" ? resolveModel(model) : model;
  if (!m) throw new Error("Unknown model: " + String(model));
  await unloadEngine(prevEngine);
  const src = source === "remote" ? "remote" : "local";
  const modelLib = await resolveWasmUrl(m, src);
  const appConfig = buildAppConfig(m, src, { modelLib });
  const listed = (appConfig.model_list || []).some((r) => r.model_id === m.id);
  if (!listed) {
    throw new Error(
      "appConfig.model_list に " + m.id + " がありません（内部設定エラー）。"
    );
  }

  const initProgressCallback = (report) => {
    const progress = typeof report.progress === "number" ? report.progress : 0;
    let text = report.text || "モデルを読み込み中…";
    if (src === "remote" && text && !/HF|Hugging|取得/.test(text)) {
      text = "HF取得 · " + text;
    }
    if (onProgress) onProgress({ text, progress });
  };

  try {
    return await CreateMLCEngine(m.id, { appConfig, initProgressCallback });
  } catch (e) {
    const msg = String(
      e && typeof e === "object" && "message" in e ? e.message : e || ""
    );
    const fetchish = /fetch|network|wasm|failed to load|load failed/i.test(msg);
    if (src === "remote" && fetchish) {
      const alt = modelLib.includes("jsdelivr")
        ? remoteWasmUrl(m, "fallback")
        : remoteWasmUrl(m, "primary");
      if (alt !== modelLib) {
        console.warn("TinySwallow/remote load: retrying with alternate WASM CDN", alt, e);
        const retryConfig = buildAppConfig(m, src, { modelLib: alt });
        return CreateMLCEngine(m.id, {
          appConfig: retryConfig,
          initProgressCallback,
        });
      }
    }
    throw e;
  }
}

/**
 * Preferred create API: `createEngine(modelKey, { onProgress, prevEngine, source })`.
 *
 * @param {string | ModelInfo} modelKey
 * @param {{
 *   onProgress?: (p: { text: string, progress: number, engineIndex?: number, engineTotal?: number }) => void,
 *   prevEngine?: import("@mlc-ai/web-llm").MLCEngineInterface | null,
 *   source?: ModelSource,
 * }} [opts]
 */
export async function createEngine(modelKey, opts = {}) {
  const m = typeof modelKey === "string" ? resolveModel(modelKey) : modelKey;
  let source = opts.source;
  if (!source && m) {
    const probe = await probeModel(m);
    if (!probe.ok) {
      const err = new Error(probe.reason || "Model not available");
      err.code = "MODEL_UNAVAILABLE";
      err.model = m;
      throw err;
    }
    source = probe.source || "local";
  }
  return createLocalEngine(opts.onProgress, modelKey, opts.prevEngine || null, source || "local");
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
 * Rough token estimate for streamed text (no local tokenizer).
 * CJK code points ≈ 1 tok; Latin/other ≈ 0.35. Label UI as [tok:N] estimate.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  let n = 0;
  for (const ch of String(text || "")) {
    const cp = ch.codePointAt(0) || 0;
    // CJK / fullwidth / kana / hangul blocks
    n += cp >= 0x2e80 ? 1 : 0.35;
  }
  return Math.max(0, Math.ceil(n));
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
 *   onDelta?: (delta: string, full: string, meta?: { tokens: number, usage?: object }) => void,
 * }} [opts]
 * @returns {Promise<string>}
 */
export async function generateWithEngine(engine, messages, opts = {}) {
  if (!engine) throw new Error("LLM engine not ready");
  const wantStream = opts.stream !== false && typeof opts.onDelta === "function";
  const modelForAdapt =
    opts.model ||
    (opts.modelKey ? resolveModel(opts.modelKey) : null) ||
    null;
  const adapted = modelForAdapt
    ? adaptMessagesForModel(modelForAdapt, messages)
    : messages;
  const base = {
    messages: adapted,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 500,
    top_p: opts.top_p ?? 0.9,
  };

  if (!wantStream) {
    const reply = await engine.chat.completions.create(base);
    const text = reply?.choices?.[0]?.message?.content;
    return String(text || "").trim();
  }

  let chunks;
  try {
    chunks = await engine.chat.completions.create({
      ...base,
      stream: true,
      stream_options: { include_usage: true },
    });
  } catch (_) {
    chunks = await engine.chat.completions.create({
      ...base,
      stream: true,
    });
  }
  let full = "";
  let lastUsage = null;
  for await (const chunk of chunks) {
    if (chunk && chunk.usage) lastUsage = chunk.usage;
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      const tokens =
        (lastUsage &&
          (lastUsage.completion_tokens || lastUsage.total_tokens)) ||
        estimateTokens(full);
      opts.onDelta(delta, full, { tokens, usage: lastUsage || undefined });
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
 * Load engines from an explicit per-agent model map.
 * Same model key → one shared runtime engine (VRAM-safe). Distinct keys →
 * one engine each. Disk weights are still one copy per model id.
 *
 * @param {Partial<Record<AgentId, string>>} [assignments]
 * @param {(p: {
 *   text: string,
 *   progress: number,
 *   engineIndex?: number,
 *   engineTotal?: number,
 *   agent?: AgentId,
 *   modelKey?: string,
 * }) => void} [onProgress]
 * @returns {Promise<{
 *   engines: Record<string, import("@mlc-ai/web-llm").MLCEngineInterface>,
 *   agentMap: Record<AgentId, {
 *     engineId: string,
 *     model: ModelInfo,
 *     engine: import("@mlc-ai/web-llm").MLCEngineInterface,
 *   }>,
 *   assignments: Record<AgentId, string>,
 *   mode: "per-agent",
 *   uniqueKeys: string[],
 * }>}
 */
export async function loadAgentAssignments(assignments, onProgress) {
  const map = setAgentAssignments(normalizeAgentAssignments(assignments));
  const uniqueKeys = uniqueAssignmentKeys(map);

  for (const key of uniqueKeys) {
    const probe = await probeModel(key);
    if (!probe.ok) {
      const err = new Error(probe.reason || "Model not available: " + key);
      err.code = "MODEL_UNAVAILABLE";
      err.model = probe.model;
      throw err;
    }
  }

  /** @type {Record<string, import("@mlc-ai/web-llm").MLCEngineInterface>} */
  const enginesByKey = {};
  /** @type {Array<import("@mlc-ai/web-llm").MLCEngineInterface | null>} */
  const loaded = [];
  const total = uniqueKeys.length;

  try {
    for (let i = 0; i < uniqueKeys.length; i++) {
      const key = uniqueKeys[i];
      const model = resolveModel(key) || MODELS[DEFAULT_MODEL_KEY];
      const agentsUsing = AGENT_IDS.filter((a) => map[a] === key);
      const agentLabel = agentsUsing.map((a) => "AGENT-" + a).join("/");
      const idx = i + 1;

      const engine = await createEngine(model, {
        onProgress: (p) => {
          const slice = (i + Math.max(0, Math.min(1, p.progress))) / total;
          if (onProgress) {
            onProgress({
              text:
                agentLabel +
                " · " +
                model.shortLabel +
                " (" +
                idx +
                "/" +
                total +
                ") · " +
                (p.text || ""),
              progress: slice,
              engineIndex: idx,
              engineTotal: total,
              agent: agentsUsing[0],
              modelKey: key,
            });
          }
        },
      });
      enginesByKey[key] = engine;
      loaded.push(engine);
      if (onProgress) {
        onProgress({
          text:
            agentLabel +
            " · " +
            model.shortLabel +
            " 準備完了 (" +
            idx +
            "/" +
            total +
            ")",
          progress: idx / total,
          engineIndex: idx,
          engineTotal: total,
          agent: agentsUsing[0],
          modelKey: key,
        });
      }
    }
  } catch (e) {
    await unloadAllEngines(loaded);
    const detail = e && e.message ? e.message : String(e);
    const err = new Error(
      "エージェント別モデルの読み込みに失敗しました（" +
        detail +
        "）。VRAM 不足の場合は同じモデルを共有するか、軽量 (0.5B) を選んでください。"
    );
    err.code = "AGENT_ASSIGN_LOAD_FAILED";
    err.cause = e;
    throw err;
  }

  /** @type {Record<AgentId, { engineId: string, model: ModelInfo, engine: import("@mlc-ai/web-llm").MLCEngineInterface }>} */
  const agentMap = {
    "00": {
      engineId: map["00"],
      model: resolveModel(map["00"]) || MODELS[DEFAULT_MODEL_KEY],
      engine: enginesByKey[map["00"]],
    },
    "01": {
      engineId: map["01"],
      model: resolveModel(map["01"]) || MODELS[DEFAULT_MODEL_KEY],
      engine: enginesByKey[map["01"]],
    },
    "02": {
      engineId: map["02"],
      model: resolveModel(map["02"]) || MODELS[DEFAULT_MODEL_KEY],
      engine: enginesByKey[map["02"]],
    },
  };

  return {
    engines: enginesByKey,
    agentMap,
    assignments: map,
    mode: "per-agent",
    uniqueKeys,
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
    const engine = await createLocalEngine(
      opts.onProgress,
      model,
      opts.prevEngine || null,
      probe.source || "local"
    );
    return { engine, model };
  }

  const engine = await createEngine(model, {
    onProgress: opts.onProgress,
    prevEngine: opts.prevEngine || null,
  });
  return { engine, model };
}

/**
 * True when WebLLM/TVM left the engine unusable (shared-engine cascade risk),
 * OR the underlying WebGPU device itself died (driver reset / TDR timeout —
 * observed in the wild as "Failed to execute 'requestDevice' on 'GPUAdapter':
 * ... DXGI_ERROR_DEVICE_REMOVED"). Both cases must trigger recoverEngine() —
 * otherwise every subsequent call in the session hits the same dead engine
 * and silently falls back to templates forever, with no way to recover short
 * of a full page reload.
 * @param {unknown} err
 */
export function isLlmDeadError(err) {
  const msg = String(
    err && typeof err === "object" && "message" in err && err.message
      ? err.message
      : err || ""
  ).toLowerCase();
  return (
    msg.includes("disposed") ||
    msg.includes("model not loaded") ||
    msg.includes("not loaded before") ||
    msg.includes("engine not ready") ||
    msg.includes("llm engine not ready") ||
    // WebGPU device loss (driver crash/reset/TDR) — requestDevice/adapter
    // failures and explicit device-lost callbacks all land here.
    msg.includes("device_removed") ||
    msg.includes("devicelost") ||
    msg.includes("device was lost") ||
    msg.includes("device lost") ||
    msg.includes("requestdevice") ||
    msg.includes("gpuadapter") ||
    msg.includes("dxgi_error") ||
    msg.includes("lost access to the gpu")
  );
}

/**
 * Serialize LLM calls — WebLLM is single-flight per engine.
 * Supports streaming via opts.onDelta(delta, fullSoFar) when stream !== false.
 * @param {{ current: import("@mlc-ai/web-llm").MLCEngineInterface | null }} engineRef
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

  return { chat, engineRef };
}

/**
 * Per-agent routing: each unique engineId gets one serialize queue.
 * Same model key → shared engineId → one queue (no cross-agent dispose race
 * from duplicate unload). On disposed / model-not-loaded, reload or recreate
 * that engine once and retry so 00/01/02 do not permanently fall to template.
 *
 * Recovery runs on the same per-engineId chain as chat, so a sibling agent
 * cannot start inference on a half-disposed shared engine.
 *
 * @param {Record<"00"|"01"|"02", {
 *   engineId: string,
 *   model: ModelInfo,
 *   engine: import("@mlc-ai/web-llm").MLCEngineInterface,
 * }>} agentMap
 * @param {{
 *   onEngineRecreated?: (
 *     engineId: string,
 *     engine: import("@mlc-ai/web-llm").MLCEngineInterface,
 *     agentMap: typeof agentMap
 *   ) => void,
 * }} [opts]
 */
export function createAgentLlmRouter(agentMap, opts = {}) {
  /** Mutable bindings — recreate updates engines in place for all sharers. */
  const map = agentMap;

  /** @type {Map<string, Promise<unknown>>} */
  const chains = new Map();
  /** @type {Map<string, Promise<import("@mlc-ai/web-llm").MLCEngineInterface>>} */
  const recovering = new Map();

  /**
   * @param {string} engineId
   * @param {() => Promise<any>} fn
   */
  function enqueue(engineId, fn) {
    const prev = chains.get(engineId) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(
      engineId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  /**
   * Point every binding that shares engineId at `engine` (00/01/02 and any
   * wolf aliases D1..D5 living on the same map).
   * @param {string} engineId
   * @param {import("@mlc-ai/web-llm").MLCEngineInterface} engine
   */
  function rebindEngine(engineId, engine) {
    for (const agent of Object.keys(map)) {
      if (map[agent]?.engineId === engineId) {
        map[agent].engine = engine;
      }
    }
    if (opts.onEngineRecreated) opts.onEngineRecreated(engineId, engine, map);
  }

  /**
   * Reload in place, or CreateMLCEngine fresh. All agents sharing engineId
   * get the new instance; never unload a sibling's distinct engine.
   *
   * Important: do NOT unload the old engine before a fresh create succeeds —
   * otherwise a failed recreate leaves every agent pointing at a dead
   * unloaded instance and the rest of the session sticks on template fallback.
   *
   * @param {string} engineId
   * @param {unknown} [cause] — original error that triggered recovery
   */
  async function recoverEngine(engineId, cause) {
    const inflight = recovering.get(engineId);
    if (inflight) return inflight;

    const work = (async () => {
      const sample = Object.keys(map)
        .map((a) => map[a])
        .find((b) => b && b.engineId === engineId);
      if (!sample) throw new Error("No engine binding for " + engineId);
      const model = sample.model;
      const old = sample.engine;
      const causeMsg = String(
        cause && typeof cause === "object" && "message" in cause && cause.message
          ? cause.message
          : cause || ""
      ).toLowerCase();
      // Disposed / not-loaded / GPU-loss engines often "succeed" at reload
      // without becoming usable — skip straight to recreate for those.
      const gpuLost =
        causeMsg.includes("device") ||
        causeMsg.includes("gpuadapter") ||
        causeMsg.includes("dxgi_error") ||
        causeMsg.includes("requestdevice") ||
        causeMsg.includes("lost access to the gpu");
      const skipReload =
        causeMsg.includes("disposed") ||
        causeMsg.includes("model not loaded") ||
        causeMsg.includes("not loaded before") ||
        gpuLost;

      if (!skipReload) {
        try {
          if (old && typeof old.reload === "function") {
            // Ensure custom models (e.g. TinySwallow) stay in appConfig after
            // any internal reset; ModelNotFoundError otherwise.
            const srcProbe = await probeModel(model);
            const src = srcProbe.source || "local";
            if (typeof old.setAppConfig === "function") {
              old.setAppConfig(buildAppConfig(model, src));
            }
            await old.reload(model.id);
            rebindEngine(engineId, old);
            return old;
          }
        } catch (e) {
          console.warn("LLM reload failed; recreating engine", engineId, e);
        }
      }

      // After GPU device loss, give the adapter a longer cool-down before requestDevice.
      if (gpuLost) {
        await new Promise((r) => setTimeout(r, 4000));
      }

      // Create fresh first; only then unload the old instance.
      // If create fails (VRAM / adapter busy), unload old, wait, and retry.
      let fresh;
      try {
        fresh = await createEngine(model, { prevEngine: null });
      } catch (createErr) {
        console.warn(
          "LLM recreate failed with old engine still held; unloading then retry",
          engineId,
          createErr
        );
        try {
          await unloadEngine(old);
        } catch (_) {
          /* already disposed */
        }
        await new Promise((r) => setTimeout(r, gpuLost ? 5000 : 800));
        try {
          fresh = await createEngine(model, { prevEngine: null });
        } catch (createErr2) {
          // One more delayed attempt — mid-session DXGI_ERROR often clears
          // after a few seconds.
          console.warn(
            "LLM recreate retry failed; final delayed attempt",
            engineId,
            createErr2
          );
          await new Promise((r) => setTimeout(r, gpuLost ? 8000 : 3500));
          fresh = await createEngine(model, { prevEngine: null });
        }
      }
      rebindEngine(engineId, fresh);
      if (old && old !== fresh) {
        try {
          await unloadEngine(old);
        } catch (_) {
          /* already disposed */
        }
      }
      return fresh;
    })().finally(() => {
      recovering.delete(engineId);
    });

    recovering.set(engineId, work);
    return work;
  }

  /**
   * @param {"00"|"01"|"02"|string} agent
   * @param {Array<{ role: string, content: string }>} messages
   * @param {object} [chatOpts]
   */
  async function chat(agent, messages, chatOpts = {}) {
    const binding = map[agent];
    if (!binding || !binding.engine) {
      throw new Error("No engine bound for AGENT-" + agent);
    }
    const engineId = binding.engineId;

    return enqueue(engineId, async () => {
      // Another recover may already be finishing on this chain.
      const pending = recovering.get(engineId);
      if (pending) await pending;

      const eng = map[agent]?.engine;
      if (!eng) throw new Error("No engine bound for AGENT-" + agent);

      const optsWithModel = { ...chatOpts, model: binding.model };
      try {
        return await generateWithEngine(eng, messages, optsWithModel);
      } catch (e) {
        if (!isLlmDeadError(e)) throw e;
        console.warn(
          "LLM engine dead for",
          engineId,
          "— recovering and retrying once:",
          e && e.message ? e.message : e
        );
        await recoverEngine(engineId, e);
        const again = map[agent]?.engine;
        if (!again) throw e;
        try {
          return await generateWithEngine(again, messages, {
            ...optsWithModel,
            model: map[agent]?.model || binding.model,
          });
        } catch (e2) {
          // Reload path can leave a still-dead engine; force a full recreate once.
          if (!isLlmDeadError(e2)) throw e2;
          console.warn(
            "LLM still dead after recover for",
            engineId,
            "— forcing recreate:",
            e2 && e2.message ? e2.message : e2
          );
          await recoverEngine(engineId, e2);
          const last = map[agent]?.engine;
          if (!last) throw e2;
          return generateWithEngine(last, messages, {
            ...optsWithModel,
            model: map[agent]?.model || binding.model,
          });
        }
      }
    });
  }

  function infoFor(agent) {
    const binding = map[agent];
    if (!binding) return null;
    return {
      agent,
      engineId: binding.engineId,
      modelKey: binding.model.key,
      modelId: binding.model.id,
      shortLabel: binding.model.shortLabel,
    };
  }

  return { chat, infoFor, agentMap: map, recoverEngine };
}

export function driftTemperature(level) {
  return Math.min(1.35, 0.35 + level * 0.28);
}

export function driftLabel(level) {
  return ["忠実", "軽微な補完", "自信ある逸脱", "過信ハルシネーション"][level] || "ドリフト";
}

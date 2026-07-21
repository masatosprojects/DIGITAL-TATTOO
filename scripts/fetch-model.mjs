/**
 * Developer-only: download WebLLM model artifacts into public/models/
 * so the art can run fully offline from same-origin paths.
 *
 * Usage (needs network once):
 *   npm run fetch-model            # default Qwen 1.5B (~840 MB)
 *   npm run fetch-model:pages      # lite 0.5B + swallow 1.5B full weights + remote WASM libs (Pages CI)
 *   npm run fetch-model:hq         # 3B
 *   npm run fetch-model:swallow    # TinySwallow JP (optional local pack)
 *   npm run fetch-model:gemma-jpn  # Gemma2-JPN (optional)
 *   npm run fetch-model:extras     # swallow + gemma-jpn
 *   npm run fetch-model -- --all   # Qwen hq+default+lite (~2.8 GB)
 *
 * Runtime prefers same-origin; missing models may load via HF + IndexedDB.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_ROOT = path.join(ROOT, "public", "models");

const WASM_BASE =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/";
const WASM_JSDELIVR =
  "https://cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@main/web-llm-models/v0_2_84/base/";

/**
 * Models must match @mlc-ai/web-llm 0.2.84 prebuilt list (v0_2_84 wasm).
 * Keep in sync with js/llm.js
 */
export const MODELS = {
  hq: {
    key: "hq",
    rank: 1,
    label: "高精度 Qwen 3B（要VRAM）",
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC",
    wasmName: "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 2505,
    approxDownloadMB: 1670,
    usable: "maybe",
    license: "Qwen Research",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  "gemma-jpn": {
    key: "gemma-jpn",
    rank: 2,
    label: "Gemma2 2B-JPN（system不可）",
    id: "gemma-2-2b-jpn-it-q4f16_1-MLC",
    hfRepo: "mlc-ai/gemma-2-2b-jpn-it-q4f16_1-MLC",
    wasmName: "gemma-2-2b-jpn-it-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "gemma-2-2b-jpn-it-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 1895,
    approxDownloadMB: 1400,
    usable: "maybe",
    license: "Gemma",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  swallow: {
    key: "swallow",
    rank: 3,
    label: "TinySwallow 1.5B（JP特化）· 推奨",
    id: "TinySwallow-1.5B-Instruct-q4f32_1-MLC",
    hfRepo: "SakanaAI/TinySwallow-1.5B-Instruct-q4f32_1-MLC",
    wasmName: "Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm",
    vramMB: 1889,
    approxDownloadMB: 830,
    usable: "yes",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  default: {
    key: "default",
    rank: 4,
    label: "標準 Qwen 1.5B（もともとの標準）",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    wasmName: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 1630,
    approxDownloadMB: 840,
    usable: "yes",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  "qwen3-1.7b": {
    key: "qwen3-1.7b",
    rank: 4.5,
    label: "Qwen3 1.7B（新世代・多言語強化）",
    id: "Qwen3-1.7B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3-1.7B-q4f16_1-MLC",
    wasmName: "Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 2037,
    approxDownloadMB: 984,
    usable: "yes",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  "qwen3-0.6b": {
    key: "qwen3-0.6b",
    rank: 5.5,
    label: "Qwen3 0.6B（軽量・新世代）",
    id: "Qwen3-0.6B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3-0.6B-q4f16_1-MLC",
    wasmName: "Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 1403,
    approxDownloadMB: 335,
    usable: "yes",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  ministral3b: {
    key: "ministral3b",
    rank: 1.2,
    label: "Ministral 3 3B Instruct（新世代・多言語）",
    id: "Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC",
    hfRepo: "mlc-ai/Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC",
    wasmName: "Ministral-3-3B-Instruct-2512-BF16-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Ministral-3-3B-Instruct-2512-BF16-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 2864,
    approxDownloadMB: 1856,
    usable: "maybe",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  "llama32-3b": {
    key: "llama32-3b",
    rank: 1.5,
    label: "Llama 3.2 3B Instruct（日本語は弱め）",
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC",
    wasmName: "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 2264,
    approxDownloadMB: 1733,
    usable: "maybe",
    license: "Llama 3.2 Community License",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  "qwen35-2b": {
    key: "qwen35-2b",
    rank: 4.7,
    label: "Qwen3.5 2B（最新世代・多言語強化）",
    id: "Qwen3.5-2B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3.5-2B-q4f16_1-MLC",
    wasmName: "Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 2245,
    approxDownloadMB: 1032,
    usable: "yes",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  "qwen35-0.8b": {
    key: "qwen35-0.8b",
    rank: 5.7,
    label: "Qwen3.5 0.8B（最新世代・軽量）",
    id: "Qwen3.5-0.8B-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen3.5-0.8B-q4f16_1-MLC",
    wasmName: "Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 1629,
    approxDownloadMB: 426,
    usable: "yes",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  "llama32-1b": {
    key: "llama32-1b",
    rank: 6,
    label: "Llama 3.2 1B Instruct（日本語は弱め）",
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
    wasmName: "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 879,
    approxDownloadMB: 672,
    usable: "yes",
    license: "Llama 3.2 Community License",
    hfCompatPrefix: path.join("resolve", "main"),
  },
  lite: {
    key: "lite",
    rank: 7,
    label: "軽量 Qwen 0.5B",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    wasmName: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl: WASM_BASE + "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 945,
    approxDownloadMB: 280,
    usable: "yes",
    license: "Apache-2.0",
    hfCompatPrefix: path.join("resolve", "main"),
  },
};

/** Ordered keys for --all (Qwen pack; JP extras are opt-in). */
export const ALL_KEYS = ["hq", "default", "lite"];
/** Optional remote-friendly JP / newer-gen / lighter-weight models (opt-in). */
export const EXTRA_KEYS = [
  "swallow",
  "gemma-jpn",
  "qwen3-1.7b",
  "qwen3-0.6b",
  "qwen35-2b",
  "qwen35-0.8b",
  "ministral3b",
  "llama32-3b",
  "llama32-1b",
];
/**
 * Pages CI: full lite weights + WASM libs for HF-remote models (~20 MB libs).
 * Avoids raw.githubusercontent.com failures when loading TinySwallow / 1.5B on Pages.
 */
export const PAGES_WASM_KEYS = [
  "default",
  "swallow",
  "hq",
  "gemma-jpn",
  "qwen3-1.7b",
  "qwen3-0.6b",
  "qwen35-2b",
  "qwen35-0.8b",
  "ministral3b",
  "llama32-3b",
  "llama32-1b",
];

/** @deprecated use MODELS.default */
export const MODEL = MODELS.default;

const SKIP_NAMES = new Set([".gitattributes", "README.md"]);

function hfResolve(repo, filePath) {
  return `https://huggingface.co/${repo}/resolve/main/${filePath}`;
}

/** List all files under HF repo (flat + recursive). */
async function listHfFiles(repo) {
  const url = `https://huggingface.co/api/models/${repo}/tree/main?recursive=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF tree failed: ${res.status} ${url}`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error("Unexpected HF tree response");
  return items.filter(
    (it) => it.type === "file" && it.path && !SKIP_NAMES.has(path.posix.basename(it.path))
  );
}

async function download(url, dest, label) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (st.size > 0) {
      console.log(`  skip (exists): ${label} (${(st.size / (1024 * 1024)).toFixed(1)} MB)`);
      return st.size;
    }
  }
  console.log(`  fetching: ${label}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);

  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(dest, buf);
    console.log(`  wrote ${(buf.length / (1024 * 1024)).toFixed(1)} MB → ${path.relative(ROOT, dest)}`);
    return buf.length;
  }

  const chunks = [];
  let received = 0;
  let lastPct = -1;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    received += value.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct >= lastPct + 10 || pct === 100) {
        process.stdout.write(`\r  … ${pct}% (${(received / (1024 * 1024)).toFixed(1)} MB)`);
        lastPct = pct;
      }
    }
  }
  if (total > 0) process.stdout.write("\n");
  const buf = Buffer.concat(chunks);
  await fs.promises.writeFile(dest, buf);
  console.log(`  wrote ${(buf.length / (1024 * 1024)).toFixed(1)} MB → ${path.relative(ROOT, dest)}`);
  return buf.length;
}

function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirSizeBytes(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

/**
 * Older builds stored files flat under models/<id>/. WebLLM requests
 * models/<id>/resolve/main/… — move flat files into that folder once.
 */
async function migrateFlatLayout(modelDir, weightsDir) {
  const flatConfig = path.join(modelDir, "mlc-chat-config.json");
  const nestedConfig = path.join(weightsDir, "mlc-chat-config.json");
  if (!fs.existsSync(flatConfig) || fs.existsSync(nestedConfig)) return;

  console.log("Migrating flat model layout → resolve/main/ (WebLLM URL layout)...");
  await fs.promises.mkdir(weightsDir, { recursive: true });
  for (const name of fs.readdirSync(modelDir)) {
    if (name === "resolve") continue;
    const src = path.join(modelDir, name);
    const dest = path.join(weightsDir, name);
    await fs.promises.rename(src, dest);
    console.log(`  moved ${name}`);
  }
}

async function fetchOne(model) {
  console.log(`── ${model.label} ──`);
  console.log(`  model_id: ${model.id}`);
  console.log(
    `  ≈${model.approxDownloadMB} MB download · ~${model.vramMB} MB VRAM · usable=${model.usable}`
  );
  console.log(`  license: ${model.license}`);
  console.log(`  weights layout: models/${model.id}/resolve/main/`);
  console.log("");

  const modelDir = path.join(OUT_ROOT, model.id);
  const weightsDir = path.join(modelDir, model.hfCompatPrefix);
  const libDir = path.join(OUT_ROOT, "libs");

  await migrateFlatLayout(modelDir, weightsDir);
  await fs.promises.mkdir(weightsDir, { recursive: true });

  const files = await listHfFiles(model.hfRepo);
  console.log(`HF files: ${files.length}`);
  let bytes = 0;
  for (const f of files) {
    const dest = path.join(weightsDir, f.path);
    bytes += await download(hfResolve(model.hfRepo, f.path), dest, f.path);
  }

  console.log("");
  console.log("WASM model library:");
  bytes += await download(model.wasmUrl, path.join(libDir, model.wasmName), model.wasmName);

  const configPath = path.join(weightsDir, "mlc-chat-config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing ${path.relative(ROOT, configPath)} after fetch — aborting.`
    );
  }

  // web-llm 0.2.84 unconditionally fetches tensor-cache.json during load —
  // older community compiles (e.g. SakanaAI/TinySwallow, built with an older
  // mlc_llm toolchain) only shipped the equivalent ndarray-cache.json under
  // the old filename. Both files use the identical raw-shard record schema
  // (verified byte-identical against mlc-ai's own Qwen2.5-1.5B-q4f32 build,
  // which ships both names with matching content) — so mirroring the file
  // under the new name is a safe, mechanical fix, not a data guess.
  const ndarrayCachePath = path.join(weightsDir, "ndarray-cache.json");
  const tensorCachePath = path.join(weightsDir, "tensor-cache.json");
  if (fs.existsSync(ndarrayCachePath) && !fs.existsSync(tensorCachePath)) {
    await fs.promises.copyFile(ndarrayCachePath, tensorCachePath);
    console.log(
      `  patched: tensor-cache.json missing upstream — mirrored from ndarray-cache.json`
    );
  }

  console.log("");
  return { model, bytes };
}


/** Download one WASM, trying jsDelivr then raw.githubusercontent. */
async function downloadWasm(wasmName, dest) {
  const urls = [WASM_JSDELIVR + wasmName, WASM_BASE + wasmName];
  let lastErr;
  for (const url of urls) {
    try {
      return await download(url, dest, wasmName);
    } catch (e) {
      lastErr = e;
      console.warn(`  wasm fetch failed (${url}): ${e.message || e}`);
    }
  }
  throw lastErr || new Error("WASM download failed: " + wasmName);
}

/** Ship WASM only (no HF weights) — for Pages remote-model support. */
async function fetchWasmOnly(model) {
  const libDir = path.join(OUT_ROOT, "libs");
  await fs.promises.mkdir(libDir, { recursive: true });
  console.log(`── WASM only · ${model.label} → ${model.wasmName} ──`);
  const bytes = await downloadWasm(model.wasmName, path.join(libDir, model.wasmName));
  return { model, bytes };
}

function normalizeKey(raw) {
  const a = String(raw || "").replace(/^--/, "").toLowerCase();
  if (a === "plus" || a === "1.5b" || a === "1.5" || a === "qwen15") return "default";
  if (a === "0.5b" || a === "0.5" || a === "small" || a === "light") return "lite";
  if (a === "3b" || a === "high" || a === "quality") return "hq";
  if (a === "tinyswallow" || a === "sakana" || a === "jp") return "swallow";
  if (a === "gemma" || a === "gemma2" || a === "gemma-jpn" || a === "jpn") return "gemma-jpn";
  return a;
}

function parseTargets(argv) {
  const args = argv.slice(2).filter((a) => a !== "--");
  if (args.includes("--all") || args.includes("all")) {
    return { full: ALL_KEYS.slice(), wasmOnly: [] };
  }
  if (args.includes("--extras") || args.includes("extras")) {
    return { full: EXTRA_KEYS.slice(), wasmOnly: [] };
  }
  if (args.length === 0) return { full: ["default"], wasmOnly: [] };

  /** @type {string[]} */
  const keys = [];
  let pages = false;
  for (const raw of args) {
    const k = normalizeKey(raw);
    if (k === "all") return { full: ALL_KEYS.slice(), wasmOnly: [] };
    if (k === "extras") return { full: EXTRA_KEYS.slice(), wasmOnly: [] };
    if (k === "pages") {
      pages = true;
      continue;
    }
    if (!MODELS[k]) {
      throw new Error(
        `Unknown args: ${args.join(" ")}\n` +
          `Usage: fetch-model.mjs [|default|lite|hq|swallow|gemma-jpn|pages|--all|--extras]\n` +
          `  (aliases: plus→default, 0.5b→lite, 3b→hq, tinyswallow→swallow)\n` +
          `  pages = lite weights + WASM libs for remote models (TinySwallow/1.5B/…)`
      );
    }
    if (!keys.includes(k)) keys.push(k);
  }
  if (pages) {
    // "swallow" ships full weights same-origin too (not wasm-only): its HF
    // repo lacks tensor-cache.json, which web-llm 0.2.84 requires to load —
    // remote HF+IndexedDB loading is permanently broken for it, so Pages
    // must serve its own (patched) copy same-origin.
    const full = keys.slice();
    for (const need of ["lite", "swallow"]) {
      if (!full.includes(need)) full.push(need);
    }
    const wasmOnly = PAGES_WASM_KEYS.filter((k) => !full.includes(k));
    return { full, wasmOnly };
  }
  return { full: keys, wasmOnly: [] };
}

async function main() {
  const { full, wasmOnly } = parseTargets(process.argv);
  const selected = full.map((k) => {
    const m = MODELS[k];
    if (!m) throw new Error(`Unknown model key: ${k}`);
    return m;
  });
  const wasmModels = wasmOnly.map((k) => {
    const m = MODELS[k];
    if (!m) throw new Error(`Unknown model key: ${k}`);
    return m;
  });

  const totalApprox =
    selected.reduce((s, m) => s + m.approxDownloadMB, 0) + wasmModels.length * 5;
  console.log(`DIGITAL TATTOO — fetch model`);
  console.log(`  targets: ${selected.map((m) => m.key).join(", ") || "(none)"}`);
  if (wasmModels.length) {
    console.log(
      `  wasm-only: ${wasmModels.map((m) => m.key).join(", ")} (~${wasmModels.length * 5} MB)`
    );
  }
  console.log(`  ≈${totalApprox} MB download total`);
  console.log(`  out: ${path.relative(ROOT, OUT_ROOT)}`);
  if (totalApprox > 1000) {
    console.log(
      "  note: total exceeds GitHub Pages soft comfort (~1 GB). Prefer Netlify / self-host for multi-model packs."
    );
  }
  if (full.includes("hq") || wasmOnly.includes("hq")) {
    console.log(
      "  note: 3B is Qwen Research license (not Apache-2.0) and needs ~2.5 GB VRAM — usable=maybe."
    );
  }
  console.log("");

  await fs.promises.mkdir(OUT_ROOT, { recursive: true });

  let bytes = 0;
  const fetched = [];
  for (const model of selected) {
    const result = await fetchOne(model);
    bytes += result.bytes;
    fetched.push({
      key: model.key,
      rank: model.rank,
      model_id: model.id,
      model_dir: `models/${model.id}/resolve/main/`,
      model_lib: `models/libs/${model.wasmName}`,
      vram_required_MB: model.vramMB,
      approx_download_MB: model.approxDownloadMB,
      usable: model.usable,
      license: model.license,
    });
  }
  for (const model of wasmModels) {
    const result = await fetchWasmOnly(model);
    bytes += result.bytes;
    fetched.push({
      key: model.key + ":wasm",
      rank: model.rank,
      model_id: model.id,
      model_lib: `models/libs/${model.wasmName}`,
      vram_required_MB: model.vramMB,
      approx_download_MB: 5,
      usable: model.usable,
      license: model.license,
    });
  }

  // Detect which models are already on disk (for manifest completeness)
  const present = [];
  for (const m of Object.values(MODELS)) {
    const cfg = path.join(OUT_ROOT, m.id, "resolve", "main", "mlc-chat-config.json");
    const wasm = path.join(OUT_ROOT, "libs", m.wasmName);
    if (fs.existsSync(cfg) && fs.existsSync(wasm)) {
      present.push(m.key);
    }
  }

  const manifest = {
    default_model_id: MODELS.default.id,
    default_key: "default",
    catalog_keys: ALL_KEYS,
    fetched_at: new Date().toISOString(),
    fetched_this_run: fetched,
    present_keys: present,
    approx_size_MB: Math.round(dirSizeBytes(OUT_ROOT) / (1024 * 1024)),
    note:
      "Runtime prefers same-origin …/resolve/main/; missing weights may use HF+IndexedDB. " +
      "Pages CI ships lite + swallow (recommended default) full weights same-origin; " +
      "other models load via HF+IndexedDB on first use.",
    deploy_size_note:
      "lite≈280MB + swallow≈830MB + remote WASM libs≈20MB same-origin (≈1.1GB). " +
      "swallow ships full weights because its HF repo lacks tensor-cache.json " +
      "(web-llm 0.2.84 requires it; remote HF loading is broken for it otherwise).",
  };
  await fs.promises.writeFile(
    path.join(OUT_ROOT, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  console.log("");
  console.log(
    `Done. Local models/ ≈ ${manifest.approx_size_MB} MB (downloaded chunk sum ${(bytes / (1024 * 1024)).toFixed(0)} MB).`
  );
  console.log(`Present: ${present.join(", ") || "(none)"}`);
  console.log("Next (publisher): npm run build  →  upload entire dist/ (includes dist/models/).");
  console.log("Or double-click 公開準備.bat — visitors only open the HTTPS URL.");
  console.log("Concept: 育ちは文脈であり重み更新ではない — inference only.");
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

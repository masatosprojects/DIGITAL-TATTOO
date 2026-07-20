/**
 * Developer-only: download WebLLM model artifacts into public/models/
 * so the art can run fully offline from same-origin paths.
 *
 * Usage (needs network once):
 *   npm run fetch-model            # default 1.5B only (~840 MB) — CI / Pages
 *   npm run fetch-model:lite       # 0.5B only (~280 MB)
 *   npm run fetch-model:hq         # 3B only (~1.7 GB) — Netlify / strong GPU
 *   npm run fetch-model -- --all   # all three (~2.8 GB)
 *   node scripts/fetch-model.mjs lite
 *   node scripts/fetch-model.mjs hq
 *   node scripts/fetch-model.mjs default
 *
 * Runtime never calls this — only serves files already under public/models/.
 *
 * Layout note (critical):
 *   @mlc-ai/web-llm cleanModelUrl() appends `resolve/main/` unless the model
 *   URL already contains `/resolve/<branch>/`. We store weights under
 *   `public/models/<id>/resolve/main/` so same-origin static hosting matches
 *   what WebLLM requests — never Hugging Face at runtime.
 *
 * Size honesty (q4f16_1 weights from HF tree, wasm extra):
 *   lite 0.5B  ≈ 280 MB  · VRAM ≈ 0.95 GB · usable yes
 *   default 1.5B ≈ 840 MB · VRAM ≈ 1.6 GB · usable yes ← CI default
 *   hq 3B      ≈ 1.7 GB  · VRAM ≈ 2.5 GB · usable maybe · Pages NO
 *   all three  ≈ 2.8 GB  → far over GitHub Pages soft 1 GB
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_ROOT = path.join(ROOT, "public", "models");

const WASM_BASE =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/";

/**
 * Models must match @mlc-ai/web-llm 0.2.84 prebuilt list (v0_2_84 wasm).
 * Keep in sync with js/llm.js
 */
export const MODELS = {
  hq: {
    key: "hq",
    rank: 1,
    label: "高精度 (3B・要VRAM)",
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
  default: {
    key: "default",
    rank: 2,
    label: "標準 (1.5B) · 推奨",
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
  lite: {
    key: "lite",
    rank: 3,
    label: "軽量 (0.5B)",
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

/** Ordered keys for --all (rank order). */
export const ALL_KEYS = ["hq", "default", "lite"];

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

  console.log("");
  return { model, bytes };
}

function normalizeKey(raw) {
  const a = String(raw || "").replace(/^--/, "").toLowerCase();
  if (a === "plus" || a === "1.5b" || a === "1.5") return "default";
  if (a === "0.5b" || a === "0.5" || a === "small" || a === "light") return "lite";
  if (a === "3b" || a === "high" || a === "quality") return "hq";
  return a;
}

function parseTargets(argv) {
  const args = argv.slice(2).filter((a) => a !== "--");
  if (args.includes("--all") || args.includes("all")) {
    return ALL_KEYS.slice();
  }
  if (args.length === 0) return ["default"];

  const keys = [];
  for (const raw of args) {
    const k = normalizeKey(raw);
    if (k === "all") return ALL_KEYS.slice();
    if (!MODELS[k]) {
      throw new Error(
        `Unknown args: ${args.join(" ")}\n` +
          `Usage: fetch-model.mjs [|default|lite|hq|--all]\n` +
          `  (aliases: plus→default, 0.5b→lite, 3b→hq)`
      );
    }
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

async function main() {
  const keys = parseTargets(process.argv);
  const selected = keys.map((k) => {
    const m = MODELS[k];
    if (!m) throw new Error(`Unknown model key: ${k}`);
    return m;
  });

  const totalApprox = selected.reduce((s, m) => s + m.approxDownloadMB, 0);
  console.log(`DIGITAL TATTOO — fetch model`);
  console.log(`  targets: ${selected.map((m) => m.key).join(", ")}`);
  console.log(`  ≈${totalApprox} MB download total`);
  console.log(`  out: ${path.relative(ROOT, OUT_ROOT)}`);
  if (totalApprox > 1000) {
    console.log(
      "  note: total exceeds GitHub Pages soft comfort (~1 GB). Prefer Netlify / self-host for multi-model packs."
    );
  }
  if (keys.includes("hq")) {
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
      "Runtime loads via same-origin …/resolve/main/ only. CI fetches default (1.5B); lite/hq optional. No HF CDN at runtime.",
    deploy_size_note:
      "Default 1.5B ≈ 840 MB (Pages OK). Lite ≈ 280 MB. HQ 3B ≈ 1.7 GB (Pages NO). All ≈ 2.8 GB — Netlify/full local only.",
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

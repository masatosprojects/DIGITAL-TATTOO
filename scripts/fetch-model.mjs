/**
 * Developer-only: download WebLLM model artifacts into public/models/
 * so the art can run fully offline from same-origin paths.
 *
 * Usage (needs network once):
 *   npm run fetch-model            # default 0.5B only (~300 MB)
 *   npm run fetch-model:plus       # plus 1.5B only (~830 MB)
 *   npm run fetch-model -- --all   # both (~1.1 GB)
 *   node scripts/fetch-model.mjs --all
 *   node scripts/fetch-model.mjs plus
 *
 * Runtime never calls this — only serves files already under public/models/.
 *
 * Layout note (critical):
 *   @mlc-ai/web-llm cleanModelUrl() appends `resolve/main/` unless the model
 *   URL already contains `/resolve/<branch>/`. We store weights under
 *   `public/models/<id>/resolve/main/` so same-origin static hosting matches
 *   what WebLLM requests — never Hugging Face at runtime.
 *
 * Size honesty:
 *   Default alone ≈ 300 MB → fine for GitHub Pages (~1 GB soft).
 *   Both models ≈ 1.1 GB → exceeds comfortable Pages deploy; keep CI on
 *   default only. Plus is for local / Netlify full deploys.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_ROOT = path.join(ROOT, "public", "models");

/**
 * Models must match @mlc-ai/web-llm 0.2.84 prebuilt list (v0_2_84 wasm).
 * Keep in sync with js/llm.js
 */
export const MODELS = {
  default: {
    key: "default",
    label: "標準 (0.5B)",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    wasmName: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl:
      "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 945,
    approxDownloadMB: 300,
    hfCompatPrefix: path.join("resolve", "main"),
  },
  plus: {
    key: "plus",
    label: "日本語プラス (1.5B)",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    hfRepo: "mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    wasmName: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    wasmUrl:
      "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    vramMB: 1630,
    approxDownloadMB: 830,
    hfCompatPrefix: path.join("resolve", "main"),
  },
};

/** @deprecated use MODELS.default — kept for older imports */
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
  console.log(`  ≈${model.approxDownloadMB} MB download · ~${model.vramMB} MB VRAM`);
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

function parseTargets(argv) {
  const args = argv.slice(2).filter((a) => a !== "--");
  if (args.includes("--all") || args.includes("all")) {
    return ["default", "plus"];
  }
  if (args.includes("--plus") || args.includes("plus")) {
    return ["plus"];
  }
  if (args.includes("--default") || args.includes("default")) {
    return ["default"];
  }
  if (args.length === 0) return ["default"];
  throw new Error(
    `Unknown args: ${args.join(" ")}\n` +
      `Usage: fetch-model.mjs [|default|plus|--all]`
  );
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
  if (keys.includes("plus") && keys.includes("default")) {
    console.log(
      "  note: both models ≈ 1.1 GB — may exceed GitHub Pages comfort (1 GB soft)."
    );
  } else if (keys.includes("plus") && !keys.includes("default")) {
    console.log(
      "  note: plus-only. Default 0.5B still recommended for Pages / fallback."
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
      model_id: model.id,
      model_dir: `models/${model.id}/resolve/main/`,
      model_lib: `models/libs/${model.wasmName}`,
      vram_required_MB: model.vramMB,
      approx_download_MB: model.approxDownloadMB,
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
    plus_model_id: MODELS.plus.id,
    fetched_at: new Date().toISOString(),
    fetched_this_run: fetched,
    present_keys: present,
    approx_size_MB: Math.round(dirSizeBytes(OUT_ROOT) / (1024 * 1024)),
    note:
      "Runtime loads via same-origin …/resolve/main/ only. CI fetches default; plus is optional (npm run fetch-model:plus). No HF CDN at runtime.",
    deploy_size_note:
      "Default alone ≈ 300 MB (Pages OK). Plus alone ≈ 830 MB. Both ≈ 1.1 GB — over GitHub Pages soft comfort; prefer Netlify/full local for dual.",
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

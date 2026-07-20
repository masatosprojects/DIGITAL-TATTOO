/**
 * Developer-only: download WebLLM model artifacts into public/models/
 * so the art can run fully offline from same-origin paths.
 *
 * Usage (needs network once):
 *   npm run fetch-model
 *   .\scripts\fetch-model.ps1
 *
 * Runtime never calls this — only serves files already under public/models/.
 *
 * Layout note (critical):
 *   @mlc-ai/web-llm cleanModelUrl() appends `resolve/main/` unless the model
 *   URL already contains `/resolve/<branch>/`. We store weights under
 *   `public/models/<id>/resolve/main/` so same-origin static hosting matches
 *   what WebLLM requests — never Hugging Face at runtime.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_ROOT = path.join(ROOT, "public", "models");

/**
 * Small Instruct model with usable Japanese (~300 MB).
 * model_lib must match @mlc-ai/web-llm prebuilt generation (v0_2_84).
 * Keep in sync with js/llm.js
 */
export const MODEL = {
  id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  hfRepo: "mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  wasmName: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  wasmUrl:
    "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  vramMB: 945,
  approxDownloadMB: 300,
  /** Must match WebLLM cleanModelUrl branch segment. */
  hfCompatPrefix: path.join("resolve", "main"),
};

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

async function main() {
  console.log(`DIGITAL TATTOO — fetch model`);
  console.log(`  model_id: ${MODEL.id}`);
  console.log(`  ≈${MODEL.approxDownloadMB} MB download · ~${MODEL.vramMB} MB VRAM`);
  console.log(`  out: ${path.relative(ROOT, OUT_ROOT)}`);
  console.log(`  weights layout: models/${MODEL.id}/resolve/main/  (WebLLM cleanModelUrl)`);
  console.log("");

  await fs.promises.mkdir(OUT_ROOT, { recursive: true });

  const modelDir = path.join(OUT_ROOT, MODEL.id);
  const weightsDir = path.join(modelDir, MODEL.hfCompatPrefix);
  const libDir = path.join(OUT_ROOT, "libs");

  await migrateFlatLayout(modelDir, weightsDir);
  await fs.promises.mkdir(weightsDir, { recursive: true });

  const files = await listHfFiles(MODEL.hfRepo);
  console.log(`HF files: ${files.length}`);
  let bytes = 0;
  for (const f of files) {
    const dest = path.join(weightsDir, f.path);
    bytes += await download(hfResolve(MODEL.hfRepo, f.path), dest, f.path);
  }

  console.log("");
  console.log("WASM model library:");
  bytes += await download(MODEL.wasmUrl, path.join(libDir, MODEL.wasmName), MODEL.wasmName);

  const configPath = path.join(weightsDir, "mlc-chat-config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing ${path.relative(ROOT, configPath)} after fetch — aborting.`
    );
  }

  const manifest = {
    model_id: MODEL.id,
    fetched_at: new Date().toISOString(),
    model_dir: `models/${MODEL.id}/resolve/main/`,
    model_lib: `models/libs/${MODEL.wasmName}`,
    vram_required_MB: MODEL.vramMB,
    approx_size_MB: Math.round(dirSizeBytes(OUT_ROOT) / (1024 * 1024)),
    note:
      "Runtime loads these via same-origin relative URLs only (…/resolve/main/ layout required by WebLLM). No weight updates. No HF CDN at runtime.",
  };
  await fs.promises.writeFile(
    path.join(OUT_ROOT, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  console.log("");
  console.log(
    `Done. Local models/ ≈ ${manifest.approx_size_MB} MB (downloaded chunk sum ${(bytes / (1024 * 1024)).toFixed(0)} MB).`
  );
  console.log("Next (publisher): npm run build  →  upload entire dist/ (includes dist/models/).");
  console.log("Or double-click 公開準備.bat — visitors only open the HTTPS URL.");
  console.log("Concept: 育ちは文脈であり重み更新ではない — inference only.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

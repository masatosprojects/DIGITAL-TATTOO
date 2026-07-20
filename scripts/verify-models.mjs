/**
 * Verify same-origin model layout required by WebLLM (resolve/main/).
 * Used by 公開準備.bat, npm scripts, and GitHub Actions.
 *
 * Checks public/models by default; pass "dist" to check build output.
 *
 * By default, 1.5B (default) is required.
 * GitHub Pages CI uses: --require-lite --allow-missing-default
 *   (0.5B shards stay under ~100 MB; 1.5B shard0 ≈111 MB breaks Cache.add on Pages)
 * hq (3B) is optional — verified only if present or --require-hq.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MODELS = {
  default: {
    key: "default",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    minMB: 500,
  },
  lite: {
    key: "lite",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    minMB: 200,
  },
  hq: {
    key: "hq",
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    minMB: 1200,
  },
};

const args = process.argv.slice(2).filter((a) => a !== "--");
const requireLite = args.includes("--require-lite");
const requireHq = args.includes("--require-hq");
const requirePlus = args.includes("--require-plus"); // legacy alias → default already required
const allowMissingDefault = args.includes("--allow-missing-default");
const targetArg = args.find((a) => !a.startsWith("--")) || "public";
const target = targetArg.replace(/[/\\]+$/, "");
const modelsRoot = path.join(ROOT, target, "models");
const PAGES_MAX_SHARD_BYTES = 100 * 1024 * 1024;

function fail(msg) {
  console.error(`[verify-models] FAIL (${target}): ${msg}`);
  process.exit(1);
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

function isPresent(model) {
  const configPath = path.join(
    modelsRoot,
    model.id,
    "resolve",
    "main",
    "mlc-chat-config.json"
  );
  const wasmPath = path.join(modelsRoot, "libs", model.wasm);
  return fs.existsSync(configPath) && fs.existsSync(wasmPath);
}

function checkModel(model, { required }) {
  const configPath = path.join(
    modelsRoot,
    model.id,
    "resolve",
    "main",
    "mlc-chat-config.json"
  );
  const wasmPath = path.join(modelsRoot, "libs", model.wasm);
  const legacyFlatConfig = path.join(modelsRoot, model.id, "mlc-chat-config.json");
  const modelDir = path.join(modelsRoot, model.id);
  const weightsDir = path.join(modelDir, "resolve", "main");
  const ndarrayCachePath = path.join(weightsDir, "ndarray-cache.json");

  if (fs.existsSync(legacyFlatConfig) && !fs.existsSync(configPath)) {
    fail(
      `legacy flat layout detected at models/${model.id}/mlc-chat-config.json. ` +
        `WebLLM needs models/${model.id}/resolve/main/mlc-chat-config.json — ` +
        `re-run npm run fetch-model (do not ship flat weights).`
    );
  }

  const present = isPresent(model);
  if (!present) {
    if (required) {
      const hint =
        model.key === "hq"
          ? "run npm run fetch-model:hq"
          : model.key === "lite"
            ? "run npm run fetch-model:lite"
            : "run npm run fetch-model";
      fail(
        `missing ${path.relative(ROOT, configPath)} or wasm — ${hint}. ` +
          `Build must fail if resolve/main config is absent (would 404 on Pages).`
      );
    }
    return { key: model.key, present: false };
  }

  // Ensure config is real JSON (not an HTML placeholder)
  let configRaw;
  try {
    configRaw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(configRaw);
    if (!parsed.model_type) {
      fail(`${path.relative(ROOT, configPath)} lacks model_type — not a valid MLC config`);
    }
  } catch (e) {
    fail(`${path.relative(ROOT, configPath)} is not valid JSON: ${e.message}`);
  }

  if (!fs.existsSync(ndarrayCachePath)) {
    fail(`missing ${path.relative(ROOT, ndarrayCachePath)} — incomplete fetch`);
  }

  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(ndarrayCachePath, "utf8"));
  } catch (e) {
    fail(`ndarray-cache.json unreadable: ${e.message}`);
  }

  const dataPaths = new Set();
  for (const rec of cache.records || []) {
    if (rec.dataPath) dataPaths.add(rec.dataPath);
  }
  if (dataPaths.size === 0) {
    fail(`${model.id}: ndarray-cache.json has no dataPath records`);
  }
  const missingShards = [];
  let maxShardBytes = 0;
  let maxShardName = "";
  for (const rel of dataPaths) {
    const shardPath = path.join(weightsDir, rel);
    if (!fs.existsSync(shardPath) || fs.statSync(shardPath).size === 0) {
      missingShards.push(rel);
      continue;
    }
    const sz = fs.statSync(shardPath).size;
    if (sz > maxShardBytes) {
      maxShardBytes = sz;
      maxShardName = rel;
    }
  }
  if (missingShards.length) {
    fail(
      `${model.id}: missing ${missingShards.length} weight shard(s) e.g. ${missingShards.slice(0, 3).join(", ")}. Re-run fetch-model.`
    );
  }

  # Pages CI: large shards OK with IndexedDB; warn only (do not fail).
  if (requireLite && maxShardBytes >= PAGES_MAX_SHARD_BYTES) {
    console.log(
      `  note: ${model.id} ${maxShardName} is ${(maxShardBytes / (1024 * 1024)).toFixed(1)} MB ` +
        `(≥100 MB). Fine with IndexedDB; avoid Cache API. Runtime may also use HF remote on Pages.`
    );
  }

  const sizeMB = dirSizeBytes(modelDir) / (1024 * 1024);
  if (sizeMB < model.minMB) {
    fail(
      `${model.id} is only ~${sizeMB.toFixed(0)} MB (expected ≥${model.minMB} MB). ` +
        `Weights look incomplete — re-run fetch-model`
    );
  }

  console.log(
    `  [${model.key}] OK  resolve/main config + wasm + ${dataPaths.size} shards · ~${sizeMB.toFixed(0)} MB` +
      (maxShardBytes
        ? ` · max shard ${(maxShardBytes / (1024 * 1024)).toFixed(1)} MB`
        : "")
  );
  return {
    key: model.key,
    present: true,
    sizeMB,
    shards: dataPaths.size,
    maxShardMB: maxShardBytes / (1024 * 1024),
  };
}

if (!fs.existsSync(modelsRoot)) {
  fail(
    `missing ${path.relative(ROOT, modelsRoot)} — run npm run fetch-model` +
      (requireLite ? ":pages" : "")
  );
}

if (requirePlus) {
  console.log(
    "[verify-models] note: --require-plus is legacy; prefer --require-lite for Pages or default fetch-model for Netlify."
  );
}

console.log(`[verify-models] checking ${target}/models …`);
const requireDefault = !allowMissingDefault;
const def = checkModel(MODELS.default, { required: requireDefault });
const lite = checkModel(MODELS.lite, {
  required: requireLite || isPresent(MODELS.lite),
});
const hq = checkModel(MODELS.hq, {
  required: requireHq || isPresent(MODELS.hq),
});

if (!def.present && !lite.present && !hq.present) {
  fail("no models present — run npm run fetch-model or fetch-model:pages");
}

const totalMB = dirSizeBytes(modelsRoot) / (1024 * 1024);
console.log(`[verify-models] OK (${target})`);
console.log(
  `  default (1.5B): ${def.present ? "present" : allowMissingDefault ? "absent (Pages OK)" : "MISSING"}`
);
console.log(`  lite (0.5B):    ${lite.present ? "present" : "absent (optional)"}`);
console.log(`  hq (3B):        ${hq.present ? "present" : "absent (optional)"}`);
console.log(`  total:          ~${totalMB.toFixed(0)} MB`);
if (totalMB > 1000) {
  console.log(
    `  note: ~${totalMB.toFixed(0)} MB exceeds GitHub Pages soft comfort (~1 GB). Prefer Netlify / local for multi-model packs.`
  );
}
if (lite.present) {
  console.log(`  app (Pages): models/${MODELS.lite.id}/resolve/main/mlc-chat-config.json`);
}
if (def.present) {
  console.log(`  app (Netlify/local): models/${MODELS.default.id}/resolve/main/mlc-chat-config.json`);
}
if (hq.present) {
  console.log(`               models/${MODELS.hq.id}/resolve/main/mlc-chat-config.json`);
}

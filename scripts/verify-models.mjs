/**
 * Verify same-origin model layout required by WebLLM (resolve/main/).
 * Used by 公開準備.bat, npm scripts, and GitHub Actions.
 *
 * Checks public/models by default; pass "dist" to check build output.
 *
 * Default 0.5B is always required.
 * Plus 1.5B is optional — verified only if present or --require-plus.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MODELS = {
  default: {
    key: "default",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    minMB: 200,
  },
  plus: {
    key: "plus",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    wasm: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    minMB: 500,
  },
};

const args = process.argv.slice(2).filter((a) => a !== "--");
const requirePlus = args.includes("--require-plus");
const targetArg = args.find((a) => !a.startsWith("--")) || "public";
const target = targetArg.replace(/[/\\]+$/, "");
const modelsRoot = path.join(ROOT, target, "models");

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

  if (fs.existsSync(legacyFlatConfig) && !fs.existsSync(configPath)) {
    fail(
      `legacy flat layout detected at models/${model.id}/mlc-chat-config.json. ` +
        `Re-run npm run fetch-model to migrate into models/${model.id}/resolve/main/`
    );
  }

  const present = fs.existsSync(configPath) && fs.existsSync(wasmPath);
  if (!present) {
    if (required) {
      fail(
        `missing ${path.relative(ROOT, configPath)} or wasm — ` +
          (model.key === "plus"
            ? "run npm run fetch-model:plus"
            : "run npm run fetch-model")
      );
    }
    return { key: model.key, present: false };
  }

  const sizeMB = dirSizeBytes(modelDir) / (1024 * 1024);
  if (sizeMB < model.minMB) {
    fail(
      `${model.id} is only ~${sizeMB.toFixed(0)} MB (expected ≥${model.minMB} MB). ` +
        `Weights look incomplete — re-run fetch-model`
    );
  }

  console.log(`  [${model.key}] OK  config + wasm · model dir ~${sizeMB.toFixed(0)} MB`);
  return { key: model.key, present: true, sizeMB };
}

if (!fs.existsSync(modelsRoot)) {
  fail(`missing ${path.relative(ROOT, modelsRoot)} — run npm run fetch-model`);
}

console.log(`[verify-models] checking ${target}/models …`);
const def = checkModel(MODELS.default, { required: true });
const plusPresentOnDisk =
  fs.existsSync(
    path.join(modelsRoot, MODELS.plus.id, "resolve", "main", "mlc-chat-config.json")
  ) || requirePlus;
const plus = checkModel(MODELS.plus, { required: requirePlus || plusPresentOnDisk });

const totalMB = dirSizeBytes(modelsRoot) / (1024 * 1024);
console.log(`[verify-models] OK (${target})`);
console.log(`  default: ${def.present ? "present" : "MISSING"}`);
console.log(`  plus:    ${plus.present ? "present" : "absent (optional)"}`);
console.log(`  total:   ~${totalMB.toFixed(0)} MB`);
if (plus.present && totalMB > 1000) {
  console.log(
    `  note: ~${totalMB.toFixed(0)} MB exceeds GitHub Pages soft comfort (~1 GB). Prefer Netlify / local for dual models.`
  );
}
console.log(
  `  app requests: models/${MODELS.default.id}/resolve/main/mlc-chat-config.json`
);
if (plus.present) {
  console.log(
    `               models/${MODELS.plus.id}/resolve/main/mlc-chat-config.json`
  );
}

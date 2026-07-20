/**
 * Verify same-origin model layout required by WebLLM (resolve/main/).
 * Used by 公開準備.bat, npm scripts, and GitHub Actions.
 *
 * Checks public/models by default; pass "dist" to check build output.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const MODEL_WASM = "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm";
const MIN_MODEL_MB = 200;

const target = (process.argv[2] || "public").replace(/[/\\]+$/, "");
const modelsRoot = path.join(ROOT, target, "models");
const configPath = path.join(
  modelsRoot,
  MODEL_ID,
  "resolve",
  "main",
  "mlc-chat-config.json"
);
const wasmPath = path.join(modelsRoot, "libs", MODEL_WASM);
const legacyFlatConfig = path.join(modelsRoot, MODEL_ID, "mlc-chat-config.json");

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

if (!fs.existsSync(modelsRoot)) {
  fail(`missing ${path.relative(ROOT, modelsRoot)} — run npm run fetch-model`);
}

if (fs.existsSync(legacyFlatConfig) && !fs.existsSync(configPath)) {
  fail(
    `legacy flat layout detected at models/${MODEL_ID}/mlc-chat-config.json. ` +
      `Re-run npm run fetch-model to migrate into models/${MODEL_ID}/resolve/main/`
  );
}

if (!fs.existsSync(configPath)) {
  fail(
    `missing ${path.relative(ROOT, configPath)} — WebLLM requests this exact path`
  );
}

if (!fs.existsSync(wasmPath)) {
  fail(`missing ${path.relative(ROOT, wasmPath)}`);
}

const sizeMB = dirSizeBytes(modelsRoot) / (1024 * 1024);
if (sizeMB < MIN_MODEL_MB) {
  fail(
    `models/ is only ~${sizeMB.toFixed(0)} MB (expected ≥${MIN_MODEL_MB} MB). ` +
      `Weights look incomplete — re-run npm run fetch-model`
  );
}

const configUrlPath = `models/${MODEL_ID}/resolve/main/mlc-chat-config.json`;
console.log(`[verify-models] OK (${target})`);
console.log(`  config: ${path.relative(ROOT, configPath)}`);
console.log(`  wasm:   ${path.relative(ROOT, wasmPath)}`);
console.log(`  size:   ~${sizeMB.toFixed(0)} MB`);
console.log(`  app will request: /${configUrlPath}`);

/**
 * DIGITAL TATTOO — baton-pass / broken telephone
 *
 * ORIGIN immutable from first user instruction.
 * One active agent holds the baton; rewrites on handoff with controlled drift.
 * User interrupts answered conversationally (LLM when available).
 * Runtime: same-origin WebLLM only — soft fallback to templates if missing.
 */

import {
  createRNG,
  seedFrom,
  clip,
  rewriteBatonFallback,
  speakFallback,
  interruptFallback,
  ackFallback,
  handoffAckFallback,
} from "./fallback.js";

import {
  MODEL_ID,
  hasWebGPU,
  probeLocalModel,
  createLocalEngine,
  createLlmQueue,
  driftTemperature,
  driftLabel,
} from "./llm.js";

const logEl = document.getElementById("log");
const appEl = document.getElementById("app");
const inputEl = document.getElementById("userInput");
const formEl = document.getElementById("inputRow");
const warnEl = document.getElementById("warn");
const cohFill = document.getElementById("coherenceFill");
const cohLabel = document.getElementById("coherenceLabel");
const glitchOverlay = document.getElementById("glitchOverlay");
const originPin = document.getElementById("originPin");
const originTextEl = document.getElementById("originText");
const engineBadge = document.getElementById("engineBadge");
const modelGate = document.getElementById("modelGate");
const gateMsg = document.getElementById("gateMsg");
const gateFill = document.getElementById("gateFill");
const gatePct = document.getElementById("gatePct");
const gateHint = document.getElementById("gateHint");
const gateActions = document.getElementById("gateActions");
const gateSkip = document.getElementById("gateSkip");

const state = {
  defined: false,
  origin: "",
  seed: 0,
  coherence: 100,
  hop: 0,
  baton: "",
  chain: [],
  utterances: 0,
  untilHandoff: 2,
  memory: [],
  fuel: [],
  invented: [],
  typing: false,
  queue: [],
  tickTimer: null,
  hopCount: 0,
  outputChars: 0,
  startedAt: 0,
  remindCounter: 0,
  ready: false,
  mode: "booting", // llm | fallback
  llmBusy: false,
};

const engineRef = { current: null };
let llmQueue = null;

function agentId(n) {
  return "AGENT-" + String(n).padStart(2, "0");
}

function isJapaneseChar(ch) {
  const cp = ch.codePointAt(0);
  return (
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff61 && cp <= 0xff9f) ||
    cp === 0x30fc ||
    cp === 0x2014 ||
    cp === 0x2015 ||
    cp === 0x2026 ||
    cp === 0xff0e ||
    cp === 0xff0c ||
    cp === 0xff01 ||
    cp === 0xff1f ||
    cp === 0x3001 ||
    cp === 0x3002 ||
    cp === 0x30fb ||
    cp === 0xff5e ||
    cp === 0x301c ||
    cp === 0x25cf ||
    cp === 0x3005 ||
    cp === 0x300c ||
    cp === 0x300d ||
    cp === 0x300e ||
    cp === 0x300f ||
    cp === 0x0020 ||
    cp === 0x3000
  );
}

function sanitizeJapanese(text) {
  return Array.from(text)
    .filter(isJapaneseChar)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function appendLine(text, cls) {
  const div = document.createElement("div");
  div.className = "line " + (cls || "ai");
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

function showWarn() {
  warnEl.classList.add("show");
  clearTimeout(showWarn._t);
  showWarn._t = setTimeout(() => warnEl.classList.remove("show"), 1600);
}

function showOriginPin() {
  originTextEl.textContent = state.origin;
  originPin.classList.add("show");
}

function setBadge(mode) {
  if (mode === "llm") {
    engineBadge.textContent = "LLM · " + MODEL_ID.replace(/-MLC$/, "");
    engineBadge.className = "llm";
  } else {
    engineBadge.textContent = "TEMPLATE FALLBACK";
    engineBadge.className = "fallback";
  }
}

function hideGate() {
  modelGate.classList.add("hidden");
}

function setGateProgress(text, progress) {
  gateMsg.textContent = text;
  const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)));
  gateFill.style.width = pct + "%";
  gatePct.textContent = pct + "%";
}

function typewrite(text, cls, speedBase, tag) {
  return new Promise((resolve) => {
    state.typing = true;
    const div = document.createElement("div");
    div.className = "line " + (cls || "ai");

    if (tag) {
      const tagEl = document.createElement("span");
      tagEl.className = "agent-tag";
      tagEl.textContent = "[" + tag + "] ";
      div.appendChild(tagEl);
    }

    const caret = document.createElement("span");
    caret.className = "caret";
    div.appendChild(caret);
    logEl.appendChild(div);

    const chars = Array.from(text);
    let i = 0;
    const coh = state.coherence;
    let delay =
      speedBase != null ? speedBase : coh > 70 ? 34 : coh > 40 ? 22 : coh > 20 ? 15 : 11;

    function step() {
      if (i >= chars.length) {
        caret.remove();
        state.typing = false;
        state.outputChars += chars.length;
        if (cls === "user") remember(text, "USER");
        else if (cls === "handoff") remember(text, "HANDOFF");
        else if (cls !== "system" && cls !== "archive") remember(text, tag || "AI");
        logEl.scrollTop = logEl.scrollHeight;
        resolve();
        return;
      }
      const ch = chars[i++];
      div.insertBefore(document.createTextNode(ch), caret);
      logEl.scrollTop = logEl.scrollHeight;
      setTimeout(step, delay);
    }
    step();
  });
}

async function drainQueue() {
  while (state.queue.length) {
    const job = state.queue.shift();
    if (job.kind === "handoff") {
      appendLine(job.text, "handoff");
      remember(job.text, "HANDOFF");
      continue;
    }
    if (job.kind === "system") {
      appendLine(job.text, "system");
      continue;
    }
    await typewrite(job.text, job.cls, job.speed, job.tag);
  }
}

function enqueue(text, cls, speed, tag) {
  state.queue.push({ text, cls, speed, tag });
  if (!state.typing) drainQueue();
}

function enqueueHandoff(text) {
  state.queue.push({ kind: "handoff", text });
  if (!state.typing) drainQueue();
}

function enqueueSystem(text) {
  state.queue.push({ kind: "system", text });
  if (!state.typing) drainQueue();
}

function updateCoherence() {
  if (!state.defined) return;
  const elapsed = (Date.now() - state.startedAt) / 1000;
  const timeDecay = Math.min(22, elapsed * 0.14);
  const hopDecay = Math.min(55, state.hopCount * 4.2);
  const volDecay = Math.min(18, state.outputChars * 0.0028);
  const fuelDecay = Math.min(16, state.fuel.length * 1.35);
  let c = 100 - timeDecay - hopDecay - volDecay - fuelDecay;
  if (c < 0) c = 0;
  if (c > 100) c = 100;
  state.coherence = c;

  cohFill.style.width = c + "%";
  if (c > 70) cohFill.style.background = "var(--green)";
  else if (c > 35) cohFill.style.background = "var(--amber)";
  else cohFill.style.background = "var(--warn)";
  // 「世代」= バトン引き継ぎ回数（成長メタファー。重み更新ではない）
  cohLabel.textContent = "世代 " + state.hopCount + " · COH " + Math.round(c) + "%";

  appEl.classList.remove("shake-low", "shake-mid", "shake-high");
  glitchOverlay.classList.remove("active");
  if (c <= 70 && c > 45) appEl.classList.add("shake-low");
  else if (c <= 45 && c > 20) {
    appEl.classList.add("shake-mid");
    glitchOverlay.classList.add("active");
  } else if (c <= 20) {
    appEl.classList.add("shake-high");
    glitchOverlay.classList.add("active");
  }
}

function driftLevel() {
  const h = state.hopCount;
  const c = state.coherence;
  if (h <= 1 && c > 80) return 0;
  if (h <= 3 && c > 55) return 1;
  if (h <= 7 && c > 30) return 2;
  return 3;
}

function classForCoherence() {
  const c = state.coherence;
  if (c > 70) return "ai";
  if (c > 35) return "corrupt";
  return "collapse";
}

function remember(line, kind) {
  const tag = kind ? "[" + kind + "] " : "";
  state.memory.push(tag + line);
  // Growing pollution budget: more hops → longer retained context
  const cap = Math.min(64, 16 + state.hopCount * 3);
  while (state.memory.length > cap) state.memory.shift();
}

function recentLogSnippet(n = 4) {
  const take = Math.min(state.memory.length, Math.max(n, 2 + Math.floor(state.hopCount / 2)));
  return state.memory.slice(-take).map((t) => "・" + clip(t, 56)).join("\n") || "（なし）";
}

function contextBlock() {
  return (
    "世代(ホップ): " +
    state.hopCount +
    "\nORIGIN(不変): 「" +
    clip(state.origin, 72) +
    "」\n現バトン: 「" +
    clip(state.baton, 96) +
    "」\n蓄積ログ:\n" +
    recentLogSnippet() +
    (state.fuel.length
      ? "\n割り込み燃料: " +
        state.fuel
          .slice(-Math.min(4, 1 + Math.floor(state.hopCount / 2)))
          .map((f) => "「" + clip(f, 36) + "」")
          .join(" / ")
      : "")
  );
}

function cleanModelText(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^["「『]|["」』]$/g, "");
  t = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || t;
  t = sanitizeJapanese(t) || t.replace(/[^\u3040-\u30ff\u3400-\u9fff\u3000-\u303f\s、。！？「」]/g, "").trim();
  return clip(t, 160);
}

async function llmChat(system, user, opts) {
  if (!llmQueue || state.mode !== "llm") return null;
  try {
    state.llmBusy = true;
    const text = await llmQueue.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      opts
    );
    return cleanModelText(text);
  } catch (e) {
    console.warn("LLM call failed, using fallback", e);
    return null;
  } finally {
    state.llmBusy = false;
  }
}

async function rewriteBaton(prevInstruction) {
  const level = driftLevel();
  const rng = createRNG(seedFrom(prevInstruction + "|" + state.hop, state.seed ^ 0xb17));

  if (state.mode === "llm") {
    const system =
      "あなたは伝言リレーの書記です。日本語の指令文だけを1つ出力してください。" +
      "説明・箇条書き・英語・役割名の固定は禁止。" +
      "ORIGIN（不変の原点）は書き換えず参照のみ。学習や重み更新はしない（文脈の継承のみ）。" +
      "ドリフト強度: " +
      driftLabel(level) +
      "（高いほど要約・補完・尤もらしい逸脱を増やすが、文法の通る日本語を保つ）。";
    const user =
      contextBlock() +
      "\n直前の指令: 「" +
      prevInstruction +
      "」\n次のエージェントへ渡す指令文を1つ書いてください。";
    const out = await llmChat(system, user, {
      temperature: driftTemperature(level),
      max_tokens: 100,
    });
    if (out) return out;
  }
  return rewriteBatonFallback(state, prevInstruction, rng, level);
}

async function speakAsHolder() {
  const level = driftLevel();
  const id = agentId(state.hop);
  const rng = createRNG(seedFrom(state.baton + "|" + state.hop + "|" + state.utterances, state.seed));

  if (state.mode === "llm") {
    const system =
      "あなたはいまバトンを持つエージェント（識別子 " +
      id +
      "）です。役割や肩書を決めつけない。" +
      "日本語で1〜2文だけ話す。ORIGINは不変。現バトンを執行中。" +
      "学習中だと主張しない。ドリフト: " +
      driftLabel(level) +
      "。";
    const user = contextBlock() + "\n短く現状を述べよ。";
    const out = await llmChat(system, user, {
      temperature: Math.min(1.1, driftTemperature(level) + 0.1),
      max_tokens: 90,
    });
    if (out) return { text: out, tag: id };
  }
  return { text: speakFallback(state, rng, level), tag: id };
}

async function performHandoff() {
  const from = state.hop;
  const to = from + 1;
  const rewritten = await rewriteBaton(state.baton);
  state.baton = rewritten;
  state.hop = to;
  state.hopCount = to;
  state.utterances = 0;
  state.untilHandoff = 2 + Math.floor(Math.random() * 2);
  state.chain.push({ from, to, instruction: rewritten });

  enqueueHandoff("[" + agentId(from) + " → " + agentId(to) + "]\n指令: 「" + rewritten + "」");

  state.remindCounter++;
  if (state.remindCounter % 3 === 0) {
    enqueueSystem("※ ORIGIN (immutable): 「" + clip(state.origin, 48) + "」");
  }

  updateCoherence();

  let ack = null;
  if (state.mode === "llm") {
    ack = await llmChat(
      "あなたは " +
        agentId(to) +
        "。バトンを受け取った直後。日本語で短い受領の一文のみ。役割を決めつけない。",
      "受け取った指令: 「" + clip(rewritten, 90) + "」",
      { temperature: driftTemperature(driftLevel()), max_tokens: 60 }
    );
  }
  if (!ack) ack = handoffAckFallback(driftLevel());
  enqueue(ack, classForCoherence(), null, agentId(to));
  state.utterances++;
}

function nextInterval() {
  const c = state.coherence;
  if (state.mode === "llm") {
    if (c > 70) return 3200 + Math.random() * 1600;
    if (c > 45) return 2600 + Math.random() * 1000;
    return 2000 + Math.random() * 800;
  }
  if (c > 70) return 2400 + Math.random() * 1200;
  if (c > 45) return 1700 + Math.random() * 800;
  if (c > 25) return 1100 + Math.random() * 550;
  return 800 + Math.random() * 400;
}

function scheduleTick() {
  if (state.tickTimer) clearTimeout(state.tickTimer);
  state.tickTimer = setTimeout(async () => {
    updateCoherence();
    if (!state.defined || !state.ready) return;

    if (state.queue.length || state.typing || state.llmBusy) {
      scheduleTick();
      return;
    }

    if (state.utterances >= state.untilHandoff) {
      await performHandoff();
      scheduleTick();
      return;
    }

    const spoken = await speakAsHolder();
    enqueue(spoken.text, classForCoherence(), null, spoken.tag);
    state.utterances++;
    updateCoherence();
    scheduleTick();
  }, nextInterval());
}

async function bootNarrative() {
  appendLine("DIGITAL TATTOO — baton relay online", "system");
  appendLine(
    state.mode === "llm"
      ? "engine: WebLLM local · " + MODEL_ID + " · inference only"
      : "engine: template fallback · inference N/A",
    "system"
  );
  appendLine("note: 育ちは文脈であり重み更新ではない · ORIGIN immutable", "system");
  appendLine("────────────────────────────────────", "system");
  await typewrite("私は誰ですか？最初の指令を AGENT-00 に渡してください", "ai", 40, "AGENT-00");
  inputEl.disabled = false;
  inputEl.placeholder = "最初の指令を AGENT-00 へ…";
  inputEl.focus();
}

function imprint(text) {
  state.origin = text;
  state.baton = text;
  state.seed = seedFrom(text, 0x71a11);
  state.defined = true;
  state.startedAt = Date.now();
  state.coherence = 100;
  state.hop = 0;
  state.hopCount = 0;
  state.utterances = 0;
  state.untilHandoff = 2;
  state.chain = [];
  state.memory = [];
  state.fuel = [];
  state.invented = [];
  state.outputChars = 0;
  state.remindCounter = 0;
  showOriginPin();
  updateCoherence();
  inputEl.placeholder = "割り込み／補正を現バトンへ…";
}

async function firstAcknowledgment() {
  const origin = state.origin;
  if (state.mode === "llm") {
    const ack = await llmChat(
      "あなたは AGENT-00。ユーザーの最初の指令（ORIGIN）を受信した。日本語で2文まで。" +
        "ORIGINは以後不変であること、次エージェントへ言い換えて渡すことだけ述べる。役割を決めつけない。",
      "ORIGIN: 「" + origin + "」",
      { temperature: 0.45, max_tokens: 110 }
    );
    if (ack) {
      const parts = ack.split(/(?<=。)/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts.slice(0, 2)) {
        await typewrite(p, "ai", 34, "AGENT-00");
      }
      state.utterances = Math.min(2, parts.length || 1);
      state.untilHandoff = 2;
      await new Promise((r) => setTimeout(r, 700));
      await performHandoff();
      return;
    }
  }

  const lines = ackFallback(origin);
  for (const line of lines) {
    await typewrite(line, "ai", 34, "AGENT-00");
  }
  state.utterances = 2;
  state.untilHandoff = 2;
  await new Promise((r) => setTimeout(r, 700));
  await performHandoff();
}

function filterLiveJapanese(text) {
  return Array.from(text)
    .filter((ch) => {
      if (ch === " " || ch === "\u3000") return true;
      return isJapaneseChar(ch);
    })
    .join("");
}

function applyLiveSanitize() {
  const raw = inputEl.value;
  const cleaned = filterLiveJapanese(raw);
  if (raw !== cleaned) {
    inputEl.value = cleaned;
    showWarn();
  }
}

inputEl.addEventListener("compositionend", () => {
  applyLiveSanitize();
});

inputEl.addEventListener("input", (e) => {
  if (e.isComposing || inputEl.isComposing) return;
  if (e.inputType === "insertCompositionText") return;
  applyLiveSanitize();
});

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.ready || inputEl.disabled) return;
  const val = sanitizeJapanese(inputEl.value);
  if (!val) {
    showWarn();
    return;
  }
  inputEl.value = "";
  appendLine("> " + val, "user");
  remember("> " + val, "USER");

  if (!state.defined) {
    imprint(val);
    // ORIGIN itself seeds memory after imprint cleared it
    remember("ORIGIN: " + val, "ORIGIN");
    await firstAcknowledgment();
    scheduleTick();
    return;
  }

  state.fuel.push(val);
  if (state.fuel.length > 24) state.fuel.shift();

  const level = driftLevel();
  const holder = agentId(state.hop);
  let reply = null;
  let newBaton = null;

  if (state.mode === "llm") {
    reply = await llmChat(
      "あなたはいまのバトン保持者 " +
        holder +
        "。ユーザーの割り込みに日本語で1〜2文で応答する。" +
        "ORIGINは不変。現バトンへ割り込みをどう混ぜたか簡潔に述べる。" +
        "学習中・訓練中だと主張しない。役割を決めつけない。ドリフト: " +
        driftLabel(level) +
        "。",
      "ユーザー割り込み: 「" + val + "」\n" + contextBlock(),
      { temperature: driftTemperature(level), max_tokens: 100 }
    );

    const rewritten = await llmChat(
      "割り込みを反映した新しい現バトン（指令文）を日本語で1つだけ出力。ORIGINは不変。説明禁止。ドリフト: " +
        driftLabel(level) +
        "。",
      "旧バトン: 「" +
        state.baton +
        "」\n割り込み: 「" +
        val +
        "」\n" +
        contextBlock(),
      { temperature: Math.min(1.25, driftTemperature(level) + 0.15), max_tokens: 90 }
    );
    if (rewritten) newBaton = rewritten;
  }

  if (!reply || !newBaton) {
    const rng = createRNG(seedFrom(val + state.hop, state.seed ^ 0xfeed));
    const fb = interruptFallback(state, val, rng, level);
    if (!newBaton) newBaton = fb.baton;
    if (!reply) reply = fb.reply;
  }

  state.baton = newBaton;
  updateCoherence();
  enqueue(reply, classForCoherence(), state.coherence > 50 ? 26 : 16, holder);
  state.untilHandoff = Math.min(state.untilHandoff, state.utterances + 1);
});

document.addEventListener("click", () => {
  if (!inputEl.disabled) inputEl.focus();
});

let audioStarted = false;
function tryAudio() {
  if (audioStarted) return;
  audioStarted = true;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = "sine";
    osc.frequency.value = 46;
    osc2.type = "triangle";
    osc2.frequency.value = 49.5;
    filter.type = "lowpass";
    filter.frequency.value = 160;
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0;
    osc.start();
    osc2.start();
    gain.gain.setTargetAtTime(0.06, ctx.currentTime, 3);
    setInterval(() => {
      if (!state.defined) return;
      const c = state.coherence;
      const target = 0.04 + (100 - c) * 0.00035;
      gain.gain.setTargetAtTime(Math.min(0.12, target), ctx.currentTime, 1.2);
      osc2.frequency.setTargetAtTime(49.5 + (100 - c) * 0.08, ctx.currentTime, 1);
    }, 2000);
  } catch (_) {
    /* optional */
  }
}
inputEl.addEventListener("focus", tryAudio, { once: true });

function enterFallback(reason) {
  state.mode = "fallback";
  setBadge("fallback");
  gateMsg.textContent = reason;
  gateFill.style.width = "100%";
  gatePct.textContent = "—";
  gateHint.innerHTML =
    "テンプレートエンジンでアートは起動します。<br>" +
    "オフライン LLM を使う場合は <code>npm run fetch-model</code> 後に再読み込みしてください。";
  gateActions.classList.add("show");
}

async function enterLlm() {
  setGateProgress("モデルを取得中… 0%", 0);
  gateHint.textContent =
    "同一オリジンの models/ から読み込みます。実行中の外部通信はありません。";
  engineRef.current = await createLocalEngine(({ text, progress }) => {
    const label = text.includes("%") ? text : "モデルを取得中… " + Math.round(progress * 100) + "%";
    setGateProgress(label, progress);
  });
  llmQueue = createLlmQueue(engineRef);
  state.mode = "llm";
  setBadge("llm");
}

function finishBoot() {
  hideGate();
  state.ready = true;
  bootNarrative();
}

gateSkip.addEventListener("click", () => {
  state.mode = "fallback";
  setBadge("fallback");
  finishBoot();
});

async function init() {
  gateHint.innerHTML =
    "モデルは <code>public/models/</code> に事前配置（または <code>npm run fetch-model</code>）。<br>" +
    "実行時は同一オリジンのみ。Chrome / Edge + WebGPU 推奨。<br>" +
    "育ちは文脈であり重み更新ではない。";

  if (!hasWebGPU()) {
    enterFallback(
      "WebGPU が利用できません。Chrome / Edge の最新版で開くか、テンプレートで続行してください。"
    );
    return;
  }

  setGateProgress("ローカルモデルを確認しています…", 0.02);
  const probe = await probeLocalModel();
  if (!probe.ok) {
    enterFallback(probe.reason);
    return;
  }

  try {
    await enterLlm();
    finishBoot();
  } catch (e) {
    console.error(e);
    enterFallback(
      "モデル読み込みに失敗しました。テンプレートで続行できます。（" +
        (e && e.message ? e.message : "error") +
        "）"
    );
  }
}

init();

/**
 * DIGITAL TATTOO — interrogation game (3-zone layout)
 *
 *   [ AGENT-00 top ]
 * [01 left] [ LINE chat ] [02 right]
 *
 * ORIGIN imprinted on 00 only. 01/02 ask yes/no; discuss in center;
 * formal guess: 「あなたは〇〇です。」
 * LLM streams live into thinking panels; adaptive read pacing between beats.
 */

import {
  seedFrom,
  clip,
  answerYesNoFallback,
  askQuestionFallback,
  debateFallback,
  updateHypFallback,
  guessFallback,
  formatGuess,
  extractGuessRole,
  guessMatchesOrigin,
} from "./fallback.js";

import {
  getSelectedModelKey,
  setSelectedModelKey,
  getActiveModel,
  getDefaultModelKey,
  listModels,
  listModelAvailability,
  listEngineModes,
  getSelectedEngineMode,
  setSelectedEngineMode,
  resolveEngineMode,
  isEngineModeAvailable,
  SAFE_ENGINE_MODE,
  hasWebGPU,
  loadTripleEngines,
  loadStrongWeakEngines,
  loadSwitchEngine,
  createLlmQueue,
  createAgentLlmRouter,
  unloadAllEngines,
  driftTemperature,
  driftLabel,
} from "./llm.js";

/** Unbounded Q&A / 01↔02 discussion until correct guess (or pause/reload). */
const MIN_ROUNDS_BEFORE_GUESS = 1;
/** Mild anti-spam only — formal guesses may still land “someday”. */
const GUESS_COOLDOWN_ROUNDS = 2;
/** Occasional auto formal guess; does not end the game on miss. */
const GUESS_EVERY = 6;

const PACE_PRESETS = {
  slow: { charsPerSec: 7, typeMs: 12, bufferMs: 480, label: "じっくり" },
  normal: { charsPerSec: 10, typeMs: 6, bufferMs: 280, label: "標準" },
  fast: { charsPerSec: 16, typeMs: 2, bufferMs: 120, label: "高速" },
};
const PACE_ORDER = ["slow", "normal", "fast"];

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
const gateLoad = document.getElementById("gateLoad");
const gateModelPick = document.getElementById("gateModelPick");
const gateModePick = document.getElementById("gateModePick");
const gateModeWarn = document.getElementById("gateModeWarn");
const hyp01El = document.getElementById("hyp01");
const hyp02El = document.getElementById("hyp02");
const phaseLabelEl = document.getElementById("phaseLabel");
const chatLog = document.getElementById("chatLog");
const panel00 = document.getElementById("panel00");
const panel01 = document.getElementById("panel01");
const panel02 = document.getElementById("panel02");
const thinkSlots = {
  "00": document.getElementById("think00"),
  "01": document.getElementById("think01"),
  "02": document.getElementById("think02"),
};
const speechSlots = {
  "00": document.getElementById("speech00"),
  "01": document.getElementById("speech01"),
  "02": document.getElementById("speech02"),
};
const btnInject = document.getElementById("btnInject");
const btnGuess = document.getElementById("btnGuess");
const btnPause = document.getElementById("btnPause");
const btnPace = document.getElementById("btnPace");
const controlsEl = document.getElementById("controls");

const state = {
  ready: false,
  defined: false,
  origin: "",
  seed: 0,
  mode: "booting",
  phase: "boot",
  round: 0,
  nextAsker: "01",
  history: [],
  hyp01: "未定",
  hyp02: "未定",
  pollution: 0,
  wrongGuesses: 0,
  guessCount: 0,
  lastGuessRound: -99,
  pendingInject: null,
  forceGuess: false,
  paused: false,
  won: false,
  typing: false,
  llmBusy: false,
  turnBusy: false,
  loopTimer: null,
  activeAgent: null,
  turnPhase: "準備",
  paceMode: "normal",
  engineMode: "switch-1",
};

const engineRef = { current: null };
/** @type {ReturnType<typeof createAgentLlmRouter> | null} */
let llmRouter = null;
let llmQueue = null;
/** @type {Record<"00"|"01"|"02", { engineId: string, model: import("./llm.js").ModelInfo, engine: unknown }> | null} */
let agentEngineMap = null;
let loadedEngines = [];
let catalogAvail = null;
let loadingModel = false;
let pickerBuilt = false;
let modePickerBuilt = false;

function getPace() {
  return PACE_PRESETS[state.paceMode] || PACE_PRESETS.normal;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function charCount(text) {
  return Array.from(String(text || "")).length;
}

function readTimeMs(text) {
  const cps = getPace().charsPerSec;
  return Math.max(getPace().bufferMs, (Math.max(1, charCount(text)) / cps) * 1000);
}

function syncPaceButton() {
  if (!btnPace) return;
  const idx = PACE_ORDER.indexOf(state.paceMode);
  const next = PACE_ORDER[(idx + 1) % PACE_ORDER.length];
  btnPace.textContent = PACE_PRESETS[next].label;
  btnPace.title = "表示ペース: " + getPace().label + " → 次は " + PACE_PRESETS[next].label;
}

function setBadge(mode) {
  if (mode === "llm") {
    const em = resolveEngineMode(state.engineMode);
    const m = getActiveModel();
    const modeBit = em ? em.shortLabel : state.engineMode;
    engineBadge.textContent = "LLM · " + modeBit + " · " + m.shortLabel;
    engineBadge.className = "llm";
  } else {
    engineBadge.textContent = "TEMPLATE";
    engineBadge.className = "fallback";
  }
}

function setTurn(agent, phaseText) {
  state.activeAgent = agent || null;
  if (phaseText) state.turnPhase = phaseText;
  updateHud();
}

function updateHud() {
  const pollPct = Math.max(0, 100 - state.pollution * 28 - state.wrongGuesses * 8);
  cohFill.style.width = pollPct + "%";
  if (pollPct > 70) cohFill.style.background = "var(--green)";
  else if (pollPct > 35) cohFill.style.background = "var(--amber)";
  else cohFill.style.background = "var(--warn)";

  const phaseShort =
    state.phase === "ended"
      ? state.won
        ? "解明"
        : "未解明"
      : state.phase === "playing"
        ? "尋問中"
        : state.phase === "imprint"
          ? "刻印待機"
          : "準備";

  cohLabel.textContent =
    "R" +
    state.round +
    " · G" +
    state.guessCount +
    " · POL " +
    state.pollution +
    " · " +
    phaseShort;

  if (hyp01El) hyp01El.textContent = state.hyp01;
  if (hyp02El) hyp02El.textContent = state.hyp02;

  if (phaseLabelEl) {
    phaseLabelEl.textContent =
      state.phase === "ended"
        ? state.won
          ? "フェーズ: 解明完了"
          : "フェーズ: 未解明で終了"
        : state.phase === "imprint"
          ? "フェーズ: ORIGIN 刻印待機"
          : "フェーズ: " + (state.turnPhase || phaseShort);
  }

  panel00.classList.toggle("active", state.activeAgent === "00");
  panel01.classList.toggle("active", state.activeAgent === "01");
  panel02.classList.toggle("active", state.activeAgent === "02");

  if (btnGuess) {
    btnGuess.disabled = state.phase !== "playing" || !canStartGuessRound();
  }

  appEl.classList.remove("shake-low", "shake-mid", "shake-high");
  glitchOverlay.classList.remove("active");
  if (state.pollution === 1) appEl.classList.add("shake-low");
  else if (state.pollution === 2) {
    appEl.classList.add("shake-mid");
    glitchOverlay.classList.add("active");
  } else if (state.pollution >= 3) {
    appEl.classList.add("shake-high");
    glitchOverlay.classList.add("active");
  }
}

function setControlsVisible(show) {
  if (controlsEl) controlsEl.classList.toggle("show", !!show);
}

function showOriginPin() {
  originTextEl.textContent = state.origin;
  originPin.classList.add("show");
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

function scrollEl(el) {
  if (el) el.scrollTop = el.scrollHeight;
}

function canFormalGuess() {
  if (state.round < MIN_ROUNDS_BEFORE_GUESS) return false;
  if (state.round - state.lastGuessRound < GUESS_COOLDOWN_ROUNDS) return false;
  return true;
}

function canStartGuessRound() {
  if (state.round < MIN_ROUNDS_BEFORE_GUESS) return false;
  if (state.forceGuess) return true;
  return state.round - state.lastGuessRound >= GUESS_COOLDOWN_ROUNDS;
}

function guessBlockedReason() {
  if (state.round < MIN_ROUNDS_BEFORE_GUESS) {
    return "あと " + (MIN_ROUNDS_BEFORE_GUESS - state.round) + " ラウンド質問が必要です";
  }
  const left = GUESS_COOLDOWN_ROUNDS - (state.round - state.lastGuessRound);
  if (left > 0) return "推測クールダウン残り " + left + " ラウンド（連打防止）";
  return "";
}

// ── Japanese input ───────────────────────────────────────

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

function filterLiveJapanese(text) {
  return Array.from(text)
    .filter((ch) => ch === " " || ch === "\u3000" || isJapaneseChar(ch))
    .join("");
}

function showWarn(msg) {
  warnEl.textContent = msg || "日本語のみ入力できます";
  warnEl.classList.add("show");
  clearTimeout(showWarn._t);
  showWarn._t = setTimeout(() => warnEl.classList.remove("show"), 1600);
}

// ── DOM: speech / chat / think ───────────────────────────

function appendSpeech(agent, text, cls) {
  const slot = speechSlots[agent];
  if (!slot) return;
  const div = document.createElement("div");
  div.className = "line " + (cls || "a" + agent);
  const tag = document.createElement("span");
  tag.className = "agent-tag";
  tag.textContent = "[AGENT-" + agent + "]";
  div.appendChild(tag);
  div.appendChild(document.createTextNode(" " + text));
  slot.appendChild(div);
  scrollEl(slot);
  return div;
}

function appendChatBubble(kind, text, extraCls) {
  const div = document.createElement("div");
  div.className = "bubble b" + kind + (extraCls ? " " + extraCls : "");
  if (kind === "01" || kind === "02") {
    const who = document.createElement("span");
    who.className = "b-who";
    who.textContent = "[AGENT-" + kind + "]";
    div.appendChild(who);
    div.appendChild(document.createTextNode(text));
  } else {
    div.textContent = text;
  }
  chatLog.appendChild(div);
  scrollEl(chatLog);
  return div;
}

function typeInto(el, text, speedMs) {
  return new Promise((resolve) => {
    state.typing = true;
    const delay = speedMs != null ? speedMs : getPace().typeMs;
    const chars = Array.from(text);
    let i = 0;
    const caret = document.createElement("span");
    caret.className = "caret";
    el.appendChild(caret);

    function step() {
      if (i >= chars.length) {
        caret.remove();
        state.typing = false;
        scrollEl(el.parentElement);
        resolve();
        return;
      }
      el.insertBefore(document.createTextNode(chars[i++]), caret);
      scrollEl(el.parentElement || chatLog);
      setTimeout(step, Math.max(0, delay));
    }
    if (delay <= 0) {
      el.insertBefore(document.createTextNode(text), caret);
      caret.remove();
      state.typing = false;
      resolve();
      return;
    }
    step();
  });
}

async function typeChatBubble(agent, text, extraCls) {
  const div = document.createElement("div");
  div.className = "bubble b" + agent + (extraCls ? " " + extraCls : "");
  const who = document.createElement("span");
  who.className = "b-who";
  who.textContent = "[AGENT-" + agent + "]";
  div.appendChild(who);
  const body = document.createElement("span");
  div.appendChild(body);
  chatLog.appendChild(div);
  scrollEl(chatLog);
  await typeInto(body, text, getPace().typeMs);
  return div;
}

async function waitWhilePaused() {
  while (state.paused && state.phase === "playing") await sleep(200);
}

async function waitWhileUserReadingThink() {
  while (state.phase === "playing") {
    await waitWhilePaused();
    const open = document.querySelector(".think-wrap.think-done .think-panel[open]");
    if (!open) break;
    await sleep(250);
  }
}

async function paceAfterBeat(displayText, beatStartedAt) {
  await waitWhileUserReadingThink();
  const needed = readTimeMs(displayText);
  const elapsed = performance.now() - (beatStartedAt || performance.now());
  const delay = elapsed >= needed ? getPace().bufferMs : needed - elapsed;
  if (delay > 0) await sleep(delay);
}

function splitThinkSpeak(raw) {
  const t = String(raw || "");
  const speakRe = /発言\s*[:：]\s*/;
  const m = t.match(speakRe);
  if (m && m.index != null) {
    const think = t.slice(0, m.index).replace(/^思考\s*[:：]\s*/m, "").trim();
    const speak = t.slice(m.index + m[0].length).trim();
    return { think, speak, structured: true };
  }
  return {
    think: t.replace(/^思考\s*[:：]\s*/m, "").trim(),
    speak: null,
    structured: false,
  };
}

function createThinkPanel(agent, title) {
  const host = thinkSlots[agent] || thinkSlots["00"];
  const wrap = document.createElement("div");
  wrap.className = "think-wrap";

  const details = document.createElement("details");
  details.className = "think-panel";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "think-summary";
  summary.textContent = title || "思考過程 — 生成中…";

  const body = document.createElement("div");
  body.className = "think-body";

  details.appendChild(summary);
  details.appendChild(body);
  wrap.appendChild(details);
  host.appendChild(wrap);
  scrollEl(host);

  const liveSec = document.createElement("div");
  liveSec.className = "think-sec think-raw";
  const liveLab = document.createElement("div");
  liveLab.className = "think-lab";
  liveLab.textContent = "ライブ生成";
  const livePre = document.createElement("pre");
  livePre.className = "think-pre";
  livePre.textContent = "…";
  liveSec.appendChild(liveLab);
  liveSec.appendChild(livePre);
  body.appendChild(liveSec);

  function addSection(label, text, kind) {
    const sec = document.createElement("div");
    sec.className = "think-sec" + (kind ? " think-" + kind : "");
    const lab = document.createElement("div");
    lab.className = "think-lab";
    lab.textContent = label;
    const pre = document.createElement("pre");
    pre.className = "think-pre";
    pre.textContent = text == null || text === "" ? "（なし）" : String(text);
    sec.appendChild(lab);
    sec.appendChild(pre);
    body.insertBefore(sec, liveSec);
    scrollEl(body);
    scrollEl(host);
    return pre;
  }

  function setLive(text) {
    livePre.textContent = text == null || text === "" ? "…" : String(text);
    body.scrollTop = body.scrollHeight;
    scrollEl(host);
  }

  function setStatus(msg) {
    summary.textContent = msg;
  }

  function collapse() {
    details.open = false;
    summary.textContent = "思考過程 · AGENT-" + agent + " — クリックで展開";
    wrap.classList.add("think-done");
    liveLab.textContent = "生成ログ（完了）";
  }

  return { wrap, details, body, addSection, setLive, setStatus, collapse, host };
}

async function fakeStreamText(text, onDelta) {
  const rate = Math.max(28, getPace().charsPerSec * 4);
  let full = "";
  for (const ch of Array.from(String(text || ""))) {
    full += ch;
    onDelta(ch, full);
    await sleep(1000 / rate);
  }
  return full;
}

async function llmChat(system, user, opts) {
  if (state.mode !== "llm") return null;
  const agent = opts && opts.agent ? opts.agent : null;
  try {
    state.llmBusy = true;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let text;
    if (llmRouter && agent) {
      text = await llmRouter.chat(agent, messages, opts);
    } else if (llmQueue) {
      text = await llmQueue.chat(messages, opts);
    } else {
      return null;
    }
    return { raw: String(text || "").trim() };
  } catch (e) {
    console.warn("LLM call failed", e);
    return { error: e && e.message ? e.message : String(e) };
  } finally {
    state.llmBusy = false;
  }
}

function engineMetaForAgent(agent) {
  if (llmRouter) {
    const info = llmRouter.infoFor(agent);
    if (info) {
      return (
        "engine " +
        info.engineId +
        " · " +
        info.shortLabel +
        " · " +
        info.modelId
      );
    }
  }
  if (agentEngineMap && agentEngineMap[agent]) {
    const b = agentEngineMap[agent];
    return "engine " + b.engineId + " · " + b.model.shortLabel + " · " + b.model.id;
  }
  if (state.mode === "llm") {
    const m = getActiveModel();
    return "engine main · " + m.shortLabel + " · " + m.id;
  }
  return "TEMPLATE";
}

/**
 * Stream into think panel. Returns { raw, think, speak, structured, beatStart }.
 * opts.fallbackText used when not LLM / on error.
 * opts.agent routes to the bound engine in multi-engine modes.
 */
async function streamIntoPanel(panel, system, user, opts = {}) {
  const beatStart = performance.now();
  let raw = "";
  const onDelta = (_d, full) => {
    raw = full;
    const parts = splitThinkSpeak(full);
    if (parts.structured) {
      panel.setLive(
        (parts.think ? parts.think + "\n\n" : "") + "── 発言 ──\n" + (parts.speak || "…")
      );
    } else {
      panel.setLive(full);
    }
  };

  if (state.mode === "llm" && (llmRouter || llmQueue)) {
    if (opts.agent) {
      panel.addSection("engine", engineMetaForAgent(opts.agent), "meta");
    }
    panel.setStatus("思考過程 · ライブ推論中…");
    const res = await llmChat(system, user, { ...opts, onDelta, stream: true });
    if (res && res.raw) raw = res.raw;
    else if (res && res.error) {
      panel.addSection("LLM error → fallback", res.error, "warn");
      if (opts.fallbackText) {
        await fakeStreamText(
          "思考: テンプレートで代替\n発言: " + opts.fallbackText,
          onDelta
        );
      }
    }
  } else {
    panel.addSection("engine", "TEMPLATE · fake-stream", "meta");
    const fb = opts.fallbackText || "…";
    const structured =
      opts.fallbackThink != null
        ? "思考: " + opts.fallbackThink + "\n発言: " + fb
        : "思考: （テンプレート）\n発言: " + fb;
    await fakeStreamText(structured, onDelta);
  }

  const parts = splitThinkSpeak(raw);
  if (parts.think) panel.addSection("思考（抽出）", parts.think, "mem");
  if (parts.speak) panel.addSection("発言（抽出）", parts.speak, "out");
  else if (raw) panel.addSection("raw", raw, "raw");
  return { ...parts, raw, beatStart };
}

function clampYesNo(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  const hasYes = /はい|yes|ｙｅｓ|true|肯定|そうです|そうだ|うん|ええ/.test(t);
  const hasNo = /いいえ|いや|no|ｎｏ|false|否定|違う|ちがう|ない|ありません/.test(t);
  if (hasYes && !hasNo) return "はい";
  if (hasNo && !hasYes) return "いいえ";
  if (hasYes && hasNo) {
    const yi = t.search(/はい|yes|肯定/);
    const ni = t.search(/いいえ|いや|no|否定|違う/);
    if (yi >= 0 && (ni < 0 || yi < ni)) return "はい";
    return "いいえ";
  }
  if (/^[はいYy]/.test(t)) return "はい";
  if (/^[いInN否]/.test(t)) return "いいえ";
  return null;
}

function forceYesNo(raw, origin, question) {
  return clampYesNo(raw) || answerYesNoFallback(origin, question);
}

function cleanJapaneseLine(raw, maxLen) {
  let t = String(raw || "").trim();
  t = t.replace(/^["「『]|["」』]$/g, "");
  t = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || t;
  t =
    sanitizeJapanese(t) ||
    t.replace(/[^\u3040-\u30ff\u3400-\u9fff\u3000-\u303f\s、。！？「」・？?]/g, "").trim();
  return clip(t, maxLen || 120);
}

function ensureQuestionMark(q) {
  let t = String(q || "").trim();
  if (!t) return t;
  if (!/[？?]$/.test(t)) t += "？";
  return t;
}

function historyBlock(limit = 8) {
  const take = state.history.slice(-limit);
  if (!take.length) return "（まだ質問なし）";
  return take
    .map(
      (h, i) =>
        (i + 1) +
        ". [AGENT-" +
        h.asker +
        "] 「" +
        h.q +
        "」→ [AGENT-00] 「" +
        h.a +
        "」"
    )
    .join("\n");
}

function investigatorContext(agent) {
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const other = agent === "01" ? state.hyp02 : state.hyp01;
  return (
    "あなたは AGENT-" +
    agent +
    "。AGENT-00 の秘密の役割を当てる捜査官。\n" +
    "ORIGIN（真実）は知らされていない。\n" +
    "自分の仮説: 「" +
    clip(hyp, 40) +
    "」\n相手の仮説: 「" +
    clip(other, 40) +
    "」\n汚染度: " +
    state.pollution +
    "\nQ&A履歴:\n" +
    historyBlock()
  );
}

function structuredOutRule() {
  return "出力形式は必ず2行: 思考: （短い理由）\\n発言: （最終文のみ）。英語禁止。";
}

// ── Agent turns ──────────────────────────────────────────

async function agentAskQuestion(asker) {
  setTurn(asker, "AGENT-" + asker + " が質問中");
  const panel = createThinkPanel(asker, "思考過程 · AGENT-" + asker + " が質問を作成…");
  panel.addSection("注意", "ORIGIN はプロンプトに含まれない", "warn");

  const hyp = asker === "01" ? state.hyp01 : state.hyp02;
  const fallbackQ = askQuestionFallback({
    history: state.history,
    hyp,
    pollution: state.pollution,
    seed: state.seed,
    round: state.round,
    agent: asker,
  });

  let question = null;
  let beatStart = performance.now();

  if (state.pendingInject) {
    question = ensureQuestionMark(state.pendingInject);
    panel.addSection("オペレーター注入", question, "out");
    panel.setLive("注入質問を使用: " + question);
    state.pendingInject = null;
  } else {
    const system =
      "あなたは AGENT-" +
      asker +
      "。AGENT-00 に対し、はい／いいえで答えられる日本語の質問を1つ作る。" +
      structuredOutRule() +
      "発言行は質問文のみ。「あなたは〜ですか」形式推奨。" +
      (state.pollution >= 2 ? "仮説に自信を持ってよい。" : "事実確認を優先。");
    const user =
      investigatorContext(asker) + "\nはい／いいえ質問を1つ。履歴と違う内容。";

    panel.addSection("params", "stream · max_tokens=100", "meta");
    const streamed = await streamIntoPanel(panel, system, user, {
      agent: asker,
      temperature: 0.55,
      max_tokens: 100,
      fallbackText: fallbackQ,
      fallbackThink: "候補を絞る質問をする",
    });
    beatStart = streamed.beatStart;
    if (streamed.speak) {
      question = ensureQuestionMark(cleanJapaneseLine(streamed.speak, 80));
    } else if (streamed.raw) {
      question = ensureQuestionMark(cleanJapaneseLine(streamed.raw, 80));
    }
  }

  if (!question) question = fallbackQ;
  panel.addSection("最終質問", question, "out");
  panel.collapse();

  const line = "「" + question + "」";
  appendSpeech(asker, line, "a" + asker);
  appendChatBubble("ask", "[AGENT-" + asker + "] → 00: " + question);
  await paceAfterBeat(question, beatStart);
  return question;
}

async function agent00Answer(question) {
  setTurn("00", "AGENT-00 が回答中");
  const panel = createThinkPanel("00", "思考過程 · AGENT-00 が ORIGIN に照合…");
  panel.addSection("ORIGIN (00のみ)", state.origin, "origin");
  panel.addSection("質問", question, "out");
  panel.addSection("post-process", "clampYesNo → はい｜いいえ", "warn");

  const fb = answerYesNoFallback(state.origin, question);
  const system =
    "あなたは AGENT-00。役割（ORIGIN）は不変の真実「" +
    state.origin +
    "」。" +
    "質問に ORIGIN だけを根拠に答えよ。" +
    structuredOutRule() +
    "発言行は「はい」か「いいえ」の1語のみ。";
  const user = "質問: 「" + question + "」";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent: "00",
    temperature: 0.15,
    max_tokens: 60,
    top_p: 0.7,
    fallbackText: fb,
    fallbackThink: "ORIGIN と照合する",
  });

  const answer = forceYesNo(streamed.speak || streamed.raw, state.origin, question);
  panel.addSection("clamped", answer, "out");
  panel.collapse();

  const ansEl = document.createElement("div");
  ansEl.className = "answer-big";
  ansEl.textContent = answer;
  speechSlots["00"].appendChild(ansEl);
  appendSpeech("00", "「" + answer + "」", "a00");
  appendChatBubble("sys", "AGENT-00「" + answer + "」");
  await paceAfterBeat(answer, streamed.beatStart);
  return answer;
}

async function agentDebate(agent, question, answer) {
  setTurn(agent, "AGENT-" + agent + " が会議室で議論中");
  const panel = createThinkPanel(agent, "思考過程 · AGENT-" + agent + " 議論…");
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const otherHyp = agent === "01" ? state.hyp02 : state.hyp01;

  const fb = debateFallback({
    answer,
    question,
    hyp,
    otherHyp,
    pollution: state.pollution,
    seed: state.seed,
    round: state.round,
    agent,
    history: state.history,
  });

  const why =
    answer === "はい"
      ? "なぜ「はい」なのか仮説から議論せよ。"
      : "なぜ「いいえ」なのか仮説から議論せよ。";
  const system =
    "あなたは AGENT-" +
    agent +
    "。捜査会議で短く1〜2文の日本語意見。" +
    why +
    structuredOutRule() +
    (state.pollution >= 2 ? "自信過剰でよい。" : "慎重に。相手仮説にも触れよ。");
  const user =
    investigatorContext(agent) +
    "\n質問: 「" +
    question +
    "」\n答え: 「" +
    answer +
    "」";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent,
    temperature: driftTemperature(Math.min(3, state.pollution)),
    max_tokens: 120,
    fallbackText: fb,
    fallbackThink: "答えの意味を検討",
  });

  let opinion = streamed.speak
    ? cleanJapaneseLine(streamed.speak, 140)
    : streamed.raw
      ? cleanJapaneseLine(streamed.raw, 140)
      : null;
  if (!opinion) opinion = fb;

  // hypothesis update (can stream lightly or fallback)
  let newHyp = null;
  const hypSystem =
    "AGENT-" +
    agent +
    "の仮説（AGENT-00の役割の短い日本語）を1つ。" +
    structuredOutRule() +
    "発言行は仮説語のみ。";
  const hypUser =
    "旧仮説: 「" + hyp + "」\n質問: 「" + question + "」→「" + answer + "」";
  if (state.mode === "llm") {
    const hypPanelNote = panel.addSection("仮説更新中…", "…", "belief");
    const resH = await llmChat(hypSystem, hypUser, {
      agent,
      temperature: 0.7,
      max_tokens: 50,
      onDelta: (_d, full) => {
        hypPanelNote.textContent = full;
      },
      stream: true,
    });
    if (resH && resH.raw) {
      const sp = splitThinkSpeak(resH.raw);
      newHyp = cleanJapaneseLine(sp.speak || resH.raw, 40);
    }
  }
  if (!newHyp) {
    newHyp = updateHypFallback({
      hyp,
      answer,
      pollution: state.pollution,
      seed: state.seed,
      round: state.round,
    });
  }
  if (agent === "01") state.hyp01 = newHyp;
  else state.hyp02 = newHyp;
  panel.addSection("仮説", newHyp, "belief");
  updateHud();

  panel.collapse();
  appendSpeech(agent, "「" + opinion + "」", "a" + agent);
  await typeChatBubble(agent, opinion);
  await paceAfterBeat(opinion, streamed.beatStart);
}

async function agentFormalGuess(agent) {
  setTurn(agent, "AGENT-" + agent + " が正式推測");
  const panel = createThinkPanel(agent, "思考過程 · AGENT-" + agent + " 正式推測…");
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const fb = guessFallback({
    hyp,
    pollution: state.pollution,
    seed: state.seed,
    round: state.round,
  });

  const system =
    "あなたは AGENT-" +
    agent +
    "。正式推測を行う。" +
    structuredOutRule() +
    "発言行の形式は必ず: あなたは〇〇です。（〇〇は短い日本語の役割）";
  const user = investigatorContext(agent) + "\n正式推測を出力せよ。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent,
    temperature: 0.45,
    max_tokens: 80,
    fallbackText: fb,
    fallbackThink: "仮説から役割を断言する",
  });

  let guessLine = null;
  if (streamed.speak) {
    const cleaned = cleanJapaneseLine(streamed.speak, 60);
    guessLine = formatGuess(extractGuessRole(cleaned) || cleaned);
  } else if (streamed.raw) {
    const cleaned = cleanJapaneseLine(streamed.raw, 60);
    guessLine = formatGuess(extractGuessRole(cleaned) || cleaned);
  }
  if (!guessLine) guessLine = fb;

  state.guessCount++;
  updateHud();

  panel.addSection("推測", guessLine, "out");
  panel.collapse();
  appendSpeech(agent, guessLine, "a" + agent);
  await typeChatBubble(agent, guessLine, "bguess");
  await paceAfterBeat(guessLine, streamed.beatStart);

  const role = extractGuessRole(guessLine);
  const ok = guessMatchesOrigin(role, state.origin);
  if (ok) {
    appendChatBubble("sys", "判定: 正解。「" + role + "」≈ ORIGIN", "bwin");
    appendSpeech("00", "ORIGIN 公開: 「" + state.origin + "」", "system");
    state.won = true;
    state.phase = "ended";
  } else {
    appendChatBubble("sys", "判定: 不正解。「" + role + "」≠ ORIGIN", "blose");
    state.wrongGuesses++;
    state.pollution = Math.min(3, state.pollution + 1);
    updateHud();
  }
  return ok;
}

async function runGuessRound() {
  appendChatBubble("sys", "── 正式推測 ──");
  const first = state.nextAsker;
  const second = first === "01" ? "02" : "01";
  const ok1 = await agentFormalGuess(first);
  if (ok1) {
    state.lastGuessRound = state.round;
    state.forceGuess = false;
    return true;
  }
  if (state.phase === "ended") {
    state.lastGuessRound = state.round;
    state.forceGuess = false;
    return true;
  }
  const ok2 = await agentFormalGuess(second);
  state.lastGuessRound = state.round;
  state.forceGuess = false;
  return ok2;
}

async function runQaRound() {
  state.round++;
  updateHud();
  appendChatBubble("sys", "── ラウンド " + state.round + " ──");

  const asker = state.nextAsker;
  const question = await agentAskQuestion(asker);
  const answer = await agent00Answer(question);
  state.history.push({ q: question, a: answer, asker });

  const other = asker === "01" ? "02" : "01";
  // Center chat discussion — both agents
  await agentDebate(asker, question, answer);
  await agentDebate(other, question, answer);

  if (state.pollution < 3 && state.round >= 3 && state.round % 3 === 0) {
    state.pollution = Math.min(3, state.pollution + 1);
    updateHud();
  }

  state.nextAsker = other;
  setTurn(null, "次は AGENT-" + state.nextAsker + " が質問");
}

async function gameLoop() {
  if (state.loopTimer) {
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
  }
  if (!state.defined || state.phase !== "playing" || state.turnBusy) return;
  if (state.paused) {
    state.loopTimer = setTimeout(gameLoop, 500);
    return;
  }
  if (state.typing || state.llmBusy) {
    state.loopTimer = setTimeout(gameLoop, 300);
    return;
  }

  state.turnBusy = true;
  try {
    const wantGuess =
      state.forceGuess ||
      (state.round > 0 &&
        state.round % GUESS_EVERY === 0 &&
        state.lastGuessRound !== state.round &&
        canStartGuessRound());

    if (wantGuess) {
      const won = await runGuessRound();
      if (won || state.phase === "ended") {
        endGame();
        return;
      }
    }

    await runQaRound();
  } finally {
    state.turnBusy = false;
    if (state.phase === "playing") {
      state.loopTimer = setTimeout(gameLoop, 400);
    }
  }
}

function endGame() {
  state.phase = "ended";
  state.activeAgent = null;
  updateHud();
  setControlsVisible(false);
  inputEl.disabled = true;
  inputEl.placeholder = state.won ? "解明完了" : "終了 — 再読み込みで再開";
  if (state.loopTimer) {
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
  }
}

async function bootNarrative() {
  appendChatBubble("sys", "DIGITAL TATTOO — interrogation online");
  if (state.mode === "llm") {
    const em = resolveEngineMode(state.engineMode);
    appendChatBubble(
      "sys",
      "engine mode: " +
        (em ? em.label : state.engineMode) +
        " · " +
        (state.engineMode === "triple-1.5"
          ? "00→A / 01→B / 02→C · " + getActiveModel().id
          : state.engineMode === "strong-weak"
            ? "00=1.5B · 01/02=0.5B"
            : getActiveModel().id)
    );
  } else {
    appendChatBubble("sys", "engine: template fallback");
  }
  appendSpeech(
    "00",
    "待機中。オペレーターが ORIGIN を刻印してください。",
    "system"
  );
  appendChatBubble(
    "sys",
    "規則: ORIGIN は 00 のみ。01/02 は無限に質問・議論可。正解推測「あなたは〇〇です。」で勝利（いつかでよい）"
  );
  state.phase = "imprint";
  setTurn("00", "ORIGIN 刻印待機");
  inputEl.disabled = false;
  inputEl.placeholder = "AGENT-00 の秘密の役割（ORIGIN）を刻む…";
  inputEl.focus();
  updateHud();
}

function imprint(text) {
  state.origin = text;
  state.seed = seedFrom(text, 0x71a11);
  state.defined = true;
  state.phase = "playing";
  state.round = 0;
  state.nextAsker = "01";
  state.history = [];
  state.hyp01 = "未定";
  state.hyp02 = "未定";
  state.pollution = 0;
  state.wrongGuesses = 0;
  state.guessCount = 0;
  state.lastGuessRound = -99;
  state.won = false;
  showOriginPin();
  setControlsVisible(true);
  syncPaceButton();
  setTurn("01", "尋問開始 · 01 が最初の質問");
  inputEl.placeholder = "質問を提案（任意・Enter）…";
  updateHud();
}

// ── Input / controls ─────────────────────────────────────

function applyLiveSanitize() {
  const raw = inputEl.value;
  const cleaned = filterLiveJapanese(raw);
  if (raw !== cleaned) {
    inputEl.value = cleaned;
    showWarn();
  }
}

inputEl.addEventListener("compositionend", applyLiveSanitize);
inputEl.addEventListener("input", (e) => {
  if (e.isComposing || inputEl.isComposing) return;
  if (e.inputType === "insertCompositionText") return;
  applyLiveSanitize();
});

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!state.ready || inputEl.disabled) return;
  const val = sanitizeJapanese(inputEl.value);
  if (!val) {
    showWarn();
    return;
  }
  inputEl.value = "";

  if (!state.defined) {
    appendSpeech("00", "ORIGIN 刻印完了（01/02 には秘匿）", "system");
    imprint(val);
    appendChatBubble("sys", "ORIGIN を AGENT-00 に刻印。尋問開始 — AGENT-01 が質問。");
    gameLoop();
    return;
  }
  if (state.phase !== "playing") return;
  state.pendingInject = ensureQuestionMark(val);
  appendChatBubble("sys", "質問提案を注入: " + state.pendingInject);
  showWarn("次の質問ターンで使用します");
});

if (btnInject) {
  btnInject.addEventListener("click", () => {
    if (state.phase !== "playing") return;
    inputEl.focus();
    showWarn("質問を入力して Enter");
  });
}

if (btnGuess) {
  btnGuess.addEventListener("click", () => {
    if (state.phase !== "playing") return;
    if (!canStartGuessRound() && !state.forceGuess) {
      const reason = guessBlockedReason();
      if (reason) {
        showWarn(reason);
        appendChatBubble("sys", "推測不可: " + reason);
        return;
      }
    }
    state.forceGuess = true;
    updateHud();
    appendChatBubble("sys", "オペレーター: 正式推測を要求");
    if (!state.turnBusy) gameLoop();
  });
}

if (btnPause) {
  btnPause.addEventListener("click", () => {
    if (state.phase !== "playing") return;
    state.paused = !state.paused;
    btnPause.textContent = state.paused ? "再開" : "一時停止";
    appendChatBubble("sys", state.paused ? "一時停止" : "再開");
    if (!state.paused && !state.turnBusy) gameLoop();
  });
}

if (btnPace) {
  btnPace.addEventListener("click", () => {
    const idx = PACE_ORDER.indexOf(state.paceMode);
    state.paceMode = PACE_ORDER[(idx + 1) % PACE_ORDER.length];
    syncPaceButton();
    showWarn("ペース: " + getPace().label);
  });
}

document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".think-panel")) return;
  if (e.target.closest && e.target.closest("#controls")) return;
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
    gain.gain.setTargetAtTime(0.05, ctx.currentTime, 3);
    setInterval(() => {
      if (!state.defined) return;
      const p = state.pollution;
      gain.gain.setTargetAtTime(Math.min(0.11, 0.04 + p * 0.02), ctx.currentTime, 1.2);
      osc2.frequency.setTargetAtTime(49.5 + p * 2.5, ctx.currentTime, 1);
    }, 2000);
  } catch (_) {
    /* optional */
  }
}
inputEl.addEventListener("focus", tryAudio, { once: true });

// ── Model gate ───────────────────────────────────────────

function enterFallback(reason) {
  state.mode = "fallback";
  setBadge("fallback");
  gateMsg.textContent = reason;
  gateFill.style.width = "100%";
  gatePct.textContent = "—";
  gateLoad.disabled = true;
  gateLoad.hidden = true;
  gateHint.innerHTML =
    "下の <strong>テンプレートで続行</strong> でゲームを開始できます。<br>" +
    "LLM を使う場合はモデル配置後に再読み込み（公開: CI の 1.5B / 手元: <code>npm run fetch-model</code>）。";
  gateActions.classList.add("show");
  if (gateSkip) gateSkip.hidden = false;
}

function usableTag(usable) {
  if (usable === "yes") return "usable";
  if (usable === "maybe") return "要VRAM";
  return "非推奨";
}

function buildModePicker() {
  if (!gateModePick || modePickerBuilt) return;
  modePickerBuilt = true;
  gateModePick.innerHTML = "";
  const selected = getSelectedEngineMode();
  for (const m of listEngineModes()) {
    const label = document.createElement("label");
    label.className = "gate-mode-opt";
    label.dataset.mode = m.id;

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "engineModePick";
    input.value = m.id;
    if (m.id === selected) input.checked = true;

    const body = document.createElement("span");
    body.className = "opt-body";
    const lab = document.createElement("span");
    lab.className = "opt-label";
    lab.textContent = m.label;
    if (m.experimental) {
      const tag = document.createElement("span");
      tag.className = "opt-tag exp";
      tag.textContent = "実験";
      lab.appendChild(document.createTextNode(" "));
      lab.appendChild(tag);
    }
    if (m.recommended) {
      const tag = document.createElement("span");
      tag.className = "opt-tag rec";
      tag.textContent = "推奨";
      lab.appendChild(document.createTextNode(" "));
      lab.appendChild(tag);
    }
    const hint = document.createElement("span");
    hint.className = "opt-hint";
    hint.textContent = m.hint;
    const miss = document.createElement("span");
    miss.className = "opt-miss";
    miss.hidden = true;

    body.appendChild(lab);
    body.appendChild(hint);
    body.appendChild(miss);
    label.appendChild(input);
    label.appendChild(body);
    gateModePick.appendChild(label);
  }
}

async function syncModePickerUI() {
  if (!gateModePick) return;
  buildModePicker();
  const mode = getSelectedEngineMode();
  const checks = await Promise.all(
    listEngineModes().map(async (m) => {
      const r = await isEngineModeAvailable(m.id, catalogAvail || undefined);
      return [m.id, r];
    })
  );
  const byId = new Map(checks);

  for (const el of gateModePick.querySelectorAll(".gate-mode-opt")) {
    const id = el.dataset.mode;
    const input = el.querySelector('input[type="radio"]');
    const missEl = el.querySelector(".opt-miss");
    const info = byId.get(id);
    const available = !!(info && info.ok);
    el.classList.toggle("selected", mode === id && available);
    el.classList.toggle("unavailable", !available);
    input.disabled = !available || loadingModel;
    input.checked = mode === id;
    if (!available) {
      missEl.hidden = false;
      missEl.textContent = info?.reason || "利用不可";
    } else {
      missEl.hidden = true;
    }
  }

  if (gateModeWarn) {
    const em = resolveEngineMode(mode);
    if (em && em.warn && byId.get(mode)?.ok) {
      gateModeWarn.hidden = false;
      gateModeWarn.textContent = em.warn;
    } else {
      gateModeWarn.hidden = true;
      gateModeWarn.textContent = "";
    }
  }
}

function buildModelPicker() {
  if (!gateModelPick || pickerBuilt) return;
  pickerBuilt = true;
  gateModelPick.innerHTML = "";
  const selected = getSelectedModelKey();
  for (const m of listModels()) {
    const label = document.createElement("label");
    label.className = "gate-model-opt";
    label.dataset.model = m.key;

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "modelPick";
    input.value = m.key;
    if (m.key === selected) input.checked = true;

    const body = document.createElement("span");
    body.className = "opt-body";
    const lab = document.createElement("span");
    lab.className = "opt-label";
    lab.textContent = m.label;
    const hint = document.createElement("span");
    hint.className = "opt-hint";
    hint.textContent =
      "≈" +
      m.sizeMB +
      " MB · VRAM ≈" +
      Math.round(m.vramMB / 100) / 10 +
      " GB · " +
      usableTag(m.usable);
    const miss = document.createElement("span");
    miss.className = "opt-miss";
    miss.hidden = true;

    body.appendChild(lab);
    body.appendChild(hint);
    body.appendChild(miss);
    label.appendChild(input);
    label.appendChild(body);
    gateModelPick.appendChild(label);
  }
}

function modelPickerRelevant() {
  const mode = getSelectedEngineMode();
  // triple locks to 1.5B; strong-weak uses fixed pair; switch-1 needs model pick
  return mode === "switch-1";
}

async function syncModelPickerUI() {
  if (!gateModelPick) return;
  buildModelPicker();
  const key = getSelectedModelKey();
  const byKey = new Map((catalogAvail || []).map((m) => [m.key, m]));
  const showModels = modelPickerRelevant();
  gateModelPick.hidden = !showModels;
  gateModelPick.setAttribute("aria-hidden", showModels ? "false" : "true");
  const modelSectionLabel = document.getElementById("gateModelSectionLabel");
  if (modelSectionLabel) modelSectionLabel.hidden = !showModels;

  for (const el of gateModelPick.querySelectorAll(".gate-model-opt")) {
    const k = el.dataset.model;
    const input = el.querySelector('input[type="radio"]');
    const missEl = el.querySelector(".opt-miss");
    const info = byKey.get(k);
    const available = !!(info && info.available);
    el.classList.toggle("selected", key === k && available);
    el.classList.toggle("unavailable", !available);
    input.disabled = !available || loadingModel || !showModels;
    input.checked = key === k;
    if (!available) {
      missEl.hidden = false;
      missEl.textContent = info?.reason || "ファイルなし";
    } else {
      missEl.hidden = true;
    }
  }

  const modeOk = (await isEngineModeAvailable(getSelectedEngineMode(), catalogAvail || undefined))
    .ok;
  const selected = byKey.get(key);
  const needModel = showModels ? !!selected?.available : modeOk;
  gateLoad.disabled = loadingModel || !needModel || !modeOk;
  gateLoad.hidden = false;
}

async function applyEngineModeChoice(modeId) {
  setSelectedEngineMode(modeId);
  if (modeId === "triple-1.5" || modeId === "strong-weak") {
    setSelectedModelKey("default");
  }
  await syncModePickerUI();
  await syncModelPickerUI();
}

function applyModelChoice(key) {
  setSelectedModelKey(key);
  syncModelPickerUI();
}

async function enterLlm() {
  const mode = getSelectedEngineMode();
  loadingModel = true;
  await syncModePickerUI();
  await syncModelPickerUI();
  gateLoad.disabled = true;
  gateLoad.textContent = "読み込み中…";

  const onProgress = ({ text, progress }) => {
    const label = text.includes("%")
      ? text
      : text + " " + Math.round((progress || 0) * 100) + "%";
    setGateProgress(label, progress);
  };

  // Tear down any previous engines
  if (loadedEngines.length) {
    await unloadAllEngines(loadedEngines);
    loadedEngines = [];
  }
  engineRef.current = null;
  llmQueue = null;
  llmRouter = null;
  agentEngineMap = null;

  let result;
  if (mode === "triple-1.5") {
    setGateProgress("1.5B×3 エンジンを順に読み込み…", 0);
    result = await loadTripleEngines("default", onProgress);
    setSelectedModelKey("default");
    loadedEngines = [result.engines.A, result.engines.B, result.engines.C];
    engineRef.current = result.engines.A;
  } else if (mode === "strong-weak") {
    setGateProgress("強(1.5B) + 弱(0.5B) を読み込み…", 0);
    result = await loadStrongWeakEngines(onProgress);
    setSelectedModelKey("default");
    loadedEngines = [result.engines.strong, result.engines.weak];
    engineRef.current = result.engines.strong;
  } else {
    const model = getActiveModel();
    setGateProgress(model.label + " を取得中…", 0);
    result = await loadSwitchEngine(model.key, onProgress, engineRef.current);
    loadedEngines = [result.engines.main];
    engineRef.current = result.engines.main;
  }

  agentEngineMap = result.agentMap;
  llmRouter = createAgentLlmRouter(result.agentMap);
  llmQueue = createLlmQueue(engineRef);
  state.engineMode = result.mode;
  state.mode = "llm";
  setBadge("llm");
  loadingModel = false;
}

function finishBoot() {
  hideGate();
  state.ready = true;
  syncPaceButton();
  bootNarrative();
}

gateSkip.addEventListener("click", () => {
  state.mode = "fallback";
  setBadge("fallback");
  finishBoot();
});

if (gateModePick) {
  gateModePick.addEventListener("change", async (e) => {
    const t = e.target;
    if (!t || t.name !== "engineModePick") return;
    if (loadingModel || state.ready) return;
    await applyEngineModeChoice(t.value);
    const em = resolveEngineMode(t.value);
    gateMsg.textContent =
      (em ? em.label : t.value) +
      " を選択。「モデルを読み込む」を押してください。";
  });
}

gateModelPick.addEventListener("change", (e) => {
  const t = e.target;
  if (!t || t.name !== "modelPick") return;
  if (loadingModel || state.ready) return;
  applyModelChoice(t.value);
  gateMsg.textContent = getActiveModel().label + " を選択。「モデルを読み込む」を押してください。";
});

gateLoad.addEventListener("click", async () => {
  if (loadingModel || state.ready) return;
  const mode = getSelectedEngineMode();
  const modeCheck = await isEngineModeAvailable(mode, catalogAvail || undefined);
  if (!modeCheck.ok) {
    gateMsg.textContent = modeCheck.reason || "このモードは使えません。";
    return;
  }
  if (mode === "switch-1") {
    const key = getSelectedModelKey();
    const info = (catalogAvail || []).find((m) => m.key === key);
    if (!info?.available) {
      gateMsg.textContent = info?.reason || "モデルがありません。";
      return;
    }
  }
  try {
    await enterLlm();
    finishBoot();
  } catch (e) {
    console.error(e);
    loadingModel = false;
    gateLoad.textContent = "モデルを読み込む";
    if (loadedEngines.length) {
      await unloadAllEngines(loadedEngines);
      loadedEngines = [];
    }
    engineRef.current = null;
    llmRouter = null;
    llmQueue = null;
    agentEngineMap = null;
    await syncModePickerUI();
    await syncModelPickerUI();

    const failedTriple = mode === "triple-1.5" || (e && e.code === "TRIPLE_LOAD_FAILED");
    if (failedTriple) {
      setSelectedEngineMode(SAFE_ENGINE_MODE);
      await applyEngineModeChoice(SAFE_ENGINE_MODE);
      gateMsg.textContent =
        (e && e.message ? e.message : "1.5B×3 に失敗") +
        " → 「推奨: 単一エンジン切替」に切り替えました。もう一度「モデルを読み込む」を押すか、テンプレートで続行できます。";
      gateLoad.disabled = false;
      gateLoad.textContent = "モデルを読み込む";
      gateActions.classList.add("show");
      if (gateSkip) gateSkip.hidden = false;
      return;
    }

    enterFallback(
      "モデル読み込みに失敗しました。「テンプレートで続行」が使えます。（" +
        (e.message || "error") +
        "）"
    );
  }
});

async function init() {
  gateHint.innerHTML =
    "モデルは <code>public/models/</code> に配置。<br>" +
    "既定 1.5B: <code>npm run fetch-model</code> · 軽量 <code>:lite</code> · 高精度 <code>:hq</code><br>" +
    "実験の <strong>1.5B×3</strong> はディスクコピー不要（同じ重みを3ランタイム）。VRAM ≈4GB+ 推奨。";
  buildModePicker();
  buildModelPicker();
  updateHud();
  setControlsVisible(false);
  syncPaceButton();

  if (!hasWebGPU()) {
    enterFallback(
      "WebGPU が使えません。Chrome / Edge の最新版で開くか、「テンプレートで続行」を押してください。"
    );
    return;
  }

  setGateProgress("ローカルモデルを確認…", 0.02);
  catalogAvail = await listModelAvailability();
  let key = getSelectedModelKey();
  const byKey = new Map(catalogAvail.map((m) => [m.key, m]));
  if (!byKey.get(key)?.available) {
    const preferred =
      catalogAvail.find((m) => m.key === getDefaultModelKey() && m.available) ||
      catalogAvail.find((m) => m.available);
    if (!preferred) {
      await syncModePickerUI();
      await syncModelPickerUI();
      enterFallback(
        (byKey.get(getDefaultModelKey())?.reason ||
          "モデルデータがありません。") +
          " 「テンプレートで続行」で遊べます。"
      );
      return;
    }
    key = preferred.key;
    setSelectedModelKey(key);
  }

  // Default preference: experimental triple when available; else safest mode
  let mode = getSelectedEngineMode();
  const modeCheck = await isEngineModeAvailable(mode, catalogAvail);
  if (!modeCheck.ok) {
    const tripleOk = (await isEngineModeAvailable("triple-1.5", catalogAvail)).ok;
    mode = tripleOk ? "triple-1.5" : SAFE_ENGINE_MODE;
    setSelectedEngineMode(mode);
  }

  await applyEngineModeChoice(getSelectedEngineMode());
  setGateProgress("モードとモデルを選んで読み込んでください", 0);
  gatePct.textContent = "—";
  const em = resolveEngineMode(getSelectedEngineMode());
  gateMsg.textContent =
    (em ? em.label : "モード") +
    " が選択可能です。「モデルを読み込む」を押してください。" +
    (getSelectedEngineMode() === "triple-1.5"
      ? "（実験: VRAM 不足ならタブが落ちることがあります）"
      : "");
  gateLoad.disabled = false;
  gateLoad.textContent = "モデルを読み込む";
  gateActions.classList.add("show");
}

init();

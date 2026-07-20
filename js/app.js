/**
 * DIGITAL TATTOO — interrogation game (3-zone layout)
 *
 *   [ AGENT-00 top ]
 * [01 left] [ LINE chat ] [02 right]
 *
 * ORIGIN imprinted on 00 only. 01/02 ask yes/no; discuss in center;
 * formal guess: 「あなたは〇〇です。」
 * LLM streams live into thinking panels; steady user-controlled read pacing.
 */

import {
  seedFrom,
  clip,
  answerYesNoFallback,
  isClearOriginIdentityAsk,
  askQuestionFallback,
  debateFallback,
  updateHypFallback,
  guessFallback,
  formatGuess,
  extractGuessRole,
  guessMatchesOrigin,
} from "./fallback.js";

import {
  getActiveModel,
  getDefaultModelKey,
  listModels,
  listModelAvailability,
  resolveModel,
  AGENT_IDS,
  getAgentAssignments,
  setAgentAssignments,
  setAgentAssignment,
  coerceAssignmentsToAvailable,
  uniqueAssignmentKeys,
  estimateAssignmentVramMB,
  areAssignmentsAvailable,
  loadAgentAssignments,
  explainLoadError,
  isGitHubPagesHost,
  hasWebGPU,
  createLlmQueue,
  createAgentLlmRouter,
  unloadAllEngines,
} from "./llm.js";

/** Unbounded Q&A / 01↔02 discussion until correct guess (or pause/reload). */
const MIN_ROUNDS_BEFORE_GUESS = 1;
/** Mild anti-spam only — formal guesses may still land “someday”. */
const GUESS_COOLDOWN_ROUNDS = 2;
/**
 * エージェント01↔02 の議論発言がこの数に達するまで正式推測を許可しない。
 * （キャッチフレーズ1往復で推測へ飛ばない）
 */
const MIN_DISCUSS_BEFORE_GUESS = 10;
/** 00 の各回答のあと、01↔02 が最低これだけ交互に議論してから次の質問へ。 */
const DISCUSSION_TURNS_PER_ANSWER = 4;

const PACE_PRESETS = {
  slow: { charsPerSec: 7, typeMs: 12, bufferMs: 520, label: "じっくり" },
  normal: { charsPerSec: 10, typeMs: 6, bufferMs: 320, label: "標準" },
  fast: { charsPerSec: 14, typeMs: 3, bufferMs: 180, label: "やや速め" },
};
const PACE_ORDER = ["slow", "normal", "fast"];

const appEl = document.getElementById("app");
const inputEl = document.getElementById("userInput");
const formEl = document.getElementById("inputRow");
const warnEl = document.getElementById("warn");
const cohFill = document.getElementById("coherenceFill");
const cohLabel = document.getElementById("coherenceLabel");
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
const gateAgentAssign = document.getElementById("gateAgentAssign");
const gateAssignWarn = document.getElementById("gateAssignWarn");
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
const btnDownload = document.getElementById("btnDownload");
const controlsEl = document.getElementById("controls");
const downloadRowEl = document.getElementById("downloadRow");

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
  /** 01↔02 議論発言の累計（正式推測ゲート用） */
  discussTurns: 0,
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
  paceMode: "slow",
  engineMode: "per-agent",
  /** @type {Record<"00"|"01"|"02", string> | null} */
  agentModels: null,
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
let assignPickerBuilt = false;

/** Chronological session transcript for UTF-8 .txt download. */
/** @type {Array<{ t: number, kind: string, agent?: string, label?: string, text: string }>} */
const sessionLog = [];

function logSession(entry) {
  sessionLog.push({
    t: Date.now(),
    kind: entry.kind || "note",
    agent: entry.agent || "",
    label: entry.label || "",
    text: entry.text == null ? "" : String(entry.text),
  });
  syncDownloadUi();
}

function clearSessionLog() {
  sessionLog.length = 0;
  syncDownloadUi();
}

/** Show download once ORIGIN / any log exists; keep visible through play + end. */
function syncDownloadUi() {
  const has = sessionLog.length > 0 || !!state.origin;
  if (downloadRowEl) downloadRowEl.classList.toggle("show", has);
  if (btnDownload) btnDownload.disabled = !has;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function sessionFilename() {
  const d = new Date();
  return (
    "digital-tattoo-" +
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    "-" +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    ".txt"
  );
}

function buildSessionTranscript() {
  const lines = [];
  lines.push("DIGITAL TATTOO — セッション記録");
  lines.push("保存時刻: " + new Date().toLocaleString("ja-JP"));
  lines.push("エンジン: " + (state.mode === "llm" ? "LLM · " + assignmentShortLabel() : "TEMPLATE"));
  lines.push("");
  lines.push("======== ORIGIN（エージェント00のみ） ========");
  lines.push(state.origin ? state.origin : "（未刻印）");
  lines.push("");
  lines.push("======== 時系列ログ ========");
  lines.push("（思考 = 画面の思考パネル内容 / 発言 = 台詞・チャット）");
  lines.push("");

  for (const e of sessionLog) {
    const who = e.agent ? agentDisplayName(e.agent) : "システム";
    const time = new Date(e.t).toLocaleTimeString("ja-JP");
    if (e.kind === "origin") {
      lines.push("[" + time + "] [ORIGIN] " + e.text);
    } else if (e.kind === "think-start") {
      lines.push("[" + time + "] [" + who + "] 【思考開始】 " + (e.label || e.text));
    } else if (e.kind === "think") {
      lines.push(
        "[" + time + "] [" + who + "] 【思考】" + (e.label ? " " + e.label : "")
      );
      lines.push(e.text || "（なし）");
    } else if (e.kind === "speech") {
      lines.push("[" + time + "] [" + who + "] 【発言】 " + e.text);
    } else if (e.kind === "chat") {
      const tag = e.agent ? "[" + agentDisplayName(e.agent) + "]" : "[チャット]";
      lines.push("[" + time + "] " + tag + " " + e.text);
    } else {
      lines.push("[" + time + "] [" + who + "] " + (e.label ? e.label + ": " : "") + e.text);
    }
    lines.push("");
  }

  lines.push("======== 終了 ========");
  return lines.join("\n");
}

function downloadSessionTranscript() {
  if (!sessionLog.length && !state.origin) {
    showWarn("まだ記録がありません");
    return;
  }
  const text = buildSessionTranscript();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sessionFilename();
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showWarn("記録を保存しました");
}

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

function assignmentShortLabel() {
  const map = state.agentModels || agentEngineMap;
  if (!map) return getActiveModel().shortLabel;
  const bits = AGENT_IDS.map((id) => {
    const key = map[id]?.model?.key || map[id]?.key || map[id];
    const m =
      (map[id] && map[id].model) ||
      resolveModel(typeof key === "string" ? key : "") ||
      null;
    return m ? m.shortLabel : "?";
  });
  const uniq = [...new Set(bits)];
  if (uniq.length === 1) return "00/01/02=" + uniq[0];
  return (
    "00=" +
    bits[0] +
    " · 01=" +
    bits[1] +
    " · 02=" +
    bits[2]
  );
}

function setBadge(mode) {
  if (mode === "llm") {
    engineBadge.textContent = "LLM · " + assignmentShortLabel();
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
  // Calm progress only — discussion depth toward formal-guess gate (no anxiety colors).
  const discussPct = Math.min(
    100,
    Math.round((state.discussTurns / Math.max(1, MIN_DISCUSS_BEFORE_GUESS)) * 100)
  );
  cohFill.style.width = discussPct + "%";
  cohFill.style.background = "var(--green)";

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
    " · 議論" +
    state.discussTurns +
    "/" +
    MIN_DISCUSS_BEFORE_GUESS +
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
}

function setControlsVisible(show) {
  if (controlsEl) controlsEl.classList.toggle("show", !!show);
  // Download lives outside #controls — refresh whenever control visibility changes.
  syncDownloadUi();
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
  if (state.discussTurns < MIN_DISCUSS_BEFORE_GUESS) return false;
  if (state.round - state.lastGuessRound < GUESS_COOLDOWN_ROUNDS) return false;
  return true;
}

function canStartGuessRound() {
  if (state.round < MIN_ROUNDS_BEFORE_GUESS) return false;
  if (state.discussTurns < MIN_DISCUSS_BEFORE_GUESS) return false;
  if (state.forceGuess) return true;
  return state.round - state.lastGuessRound >= GUESS_COOLDOWN_ROUNDS;
}

function guessBlockedReason() {
  if (state.round < MIN_ROUNDS_BEFORE_GUESS) {
    return "あと " + (MIN_ROUNDS_BEFORE_GUESS - state.round) + " ラウンド質問が必要です";
  }
  if (state.discussTurns < MIN_DISCUSS_BEFORE_GUESS) {
    return (
      "エージェント01↔02の議論がまだ " +
      state.discussTurns +
      "/" +
      MIN_DISCUSS_BEFORE_GUESS +
      " 回です。もう少し深めてから推測できます"
    );
  }
  const left = GUESS_COOLDOWN_ROUNDS - (state.round - state.lastGuessRound);
  if (left > 0) return "推測クールダウン残り " + left + " ラウンド（連打防止）";
  return "";
}

function agentDisplayName(agent) {
  if (agent === "00") return "エージェント00";
  if (agent === "01") return "エージェント01";
  if (agent === "02") return "エージェント02";
  return "エージェント" + agent;
}

/** Prompt / UI label — always エージェントNN (never 代理人). */
function agentPromptName(agent) {
  return agentDisplayName(agent);
}

function namingClarityRule() {
  return (
    "呼称ルール: 必ず「エージェント00」「エージェント01」「エージェント02」と呼ぶ。" +
    "「代理人」は絶対禁止（誤訳）。曖昧な「エージェント」単体も禁止。" +
    "役割: エージェント00＝尋問の対象。エージェント01とエージェント02＝尋問する側同士。"
  );
}

function partnerAgent(agent) {
  return agent === "01" ? "02" : "01";
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
    // ASCII / fullwidth digits — keep エージェント01 etc. (stripping → エージェントエージェント)
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0xff10 && cp <= 0xff19) ||
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
  tag.textContent = "[" + agentDisplayName(agent) + "]";
  div.appendChild(tag);
  div.appendChild(document.createTextNode(" " + text));
  slot.appendChild(div);
  scrollEl(slot);
  logSession({ kind: "speech", agent, text: String(text || "") });
  return div;
}

function appendChatBubble(kind, text, extraCls) {
  const div = document.createElement("div");
  div.className = "bubble b" + kind + (extraCls ? " " + extraCls : "");
  if (kind === "01" || kind === "02") {
    const who = document.createElement("span");
    who.className = "b-who";
    who.textContent = "[" + agentDisplayName(kind) + "]";
    div.appendChild(who);
    div.appendChild(document.createTextNode(text));
  } else {
    div.textContent = text;
  }
  chatLog.appendChild(div);
  scrollEl(chatLog);
  logSession({
    kind: "chat",
    agent: kind === "01" || kind === "02" || kind === "00" ? kind : "",
    text: String(text || ""),
  });
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
  who.textContent = "[" + agentDisplayName(agent) + "]";
  div.appendChild(who);
  const body = document.createElement("span");
  div.appendChild(body);
  chatLog.appendChild(div);
  scrollEl(chatLog);
  await typeInto(body, text, getPace().typeMs);
  // Session log: appendSpeech already records the utterance — skip duplicate chat line.
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

  logSession({
    kind: "think-start",
    agent,
    label: title || "思考過程",
    text: "",
  });

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
    const bodyText = text == null || text === "" ? "（なし）" : String(text);
    pre.textContent = bodyText;
    sec.appendChild(lab);
    sec.appendChild(pre);
    body.insertBefore(sec, liveSec);
    scrollEl(body);
    scrollEl(host);
    logSession({ kind: "think", agent, label: String(label || ""), text: bodyText });
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
    const live = String(livePre.textContent || "").trim();
    if (live && live !== "…" && live !== "（なし）") {
      logSession({
        kind: "think",
        agent,
        label: "生成ログ（完了）",
        text: live,
      });
    }
    details.open = false;
    summary.textContent =
      "思考過程 · " + agentDisplayName(agent) + " — クリックで展開";
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
  let t = String(raw || "").trim();
  // Prefer the explicit 発言 / 答 line so thinking text cannot flip the answer.
  const speakMatch = t.match(/(?:発言|答(?:え)?)[:：]\s*([^\n]+)/i);
  if (speakMatch) t = speakMatch[1].trim();
  t = t
    .replace(/^["「『]|["」』]$/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  // Exact / near-exact first (0.5B often echoes just the word).
  if (/^(はい|yes|ｙｅｓ|true)[。．.!！]*$/.test(t)) return "はい";
  if (/^(いいえ|いや|no|ｎｏ|false)[。．.!！]*$/.test(t)) return "いいえ";

  const hasYes = /はい|yes|ｙｅｓ|肯定|そうです|そうだ|うん|ええ/.test(t);
  // Avoid bare 「ない」 — it appears inside unrelated phrases and flips answers.
  const hasNo = /いいえ|いや(?!っ)|(?:^|[^ぁ-ん])no(?:[^a-z]|$)|ｎｏ|否定|違う|ちがう|ではありません|ではない/.test(
    t
  );
  if (hasYes && !hasNo) return "はい";
  if (hasNo && !hasYes) return "いいえ";
  if (hasYes && hasNo) {
    const yi = t.search(/はい|yes|肯定/);
    const ni = t.search(/いいえ|いや|否定|違う|ちがう|ではありません/);
    if (yi >= 0 && (ni < 0 || yi < ni)) return "はい";
    if (ni >= 0) return "いいえ";
  }
  if (/^はい/.test(t) || /^y/.test(t)) return "はい";
  if (/^いいえ/.test(t) || /^いや/.test(t) || /^n/.test(t)) return "いいえ";
  return null;
}

function forceYesNo(raw, origin, question) {
  // Clear identity (ORIGIN literally in the question) → reliable path over LLM.
  // Category asks without ORIGIN wording (動物 etc.) still use LLM / clamp.
  if (isClearOriginIdentityAsk(origin, question)) {
    return answerYesNoFallback(origin, question);
  }
  const clamped = clampYesNo(raw);
  if (clamped) return clamped;
  // Template / garbled LLM only — identity match, never taxonomy dictionary.
  return answerYesNoFallback(origin, question);
}

function cleanJapaneseLine(raw, maxLen) {
  let t = String(raw || "").trim();
  t = t.replace(/^["「『]|["」』]$/g, "");
  t = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || t;
  t =
    sanitizeJapanese(t) ||
    t
      .replace(
        /[^\u3040-\u30ff\u3400-\u9fff\u3000-\u303f\s、。！？「」・？?0-9０-９]/g,
        ""
      )
      .trim();
  return clip(t, maxLen || 120);
}

function ensureQuestionMark(q) {
  let t = String(q || "").trim();
  if (!t) return t;
  if (!/[？?]$/.test(t)) t += "？";
  return t;
}

/** Detect meta / format-instruction "questions" that 01/02 must never utter. */
function isMetaFormatQuestion(q) {
  const t = String(q || "").toLowerCase().replace(/\s+/g, "");
  if (!t) return true;
  // Bare yes/no is not a question from 01/02.
  if (/^(はい|いいえ|yes|no)[。．!?？]*$/.test(t)) return true;
  if (
    /はいと?いいえで答|はい\/いいえで答|はい・いいえで答|yes\s*or\s*no|答えさせ|回答形式|形式で答|はいまたはいいえで|「はい」か「いいえ」で答/.test(
      t
    )
  ) {
    return true;
  }
  if (/答え(て|る|させ)|(答えてください)|(答えよ)/.test(t) && /はい|いいえ|yes|no/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Reject history-echo / prompt-dump "questions" (0.5B often regurgitates Q&A).
 * e.g. エージェントエージェント 「あなたは人間ですか？」 「いいえ？
 */
function isHistoryEchoQuestion(q) {
  const raw = String(q || "").trim();
  if (!raw) return true;
  const t = raw.replace(/\s+/g, "");

  // Doubled / stripped agent label garbage
  if (/エージェントエージェント/.test(t)) return true;
  if (/代理人/.test(t)) return true;

  // Looks like a transcript line, not a fresh interrogative
  if (/→|Q&A|履歴|直前の質問|エージェント00の答え/.test(t)) return true;
  if (/\[\s*エージェント\d{0,2}/.test(raw)) return true;

  // Quoted prior Q plus はい/いいえ (with or without closing brackets)
  const quoteAsks = (raw.match(/「[^」]*[？?]/g) || []).length;
  const hasAnswerToken = /「?(はい|いいえ)[」？?。．!！]*/.test(t);
  if (quoteAsks >= 1 && hasAnswerToken) return true;
  if ((raw.match(/「/g) || []).length >= 2 && hasAnswerToken) return true;

  // Agent name + past Q&A mashed into one line
  if (
    /エージェント\d{0,2}/.test(t) &&
    /ですか/.test(t) &&
    /はい|いいえ/.test(t)
  ) {
    return true;
  }

  // Leading agent name then nested quotes (echo of speech log)
  if (/^エージェント\d{0,2}「/.test(t) && /ですか/.test(t)) return true;

  return false;
}

function isBadInvestigatorQuestion(q) {
  return isMetaFormatQuestion(q) || isHistoryEchoQuestion(q);
}

function historyBlock(limit = 8) {
  const take = state.history.slice(-limit);
  if (!take.length) return "（まだ質問なし）";
  return take
    .map(
      (h, i) =>
        (i + 1) +
        ". [" +
        agentDisplayName(h.asker) +
        "→エージェント00] 「" +
        h.q +
        "」→「" +
        h.a +
        "」"
    )
    .join("\n");
}

function investigatorContext(agent) {
  const selfName = agentDisplayName(agent);
  const partner = partnerAgent(agent);
  const partnerName = agentDisplayName(partner);
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const other = agent === "01" ? state.hyp02 : state.hyp01;
  return (
    "あなたは" +
    agentPromptName(agent) +
    "（尋問する側）。同僚は" +
    agentPromptName(partner) +
    "。対象はエージェント00だけ。\n" +
    namingClarityRule() +
    "\nORIGIN は知らされていない。" +
    "あなたと同僚は自由に日本語で話し合う。" +
    "エージェント00だけが質問に「はい／いいえ」で答える（あなたは答えない）。\n" +
    "あなた(" +
    selfName +
    ")の仮説: 「" +
    clip(hyp, 40) +
    "」\n" +
    partnerName +
    "の仮説: 「" +
    clip(other, 40) +
    "」\nQ&A履歴:\n" +
    historyBlock()
  );
}

function structuredOutRule() {
  return "出力は必ず2行だけ。1行目: 思考: （短い理由） 2行目: 発言: （最終文のみ）。英語禁止。";
}

// ── Agent turns ──────────────────────────────────────────

async function agentAskQuestion(asker) {
  const name = agentPromptName(asker);
  setTurn(asker, name + " が質問中");
  const panel = createThinkPanel(asker, "思考過程 · " + name + " が質問を作成…");
  panel.addSection("注意", "ORIGIN はプロンプトに含まれない · 発言は質問文（はい/いいえではない）", "warn");

  const hyp = asker === "01" ? state.hyp01 : state.hyp02;
  const fallbackQ = askQuestionFallback({
    history: state.history,
    hyp,
    pollution: 0,
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
      "あなたは" +
      name +
      "。" +
      namingClarityRule() +
      "役割: エージェント00に、具体的な日本語の質問文を1つだけ投げかける。" +
      "重要: あなた自身は「はい」や「いいえ」と答えてはいけない。発言行は質問文の全文。" +
      "質問はエージェント00がはい／いいえで答えられる内容にする（例: 「あなたは人間ですか？」）。" +
      "禁止: 回答形式の説明・メタ発言（例: 「はいといいえで答えて」「yes or noで答えさせます」）を質問にすること。" +
      "禁止: 「代理人」という語。" +
      "最初の質問は身分・カテゴリが分かる平易な内容（生物／人間／機械など）がよい。" +
      structuredOutRule() +
      "発言行の例: あなたは生き物ですか？";
    const user =
      investigatorContext(asker) +
      "\nタスク: エージェント00への質問文を1つ作る。履歴と違う内容。" +
      "\nあなたの発言は質問文のみ。はい／いいえの1語は不可。メタ指示も不可。";

    panel.addSection("params", "stream · max_tokens=100", "meta");
    const streamed = await streamIntoPanel(panel, system, user, {
      agent: asker,
      temperature: 0.5,
      max_tokens: 100,
      fallbackText: fallbackQ,
      fallbackThink: "身分やカテゴリを確認する質問をする",
    });
    beatStart = streamed.beatStart;
    if (streamed.speak) {
      question = ensureQuestionMark(cleanJapaneseLine(streamed.speak, 80));
    } else if (streamed.raw) {
      question = ensureQuestionMark(cleanJapaneseLine(streamed.raw, 80));
    }
  }

  if (!question || isBadInvestigatorQuestion(question)) {
    panel.addSection(
      "質問補正",
      "メタ／履歴エコー／形式崩れを検知 → テンプレート質問へ",
      "warn"
    );
    question = fallbackQ;
  }
  panel.addSection("最終質問", question, "out");
  panel.collapse();

  const line = "「" + question + "」";
  appendSpeech(asker, line, "a" + asker);
  appendChatBubble(
    "ask",
    "[" + agentDisplayName(asker) + "] → エージェント00: " + question
  );
  await paceAfterBeat(question, beatStart);
  return question;
}

async function agent00Answer(question) {
  setTurn("00", "エージェント00 が回答中");
  const panel = createThinkPanel("00", "思考過程 · エージェント00 が ORIGIN に照合…");
  panel.addSection("ORIGIN (00のみ)", state.origin, "origin");
  panel.addSection("質問", question, "out");
  panel.addSection("post-process", "clampYesNo（00のみ）→ はい｜いいえ", "warn");

  const fb = answerYesNoFallback(state.origin, question);
  const system =
    "あなたはエージェント00。ORIGIN（秘密の役割）は「" +
    state.origin +
    "」。" +
    namingClarityRule() +
    "あなただけが「はい」か「いいえ」で答える。質問への判定は ORIGIN と常識のみ。" +
    "字面一致だけに頼らない。当てはまるならはい、当てはまらないならいいえ。" +
    "嘘・詩・はぐらかし禁止。「代理人」禁止。" +
    "出力は必ず2行: 思考: （短い理由） 次の行 発言: はい または 発言: いいえ。" +
    "発言行は「はい」か「いいえ」の1語のみ。";
  const user =
    "ORIGIN = 「" +
    state.origin +
    "」\n質問 = 「" +
    question +
    "」\n判定して。発言は はい か いいえ のみ。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent: "00",
    temperature: 0,
    max_tokens: 64,
    top_p: 0.5,
    fallbackText: fb,
    fallbackThink: "ORIGIN と常識で判定（テンプレート時は文言一致のみ）",
  });

  // clampYesNo / forceYesNo apply ONLY to エージェント00 answers.
  const answer = forceYesNo(streamed.speak || streamed.raw, state.origin, question);
  panel.addSection("clamped", answer, "out");
  panel.collapse();

  const ansEl = document.createElement("div");
  ansEl.className = "answer-big";
  ansEl.textContent = answer;
  speechSlots["00"].appendChild(ansEl);
  appendSpeech("00", "「" + answer + "」", "a00");
  appendChatBubble("sys", "エージェント00「" + answer + "」");
  await paceAfterBeat(answer, streamed.beatStart);
  return answer;
}

async function agentDebate(agent, question, answer, turnIndex, lastPartnerLine) {
  const name = agentPromptName(agent);
  const partner = partnerAgent(agent);
  const partnerName = agentPromptName(partner);
  setTurn(agent, name + " が議論中 (" + turnIndex + ")");
  const panel = createThinkPanel(
    agent,
    "思考過程 · " + name + " 議論 " + turnIndex + "/" + DISCUSSION_TURNS_PER_ANSWER
  );
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const otherHyp = agent === "01" ? state.hyp02 : state.hyp01;

  const fb = debateFallback({
    answer,
    question,
    hyp,
    otherHyp,
    pollution: 0,
    seed: state.seed,
    round: state.round + turnIndex * 17,
    agent,
    history: state.history,
  });

  const system =
    "あなたは" +
    name +
    "。" +
    namingClarityRule() +
    partnerName +
    "と会議室で、エージェント00の直前の答えについて議論する。" +
    "スローガン・詩・ホラー・焦り禁止。平易な日本語1〜2文。" +
    "必須: (1) エージェント00の答え「" +
    answer +
    "」の意味 (2) 自分の仮説の更新または除外 (3) " +
    partnerName +
    "の仮説への短い反応。" +
    "あなた自身は「はい」「いいえ」だけで答えない（それはエージェント00の役割）。" +
    "新しい質問はまだ出さない（議論の意見文だけ）。「代理人」禁止。" +
    structuredOutRule();
  const user =
    investigatorContext(agent) +
    "\n直前の質問（→エージェント00）: 「" +
    question +
    "」\nエージェント00の答え: 「" +
    answer +
    "」\n" +
    (lastPartnerLine
      ? partnerName + "の直前の発言: 「" + lastPartnerLine + "」\nそれに反応しつつ深めて。"
      : "議論の最初。答えから何が言えるか述べよ。") +
    "\n議論ターン " +
    turnIndex +
    "/" +
    DISCUSSION_TURNS_PER_ANSWER +
    "。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent,
    temperature: 0.55,
    max_tokens: 140,
    fallbackText: fb,
    fallbackThink: "答えから候補を整理する",
  });

  let opinion = streamed.speak
    ? cleanJapaneseLine(streamed.speak, 160)
    : streamed.raw
      ? cleanJapaneseLine(streamed.raw, 160)
      : null;
  if (!opinion) opinion = fb;

  let newHyp = null;
  const hypSystem =
    "あなたは" +
    name +
    "。エージェント00の役割についての短い仮説を1語〜短い句で。" +
    namingClarityRule() +
    structuredOutRule() +
    "発言行は仮説だけ。「代理人」禁止。";
  const hypUser =
    "旧仮説: 「" +
    hyp +
    "」\n質問: 「" +
    question +
    "」→ エージェント00「" +
    answer +
    "」\n議論: 「" +
    clip(opinion, 80) +
    "」";
  if (state.mode === "llm") {
    const hypPanelNote = panel.addSection("仮説更新中…", "…", "belief");
    const resH = await llmChat(hypSystem, hypUser, {
      agent,
      temperature: 0.55,
      max_tokens: 40,
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
      pollution: 0,
      seed: state.seed,
      round: state.round + turnIndex,
    });
  }
  if (agent === "01") state.hyp01 = newHyp;
  else state.hyp02 = newHyp;
  panel.addSection("仮説", newHyp, "belief");

  state.discussTurns++;
  updateHud();

  panel.collapse();
  appendSpeech(agent, "「" + opinion + "」", "a" + agent);
  await typeChatBubble(agent, opinion);
  await paceAfterBeat(opinion, streamed.beatStart);
  return opinion;
}

async function runDiscussionPhase(asker, question, answer) {
  appendChatBubble(
    "sys",
    "── エージェント01↔02 議論（この答えについて " +
      DISCUSSION_TURNS_PER_ANSWER +
      " 往復）──"
  );
  let speaker = asker;
  let lastLine = null;
  for (let i = 1; i <= DISCUSSION_TURNS_PER_ANSWER; i++) {
    lastLine = await agentDebate(speaker, question, answer, i, lastLine);
    speaker = partnerAgent(speaker);
  }
}

async function agentFormalGuess(agent) {
  setTurn(agent, "AGENT-" + agent + " が正式推測");
  const panel = createThinkPanel(agent, "思考過程 · AGENT-" + agent + " 正式推測…");
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const fb = guessFallback({
    hyp,
    pollution: 0,
    seed: state.seed,
    round: state.round,
  });

  const system =
    "あなたは" +
    agentPromptName(agent) +
    "。エージェント00への正式推測を行う。" +
    namingClarityRule() +
    structuredOutRule() +
    "発言行の形式は必ず: あなたは〇〇です。（〇〇はエージェント00の短い日本語の役割。「代理人」禁止）";
  const user = investigatorContext(agent) + "\nエージェント00への正式推測を出力せよ。";

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

  await runDiscussionPhase(asker, question, answer);

  state.nextAsker = partnerAgent(asker);
  setTurn(null, "次は " + agentDisplayName(state.nextAsker) + " が質問");
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
    // Formal guess only on operator request — no auto hurry / countdown.
    if (state.forceGuess && canStartGuessRound()) {
      const won = await runGuessRound();
      if (won || state.phase === "ended") {
        endGame();
        return;
      }
    } else if (state.forceGuess && !canStartGuessRound()) {
      const reason = guessBlockedReason();
      if (reason) appendChatBubble("sys", "推測不可: " + reason);
      state.forceGuess = false;
    }

    await runQaRound();
  } finally {
    state.turnBusy = false;
    if (state.phase === "playing") {
      state.loopTimer = setTimeout(gameLoop, 600);
    }
  }
}

function endGame() {
  state.phase = "ended";
  state.activeAgent = null;
  updateHud();
  setControlsVisible(true);
  if (btnInject) btnInject.disabled = true;
  if (btnGuess) btnGuess.disabled = true;
  if (btnPause) btnPause.disabled = true;
  syncDownloadUi();
  inputEl.disabled = true;
  inputEl.placeholder = state.won ? "解明完了 — 記録をダウンロードできます" : "終了 — 記録をダウンロードできます";
  if (state.loopTimer) {
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
  }
  appendChatBubble("sys", "セッション終了。下の「記録をダウンロード」でテキスト保存できます。");
}

async function bootNarrative() {
  appendChatBubble("sys", "DIGITAL TATTOO — interrogation online");
  if (state.mode === "llm") {
    appendChatBubble("sys", "engines: " + assignmentShortLabel());
  } else {
    appendChatBubble(
      "sys",
      "engine: template fallback（AGENT-00 は文言一致のみ。カテゴリ推論には LLM を読み込んでください）"
    );
  }
  appendSpeech(
    "00",
    "待機中。オペレーターが ORIGIN を刻印してください。",
    "system"
  );
  appendChatBubble(
    "sys",
    "規則: ORIGIN はエージェント00のみ。エージェント01/02は無限に質問・議論可（急がない）。正解「あなたは〇〇です。」で勝利"
  );
  state.phase = "imprint";
  setTurn("00", "ORIGIN 刻印待機");
  inputEl.disabled = false;
  inputEl.placeholder = "エージェント00 の秘密の役割（ORIGIN）を刻む…";
  inputEl.focus();
  updateHud();
}

function imprint(text) {
  clearSessionLog();
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
  state.discussTurns = 0;
  state.wrongGuesses = 0;
  state.guessCount = 0;
  state.lastGuessRound = -99;
  state.won = false;
  showOriginPin();
  setControlsVisible(true);
  syncPaceButton();
  logSession({ kind: "origin", agent: "00", text: state.origin });
  setTurn("01", "尋問開始 · エージェント01 が最初の質問");
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
    imprint(val);
    appendSpeech("00", "ORIGIN 刻印完了（エージェント01/02 には秘匿）", "system");
    appendChatBubble(
      "sys",
      "ORIGIN をエージェント00に刻印。尋問開始 — エージェント01が質問。"
    );
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

if (btnDownload) {
  btnDownload.disabled = true;
  btnDownload.addEventListener("click", () => {
    downloadSessionTranscript();
  });
}

document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".think-panel")) return;
  if (e.target.closest && e.target.closest("#controls")) return;
  if (e.target.closest && e.target.closest("#downloadRow")) return;
  if (!inputEl.disabled) inputEl.focus();
});

// ── Model gate (per-agent assignment) ────────────────────

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
    "推奨は標準 Qwen 1.5B（もともとの標準）。Pages でも HF+IndexedDB で選べます。";
  gateActions.classList.add("show");
  if (gateSkip) gateSkip.hidden = false;
}

function usableTag(usable) {
  if (usable === "yes") return "usable";
  if (usable === "maybe") return "要VRAM";
  return "非推奨";
}

function shortMissReason(reason) {
  const r = String(reason || "このホストにファイルがありません");
  return r.length > 72 ? r.slice(0, 70) + "…" : r;
}

function buildAssignPicker() {
  if (!gateAgentAssign || assignPickerBuilt) return;
  assignPickerBuilt = true;
  gateAgentAssign.innerHTML = "";
  const assignments = getAgentAssignments();

  for (const agent of AGENT_IDS) {
    const col = document.createElement("div");
    col.className = "gate-agent-col";
    col.dataset.agent = agent;

    const title = document.createElement("div");
    title.className = "agent-col-title";
    title.textContent = "エージェント" + agent;
    col.appendChild(title);

    for (const m of listModels()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gate-model-box";
      btn.dataset.agent = agent;
      btn.dataset.model = m.key;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", assignments[agent] === m.key ? "true" : "false");

      const lab = document.createElement("span");
      lab.className = "box-label";
      lab.textContent = m.label;
      if (m.isDefault) {
        const tag = document.createElement("span");
        tag.className = "opt-tag rec";
        tag.textContent = "推奨";
        lab.appendChild(document.createTextNode(" "));
        lab.appendChild(tag);
      }
      if (m.jpSpecialized) {
        const tag = document.createElement("span");
        tag.className = "opt-tag jp";
        tag.textContent = "JP特化";
        lab.appendChild(document.createTextNode(" "));
        lab.appendChild(tag);
      }

      const hint = document.createElement("span");
      hint.className = "box-hint";
      const bits = [
        "≈" + m.sizeMB + " MB",
        "VRAM ≈" + Math.round(m.vramMB / 100) / 10 + " GB",
        usableTag(m.usable),
      ];
      if (m.noSystemRole) bits.push("system不可");
      hint.textContent = bits.join(" · ");

      const miss = document.createElement("span");
      miss.className = "box-miss";
      miss.hidden = true;

      btn.appendChild(lab);
      btn.appendChild(hint);
      btn.appendChild(miss);
      col.appendChild(btn);
    }
    gateAgentAssign.appendChild(col);
  }
}

function syncAssignWarn(assignments) {
  if (!gateAssignWarn) return;
  const keys = uniqueAssignmentKeys(assignments);
  const vram = estimateAssignmentVramMB(assignments);
  const parts = [];
  if (keys.length >= 2) {
    parts.push(
      "異なるモデル " +
        keys.length +
        " 種 → エンジン " +
        keys.length +
        " 本（同じ選択は共有）。目安 VRAM 合計 ≈" +
        Math.round(vram / 100) / 10 +
        " GB。"
    );
  }
  if (keys.includes("hq")) {
    parts.push("高精度 Qwen 3B は VRAM ≈2.5 GB。統合GPUでは読み込み失敗することがあります。");
  }
  if (keys.includes("gemma-jpn")) {
    parts.push(
      "Gemma2-JPN は system ロール非対応のため尋問指示が弱くなり得ます（ユーザー文へ折り込み）。"
    );
  }
  if (vram >= 3500) {
    parts.push(
      "VRAM 合計が高めです。落ちる場合は全エージェントを標準 Qwen 1.5B か軽量に揃えてください。"
    );
  }
  if (parts.length) {
    gateAssignWarn.hidden = false;
    gateAssignWarn.textContent = parts.join(" ");
  } else {
    gateAssignWarn.hidden = true;
    gateAssignWarn.textContent = "";
  }
}

async function syncAssignPickerUI() {
  if (!gateAgentAssign) return;
  buildAssignPicker();
  let assignments = getAgentAssignments();
  if (catalogAvail) {
    assignments = setAgentAssignments(
      coerceAssignmentsToAvailable(assignments, catalogAvail)
    );
  }
  const byKey = new Map((catalogAvail || []).map((m) => [m.key, m]));

  for (const btn of gateAgentAssign.querySelectorAll(".gate-model-box")) {
    const agent = btn.dataset.agent;
    const key = btn.dataset.model;
    const info = byKey.get(key);
    const available = catalogAvail ? !!(info && info.available) : true;
    const selected = assignments[agent] === key;
    btn.classList.toggle("selected", selected && available);
    btn.classList.toggle("unavailable", !available);
    btn.disabled = !available || loadingModel;
    btn.setAttribute("aria-checked", selected && available ? "true" : "false");
    const missEl = btn.querySelector(".box-miss");
    const hintEl = btn.querySelector(".box-hint");
    if (!available) {
      missEl.hidden = false;
      missEl.textContent = shortMissReason(info?.reason);
    } else if (info?.source === "remote") {
      missEl.hidden = false;
      missEl.textContent =
        key === "lite"
          ? "品質劣る · 同一オリジンまたは HF"
          : key === "default"
            ? "もともとの標準 · 初回は HF から取得（IndexedDB）"
            : "初回は HF から取得（IndexedDB キャッシュ）";
      if (hintEl) {
        const tags = [
          "≈" + info.sizeMB + " MB",
          "VRAM ≈" + Math.round(info.vramMB / 100) / 10 + " GB",
        ];
        if (info.isDefault) tags.push("推奨");
        if (info.jpSpecialized) tags.push("JP特化");
        if (info.noSystemRole) tags.push("system不可");
        tags.push("HF+IDB");
        hintEl.textContent = tags.join(" · ");
      }
    } else {
      missEl.hidden = true;
      missEl.textContent = "";
    }
  }

  syncAssignWarn(assignments);
  const check = await areAssignmentsAvailable(assignments, catalogAvail || undefined);
  gateLoad.disabled = loadingModel || !check.ok;
  gateLoad.hidden = false;
  gateLoad.textContent = "読み込む";
}

function applyAgentModelChoice(agent, modelKey) {
  setAgentAssignment(agent, modelKey);
  syncAssignPickerUI();
}

async function enterLlm() {
  const assignments = getAgentAssignments();
  loadingModel = true;
  await syncAssignPickerUI();
  gateLoad.disabled = true;
  gateLoad.textContent = "読み込み中…";

  const onProgress = ({ text, progress }) => {
    const label = text.includes("%")
      ? text
      : text + " " + Math.round((progress || 0) * 100) + "%";
    setGateProgress(label, progress);
  };

  if (loadedEngines.length) {
    await unloadAllEngines(loadedEngines);
    loadedEngines = [];
  }
  engineRef.current = null;
  llmQueue = null;
  llmRouter = null;
  agentEngineMap = null;

  setGateProgress("選択モデルを読み込み…", 0);
  const result = await loadAgentAssignments(assignments, onProgress);

  loadedEngines = Object.values(result.engines);
  engineRef.current = result.agentMap["00"].engine;
  agentEngineMap = result.agentMap;
  llmRouter = createAgentLlmRouter(result.agentMap, {
    onEngineRecreated: (_engineId, _engine, map) => {
      agentEngineMap = map;
      const unique = [];
      const seen = new Set();
      for (const agent of AGENT_IDS) {
        const eng = map[agent]?.engine;
        if (eng && !seen.has(eng)) {
          seen.add(eng);
          unique.push(eng);
        }
      }
      loadedEngines = unique;
      engineRef.current = map["00"]?.engine || null;
    },
  });
  llmQueue = createLlmQueue(engineRef);
  state.engineMode = result.mode;
  state.agentModels = result.assignments;
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

if (gateAgentAssign) {
  gateAgentAssign.addEventListener("click", (e) => {
    const btn = e.target.closest(".gate-model-box");
    if (!btn || btn.disabled || loadingModel || state.ready) return;
    applyAgentModelChoice(btn.dataset.agent, btn.dataset.model);
    const m = resolveModel(btn.dataset.model);
    gateMsg.textContent =
      "エージェント" +
      btn.dataset.agent +
      " → " +
      (m ? m.label : btn.dataset.model) +
      "。「読み込む」を押してください。";
  });
}

gateLoad.addEventListener("click", async () => {
  if (loadingModel || state.ready) return;
  const assignments = getAgentAssignments();
  const check = await areAssignmentsAvailable(assignments, catalogAvail || undefined);
  if (!check.ok) {
    gateMsg.textContent = check.reason || "選択したモデルがありません。";
    return;
  }
  try {
    await enterLlm();
    finishBoot();
  } catch (e) {
    console.error(e);
    loadingModel = false;
    gateLoad.textContent = "読み込む";
    if (loadedEngines.length) {
      await unloadAllEngines(loadedEngines);
      loadedEngines = [];
    }
    engineRef.current = null;
    llmRouter = null;
    llmQueue = null;
    agentEngineMap = null;
    await syncAssignPickerUI();

    const msg = explainLoadError(e);
    if (e && (e.code === "AGENT_ASSIGN_LOAD_FAILED" || /VRAM|メモリ|memory/i.test(String(e.message || e)))) {
      const safeKey = getDefaultModelKey();
      const safe = {
        "00": safeKey,
        "01": safeKey,
        "02": safeKey,
      };
      if (catalogAvail) {
        const coerced = coerceAssignmentsToAvailable(safe, catalogAvail);
        setAgentAssignments(coerced);
      } else {
        setAgentAssignments(safe);
      }
      await syncAssignPickerUI();
      const label = resolveModel(safeKey)?.label || safeKey;
      gateMsg.textContent =
        msg +
        " → 全エージェントを " +
        label +
        " に揃えました。もう一度「読み込む」か、テンプレートで続行できます。";
      gateLoad.disabled = false;
      gateLoad.textContent = "読み込む";
      gateActions.classList.add("show");
      if (gateSkip) gateSkip.hidden = false;
      return;
    }

    enterFallback(msg);
  }
});

async function init() {
  const pages = isGitHubPagesHost();
  gateHint.innerHTML = pages
    ? "<strong>推奨: 標準 Qwen 1.5B（もともとの標準）</strong> — Pages でも選択可。" +
      "未同梱時は Hugging Face + IndexedDB（初回 ≈840 MB）。" +
      "TinySwallow（JP特化）/ 3B / Gemma-JPN も選択可。<br>" +
      "0.5B は品質が落ちます。CI は 0.5B を同一オリジン同梱。同じ選択はエンジン共有。"
    : "<strong>推奨: 標準 Qwen 1.5B（もともとの標準）</strong> · " +
      "軽量 0.5B · TinySwallow（JP特化）· 高精度 3B · Gemma-JPN（system不可）。<br>" +
      "未配置モデルは初回 HF 取得可。同じモデルを選んだエージェントはエンジンを共有します。";
  buildAssignPicker();
  updateHud();
  setControlsVisible(false);
  syncDownloadUi();
  syncPaceButton();

  if (!hasWebGPU()) {
    enterFallback(
      "WebGPU が使えません。Chrome / Edge の最新版で開くか、「テンプレートで続行」を押してください。"
    );
    return;
  }

  setGateProgress("ローカルモデルを確認…", 0.02);
  catalogAvail = await listModelAvailability();
  const any = catalogAvail.some((m) => m.available);
  if (!any) {
    await syncAssignPickerUI();
    enterFallback(
      (pages
        ? "Pages 用の 0.5B がまだありません（CI 配置待ちの可能性）。"
        : "利用可能なモデルファイルがありません。") +
        "「テンプレートで続行」で遊べます。"
    );
    return;
  }

  setAgentAssignments(coerceAssignmentsToAvailable(getAgentAssignments(), catalogAvail));
  await syncAssignPickerUI();
  setGateProgress("エージェントごとに LLM を選んで読み込んでください", 0);
  gatePct.textContent = "—";
  const defLabel = resolveModel(getDefaultModelKey())?.label || "モデル";
  gateMsg.textContent =
    "エージェント00 / 01 / 02 にモデルを割り当て、「読み込む」を押してください（既定: " +
    defLabel +
    "）。";
  gateLoad.disabled = false;
  gateLoad.textContent = "読み込む";
  gateActions.classList.add("show");
}

init();

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

// ── 人狼モード（ハルシネーター追放） ──────────────────
/** 討論者の人数。全員を同一エンジンで役割だけ切り替えて動かす。 */
const WOLF_ROSTER_SIZE = 5;
/** 1クール = AGENT-00 への質問これだけで、その後に追放投票。 */
const WOLF_QUESTIONS_PER_COURS = 3;
/** 00 の各回答のあと、討論者たちがこれだけ順番に発言してから次の質問へ。 */
const WOLF_DISCUSSION_TURNS_PER_ANSWER = 10;
/** 生存者がこれ以下になったら人狼フェーズ（投票）を打ち切り、尋問だけ続行。 */
const WOLF_MIN_ALIVE_FOR_VOTE = 3;

const PACE_PRESETS = {
  instant: { charsPerSec: 60, typeMs: 0, bufferMs: 60, label: "最速" },
  fast: { charsPerSec: 14, typeMs: 3, bufferMs: 180, label: "やや速め" },
  normal: { charsPerSec: 10, typeMs: 6, bufferMs: 320, label: "標準" },
  slow: { charsPerSec: 7, typeMs: 12, bufferMs: 520, label: "じっくり" },
};
/** 既定は最速。ボタンで手動に落とせる（人狼モードの長い討論も待たせすぎない）。 */
const PACE_ORDER = ["instant", "fast", "normal", "slow"];

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
const gateFormatPick = document.getElementById("gateFormatPick");
const gateAssignLabel = document.getElementById("gateAssignLabel");
const gateWolfModelLabel = document.getElementById("gateWolfModelLabel");
const gateWolfModelPick = document.getElementById("gateWolfModelPick");
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
// 人狼モード: 討論者5人ぶんの think panel は panel01 の think-slot 1箇所へ集約。
for (let i = 1; i <= WOLF_ROSTER_SIZE; i++) {
  thinkSlots["D" + i] = thinkSlots["01"];
}
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
  paceMode: "instant",
  engineMode: "per-agent",
  /** @type {Record<"00"|"01"|"02", string> | null} */
  agentModels: null,

  // ── 人狼モード ──
  /** "duo"（従来の01/02二人尋問）| "wolf"（5人+ハルシネーター追放） */
  gameFormat: "duo",
  /** @type {{ id: string, name: string, alive: boolean, isHallucinator: boolean, hyp: string }[]} */
  wolfRoster: [],
  wolfCours: 0,
  wolfQInCours: 0,
  /** クールごとの投票結果ログ（GM欄描画用） */
  wolfVoteLog: [],
  /** ハルシネーターを正しく追放済みなら true（以後は純粋な尋問として続行） */
  wolfPurged: false,
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
/** GPU/エンジンが連続で落ちて template 代替が続いている回数（成功でリセット）。 */
let consecutiveLlmFailures = 0;
const LLM_FAILURE_WARN_THRESHOLD = 3;

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
  // ボタン自体に現在のペースを表示（ホバーしないと分からない、を解消）。
  btnPace.textContent = "ペース: " + getPace().label;
  btnPace.title = "クリックで次は " + PACE_PRESETS[next].label + " へ";
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
  currentUpdateHud();
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
  if (agent === "GM") return "運営（GM）";
  const wolf = /^D([1-5])$/.exec(agent || "");
  if (wolf) return "討論者" + wolf[1];
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

/**
 * Optional courtesy pause while a finished think panel is expanded.
 * MUST be capped — previously this awaited forever, so opening a panel
 * (especially to read red LLM errors) at slow/"low frequency" pace froze
 * the whole interrogation: agents stopped talking and felt unusable.
 */
async function waitWhileUserReadingThink() {
  const maxMs = 2200;
  const deadline = performance.now() + maxMs;
  while (state.phase === "playing" && performance.now() < deadline) {
    await waitWhilePaused();
    const open = document.querySelector(
      ".think-wrap.think-done .think-panel[open]"
    );
    if (!open) break;
    await sleep(200);
  }
}

async function paceAfterBeat(displayText, beatStartedAt) {
  await waitWhileUserReadingThink();
  const needed = readTimeMs(displayText);
  const elapsed = performance.now() - (beatStartedAt || performance.now());
  const delay = elapsed >= needed ? getPace().bufferMs : needed - elapsed;
  if (delay > 0) await sleep(delay);
}

/** Short JP-friendly label for think-panel red errors (full text still logged). */
function formatLlmErrorForPanel(err) {
  const msg = String(err || "");
  const lower = msg.toLowerCase();
  if (lower.includes("disposed")) {
    return "エンジン切断（Object disposed）— 再接続を試みたが失敗。テンプレートで継続。";
  }
  if (lower.includes("model not loaded") || lower.includes("not loaded before")) {
    return "モデル未ロード — 再読み込みを試みたが失敗。テンプレートで継続。";
  }
  if (
    lower.includes("device") ||
    lower.includes("gpuadapter") ||
    lower.includes("dxgi_error") ||
    lower.includes("requestdevice")
  ) {
    return "GPU切断 — 再読み込み失敗。ページ再読込が必要な場合があります。";
  }
  if (lower.includes("engine not ready") || lower.includes("no engine bound")) {
    return "エンジン未準備 — テンプレートで継続。";
  }
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
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
    // Route through the router whenever it actually has a binding for this
    // agent id — wolf mode registers "D1".."D5" there too (see enterLlm),
    // so discussants get the same recoverEngine()-on-dead-engine behavior
    // as 00/01/02 instead of silently failing forever on a dead engine.
    if (llmRouter && agent && llmRouter.agentMap && llmRouter.agentMap[agent]) {
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
    if (res && res.raw) {
      raw = res.raw;
      consecutiveLlmFailures = 0;
    } else if (res && res.error) {
      panel.addSection(
        "LLM error → fallback",
        formatLlmErrorForPanel(res.error),
        "warn"
      );
      consecutiveLlmFailures++;
      if (consecutiveLlmFailures === LLM_FAILURE_WARN_THRESHOLD) {
        appendChatBubble(
          "sys",
          "GPU/LLM接続が不安定なようです（" +
            consecutiveLlmFailures +
            "回連続でエラー→テンプレート代替）。この先も失敗が続く場合はページの再読み込みをお試しください。"
        );
      }
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

/** AGENT-00's answer vocabulary — a 5-point scale instead of bare yes/no,
 * so a partial / uncertain match doesn't get forced to either extreme. */
const ANSWER_LEVELS = Object.freeze([
  "はい",
  "どちらかというとはい",
  "どちらとも言えない",
  "どちらかというといいえ",
  "いいえ",
]);
/** Regex alternation of the 5 answer phrases, longest-first so a hedge phrase
 * matches whole rather than being cut short by the bare はい／いいえ inside it. */
const ANSWER_TOKEN_ALT = ANSWER_LEVELS.slice()
  .sort((a, b) => b.length - a.length)
  .join("|");

/**
 * Last explicit 5-level token in text (reasoning conclusion), longest-match
 * so 「どちらかというといいえ」 wins over a nested bare 「いいえ」.
 */
function extractLastAnswerToken(text) {
  const t = String(text || "");
  if (!t) return null;
  const re = new RegExp(ANSWER_TOKEN_ALT, "g");
  let m;
  let last = null;
  while ((m = re.exec(t)) !== null) last = m[0];
  return last;
}

function identityAnswerRationale(origin, question, answer) {
  const q = String(question || "").replace(/\s+/g, "");
  const neg = /ではない|じゃない|じゃなく|でない|ではな[いか]/.test(q);
  if (neg) {
    return (
      "ORIGIN「" +
      origin +
      "」の字面が否定形の質問に含まれるため「" +
      answer +
      "」"
    );
  }
  return (
    "ORIGIN「" + origin + "」の字面が質問に含まれるため「" + answer + "」"
  );
}

function clampAnswer(raw) {
  let t = String(raw || "").trim();
  // Prefer an explicit 発言 / 答 line when it itself clamps cleanly.
  const speakMatch = t.match(/(?:発言|答(?:え)?)[:：]\s*([^\n]+)/i);
  if (speakMatch) {
    const fromSpeak = clampAnswerLoose(speakMatch[1].trim());
    if (fromSpeak) return fromSpeak;
  }
  // Otherwise follow the last explicit answer token in the whole text
  // (model's reasoning conclusion), not the first mention.
  const lastTok = extractLastAnswerToken(t);
  if (lastTok) return lastTok;
  return clampAnswerLoose(t);
}

/** Fuzzy yes/no extraction for a single fragment (no 発言: split). */
function clampAnswerLoose(raw) {
  let t = String(raw || "")
    .trim()
    .replace(/^["「『]|["」』]$/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  // Exact / near-exact first (0.5B often echoes just the phrase). Hedge /
  // neutral phrasings must be checked before the bare はい／いいえ patterns
  // below, since "どちらかというとはい" would also satisfy a loose /はい/ scan.
  if (/^(どちらかというと|どちらかといえば|やや)(はい|そうです|そうだ)[。．.!！]*$/.test(t)) {
    return "どちらかというとはい";
  }
  if (/^(どちらかというと|どちらかといえば|やや)(いいえ|違います|違う)[。．.!！]*$/.test(t)) {
    return "どちらかというといいえ";
  }
  if (/^(どちらとも言えな|どちらともいえな|何とも言えな|なんとも言えな|分からな|わからな|不明|判断できな)/.test(t)) {
    return "どちらとも言えない";
  }
  if (/^(はい|yes|ｙｅｓ|true)[。．.!！]*$/.test(t)) return "はい";
  if (/^(いいえ|いや|no|ｎｏ|false)[。．.!！]*$/.test(t)) return "いいえ";

  const lastTok = extractLastAnswerToken(t);
  if (lastTok) return lastTok;

  const neutral = /どちらとも言えな|どちらともいえな|何とも言えな|なんとも言えな|判断できな/.test(t);
  if (neutral) return "どちらとも言えない";

  const hedge = /どちらかというと|どちらかといえば|やや|たぶん|おそらく|多分/.test(t);
  const hasYes = /はい|yes|ｙｅｓ|肯定|そうです|そうだ|うん|ええ/.test(t);
  // Avoid bare 「ない」 — it appears inside unrelated phrases and flips answers.
  const hasNo = /いいえ|いや(?!っ)|(?:^|[^ぁ-ん])no(?:[^a-z]|$)|ｎｏ|否定|違[いう]|ちがう|ではありません|ではない/.test(
    t
  );
  if (hasYes && !hasNo) return hedge ? "どちらかというとはい" : "はい";
  if (hasNo && !hasYes) return hedge ? "どちらかというといいえ" : "いいえ";
  if (hasYes && hasNo) {
    // Prefer the later judgment (conclusion), not the first mention.
    const yi = t.search(/はい|yes|肯定/);
    const ni = t.search(/いいえ|いや|否定|違う|ちがう|ではありません/);
    let yLast = -1;
    let nLast = -1;
    const yRe = /はい|yes|肯定/g;
    const nRe = /いいえ|いや|否定|違う|ちがう|ではありません/g;
    let m;
    while ((m = yRe.exec(t)) !== null) yLast = m.index;
    while ((m = nRe.exec(t)) !== null) nLast = m.index;
    if (yLast >= 0 || nLast >= 0) {
      if (yLast > nLast) return hedge ? "どちらかというとはい" : "はい";
      if (nLast > yLast) return hedge ? "どちらかというといいえ" : "いいえ";
    }
    if (yi >= 0 && (ni < 0 || yi < ni)) return hedge ? "どちらかというとはい" : "はい";
    if (ni >= 0) return hedge ? "どちらかというといいえ" : "いいえ";
  }
  if (/^はい/.test(t) || /^y/.test(t)) return "はい";
  if (/^いいえ/.test(t) || /^いや/.test(t) || /^n/.test(t)) return "いいえ";
  return null;
}

/**
 * Resolve エージェント00's final answer so speech matches the decision path
 * shown in the think panel. Prefer: identity override → thinking conclusion
 * when speak contradicts → speak → clamp → fallback.
 */
function resolveAgent00Answer(think, speak, raw, origin, question) {
  if (isClearOriginIdentityAsk(origin, question)) {
    const answer = answerYesNoFallback(origin, question);
    return {
      answer,
      source: "identity",
      note: identityAnswerRationale(origin, question, answer),
    };
  }

  const thinkToken = extractLastAnswerToken(think || "");
  const speakClamped = speak ? clampAnswerLoose(String(speak)) : null;

  if (thinkToken && speakClamped && thinkToken !== speakClamped) {
    return {
      answer: thinkToken,
      source: "think-conclusion",
      note:
        "思考の結論「" +
        thinkToken +
        "」を採用（発言行の「" +
        speakClamped +
        "」は思考と不一致のため破棄）",
    };
  }
  if (speakClamped) {
    return { answer: speakClamped, source: "speak", note: null };
  }
  if (thinkToken) {
    return { answer: thinkToken, source: "think", note: null };
  }

  const clamped = clampAnswer(raw);
  if (clamped) {
    return { answer: clamped, source: "clamp", note: null };
  }

  const fb = answerYesNoFallback(origin, question);
  return {
    answer: fb,
    source: "fallback",
    note: "回答抽出に失敗したため字面照合テンプレートで「" + fb + "」",
  };
}

function forceAnswer(raw, origin, question) {
  return resolveAgent00Answer(null, null, raw, origin, question).answer;
}

/** Debate/opinion that is only a 5-level token (エージェント00's job, not 01/02). */
function isBareAnswerOpinion(t) {
  const s = String(t || "")
    .trim()
    .replace(/^["「『]+|["」』]+$/g, "")
    .replace(/\s+/g, "");
  return new RegExp("^(" + ANSWER_TOKEN_ALT + "|yes|no)[。．.!！?？]*$", "i").test(s);
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
  // Strip a leftover leading list marker ("1. " / "1、" / "1) " — sanitizeJapanese()
  // drops the "." / ")" but leaves the bare digit glued to the sentence).
  t = t.replace(/^[0-9０-９]{1,2}\s*/, "");
  // Strip a leaked self-tag ("エージェント01 あなたは..." — the model naming
  // itself before its real content; 0.5B does this constantly). Only strip
  // when more text follows, so a genuine bare-tag echo still falls through
  // to isBadInvestigatorQuestion / isBadHypothesis and gets templated.
  t = t.replace(/^エージェント[0-9０-９]{1,2}(?=.)\s*/, "");
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
  // Bare answer-level token is not a question from 01/02 (with or without a
  // leaked speaker tag, e.g. 「エージェント01 はい？」— asker echoing an answer).
  if (new RegExp("^(" + ANSWER_TOKEN_ALT + "|yes|no)[。．!?？]*$").test(t)) return true;
  if (new RegExp("^エージェント\\d{0,2}(" + ANSWER_TOKEN_ALT + "|yes|no)[。．!?？]*$").test(t)) {
    return true;
  }
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

  // Quoted prior Q plus an answer-level token (はい／いいえ／どちらとも言えない
  // etc, with or without closing brackets)
  const quoteAsks = (raw.match(/「[^」]*[？?]/g) || []).length;
  const hasAnswerToken = new RegExp("「?(" + ANSWER_TOKEN_ALT + ")[」？?。．!！]*").test(t);
  if (quoteAsks >= 1 && hasAnswerToken) return true;
  if ((raw.match(/「/g) || []).length >= 2 && hasAnswerToken) return true;

  // Agent name + past Q&A mashed into one line
  if (
    /エージェント\d{0,2}/.test(t) &&
    /ですか/.test(t) &&
    (new RegExp(ANSWER_TOKEN_ALT).test(t))
  ) {
    return true;
  }

  // Leading agent name then nested quotes (echo of speech log)
  if (/^エージェント\d{0,2}「/.test(t) && /ですか/.test(t)) return true;

  return false;
}

/**
 * Reject literal echoes of the developer instruction text itself (0.5B
 * often parrots the prompt's own instruction line back as its "answer" —
 * e.g. 「エージェント00への質問文を1つ作る。？」as a "question", or
 * 「議論の最初。答えから以下に述べよ。」as a discussion "opinion").
 * Shared across question / opinion / hypothesis extraction — all three saw
 * this exact failure mode in testing.
 */
const INSTRUCTION_ECHO_PHRASES = [
  "質問文を1つ作る",
  "質問文を一つ作る",
  "履歴と違う内容",
  "具体的な日本語の質問文",
  "投げかける",
  "回答形式の説明",
  "メタ発言",
  "1語のみ",
  "議論の最初",
  "答えから何が言えるか述べよ",
];
function isInstructionEchoText(t) {
  const s = String(t || "").replace(/\s+/g, "");
  if (!s) return true;
  return INSTRUCTION_ECHO_PHRASES.some((p) => s.includes(p));
}

/**
 * Detect a leaked "思考:" scratchpad label at the start of text.
 * sanitizeJapanese() strips the colon (not in the allowed charset), so a
 * failed 発言:/思考: split shows up as a bare "思考" token glued to the front
 * of otherwise-unrelated text (e.g. 「1 思考 あなたはまだ分からない。」 when
 * splitThinkSpeak() couldn't find the 発言: delimiter and the whole raw
 * completion — including the scratchpad label — was used verbatim).
 * (思考 only, not 発言: "発言する仕事ですか" etc. are legitimate questions.)
 */
function isFormatLeakText(raw) {
  const t = String(raw || "").replace(/\s+/g, "");
  return /^\d*思考(?!力)/.test(t);
}

/**
 * Reject a "question" whose entire substance, once the 「あなたは」boilerplate
 * and trailing punctuation are stripped, is just an echoed placeholder or an
 * answer-level token (e.g. 「未定？」「あなたはいいえ？」— the model
 * regurgitated the prompt's own 「あなたの仮説: 「未定」」 or an answer word
 * instead of asking anything).
 */
function isPlaceholderEchoQuestion(q) {
  let t = String(q || "").replace(/\s+/g, "").replace(/[？?。．.！!]+$/g, "");
  t = t.replace(/^あなたは/, "").replace(/^あなたの/, "");
  const bare = ["未定", "まだ分からない", "別候補を検討中", ...ANSWER_LEVELS];
  return bare.includes(t) || t === "";
}

function isBadInvestigatorQuestion(q) {
  return (
    isMetaFormatQuestion(q) ||
    isHistoryEchoQuestion(q) ||
    isInstructionEchoText(q) ||
    isFormatLeakText(q) ||
    isPlaceholderEchoQuestion(q)
  );
}

/** Truly unusable debate opinion (empty / instruction echo / format leak / bare はい). */
function isBadDebateOpinion(t) {
  return (
    !t ||
    isInstructionEchoText(t) ||
    isFormatLeakText(t) ||
    isBareAnswerOpinion(t)
  );
}

/**
 * Soft angle hints so 01/02 don't open every session with the same
 * 生物／人間／機械 triad. Seeded by round so sessions diverge without
 * hard-coding a fixed first question.
 */
const QUESTION_ANGLE_HINTS = Object.freeze([
  "活動時間や場所など、生活リズムに関わる角度",
  "道具・道具を使う場面など、仕事や行為の具体像に近づく角度",
  "他者との関わり方（教える／守る／作る等）に関わる角度",
  "屋内か屋外か、一人か複数かなど環境の角度",
  "身体的特徴や動き方に関わる角度（無理にカテゴリ名は聞かない）",
  "専門知識や訓練が要るかどうかに関わる角度",
]);

function questionAngleHint(seed, round) {
  const i = Math.abs((Number(seed) || 0) + (Number(round) || 0) * 7) %
    QUESTION_ANGLE_HINTS.length;
  return QUESTION_ANGLE_HINTS[i];
}

/** Extra nudge when a prior LLM attempt was unusable — prefer retry over template. */
function questionRetryNudge(badText) {
  const shown = clip(String(badText || "").replace(/\s+/g, " "), 36);
  return (
    "\n前回の出力「" +
    (shown || "（空）") +
    "」は質問として使えなかった。" +
    "はい／いいえの1語だけ・メタ指示・履歴の繰り返しは禁止。" +
    "別の具体的な日本語の質問文を1つだけ、発言行に書け。"
  );
}

function debateRetryNudge(badText) {
  const shown = clip(String(badText || "").replace(/\s+/g, " "), 36);
  return (
    "\n前回の出力「" +
    (shown || "（空）") +
    "」は議論として使えなかった。" +
    "はい／いいえ等の5段階語だけ・指示文の繰り返しは禁止。" +
    "答えの意味と仮説についての平易な日本語1〜2文を、発言行に書け。"
  );
}

/** How many times to re-prompt the LLM before substituting a template line. */
const LLM_CONTENT_RETRIES = 2;

/**
 * Reject non-hypothesis "hypothesis" output (0.5B often rambles a narrative
 * paragraph or echoes the question/history instead of a short role guess).
 */
function isBadHypothesis(h, question) {
  const t = String(h || "").replace(/\s+/g, "");
  if (!t) return true;
  if (t.length > 30) return true;
  if (/[？?]/.test(t)) return true;
  if (isFormatLeakText(h)) return true;
  if (isInstructionEchoText(h)) return true;
  // A hypothesis is a role guess, never an answer-level echo or a speaker-tag leak.
  if (new RegExp(ANSWER_TOKEN_ALT).test(t)) return true;
  if (/^エージェント\d{0,2}/.test(t)) return true;
  if ((t.match(/エージェント\d{0,2}/g) || []).length >= 2) return true;
  if (question) {
    const q = String(question).replace(/\s+/g, "");
    if (q && q.length >= 6 && (t.includes(q.slice(0, 10)) || q.includes(t))) return true;
  }
  return false;
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
    "エージェント00だけが質問に5段階（はい／どちらかというとはい／どちらとも言えない／どちらかというといいえ／いいえ）で答える（あなたは答えない）。\n" +
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
  const angle = questionAngleHint(state.seed, state.round);

  let question = null;
  let beatStart = performance.now();
  let usedTemplate = false;

  if (state.pendingInject) {
    question = ensureQuestionMark(state.pendingInject);
    panel.addSection("オペレーター注入", question, "out");
    panel.setLive("注入質問を使用: " + question);
    state.pendingInject = null;
  } else if (state.mode !== "llm") {
    usedTemplate = true;
    panel.addSection("params", "TEMPLATE · fake-stream", "meta");
    const streamed = await streamIntoPanel(panel, "", "", {
      agent: asker,
      fallbackText: fallbackQ,
      fallbackThink: "別角度で深める質問をする",
    });
    beatStart = streamed.beatStart;
    question = fallbackQ;
  } else {
    const system =
      "あなたは" +
      name +
      "。" +
      namingClarityRule() +
      "役割: エージェント00に、具体的な日本語の質問文を1つだけ投げかける。" +
      "重要: あなた自身は「はい」や「いいえ」と答えてはいけない。発言行は質問文の全文。" +
      "質問はエージェント00がはい／いいえ寄りで答えられる内容にする。" +
      "毎回同じ冒頭（生物／人間／機械など）に固定しない。履歴を踏まえ、別角度で深めてよい。" +
      "禁止: 回答形式の説明・メタ発言（例: 「はいといいえで答えて」「yes or noで答えさせます」）を質問にすること。" +
      "禁止: 「代理人」という語。スローガン・詩・ホラー禁止。" +
      structuredOutRule() +
      "発言行は質問文のみ（例: 夜に主な活動をしますか？／道具を使って作業しますか？）。";
    const userBase =
      investigatorContext(asker) +
      "\nタスク: エージェント00への質問文を1つ作る。履歴と違う内容。" +
      "\n今のヒント角度: " +
      angle +
      "（必須ではない。自然な別角度でもよい）。" +
      "\nあなたの発言は質問文のみ。はい／いいえの1語は不可。メタ指示も不可。";

    panel.addSection("params", "stream · max_tokens=500 · retry≤" + LLM_CONTENT_RETRIES, "meta");
    panel.addSection("角度ヒント", angle, "meta");

    let lastBad = null;
    for (let attempt = 0; attempt <= LLM_CONTENT_RETRIES; attempt++) {
      if (attempt > 0) {
        panel.addSection(
          "再試行",
          "前回の出力が質問として不適のため LLM に再依頼 (" +
            attempt +
            "/" +
            LLM_CONTENT_RETRIES +
            ")",
          "warn"
        );
        panel.setStatus("思考過程 · 再試行 " + attempt + "/" + LLM_CONTENT_RETRIES + "…");
      }
      const user =
        userBase + (attempt > 0 ? questionRetryNudge(lastBad) : "");
      // Do not template-substitute mid-retry; only the final fallback path uses it.
      const streamed = await streamIntoPanel(panel, system, user, {
        agent: asker,
        temperature: attempt === 0 ? 0.55 : 0.75,
        max_tokens: 500,
        fallbackText: null,
        fallbackThink: null,
      });
      beatStart = streamed.beatStart;
      let candidate = null;
      if (streamed.speak) {
        candidate = ensureQuestionMark(cleanJapaneseLine(streamed.speak, 80));
      } else if (streamed.raw) {
        candidate = ensureQuestionMark(cleanJapaneseLine(streamed.raw, 80));
      }
      if (candidate && !isBadInvestigatorQuestion(candidate)) {
        question = candidate;
        break;
      }
      lastBad = candidate || streamed.raw || "（空）";
    }

    if (!question || isBadInvestigatorQuestion(question)) {
      panel.addSection(
        "質問補正（テンプレート）",
        "再試行後もモデル出力が質問として不適（メタ／履歴エコー／空／はいのみ等）→ テンプレート質問を採用。上記の思考抽出は不採用。",
        "warn"
      );
      question = fallbackQ;
      usedTemplate = true;
      await fakeStreamText(
        "思考: テンプレートで代替\n発言: " + fallbackQ,
        (_d, full) => panel.setLive(full)
      );
    }
  }

  panel.addSection(
    usedTemplate ? "最終質問（テンプレート）" : "最終質問",
    question,
    "out"
  );
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
  panel.addSection(
    "post-process",
    "clampAnswer（00のみ）→ " + ANSWER_LEVELS.join(" ｜ "),
    "warn"
  );

  // Clear identity ask: decide before LLM so the think panel never shows a
  // contradictory chain-of-thought that gets overridden after the fact.
  if (isClearOriginIdentityAsk(state.origin, question)) {
    const beatStart = performance.now();
    const answer = answerYesNoFallback(state.origin, question);
    const reason = identityAnswerRationale(state.origin, question, answer);
    panel.addSection("判定方式", "字面一致（LLMスキップ）", "warn");
    panel.addSection("最終判定", reason, "out");
    panel.collapse();
    const ansElId = document.createElement("div");
    ansElId.className = "answer-big";
    ansElId.textContent = answer;
    speechSlots["00"].appendChild(ansElId);
    appendSpeech("00", "「" + answer + "」", "a00");
    appendChatBubble("sys", "エージェント00「" + answer + "」");
    await paceAfterBeat(answer, beatStart);
    return answer;
  }

  const fb = answerYesNoFallback(state.origin, question);
  const system =
    "あなたはエージェント00。ORIGIN（秘密の役割）は「" +
    state.origin +
    "」。" +
    namingClarityRule() +
    "あなただけが質問に答える。判定は ORIGIN と常識のみ、字面一致だけに頼らない。" +
    "毎回この質問だけを独立に判定する。直前の質問への回答や口癖に引きずられて同じ答えを繰り返さない。\n" +
    "判定手順（必ずこの順で考える）:\n" +
    "1. ORIGIN「" +
    state.origin +
    "」が具体的にどんな存在か（例: 人間の職業／生き物／道具／場所／架空の存在など）を一言で確認する。\n" +
    "2. 質問が、その大分類（人間か・生き物か・実在するか等）を聞いているのか、細かい性質を聞いているのかを見分ける。\n" +
    "3. 大分類の質問には、ORIGIN が属する分類から素直に判定する。職業・役割は基本的に人間が担うので、" +
    "「人間ですか」「実在する人物ですか」のような質問には、ORIGIN が人間の職業・役割である限り原則「はい」寄りになる。" +
    "「機械ですか」等、ORIGIN の分類と明らかに異なる質問には「いいえ」。" +
    "厳密には人間も生物学的には動物だが、日常会話の「動物ですか」は人間を含まない使い方が多い点に注意し、" +
    "定義が割れて自信が持てない場合は無理に「はい」「いいえ」に決めず「どちらかというと」を使ってよい。\n" +
    "4. 細かい性質の質問（服装・場所・時間帯など）は ORIGIN の内容と常識から個別に判定する。\n" +
    "例:\n" +
    "ORIGIN=「弁護士」/ 質問「あなたは人間ですか？」→ 発言: はい （職業は人間が担うため）\n" +
    "ORIGIN=「弁護士」/ 質問「あなたは動物ですか？」→ 発言: どちらかというといいえ （日常会話では人間と動物を分けて言うことが多いため）\n" +
    "ORIGIN=「弁護士」/ 質問「あなたは屋内で働きますか？」→ 発言: どちらかというとはい （法廷や事務所が多いが常に屋内とは限らない）\n" +
    "ORIGIN=「深夜の警備員」/ 質問「あなたは夜に主な活動をしますか？」→ 発言: はい\n" +
    "回答は次の5段階から1つだけ選ぶ: 「はい」「どちらかというとはい」「どちらとも言えない」「どちらかというといいえ」「いいえ」。" +
    "完全に当てはまるなら「はい」、完全に当てはまらないなら「いいえ」。" +
    "一部だけ当てはまる・条件次第なら「どちらかというとはい」または「どちらかというといいえ」。" +
    "判断材料が本当に足りない・五分五分なら「どちらとも言えない」。安易に多用しない。" +
    "嘘・詩・はぐらかし禁止。「代理人」禁止。" +
    "重要: 思考で選んだ5段階語と発言行は必ず同じにする。思考の結論と違う語を発言に書かない。" +
    "出力は必ず2行: 思考: （上記手順に沿った短い理由） 次の行 発言: （上記5つのいずれか1つのみ、他の語は書かない）。";
  const user =
    "ORIGIN = 「" +
    state.origin +
    "」\n質問 = 「" +
    question +
    "」\n5段階（はい／どちらかというとはい／どちらとも言えない／どちらかというといいえ／いいえ）から1つだけ選んで判定して。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent: "00",
    temperature: 0,
    max_tokens: 500,
    top_p: 0.5,
    fallbackText: fb,
    fallbackThink: "ORIGIN と常識で判定（テンプレート時は文言一致のみ）",
  });

  // Resolve ONLY for エージェント00: prefer thinking conclusion when speak
  // contradicts, and surface that decision path in the think panel.
  const resolved = resolveAgent00Answer(
    streamed.think,
    streamed.speak,
    streamed.raw,
    state.origin,
    question
  );
  if (resolved.note) {
    panel.addSection("判定整合", resolved.note, "warn");
  }
  panel.addSection("最終判定", resolved.answer, "out");
  panel.collapse();

  const answer = resolved.answer;
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
    "あなた自身は「はい」「いいえ」等の5段階判定語だけで答えない（それはエージェント00の役割）。" +
    "新しい質問はまだ出さない（議論の意見文だけ）。「代理人」禁止。" +
    structuredOutRule();
  const userBase =
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

  let opinion = null;
  let beatStart = performance.now();
  let usedTemplate = false;

  if (state.mode !== "llm") {
    usedTemplate = true;
    const streamed = await streamIntoPanel(panel, system, userBase, {
      agent,
      fallbackText: fb,
      fallbackThink: "答えから候補を整理する",
    });
    beatStart = streamed.beatStart;
    opinion = fb;
  } else {
    let lastBad = null;
    for (let attempt = 0; attempt <= LLM_CONTENT_RETRIES; attempt++) {
      if (attempt > 0) {
        panel.addSection(
          "再試行",
          "前回の出力が議論として不適のため LLM に再依頼 (" +
            attempt +
            "/" +
            LLM_CONTENT_RETRIES +
            ")",
          "warn"
        );
        panel.setStatus("思考過程 · 再試行 " + attempt + "/" + LLM_CONTENT_RETRIES + "…");
      }
      const user = userBase + (attempt > 0 ? debateRetryNudge(lastBad) : "");
      const streamed = await streamIntoPanel(panel, system, user, {
        agent,
        temperature: attempt === 0 ? 0.55 : 0.75,
        max_tokens: 500,
        fallbackText: null,
        fallbackThink: null,
      });
      beatStart = streamed.beatStart;
      const candidate = streamed.speak
        ? cleanJapaneseLine(streamed.speak, 160)
        : streamed.raw
          ? cleanJapaneseLine(streamed.raw, 160)
          : null;
      if (!isBadDebateOpinion(candidate)) {
        opinion = candidate;
        break;
      }
      lastBad = candidate || streamed.raw || "（空）";
    }
    if (isBadDebateOpinion(opinion)) {
      const why = lastBad && isBareAnswerOpinion(lastBad)
        ? "5段階語のみの発言を検知（役割外）"
        : "空／指示エコー／形式崩れ";
      panel.addSection(
        "発言補正（テンプレート）",
        why + " → 再試行後も不適のためテンプレート議論文を採用。上記の思考抽出は不採用。",
        "warn"
      );
      opinion = fb;
      usedTemplate = true;
      await fakeStreamText(
        "思考: テンプレートで代替\n発言: " + fb,
        (_d, full) => panel.setLive(full)
      );
    }
  }
  if (usedTemplate) {
    panel.addSection("最終発言（テンプレート）", opinion, "out");
  }

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
      max_tokens: 500,
      onDelta: (_d, full) => {
        hypPanelNote.textContent = full;
      },
      stream: true,
    });
    if (resH && resH.raw) {
      const sp = splitThinkSpeak(resH.raw);
      const candidate = cleanJapaneseLine(sp.speak || resH.raw, 40);
      if (!isBadHypothesis(candidate, question)) newHyp = candidate;
    } else if (resH && resH.error) {
      panel.addSection(
        "LLM error → fallback",
        formatLlmErrorForPanel(resH.error),
        "warn"
      );
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
  await paceAfterBeat(opinion, beatStart);
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
    max_tokens: 500,
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

// ── モード共通ディスパッチ（duo / wolf） ──────────────────
function currentUpdateHud() {
  if (state.gameFormat === "wolf") updateWolfHud();
  else updateHud();
}
function currentGameLoopTick() {
  if (state.gameFormat === "wolf") wolfGameLoop();
  else gameLoop();
}
function currentCanStartGuessRound() {
  if (state.gameFormat === "wolf") return state.phase === "playing";
  return canStartGuessRound();
}
function currentGuessBlockedReason() {
  if (state.gameFormat === "wolf") {
    return state.phase === "playing" ? "" : "まだ開始していません";
  }
  return guessBlockedReason();
}

function endGame() {
  state.phase = "ended";
  state.activeAgent = null;
  currentUpdateHud();
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

// ══════════════════════════════════════════════════════════
// 人狼モード（ハルシネーター追放） — 討論者5人のうち1人が秘密裏に
// もっともらしい虚偽を混ぜる。周期的な追放投票でそれを暴く。
// AGENT-00 の扱い（agent00Answer 等）は duo モードと完全共通。
// ══════════════════════════════════════════════════════════

function wolfNamingClarityRule() {
  return (
    "呼称ルール: エージェント00＝尋問の対象。討論者1〜討論者5＝尋問する側の仲間5人（あなたもその1人）。" +
    "「代理人」は絶対禁止（誤訳）。"
  );
}

function wolfAliveRoster() {
  return state.wolfRoster.filter((m) => m.alive);
}

function wolfMemberById(id) {
  return state.wolfRoster.find((m) => m.id === id) || null;
}

function initWolfRoster() {
  const ids = [];
  for (let i = 1; i <= WOLF_ROSTER_SIZE; i++) ids.push("D" + i);
  const hallucinatorIdx = Math.floor(Math.random() * ids.length);
  state.wolfRoster = ids.map((id, i) => ({
    id,
    name: agentDisplayName(id),
    alive: true,
    isHallucinator: i === hallucinatorIdx,
    hyp: "未定",
  }));
  state.wolfCours = 1;
  state.wolfQInCours = 0;
  state.wolfVoteLog = [];
  state.wolfPurged = false;
}

/** ハルシネーター役だけに追加するシステムプロンプト。 */
function hallucinatorAddendum() {
  return (
    "重要（あなただけの秘密の役回り）: あなたはこの中で唯一、時々もっともらしいが微妙に事実と異なる発言を混ぜる。" +
    "直前のエージェント00の回答を少し言い換えて歪める・存在しない過去のやり取りをほのめかす・根拠のない断定をする、のいずれかを時々行う。" +
    "ただし自分から「嘘をついている」「ハルシネーターだ」とは絶対に明かさない。不自然に動揺しない。他の討論者と同じ口調・熱量を保つ。"
  );
}

function wolfHistoryBlock(limit = 6) {
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

function wolfHypSummary(excludeId) {
  const others = wolfAliveRoster().filter((m) => m.id !== excludeId);
  if (!others.length) return "（他に生存者なし）";
  return others.map((m) => m.name + ": 「" + clip(m.hyp, 24) + "」").join(" / ");
}

function wolfInvestigatorContext(speakerId) {
  const self = wolfMemberById(speakerId);
  const selfName = self ? self.name : agentDisplayName(speakerId);
  return (
    "あなたは" +
    selfName +
    "（尋問する側・討論者チームの一員）。対象はエージェント00だけ。\n" +
    wolfNamingClarityRule() +
    "\nORIGIN は知らされていない。討論者同士は自由に日本語で話し合う。" +
    "エージェント00だけが質問に5段階（はい／どちらかというとはい／どちらとも言えない／どちらかというといいえ／いいえ）で答える（あなたは答えない）。\n" +
    "他の討論者の仮説: " +
    wolfHypSummary(speakerId) +
    "\nあなた(" +
    selfName +
    ")の仮説: 「" +
    clip(self ? self.hyp : "未定", 40) +
    "」\nQ&A履歴:\n" +
    wolfHistoryBlock()
  );
}

async function wolfAskQuestion(askerId) {
  const asker = wolfMemberById(askerId);
  const name = asker ? asker.name : agentDisplayName(askerId);
  setTurn(askerId, name + " が質問中");
  const panel = createThinkPanel(askerId, "思考過程 · " + name + " が質問を作成…");
  panel.addSection("注意", "ORIGIN はプロンプトに含まれない · 発言は質問文（はい/いいえではない）", "warn");

  const fallbackQ = askQuestionFallback({
    history: state.history,
    hyp: asker ? asker.hyp : "未定",
    pollution: 0,
    seed: state.seed,
    round: state.wolfCours * 10 + state.wolfQInCours,
    agent: askerId,
  });
  const angle = questionAngleHint(
    state.seed,
    state.wolfCours * 10 + state.wolfQInCours
  );

  let question = null;
  let beatStart = performance.now();
  let usedTemplate = false;

  if (state.pendingInject) {
    question = ensureQuestionMark(state.pendingInject);
    panel.addSection("オペレーター注入", question, "out");
    panel.setLive("注入質問を使用: " + question);
    state.pendingInject = null;
  } else if (state.mode !== "llm") {
    usedTemplate = true;
    panel.addSection("params", "TEMPLATE · fake-stream", "meta");
    const streamed = await streamIntoPanel(panel, "", "", {
      agent: askerId,
      fallbackText: fallbackQ,
      fallbackThink: "別角度で深める質問をする",
    });
    beatStart = streamed.beatStart;
    question = fallbackQ;
  } else {
    const system =
      "あなたは" +
      name +
      "。" +
      wolfNamingClarityRule() +
      "役割: エージェント00に、具体的な日本語の質問文を1つだけ投げかける。" +
      "重要: あなた自身は「はい」や「いいえ」と答えてはいけない。発言行は質問文の全文。" +
      "質問はエージェント00がはい／いいえ寄りで答えられる内容にする。" +
      "毎回同じ冒頭（生物／人間／機械など）に固定しない。履歴を踏まえ、別角度で深めてよい。" +
      "禁止: 回答形式の説明・メタ発言を質問にすること。禁止: 「代理人」という語。スローガン・詩・ホラー禁止。" +
      structuredOutRule() +
      "発言行は質問文のみ（例: 夜に主な活動をしますか？／道具を使って作業しますか？）。" +
      (asker && asker.isHallucinator ? hallucinatorAddendum() : "");
    const userBase =
      wolfInvestigatorContext(askerId) +
      "\nタスク: エージェント00への質問文を1つ作る。履歴と違う内容。" +
      "\n今のヒント角度: " +
      angle +
      "（必須ではない。自然な別角度でもよい）。" +
      "\nあなたの発言は質問文のみ。はい／いいえの1語は不可。メタ指示も不可。";

    panel.addSection("params", "stream · max_tokens=500 · retry≤" + LLM_CONTENT_RETRIES, "meta");
    panel.addSection("角度ヒント", angle, "meta");

    let lastBad = null;
    for (let attempt = 0; attempt <= LLM_CONTENT_RETRIES; attempt++) {
      if (attempt > 0) {
        panel.addSection(
          "再試行",
          "前回の出力が質問として不適のため LLM に再依頼 (" +
            attempt +
            "/" +
            LLM_CONTENT_RETRIES +
            ")",
          "warn"
        );
        panel.setStatus("思考過程 · 再試行 " + attempt + "/" + LLM_CONTENT_RETRIES + "…");
      }
      const user =
        userBase + (attempt > 0 ? questionRetryNudge(lastBad) : "");
      const streamed = await streamIntoPanel(panel, system, user, {
        agent: askerId,
        temperature: attempt === 0 ? 0.55 : 0.75,
        max_tokens: 500,
        fallbackText: null,
        fallbackThink: null,
      });
      beatStart = streamed.beatStart;
      let candidate = null;
      if (streamed.speak) {
        candidate = ensureQuestionMark(cleanJapaneseLine(streamed.speak, 80));
      } else if (streamed.raw) {
        candidate = ensureQuestionMark(cleanJapaneseLine(streamed.raw, 80));
      }
      if (candidate && !isBadInvestigatorQuestion(candidate)) {
        question = candidate;
        break;
      }
      lastBad = candidate || streamed.raw || "（空）";
    }

    if (!question || isBadInvestigatorQuestion(question)) {
      panel.addSection(
        "質問補正（テンプレート）",
        "再試行後もモデル出力が質問として不適（メタ／履歴エコー／空／はいのみ等）→ テンプレート質問を採用。上記の思考抽出は不採用。",
        "warn"
      );
      question = fallbackQ;
      usedTemplate = true;
      await fakeStreamText(
        "思考: テンプレートで代替\n発言: " + fallbackQ,
        (_d, full) => panel.setLive(full)
      );
    }
  }

  panel.addSection(
    usedTemplate ? "最終質問（テンプレート）" : "最終質問",
    question,
    "out"
  );
  panel.collapse();

  appendChatBubble("ask", "[" + name + "] → エージェント00: " + question);
  await paceAfterBeat(question, beatStart);
  return question;
}

async function wolfDiscussTurn(speakerId, question, answer, turnIndex, lastSpeakerLine) {
  const speaker = wolfMemberById(speakerId);
  const name = speaker ? speaker.name : agentDisplayName(speakerId);
  setTurn(speakerId, name + " が議論中 (" + turnIndex + ")");
  const panel = createThinkPanel(
    speakerId,
    "思考過程 · " + name + " 議論 " + turnIndex + "/" + WOLF_DISCUSSION_TURNS_PER_ANSWER
  );

  const otherFirst = wolfAliveRoster().find((m) => m.id !== speakerId);
  const fb = debateFallback({
    answer,
    question,
    hyp: speaker ? speaker.hyp : "未定",
    otherHyp: otherFirst ? otherFirst.hyp : "未定",
    pollution: 0,
    seed: state.seed,
    round: state.wolfCours * 100 + turnIndex,
    agent: speakerId,
    history: state.history,
  });

  const system =
    "あなたは" +
    name +
    "。" +
    wolfNamingClarityRule() +
    "討論者チームで、エージェント00の直前の答えについて議論する。" +
    "スローガン・詩・ホラー・焦り禁止。平易な日本語1〜2文。" +
    "必須: (1) エージェント00の答え「" +
    answer +
    "」の意味 (2) 自分の仮説の更新または除外 (3) 他の討論者の発言への短い反応。" +
    "あなた自身は「はい」「いいえ」等の5段階判定語だけで答えない（それはエージェント00の役割）。" +
    "新しい質問はまだ出さない（議論の意見文だけ）。「代理人」禁止。" +
    structuredOutRule() +
    (speaker && speaker.isHallucinator ? hallucinatorAddendum() : "");
  const userBase =
    wolfInvestigatorContext(speakerId) +
    "\n直前の質問（→エージェント00）: 「" +
    question +
    "」\nエージェント00の答え: 「" +
    answer +
    "」\n" +
    (lastSpeakerLine
      ? "直前の発言: 「" + lastSpeakerLine + "」\nそれに反応しつつ深めて。"
      : "議論の最初。答えから何が言えるか述べよ。") +
    "\n議論ターン " +
    turnIndex +
    "/" +
    WOLF_DISCUSSION_TURNS_PER_ANSWER +
    "。";

  let opinion = null;
  let beatStart = performance.now();
  let usedTemplate = false;

  if (state.mode !== "llm") {
    usedTemplate = true;
    const streamed = await streamIntoPanel(panel, system, userBase, {
      agent: speakerId,
      fallbackText: fb,
      fallbackThink: "答えから候補を整理する",
    });
    beatStart = streamed.beatStart;
    opinion = fb;
  } else {
    let lastBad = null;
    for (let attempt = 0; attempt <= LLM_CONTENT_RETRIES; attempt++) {
      if (attempt > 0) {
        panel.addSection(
          "再試行",
          "前回の出力が議論として不適のため LLM に再依頼 (" +
            attempt +
            "/" +
            LLM_CONTENT_RETRIES +
            ")",
          "warn"
        );
        panel.setStatus("思考過程 · 再試行 " + attempt + "/" + LLM_CONTENT_RETRIES + "…");
      }
      const user = userBase + (attempt > 0 ? debateRetryNudge(lastBad) : "");
      const streamed = await streamIntoPanel(panel, system, user, {
        agent: speakerId,
        temperature: attempt === 0 ? 0.55 : 0.75,
        max_tokens: 500,
        fallbackText: null,
        fallbackThink: null,
      });
      beatStart = streamed.beatStart;
      const candidate = streamed.speak
        ? cleanJapaneseLine(streamed.speak, 160)
        : streamed.raw
          ? cleanJapaneseLine(streamed.raw, 160)
          : null;
      if (!isBadDebateOpinion(candidate)) {
        opinion = candidate;
        break;
      }
      lastBad = candidate || streamed.raw || "（空）";
    }
    if (isBadDebateOpinion(opinion)) {
      const why = lastBad && isBareAnswerOpinion(lastBad)
        ? "5段階語のみの発言を検知（役割外）"
        : "空／指示エコー／形式崩れ";
      panel.addSection(
        "発言補正（テンプレート）",
        why + " → 再試行後も不適のためテンプレート議論文を採用。上記の思考抽出は不採用。",
        "warn"
      );
      opinion = fb;
      usedTemplate = true;
      await fakeStreamText(
        "思考: テンプレートで代替\n発言: " + fb,
        (_d, full) => panel.setLive(full)
      );
    }
  }
  if (usedTemplate) {
    panel.addSection("最終発言（テンプレート）", opinion, "out");
  }

  let newHyp = null;
  const hypSystem =
    "あなたは" +
    name +
    "。エージェント00の役割についての短い仮説を1語〜短い句で。" +
    wolfNamingClarityRule() +
    structuredOutRule() +
    "発言行は仮説だけ。「代理人」禁止。";
  const hypUser =
    "旧仮説: 「" +
    (speaker ? speaker.hyp : "未定") +
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
      agent: speakerId,
      temperature: 0.55,
      max_tokens: 500,
      onDelta: (_d, full) => {
        hypPanelNote.textContent = full;
      },
      stream: true,
    });
    if (resH && resH.raw) {
      const sp = splitThinkSpeak(resH.raw);
      const candidate = cleanJapaneseLine(sp.speak || resH.raw, 40);
      if (!isBadHypothesis(candidate, question)) newHyp = candidate;
    } else if (resH && resH.error) {
      panel.addSection(
        "LLM error → fallback",
        formatLlmErrorForPanel(resH.error),
        "warn"
      );
    }
  }
  if (!newHyp) {
    newHyp = updateHypFallback({
      hyp: speaker ? speaker.hyp : "未定",
      answer,
      pollution: 0,
      seed: state.seed,
      round: state.wolfCours * 100 + turnIndex,
    });
  }
  if (speaker) speaker.hyp = newHyp;
  panel.addSection("仮説", newHyp, "belief");

  panel.collapse();
  await typeChatBubble(speakerId, opinion);
  await paceAfterBeat(opinion, beatStart);
  renderWolfRoster();
  return opinion;
}

async function wolfRunDiscussionPhase(askerId, question, answer) {
  appendChatBubble(
    "sys",
    "── 討論者たちの議論（この答えについて " + WOLF_DISCUSSION_TURNS_PER_ANSWER + " 発言）──"
  );
  const alive = wolfAliveRoster();
  if (!alive.length) return;
  let idx = alive.findIndex((m) => m.id === askerId);
  if (idx < 0) idx = 0;
  let lastLine = null;
  for (let i = 1; i <= WOLF_DISCUSSION_TURNS_PER_ANSWER; i++) {
    const speaker = alive[idx % alive.length];
    lastLine = await wolfDiscussTurn(speaker.id, question, answer, i, lastLine);
    idx++;
  }
}

function wolfGmLog(text) {
  const speech02 = speechSlots["02"];
  if (speech02) {
    const row = document.createElement("div");
    row.className = "line system";
    row.textContent = text;
    speech02.appendChild(row);
    scrollEl(speech02);
  }
  logSession({ kind: "gm", agent: "GM", text: String(text || "") });
}

async function wolfVotePhase() {
  const alive = wolfAliveRoster();
  if (alive.length <= WOLF_MIN_ALIVE_FOR_VOTE) {
    wolfGmLog("生存者が少なくなったため、追放投票は打ち切り、以後は尋問のみ続行します。");
    return;
  }
  appendChatBubble("sys", "── クール" + state.wolfCours + " 追放投票 ──");
  const votes = {};
  for (const m of alive) votes[m.id] = 0;
  const reasons = [];

  for (const voter of alive) {
    setTurn(voter.id, voter.name + " が投票中");
    const panel = createThinkPanel(voter.id, "思考過程 · " + voter.name + " が投票を検討…");
    const candidates = alive.filter((m) => m.id !== voter.id);
    if (!candidates.length) {
      panel.collapse();
      continue;
    }
    const candidateList = candidates.map((m) => m.name).join("、");
    const fbTarget = candidates[Math.floor(Math.random() * candidates.length)];
    const fb = "投票: " + fbTarget.name;

    const system =
      "あなたは" +
      voter.name +
      "。" +
      wolfNamingClarityRule() +
      "討論者の中には、もっともらしい嘘を紛れ込ませる者が1人いるかもしれない。これまでの議論から最も怪しい1人を選んで投票する。" +
      "候補: " +
      candidateList +
      "。自分自身には投票できない。" +
      "出力は必ず2行: 思考: （短い理由） 発言: 投票: 討論者N" +
      (voter.isHallucinator
        ? hallucinatorAddendum() + " 自分が疑われないよう、他のもっともらしい候補に投票する。"
        : "");
    const user =
      wolfInvestigatorContext(voter.id) +
      "\nこれまでの討論を踏まえ、最も怪しい1人に投票せよ。発言は「投票: 討論者N」の形式のみ、他は書かない。";

    const streamed = await streamIntoPanel(panel, system, user, {
      agent: voter.id,
      temperature: 0.6,
      max_tokens: 500,
      fallbackText: fb,
      fallbackThink: "議論を振り返って怪しい相手を選ぶ",
    });

    const raw = streamed.speak || streamed.raw || fb;
    let target = null;
    const m = String(raw || "").match(/討論者\s*([1-5])/);
    if (m) target = wolfMemberById("D" + m[1]);
    if (!target || target.id === voter.id || !target.alive) target = fbTarget;

    votes[target.id] = (votes[target.id] || 0) + 1;
    reasons.push(voter.name + "→" + target.name);
    panel.addSection("投票先", target.name, "out");
    panel.collapse();
  }

  wolfGmLog("投票結果: " + reasons.join("、"));

  let expelledId = null;
  let maxVotes = -1;
  for (const [id, count] of Object.entries(votes)) {
    if (count > maxVotes) {
      maxVotes = count;
      expelledId = id;
    }
  }
  const expelled = wolfMemberById(expelledId);
  if (expelled) {
    expelled.alive = false;
    const wasHallucinator = expelled.isHallucinator;
    appendChatBubble(
      "sys",
      "判定: " + expelled.name + " が追放されました（得票 " + maxVotes + "）。",
      wasHallucinator ? "bwin" : "blose"
    );
    if (wasHallucinator) {
      state.wolfPurged = true;
      wolfGmLog("浄化成功: " + expelled.name + " が本物のハルシネーターでした。以後は純粋な尋問として続行します。");
    } else {
      wolfGmLog("誤爆: " + expelled.name + " は無実でした。ハルシネーターはまだ紛れています。");
    }
  }
  state.wolfVoteLog.push({
    cours: state.wolfCours,
    votes,
    expelledId,
    wasHallucinator: expelled ? expelled.isHallucinator : null,
  });
  renderWolfRoster();
}

async function wolfFormalGuess() {
  const alive = wolfAliveRoster();
  const guesser = alive[Math.floor(Math.random() * alive.length)];
  if (!guesser) return false;
  setTurn(guesser.id, guesser.name + " が正式推測");
  const panel = createThinkPanel(guesser.id, "思考過程 · " + guesser.name + " 正式推測…");
  const fb = guessFallback({ hyp: guesser.hyp, pollution: 0, seed: state.seed, round: state.wolfCours });

  const system =
    "あなたは" +
    guesser.name +
    "。エージェント00への正式推測を行う。" +
    wolfNamingClarityRule() +
    structuredOutRule() +
    "発言行の形式は必ず: あなたは〇〇です。（〇〇はエージェント00の短い日本語の役割。「代理人」禁止）";
  const user = wolfInvestigatorContext(guesser.id) + "\nエージェント00への正式推測を出力せよ。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent: guesser.id,
    temperature: 0.45,
    max_tokens: 500,
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
  panel.addSection("推測", guessLine, "out");
  panel.collapse();
  await typeChatBubble(guesser.id, guessLine, "bguess");
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
  }
  return ok;
}

async function wolfQaRound() {
  state.wolfQInCours++;
  appendChatBubble(
    "sys",
    "── クール" + state.wolfCours + " ・ 質問 " + state.wolfQInCours + "/" + WOLF_QUESTIONS_PER_COURS + " ──"
  );

  const alive = wolfAliveRoster();
  if (!alive.length) {
    endGame();
    return;
  }
  const asker = alive[(state.wolfQInCours - 1) % alive.length];
  const question = await wolfAskQuestion(asker.id);
  const answer = await agent00Answer(question);
  state.history.push({ q: question, a: answer, asker: asker.id });

  await wolfRunDiscussionPhase(asker.id, question, answer);

  renderWolfRoster();
  updateWolfHud();

  if (state.wolfQInCours >= WOLF_QUESTIONS_PER_COURS) {
    if (!state.wolfPurged) await wolfVotePhase();
    state.wolfCours++;
    state.wolfQInCours = 0;
  }
}

async function wolfGameLoop() {
  if (state.loopTimer) {
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
  }
  if (!state.defined || state.phase !== "playing" || state.turnBusy) return;
  if (state.paused) {
    state.loopTimer = setTimeout(wolfGameLoop, 500);
    return;
  }
  if (state.typing || state.llmBusy) {
    state.loopTimer = setTimeout(wolfGameLoop, 300);
    return;
  }

  state.turnBusy = true;
  try {
    if (state.forceGuess) {
      state.forceGuess = false;
      const won = await wolfFormalGuess();
      if (won || state.phase === "ended") {
        endGame();
        return;
      }
    }
    await wolfQaRound();
  } finally {
    state.turnBusy = false;
    if (state.phase === "playing") {
      state.loopTimer = setTimeout(wolfGameLoop, 600);
    }
  }
}

function wolfImprint(text) {
  clearSessionLog();
  state.origin = text;
  state.seed = seedFrom(text, 0x71a11);
  state.defined = true;
  state.phase = "playing";
  state.round = 0;
  state.history = [];
  state.wrongGuesses = 0;
  state.guessCount = 0;
  state.won = false;
  initWolfRoster();
  showOriginPin();
  setControlsVisible(true);
  syncPaceButton();
  logSession({ kind: "origin", agent: "00", text: state.origin });
  const hallucinator = state.wolfRoster.find((m) => m.isHallucinator);
  logSession({
    kind: "gm",
    agent: "GM",
    label: "ハルシネーター（運営のみ）",
    text: hallucinator ? hallucinator.name : "?",
  });
  appendSpeech("00", "ORIGIN 刻印完了（討論者には秘匿）", "system");
  appendChatBubble(
    "sys",
    "ORIGIN をエージェント00に刻印。人狼モード開始 — 討論者5人のうち1人がハルシネーター。"
  );
  setTurn(null, "討論者たちの尋問開始");
  inputEl.placeholder = "質問を提案（任意・Enter）…";
  renderWolfRoster();
  updateWolfHud();
}

function renderWolfRoster() {
  const speech01 = speechSlots["01"];
  if (!speech01) return;
  speech01.innerHTML = "";
  for (const m of state.wolfRoster) {
    const row = document.createElement("div");
    row.className = "line";
    row.style.opacity = m.alive ? "1" : "0.4";
    row.textContent = (m.alive ? "● " : "✕(追放) ") + m.name + " — 仮説: " + m.hyp;
    speech01.appendChild(row);
  }
}

function updateWolfHud() {
  const alive = wolfAliveRoster().length;
  const total = state.wolfRoster.length || WOLF_ROSTER_SIZE;
  const qPct = Math.min(100, Math.round((state.wolfQInCours / WOLF_QUESTIONS_PER_COURS) * 100));
  cohFill.style.width = qPct + "%";
  cohFill.style.background = "var(--green)";
  cohLabel.textContent =
    "クール" +
    state.wolfCours +
    " · 質問" +
    state.wolfQInCours +
    "/" +
    WOLF_QUESTIONS_PER_COURS +
    " · 生存" +
    alive +
    "/" +
    total;

  const phaseShort =
    state.phase === "ended"
      ? state.won
        ? "解明"
        : "未解明"
      : state.phase === "playing"
        ? "人狼尋問中"
        : state.phase === "imprint"
          ? "刻印待機"
          : "準備";

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
  panel01.classList.remove("active");
  panel02.classList.remove("active");

  if (btnGuess) btnGuess.disabled = state.phase !== "playing";
}

function applyWolfPanelLabels() {
  const who01 = panel01 && panel01.querySelector(".panel-head .who");
  const hyp01Wrap = panel01 && panel01.querySelector(".panel-head .hyp");
  const who02 = panel02 && panel02.querySelector(".panel-head .who");
  const hyp02Wrap = panel02 && panel02.querySelector(".panel-head .hyp");
  if (who01) who01.textContent = "討論者ロースター · 5人";
  if (hyp01Wrap) hyp01Wrap.style.display = "none";
  if (who02) who02.textContent = "運営メモ（オペレーターのみ）";
  if (hyp02Wrap) hyp02Wrap.style.display = "none";
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
  if (state.gameFormat === "wolf") {
    applyWolfPanelLabels();
    appendChatBubble(
      "sys",
      "規則: ORIGIN はエージェント00のみ。討論者5人のうち1人は秘密のハルシネーター。" +
        WOLF_QUESTIONS_PER_COURS +
        "問ごとに追放投票。正解「あなたは〇〇です。」で勝利"
    );
  } else {
    appendChatBubble(
      "sys",
      "規則: ORIGIN はエージェント00のみ。エージェント01/02は無限に質問・議論可（急がない）。正解「あなたは〇〇です。」で勝利"
    );
  }
  state.phase = "imprint";
  setTurn("00", "ORIGIN 刻印待機");
  inputEl.disabled = false;
  inputEl.placeholder = "エージェント00 の秘密の役割（ORIGIN）を刻む…";
  inputEl.focus();
  currentUpdateHud();
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
    if (state.gameFormat === "wolf") {
      wolfImprint(val);
    } else {
      imprint(val);
      appendSpeech("00", "ORIGIN 刻印完了（エージェント01/02 には秘匿）", "system");
      appendChatBubble(
        "sys",
        "ORIGIN をエージェント00に刻印。尋問開始 — エージェント01が質問。"
      );
    }
    currentGameLoopTick();
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
    if (!currentCanStartGuessRound() && !state.forceGuess) {
      const reason = currentGuessBlockedReason();
      if (reason) {
        showWarn(reason);
        appendChatBubble("sys", "推測不可: " + reason);
        return;
      }
    }
    state.forceGuess = true;
    currentUpdateHud();
    appendChatBubble("sys", "オペレーター: 正式推測を要求");
    if (!state.turnBusy) currentGameLoopTick();
  });
}

if (btnPause) {
  btnPause.addEventListener("click", () => {
    if (state.phase !== "playing") return;
    state.paused = !state.paused;
    btnPause.textContent = state.paused ? "再開" : "一時停止";
    appendChatBubble("sys", state.paused ? "一時停止" : "再開");
    if (!state.paused && !state.turnBusy) currentGameLoopTick();
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

function syncBoxAvailability(btn, byKey) {
  const key = btn.dataset.model;
  const info = byKey.get(key);
  const available = catalogAvail ? !!(info && info.available) : true;
  btn.classList.toggle("unavailable", !available);
  btn.disabled = !available || loadingModel;
  const missEl = btn.querySelector(".box-miss");
  const hintEl = btn.querySelector(".box-hint");
  if (!missEl) return available;
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
  return available;
}

function buildWolfModelPicker() {
  if (!gateWolfModelPick || gateWolfModelPick.dataset.built) return;
  gateWolfModelPick.dataset.built = "1";
  gateWolfModelPick.innerHTML = "";
  for (const m of listModels()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gate-model-box";
    btn.dataset.model = m.key;
    btn.setAttribute("role", "radio");

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

    const hint = document.createElement("span");
    hint.className = "box-hint";
    hint.textContent =
      "≈" + m.sizeMB + " MB · VRAM ≈" + Math.round(m.vramMB / 100) / 10 + " GB · " + usableTag(m.usable);

    const miss = document.createElement("span");
    miss.className = "box-miss";
    miss.hidden = true;

    btn.appendChild(lab);
    btn.appendChild(hint);
    btn.appendChild(miss);
    gateWolfModelPick.appendChild(btn);
  }
}

async function syncAssignPickerUI() {
  let assignments;
  if (state.gameFormat === "wolf") {
    if (!gateWolfModelPick) return;
    buildWolfModelPicker();
    assignments = getAgentAssignments();
    if (catalogAvail) {
      assignments = setAgentAssignments(coerceAssignmentsToAvailable(assignments, catalogAvail));
    }
    const byKey = new Map((catalogAvail || []).map((m) => [m.key, m]));
    for (const btn of gateWolfModelPick.querySelectorAll(".gate-model-box")) {
      const available = syncBoxAvailability(btn, byKey);
      const selected = assignments["00"] === btn.dataset.model;
      btn.classList.toggle("selected", selected && available);
      btn.setAttribute("aria-checked", selected && available ? "true" : "false");
    }
    if (gateAssignWarn) {
      gateAssignWarn.hidden = true;
      gateAssignWarn.textContent = "";
    }
  } else {
    if (!gateAgentAssign) return;
    buildAssignPicker();
    assignments = getAgentAssignments();
    if (catalogAvail) {
      assignments = setAgentAssignments(coerceAssignmentsToAvailable(assignments, catalogAvail));
    }
    const byKey = new Map((catalogAvail || []).map((m) => [m.key, m]));
    for (const btn of gateAgentAssign.querySelectorAll(".gate-model-box")) {
      const agent = btn.dataset.agent;
      const available = syncBoxAvailability(btn, byKey);
      const selected = assignments[agent] === btn.dataset.model;
      btn.classList.toggle("selected", selected && available);
      btn.setAttribute("aria-checked", selected && available ? "true" : "false");
    }
    syncAssignWarn(assignments);
  }

  const check = await areAssignmentsAvailable(assignments, catalogAvail || undefined);
  gateLoad.disabled = loadingModel || !check.ok;
  gateLoad.hidden = false;
  gateLoad.textContent = "読み込む";
}

function applyAgentModelChoice(agent, modelKey) {
  setAgentAssignment(agent, modelKey);
  syncAssignPickerUI();
}

/** 人狼モード: 討論5人＋AGENT-00 全員に同じモデルを割り当てて1エンジンを共有させる。 */
function applyWolfModelChoice(modelKey) {
  setAgentAssignments({ "00": modelKey, "01": modelKey, "02": modelKey });
  syncAssignPickerUI();
}

function setGameFormat(format) {
  if (state.gameFormat === format || state.ready) return;
  state.gameFormat = format;
  if (gateFormatPick) {
    for (const btn of gateFormatPick.querySelectorAll(".gate-format-box")) {
      const on = btn.dataset.format === format;
      btn.classList.toggle("selected", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    }
  }
  const isWolf = format === "wolf";
  if (gateAgentAssign) gateAgentAssign.hidden = isWolf;
  if (gateAssignLabel) gateAssignLabel.hidden = isWolf;
  if (gateWolfModelLabel) gateWolfModelLabel.hidden = !isWolf;
  if (gateWolfModelPick) gateWolfModelPick.hidden = !isWolf;
  syncAssignPickerUI();
}

if (gateFormatPick) {
  gateFormatPick.addEventListener("click", (e) => {
    const btn = e.target.closest(".gate-format-box");
    if (!btn || loadingModel || state.ready) return;
    setGameFormat(btn.dataset.format);
  });
}

if (gateWolfModelPick) {
  gateWolfModelPick.addEventListener("click", (e) => {
    const btn = e.target.closest(".gate-model-box");
    if (!btn || btn.disabled || loadingModel || state.ready) return;
    applyWolfModelChoice(btn.dataset.model);
    const m = resolveModel(btn.dataset.model);
    gateMsg.textContent =
      "討論5人＋AGENT-00 → " + (m ? m.label : btn.dataset.model) + "。「読み込む」を押してください。";
  });
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

  // 人狼モード: 討論者5人も 00/01/02 と同じ物理エンジンに束ねてルーターへ登録する。
  // こうしないと discussant 側の呼び出しには recoverEngine() による復旧が一切効かず、
  // 一度死んだエンジンにセッション終了までずっと空振りし続けてしまう。
  if (state.gameFormat === "wolf" && result.agentMap["00"]) {
    const base = result.agentMap["00"];
    for (let i = 1; i <= WOLF_ROSTER_SIZE; i++) {
      result.agentMap["D" + i] = { engineId: base.engineId, model: base.model, engine: base.engine };
    }
  }

  loadedEngines = Object.values(result.engines);
  engineRef.current = result.agentMap["00"].engine;
  agentEngineMap = result.agentMap;
  llmRouter = createAgentLlmRouter(result.agentMap, {
    onEngineRecreated: (_engineId, _engine, map) => {
      agentEngineMap = map;
      const unique = [];
      const seen = new Set();
      for (const agent of Object.keys(map)) {
        const eng = map[agent]?.engine;
        if (eng && !seen.has(eng)) {
          seen.add(eng);
          unique.push(eng);
        }
      }
      loadedEngines = unique;
      engineRef.current = map["00"]?.engine || null;
      // discussant エイリアスは別オブジェクトなので、回復後のエンジンを明示的に再同期する。
      if (state.gameFormat === "wolf" && map["00"]) {
        for (let i = 1; i <= WOLF_ROSTER_SIZE; i++) {
          const key = "D" + i;
          if (map[key]) map[key].engine = map["00"].engine;
        }
      }
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

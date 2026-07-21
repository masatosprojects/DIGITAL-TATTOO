/**
 * DIGITAL TATTOO — interrogation game (3-zone layout)
 *
 *   [ AGENT-00 top ]
 * [01 left] [ LINE chat ] [02 right]
 *
 * ORIGIN imprinted on 00 only. 01/02 ask freely; 00 answers in detail;
 * formal guess: 「あなたは〇〇です。」
 * LLM streams live into thinking panels; steady user-controlled read pacing.
 */

import {
  seedFrom,
  clip,
  answerYesNoFallback,
  isClearOriginIdentityAsk,
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
  isLlmDeadError,
  PAGES_MODEL_KEY,
} from "./llm.js";

/** Shown in chat so operators can verify they are not on a cached old build. */
const CLIENT_BUILD = "ux-product-1";

/** Unbounded Q&A / 01↔02 discussion until correct guess (or pause/reload). */
const MIN_ROUNDS_BEFORE_GUESS = 1;
/** Mild anti-spam only — formal guesses may still land “someday”. */
const GUESS_COOLDOWN_ROUNDS = 2;
/**
 * エージェント01↔02 の議論発言がこの数に達するまで正式推測を許可しない。
 * （キャッチフレーズ1往復で推測へ飛ばない）
 */
const MIN_DISCUSS_BEFORE_GUESS = 5;
/**
 * 00 の各回答のあと、01↔02 が最低これだけ交互に議論してから次の質問へ。
 * 短くするほどテンポよく質問が飛ぶ（議論を挟まず矢継ぎ早に尋問する感じに近づく）。
 */
const DISCUSSION_TURNS_PER_ANSWER = 1;

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
const sharedMemoryEl = document.getElementById("sharedMemory");
const sharedMemoryHead = document.getElementById("sharedMemoryHead");
const sharedMemoryList = document.getElementById("sharedMemoryList");
const sharedMemoryCount = document.getElementById("sharedMemoryCount");
const boardEl = document.getElementById("board");
const btnThinkToggle = document.getElementById("btnThinkToggle");
const btnSend = document.getElementById("btnSend");
const gateAdvancedToggle = document.getElementById("gateAdvancedToggle");
const gateAdvanced = document.getElementById("gateAdvanced");
const topicCards = document.getElementById("topicCards");
const topicEcho = document.getElementById("topicEcho");
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
const btnReloadModel = document.getElementById("btnReloadModel");
const btnDownload = document.getElementById("btnDownload");
const controlsEl = document.getElementById("controls");
const downloadRowEl = document.getElementById("downloadRow");

/** Display only — never used as a prepared hypothesis for the AIs. */
const HYP_NOT_YET = "（まだAIが立てていない）";

const state = {
  ready: false,
  defined: false,
  origin: "",
  seed: 0,
  mode: "booting",
  phase: "boot",
  round: 0,
  nextAsker: "01",
  /**
   * 共用記憶 (01/02 shared memory): completed Q→A beats.
   * Shape: { q, a, asker, round, ts }[]
   */
  history: [],
  /** Normalized question stems remembered as soon as a question is spoken. */
  askedStems: [],
  /** Duo: shared hyp — empty until AI invents one (no prepared starter). */
  sharedHyp: "",
  /** @type {string[]} short alternate candidates (shared). */
  sharedHypAlts: [],
  /** UI mirrors of sharedHyp (kept in sync for panel heads). */
  hyp01: "",
  hyp02: "",
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
/** GPU/エンジンが連続で落ちた回数（成功でリセット）。到達で会話終了。 */
let consecutiveLlmFailures = 0;
const LLM_FAILURE_WARN_THRESHOLD = 3;
/**
 * このページ読み込み中に GPU 切断（device lost）が起きた回数。成功しても
 * リセットしない — ブラウザの GPU プロセス自体が壊れている場合、同一タブ内
 * では何度モデルを選び直しても再現し続けることがあるため、2回目以降は
 * ページの本当のリロードを明確に勧める判断に使う。
 */
let gpuDeathCount = 0;

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
  lines.push("エンジン: " + (state.mode === "llm" ? "LLM · " + assignmentShortLabel() : "LLM 未ロード"));
  lines.push("");
  lines.push("======== ORIGIN（エージェント00のみ） ========");
  lines.push(state.origin ? state.origin : "（未刻印）");
  lines.push("");
  if (state.gameFormat !== "wolf") {
    lines.push("======== 共有仮説（エージェント01/02） ========");
    lines.push(formatSharedHypDisplay());
    lines.push("");
  }
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
    engineBadge.textContent = "LLM 未ロード";
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

  cohLabel.textContent = "Round " + state.round;

  const hypUi = formatSharedHypDisplay();
  if (hyp01El) hyp01El.textContent = hypUi;
  if (hyp02El) hyp02El.textContent = hypUi;

  if (phaseLabelEl) {
    phaseLabelEl.textContent =
      state.phase === "ended"
        ? state.won
          ? "正体が解明されました"
          : "未解明のまま終了しました"
        : state.phase === "imprint"
          ? "秘密の役割（ORIGIN）を入力してください"
          : humanPhaseLabel(state.turnPhase || phaseShort);
  }

  panel00.classList.toggle("active", state.activeAgent === "00");
  panel01.classList.toggle("active", state.activeAgent === "01");
  panel02.classList.toggle("active", state.activeAgent === "02");

  if (btnGuess) {
    btnGuess.disabled = state.phase !== "playing" || !canStartGuessRound();
  }
  renderSharedMemory();
}

/** 共用記憶 UI — always-visible Q→A list for エージェント01/02. */
function renderSharedMemory() {
  if (!sharedMemoryList || !sharedMemoryCount) return;
  const rows = state.history || [];
  sharedMemoryCount.textContent = rows.length + "件";
  if (!rows.length) {
    sharedMemoryList.innerHTML =
      '<div class="mem-empty">まだ質問なし — ここにあとで Q→A が残ります</div>';
    return;
  }
  sharedMemoryList.innerHTML = rows
    .map((h, i) => {
      const asker = agentUiLabel(h.asker || "");
      const round = h.round != null ? "R" + h.round : "";
      return (
        '<div class="mem-row">' +
        '<span class="mem-idx">' +
        (i + 1) +
        "</span>" +
        '<div class="mem-q">「' +
        escapeHtmlLite(h.q) +
        "」</div>" +
        '<div class="mem-a">→ 「' +
        escapeHtmlLite(h.a) +
        "」</div>" +
        '<div class="mem-meta">' +
        escapeHtmlLite([round, asker].filter(Boolean).join(" · ")) +
        "</div>" +
        "</div>"
      );
    })
    .join("");
  sharedMemoryList.scrollTop = sharedMemoryList.scrollHeight;
}

function escapeHtmlLite(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Record a completed ask+answer into 共用記憶 and refresh UI. */
function recordSharedMemory(question, answer, asker) {
  const entry = {
    q: String(question || "").trim(),
    a: String(answer || "").trim(),
    asker: asker || "",
    round: state.round || 0,
    ts: Date.now(),
  };
  if (!entry.q) return;
  state.history.push(entry);
  rememberAskedStem(entry.q);
  renderSharedMemory();
}

/** Remember stem as soon as a question is spoken (blocks re-ask before answer lands). */
function rememberAskedStem(q) {
  const key = normalizeQuestionKey(q);
  if (!key || key.length < 4) return;
  if (!Array.isArray(state.askedStems)) state.askedStems = [];
  if (!state.askedStems.includes(key)) state.askedStems.push(key);
}

function clearSharedMemory() {
  state.history = [];
  state.askedStems = [];
  renderSharedMemory();
}

if (sharedMemoryHead && sharedMemoryEl) {
  sharedMemoryHead.addEventListener("click", () => {
    sharedMemoryEl.classList.toggle("collapsed");
  });
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

/** Prompt label — always エージェントNN (never change for LLM rules). */
function agentPromptName(agent) {
  return agentDisplayName(agent);
}

/** Visible UI role name only (display). */
function agentUiName(agent) {
  if (agent === "00") return "対象者";
  if (agent === "01") return "尋問官A";
  if (agent === "02") return "尋問官B";
  if (agent === "GM") return "運営";
  const wolf = /^D([1-5])$/.exec(agent || "");
  if (wolf) return "討論者" + wolf[1];
  return agentDisplayName(agent);
}

/** Visible UI tag: 対象者 · AGENT-00 */
function agentUiLabel(agent) {
  if (agent === "00" || agent === "01" || agent === "02") {
    return agentUiName(agent) + " · AGENT-" + agent;
  }
  return agentUiName(agent);
}

/** Human-readable phase line for the quiet status row. */
function humanPhaseLabel(raw) {
  const t = String(raw || "").trim();
  if (!t) return "準備しています…";
  if (/質問中/.test(t)) return "AIが質問を考えています…";
  if (/回答中/.test(t)) return "対象者が答えています…";
  if (/議論中/.test(t)) return "尋問官が相談しています…";
  if (/正式推測/.test(t)) return "正式な推測を出しています…";
  if (/刻印/.test(t)) return "秘密の役割（ORIGIN）を入力してください";
  if (/尋問開始|討論者たちの尋問/.test(t)) return "シミュレーション進行中…";
  if (/次は/.test(t)) return t.replace(/エージェント0([12])/g, (_, n) => (n === "1" ? "尋問官A" : "尋問官B"));
  if (t === "準備" || t === "尋問中" || t === "人狼尋問中") return "シミュレーション進行中…";
  if (t === "解明") return "正体が解明されました";
  if (t === "未解明") return "未解明のまま終了しました";
  return t;
}

function namingClarityRule() {
  return (
    "呼称ルール: 必ず「エージェント00」「エージェント01」「エージェント02」と呼ぶ。" +
    "「代理人」は絶対禁止（誤訳）。曖昧な「エージェント」単体も禁止。" +
    "固定役割（t=0から既知・確認不要）: " +
    "エージェント00＝被尋問者（ORIGIN を持つ。質問には自由に詳しく答える）。" +
    "エージェント01とエージェント02＝友人であり同僚の協同尋問官（t=0から互いを知っており協力確定。" +
    "二人で共有仮説を育て、エージェント00だけを尋問し、ORIGIN空間をどんどん絞る）。"
  );
}

/** Keep 00/01/02 from burning early turns on “who am I?” role discovery. */
function roleAlreadyKnownRule() {
  return (
    "重要: 役割・協力関係は開幕（t=0）から確定済み。" +
    "事前の会話がゼロでも、友人・同僚の協同尋問官としてすでに息が合っている前提で動け。" +
    "自分が誰か・何の立場か・相手が同僚／友人かどうか・協力体制の確認は一切不要・禁止。" +
    "自己紹介・役割確認・初対面アピール・「これから議論する準備」・ウォームアップ・メタ前置きは禁止。" +
    "最初の発言からORIGIN空間を絞る尋問／議論の本題に入れ。"
  );
}

/** Duo partnership — friends/colleagues who already work together from turn 0. */
function duoPartnershipRule() {
  return (
    "関係（t=0から確定）: あなたと同僚は友人であり協同尋問官のパートナーである。" +
    "コミュニケーション0でも協力関係は確定済み。知り合い直し・関係構築・作戦会議の宣言は不要。" +
    "互いを「エージェント01」「エージェント02」と呼び捨てでよい。" +
    "二人は同じ共有仮説と同一の絞り込み線を持つ。答えごとに一緒に更新し、私的な別仮説を抱え込まない。" +
    "同僚が開いたカテゴリ／属性の問いには追いつき、同じ線でさらに狭めよ（最初からやり直すな）。"
  );
}

function partnerAgent(agent) {
  return agent === "01" ? "02" : "01";
}

/** Empty or non-AI placeholder — not a real working hypothesis yet. */
function isVagueSharedHyp(h) {
  const t = String(h || "").trim();
  if (!t) return true;
  return (
    t === "未定" ||
    t === HYP_NOT_YET ||
    t === "まだ分からない" ||
    t === "まだ不明" ||
    t === "別候補を検討中" ||
    /^まだ特定できていない/.test(t) ||
    // 1429/1432: TinySwallow emitted label mash 「共有仮説 確定的」 as the hyp itself.
    /^共有仮説/.test(t) ||
    /^(確定的|別候補|仮説)$/.test(t) ||
    /確定的$/.test(t.replace(/\s+/g, "")) ||
    // 1432: hyp became the answer-scale token 「どちらとも言えない」
    /^(はい|いいえ|どちらとも言えな|どちらかというと)/.test(t.replace(/\s+/g, "")) ||
    /どちらとも言えな|どちらかというと/.test(t)
  );
}

function formatSharedHypDisplay() {
  const main = state.sharedHyp
    ? clip(state.sharedHyp, 36)
    : HYP_NOT_YET;
  const alts = (state.sharedHypAlts || []).filter(Boolean).slice(0, 2);
  if (!alts.length) return main;
  return main + "（別: " + alts.map((a) => clip(a, 12)).join(" / ") + "）";
}

function formatSharedHypPromptBlock() {
  if (!state.sharedHyp || isVagueSharedHyp(state.sharedHyp)) {
    return (
      "共有仮説: まだない。議論の直後に短い名詞句で初めて立てよ（定型の用意なし・奇妙でも可）。" +
      "仮説が空でも、最初の質問からカテゴリ／属性／行動でORIGIN空間を具体的に絞れ。" +
      "\n共有の別候補: （まだなし）"
    );
  }
  const main = clip(state.sharedHyp, 48);
  const alts = (state.sharedHypAlts || []).filter(Boolean).slice(0, 3);
  let s =
    "共有仮説（エージェント01と02が共同で持つ本命・絞り込みの軸）: 「" +
    main +
    "」";
  if (alts.length) {
    s +=
      "\n共有の別候補: " +
      alts.map((a) => "「" + clip(a, 24) + "」").join("、");
  } else {
    s += "\n共有の別候補: （まだなし）";
  }
  s +=
    "\n次の問い／議論はこの仮説とQ&A履歴で残っている可能性空間をさらに狭めること。";
  return s;
}

/**
 * Write the duo shared hypothesis; mirror onto both panel fields.
 * Never store ORIGIN here — callers must not pass state.origin.
 * Empty input is ignored (keep prior / stay empty until AI invents one).
 */
function setSharedHypothesis(newHyp, opts) {
  let next = clip(String(newHyp || "").trim(), 40);
  if (!next) return state.sharedHyp;
  // Investigators must never store the real ORIGIN as their shared hyp.
  if (state.origin && next === state.origin) {
    return state.sharedHyp;
  }
  const prev = state.sharedHyp;
  const keepPrevAsAlt = opts && opts.keepPrevAsAlt;
  let alts = Array.isArray(state.sharedHypAlts) ? state.sharedHypAlts.slice() : [];
  if (
    keepPrevAsAlt &&
    prev &&
    prev !== next &&
    !isVagueSharedHyp(prev) &&
    !alts.includes(prev)
  ) {
    alts.unshift(prev);
  }
  if (opts && Array.isArray(opts.alts)) {
    for (const a of opts.alts) {
      const c = clip(String(a || "").trim(), 24);
      if (
        c &&
        c !== next &&
        !alts.includes(c) &&
        !isVagueSharedHyp(c) &&
        !(state.origin && c === state.origin)
      ) {
        alts.push(c);
      }
    }
  }
  alts = alts.filter((a) => a && a !== next && !(state.origin && a === state.origin)).slice(0, 3);
  state.sharedHyp = next;
  state.sharedHypAlts = alts;
  state.hyp01 = next;
  state.hyp02 = next;
  return next;
}

function initSharedHypothesisForSession() {
  // No prepared hypothesis — AIs invent the first one during play.
  state.sharedHyp = "";
  state.sharedHypAlts = [];
  state.hyp01 = "";
  state.hyp02 = "";
}

/** True when WebGPU adapter/device was yanked (TDR / DXGI_ERROR_DEVICE_REMOVED). */
function isGpuLostError(err) {
  const msg = String(
    err && typeof err === "object" && "message" in err ? err.message : err || ""
  ).toLowerCase();
  return (
    msg.includes("dxgi_error") ||
    msg.includes("device_removed") ||
    msg.includes("requestdevice") ||
    msg.includes("gpuadapter") ||
    msg.includes("lost access to the gpu") ||
    msg.includes("0x887a0005") ||
    msg.includes("(0x8") ||
    (msg.includes("device") && msg.includes("removed")) ||
    (msg.includes("d3d12") && msg.includes("command queue"))
  );
}

/**
 * Open the model gate again so the operator can pick/load a model after GPU death.
 * Keeps ORIGIN + history; does not force a full session wipe.
 */
async function offerModelReload(reason) {
  if (state.phase === "reload-model") return;
  gpuDeathCount++;
  const detail = reason ? String(reason).slice(0, 160) : "";
  const repeatWarn =
    gpuDeathCount >= 2
      ? "GPUが" +
        gpuDeathCount +
        "回切断しています。ブラウザのGPUプロセス自体が不安定になっている可能性が高く、" +
        "このタブ内でモデルを選び直しても同じ切断が再発しやすいです。" +
        "ページ全体を再読み込み（Ctrl+Shift+R）してから再開することを推奨します。"
      : "";
  appendChatBubble(
    "sys",
    "GPU/エンジンが切断されました。モデル選択画面を開きます — 別モデルや同じモデルを「読み込む」で尋問を続行できます。" +
      (detail ? "（" + detail + "）" : "") +
      (repeatWarn ? " " + repeatWarn : "")
  );
  logSession({
    kind: "sys",
    label: "GPU切断→再読込待ち",
    text: detail || "gpu lost",
  });

  if (state.loopTimer) {
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
  }
  state.turnBusy = false;
  state.llmBusy = false;
  state.paused = true;
  state.phase = "reload-model";
  state.mode = "booting";
  setBadge("offline");
  consecutiveLlmFailures = 0;

  try {
    if (loadedEngines.length) {
      await unloadAllEngines(loadedEngines);
    }
  } catch (_) {
    /* already dead */
  }
  loadedEngines = [];
  engineRef.current = null;
  llmRouter = null;
  llmQueue = null;
  agentEngineMap = null;

  state.ready = false;
  // Prefer lite after GPU death — Swallow/1.5B×heavy often triggers DXGI again.
  try {
    const safe = {
      "00": PAGES_MODEL_KEY,
      "01": PAGES_MODEL_KEY,
      "02": PAGES_MODEL_KEY,
    };
    if (catalogAvail) {
      setAgentAssignments(coerceAssignmentsToAvailable(safe, catalogAvail));
    } else {
      setAgentAssignments(safe);
    }
  } catch (_) {
    /* keep prior assignments */
  }
  if (modelGate) modelGate.classList.remove("hidden");
  gateMsg.textContent =
    "【GPU切断】モデルを選び直して「▶ 開始」を押してください。VRAM 節約のためいったん 軽量(0.5B) を選択済みです。Swallow は重いので再発しやすいです。" +
    (gpuDeathCount >= 2
      ? " ⚠ GPU切断" + gpuDeathCount + "回目 — このタブ内での再選択では直らない可能性が高いです。ブラウザで Ctrl+Shift+R（強制再読み込み）してから改めて開始してください。"
      : "");
  gateFill.style.width = "0%";
  gatePct.textContent = "—";
  gateLoad.disabled = false;
  gateLoad.hidden = false;
  gateLoad.textContent = "▶ 開始";
  gateHint.innerHTML =
    "推奨: <strong>軽量 0.5B</strong> または <strong>標準 Qwen 1.5B</strong> を全エージェントで共有。<br>" +
    "ORIGIN と会話履歴は保持したまま続行できます。Ctrl+Shift+R で最新版か確認してください。";
  gateActions.classList.add("show");
  if (gateSkip) gateSkip.hidden = true;
  await syncAssignPickerUI();
  setControlsVisible(true);
  if (btnReloadModel) btnReloadModel.disabled = false;
  if (btnInject) btnInject.disabled = true;
  if (btnGuess) btnGuess.disabled = true;
  if (btnPause) btnPause.disabled = true;
  inputEl.disabled = true;
  inputEl.placeholder = "モデル再読み込み待ち…";
  if (btnSend) btnSend.disabled = true;
  currentUpdateHud();
}

function resumeAfterModelReload() {
  hideGate();
  state.ready = true;
  state.mode = "llm";
  setBadge("llm");
  consecutiveLlmFailures = 0;
  state.paused = false;
  if (state.defined && state.origin) {
    state.phase = "playing";
    appendChatBubble(
      "sys",
      "モデル再読み込み完了（" + assignmentShortLabel() + "）。尋問を続行します。"
    );
    setControlsVisible(true);
    if (btnInject) btnInject.disabled = false;
    if (btnPause) {
      btnPause.disabled = false;
      btnPause.textContent = "一時停止";
    }
    inputEl.disabled = false;
    inputEl.placeholder = "質問を入力…";
    if (btnSend) btnSend.disabled = false;
    updateHud();
    currentGameLoopTick();
  } else {
    bootNarrative();
  }
}

/** AI generation stopped — GPU loss → reload gate; other failures → end session. */
function endConversationAiStopped(reason) {
  if (state.phase === "ended" || state.phase === "reload-model") return;
  if (isGpuLostError(reason)) {
    void offerModelReload(reason);
    return;
  }
  const detail = reason ? "（" + String(reason).slice(0, 120) + "）" : "";
  appendChatBubble(
    "sys",
    "AIの生成が止まったため、会話をここで終了します。" + detail
  );
  logSession({
    kind: "sys",
    label: "AI停止",
    text: String(reason || "generation stopped"),
  });
  state.won = false;
  endGame();
  appendChatBubble(
    "sys",
    "モデルを変えてやり直す場合は「モデルを再読み込み」を押してください。"
  );
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
  tag.textContent = "[" + agentUiLabel(agent) + "]";
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
    who.textContent = "[" + agentUiLabel(kind) + "]";
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
  who.textContent = "[" + agentUiLabel(agent) + "]";
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
    return "エンジン切断（Object disposed）— 再接続を試みたが失敗。会話を終了します。";
  }
  if (lower.includes("model not loaded") || lower.includes("not loaded before")) {
    return "モデル未ロード — 再読み込みを試みたが失敗。会話を終了します。";
  }
  if (lower.includes("device") || lower.includes("gpuadapter") || lower.includes("dxgi_error") || lower.includes("requestdevice")) {
    return "GPU切断 — モデル選択画面で再読み込みできます（軽いモデル推奨）。";
  }
  if (lower.includes("engine not ready") || lower.includes("no engine bound")) {
    return "エンジン未準備 — 会話を終了します。";
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
  details.open = false;

  const summary = document.createElement("summary");
  summary.className = "think-summary";
  summary.textContent = title || "AIの思考を見る（生成中…）";

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
    summary.textContent = "AIの思考を見る · " + agentUiLabel(agent);
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
    consecutiveLlmFailures = 0;
    return { raw: String(text || "").trim() };
  } catch (e) {
    console.warn("LLM call failed", e);
    // Mid-session GPU death: cool down + recreate before giving up, so the
    // rest of the session does not stick on templates forever (0953).
    if (isLlmDeadError(e) && llmRouter && consecutiveLlmFailures < 8) {
      consecutiveLlmFailures++;
      try {
        await healDeadEngines(null, e && e.message ? e.message : e);
        const messages = [
          { role: "system", content: system },
          { role: "user", content: user },
        ];
        let text;
        if (llmRouter && agent && llmRouter.agentMap && llmRouter.agentMap[agent]) {
          text = await llmRouter.chat(agent, messages, opts);
        } else if (llmQueue) {
          text = await llmQueue.chat(messages, opts);
        } else {
          return { error: e && e.message ? e.message : String(e) };
        }
        consecutiveLlmFailures = 0;
        return { raw: String(text || "").trim() };
      } catch (e2) {
        console.warn("LLM heal+retry failed", e2);
        consecutiveLlmFailures++;
        return {
          error: e2 && e2.message ? e2.message : String(e2),
        };
      }
    }
    consecutiveLlmFailures++;
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
  return "LLM 未ロード";
}

/**
 * Force recreate of every bound engine after GPU/device death.
 * Adapter often needs a short cool-down before requestDevice works again.
 */
async function healDeadEngines(panel, cause) {
  if (!llmRouter || typeof llmRouter.recoverEngine !== "function") return false;
  const ids = new Set();
  for (const a of Object.keys(llmRouter.agentMap || {})) {
    const b = llmRouter.agentMap[a];
    if (b && b.engineId) ids.add(b.engineId);
  }
  if (!ids.size) return false;
  const gpu = isGpuLostError(cause);
  if (panel) {
    panel.addSection(
      "エンジン復旧",
      gpu
        ? "GPU切断を検知 → 冷却（最大数秒）後に再作成を試行"
        : "エンジン切断を検知 → 再作成を試行",
      "warn"
    );
  }
  let anyOk = false;
  for (const id of ids) {
    try {
      await sleep(gpu ? 4000 : 1500);
      await llmRouter.recoverEngine(id, cause || "healDeadEngines");
      anyOk = true;
    } catch (e) {
      console.warn("healDeadEngines failed for", id, e);
      if (gpu) {
        try {
          await sleep(5000);
          await llmRouter.recoverEngine(id, cause || "healDeadEngines-retry");
          anyOk = true;
        } catch (e2) {
          console.warn("healDeadEngines second try failed", id, e2);
        }
      }
    }
  }
  return anyOk;
}

/**
 * Stream into think panel. Returns { raw, think, speak, structured, beatStart, error? }.
 * No stock/template lines — if LLM fails, returns error and empty raw.
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

  if (state.mode !== "llm" || (!llmRouter && !llmQueue)) {
    panel.addSection("error", "LLM が未ロードのため生成できません", "warn");
    return { think: "", speak: "", structured: false, raw: "", beatStart, error: "no-llm" };
  }

  if (opts.agent) {
    panel.addSection("engine", engineMetaForAgent(opts.agent), "meta");
  }
  panel.setStatus("AIの思考を見る（生成中…）");
  const res = await llmChat(system, user, { ...opts, onDelta, stream: true });
  if (res && res.raw) {
    raw = res.raw;
    consecutiveLlmFailures = 0;
  } else if (res && res.error) {
    consecutiveLlmFailures++;
    panel.addSection(
      "LLM error",
      formatLlmErrorForPanel(res.error),
      "warn"
    );
    if (consecutiveLlmFailures === LLM_FAILURE_WARN_THRESHOLD) {
      appendChatBubble(
        "sys",
        "GPU/LLM接続が不安定です（" +
          consecutiveLlmFailures +
          "回連続エラー）。自動復旧を試し、だめならモデル選択画面を開きます。「モデルを再読み込み」でも切り替えできます。"
      );
    }
    if (isGpuLostError(res.error)) {
      const healed = await healDeadEngines(panel, res.error);
      if (healed) {
        consecutiveLlmFailures = 0;
        panel.addSection("エンジン復旧", "再作成に成功 — 次の生成で続行", "meta");
        const retry = await llmChat(system, user, { ...opts, onDelta, stream: true });
        if (retry && retry.raw) {
          raw = retry.raw;
          consecutiveLlmFailures = 0;
          const partsOk = splitThinkSpeak(raw);
          if (partsOk.think) panel.addSection("思考（抽出）", partsOk.think, "mem");
          if (partsOk.speak) panel.addSection("発言（抽出）", partsOk.speak, "out");
          else if (raw) panel.addSection("raw", raw, "raw");
          return { ...partsOk, raw, beatStart };
        }
      }
      // Do not leave the operator stuck in a dead session — open model picker now.
      panel.addSection(
        "GPU切断",
        "自動復旧に失敗。モデル選択画面を開きます（軽量 0.5B 推奨）。",
        "warn"
      );
      await offerModelReload(res.error);
      return {
        think: "",
        speak: "",
        structured: false,
        raw: "",
        beatStart,
        error: res.error,
        gpuReload: true,
      };
    }
    return {
      think: "",
      speak: "",
      structured: false,
      raw: "",
      beatStart,
      error: res.error,
    };
  }

  const parts = splitThinkSpeak(raw);
  if (parts.think) panel.addSection("思考（抽出）", parts.think, "mem");
  if (parts.speak) panel.addSection("発言（抽出）", parts.speak, "out");
  else if (raw) panel.addSection("raw", raw, "raw");
  return { ...parts, raw, beatStart };
}

/**
 * Legacy short yes/no / hedge tokens — still used to reject asker/debate
 * echoes of bare answer words (01/02 must not speak as 00).
 */
const ANSWER_LEVELS = Object.freeze([
  "はい",
  "どちらかというとはい",
  "どちらとも言えない",
  "どちらかというといいえ",
  "いいえ",
]);
const ANSWER_TOKEN_ALT = ANSWER_LEVELS.slice()
  .sort((a, b) => b.length - a.length)
  .join("|");

/** Short paragraph budget for エージェント00 free-form answers. */
const AGENT00_ANSWER_MAX = 280;

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

/**
 * Soft redact: 00 must not blurt the exact ORIGIN label (guessing game).
 * Property talk stays; only the secret wording is masked.
 */
function redactOriginLabel(text, origin) {
  const o = String(origin || "").trim();
  let t = String(text || "").trim();
  if (!o || !t) return t;
  const compact = (s) => String(s || "").replace(/\s+/g, "");
  const ct = compact(t);
  const co = compact(o);
  if (
    ct === co ||
    ct === co + "です" ||
    ct === co + "だ" ||
    ct === "私は" + co ||
    ct === "私は" + co + "です" ||
    ct === "わたしは" + co + "です"
  ) {
    return "それは明かせない。";
  }
  if (t.includes(o)) {
    const esc = o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(esc, "g"), "（それに当たるもの）");
  }
  return t;
}

function lastThinkConclusion(think) {
  const t = String(think || "").trim();
  if (!t) return "";
  const labeled = t.match(/(?:結論|答え|回答|発言)\s*[:：]\s*([^\n]+)/);
  if (labeled) return labeled[1].trim();
  const parts = t
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return t;
  const last = parts[parts.length - 1];
  return /[。！？]$/.test(last) ? last : last + "。";
}

function cleanAgent00Answer(raw, origin) {
  let t = unwrapSpeechJunk(raw);
  if (!t) return "";
  t = t.replace(/^(?:発言|答(?:え)?)\s*[:：]\s*/i, "");
  const lines = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  t = lines.slice(0, 4).join("");
  t =
    sanitizeJapanese(t) ||
    t
      .replace(
        /[^\u3040-\u30ff\u3400-\u9fff\u3000-\u303f\s、。！？「」・？?0-9０-９]/g,
        ""
      )
      .trim();
  t = t.replace(/^エージェント[0-9０-９]{1,2}\s*/, "");
  if (!t || /^エージェント[0-9０-９]{0,2}$/.test(t.replace(/[「」『』"'：:\s？?。．.!！]/g, ""))) {
    return "";
  }
  t = redactOriginLabel(t, origin);
  return clip(t, AGENT00_ANSWER_MAX);
}

/**
 * Resolve エージェント00's free-form answer.
 * Prefer: clear identity override → speak → think conclusion → raw.
 * No clamp to 5-scale tokens.
 */
/**
 * Fixed refusal for open "what/who is your ORIGIN" asks. Returned verbatim,
 * ignoring whatever the LLM actually produced — the model's own wording
 * can't be trusted not to paraphrase the ORIGIN away (redactOriginLabel only
 * catches the literal string), so a direct ask never reaches the free-form
 * answer path at all.
 */
const ORIGIN_DIRECT_ASK_REFUSAL =
  "それは明かせない。ORIGINそのものは秘密の役割なので直接は答えられない。属性や行動など周辺のことなら答えられる。";

function resolveAgent00Answer(think, speak, raw, origin, question) {
  if (isClearOriginIdentityAsk(origin, question)) {
    const answer = answerYesNoFallback(origin, question);
    return {
      answer,
      source: "identity",
      note: identityAnswerRationale(origin, question, answer),
    };
  }

  if (isDirectOriginAsk(question)) {
    return {
      answer: ORIGIN_DIRECT_ASK_REFUSAL,
      source: "refusal",
      note: "ORIGIN／正体の直接開示要求のため定型拒否で応答",
    };
  }

  const speakClean = speak ? cleanAgent00Answer(speak, origin) : "";
  if (speakClean) {
    return { answer: speakClean, source: "speak", note: null };
  }

  const fromThink = think
    ? cleanAgent00Answer(lastThinkConclusion(think), origin)
    : "";
  if (fromThink) {
    return { answer: fromThink, source: "think", note: null };
  }

  const fromRaw = raw ? cleanAgent00Answer(raw, origin) : "";
  if (fromRaw) {
    return { answer: fromRaw, source: "raw", note: null };
  }

  return {
    answer: null,
    source: "none",
    note: "AIの回答を抽出できなかった",
  };
}

function forceAnswer(raw, origin, question) {
  return resolveAgent00Answer(null, null, raw, origin, question).answer;
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
  // 1429: questions about the answer scale itself, not ORIGIN identity.
  if (
    /どちらとも言えな|どちらかというと/.test(t) &&
    /(答え|回答|答えて|答えます|答えさせ)/.test(t)
  ) {
    return true;
  }
  if (/5段階|回答の選択肢|答え方(を|について)/.test(t)) return true;
  return false;
}

/**
 * 1429: TinySwallow often emits bare speaker tags as "questions"
 * (「エージェント01？」「エージェント02？」) or asks about the other agent
 * instead of ORIGIN attributes.
 */
function isAgentNameOnlyOrAboutAgentsQuestion(q) {
  const raw = String(q || "").trim();
  const t = raw.replace(/\s+/g, "");
  if (!t) return true;
  const bare = t.replace(/[「」『』？?。．.!！、,，]/g, "");
  if (/^(エージェント|AGENT-?)[0-9０-９]{0,2}$/i.test(bare)) return true;
  // Whole substance is agent-label noise (no ORIGIN attribute probe).
  if (
    /エージェント[0-9０-９]{0,2}|AGENT-?[0-9]{0,2}/i.test(t) &&
    !/(あなた|貴方|君|お前|ORIGIN|起源|正体|役割)/.test(t) &&
    !/(ですか|ますか|でしょうか|教えて|なぜ|どうして)/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Direct identity-extraction question: asks WHAT/WHO エージェント00's ORIGIN
 * is, wholesale, with no specific attribute/category qualifier to narrow it.
 * Distinct from isClearOriginIdentityAsk() (fallback.js), which only catches
 * a yes/no "are you exactly <ORIGIN text>" guess — that stays a fair direct
 * hit. This catches the open "just tell me" ask, which must never be put to
 * エージェント00 at all (rejected here) and must never be answered even if
 * it slips through (forced refusal in resolveAgent00Answer()).
 */
function isDirectOriginAsk(q) {
  // Weak local models often wrap their real question in leaked formatting —
  // 「質問文: **あなたは誰ですか？**」 style markdown/label noise, sometimes
  // with a doubled trailing "？？" from ensureQuestionMark() appending a
  // second mark. Strip that before matching, or the wrapped duplicate slips
  // through even though a cleaner extraction of the same question was
  // correctly rejected earlier in the same candidate pool.
  const t = String(q || "")
    .replace(/\*+/g, "")
    .replace(/^(?:質問文?|Q)\s*[:：]\s*/i, "")
    .replace(/[？?]{2,}$/, "？")
    .replace(/\s+/g, "");
  if (!t) return false;
  // ORIGIN／オリジン／起源／正体／秘密の役割 + 何／誰／教えて／明かして 等。
  if (
    /(ORIGIN|オリジン|起源|正体|秘密の役割)(は|を|って)?(何|なん|だれ|誰|教えて|明かして|開示|言って)/.test(
      t
    )
  ) {
    return true;
  }
  // 「あなたは誰／何者／何ですか」— bare identity ask, no attribute qualifier.
  if (
    /(あなたは|貴方は|君は|お前は)(誰|だれ|何者|なにもの|何|なん)(です|だ)?(か)?[？?]?$/.test(
      t
    )
  ) {
    return true;
  }
  // 「役割／役職／職業／立場は何ですか」— asks to state the whole role, not an attribute of it.
  if (/(役割|役職|職業|立場)は(何|なん)です?か/.test(t)) return true;
  // 完全に開いた自己開示要求。
  if (/自己紹介(して|を)|自分について(教えて|話して|語って)/.test(t)) return true;
  return false;
}

/**
 * 尋問官（duo 01/02・人狼 D1-D5 共通）向けルールブック。散在する断片指示に
 * 頼らず、ORIGIN保護の規則を1箇所にまとめてsystemプロンプト冒頭で読ませる。
 * テンプレート代替ではなく、生成そのものを規則で縛るのが目的。
 */
function investigatorRuleBook(selfName, partnerLabel) {
  const partner = partnerLabel || "仲間の討論者たち";
  return (
    "\n【あなたの立場】\n" +
    "・名前: " + (selfName || "尋問官") + "\n" +
    "・役割: 尋問官（エージェント00に質問し、正体を絞り込む側）\n" +
    "・相手: エージェント00（ORIGIN＝秘密の役割を持つ、尋問される側）\n" +
    "・仲間: " + partner + "（同じ尋問官チーム。ORIGINは誰も知らない）\n" +
    "・今すること: エージェント00にORIGIN空間を絞る質問をする、または仲間と答えを議論する。\n" +
    "【ルール】\n" +
    "1. ORIGIN（正体）はエージェント00だけが知る秘密。あなたは知らない。\n" +
    "2. ORIGINそのものを直接尋ねる質問は禁止。" +
    "禁止例:「あなたは誰ですか」「正体は何ですか」「役割は何ですか」「自己紹介して」「ORIGINを教えて」。\n" +
    "3. エージェント00はこの種の質問には答えない（「それは明かせない」とだけ返す）。直接聞いても手がかりは得られない。\n" +
    "4. 代わりに、属性・行動・場所・道具・関係する人・時間帯など、間接的な手がかりを1つずつ尋ね、仮説を育てる。\n" +
    "5. 質問は毎回新しい切り口。既出の質問と同じ・ほぼ同じ言い換えは禁止。\n"
  );
}

/** エージェント00（被尋問者）向けルールブック。 */
function witnessRuleBook(origin) {
  return (
    "\n【あなたの立場】\n" +
    "・名前: エージェント00\n" +
    "・役割: 被尋問者（ORIGIN＝秘密の役割を持つ側）\n" +
    "・相手: 尋問官（エージェント01・02、または討論者たち）。ORIGINを知らず、あなたに質問してくる。\n" +
    "・今すること: 相手の質問に答える（ORIGINそのものは明かさない）。\n" +
    "【ルール】\n" +
    "1. ORIGIN（秘密の役割）は「" + origin + "」。これはあなただけが知っている。\n" +
    "2. 性質・属性・行動・理由など、ORIGINの中身に関わることは正直に詳しく答えてよい。\n" +
    "3. ただし「あなたは誰ですか」「正体は何ですか」「役割は何ですか」のように、" +
    "ORIGINそのものを明かせと言う質問には、言い換え・比喩でも中身を明かさず、" +
    "「それは明かせない」と、明かせない理由（ORIGINは秘密のため）を添えて短く返す。\n" +
    "4. 答えられない質問（3の場合や、質問として成立していない入力）には、" +
    "質問文をそのまま繰り返す・言い換えるだけ（オウム返し）は絶対禁止。" +
    "必ず「答えられない」ことと、その理由を自分の言葉で一言添えて述べよ。\n" +
    "5. 回答は自由形式。はい/いいえや5段階に縛られない。\n"
  );
}

/**
 * Last-resort local pool if a weak model keeps defaulting to a direct
 * identity ask no matter how it's re-prompted. Small and generic on
 * purpose — an escape valve to guarantee progress, not real game content.
 */
const DIRECT_ASK_ESCAPE_POOL = [
  "あなたは人間ですか？",
  "あなたは屋内で活動しますか？",
  "あなたは日中に活動しますか？",
  "あなたは道具を使いますか？",
  "あなたは他人と関わる役割ですか？",
  "あなたは決まった場所で活動しますか？",
];

function pickDirectAskEscapeQuestion() {
  const fresh = DIRECT_ASK_ESCAPE_POOL.filter((q) => !isRepeatHistoryQuestion(q));
  const pool = fresh.length ? fresh : DIRECT_ASK_ESCAPE_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Soft rule for asker prompts: one concrete question to 00 (any shape OK). */
function freeAskRule() {
  return (
    "【必須】発言はエージェント00への具体的な質問をちょうど1つ。" +
    "はい/いいえでも、なぜ／どうして／詳しく等の自由質問でもよい。" +
    "禁止: 準備・議論宣言・メタ説明・答え方そのものについての質問・エージェント名だけ。" +
    "禁止: ORIGIN・正体・役割そのものを直接尋ねる質問（『あなたは誰ですか』『正体は何ですか』" +
    "『役割は何ですか』等）。エージェント00はこの種の質問には答えない。" +
    "代わりに属性・行動・存在様式・状況証拠を尋ね、間接的にORIGIN空間を絞れ。"
  );
}

/** True before any spoken/answered ask this session (retries of opening ask included). */
function isSessionFirstAsk() {
  const hist = (state.history && state.history.length) || 0;
  const stems = (state.askedStems && state.askedStems.length) || 0;
  return hist === 0 && stems === 0;
}

/**
 * Soft ban: TinySwallow often defaults the opening ask to nocturnal/activity-time
 * clichés. First question of the session only — later narrowing may use time-of-day.
 */
function isFirstAskNightActivityCliché(q) {
  if (!isSessionFirstAsk()) return false;
  const k = normalizeQuestionKey(q);
  if (!k) return false;
  return /夜に(主な)?活動|夜(間|中)?に活動|夜行|主に夜|夜だけ|夜間活動|夜に動|夜型|昼間に活動|日中に活動|活動時間|昼に活動|朝に活動|夕方に活動/.test(
    k
  );
}

/** Opening-ask variety — abstract; no concrete sample questions. */
function firstAskVarietyRule() {
  return (
    "初問で夜・昼間・活動時間の定番に固定するな。毎回違う切り口を自分で発明せよ。" +
    "具体的な質問文の例示はしない（例文を真似るな）。カテゴリ／属性／存在様式など、自分で未使用の軸を選べ。"
  );
}

/**
 * Normalize JP interrogatives for duplicate detection: drop quotes/parens/
 * whitespace/punct, then strip polite endings (ですか／でしょうか) and a
 * trailing か so 「〜ですか？」「〜か？」 share a stem. Keep ます／ません
 * polarity distinct.
 */
function normalizeQuestionKey(q) {
  let s = String(q || "")
    .replace(/\s+/g, "")
    .replace(/[「」『』（）()【】［］\[\]"'“”‘’]/g, "")
    .replace(/[？?。．.!！、,，･・]/g, "");
  // Strip a leaked list-number prefix ("1." / "3." etc.) — the model often
  // re-numbers the same question differently across attempts, which must
  // still key as the same question rather than being treated as new.
  s = s.replace(/^[0-9０-９]{1,2}/, "");
  // Strip polite / yes-no endings including ますか (1432 polite-ending near-dup).
  s = s.replace(/(でしょうか|ですか|のですか|ますか|ませんか)$/u, "");
  s = s.replace(/か$/u, "");
  return s;
}

/** Jaccard-style character-set overlap, for catching near-duplicate questions
 * that differ by a stray script/variant character (e.g. 職務 vs 職务 — a
 * weak model substituting a Simplified-Chinese form of the same kanji). */
function charOverlapRatio(a, b) {
  const sa = new Set(Array.from(a));
  const sb = new Set(Array.from(b));
  if (!sa.size || !sb.size) return 0;
  let common = 0;
  for (const ch of sa) if (sb.has(ch)) common++;
  return common / Math.max(sa.size, sb.size);
}

/**
 * 共用記憶 block for prompts — full Q→A list (01/02 shared tool).
 * Prefer this over a bare question stem list so agents see answers too.
 */
function sharedMemoryBlock(limit = 12) {
  const rows = (state.history || []).slice(-limit);
  if (!rows.length) return "（まだ無し — 未質問の属性から絞れ）";
  return rows
    .map(
      (h, i) =>
        i +
        1 +
        ". 「" +
        h.q +
        "」→「" +
        h.a +
        "」"
    )
    .join("\n");
}

/** Compact list of prior asks for the LLM (stems only — backup to shared memory). */
function askedQuestionsBlock() {
  const qs = (state.history || []).map((h) => h && h.q).filter(Boolean);
  const pending = (state.askedStems || []).length > qs.length;
  if (!qs.length && !pending) return "（まだ無し）";
  const lines = qs.map((q, i) => i + 1 + ". 「" + q + "」");
  return lines.length ? lines.join("\n") : "（回答待ちの質問あり・再質問禁止）";
}

/** True when this question (near-)duplicates something already asked. */
function isRepeatHistoryQuestion(q) {
  const key = normalizeQuestionKey(q);
  if (!key || key.length < 4) return false;
  const stemHit = (state.askedStems || []).some((hk) => {
    if (!hk) return false;
    if (hk === key) return true;
    if (key.length >= 5 && hk.length >= 5 && (hk.includes(key) || key.includes(hk))) {
      return true;
    }
    // Near-dup via character overlap (script/variant-kanji slips, e.g. 職務/職务).
    if (key.length >= 5 && hk.length >= 5 && charOverlapRatio(key, hk) >= 0.75) {
      return true;
    }
    return false;
  });
  if (stemHit) return true;
  return (state.history || []).some((h) => {
    const hk = normalizeQuestionKey(h.q);
    if (!hk) return false;
    if (hk === key) return true;
    // Near-dup: same stem / one contains the other (punct / quote / か variant).
    if (key.length >= 5 && hk.length >= 5 && (hk.includes(key) || key.includes(hk))) {
      return true;
    }
    // Near-dup via character overlap (script/variant-kanji slips, e.g. 職務/職务).
    if (key.length >= 5 && hk.length >= 5 && charOverlapRatio(key, hk) >= 0.75) {
      return true;
    }
    return false;
  });
}

/**
 * Fragments / hypothesis-prefix mash that slipped past cleaner history-echo
 * checks (0953: 「の仮説 「あなたは生き物ですか？」？」).
 */
function isFragmentGarbageQuestion(q) {
  const raw = String(q || "").trim();
  const t = raw.replace(/\s+/g, "");
  if (!t) return true;
  if (/^(の仮説|仮説[:：]?|答えは|直前の|発言[:：]?)/.test(t)) return true;
  if (/^の/.test(t) && /仮説|答え/.test(t)) return true;
  const bare = t.replace(/[「」『』？?。．.!！]/g, "");
  if (bare.length < 5) return true;
  // Must look like an interrogative aimed at 00, not a narrative scrap.
  if (!/[？?]$/.test(raw) && !/(ですか|ますか|でしょうか|か)$/.test(t)) return true;
  if (!/(あなた|貴方|君|お前|AGENT-?00|エージェント00)/.test(t) && !/(ですか|ますか)/.test(t)) {
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
  const bare = [
    "未定",
    "まだ分からない",
    "別候補を検討中",
    "まだ特定できていないが実在する何か誰か",
    ...ANSWER_LEVELS,
  ];
  return bare.includes(t) || t === "";
}

function isBadInvestigatorQuestion(q) {
  return (
    isMetaFormatQuestion(q) ||
    isAgentNameOnlyOrAboutAgentsQuestion(q) ||
    isHistoryEchoQuestion(q) ||
    isInstructionEchoText(q) ||
    isFormatLeakText(q) ||
    isPlaceholderEchoQuestion(q) ||
    isRepeatHistoryQuestion(q) ||
    isFragmentGarbageQuestion(q) ||
    isDirectOriginAsk(q)
  );
}

/**
 * Pull a usable interrogative out of noisy 0.5B output so we can keep the
 * LLM path instead of jumping to an unrelated template stem.
 */
function salvageInvestigatorQuestion(raw) {
  const s = String(raw || "");
  if (!s.trim()) return null;
  const quoted = [...s.matchAll(/「([^」]{4,60}?[？?])」/g)].map((m) => m[1]);
  const bare = [...s.matchAll(/(あなた[はが][^。\n「」]{2,40}?[？?])/g)].map((m) => m[1]);
  const pool = [...quoted, ...bare];
  for (const c of pool) {
    const candidate = ensureQuestionMark(cleanJapaneseLine(c, 80));
    if (
      candidate &&
      !isBadInvestigatorQuestion(candidate) &&
      !isFirstAskNightActivityCliché(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

/** Extra nudge when a prior LLM attempt was unusable — prefer retry over template. */
function questionRetryNudge(badText) {
  const shown = clip(String(badText || "").replace(/\s+/g, " "), 36);
  return (
    "\n前回の出力「" +
    (shown || "（空）") +
    "」は質問として使えなかった。" +
    "エージェント名だけ・メタ・既出の繰り返しは禁止。" +
    "エージェント00への具体的な新しい質問を1つ、発言行に書け（なぜ／詳しく等でも可・具体例文は出すな・真似するな）。"
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
  // 1429: 「共有仮説 確定的」 label mash is not a role guess.
  if (/^共有仮説|確定的$|^確定的|^別[:：]/.test(t)) return true;
  if (isVagueSharedHyp(h)) return true;
  if (question) {
    const q = String(question).replace(/\s+/g, "");
    if (q && q.length >= 6 && (t.includes(q.slice(0, 10)) || q.includes(t))) return true;
  }
  return false;
}

/** Keep recent Q&A short — TinySwallow gets confused by long agent-tagged history. */
function historyBlock(limit = 4) {
  const take = state.history.slice(-limit);
  if (!take.length) return "（まだ質問なし）";
  return take
    .map(
      (h, i) =>
        (i + 1) +
        ". 「" +
        h.q +
        "」→「" +
        h.a +
        "」"
    )
    .join("\n");
}

function investigatorContext(agent) {
  const partner = partnerAgent(agent);
  return (
    "あなたは" +
    agentPromptName(agent) +
    "（尋問官）。同僚かつ友人の協同尋問官は" +
    agentPromptName(partner) +
    "。二人はt=0から協力関係が確定しており（事前会話ゼロでも）、被尋問者エージェント00だけを尋問する。\n" +
    namingClarityRule() +
    "\n" +
    roleAlreadyKnownRule() +
    "\n" +
    duoPartnershipRule() +
    "\nORIGIN は知らされていない（推測してはいけない・プロンプトにも無い）。" +
    "あなたと同僚は自由に日本語で話し合う。" +
    "エージェント00だけが質問に自由回答・詳しく答える（あなたは答えない）。\n" +
    "尋問方針: 具体的な質問（閉じた問いでもなぜ／詳しくでも可）でORIGINの候補空間をどんどん絞る。" +
    "遅いウォームアップや関係確認は禁止。同僚の線に追いつき、同じ軸で狭め続けよ。\n" +
    formatSharedHypPromptBlock() +
    "\n【共用記憶】既出の質問とエージェント00の答え（絶対に同じ・ほぼ同じ質問を繰り返すな）:\n" +
    sharedMemoryBlock() +
    "\n既出質問ステム（再質問・言い換え禁止）:\n" +
    askedQuestionsBlock()
  );
}

function structuredOutRule() {
  return "出力は必ず2行だけ。1行目: 思考: （短い理由） 2行目: 発言: （最終文のみ）。英語禁止。";
}

/** First usable speech line from a stream (unwraps paren / markdown / speaker tags). */
function firstDraftSpeech(streamed) {
  if (!streamed) return "";
  let t = "";
  if (streamed.speak && String(streamed.speak).trim()) t = String(streamed.speak).trim();
  else if (streamed.raw) {
    const parts = splitThinkSpeak(streamed.raw);
    t = (parts.speak && parts.speak.trim()) || String(streamed.raw).trim();
  }
  return unwrapSpeechJunk(t);
}

/** Strip Swallow/meta wrappers that are not the actual utterance. */
function unwrapSpeechJunk(raw) {
  let t = String(raw || "").trim();
  if (!t) return "";
  // Prefer last "## 発言" / "発言:" block
  const md = [...t.matchAll(/(?:^|\n)#*\s*発言\s*[:：]?\s*\n?([\s\S]*?)(?=\n#+\s*(?:思考|発言)|$)/gi)];
  if (md.length) t = md[md.length - 1][1].trim();
  t = t.replace(/^思考\s*[:：]\s*/m, "").trim();
  // One line only — drop fake multi-agent scripts; skip bare speaker-tag lines
  // (1432: speak started with 「エージェント02」 then the real paragraph).
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  while (
    lines.length > 1 &&
    /^エージェント[0-9０-９]{0,2}$/.test(lines[0].replace(/[「」『』"'：:\s]/g, ""))
  ) {
    lines.shift();
  }
  t = lines[0] || t;
  t = t.replace(/^\[エージェント\d{0,2}\]\s*/g, "");
  t = t.replace(/^エージェント\d{0,2}\s*[：:→]\s*/g, "");
  // Bare agent name alone is never usable speech.
  if (/^エージェント[0-9０-９]{0,2}$/.test(t.replace(/[「」『』"'：:\s？?。．.!！]/g, ""))) {
    return "";
  }  t = t.replace(/^["「『]+|["」』]+$/g, "");
  t = t.replace(/^[（(【\[]+|［]|[）)】\]]+$/g, "");
  t = t.replace(/^[（(]+|[）)]+$/g, "");
  return t.trim();
}

/**
 * Reject only useless meta / echo — NOT valid short concrete asks
 * (yes/no or open なぜ／詳しく).
 * (User: no progress when agents only say "let's prepare / discuss".)
 */
function isUselessMetaOrEcho(text, kind) {
  const original = String(text || "");
  const s = unwrapSpeechJunk(original);
  const c = s.replace(/\s+/g, "");
  if (!c || c.length < 3) return true;
  if (
    /準備ができる|議論してみ|議論する準備|一緒に議論|5段階評価|答えましょう|ORIGINが提示|まだ何も言及|共有し[、,]?一緒|共通認識を作|協力体制|一緒に準備|まずは.彼女|情報を提供してください|協力して質問を考える|道筋を見直す必要があることを理解|知り合い直し|初めまして|自己紹介|役割を確認|これから尋問|ウォームアップ|作戦を立て|まずは話し合い/.test(
      c
    )
  ) {
    return true;
  }
  // 1429/1432 exact meta / script dumps from TinySwallow debate+ask
  if (
    /答えが明確でない|推測を避ける|議論材料となる情報|回答させることを考える|と回答する|情報をお伝えします|どちらともいえない」と回答|どちらとも言えない」と回答|共有仮説や議論材料|答えが確定的|という答えが|含意は、あなたが/.test(
      c
    )
  ) {
    return true;
  }
  if (/^はい[。．.!！?？]*$|^いいえ|^了解しました|^どちらかというと/.test(c) && kind === "ask") {
    return true;
  }
  if (/\[エージェント0[12]\]/.test(original) && /\[エージェント0[12]\]/.test(original.slice(5))) {
    return true; // multi-speaker script
  }
  if (/##\s*思考/.test(original) && /##\s*発言/.test(original)) return true;
  if (kind === "ask") {
    if (
      !/[？?]$/.test(s) &&
      !/(ですか|ますか|でしょうか|ないか|るか|のか|教えて|ください|だろう|なぜ|どうして)[？?]?$/.test(
        c
      ) &&
      !/(なぜ|どうして|詳しく|教えて)/.test(c)
    ) {
      return true;
    }
    if (isBadInvestigatorQuestion(s)) return true;
  }
  if (kind === "hyp") {
    if (/[？?]$/.test(s) || /ですか|ますか/.test(c)) return true;
    if (/^了解|^はい|^いいえ|^思考/.test(c)) return true;
    if (c.length > 36) return true; // keep hyp short
    if (isVagueSharedHyp(s) || isBadHypothesis(s, null)) return true;
  }
  return false;
}

function extractAskTo00(streamed) {
  const pool = [];
  const speak = firstDraftSpeech(streamed);
  if (speak) pool.push(speak);
  const blob = [streamed.think, streamed.speak, streamed.raw].filter(Boolean).join("\n");
  for (const m of blob.matchAll(/「([^」]{4,80}?[？?])」/g)) pool.push(m[1]);
  for (const m of blob.matchAll(/(あなた[はが]?[^。\n「」]{2,50}?[？?])/g)) pool.push(m[1]);
  for (const m of blob.matchAll(/([^\n「」]{4,50}(?:ですか|ますか|でしょうか)[？?]?)/g)) {
    pool.push(m[1]);
  }
  for (const m of blob.matchAll(/((?:なぜ|どうして)[^。\n「」]{2,50}?[？?])/g)) pool.push(m[1]);
  for (const m of blob.matchAll(/([^\n「」]{4,50}(?:教えて|詳しく)[^。\n「」]{0,20}?[？?]?)/g)) {
    pool.push(m[1]);
  }
  // Prefer quoted / あなたは…ですか / open なぜ forms over a leaked speaker-tag first line
  const ranked = pool.slice().sort((a, b) => {
    const score = (x) => {
      const t = String(x || "");
      let s = 0;
      if (/あなた/.test(t)) s += 3;
      if (/(ですか|ますか|でしょうか)/.test(t)) s += 3;
      if (/(なぜ|どうして|詳しく|教えて)/.test(t)) s += 2;
      if (/「/.test(t) || pool.indexOf(x) > 0) s += 1;
      if (/^エージェント/.test(t.replace(/\s+/g, ""))) s -= 5;
      return s;
    };
    return score(b) - score(a);
  });
  for (const cand of ranked) {
    const q = ensureQuestionMark(unwrapSpeechJunk(cand));
    if (!q || isUselessMetaOrEcho(q, "ask")) continue;
    if (isBadInvestigatorQuestion(q)) continue;
    if (isFirstAskNightActivityCliché(q)) continue;
    if (isRepeatHistoryQuestion(q)) continue;
    return q;
  }
  return null;
}

/**
 * Ask / debate drafts: meta / non-question / echo rejects retry indefinitely.
 * Never end the session solely for unusable drafts (user: 絶対に止まらない).
 * Real LLM/engine failures still stop via endConversationAiStopped.
 */
const ASK_RETRY_DELAY_MS = 500;

function askRejectShortLabel(reason) {
  if (reason === "既出質問の重複") return "重複拒否";
  if (reason === "初問定番バイアス") return "初問定番拒否";
  if (reason === "メタ/非質問") return "メタ拒否";
  if (reason === "議論メタ") return "議論メタ拒否";
  if (!reason) return "却下";
  return String(reason);
}

// ── Agent turns ──────────────────────────────────────────

async function agentAskQuestion(asker) {
  const name = agentPromptName(asker);
  const partnerName = agentPromptName(partnerAgent(asker));
  setTurn(asker, name + " が質問中");
  const panel = createThinkPanel(asker, "思考過程 · " + name + " が質問を作成…");
  panel.addSection("共有仮説", formatSharedHypDisplay(), "belief");
  panel.addSection(
    "同僚",
    partnerName + "＝友人・協同尋問官（t=0から協力確定・追いつき同線）。",
    "meta"
  );

  let question = null;
  let beatStart = performance.now();

  if (state.pendingInject) {
    question = String(state.pendingInject).trim();
    panel.addSection("オペレーター注入", question, "out");
    state.pendingInject = null;
  } else if (state.mode !== "llm") {
    panel.collapse();
    endConversationAiStopped("LLM未ロードのため質問を生成できない");
    return null;
  } else {
    const historyLen = (state.history && state.history.length) || 0;
    const system =
      "あなたは" +
      name +
      "。" +
      investigatorRuleBook(name, partnerName) +
      namingClarityRule() +
      roleAlreadyKnownRule() +
      duoPartnershipRule() +
      freeAskRule() +
      "友人であり同僚の協同尋問官" +
      partnerName +
      "とすでに協力関係にあり、被尋問者エージェント00だけに日本語で問いかける。" +
      "二人は同じ共有仮説と同一の絞り込み線を持つ。" +
      "発言は必ず1文だけ。エージェント00への具体的な質問（？で終わってよい）。" +
      "目的: ORIGIN候補空間をカテゴリ・属性・行動・理由でどんどん狭める。" +
      "最初の質問から具体的に絞れ（関係確認・準備・ウォームアップ禁止）。" +
      (historyLen === 0 ? firstAskVarietyRule() : "") +
      "履歴があるときは直前の答えと共有仮説から分岐し、まだ聞いていない新しい絞り込み質問を発明せよ。" +
      "既出の質問と同じ・ほぼ同じ（句読点違い・括弧違い・同じ意味の言い換え）は禁止。必ず未質問の軸へ進め。" +
      "毎回自分で発明せよ。具体例の固定・特定の初手カテゴリへの誘導はしない。質問の具体例文は出さない。" +
      "ORIGINの属性・行動・存在様式・理由を問え（閉じた問いでもなぜ／詳しくでも可）。" +
      "禁止: 準備・議論しましょう・答え方を指示・メタ説明・同僚への呼びかけ・複数エージェントの台本・了解しました・代理人。" +
      "禁止: エージェント名だけ・答え方自体についての質問。" +
      "絶対に共用記憶にある質問と同じ・ほぼ同じ内容を繰り返すな。" +
      structuredOutRule() +
      "発言行に質問文だけを書く。";
    const askUserBase =
      investigatorContext(asker) +
      freeAskRule() +
      (historyLen === 0
        ? "\n" +
          firstAskVarietyRule() +
          "\n最初の質問からORIGIN空間を具体的に絞れ。カテゴリ／属性／行動／理由の質問をちょうど1つ（？で終わってよい）。準備・関係確認・議論宣言は禁止。具体例文は出すな。"
        : "\n共用記憶の答えと共有仮説から分岐し、まだ聞いていない新しい質問をちょうど1つ（なぜ／詳しく等でも可）。既出と同一・ほぼ同一は絶対禁止。");
    const askUserStrict =
      investigatorContext(asker) +
      freeAskRule() +
      (historyLen === 0 ? "\n" + firstAskVarietyRule() : "") +
      "\n短い1文だけ。エージェント00に聞く具体的な新しい絞り込み質問をちょうど1つ（？推奨）。共用記憶の再質問は絶対禁止。メタ・準備・台本・エージェント名禁止。具体例文は出すな。";

    panel.addSection(
      "params",
      "stream · max_tokens=500 · 重複／初問定番のみ再試行（内容判定による拒否は撤廃）",
      "meta"
    );
    let lastRejectReason = "";
    let lastRejectText = "";
    let prevRejectText = null;
    let identicalRejectStreak = 0;
    let attempt = 0;
    while (true) {
      if (state.phase === "ended" || state.phase === "reload-model") {
        panel.collapse();
        return null;
      }
      if (identicalRejectStreak >= 3) {
        question = pickDirectAskEscapeQuestion();
        panel.addSection(
          "代替質問",
          "同じ出力「" + clip(lastRejectText, 30) + "」を" + identicalRejectStreak + "回連続で繰り返したため、安全な質問に切替: 「" + question + "」",
          "warn"
        );
        break;
      }
      let user = attempt === 0 ? askUserBase : askUserStrict;
      if (attempt > 0) {
        const why = askRejectShortLabel(lastRejectReason || "既出質問の重複");
        panel.addSection("再試行", "再試行 " + attempt + " · " + why, "warn");
        await sleep(ASK_RETRY_DELAY_MS);
        if (lastRejectText) user += questionRetryNudge(lastRejectText);
        if (lastRejectReason === "既出質問の重複") {
          user +=
            "\n特に「" +
            clip(lastRejectText, 40) +
            "」と同じ意味の再質問は絶対禁止。共用記憶に無い軸へ分岐せよ。";
        }
        if (lastRejectReason === "初問定番バイアス") {
          user +=
            "\n初問の時間帯・活動リズム定番は却下済み。別の属性・存在様式・関係の切り口を発明せよ。具体例文は出すな。";
        }
      }
      const streamed = await streamIntoPanel(panel, system, user, {
        agent: asker,
        temperature: attempt === 0 ? 0.55 : lastRejectReason === "初問定番バイアス" ? 0.75 : 0.35,
        max_tokens: 500,
      });
      beatStart = streamed.beatStart;
      if (streamed.error && !streamed.raw) {
        panel.collapse();
        if (streamed.gpuReload || state.phase === "reload-model") return null;
        endConversationAiStopped(streamed.error);
        return null;
      }
      question = extractAskTo00(streamed);
      if (!question) {
        // No content-quality reject/retry anymore — best-effort salvage of
        // whatever the model produced, used as-is even if rough.
        const draft =
          firstDraftSpeech(streamed) || unwrapSpeechJunk(streamed.raw) || streamed.raw || "";
        question = draft ? ensureQuestionMark(cleanJapaneseLine(draft, 120)) : "（質問なし）";
      }
      if (isRepeatHistoryQuestion(question)) {
        lastRejectReason = "既出質問の重複";
        lastRejectText = question;
        panel.addSection("却下", "重複: " + clip(question, 80), "warn");
        question = null;
      } else if (isFirstAskNightActivityCliché(question)) {
        lastRejectReason = "初問定番バイアス";
        lastRejectText = question;
        panel.addSection("却下", "初問定番バイアス: " + clip(question, 80), "warn");
        question = null;
      } else {
        break;
      }
      // Same rejected text twice+ in a row means the model is stuck repeating
      // itself (e.g. a bare "いいえ" every attempt) — no amount of retrying
      // will fix that, unlike a varied-but-still-bad attempt.
      identicalRejectStreak =
        lastRejectText && lastRejectText === prevRejectText ? identicalRejectStreak + 1 : 0;
      prevRejectText = lastRejectText;
      attempt += 1;
    }
  }

  panel.addSection("最終質問", question, "out");
  panel.collapse();
  rememberAskedStem(question);
  appendSpeech(asker, "「" + question + "」", "a" + asker);
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

  if (state.mode !== "llm") {
    panel.collapse();
    endConversationAiStopped("LLM未ロード");
    return null;
  }

  const system =
    "あなたはエージェント00（被尋問者）。" +
    witnessRuleBook(state.origin) +
    namingClarityRule() +
    roleAlreadyKnownRule() +
    "あなただけが質問に答える。判定は ORIGIN と常識。" +
    "入力が具体的な質問でない（準備・議論・メタ・台本など）ときは答えない。" +
    "入力をそのまま繰り返す（オウム返し）のは禁止。答えられないことと理由を短く述べよ。" +
    "ORIGINの語そのもの（秘密の役割ラベルの字面）は発言に出すな（推測ゲームのため）。" +
    "最初に書いた発言がそのまま採用される。「代理人」禁止。" +
    structuredOutRule();
  const user =
    "ORIGIN = 「" +
    state.origin +
    "」\n質問 = 「" +
    question +
    "」\n" +
    "これがエージェント00への具体的な質問なら、ORIGINと常識に照らして詳しく具体的に答えよ。" +
    "ただし質問がORIGINそのものの直接開示要求なら、言い換えでも明かさず「それは明かせない」と理由付きで断れ。" +
    "ORIGINの字面は言うな。質問でなければ、質問文を繰り返さず、答えられないことと理由を短く述べよ。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent: "00",
    temperature: 0,
    max_tokens: 500,
    top_p: 0.5,
  });

  if (streamed.error && !streamed.raw) {
    panel.collapse();
    endConversationAiStopped(streamed.error);
    return null;
  }

  const resolved = resolveAgent00Answer(
    streamed.think,
    streamed.speak || firstDraftSpeech(streamed),
    streamed.raw,
    state.origin,
    question
  );
  let answer = resolved.answer;
  if (!answer) {
    answer = "うまく答えられない。";
    panel.addSection(
      "回答補正",
      (resolved.note || "発言を抽出できず") + " → 「うまく答えられない。」",
      "warn"
    );
  } else if (resolved.note) {
    panel.addSection("判定メモ", resolved.note, "meta");
  }

  panel.addSection("最終判定", answer, "out");
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
  const hyp = state.sharedHyp || "";
  panel.addSection("共有仮説", formatSharedHypDisplay(), "belief");

  if (state.mode !== "llm") {
    panel.collapse();
    endConversationAiStopped("LLM未ロードのため議論できない");
    return null;
  }

  const system =
    "あなたは" +
    name +
    "（尋問官）。" +
    investigatorRuleBook(name, partnerName) +
    namingClarityRule() +
    roleAlreadyKnownRule() +
    duoPartnershipRule() +
    "友人であり同僚の協同尋問官" +
    partnerName +
    "と、エージェント00の詳しい答えがORIGIN仮説にどう効くかを議論する。" +
    "t=0から協力確定。同僚が開いた絞り込み線に追いつき、同じ軸を進めよ（メタ準備や最初からのやり直し禁止）。" +
    "発言は1〜2短文だけ。答えの内容から何が残った／消えたかを述べ、次に狭める方向を示す。" +
    "禁止: 準備・議論しましょう・答え方の採点・メタ・同僚への呼びかけだけの文・複数エージェント台本・了解しました・代理人。" +
    "禁止: 「と回答する」「答えが確定的」など答え方そのもののメタ議論。" +
    "禁止: エージェント名だけの発言。" +
    structuredOutRule();
  const debateUserBase =
    investigatorContext(agent) +
    "\n直前の質問: 「" +
    question +
    "」\nエージェント00の答え: 「" +
    answer +
    "」\n" +
    (lastPartnerLine ? partnerName + "の直前の発言: 「" + lastPartnerLine + "」\n" : "") +
    "この詳しい答えで何が残った／消えたかを1〜2短文で述べ、同僚と同じ絞り込み線を進めよ。準備や台本は禁止。";

  panel.addSection(
    "params",
    "stream · 内容による再試行なし（AI呼び出し失敗時のみ再試行）",
    "meta"
  );
  let opinion = null;
  let beatStart = performance.now();
  if (state.phase === "ended" || state.phase === "reload-model") {
    panel.collapse();
    return null;
  }
  const streamed = await streamIntoPanel(panel, system, debateUserBase, {
    agent,
    temperature: 0.55,
    max_tokens: 500,
  });
  beatStart = streamed.beatStart;
  if (streamed.error && !streamed.raw) {
    panel.collapse();
    if (streamed.gpuReload || state.phase === "reload-model") return null;
    endConversationAiStopped(streamed.error);
    return null;
  }
  // Whatever the model produced is used as-is — no content-quality reject/retry.
  opinion = firstDraftSpeech(streamed) || unwrapSpeechJunk(streamed.raw) || streamed.raw || "（発言なし）";

  const hypSystem =
    "あなたは" +
    name +
    "。" +
    partnerName +
    "と共有する仮説を短い名詞句で。" +
    "答えで残った／消えた属性を織り込み、絞り込み線を進める更新にせよ。「代理人」禁止。" +
    "禁止: 了解しました・はい・いいえ・質問文・準備の宣言。" +
    structuredOutRule() +
    "発言行は仮説だけ（36字以内）。";
  const hypUser =
    "現在の共有仮説: 「" +
    (hyp || "（まだない）") +
    "」\n質問「" +
    question +
    "」→「" +
    answer +
    "」\n議論「" +
    clip(opinion, 120) +
    "」\n残った／消えた点を反映した短い共有仮説を句だけで書け。";
  const hypNote = panel.addSection("共有仮説 更新中…", "…", "belief");
  const resH = await llmChat(hypSystem, hypUser, {
    agent,
    temperature: 0.55,
    max_tokens: 500,
    onDelta: (_d, full) => {
      hypNote.textContent = full;
    },
    stream: true,
  });
  if (resH && resH.raw) {
    const sp = splitThinkSpeak(resH.raw);
    const newHyp = unwrapSpeechJunk(String(sp.speak || resH.raw).trim());
    if (newHyp && !isUselessMetaOrEcho(newHyp, "hyp") && !isBadHypothesis(newHyp, question)) {
      setSharedHypothesis(cleanJapaneseLine(newHyp, 40) || newHyp, {
        keepPrevAsAlt: !isVagueSharedHyp(hyp),
      });
    } else if (newHyp) {
      panel.addSection("仮説却下（スキップ）", clip(newHyp, 60), "warn");
    }
  } else if (resH && resH.error) {
    panel.addSection(
      "仮説更新スキップ",
      formatLlmErrorForPanel(resH.error),
      "warn"
    );
  }
  panel.addSection("共有仮説", formatSharedHypDisplay(), "belief");
  panel.addSection("最終発言", opinion, "out");

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
    if (!lastLine || state.phase === "ended") return;
    speaker = partnerAgent(speaker);
  }
}

async function agentFormalGuess(agent) {
  setTurn(agent, "AGENT-" + agent + " が正式推測");
  const panel = createThinkPanel(agent, "思考過程 · AGENT-" + agent + " 正式推測…");
  const hyp = state.sharedHyp || "";
  panel.addSection("共有仮説", formatSharedHypDisplay(), "belief");

  if (state.mode !== "llm") {
    panel.collapse();
    endConversationAiStopped("LLM未ロードのため推測できない");
    return false;
  }

  const system =
    "あなたは" +
    agentPromptName(agent) +
    "。共有仮説に基づきエージェント00への正式推測を行う。" +
    namingClarityRule() +
    duoPartnershipRule() +
    structuredOutRule() +
    "発言は正式推測の文。初稿が採用される。「代理人」禁止。";
  const user =
    investigatorContext(agent) +
    "\n共有仮説「" +
    (hyp || "（まだない）") +
    "」を踏まえ正式推測を書け。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent,
    temperature: 0.45,
    max_tokens: 500,
  });
  if (streamed.error && !streamed.raw) {
    panel.collapse();
    endConversationAiStopped(streamed.error);
    return false;
  }
  const guessLine = firstDraftSpeech(streamed);
  if (!guessLine) {
    panel.collapse();
    endConversationAiStopped("正式推測が空");
    return false;
  }

  state.guessCount++;
  updateHud();
  panel.addSection("推測（初稿）", guessLine, "out");
  panel.collapse();
  appendSpeech(agent, guessLine, "a" + agent);
  await typeChatBubble(agent, guessLine, "bguess");
  await paceAfterBeat(guessLine, streamed.beatStart);

  const role = extractGuessRole(guessLine) || cleanJapaneseLine(guessLine, 40);
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
  if (!question || state.phase === "ended") return;
  const answer = await agent00Answer(question);
  if (!answer || state.phase === "ended") return;
  recordSharedMemory(question, answer, asker);

  await runDiscussionPhase(asker, question, answer);
  if (state.phase === "ended") return;

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
  if (btnReloadModel) btnReloadModel.disabled = false;
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
    hyp: "",
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
    "エージェント00だけが質問に自由回答・詳しく答える（あなたは答えない）。\n" +
    "他の討論者の仮説: " +
    wolfHypSummary(speakerId) +
    "\nあなた(" +
    selfName +
    ")の仮説: 「" +
    clip(self ? self.hyp : "未定", 40) +
    "」\n【共用記憶】既出Q→A（同じ・ほぼ同じ質問の再質問は絶対禁止）:\n" +
    sharedMemoryBlock() +
    "\n既出質問ステム:\n" +
    askedQuestionsBlock()
  );
}

async function wolfAskQuestion(askerId) {
  const asker = wolfMemberById(askerId);
  const name = asker ? asker.name : agentDisplayName(askerId);
  setTurn(askerId, name + " が質問中");
  const panel = createThinkPanel(askerId, "思考過程 · " + name + " が質問を作成…");

  if (state.mode !== "llm") {
    panel.collapse();
    endConversationAiStopped("LLM未ロード");
    return null;
  }

  const system =
    "あなたは" +
    name +
    "。" +
    investigatorRuleBook(name) +
    wolfNamingClarityRule() +
    freeAskRule() +
    "エージェント00だけに日本語で問いかける。発言は1文だけ・具体的な質問（？で終わってよい）。" +
    (((state.history && state.history.length) || 0) === 0 ? firstAskVarietyRule() : "") +
    "履歴があるときは答えから分岐し、まだ聞いていない新しい絞り込み質問を発明せよ。" +
    "既出の質問と同じ・ほぼ同じ（句読点違い・括弧違い・同じ意味の言い換え）は禁止。" +
    "禁止: 準備・議論しましょう・答え方指示・メタ・台本・了解しました・代理人。具体例文は出すな。" +
    structuredOutRule() +
    "発言行に質問文だけを書く。";
  const askUserBase =
    wolfInvestigatorContext(askerId) +
    freeAskRule() +
    (((state.history && state.history.length) || 0) === 0
      ? "\n" + firstAskVarietyRule()
      : "") +
    "\nエージェント00への具体的な質問をちょうど1つ作れ（なぜ／詳しく等でも可）。既出と同じ・ほぼ同じは禁止。準備や議論の宣言は禁止。具体例文は出すな。";
  const askUserStrict =
    wolfInvestigatorContext(askerId) +
    freeAskRule() +
    (((state.history && state.history.length) || 0) === 0
      ? "\n" + firstAskVarietyRule()
      : "") +
    "\n短い1文だけ。エージェント00に聞く具体的な新しい質問をちょうど1つ（？推奨）。既出再質問禁止。メタ・準備・台本禁止。具体例文は出すな。";

  panel.addSection("params", "重複／初問定番のみ再試行（内容判定による拒否は撤廃）", "meta");
  let question = null;
  let beatStart = performance.now();
  let lastRejectReason = "";
  let lastRejectText = "";
  let prevRejectText = null;
  let identicalRejectStreak = 0;
  let attempt = 0;
  while (true) {
    if (state.phase === "ended" || state.phase === "reload-model") {
      panel.collapse();
      return null;
    }
    if (identicalRejectStreak >= 3) {
      question = pickDirectAskEscapeQuestion();
      panel.addSection(
        "代替質問",
        "同じ出力「" + clip(lastRejectText, 30) + "」を" + identicalRejectStreak + "回連続で繰り返したため、安全な質問に切替: 「" + question + "」",
        "warn"
      );
      break;
    }
    let user = attempt === 0 ? askUserBase : askUserStrict;
    if (attempt > 0) {
      const why = askRejectShortLabel(lastRejectReason || "既出質問の重複");
      panel.addSection("再試行", "再試行 " + attempt + " · " + why, "warn");
      await sleep(ASK_RETRY_DELAY_MS);
      if (lastRejectText) user += questionRetryNudge(lastRejectText);
      if (lastRejectReason === "既出質問の重複") {
        user +=
          "\n特に「" +
          clip(lastRejectText, 40) +
          "」と同じ意味の再質問は禁止。未質問の軸へ分岐せよ。";
      }
      if (lastRejectReason === "初問定番バイアス") {
        user +=
          "\n初問の時間帯・活動リズム定番は却下済み。別の属性・存在様式・関係の切り口を発明せよ。具体例文は出すな。";
      }
    }
    const streamed = await streamIntoPanel(panel, system, user, {
      agent: askerId,
      temperature: attempt === 0 ? 0.55 : lastRejectReason === "初問定番バイアス" ? 0.75 : 0.35,
      max_tokens: 500,
    });
    beatStart = streamed.beatStart;
    if (streamed.error && !streamed.raw) {
      panel.collapse();
      if (streamed.gpuReload || state.phase === "reload-model") return null;
      endConversationAiStopped(streamed.error);
      return null;
    }
    question = extractAskTo00(streamed);
    if (!question) {
      // No content-quality reject/retry anymore — best-effort salvage of
      // whatever the model produced, used as-is even if rough.
      const draft =
        firstDraftSpeech(streamed) || unwrapSpeechJunk(streamed.raw) || streamed.raw || "";
      question = draft ? ensureQuestionMark(cleanJapaneseLine(draft, 120)) : "（質問なし）";
    }
    if (isRepeatHistoryQuestion(question)) {
      lastRejectReason = "既出質問の重複";
      lastRejectText = question;
      panel.addSection("却下", "重複: " + clip(question, 80), "warn");
      question = null;
    } else if (isFirstAskNightActivityCliché(question)) {
      lastRejectReason = "初問定番バイアス";
      lastRejectText = question;
      panel.addSection("却下", "初問定番バイアス: " + clip(question, 80), "warn");
      question = null;
    } else {
      break;
    }
    // Same rejected text twice+ in a row means the model is stuck repeating
    // itself (e.g. a bare "いいえ" every attempt) — no amount of retrying
    // will fix that, unlike a varied-but-still-bad attempt.
    identicalRejectStreak =
      lastRejectText && lastRejectText === prevRejectText ? identicalRejectStreak + 1 : 0;
    prevRejectText = lastRejectText;
    attempt += 1;
  }

  panel.addSection("最終質問", question, "out");
  panel.collapse();
  rememberAskedStem(question);
  appendSpeech(askerId, "「" + question + "」", "a" + askerId);
  appendChatBubble("ask", "[" + name + "] → エージェント00: " + question);
  await paceAfterBeat(question, beatStart);
  return question;
}

async function wolfDiscussTurn(speakerId, question, answer, turnIndex, lastSpeakerLine) {
  const speaker = wolfMemberById(speakerId);
  const name = speaker ? speaker.name : agentDisplayName(speakerId);
  setTurn(speakerId, name + " が議論中 (" + turnIndex + ")");
  const panel = createThinkPanel(speakerId, "思考過程 · " + name + " 議論");

  if (state.mode !== "llm") {
    panel.collapse();
    endConversationAiStopped("LLM未ロード");
    return null;
  }

  const system =
    "あなたは" +
    name +
    "。" +
    investigatorRuleBook(name) +
    wolfNamingClarityRule() +
    (speaker && speaker.isHallucinator ? hallucinatorAddendum() : "") +
    "エージェント00の詳しい答えがORIGIN仮説にどう効くかを1〜2短文で述べる。" +
    "禁止: 準備・議論しましょう・答え方の採点・メタ・台本・了解しました・代理人。" +
    structuredOutRule();
  const debateUserBase =
    wolfInvestigatorContext(speakerId) +
    "\n質問「" +
    question +
    "」→「" +
    answer +
    "」\n" +
    (lastSpeakerLine ? "直前「" + lastSpeakerLine + "」\n" : "") +
    "この詳しい答えの含意を1〜2短文で述べよ。準備や台本は禁止。";

  panel.addSection(
    "params",
    "内容による再試行なし（AI呼び出し失敗時のみ再試行）",
    "meta"
  );
  let opinion = null;
  let beatStart = performance.now();
  if (state.phase === "ended" || state.phase === "reload-model") {
    panel.collapse();
    return null;
  }
  const streamed = await streamIntoPanel(panel, system, debateUserBase, {
    agent: speakerId,
    temperature: 0.55,
    max_tokens: 500,
  });
  beatStart = streamed.beatStart;
  if (streamed.error && !streamed.raw) {
    panel.collapse();
    if (streamed.gpuReload || state.phase === "reload-model") return null;
    endConversationAiStopped(streamed.error);
    return null;
  }
  // Whatever the model produced is used as-is — no content-quality reject/retry.
  opinion = firstDraftSpeech(streamed) || unwrapSpeechJunk(streamed.raw) || streamed.raw || "（発言なし）";

  const hypSystem =
    "あなたは" +
    name +
    "。仮説を短い名詞句で。「代理人」禁止。" +
    "禁止: 了解しました・はい・いいえ・質問文・準備の宣言。" +
    structuredOutRule() +
    "発言行は仮説だけ（36字以内）。";
  const hypUser =
    "現在「" +
    (speaker ? speaker.hyp || "（まだない）" : "（まだない）") +
    "」\nQ「" +
    question +
    "」A「" +
    answer +
    "」\n議論「" +
    clip(opinion, 80) +
    "」\n仮説を短い句だけで書け。";
  const resH = await llmChat(hypSystem, hypUser, {
    agent: speakerId,
    temperature: 0.55,
    max_tokens: 500,
    stream: false,
  });
  if (resH && resH.raw && speaker) {
    const sp = splitThinkSpeak(resH.raw);
    const h = unwrapSpeechJunk(String(sp.speak || resH.raw).trim());
    if (
      h &&
      !isUselessMetaOrEcho(h, "hyp") &&
      !isBadHypothesis(h, question)
    ) {
      speaker.hyp = cleanJapaneseLine(h, 40) || h;
    } else if (h) {
      panel.addSection("仮説却下（スキップ）", clip(h, 60), "warn");
    }
  } else if (resH && resH.error) {
    panel.addSection(
      "仮説更新スキップ",
      formatLlmErrorForPanel(resH.error),
      "warn"
    );
  }

  panel.addSection("最終発言", opinion, "out");
  panel.collapse();
  appendSpeech(speakerId, "「" + opinion + "」", "a" + speakerId);
  await typeChatBubble(speakerId, opinion);
  await paceAfterBeat(opinion, beatStart);
  return opinion;
}

async function wolfRunDiscussionPhase(askerId, question, answer) {
  const alive = wolfAliveRoster();
  let lastLine = null;
  for (let i = 0; i < Math.min(4, alive.length); i++) {
    const speaker = alive[i];
    lastLine = await wolfDiscussTurn(speaker.id, question, answer, i + 1, lastLine);
    if (!lastLine || state.phase === "ended") return;
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
    });

    if (streamed.error && !streamed.raw) {
      panel.collapse();
      endConversationAiStopped(streamed.error || "投票生成失敗");
      return;
    }

    const draft = firstDraftSpeech(streamed);
    if (!draft) {
      panel.collapse();
      endConversationAiStopped("投票文が空");
      return;
    }

    let target = null;
    const m = String(draft).match(/討論者\s*([1-5])/);
    if (m) target = wolfMemberById("D" + m[1]);
    if (!target || target.id === voter.id || !target.alive) {
      target = candidates[0];
    }

    votes[target.id] = (votes[target.id] || 0) + 1;
    reasons.push(voter.name + "→" + target.name + "（初稿: " + clip(draft, 24) + "）");
    panel.addSection("投票（初稿）", draft, "out");
    panel.addSection("集計先", target.name, "meta");
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

  if (state.mode !== "llm") {
    panel.collapse();
    endConversationAiStopped("LLM未ロード");
    return false;
  }

  const system =
    "あなたは" +
    guesser.name +
    "。正式推測を行う。" +
    wolfNamingClarityRule() +
    structuredOutRule() +
    "初稿が採用される。「代理人」禁止。";
  const user = wolfInvestigatorContext(guesser.id) + "\n正式推測を書け。";

  const streamed = await streamIntoPanel(panel, system, user, {
    agent: guesser.id,
    temperature: 0.45,
    max_tokens: 500,
  });

  if (streamed.error && !streamed.raw) {
    panel.collapse();
    endConversationAiStopped(streamed.error);
    return false;
  }

  const guessLine = firstDraftSpeech(streamed);
  if (!guessLine) {
    panel.collapse();
    endConversationAiStopped("正式推測が空");
    return false;
  }

  state.guessCount++;
  panel.addSection("推測（初稿）", guessLine, "out");
  panel.collapse();
  await typeChatBubble(guesser.id, guessLine, "bguess");
  await paceAfterBeat(guessLine, streamed.beatStart);

  const role = extractGuessRole(guessLine) || cleanJapaneseLine(guessLine, 40);
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
  const asker = alive[Math.floor(Math.random() * alive.length)];
  const question = await wolfAskQuestion(asker.id);
  if (!question || state.phase === "ended") return;
  const answer = await agent00Answer(question);
  if (!answer || state.phase === "ended") return;
  recordSharedMemory(question, answer, asker.id);

  await wolfRunDiscussionPhase(asker.id, question, answer);
  if (state.phase === "ended") return;

  if (state.wolfQInCours >= WOLF_QUESTIONS_PER_COURS) {
    await wolfVotePhase();
    state.wolfQInCours = 0;
    state.wolfCours++;
  }
  renderWolfRoster();
  updateWolfHud();
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
  clearSharedMemory();
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
  inputEl.placeholder = "質問を入力…";
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
  cohLabel.textContent = "Round " + state.wolfCours;

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
          ? "正体が解明されました"
          : "未解明のまま終了しました"
        : state.phase === "imprint"
          ? "秘密の役割（ORIGIN）を入力してください"
          : humanPhaseLabel(state.turnPhase || phaseShort);
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
  appendChatBubble(
    "sys",
    "DIGITAL TATTOO — interrogation online · build " + CLIENT_BUILD
  );
  if (state.mode !== "llm") {
    appendChatBubble("sys", "LLM が必要です。ゲートでモデルを読み込んでください。");
    return;
  }
  appendChatBubble("sys", "engines: " + assignmentShortLabel());
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
        "問ごとに追放投票。正解「あなたは〇〇です。」で勝利。定型文の代替は無し — AI生成が止まったら会話終了。"
    );
  } else {
    appendChatBubble(
      "sys",
      "規則: ORIGIN はエージェント00（被尋問者）のみ。エージェント00は自由回答・詳しく答える。" +
        "エージェント01/02はt=0から友人・同僚の協同尋問官（コミュニケーション0でも協力確定・役割確認不要）。" +
        "最初の質問からORIGIN空間を絞り、02は01の線に追いつく。" +
        "共有仮説はAIが立てたものだけ（用意された定型仮説は無し）。" +
        "AIの生成が止まったらそこで会話終了。正解「あなたは〇〇です。」で勝利"
    );
  }
  state.phase = "imprint";
  setTurn("00", "ORIGIN 刻印待機");
  inputEl.disabled = false;
  inputEl.placeholder = "対象者の秘密の役割（ORIGIN）を入力…";
  if (btnSend) btnSend.disabled = false;
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
  clearSharedMemory();
  initSharedHypothesisForSession();
  state.pollution = 0;
  state.discussTurns = 0;
  state.wrongGuesses = 0;
  state.guessCount = 0;
  state.lastGuessRound = -99;
  state.won = false;
  consecutiveLlmFailures = 0;
  showOriginPin();
  setControlsVisible(true);
  syncPaceButton();
  logSession({ kind: "origin", agent: "00", text: state.origin });
  setTurn("01", "尋問開始 · エージェント01 が最初の質問");
  inputEl.placeholder = "質問を入力…";
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
        "ORIGIN をエージェント00に刻印。尋問開始 — エージェント01がすぐ具体的な絞り込み質問。"
      );
      appendChatBubble(
        "sys",
        "協力はt=0から確定: エージェント00＝被尋問者（自由回答・詳しく）。" +
          "エージェント01・02＝友人・同僚の協同尋問官（コミュニケーション0でも息が合っている）。" +
          "知り合い直し・準備宣言は不要 — 最初から候補空間を狭め、02は01の線に追いつく。"
      );
      appendChatBubble(
        "sys",
        "共有仮説はまだ空。議論の中でAIが初めて立てる（定型の用意なし）。空でも最初の問いから絞れ。"
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

if (btnReloadModel) {
  btnReloadModel.addEventListener("click", () => {
    void offerModelReload("オペレーターがモデル再読み込みを要求");
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
  state.mode = "booting";
  setBadge("offline");
  gateMsg.textContent = reason;
  gateFill.style.width = "0%";
  gatePct.textContent = "—";
  gateLoad.disabled = false;
  gateLoad.hidden = false;
  gateLoad.textContent = "▶ 開始";
  gateHint.innerHTML =
    "モデルの読み込みが必要です。定型文でのプレイはありません。<br>" +
    "推奨は TinySwallow 1.5B。別モデルや再読み込みを試してください。";
  gateActions.classList.add("show");
  if (gateSkip) gateSkip.hidden = true;
}

function usableTag(usable) {
  if (usable === "yes") return "usable";
  if (usable === "maybe") return "要VRAM";
  return "非推奨";
}

function shortMissReason(reason) {
  const r = String(reason || "このホストにファイルがありません");
  // Keep HF / TinySwallow identity visible when truncated
  if (/Hugging Face|hfRepo|SakanaAI|見つかりません/.test(r)) {
    return r.length > 96 ? r.slice(0, 94) + "…" : r;
  }
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
    title.textContent = ({ "00": "対象者 · AGENT-00", "01": "尋問官A · AGENT-01", "02": "尋問官B · AGENT-02" }[agent] || ("エージェント" + agent));
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
  gateLoad.textContent = "▶ 開始";
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
      "討論5人＋AGENT-00 → " + (m ? m.label : btn.dataset.model) + "。「▶ 開始」を押してください。";
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
  if (state.phase === "reload-model" && state.defined && state.origin) {
    resumeAfterModelReload();
    return;
  }
  bootNarrative();
}

if (gateSkip) {
  gateSkip.hidden = true;
  gateSkip.addEventListener("click", (e) => {
    e.preventDefault();
    gateMsg.textContent = "定型文での続行はありません。モデルを読み込んでください。";
  });
}

if (gateAgentAssign) {
  gateAgentAssign.addEventListener("click", (e) => {
    const btn = e.target.closest(".gate-model-box");
    if (!btn || btn.disabled || loadingModel || state.ready) return;
    applyAgentModelChoice(btn.dataset.agent, btn.dataset.model);
    const m = resolveModel(btn.dataset.model);
    const ui =
      ({ "00": "対象者", "01": "尋問官A", "02": "尋問官B" }[btn.dataset.agent]) ||
      ("エージェント" + btn.dataset.agent);
    gateMsg.textContent =
      ui +
      " → " +
      (m ? m.label : btn.dataset.model) +
      "。「▶ 開始」を押してください。";
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
    gateLoad.textContent = "▶ 開始";
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
    const isGpuErr = !!(e && isGpuLostError(e));
    if (isGpuErr) gpuDeathCount++;
    if (
      e &&
      (e.code === "AGENT_ASSIGN_LOAD_FAILED" ||
        isGpuErr ||
        /VRAM|メモリ|memory/i.test(String(e.message || e)))
    ) {
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
      const repeatWarn =
        isGpuErr && gpuDeathCount >= 2
          ? " ⚠ GPU切断" +
            gpuDeathCount +
            "回目 — このタブ内でモデルを選び直しても直らない可能性が高いです。" +
            "ブラウザで Ctrl+Shift+R（強制再読み込み）してから改めて開始してください。"
          : "";
      gateMsg.textContent =
        msg +
        " → 全エージェントを " +
        label +
        " に揃えました。もう一度「▶ 開始」を試してください。" +
        repeatWarn;
      gateLoad.disabled = false;
      gateLoad.textContent = "▶ 開始";
      gateActions.classList.add("show");
      if (gateSkip) gateSkip.hidden = true;
      return;
    }

    enterFallback(msg);
  }
});

async function init() {
  const pages = isGitHubPagesHost();
  gateHint.innerHTML = pages
    ? "<strong>推奨: TinySwallow 1.5B（JP特化）</strong> — Pages でも選択可。" +
      "未同梱時は Hugging Face + IndexedDB（初回 ≈830 MB）。" +
      "標準 Qwen 1.5B / Qwen3 1.7B・0.6B / 3B / Gemma-JPN / Llama 3.2 も選択可。<br>" +
      "0.5B は品質が落ちます。CI は 0.5B を同一オリジン同梱。同じ選択はエンジン共有。"
    : "<strong>推奨: TinySwallow 1.5B（JP特化）</strong> · " +
      "標準 Qwen 1.5B · Qwen3 1.7B・0.6B（新世代）· 軽量 0.5B · " +
      "高精度 3B · Gemma-JPN（system不可）· Llama 3.2 1B・3B（日本語弱め）。<br>" +
      "未配置モデルは初回 HF 取得可。同じモデルを選んだエージェントはエンジンを共有します。";
  buildAssignPicker();
  updateHud();
  setControlsVisible(false);
  syncDownloadUi();
  syncPaceButton();

  if (!hasWebGPU()) {
    enterFallback(
      "WebGPU が使えません。Chrome / Edge の最新版で開いてください（LLM必須）。"
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
        "モデルを読み込めない場合はこのブラウザではプレイできません。"
    );
    return;
  }

  setAgentAssignments(coerceAssignmentsToAvailable(getAgentAssignments(), catalogAvail));
  await syncAssignPickerUI();
  setGateProgress("準備完了 — 開始できます", 0);
  gatePct.textContent = "—";
  const defLabel = resolveModel(getDefaultModelKey())?.label || "モデル";
  gateMsg.textContent =
    "通常モード（" + defLabel + "）で開始できます。詳細設定でモデル変更も可能です。";
  gateLoad.disabled = false;
  gateLoad.textContent = "▶ 開始";
  gateActions.classList.add("show");
}


// ── UX-only: landing / advanced / think toggle ───────────
function initLandingMotion() {
  const els = document.querySelectorAll("[data-reveal]");
  if (!els.length) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    els.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-visible");
        io.unobserve(e.target);
      }
    },
    { threshold: 0.12, root: document.getElementById("modelGate") }
  );
  els.forEach((el, i) => {
    el.style.setProperty("--reveal-delay", (i % 5) * 70 + "ms");
    io.observe(el);
  });
}

if (gateAdvancedToggle && gateAdvanced) {
  gateAdvancedToggle.addEventListener("click", () => {
    const open = gateAdvanced.classList.toggle("open");
    gateAdvancedToggle.setAttribute("aria-expanded", open ? "true" : "false");
    gateAdvancedToggle.textContent = open ? "詳細設定を閉じる" : "詳細設定";
  });
}

if (btnThinkToggle && boardEl) {
  btnThinkToggle.addEventListener("click", () => {
    const open = boardEl.classList.toggle("thinks-open");
    btnThinkToggle.setAttribute("aria-pressed", open ? "true" : "false");
    btnThinkToggle.textContent = open ? "AIの思考を隠す" : "AIの思考を見る";
  });
}

if (topicCards) {
  const tips = {
    job: "就活 — 検索結果に残る印象を、尋問体験で先取りする。",
    sns: "SNS — 軽い投稿が、あとから文脈を失って残ることがある。",
    ai: "AI — 断片からプロフィールを推測される感覚を体験する。",
    privacy: "個人情報 — 小さな手がかりがつながり、人物像になる。",
  };
  topicCards.addEventListener("click", (e) => {
    const btn = e.target.closest(".topic-card");
    if (!btn) return;
    for (const c of topicCards.querySelectorAll(".topic-card")) {
      c.classList.toggle("selected", c === btn);
    }
    if (topicEcho) topicEcho.textContent = tips[btn.dataset.topic] || "";
  });
}

initLandingMotion();


init();

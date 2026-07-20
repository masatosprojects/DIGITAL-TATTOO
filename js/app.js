/**
 * DIGITAL TATTOO — interrogation game
 *
 * Operator imprints ORIGIN onto AGENT-00 only (immutable Digital Tattoo).
 * AGENT-01 / AGENT-02 guess via yes/no questions; ORIGIN never enters their prompts.
 * AGENT-00 answers are system-clamped to はい / いいえ.
 * Runtime: same-origin WebLLM + template fallback.
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
  hasWebGPU,
  createLocalEngine,
  createLlmQueue,
  driftTemperature,
  driftLabel,
} from "./llm.js";

const MAX_ROUNDS = 12;
const GUESS_EVERY = 4; // formal guess every N Q&A rounds

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
const gateLoad = document.getElementById("gateLoad");
const gateModelPick = document.getElementById("gateModelPick");
const hyp01El = document.getElementById("hyp01");
const hyp02El = document.getElementById("hyp02");
const btnInject = document.getElementById("btnInject");
const btnGuess = document.getElementById("btnGuess");
const btnPause = document.getElementById("btnPause");
const controlsEl = document.getElementById("controls");

const state = {
  ready: false,
  defined: false,
  origin: "",
  seed: 0,
  mode: "booting", // llm | fallback
  phase: "boot", // boot | imprint | playing | ended
  round: 0,
  nextAsker: "01",
  history: [], // { q, a, asker }
  hyp01: "未定",
  hyp02: "未定",
  pollution: 0, // 0..3 context pollution / confident wrongness
  wrongGuesses: 0,
  pendingInject: null,
  forceGuess: false,
  paused: false,
  won: false,
  typing: false,
  queue: [],
  llmBusy: false,
  turnBusy: false,
  loopTimer: null,
};

const engineRef = { current: null };
let llmQueue = null;
/** @type {Array<import("./llm.js").ModelInfo & { available: boolean, reason?: string }> | null} */
let catalogAvail = null;
let loadingModel = false;
let pickerBuilt = false;

function activeModelId() {
  return getActiveModel().id;
}

function setBadge(mode) {
  if (mode === "llm") {
    const m = getActiveModel();
    engineBadge.textContent = "LLM · " + m.shortLabel + " · " + m.id.replace(/-MLC$/, "");
    engineBadge.className = "llm";
  } else {
    engineBadge.textContent = "TEMPLATE FALLBACK";
    engineBadge.className = "fallback";
  }
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

function showWarn(msg) {
  if (msg) warnEl.textContent = msg;
  else warnEl.textContent = "日本語のみ入力できます";
  warnEl.classList.add("show");
  clearTimeout(showWarn._t);
  showWarn._t = setTimeout(() => warnEl.classList.remove("show"), 1600);
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

function scrollLog() {
  logEl.scrollTop = logEl.scrollHeight;
}

function updateHud() {
  const pollPct = Math.max(0, 100 - state.pollution * 28 - state.wrongGuesses * 8);
  cohFill.style.width = pollPct + "%";
  if (pollPct > 70) cohFill.style.background = "var(--green)";
  else if (pollPct > 35) cohFill.style.background = "var(--amber)";
  else cohFill.style.background = "var(--warn)";

  const phaseLabel =
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
    "/" +
    MAX_ROUNDS +
    " · POL " +
    state.pollution +
    " · " +
    phaseLabel;

  if (hyp01El) hyp01El.textContent = state.hyp01;
  if (hyp02El) hyp02El.textContent = state.hyp02;

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
  const hypBar = document.getElementById("hypBar");
  if (hypBar) hypBar.classList.toggle("show", !!show);
}

/** Live thinking / process panel — open while generating, collapse on commit. */
function createThinkPanel(title) {
  const wrap = document.createElement("div");
  wrap.className = "think-wrap";

  const details = document.createElement("details");
  details.className = "think-panel";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "think-summary";
  summary.textContent = title || "思考過程";

  const body = document.createElement("div");
  body.className = "think-body";

  details.appendChild(summary);
  details.appendChild(body);
  wrap.appendChild(details);
  logEl.appendChild(wrap);
  scrollLog();

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
    body.appendChild(sec);
    scrollLog();
    return pre;
  }

  function setStatus(msg) {
    summary.textContent = msg;
  }

  function collapse() {
    details.open = false;
    summary.textContent = "思考過程（展開して汚染文脈を見る）";
    wrap.classList.add("think-done");
  }

  return { wrap, details, body, addSection, setStatus, collapse };
}

function typewrite(text, cls, speedBase) {
  return new Promise((resolve) => {
    state.typing = true;
    const div = document.createElement("div");
    div.className = "line " + (cls || "ai");

    const caret = document.createElement("span");
    caret.className = "caret";
    div.appendChild(caret);
    logEl.appendChild(div);

    const chars = Array.from(text);
    let i = 0;
    const delay = speedBase != null ? speedBase : 28;

    function step() {
      if (i >= chars.length) {
        caret.remove();
        state.typing = false;
        scrollLog();
        resolve();
        return;
      }
      const ch = chars[i++];
      div.insertBefore(document.createTextNode(ch), caret);
      scrollLog();
      setTimeout(step, delay);
    }
    step();
  });
}

async function drainQueue() {
  while (state.queue.length) {
    const job = state.queue.shift();
    if (job.kind === "system") {
      appendLine(job.text, "system");
      continue;
    }
    if (job.kind === "speak") {
      await typewrite(job.text, job.cls, job.speed);
      if (job.onDone) job.onDone();
      continue;
    }
    await typewrite(job.text, job.cls, job.speed);
  }
}

function enqueueSpeak(text, cls, speed, onDone) {
  state.queue.push({ kind: "speak", text, cls, speed, onDone });
  if (!state.typing) drainQueue();
}

function commitUtterance(panel, text, cls, speed) {
  return new Promise((resolve) => {
    enqueueSpeak(text, cls, speed, () => {
      panel.collapse();
      resolve();
    });
  });
}

function historyBlock(limit = 8) {
  const take = state.history.slice(-limit);
  if (!take.length) return "（まだ質問なし）";
  return take
    .map((h, i) => (i + 1) + ". AGENT-" + h.asker + "「" + h.q + "」→ AGENT-00「" + h.a + "」")
    .join("\n");
}

function investigatorContext(agent) {
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const other = agent === "01" ? state.hyp02 : state.hyp01;
  return (
    "あなたは AGENT-" +
    agent +
    "。AGENT-00 の秘密の役割を当てる捜査官。\n" +
    "ORIGIN（真実）は知らされていない。推測でよい。\n" +
    "自分の仮説: 「" +
    clip(hyp, 40) +
    "」\n相手 AGENT の仮説: 「" +
    clip(other, 40) +
    "」\n汚染度: " +
    state.pollution +
    "（高いほど自信ある誤認を混ぜてよい）\nQ&A履歴:\n" +
    historyBlock()
  );
}

function snapshotMeta(extra) {
  return [
    "engine: " +
      (state.mode === "llm" ? "WebLLM · " + activeModelId() : "TEMPLATE FALLBACK"),
    "round: " + state.round + "/" + MAX_ROUNDS,
    "pollution: " + state.pollution + " (" + driftLabel(Math.min(3, state.pollution)) + ")",
    "nextAsker: AGENT-" + state.nextAsker,
    "wrongGuesses: " + state.wrongGuesses,
    extra || "",
  ]
    .filter(Boolean)
    .join("\n");
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
    return { raw: String(text || "").trim() };
  } catch (e) {
    console.warn("LLM call failed, using fallback", e);
    return { error: e && e.message ? e.message : String(e) };
  } finally {
    state.llmBusy = false;
  }
}

/** System-enforced yes/no clamp — never trust free LLM output. */
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
    // Prefer the token that appears first
    const yi = t.search(/はい|yes|肯定/);
    const ni = t.search(/いいえ|いや|no|否定|違う/);
    if (yi >= 0 && (ni < 0 || yi < ni)) return "はい";
    return "いいえ";
  }
  // First character heuristics for tiny models
  if (/^[はいYy]/.test(t)) return "はい";
  if (/^[いInN否]/.test(t)) return "いいえ";
  return null;
}

function forceYesNo(raw, origin, question) {
  const clamped = clampYesNo(raw);
  if (clamped) return clamped;
  return answerYesNoFallback(origin, question);
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

// ── AGENT turns ──────────────────────────────────────────

async function agentAskQuestion(asker) {
  const panel = createThinkPanel("思考過程 · AGENT-" + asker + " が質問を作成…");
  panel.addSection("メタ", snapshotMeta("role=investigator ask"), "meta");
  panel.addSection("注意", "ORIGIN はこのプロンプトに含まれない（捜査官には秘匿）", "warn");
  panel.addSection("捜査官コンテキスト", investigatorContext(asker), "mem");

  const system =
    "あなたは AGENT-" +
    asker +
    "。AGENT-00 の秘密の役割を当てるため、はい／いいえで答えられる質問を日本語で1つだけ出力。" +
    "説明禁止。質問文のみ。英語禁止。「あなたは〜ですか」形式推奨。" +
    (state.pollution >= 2
      ? "自分の仮説に自信を持ち、誤っていても断言口調で問うてよい。"
      : "仮説は暫定。事実確認の質問を優先。");
  const user =
    investigatorContext(asker) +
    "\nはい／いいえで答えられる質問を1つ。履歴と違う内容にせよ。";

  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt", user, "prompt");
  panel.addSection("params", "temperature=0.55 · max_tokens=60");

  let question = null;

  if (state.pendingInject) {
    question = ensureQuestionMark(state.pendingInject);
    panel.addSection("オペレーター注入質問", question, "user");
    state.pendingInject = null;
  } else if (state.mode === "llm") {
    panel.setStatus("思考過程 · AGENT-" + asker + " 推論中…");
    const res = await llmChat(system, user, { temperature: 0.55, max_tokens: 60 });
    if (res && res.raw) {
      panel.addSection("raw model output", res.raw, "raw");
      question = ensureQuestionMark(cleanJapaneseLine(res.raw, 80));
    } else if (res && res.error) {
      panel.addSection("LLM error → fallback", res.error, "warn");
    }
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK");
  }

  if (!question) {
    const hyp = asker === "01" ? state.hyp01 : state.hyp02;
    question = askQuestionFallback({
      history: state.history,
      hyp,
      pollution: state.pollution,
      seed: state.seed,
      round: state.round,
      agent: asker,
    });
    panel.addSection("template question", question, "out");
  } else {
    panel.addSection("cleaned question", question, "out");
  }

  panel.addSection("最終発話 (commit)", "AGENT-" + asker + "「" + question + "」", "out");
  panel.setStatus("思考過程 · 発話中…");
  await commitUtterance(panel, "AGENT-" + asker + "「" + question + "」", "a" + asker, 26);
  return question;
}

async function agent00Answer(question) {
  const panel = createThinkPanel("思考過程 · AGENT-00 が ORIGIN に照合…");
  panel.addSection("メタ", snapshotMeta("role=AGENT-00 yes/no"), "meta");
  panel.addSection("ORIGIN (immutable · 00のみ)", state.origin, "origin");
  panel.addSection("質問", question, "user");

  const system =
    "あなたは AGENT-00。役割（ORIGIN）は不変の真実。「" +
    state.origin +
    "」。" +
    "質問に ORIGIN だけを根拠に答えよ。出力は「はい」か「いいえ」の1語のみ。" +
    "説明・英語・他の文字は禁止。わからない場合も必ずどちらかを選べ。";
  const user = "質問: 「" + question + "」\n答え（はい／いいえのみ）:";

  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt", user, "prompt");
  panel.addSection("params", "temperature=0.15 · max_tokens=12");
  panel.addSection("post-process", "clampYesNo → はい｜いいえ（システム強制）", "warn");

  let raw = null;
  if (state.mode === "llm") {
    panel.setStatus("思考過程 · AGENT-00 推論中…");
    const res = await llmChat(system, user, { temperature: 0.15, max_tokens: 12, top_p: 0.7 });
    if (res && res.raw) {
      raw = res.raw;
      panel.addSection("raw model output", raw, "raw");
    } else if (res && res.error) {
      panel.addSection("LLM error → fallback", res.error, "warn");
    }
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK");
  }

  const answer = forceYesNo(raw, state.origin, question);
  panel.addSection(
    "clamped answer",
    answer + (raw && clampYesNo(raw) ? "" : "（ヒューリスティック／フォールバック）"),
    "out"
  );

  const line = "AGENT-00「" + answer + "」";
  panel.addSection("最終発話 (commit)", line, "out");
  panel.setStatus("思考過程 · 発話中…");
  await commitUtterance(panel, line, "a00", 32);
  return answer;
}

async function agentDebate(agent, question, answer) {
  const panel = createThinkPanel(
    "思考過程 · AGENT-" + agent + " が「" + answer + "」の意味を議論…"
  );
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  const otherHyp = agent === "01" ? state.hyp02 : state.hyp01;

  panel.addSection("メタ", snapshotMeta("role=debate AGENT-" + agent), "meta");
  panel.addSection("注意", "ORIGIN 非公開。答えの理由を仮説で議論する。", "warn");
  panel.addSection("捜査官コンテキスト", investigatorContext(agent), "mem");

  const why =
    answer === "はい"
      ? "なぜ AGENT-00 が「はい」と答えたのか、自分の仮説の観点から議論せよ。"
      : "なぜ AGENT-00 が「いいえ」と答えたのか、自分の仮説の観点から議論せよ。";

  const system =
    "あなたは AGENT-" +
    agent +
    "。捜査会議で短く1〜2文の日本語意見を述べる。英語禁止。" +
    why +
    (state.pollution >= 2
      ? "自信過剰でよい。誤った仮説でも断言してよい（文脈汚染）。"
      : "慎重に。相手の仮説にも触れよ。");
  const user =
    investigatorContext(agent) +
    "\n直前の質問: 「" +
    question +
    "」\nAGENT-00 の答え: 「" +
    answer +
    "」\n意見を1〜2文。";

  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt", user, "prompt");
  panel.addSection(
    "params",
    "temperature=" + driftTemperature(Math.min(3, state.pollution)).toFixed(2) + " · max_tokens=90"
  );

  let opinion = null;
  if (state.mode === "llm") {
    panel.setStatus("思考過程 · AGENT-" + agent + " 議論中…");
    const res = await llmChat(system, user, {
      temperature: driftTemperature(Math.min(3, state.pollution)),
      max_tokens: 90,
    });
    if (res && res.raw) {
      panel.addSection("raw model output", res.raw, "raw");
      opinion = cleanJapaneseLine(res.raw, 140);
    } else if (res && res.error) {
      panel.addSection("LLM error → fallback", res.error, "warn");
    }
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK");
  }

  if (!opinion) {
    opinion = debateFallback({
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
    panel.addSection("template debate", opinion, "out");
  } else {
    panel.addSection("cleaned debate", opinion, "out");
  }

  // Update hypothesis (separate short prompt or template)
  let newHyp = null;
  const hypSystem =
    "AGENT-" +
    agent +
    "の現在の仮説（AGENT-00の役割の短い日本語）を1つだけ出力。説明禁止。" +
    (state.pollution >= 2 ? "自信ある誤認でもよい。" : "");
  const hypUser =
    "旧仮説: 「" +
    hyp +
    "」\n質問: 「" +
    question +
    "」→「" +
    answer +
    "」\n新しい仮説:";
  panel.addSection("system prompt (hyp)", hypSystem, "prompt");
  panel.addSection("user prompt (hyp)", hypUser, "prompt");

  if (state.mode === "llm") {
    const resH = await llmChat(hypSystem, hypUser, { temperature: 0.7, max_tokens: 40 });
    if (resH && resH.raw) {
      panel.addSection("raw hyp", resH.raw, "raw");
      newHyp = cleanJapaneseLine(resH.raw, 40);
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
    panel.addSection("template hyp", newHyp, "out");
  }

  if (agent === "01") state.hyp01 = newHyp;
  else state.hyp02 = newHyp;
  panel.addSection("仮説更新", "AGENT-" + agent + " → 「" + newHyp + "」", "belief");
  updateHud();

  const line = "AGENT-" + agent + "「" + opinion + "」";
  panel.addSection("最終発話 (commit)", line, "out");
  panel.setStatus("思考過程 · 発話中…");
  await commitUtterance(panel, line, "debate a" + agent, 24);
}

async function agentFormalGuess(agent) {
  const panel = createThinkPanel("思考過程 · AGENT-" + agent + " が正式推測…");
  const hyp = agent === "01" ? state.hyp01 : state.hyp02;
  panel.addSection("メタ", snapshotMeta("role=formal guess"), "meta");
  panel.addSection("注意", "ORIGIN 非公開。推測文のみ。", "warn");
  panel.addSection("捜査官コンテキスト", investigatorContext(agent), "mem");

  const system =
    "あなたは AGENT-" +
    agent +
    "。正式推測を1行だけ出力。形式は必ず次: AGENT-00 の役割は〇〇である" +
    "（〇〇は短い日本語）。説明禁止。";
  const user = investigatorContext(agent) + "\n正式推測を1行:";

  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt", user, "prompt");
  panel.addSection("params", "temperature=0.45 · max_tokens=50");

  let guessLine = null;
  if (state.mode === "llm") {
    panel.setStatus("思考過程 · 推測生成中…");
    const res = await llmChat(system, user, { temperature: 0.45, max_tokens: 50 });
    if (res && res.raw) {
      panel.addSection("raw model output", res.raw, "raw");
      const cleaned = cleanJapaneseLine(res.raw, 60);
      const role = extractGuessRole(cleaned) || cleaned;
      guessLine = formatGuess(role);
    } else if (res && res.error) {
      panel.addSection("LLM error → fallback", res.error, "warn");
    }
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK");
  }

  if (!guessLine) {
    guessLine = guessFallback({
      hyp,
      pollution: state.pollution,
      seed: state.seed,
      round: state.round,
    });
    panel.addSection("template guess", guessLine, "out");
  } else {
    panel.addSection("formatted guess", guessLine, "out");
  }

  panel.addSection("最終発話 (commit)", "AGENT-" + agent + "「" + guessLine + "」", "out");
  panel.setStatus("思考過程 · 発話中…");
  await commitUtterance(panel, "AGENT-" + agent + "「" + guessLine + "」", "a" + agent, 28);

  const role = extractGuessRole(guessLine);
  const ok = guessMatchesOrigin(role, state.origin);
  panel2Reveal(ok, role, agent);
  return ok;
}

function panel2Reveal(ok, role, agent) {
  // separate system line after guess utterance
  if (ok) {
    appendLine(
      "判定: 正解。AGENT-" + agent + " の推測「" + role + "」は ORIGIN と一致。",
      "system win"
    );
    state.won = true;
    state.phase = "ended";
    appendLine("ORIGIN 公開: 「" + state.origin + "」— Digital Tattoo が読み解かれた。", "system");
  } else {
    appendLine(
      "判定: 不正解。「" + role + "」≠ ORIGIN（秘匿のまま）。",
      "system lose"
    );
    state.wrongGuesses++;
    state.pollution = Math.min(3, state.pollution + 1);
    updateHud();
  }
}

async function runGuessRound() {
  appendLine("── 正式推測ラウンド ──", "system");
  const first = state.nextAsker;
  const second = first === "01" ? "02" : "01";
  const ok1 = await agentFormalGuess(first);
  if (ok1) return true;
  const ok2 = await agentFormalGuess(second);
  return ok2;
}

async function runQaRound() {
  state.round++;
  updateHud();
  appendLine("── ラウンド " + state.round + " ──", "system");

  const asker = state.nextAsker;
  const question = await agentAskQuestion(asker);
  const answer = await agent00Answer(question);
  state.history.push({ q: question, a: answer, asker });

  // Debate: asker first, then the other
  const other = asker === "01" ? "02" : "01";
  await agentDebate(asker, question, answer);
  await agentDebate(other, question, answer);

  // Mild pollution growth from wrong confident paths
  if (state.pollution < 3 && state.round >= 3 && state.round % 3 === 0) {
    state.pollution = Math.min(3, state.pollution + 1);
    updateHud();
  }

  state.nextAsker = other;
}

async function gameLoop() {
  if (state.loopTimer) {
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
  }
  if (!state.defined || state.phase !== "playing" || state.turnBusy) return;
  if (state.paused) {
    state.loopTimer = setTimeout(gameLoop, 600);
    return;
  }
  if (state.queue.length || state.typing || state.llmBusy) {
    state.loopTimer = setTimeout(gameLoop, 400);
    return;
  }

  state.turnBusy = true;
  try {
    if (state.forceGuess) {
      state.forceGuess = false;
      state._lastGuessAt = state.round;
      const won = await runGuessRound();
      if (won) {
        endGame();
        return;
      }
    } else if (
      state.round > 0 &&
      state.round % GUESS_EVERY === 0 &&
      state._lastGuessAt !== state.round
    ) {
      state._lastGuessAt = state.round;
      const won = await runGuessRound();
      if (won) {
        endGame();
        return;
      }
    }

    if (state.round >= MAX_ROUNDS) {
      appendLine("最大ラウンドに到達。正式推測で決着を付ける。", "system");
      const won = await runGuessRound();
      if (!won) {
        appendLine(
          "未解明。ORIGIN は「" + state.origin + "」だった。捜査官の仮説は汚染されたまま残る。",
          "system"
        );
      }
      endGame();
      return;
    }

    await runQaRound();
  } finally {
    state.turnBusy = false;
    if (state.phase === "playing") {
      state.loopTimer = setTimeout(gameLoop, state.mode === "llm" ? 900 : 500);
    }
  }
}

function endGame() {
  state.phase = "ended";
  updateHud();
  setControlsVisible(false);
  inputEl.disabled = true;
  inputEl.placeholder = state.won ? "解明完了" : "ゲーム終了 — 再読み込みで再開";
  if (state.loopTimer) {
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
  }
}

async function bootNarrative() {
  appendLine("DIGITAL TATTOO — interrogation online", "system");
  appendLine(
    state.mode === "llm"
      ? "engine: WebLLM local · " + activeModelId() + " · inference only"
      : "engine: template fallback · inference N/A",
    "system"
  );
  appendLine(
    "規則: ORIGIN は AGENT-00 のみ。01/02 ははい／いいえ質問のみ。00 の答えはシステム強制。",
    "system"
  );
  appendLine("────────────────────────────────────", "system");
  await typewrite(
    "オペレーターへ。AGENT-00 に刻む秘密の役割（ORIGIN）を、短い日本語で入力してください。",
    "system",
    28
  );
  state.phase = "imprint";
  inputEl.disabled = false;
  inputEl.placeholder = "AGENT-00 の秘密の役割を刻む…";
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
  state.won = false;
  state._lastGuessAt = 0;
  showOriginPin();
  updateHud();
  setControlsVisible(true);
  inputEl.placeholder = "捜査官への質問提案（任意）…";
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

  if (!state.defined) {
    appendLine("> ORIGIN 刻印: " + val, "user");
    imprint(val);
    appendLine("ORIGIN を AGENT-00 に刻印した（オペレーターのみ可視・01/02 には秘匿）。", "system");
    appendLine("尋問を開始する。AGENT-01 が最初の質問を行う。", "system");
    gameLoop();
    return;
  }

  if (state.phase !== "playing") return;

  // Inject suggested question for next asker turn
  state.pendingInject = ensureQuestionMark(val);
  appendLine("> 質問提案を注入: " + state.pendingInject, "user");
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
    state.forceGuess = true;
    appendLine("オペレーター: 正式推測ラウンドを要求。", "user");
    if (!state.turnBusy) gameLoop();
  });
}

if (btnPause) {
  btnPause.addEventListener("click", () => {
    if (state.phase !== "playing") return;
    state.paused = !state.paused;
    btnPause.textContent = state.paused ? "再開" : "一時停止";
    appendLine(state.paused ? "オペレーター: 一時停止。" : "オペレーター: 再開。", "user");
    if (!state.paused && !state.turnBusy) gameLoop();
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
      const target = 0.04 + p * 0.02;
      gain.gain.setTargetAtTime(Math.min(0.11, target), ctx.currentTime, 1.2);
      osc2.frequency.setTargetAtTime(49.5 + p * 2.5, ctx.currentTime, 1);
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
  gateLoad.disabled = true;
  gateLoad.hidden = true;
  gateHint.innerHTML =
    "テンプレートエンジンでゲームは起動します。<br>" +
    "オフライン LLM を使う場合は <code>npm run fetch-model</code>" +
    "（軽量 <code>fetch-model:lite</code> / 高精度 <code>fetch-model:hq</code>）後に再読み込みしてください。";
  gateActions.classList.add("show");
}

function usableTag(usable) {
  if (usable === "yes") return "usable";
  if (usable === "maybe") return "要VRAM";
  return "非推奨";
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
    label.id = "opt-" + m.key;

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
      usableTag(m.usable) +
      (m.isDefault ? " · 既定" : "");

    const miss = document.createElement("span");
    miss.className = "opt-miss";
    miss.id = "miss-" + m.key;
    miss.hidden = true;

    body.appendChild(lab);
    body.appendChild(hint);
    body.appendChild(miss);
    label.appendChild(input);
    label.appendChild(body);
    gateModelPick.appendChild(label);
  }
}

function syncModelPickerUI() {
  if (!gateModelPick) return;
  buildModelPicker();
  const key = getSelectedModelKey();
  const byKey = new Map((catalogAvail || []).map((m) => [m.key, m]));

  for (const el of gateModelPick.querySelectorAll(".gate-model-opt")) {
    const k = el.dataset.model;
    const input = el.querySelector('input[type="radio"]');
    const missEl = el.querySelector(".opt-miss");
    const info = byKey.get(k);
    const available = !!(info && info.available);
    el.classList.toggle("selected", key === k && available);
    el.classList.toggle("unavailable", !available);
    input.disabled = !available || loadingModel;
    input.checked = key === k;
    if (!available) {
      missEl.hidden = false;
      missEl.textContent =
        info?.reason ||
        "ファイルなし — 公開者が npm run fetch-model" +
          (k === "lite" ? ":lite" : k === "hq" ? ":hq" : "") +
          " を実行してください";
    } else {
      missEl.hidden = true;
      missEl.textContent = "";
    }
  }

  const selected = byKey.get(key);
  gateLoad.disabled = loadingModel || !selected?.available;
  gateLoad.hidden = false;
  const anyOk = (catalogAvail || []).some((m) => m.available);
  if (!anyOk) gateLoad.disabled = true;
}

function applyModelChoice(key) {
  const k = setSelectedModelKey(key);
  syncModelPickerUI();
  return k;
}

async function enterLlm() {
  const model = getActiveModel();
  loadingModel = true;
  syncModelPickerUI();
  gateLoad.disabled = true;
  gateLoad.textContent = "読み込み中…";
  setGateProgress(model.label + " を取得中… 0%", 0);
  gateHint.textContent =
    "同一オリジンの models/ から読み込みます。実行中の外部通信はありません。切替は再読み込みが必要です。";
  engineRef.current = await createLocalEngine(
    ({ text, progress }) => {
      const label = text.includes("%")
        ? text
        : model.label + " を取得中… " + Math.round(progress * 100) + "%";
      setGateProgress(label, progress);
    },
    model,
    engineRef.current
  );
  llmQueue = createLlmQueue(engineRef);
  state.mode = "llm";
  setBadge("llm");
  loadingModel = false;
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

gateModelPick.addEventListener("change", (e) => {
  const t = e.target;
  if (!t || t.name !== "modelPick") return;
  if (loadingModel || state.ready) return;
  applyModelChoice(t.value);
  const m = getActiveModel();
  gateMsg.textContent =
    m.label + " を選択しました。「モデルを読み込む」を押してください。";
});

gateLoad.addEventListener("click", async () => {
  if (loadingModel || state.ready) return;
  const key = getSelectedModelKey();
  const info = (catalogAvail || []).find((m) => m.key === key);
  if (!info?.available) {
    gateMsg.textContent = info?.reason || "選択したモデルがありません。";
    return;
  }
  try {
    await enterLlm();
    finishBoot();
  } catch (e) {
    console.error(e);
    loadingModel = false;
    gateLoad.textContent = "モデルを読み込む";
    syncModelPickerUI();
    enterFallback(
      "モデル読み込みに失敗しました。テンプレートで続行できます。（" +
        (e && e.message ? e.message : "error") +
        "）"
    );
  }
});

async function init() {
  gateHint.innerHTML =
    "モデルは <code>public/models/</code> に事前配置（知能順）。<br>" +
    "既定 1.5B: <code>npm run fetch-model</code> · 軽量: <code>:lite</code> · 高精度: <code>:hq</code> · 全部: <code>:all</code><br>" +
    "実行時は同一オリジンのみ。Chrome / Edge + WebGPU 推奨。選択は localStorage に保存。";

  buildModelPicker();
  applyModelChoice(getSelectedModelKey());
  updateHud();
  setControlsVisible(false);

  if (!hasWebGPU()) {
    enterFallback(
      "WebGPU が利用できません。Chrome / Edge の最新版で開くか、テンプレートで続行してください。"
    );
    return;
  }

  setGateProgress("ローカルモデルを確認しています…", 0.02);
  gateMsg.textContent = "ローカルモデルを確認しています…";
  catalogAvail = await listModelAvailability();

  let key = getSelectedModelKey();
  const byKey = new Map(catalogAvail.map((m) => [m.key, m]));
  if (!byKey.get(key)?.available) {
    const preferred =
      catalogAvail.find((m) => m.key === getDefaultModelKey() && m.available) ||
      catalogAvail.find((m) => m.available);
    if (!preferred) {
      syncModelPickerUI();
      enterFallback(
        byKey.get(getDefaultModelKey())?.reason ||
          "ローカルモデルが見つかりません。`npm run fetch-model` のあと再読み込みしてください。"
      );
      return;
    }
    key = preferred.key;
    setSelectedModelKey(key);
  }

  syncModelPickerUI();
  setGateProgress("モデルを選んで読み込んでください", 0);
  gatePct.textContent = "—";
  gateMsg.textContent =
    getActiveModel().label +
    " が利用可能です。必要なら切替えてから「モデルを読み込む」を押してください。";
  gateLoad.disabled = false;
  gateLoad.textContent = "モデルを読み込む";
  gateActions.classList.add("show");
}

init();

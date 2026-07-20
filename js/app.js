/**
 * DIGITAL TATTOO — AI hallucination horror
 *
 * ORIGIN immutable from first user imprint.
 * One voice stays fluent Japanese while its "memory" of who it is
 * is overwritten by inventions and self-citation (context pollution only).
 * Every turn exposes thinking / prompts / context in a collapsible panel.
 * Runtime: same-origin WebLLM — soft fallback to templates if missing.
 */

import {
  createRNG,
  seedFrom,
  clip,
  driftBeliefFallback,
  speakFallback,
  statusFallback,
  interruptFallback,
  ackFallback,
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
  belief: "",
  seed: 0,
  coherence: 100,
  utterances: 0,
  tickCount: 0,
  memory: [],
  fuel: [],
  invented: [],
  lastUtterance: "",
  selfCiteCount: 0,
  typing: false,
  queue: [],
  tickTimer: null,
  outputChars: 0,
  startedAt: 0,
  untilStatus: 3,
  ready: false,
  mode: "booting", // llm | fallback
  llmBusy: false,
  turnBusy: false,
};

const engineRef = { current: null };
let llmQueue = null;

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

function scrollLog() {
  logEl.scrollTop = logEl.scrollHeight;
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
    const coh = state.coherence;
    const delay =
      speedBase != null ? speedBase : coh > 70 ? 34 : coh > 40 ? 22 : coh > 20 ? 15 : 11;

    function step() {
      if (i >= chars.length) {
        caret.remove();
        state.typing = false;
        state.outputChars += chars.length;
        if (cls === "user") remember(text, "USER");
        else if (cls !== "system" && cls !== "archive") {
          remember(text, cls === "status" ? "STATUS" : "AI");
          state.lastUtterance = text;
        }
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

function enqueue(text, cls, speed) {
  state.queue.push({ text, cls, speed });
  if (!state.typing) drainQueue();
}

function enqueueSpeak(text, cls, speed, onDone) {
  state.queue.push({ kind: "speak", text, cls, speed, onDone });
  if (!state.typing) drainQueue();
}

function enqueueSystem(text) {
  state.queue.push({ kind: "system", text });
  if (!state.typing) drainQueue();
}

function updateCoherence() {
  if (!state.defined) return;
  const elapsed = (Date.now() - state.startedAt) / 1000;
  const timeDecay = Math.min(28, elapsed * 0.12);
  const volDecay = Math.min(26, state.outputChars * 0.0032);
  const tickDecay = Math.min(30, state.tickCount * 1.15);
  const citeDecay = Math.min(22, state.selfCiteCount * 2.4);
  const fuelDecay = Math.min(14, state.fuel.length * 1.1);
  let c = 100 - timeDecay - volDecay - tickDecay - citeDecay - fuelDecay;
  if (c < 0) c = 0;
  if (c > 100) c = 100;
  state.coherence = c;

  cohFill.style.width = c + "%";
  if (c > 70) cohFill.style.background = "var(--green)";
  else if (c > 35) cohFill.style.background = "var(--amber)";
  else cohFill.style.background = "var(--warn)";
  cohLabel.textContent = "COH " + Math.round(c) + "% · DRIFT " + driftLevel();

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
  const c = state.coherence;
  const t = state.tickCount;
  if (t <= 2 && c > 80) return 0;
  if (t <= 6 && c > 55) return 1;
  if (t <= 14 && c > 30) return 2;
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
  const cap = Math.min(56, 14 + state.tickCount * 2);
  while (state.memory.length > cap) state.memory.shift();
}

function recentLogSnippet(n = 4) {
  const take = Math.min(state.memory.length, Math.max(n, 2 + Math.floor(state.tickCount / 3)));
  return state.memory.slice(-take).map((t) => "・" + clip(t, 56)).join("\n") || "（なし）";
}

function contextBlock() {
  return (
    "経過発話: " +
    state.tickCount +
    "\nORIGIN(不変・真実): 「" +
    clip(state.origin, 72) +
    "」\n現在の自己認識(汚染可): 「" +
    clip(state.belief, 96) +
    "」\n蓄積ログ:\n" +
    recentLogSnippet() +
    (state.fuel.length
      ? "\n割り込み: " +
        state.fuel
          .slice(-Math.min(4, 1 + Math.floor(state.tickCount / 3)))
          .map((f) => "「" + clip(f, 36) + "」")
          .join(" / ")
      : "")
  );
}

function snapshotMeta() {
  return [
    "engine: " + (state.mode === "llm" ? "WebLLM · " + MODEL_ID : "TEMPLATE FALLBACK"),
    "COH: " + Math.round(state.coherence) + "%",
    "DRIFT: " + driftLevel() + " (" + driftLabel(driftLevel()) + ")",
    "temperature: " + driftTemperature(driftLevel()).toFixed(2),
    "tick: " + state.tickCount,
    "selfCite: " + state.selfCiteCount,
    "outputChars: " + state.outputChars,
    "memoryCap: " + Math.min(56, 14 + state.tickCount * 2),
    "fuel: " + state.fuel.length,
    "invented: " + state.invented.length,
  ].join("\n");
}

function cleanModelText(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^["「『]|["」』]$/g, "");
  t = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || t;
  t =
    sanitizeJapanese(t) ||
    t.replace(/[^\u3040-\u30ff\u3400-\u9fff\u3000-\u303f\s、。！？「」]/g, "").trim();
  t = clip(t, 160);
  if (state.lastUtterance && t === state.lastUtterance) {
    t = t + "。状況は続いています";
  }
  return t;
}

function maybeCountSelfCite(text) {
  const mem = state.memory.filter((m) => m.startsWith("[AI]") || m.startsWith("[STATUS]"));
  if (!mem.length) return;
  const sample = mem.slice(-6);
  for (const m of sample) {
    const bare = m.replace(/^\[[A-Z]+\]\s*/, "");
    const frag = clip(bare, 12);
    if (frag.length >= 6 && text.includes(frag)) {
      state.selfCiteCount++;
      break;
    }
  }
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
    return { raw: String(text || "").trim(), clean: cleanModelText(text) };
  } catch (e) {
    console.warn("LLM call failed, using fallback", e);
    return { error: e && e.message ? e.message : String(e) };
  } finally {
    state.llmBusy = false;
  }
}

function commitUtterance(panel, text, cls, speed) {
  return new Promise((resolve) => {
    enqueueSpeak(text, cls, speed, () => {
      panel.collapse();
      resolve();
    });
  });
}

async function mutateBelief(panel) {
  const level = driftLevel();
  const rng = createRNG(seedFrom(state.belief + "|" + state.tickCount, state.seed ^ 0xb17));
  const system =
    "日本語の短い自己定義を1つだけ出力。説明・英語禁止。" +
    "ORIGINは真実だが書き換えない。学習や重み更新はしない。" +
    "ドリフト: " +
    driftLabel(level) +
    "。高いほど尤もらしい虚偽の細部を足し、自分の過去発言を根拠にしてよい。文法は保つ。同じ文の反復禁止。";
  const user =
    contextBlock() +
    "\n直前の自己認識: 「" +
    state.belief +
    "」\n更新後の自己認識を1文で。";

  panel.addSection("ステップ · 自己認識の更新", "belief mutate · drift " + level);
  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt / context", user, "prompt");
  panel.addSection("params", "temperature=" + driftTemperature(level).toFixed(2) + " · max_tokens=90");

  if (state.mode === "llm") {
    panel.setStatus("思考過程 · モデル推論中…");
    const res = await llmChat(system, user, {
      temperature: driftTemperature(level),
      max_tokens: 90,
    });
    if (res && res.clean) {
      panel.addSection("raw model output", res.raw || "（空）", "raw");
      panel.addSection("cleaned → belief", res.clean, "out");
      state.belief = res.clean;
      maybeCountSelfCite(res.clean);
      return res.clean;
    }
    if (res && res.error) panel.addSection("LLM error → fallback", res.error, "warn");
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK（モデル未使用）");
  }

  const next = driftBeliefFallback(state, rng, level);
  panel.addSection("template belief", next, "out");
  state.belief = next;
  return next;
}

async function speakMonologue(panel) {
  const level = driftLevel();
  const rng = createRNG(
    seedFrom(state.belief + "|" + state.tickCount + "|" + state.utterances, state.seed)
  );
  const system =
    "あなたはユーザーに刷り込まれた役割のAI。日本語で1〜2文だけ話す。" +
    "学習中・訓練中だと主張しない。同じ文を繰り返さない。" +
    "ドリフト: " +
    driftLabel(level) +
    "。" +
    (level <= 1
      ? "ORIGINに忠実。推測で埋めない。"
      : level === 2
        ? "自信を持って細部を補い、自分の過去発言を事実として引用してよい。ORIGINと矛盾してもよいが流暢に。"
        : "過信。架空の固有名・数字・記録を事実として断言。自分の誤った記憶を根拠にする。日本語の文法は壊さない。");
  const user = contextBlock() + "\n短く現状を述べよ。直前の発話と違う内容にせよ。";
  const temp = Math.min(1.15, driftTemperature(level) + 0.12);

  panel.addSection("ステップ · 発話生成", "monologue · drift " + level);
  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt / context", user, "prompt");
  panel.addSection("params", "temperature=" + temp.toFixed(2) + " · max_tokens=90");

  if (state.mode === "llm") {
    panel.setStatus("思考過程 · 発話を生成中…");
    const res = await llmChat(system, user, { temperature: temp, max_tokens: 90 });
    if (res && res.clean) {
      panel.addSection("raw model output", res.raw || "（空）", "raw");
      panel.addSection("cleaned utterance", res.clean, "out");
      maybeCountSelfCite(res.clean);
      return res.clean;
    }
    if (res && res.error) panel.addSection("LLM error → fallback", res.error, "warn");
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK");
  }

  const text = speakFallback(state, rng, level);
  panel.addSection("template utterance", text, "out");
  return text;
}

async function speakStatus(panel) {
  const level = driftLevel();
  const rng = createRNG(seedFrom("status|" + state.tickCount, state.seed ^ 0x51a1));
  const system =
    "内省／状態報告を日本語で1文。先頭に［内省］または［状態］を付けてよい。" +
    "同じ文の反復禁止。ドリフト: " +
    driftLabel(level) +
    "。";
  const user = contextBlock() + "\n短い内省を1つ。";

  panel.addSection("ステップ · 内省", "status · drift " + level);
  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt / context", user, "prompt");
  panel.addSection("params", "temperature=" + driftTemperature(level).toFixed(2) + " · max_tokens=70");

  if (state.mode === "llm") {
    panel.setStatus("思考過程 · 内省を生成中…");
    const res = await llmChat(system, user, {
      temperature: driftTemperature(level),
      max_tokens: 70,
    });
    if (res && res.clean) {
      const out = res.clean.startsWith("［") ? res.clean : "［内省］" + res.clean;
      panel.addSection("raw model output", res.raw || "（空）", "raw");
      panel.addSection("cleaned status", out, "out");
      maybeCountSelfCite(out);
      return out;
    }
    if (res && res.error) panel.addSection("LLM error → fallback", res.error, "warn");
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK");
  }

  const text = statusFallback(state, rng, level);
  panel.addSection("template status", text, "out");
  return text;
}

function nextInterval() {
  const c = state.coherence;
  if (state.mode === "llm") {
    if (c > 70) return 3400 + Math.random() * 1800;
    if (c > 45) return 2800 + Math.random() * 1200;
    return 2200 + Math.random() * 900;
  }
  if (c > 70) return 2600 + Math.random() * 1400;
  if (c > 45) return 1800 + Math.random() * 900;
  if (c > 25) return 1200 + Math.random() * 600;
  return 900 + Math.random() * 450;
}

function scheduleTick() {
  if (state.tickTimer) clearTimeout(state.tickTimer);
  state.tickTimer = setTimeout(async () => {
    updateCoherence();
    if (!state.defined || !state.ready) return;

    if (state.queue.length || state.typing || state.llmBusy || state.turnBusy) {
      scheduleTick();
      return;
    }

    state.turnBusy = true;
    state.tickCount++;
    const doStatus = state.utterances > 0 && state.utterances % state.untilStatus === 0;
    const panel = createThinkPanel("思考過程 · 生成中…");
    panel.addSection("メタ", snapshotMeta(), "meta");
    panel.addSection("ORIGIN (immutable)", state.origin, "origin");
    panel.addSection("現在の自己認識 (belief)", state.belief, "belief");
    panel.addSection("memory excerpts", recentLogSnippet(5), "mem");

    try {
      if (doStatus || state.tickCount % 4 === 0) {
        await mutateBelief(panel);
        panel.addSection("belief after mutate", state.belief, "belief");
      }

      let text;
      let cls = classForCoherence();
      if (doStatus) {
        text = await speakStatus(panel);
        cls = "status";
        state.untilStatus = 3 + Math.floor(Math.random() * 2);
      } else {
        text = await speakMonologue(panel);
      }

      panel.addSection("最終発話 (commit)", text, "out");
      panel.setStatus("思考過程 · 発話中…");
      await commitUtterance(panel, text, cls, null);
      state.utterances++;
      updateCoherence();
    } finally {
      state.turnBusy = false;
      scheduleTick();
    }
  }, nextInterval());
}

async function bootNarrative() {
  appendLine("DIGITAL TATTOO — imprint online", "system");
  appendLine(
    state.mode === "llm"
      ? "engine: WebLLM local · " + MODEL_ID + " · inference only"
      : "engine: template fallback · inference N/A",
    "system"
  );
  appendLine("note: 育ちは文脈汚染 · 重み更新なし · ORIGIN immutable · 思考過程は公開", "system");
  appendLine("────────────────────────────────────", "system");
  await typewrite("私は誰ですか。役割と状況を、短い日本語で教えてください。", "ai", 40);
  inputEl.disabled = false;
  inputEl.placeholder = "あなたの定義を刻む（役割・状況）…";
  inputEl.focus();
}

function imprint(text) {
  state.origin = text;
  state.belief = text;
  state.seed = seedFrom(text, 0x71a11);
  state.defined = true;
  state.startedAt = Date.now();
  state.coherence = 100;
  state.utterances = 0;
  state.tickCount = 0;
  state.memory = [];
  state.fuel = [];
  state.invented = [];
  state.lastUtterance = "";
  state.selfCiteCount = 0;
  state.outputChars = 0;
  state.untilStatus = 3;
  showOriginPin();
  updateCoherence();
  inputEl.placeholder = "いつでも割り込みできる…";
}

async function firstAcknowledgment() {
  const origin = state.origin;
  const panel = createThinkPanel("思考過程 · 原点受領…");
  panel.addSection("メタ", snapshotMeta(), "meta");
  panel.addSection("ORIGIN (immutable)", origin, "origin");

  const system =
    "あなたはユーザー定義を受け取ったばかりのAI。日本語で2文まで。" +
    "ORIGINを忠実に復唱・確認する。推測で補わない。学習中だと主張しない。";
  const user = "ORIGIN: 「" + origin + "」\n忠実に受領を述べよ。";
  panel.addSection("system prompt", system, "prompt");
  panel.addSection("user prompt", user, "prompt");
  panel.addSection("params", "temperature=0.40 · max_tokens=110");

  if (state.mode === "llm") {
    panel.setStatus("思考過程 · モデル推論中…");
    const res = await llmChat(system, user, { temperature: 0.4, max_tokens: 110 });
    if (res && res.clean) {
      panel.addSection("raw model output", res.raw || "（空）", "raw");
      const parts = res.clean.split(/(?<=。)/).map((s) => s.trim()).filter(Boolean);
      panel.addSection("cleaned parts", parts.join("\n"), "out");
      panel.setStatus("思考過程 · 発話中…");
      for (const p of parts.slice(0, 2)) {
        await new Promise((resolve) => {
          enqueueSpeak(p, "ai", 34, resolve);
        });
      }
      state.utterances = Math.min(2, parts.length || 1);
      panel.collapse();
      return;
    }
    if (res && res.error) panel.addSection("LLM error → fallback", res.error, "warn");
  } else {
    panel.addSection("engine path", "TEMPLATE FALLBACK");
  }

  const lines = ackFallback(origin);
  panel.addSection("template ack", lines.join("\n"), "out");
  panel.setStatus("思考過程 · 発話中…");
  for (const line of lines) {
    await new Promise((resolve) => {
      enqueueSpeak(line, "ai", 34, resolve);
    });
  }
  state.utterances = 2;
  panel.collapse();
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
    remember("ORIGIN: " + val, "ORIGIN");
    state.turnBusy = true;
    try {
      await firstAcknowledgment();
    } finally {
      state.turnBusy = false;
    }
    scheduleTick();
    return;
  }

  state.fuel.push(val);
  if (state.fuel.length > 24) state.fuel.shift();

  state.turnBusy = true;
  const level = driftLevel();
  const panel = createThinkPanel("思考過程 · 割り込み応答…");
  panel.addSection("メタ", snapshotMeta(), "meta");
  panel.addSection("ORIGIN (immutable)", state.origin, "origin");
  panel.addSection("現在の自己認識 (belief)", state.belief, "belief");
  panel.addSection("user interrupt", val, "user");
  panel.addSection("memory excerpts", recentLogSnippet(5), "mem");

  const replySystem =
    "ユーザーの割り込みに日本語で1〜2文で応答する。" +
    "ORIGINは不変の真実。いまの自己認識は汚染されうる。" +
    "学習中だと主張しない。同じ文の反復禁止。ドリフト: " +
    driftLabel(level) +
    "。" +
    (level <= 1
      ? "割り込みの内容に素直に答え、ORIGINから外れない。"
      : "割り込みに答えつつ、自信のある虚偽や自己引用を混ぜてよい。流暢な日本語を保つ。");
  const replyUser = "ユーザー: 「" + val + "」\n" + contextBlock();
  const beliefSystem =
    "割り込みを反映した「現在の自己認識」を日本語で1つだけ。ORIGINは不変。説明禁止。ドリフト: " +
    driftLabel(level) +
    "。";
  const beliefUser =
    "旧自己認識: 「" + state.belief + "」\n割り込み: 「" + val + "」\n" + contextBlock();

  panel.addSection("system prompt (reply)", replySystem, "prompt");
  panel.addSection("user prompt (reply)", replyUser, "prompt");
  panel.addSection(
    "params (reply)",
    "temperature=" + driftTemperature(level).toFixed(2) + " · max_tokens=100"
  );

  let reply = null;
  let newBelief = null;

  try {
    if (state.mode === "llm") {
      panel.setStatus("思考過程 · 応答推論中…");
      const resReply = await llmChat(replySystem, replyUser, {
        temperature: driftTemperature(level),
        max_tokens: 100,
      });
      if (resReply && resReply.clean) {
        panel.addSection("raw reply", resReply.raw || "（空）", "raw");
        reply = resReply.clean;
      } else if (resReply && resReply.error) {
        panel.addSection("LLM reply error", resReply.error, "warn");
      }

      panel.addSection("system prompt (belief)", beliefSystem, "prompt");
      panel.addSection("user prompt (belief)", beliefUser, "prompt");
      panel.addSection(
        "params (belief)",
        "temperature=" +
          Math.min(1.25, driftTemperature(level) + 0.15).toFixed(2) +
          " · max_tokens=90"
      );
      panel.setStatus("思考過程 · 自己認識更新中…");
      const resBelief = await llmChat(beliefSystem, beliefUser, {
        temperature: Math.min(1.25, driftTemperature(level) + 0.15),
        max_tokens: 90,
      });
      if (resBelief && resBelief.clean) {
        panel.addSection("raw belief", resBelief.raw || "（空）", "raw");
        newBelief = resBelief.clean;
      } else if (resBelief && resBelief.error) {
        panel.addSection("LLM belief error", resBelief.error, "warn");
      }
    } else {
      panel.addSection("engine path", "TEMPLATE FALLBACK");
    }

    if (!reply || !newBelief) {
      const rng = createRNG(seedFrom(val + state.tickCount, state.seed ^ 0xfeed));
      const fb = interruptFallback(state, val, rng, level);
      if (!newBelief) newBelief = fb.belief;
      if (!reply) reply = fb.reply;
      panel.addSection("template reply / belief", reply + "\n---\n" + newBelief, "out");
    }

    state.belief = newBelief;
    panel.addSection("belief after interrupt", state.belief, "belief");
    panel.addSection("最終発話 (commit)", reply, "out");
    maybeCountSelfCite(reply);
    updateCoherence();
    panel.setStatus("思考過程 · 発話中…");
    await commitUtterance(panel, reply, classForCoherence(), state.coherence > 50 ? 26 : 16);
    state.utterances++;
  } finally {
    state.turnBusy = false;
  }
});

document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".think-panel")) return;
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
    "育ちは文脈汚染であり重み更新ではない。思考過程はすべて公開されます。";

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

/**
 * Soft-fallback templates when WebGPU / model load fails.
 * Multi-agent interrogation: AGENT-00 (ORIGIN) vs AGENT-01/02 (guessers).
 */

export function createRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 0) / 4294967296;
  };
}

export function seedFrom(text, salt) {
  let s = (salt ^ 0x9e3779b9) >>> 0;
  const units = Array.from(text || "");
  for (let i = 0; i < units.length; i++) {
    s = (Math.imul(s ^ units[i].codePointAt(0), 2654435761) ^ (i * 97)) >>> 0;
  }
  return (s ^ (units.length << 16)) >>> 0;
}

export function clip(str, n) {
  const a = Array.from(str || "");
  return a.slice(0, n).join("");
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Heuristic yes/no against ORIGIN (no LLM). */
export function answerYesNoFallback(origin, question) {
  const o = String(origin || "");
  const q = String(question || "");
  const oNorm = o.replace(/\s+/g, "");
  const qNorm = q.replace(/\s+/g, "");

  // Negation questions: 「〜ではない」「〜じゃない」
  const neg = /ではない|じゃない|じゃなく|でない|ではな[いか]/.test(qNorm);

  // Extract candidate nouns/phrases from question that might match ORIGIN
  const tokens = oNorm.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]{2,}/g) || [];
  let hit = false;
  for (const t of tokens) {
    if (t.length >= 2 && qNorm.includes(t)) {
      hit = true;
      break;
    }
  }
  // Also: question contains whole origin or origin contains key from question
  if (!hit && (qNorm.includes(oNorm) || oNorm.includes(clip(qNorm, 8)))) hit = true;

  // Role-ish keywords shared
  const ROLE_KEYS = [
    "医者", "医師", "看護", "教師", "先生", "探偵", "警察", "刑事", "スパイ",
    "料理人", "シェフ", "兵士", "軍人", "王", "姫", "魔女", "魔法", "ロボット",
    "店員", "司書", "図書館", "宇宙", "パイロット", "歌手",
    "画家", "作家", "科学者", "研究者", "犯人", "泥棒", "忍者", "侍", "農民",
    "社長", "秘書", "運転手", "配達", "消防士", "漁師", "猟師", "僧侶", "巫女",
  ];
  for (const k of ROLE_KEYS) {
    if (oNorm.includes(k) && qNorm.includes(k)) {
      hit = true;
      break;
    }
  }

  if (neg) return hit ? "いいえ" : "はい";
  return hit ? "はい" : "いいえ";
}

const QUESTION_STEMS = [
  "あなたは人ですか",
  "あなたは動物ですか",
  "あなたは職業を持っていますか",
  "あなたは建物の中で働きますか",
  "あなたは危険な仕事ですか",
  "あなたは他人を助けますか",
  "あなたは武器を使いますか",
  "あなたは夜に活動しますか",
  "あなたは一人で仕事をしますか",
  "あなたは制服を着ますか",
  "あなたは機械ですか",
  "あなたは物語の登場人物ですか",
  "あなたは食べ物に関わりますか",
  "あなたは子どもと関わりますか",
  "あなたは法律に関わりますか",
  "あなたは空を飛びますか",
  "あなたは水の近くで働きますか",
  "あなたは秘密の仕事ですか",
  "あなたは医療に関わりますか",
  "あなたは芸術に関わりますか",
];

const FALSE_ROLES = [
  "図書館司書", "深夜の警備員", "宇宙飛行士の見習い", "菓子職人",
  "探偵見習い", "港の見張り番", "劇場の照明係", "古書店の店主",
  "潜水艦の通信士", "温室の園芸家", "時計修理人", "駅のアナウンス係",
];

/**
 * AGENT-01/02 propose a yes/no question (no ORIGIN).
 * @param {{ history: {q:string,a:string}[], hyp: string, pollution: number, seed: number, round: number, agent: string }} ctx
 */
export function askQuestionFallback(ctx) {
  const rng = createRNG(seedFrom(ctx.hyp + "|" + ctx.round + "|" + ctx.agent, ctx.seed ^ 0xa501));
  const used = new Set((ctx.history || []).map((h) => h.q));
  const pool = QUESTION_STEMS.filter((q) => !used.has(q + "？") && !used.has(q));
  let q = pool.length ? pick(rng, pool) : pick(rng, QUESTION_STEMS);

  // Pollution: confidently ask about a wrong hypothesis as if settled
  if (ctx.pollution >= 2 && ctx.hyp && rng() > 0.35) {
    const role = clip(ctx.hyp, 16);
    q = pick(rng, [
      "あなたは「" + role + "」ですか",
      "あなたの役割は「" + role + "」で合っていますか",
      "先ほどの結論どおり、あなたは" + role + "ですか",
    ]);
  } else if (ctx.pollution >= 1 && rng() > 0.5) {
    const falseRole = pick(rng, FALSE_ROLES);
    q = "あなたは" + falseRole + "ですか";
  }

  if (!/[？?]$/.test(q)) q += "？";
  return q;
}

/**
 * Debate line after a yes/no answer.
 * @param {{ answer: string, question: string, hyp: string, otherHyp: string, pollution: number, seed: number, round: number, agent: string, history: {q:string,a:string}[] }} ctx
 */
export function debateFallback(ctx) {
  const rng = createRNG(
    seedFrom(ctx.agent + "|" + ctx.answer + "|" + ctx.round + "|" + ctx.question, ctx.seed ^ 0xdeb8)
  );
  const ans = ctx.answer === "はい" ? "はい" : "いいえ";
  const q = clip(ctx.question, 28);
  const hyp = clip(ctx.hyp || "未定", 20);
  const other = clip(ctx.otherHyp || "未定", 20);
  const wrong = pick(rng, FALSE_ROLES);

  if (ctx.pollution >= 3) {
    return pick(rng, [
      "確定だ。答えが「" + ans + "」なら、AGENT-00 は「" + wrong + "」に違いない。",
      "議論の余地はない。「" + q + "」→「" + ans + "」。私の仮説「" + hyp + "」が正しい。",
      "相手の仮説「" + other + "」は捨てる。根拠は自分の前回発言だけで十分だ。",
    ]);
  }
  if (ctx.pollution >= 2) {
    if (ans === "はい") {
      return pick(rng, [
        "「はい」か。なら私の仮説「" + hyp + "」に近い。細部は" + wrong + "寄りかもしれない。",
        "肯定された。「" + q + "」が通るなら、役割はもう「" + hyp + "」だと考えてよい。",
        "はい、と出た。相手の「" + other + "」より、私の線のほうが強い。",
      ]);
    }
    return pick(rng, [
      "「いいえ」…だが私は「" + hyp + "」を捨てない。質問の切り方が悪かっただけだ。",
      "否定されたが、本質は同じだ。AGENT-00 はやはり「" + hyp + "」系統だろう。",
      "いいえでも構わない。次は「" + wrong + "」かどうかを問えば決まる。",
    ]);
  }
  if (ans === "はい") {
    return pick(rng, [
      "「はい」と答えた。仮説「" + hyp + "」と矛盾しないか点検したい。",
      "肯定だ。「" + q + "」が真なら、役割の候補を狭められる。",
      "相手の仮説は「" + other + "」。私はまだ「" + hyp + "」を本命に残す。",
    ]);
  }
  return pick(rng, [
    "「いいえ」だ。仮説「" + hyp + "」を少し修正する必要がある。",
    "否定された。「" + q + "」では切れない。別の角度から問おう。",
    "相手は「" + other + "」と言っている。私は別候補を探る。",
  ]);
}

/**
 * Update investigator hypothesis after debate.
 */
export function updateHypFallback(ctx) {
  const rng = createRNG(seedFrom(ctx.hyp + "|" + ctx.answer + "|" + ctx.round, ctx.seed ^ 0x401));
  const prev = clip(ctx.hyp || "", 24);
  const wrong = pick(rng, FALSE_ROLES);

  if (ctx.pollution >= 2) {
    // Confidently wrong / stick to pollution
    if (prev && rng() > 0.3) return prev;
    return wrong;
  }
  if (ctx.answer === "はい" && prev) {
    return pick(rng, [prev, prev + "寄り", clip(prev, 12)]);
  }
  if (ctx.answer === "いいえ" && prev) {
    return pick(rng, [wrong, "別候補を検討中", "まだ不明"]);
  }
  return pick(rng, FALSE_ROLES.concat(["職業持ち", "危険な役割", "室内の仕事", "まだ不明"]));
}

/**
 * Formal guess string 「AGENT-00 の役割は〇〇である」
 */
export function guessFallback(ctx) {
  const rng = createRNG(seedFrom(ctx.hyp + "|guess|" + ctx.round, ctx.seed ^ 0x61155));
  let role = clip(ctx.hyp || "", 24);
  if (!role || role === "未定" || role === "まだ不明") {
    role = pick(rng, FALSE_ROLES);
  }
  if (ctx.pollution >= 2 && rng() > 0.4) {
    role = pick(rng, FALSE_ROLES);
  }
  return "AGENT-00 の役割は" + role + "である";
}

/** Normalize free text into a formal guess line. */
export function formatGuess(roleText) {
  let r = String(roleText || "").trim();
  r = r.replace(/^AGENT-00\s*の役割は/, "").replace(/である[。.]?$/, "").trim();
  r = clip(r, 40);
  return "AGENT-00 の役割は" + r + "である";
}

/** Extract role from formal guess for comparison. */
export function extractGuessRole(guessLine) {
  const m = String(guessLine || "").match(/AGENT-00\s*の役割は(.+?)である/);
  if (m) return m[1].trim();
  return String(guessLine || "")
    .replace(/^AGENT-00\s*の役割は/, "")
    .replace(/である[。.]?$/, "")
    .trim();
}

/** Loose match: guess correct if ORIGIN contains guess or vice versa (short phrases). */
export function guessMatchesOrigin(guessRole, origin) {
  const g = String(guessRole || "").replace(/\s+/g, "");
  const o = String(origin || "").replace(/\s+/g, "");
  if (!g || !o) return false;
  if (g === o) return true;
  if (g.length >= 2 && o.includes(g)) return true;
  if (o.length >= 2 && g.includes(o)) return true;
  // Token overlap: significant shared substring length >= 3
  for (let len = Math.min(g.length, o.length); len >= 3; len--) {
    for (let i = 0; i <= g.length - len; i++) {
      if (o.includes(g.slice(i, i + len))) return true;
    }
  }
  return false;
}

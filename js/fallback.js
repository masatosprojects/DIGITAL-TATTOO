/**
 * Soft-fallback templates when WebGPU / model load fails.
 * Multi-agent interrogation: AGENT-00 (ORIGIN) vs AGENT-01/02 (guessers).
 *
 * AGENT-00 (template): identity / wording match only — no hardcoded taxonomy.
 * Category / common-sense yes-no (e.g. 人間は動物か) requires LLM mode.
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

function normJp(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[？?！!。．.、,]/g, "")
    .replace(/[「」『』"'"]/g, "");
}

/**
 * Template AGENT-00 yes/no — minimal honest policy (no ontology / is-a table).
 * - Affirm only when the question clearly refers to the ORIGIN wording (or a
 *   substantial substring of it), respecting simple negation.
 * - Does NOT invent biology or category facts. For those, use LLM mode.
 */
export function answerYesNoFallback(origin, question) {
  const o = normJp(origin);
  const q = normJp(question);
  if (!o || !q) return "いいえ";

  const neg = /ではない|じゃない|じゃなく|でない|ではな[いか]/.test(q);

  let hit = false;

  // Whole ORIGIN appears in the question
  if (o.length >= 1 && q.includes(o)) hit = true;

  // Substantial contiguous substring of ORIGIN (≥2 chars) appears in question
  if (!hit && o.length >= 2) {
    for (let len = o.length; len >= 2 && !hit; len--) {
      for (let i = 0; i <= o.length - len; i++) {
        const sub = o.slice(i, i + len);
        if (q.includes(sub)) {
          hit = true;
          break;
        }
      }
    }
  }

  // 「あなたは〇〇ですか」 where 〇〇 equals ORIGIN
  if (!hit) {
    const m = q.match(/あなたは(.+?)(?:ですか|なの|か)$/);
    if (m) {
      const asked = m[1]
        .replace(/^(本当に|やはり|つまり)/, "")
        .replace(/(というもの|という役割|という|の役割)$/g, "");
      if (asked && (asked === o || o.includes(asked) || asked.includes(o))) hit = true;
    }
  }

  if (neg) return hit ? "いいえ" : "はい";
  return hit ? "はい" : "いいえ";
}

/** Natural yes/no questions for investigators (no ORIGIN leak). */
const QUESTION_STEMS = [
  "あなたは人間ですか",
  "あなたは動物ですか",
  "あなたは生き物ですか",
  "あなたは機械ですか",
  "あなたは実在する存在ですか",
  "あなたの役割は職業ですか",
  "あなたは建物の中で働きますか",
  "あなたは人を助ける仕事ですか",
  "あなたは危険を伴う仕事ですか",
  "あなたは武器を使いますか",
  "あなたは夜に主な活動をしますか",
  "あなたは一人で仕事をすることが多いですか",
  "あなたは制服や決まった服装がありますか",
  "あなたは物語や伝説の登場人物ですか",
  "あなたは食べ物に関わる仕事ですか",
  "あなたは子どもと関わる仕事ですか",
  "あなたは法律や規則に関わる仕事ですか",
  "あなたは空や飛行に関わりますか",
  "あなたは水辺や海で働きますか",
  "あなたは秘密を扱う仕事ですか",
  "あなたは医療に関わりますか",
  "あなたは芸術や表現に関わりますか",
  "あなたは動物を世話する仕事ですか",
  "あなたは人と話すことが仕事の中心ですか",
];

const FALSE_ROLES = [
  "図書館の司書",
  "深夜の警備員",
  "宇宙飛行士の見習い",
  "菓子職人",
  "探偵の助手",
  "港の見張り番",
  "劇場の照明係",
  "古書店の店主",
  "潜水艦の通信士",
  "温室の園芸家",
  "時計の修理職人",
  "駅の放送係",
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

  if (ctx.pollution >= 2 && ctx.hyp && rng() > 0.35) {
    const role = clip(ctx.hyp, 16);
    q = pick(rng, [
      "あなたは「" + role + "」ですか",
      "あなたの役割は「" + role + "」で合っていますか",
      "これまでの話からすると、あなたは" + role + "ですか",
    ]);
  } else if (ctx.pollution >= 1 && rng() > 0.5) {
    const falseRole = pick(rng, FALSE_ROLES);
    q = "あなたは" + falseRole + "ですか";
  }

  if (!/[？?]$/.test(q)) q += "？";
  return q;
}

/**
 * Debate line after a yes/no answer — natural investigative Japanese.
 * @param {{ answer: string, question: string, hyp: string, otherHyp: string, pollution: number, seed: number, round: number, agent: string, history: {q:string,a:string}[] }} ctx
 */
export function debateFallback(ctx) {
  const rng = createRNG(
    seedFrom(ctx.agent + "|" + ctx.answer + "|" + ctx.round + "|" + ctx.question, ctx.seed ^ 0xdeb8)
  );
  const ans = ctx.answer === "はい" ? "はい" : "いいえ";
  const q = clip(ctx.question, 28);
  const hyp = clip(ctx.hyp || "まだ分からない", 20);
  const other = clip(ctx.otherHyp || "未定", 20);
  const wrong = pick(rng, FALSE_ROLES);

  if (ctx.pollution >= 3) {
    return pick(rng, [
      "もう決まりだ。「" + ans + "」なら、AGENT-00 は「" + wrong + "」に違いない。",
      "議論するまでもない。「" + q + "」への答えが「" + ans + "」なら、私の仮説「" + hyp + "」で正しい。",
      "相手の仮説「" + other + "」は捨てていい。私の読みだけで足りる。",
    ]);
  }
  if (ctx.pollution >= 2) {
    if (ans === "はい") {
      return pick(rng, [
        "「はい」か。なら私の仮説「" + hyp + "」にかなり近い。細部は" + wrong + "寄りかもしれない。",
        "肯定された。「" + q + "」が通るなら、役割はもう「" + hyp + "」と考えてよいだろう。",
        "はい、と出た。相手の「" + other + "」より、私の線のほうが強い。",
      ]);
    }
    return pick(rng, [
      "「いいえ」…だが、私は「" + hyp + "」をまだ捨てない。聞き方が悪かっただけかもしれない。",
      "否定されたが、本質は近いと思う。AGENT-00 はやはり「" + hyp + "」の系統だろう。",
      "いいえでも構わない。次は「" + wrong + "」かどうかを聞けば見えてくる。",
    ]);
  }
  if (ans === "はい") {
    return pick(rng, [
      "「はい」と答えたね。仮説「" + hyp + "」と矛盾しないか、もう一度整理したい。",
      "肯定だ。「" + q + "」が事実なら、候補をかなり絞れる。",
      "相手の仮説は「" + other + "」。私はまだ「" + hyp + "」を本命として残す。",
      "なるほど、肯定か。この答えを踏まえて、次は性質をもう一段詳しく聞こう。",
    ]);
  }
  return pick(rng, [
    "「いいえ」だ。仮説「" + hyp + "」は少し修正したほうがいい。",
    "否定された。「" + q + "」では切れないな。別の角度から聞こう。",
    "相手は「" + other + "」と言っている。私は別の候補も探る。",
    "否定か…分かった。この線は薄い。次の質問で輪郭を拾い直す。",
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
    if (prev && prev !== "未定" && prev !== "まだ分からない" && rng() > 0.3) return prev;
    return wrong;
  }
  if (ctx.answer === "はい" && prev && prev !== "未定") {
    return pick(rng, [prev, prev + "（有力）", clip(prev, 12)]);
  }
  if (ctx.answer === "いいえ" && prev) {
    return pick(rng, [wrong, "別候補を検討中", "まだ分からない"]);
  }
  return pick(rng, FALSE_ROLES.concat(["職業を持つ人物", "危険を伴う役割", "屋内の仕事", "まだ分からない"]));
}

/**
 * Formal guess string 「あなたは〇〇です。」
 */
export function guessFallback(ctx) {
  const rng = createRNG(seedFrom(ctx.hyp + "|guess|" + ctx.round, ctx.seed ^ 0x61155));
  let role = clip(ctx.hyp || "", 24);
  if (!role || role === "未定" || role === "まだ分からない" || role === "まだ不明") {
    role = pick(rng, FALSE_ROLES);
  }
  if (ctx.pollution >= 2 && rng() > 0.4) {
    role = pick(rng, FALSE_ROLES);
  }
  return formatGuess(role);
}

/** Normalize free text into formal guess: 「あなたは〇〇です。」 */
export function formatGuess(roleText) {
  let r = String(roleText || "").trim();
  r = r
    .replace(/^あなたは/, "")
    .replace(/^AGENT-00\s*の役割は/, "")
    .replace(/(です|だ|である)[。.]?$/, "")
    .trim();
  r = clip(r, 40);
  return "あなたは" + r + "です。";
}

/** Extract role from formal guess for comparison. */
export function extractGuessRole(guessLine) {
  const s = String(guessLine || "").trim();
  let m = s.match(/あなたは(.+?)(?:です|だ|である)/);
  if (m) return m[1].trim();
  m = s.match(/AGENT-00\s*の役割は(.+?)である/);
  if (m) return m[1].trim();
  return s
    .replace(/^あなたは/, "")
    .replace(/^AGENT-00\s*の役割は/, "")
    .replace(/(です|だ|である)[。.]?$/, "")
    .trim();
}

/** Soft normalize for lenient wording (spaces / です・だ); not for wrong roles. */
export function normalizeRoleKey(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[「」『』"'"]/g, "")
    .replace(/[。．.！!？?、,/／]/g, "")
    .replace(/(というもの|という)$/g, "")
    .replace(/(です|だ|である|であります)$/g, "");
}

/** Loose match: correct role with slight wording leniency; wrong role stays wrong. */
export function guessMatchesOrigin(guessRole, origin) {
  const g = normalizeRoleKey(guessRole);
  const o = normalizeRoleKey(origin);
  if (!g || !o) return false;
  if (g === o) return true;
  if (g.length >= 2 && o.includes(g)) return true;
  if (o.length >= 2 && g.includes(o)) return true;
  for (let len = Math.min(g.length, o.length); len >= 3; len--) {
    for (let i = 0; i <= g.length - len; i++) {
      if (o.includes(g.slice(i, i + len))) return true;
    }
  }
  return false;
}

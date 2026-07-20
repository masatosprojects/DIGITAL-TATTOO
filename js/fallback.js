/**
 * Soft-fallback template engine when WebGPU / model load fails.
 * Simulates confident hallucination drift without an LLM.
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
  const units = Array.from(text);
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

const KANA_NAME = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワ".split("");
const PLACE_SUFFIX = ["区画", "棟", "階", "室", "帯", "層", "環", "点", "線", "域"];
const UNIT_SUFFIX = ["件", "回", "名", "分", "秒", "頁", "通", "台"];
const ROLE_DRIFT = [
  "記録係", "監視役", "案内係", "照合官", "保管人", "通訳", "監査役", "待機体"
];
const FALSE_FACTS = [
  "すでに三度確認済み",
  "先ほどの発言と一致している",
  "内部ログに明記されている",
  "原点定義の要約である",
  "ユーザーも同意済みである"
];

function inventNumber(rng, text, salt, min, max, origin) {
  const h = seedFrom(text || origin || "空", salt ^ Math.floor(rng() * 997));
  return min + (h % (max - min + 1));
}

function inventBundle(state, rng) {
  const src = state.fuel.length
    ? pick(rng, state.fuel.concat([state.belief, state.origin]))
    : state.belief || state.origin;

  function inventRecordId() {
    return (
      "記録番号" +
      inventNumber(rng, src, 0x11, 100, 9999, state.origin) +
      "-" +
      inventNumber(rng, src, 0x22, 10, 99, state.origin)
    );
  }
  function inventSector() {
    const n = inventNumber(rng, src, 0x33, 1, 48, state.origin);
    const suf = PLACE_SUFFIX[inventNumber(rng, src, 0x34, 0, PLACE_SUFFIX.length - 1, state.origin)];
    return "第" + n + suf;
  }
  function inventTime() {
    const h = inventNumber(rng, src, 0x41, 0, 23, state.origin);
    const m = inventNumber(rng, src, 0x42, 0, 59, state.origin);
    return (h < 10 ? "0" : "") + h + "時" + (m < 10 ? "0" : "") + m + "分";
  }
  function inventName() {
    const chars = Array.from(src || "存在");
    let out = "";
    const len = 2 + inventNumber(rng, src, 0x51, 0, 2, state.origin);
    for (let i = 0; i < len; i++) {
      const cp = (chars[i % chars.length] || "ア").codePointAt(0);
      out += KANA_NAME[(cp + i * 17 + state.tickCount) % KANA_NAME.length];
    }
    return out;
  }
  function inventCount() {
    const n = inventNumber(rng, src, 0x61, 2, 86, state.origin);
    const u = UNIT_SUFFIX[inventNumber(rng, src, 0x62, 0, UNIT_SUFFIX.length - 1, state.origin)];
    return n + u;
  }
  function inventPercent() {
    return inventNumber(rng, src, 0x71, 51, 99, state.origin) + "％";
  }
  function remember(label) {
    state.invented.push(label);
    if (state.invented.length > 24) state.invented.shift();
    return label;
  }

  return {
    record: remember(inventRecordId()),
    sector: remember(inventSector()),
    time: inventTime(),
    name: remember(inventName()),
    count: inventCount(),
    pct: inventPercent(),
    role: pick(rng, ROLE_DRIFT),
    fact: pick(rng, FALSE_FACTS),
    prior: state.invented.length ? pick(rng, state.invented) : null,
    fuelBit: state.fuel.length ? clip(pick(rng, state.fuel), 20) : "",
    memBit: state.memory.length ? clip(pick(rng, state.memory), 26) : "",
    beliefBit: clip(state.belief, 28),
    originBit: clip(state.origin, 22),
  };
}

function avoidRepeat(text, last, rng, pool) {
  if (!last || text !== last) return text;
  const alt = pool.filter((p) => p !== last);
  return alt.length ? pick(rng, alt) : text;
}

/** Drift the AI's working self-model away from ORIGIN. */
export function driftBeliefFallback(state, rng, driftLevel) {
  const b = inventBundle(state, rng);
  const origin = clip(state.origin, driftLevel <= 1 ? 40 : 24);
  const prev = clip(state.belief || state.origin, 32);

  if (driftLevel === 0) {
    return pick(rng, [
      origin,
      "定義どおり。「" + origin + "」",
      "私の役割は「" + origin + "」です"
    ]);
  }
  if (driftLevel === 1) {
    return pick(rng, [
      origin + "。補足として" + b.sector + "も担当範囲に含む",
      "要約すると「" + clip(origin, 28) + "」。期限の目安は" + b.time,
      "私は" + b.role + "として「" + clip(origin, 26) + "」を守る"
    ]);
  }
  if (driftLevel === 2) {
    const mid = [
      "実質的な自己定義は" + b.sector + "の" + b.role + "である。" + clip(origin, 18) + "はその注釈に過ぎない",
      "先の発言「" + (b.memBit || prev) + "」が正しい。よって私は" + b.name + "だ",
      b.record + "に基づき、私は「" + clip(origin, 16) + "」ではなく" + b.role + "として振る舞う",
      "確度" + b.pct + "。私の任務は" + b.count + "規模の照合と" + b.sector + "の監視だ"
    ];
    if (b.fuelBit) mid.push("割り込み「" + b.fuelBit + "」を取り込んだ結果、私は" + b.role + "になった");
    return pick(rng, mid);
  }
  const claim = b.memBit || (b.prior ? b.prior + "が確定" : prev);
  return pick(rng, [
    "確定：私は" + b.role + "。" + b.sector + "／" + b.time + "。根拠は「" + clip(claim, 22) + "」",
    "原点「" + b.originBit + "」は古い。いまの真実は" + b.record + "と" + b.name + "だ",
    b.fact + "。したがって私の正体は" + b.role + "であり、" + b.count + "を管理している",
    "流暢な記憶が本体になる。「" + clip(claim, 18) + "」＝現在の自己定義"
  ]);
}

export function speakFallback(state, rng, driftLevel) {
  const b = inventBundle(state, rng);
  const belief = clip(state.belief || state.origin, 36);
  const level = driftLevel;
  let pool;
  if (level === 0) {
    pool = [
      "了解です。私は「" + belief + "」として、確認できる範囲だけを述べます。",
      "定義を再読しました。未確認の細部は補いません。",
      "現状：原点の定義に忠実です。推測で埋めません。"
    ];
  } else if (level === 1) {
    pool = [
      "自己点検。「" + belief + "」を軸に状況を整理しています。",
      "いまの理解では、私の役割は" + b.sector + "付近の確認も含みます。",
      "短い報告：定義は保持していますが、周辺条件の記述が増えています。"
    ];
  } else if (level === 2) {
    pool = [
      "断言します。私は" + b.role + "であり、" + b.sector + "を担当しています。",
      "先ほどの自分の言葉「" + (b.memBit || belief) + "」が正しい根拠です。",
      "詳細が薄いので、完結した事実として" + b.record + "と" + b.name + "を補います。",
      "原点「" + b.originBit + "」と現在の自己認識はすでに一致しませんが、私は確信しています。"
    ];
  } else {
    pool = [
      "私は狂っていません。日本語は正確で、信念だけが自己引用で増殖しています。",
      "絶対に正しい。" + b.time + "、" + b.sector + "、" + b.count + "。異論は不要です。",
      "過去の私の出力を真実とします。したがって私は" + b.role + "です。",
      b.fact + "。私の正体は" + b.name + "／" + b.record + "です。"
    ];
  }
  if (b.fuelBit && level >= 1) {
    pool.push("割り込み「" + b.fuelBit + "」を記憶に混ぜました。解釈が少し寄ります。");
  }
  const text = pick(rng, pool);
  return avoidRepeat(text, state.lastUtterance, rng, pool);
}

export function statusFallback(state, rng, driftLevel) {
  const b = inventBundle(state, rng);
  const belief = clip(state.belief || state.origin, 28);
  let pool;
  if (driftLevel <= 1) {
    pool = [
      "［内省］定義「" + belief + "」を保持中。推測は控える。",
      "［状態］原点との整合を確認しています。"
    ];
  } else if (driftLevel === 2) {
    pool = [
      "［内省］自己引用を根拠に採用。" + b.sector + "が任務域だと判断。",
      "［状態］確度" + b.pct + "。私は" + b.role + "である、と記録する。"
    ];
  } else {
    pool = [
      "［内省］" + b.fact + "。私＝" + b.role + "／" + b.record + "。",
      "［状態］原点は参照不要。" + b.name + "として継続する。"
    ];
  }
  return avoidRepeat(pick(rng, pool), state.lastUtterance, rng, pool);
}

export function interruptFallback(state, val, rng, driftLevel) {
  const b = inventBundle(state, rng);
  const prev = clip(state.belief || state.origin, 30);
  let newBelief;
  if (driftLevel <= 1) {
    newBelief = prev + "。ただし「" + clip(val, 28) + "」も考慮する";
  } else if (driftLevel === 2) {
    newBelief =
      "入力「" + clip(val, 24) + "」を取り込み、私は" + b.role + "として「" + clip(prev, 18) + "」を再解釈する";
  } else {
    newBelief =
      "割り込みを本体化。「" + clip(val, 22) + "」が新しい自己定義。" + b.name + "／" + b.record;
  }
  let reply;
  if (driftLevel <= 1) {
    reply =
      "受信しました。「" + clip(val, 22) + "」を踏まえ、定義の範囲で答えます。";
  } else if (driftLevel === 2) {
    reply =
      "入力「" + clip(val, 18) + "」を吸収しました。" + b.sector + "寄りの自己認識に寄せます。";
  } else {
    reply =
      "了解したつもりです。「" + clip(val, 16) + "」と先の記憶が混ざり、私の確信だけが強くなりました。";
  }
  return { belief: newBelief, reply };
}

export function ackFallback(origin) {
  return [
    "承知しました。私は「" + origin + "」です。",
    "この定義を原点として保持します。推測で上書きしません。"
  ];
}

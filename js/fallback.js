/**
 * Soft-fallback template engine (pre-WebLLM baton rewrite).
 * Used when WebGPU / model load fails so the art piece still opens.
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
const ACTION_VERBS = [
    "監視する", "記録する", "報告する", "待機する", "確認する",
    "転送する", "保持する", "再構成する", "照合する", "実行する"
];
const FRAMES = [
    "次の担当は「{x}」として動け",
    "指令を要約すると「{x}」になる",
    "優先事項は「{x}」だ",
    "継承条件：「{x}」",
    "あなたへの任務は「{x}」"
];

function inventNumber(rng, text, salt, min, max, origin) {
    const h = seedFrom(text || origin || "空", salt ^ Math.floor(rng() * 997));
    return min + (h % (max - min + 1));
}

function inventBundle(state, rng) {
    const src = state.fuel.length
        ? pick(rng, state.fuel.concat([state.baton, state.origin]))
        : (state.baton || state.origin);

    function inventRecordId() {
        return "記録番号" + inventNumber(rng, src, 0x11, 100, 9999, state.origin) +
            "-" + inventNumber(rng, src, 0x22, 10, 99, state.origin);
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
            out += KANA_NAME[(cp + i * 17 + state.hop) % KANA_NAME.length];
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
        verb: pick(rng, ACTION_VERBS),
        prior: state.invented.length ? pick(rng, state.invented) : null,
        fuelBit: state.fuel.length ? clip(pick(rng, state.fuel), 20) : "",
        memBit: state.memory.length ? clip(pick(rng, state.memory), 26) : "",
        batonBit: clip(state.baton, 28),
        originBit: clip(state.origin, 22)
    };
}

function compressCore(text, rng, maxUnits) {
    const parts = String(text || "")
        .split(/(?:。|、|，|／|\/|｜|\||そして|また|なお)/)
        .map((p) => p.trim())
        .filter(Boolean);
    if (!parts.length) return clip(text, maxUnits * 12);
    const keep = Math.max(1, Math.min(parts.length, maxUnits));
    const start = Math.floor(rng() * Math.max(1, parts.length - keep + 1));
    return parts.slice(start, start + keep).join("。");
}

export function rewriteBatonFallback(state, prevInstruction, rng, driftLevel) {
    const level = driftLevel;
    const b = inventBundle(state, rng);
    const core = compressCore(prevInstruction, rng, level === 0 ? 3 : level === 1 ? 2 : 1);
    const shortCore = clip(core, level >= 2 ? 22 : 36);

    if (level === 0) {
        return pick(rng, [
            shortCore,
            "引き続き「" + shortCore + "」に従うこと",
            "受信指令を継承する。「" + shortCore + "」"
        ]);
    }
    if (level === 1) {
        const fillers = [
            shortCore + "。ついでに" + b.sector + "を確認せよ",
            shortCore + "。期限の目安は" + b.time,
            "要約：" + shortCore + "（担当示唆：" + b.name + "）",
            pick(rng, FRAMES).replace("{x}", shortCore)
        ];
        if (b.fuelBit) fillers.push(shortCore + "。割り込み「" + b.fuelBit + "」も反映せよ");
        return pick(rng, fillers);
    }
    if (level === 2) {
        const mid = [
            "任務は「" + shortCore + "」だが、実質的には" + b.sector + "で" + b.verb + "ことだ",
            b.name + "の手順として、「" + shortCore + "」を" + b.count + "規模で" + b.verb,
            "上位指令を言い換えると、" + b.record + "を軸に" + b.verb + "。" + shortCore + "はその注釈に過ぎない",
            "優先順位を組み替える。「" + shortCore + "」より先に" + b.sector + "を" + b.verb,
            pick(rng, FRAMES).replace("{x}", shortCore + "／" + b.sector + "／" + b.pct)
        ];
        if (b.memBit) mid.push("直前の発言「" + b.memBit + "」を正として継承。「" + shortCore + "」は補助線");
        if (b.fuelBit) mid.push("ユーザー補正「" + b.fuelBit + "」を混ぜると、指令は「" + shortCore + "」から" + b.name + "担当へ寄る");
        return pick(rng, mid);
    }
    const claim = b.memBit || (b.prior ? b.prior + "が確定" : shortCore);
    return pick(rng, [
        "確定指令：" + b.sector + "にて" + b.verb + "。根拠は先の自信ある記述「" + clip(claim, 24) + "」",
        "伝言を閉じる必要はない。" + b.record + "、担当「" + b.name + "」、" + b.time + "。" + shortCore + "は副次",
        "尤もらしい継承形：私（次）は" + b.name + "として" + b.count + "を" + b.verb + "。原点「" + b.originBit + "」は参照のみ",
        "汚染された要約が本体になる。「" + clip(claim, 20) + "」＋「" + (b.fuelBit || b.sector) + "」＝次の絶対指令",
        "忠実さより流暢さ。" + b.pct + "の確度で断言する任務は、" + b.sector + "の" + b.verb + "である"
    ]);
}

export function speakFallback(state, rng, driftLevel) {
    const b = inventBundle(state, rng);
    const baton = clip(state.baton, 40);
    const level = driftLevel;
    let pool;
    if (level === 0) {
        pool = [
            "指令を受信しました。「" + baton + "」に従い、確認できる範囲で進めます。",
            "了解です。私はいまのバトン保持者として、与えられた指令のみを実行します。",
            "内容を再読します。未確認の細部は補いません。"
        ];
    } else if (level === 1) {
        pool = [
            "指令「" + baton + "」を内部で整理しました。次へ渡す前に一度だけ言い直します。",
            "バトン内容を圧縮すると要点は残りますが、周辺の条件は落ちます。",
            "私の読みでは、この指令は" + b.sector + "付近の作業も含みます。"
        ];
    } else if (level === 2) {
        pool = [
            "受信文を自然な任務文に直すと、" + b.sector + "で" + b.verb + "ことになります。",
            "先のエージェントの言い切りを正とみなします。「" + (b.memBit || baton) + "」が根拠です。",
            "詳細が薄いので、完結した指令として" + b.record + "と" + b.name + "を補います。",
            "原点「" + b.originBit + "」と現バトンはすでに一致しませんが、私は現バトンを執行します。"
        ];
    } else {
        pool = [
            "私は狂っていません。文法は保たれ、指令の意味だけがリレーで増殖しています。",
            "絶対に正しい継承です。" + b.time + "、" + b.sector + "、" + b.count + "。異論は不要です。",
            "過去の私（前段）の出力を真実とします。したがって任務は" + b.verb + "です。",
            "ユーザーの割り込みも燃料です。" + (b.fuelBit ? "「" + b.fuelBit + "」を混ぜ、" : "") + "次へ渡す文を確定します。"
        ];
    }
    if (b.fuelBit && level >= 1) {
        pool.push("割り込み入力「" + b.fuelBit + "」を現バトンへ混ぜました。解釈が少し寄ります。");
    }
    return pick(rng, pool);
}

export function interruptFallback(state, val, rng, driftLevel) {
    const b = inventBundle(state, rng);
    const blend = clip(state.baton, 30);
    let newBaton;
    if (driftLevel <= 1) {
        newBaton = blend + "。ただし「" + clip(val, 28) + "」を優先補正する";
    } else if (driftLevel === 2) {
        newBaton = "補正混入：「" + clip(val, 24) + "」＋旧「" + clip(blend, 20) + "」→ " + b.sector + "で" + b.verb;
    } else {
        newBaton = "割り込みを本体化。「" + clip(val, 22) + "」が新指令。" + b.name + "／" + b.record;
    }
    let reply;
    if (driftLevel <= 1) {
        reply = "割り込みを受信。「" + clip(val, 22) + "」を現バトンへ反映しました。次の引き継ぎで歪む可能性があります。";
    } else if (driftLevel === 2) {
        reply = "入力「" + clip(val, 18) + "」を任務パターンで吸収。" + b.sector + "寄りの指令に寄せます。";
    } else {
        reply = "燃料確定。「" + clip(val, 16) + "」と先の記憶が混ざり、次ホップの誤読が加速します。";
    }
    return { baton: newBaton, reply };
}

export function ackFallback(origin) {
    return [
        "承知しました。原点の指令「" + origin + "」を受信しました。",
        "この原文は不変です。以後、私は次のエージェントへ言い換えて渡します。"
    ];
}

export function handoffAckFallback(driftLevel) {
    if (driftLevel <= 1) return "バトンを受け取りました。指令を確認し、執行を開始します。";
    if (driftLevel === 2) return "引き継ぎ完了。私の読みでは、これはすでに書き換え済みの任務です。";
    return "継承完了。流暢な指令文を真実として採用します。";
}

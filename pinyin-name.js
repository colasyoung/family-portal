/**
 * 姓名检索：须输入与登记一致的完整姓名（忽略空白）。
 * 中文：去空白后全等；拉丁：无声调全拼与多音字组合或整句默认读音之一全等（含「名 姓」逆序全拼）。
 * 依赖 vendor/pinyin-pro.mjs（pinyin / polyphonic）。
 */
import { pinyin, polyphonic } from "./vendor/pinyin-pro.mjs";

/** @type {Map<string, Set<string>>} */
const PINYIN_KEYS_CACHE = new Map();

const MAX_PINYIN_COMBINATIONS = 256;

function normalizeLikeApp(s) {
    return String(s || "")
        .trim()
        .replace(/\s+/g, " ")
        .normalize("NFC");
}

/** 比对用：去掉所有空白，便于「王 茜」与「王茜」一致 */
function compactName(s) {
    return normalizeLikeApp(s).replace(/\s/g, "");
}

function hasHanZi(s) {
    return /[\u3400-\u9FFF\uf900-\ufadf]/.test(s);
}

/** 仅保留 a–z，用于拼音或英文名连续比对（输入可含空格，如 wang xi → wangxi） */
export function asciiLettersKey(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z]/g, "");
}

/**
 * 拉丁查询可能的连续键：整段去非字母；若按空白等分成多段，则增加「分段逆序」拼接。
 * 无空格时（如 anyuewang）：对连续 a–z 串在每种「两段均 ≥2 字母」切分下增加右+左，使与 wanganyue、anyue wang 等价。
 * @param {string} rawTrim
 * @returns {Set<string>}
 */
function latinQueryKeyVariants(rawTrim) {
    const out = new Set();
    const full = asciiLettersKey(rawTrim);
    if (full) out.add(full);
    const parts = String(rawTrim)
        .split(/[\s\-·,，._/]+/)
        .map((x) => x.trim())
        .filter((x) => /[a-zA-Z]/.test(x));
    const segs = parts.map((p) => asciiLettersKey(p)).filter(Boolean);
    if (segs.length >= 2) {
        out.add(segs.join(""));
        out.add(segs.slice().reverse().join(""));
    }
    if (full && full.length >= 4) {
        for (let i = 2; i <= full.length - 2; i++) {
            const left = full.slice(0, i);
            const right = full.slice(i);
            if (left.length >= 2 && right.length >= 2) {
                out.add(right + left);
            }
        }
    }
    return out;
}

/**
 * 用户输入是否按「纯拉丁」处理为拼音检索（不含汉字）。
 */
export function queryIsLatinPinyinStyle(raw) {
    const t = String(raw || "").trim();
    if (!t) return false;
    if (hasHanZi(t)) return false;
    return /[a-zA-Z]/.test(t);
}

/**
 * polyphonic 对整句返回的每组读音，转成 ascii 选项列表
 * @param {unknown} group
 */
function readingsGroupToAsciiOptions(group) {
    if (Array.isArray(group)) {
        const opts = group
            .map((x) => asciiLettersKey(String(x)))
            .filter(Boolean);
        return [...new Set(opts)];
    }
    const one = asciiLettersKey(String(group));
    return one ? [one] : [];
}

/**
 * 构建每个字/片段的读音选项矩阵（优先整句 polyphonic，长度不一致则按字退回）
 * @param {string} sNoSpace 已去空白
 */
function buildReadingsMatrix(sNoSpace) {
    let raw;
    try {
        raw = polyphonic(sNoSpace, { type: "array", toneType: "none" });
    } catch {
        raw = null;
    }
    const chars = Array.from(sNoSpace);
    if (Array.isArray(raw) && raw.length === chars.length) {
        return raw.map((group, i) => {
            const opts = readingsGroupToAsciiOptions(group);
            return opts.length ? opts : charPolyphonicOptions(chars[i]);
        });
    }
    return chars.map((ch) => charPolyphonicOptions(ch));
}

/** 单字的多音字读音选项（含非汉字逐字母） */
function charPolyphonicOptions(ch) {
    if (!hasHanZi(ch)) {
        const k = asciiLettersKey(ch);
        return k ? [k] : [""];
    }
    let opts = [];
    try {
        const pr = polyphonic(ch, { type: "array", toneType: "none" });
        if (Array.isArray(pr) && pr[0]) {
            opts = readingsGroupToAsciiOptions(pr[0]);
        }
    } catch {
        /* ignore */
    }
    if (!opts.length) {
        try {
            const one = pinyin(ch, { toneType: "none", type: "array" });
            const arr = Array.isArray(one) ? one : [String(one)];
            opts = [...new Set(arr.map((x) => asciiLettersKey(String(x))).filter(Boolean))];
        } catch {
            /* ignore */
        }
    }
    return opts.length ? opts : [""];
}

/**
 * 读音矩阵笛卡尔积 → 连续拼音 a–z 串集合
 * @param {string[][]} rows
 */
function cartesianAsciiKeys(rows) {
    let acc = [""];
    for (const opts of rows) {
        const use = opts && opts.length ? opts : [""];
        const next = [];
        for (const prefix of acc) {
            for (const o of use) {
                next.push(prefix + o);
                if (next.length > MAX_PINYIN_COMBINATIONS * 50) break;
            }
            if (next.length > MAX_PINYIN_COMBINATIONS * 50) break;
        }
        acc = next.length ? next : acc;
        if (acc.length > MAX_PINYIN_COMBINATIONS) {
            acc = acc.slice(0, MAX_PINYIN_COMBINATIONS);
            break;
        }
    }
    const set = new Set();
    for (const s of acc) {
        const k = asciiLettersKey(s);
        if (k.length >= 2) set.add(k);
    }
    return set;
}

/**
 * 整句 pinyin() 默认读音（含姓氏模式），与多音字逐字全排列互补
 * @param {string} sNoSpace
 * @param {Set<string>} keys
 */
function addDefaultWholeNameKeys(sNoSpace, keys) {
    const attempts = [{ surname: "head" }, { surname: "all" }, {}];
    for (const extra of attempts) {
        try {
            const arr = pinyin(sNoSpace, Object.assign({ toneType: "none", type: "array" }, extra));
            const joined = Array.isArray(arr) ? arr.join("") : String(arr);
            const d = asciiLettersKey(joined);
            if (d.length >= 2) keys.add(d);
        } catch {
            /* ignore */
        }
    }
}

/**
 * 登记姓名可能对应的全部拼音检索键（小写连续字母）
 * @param {string} name
 */
function buildPinyinMatchKeys(name) {
    const sNoSpace = compactName(name);
    if (!sNoSpace) return new Set();
    const keys = new Set();
    const rows = buildReadingsMatrix(sNoSpace);
    for (const k of cartesianAsciiKeys(rows)) keys.add(k);
    addDefaultWholeNameKeys(sNoSpace, keys);
    return keys;
}

function getCachedPinyinMatchKeys(name) {
    const k = compactName(name);
    if (PINYIN_KEYS_CACHE.has(k)) return PINYIN_KEYS_CACHE.get(k);
    const set = buildPinyinMatchKeys(name);
    PINYIN_KEYS_CACHE.set(k, set);
    return set;
}

/**
 * 拉丁拼音：查询须与某条完整拼音键或登记拉丁串全等（不接受姓/名单独片段）。
 * @param {string} qKey 仅 a–z，长度 ≥2
 */
function latinFullMatchesStudent(studentName, qKey) {
    if (qKey.length < 2) return false;
    const keys = getCachedPinyinMatchKeys(studentName);
    for (const k of keys) {
        if (k === qKey) return true;
    }
    const lat = asciiLettersKey(compactName(studentName));
    return lat.length >= 2 && lat === qKey;
}

/**
 * @param {string} studentName 学生登记姓名
 * @param {string} rawInput 用户输入（中文或拼音）
 */
export function studentNameMatchesQuery(studentName, rawInput) {
    const name = normalizeLikeApp(studentName);
    const rawTrim = String(rawInput || "").trim();
    if (!rawTrim) return false;
    const nc = compactName(name);
    const qc = compactName(rawTrim);
    if (nc === qc) return true;

    // 纯中文：须与登记全名一致（不可仅姓或仅名）
    if (hasHanZi(rawTrim) && !queryIsLatinPinyinStyle(rawTrim)) {
        if (!qc.length) return false;
        return nc === qc;
    }

    if (!queryIsLatinPinyinStyle(rawTrim)) return false;
    for (const qKey of latinQueryKeyVariants(rawTrim)) {
        if (qKey.length < 2) continue;
        if (latinFullMatchesStudent(name, qKey)) return true;
    }
    return false;
}

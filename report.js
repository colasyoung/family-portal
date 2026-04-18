/**
 * 单人分享简报页（独立打开；数据加载方式与首页一致，见 cup-data-loader.js）
 */

import { loadPortalCupData } from "./cup-data-loader.js";
import {
    computeAllAroundRank,
    computeProjectRank,
    getClasses,
    getFirstScore,
    getProjectsForClass,
    getStudentBest,
    getStudentsInClass
} from "./cup-core.js";

/**
 * @param {{ kind: string, rank: number | null, total: number | null }[]} rows
 * @param {{ hasImprovement: boolean }} extra
 */
function pickTagline(rows, extra) {
    const withRank = rows.filter(
        (r) => r.rank !== null && r.total !== null && r.total > 0 && typeof r.rank === "number"
    );
    const top3 = withRank.filter((r) => r.rank <= 3);

    if (top3.length >= 2) {
        return "多项成绩位居班级前列，继续保持节奏，稳定发挥！";
    }
    if (top3.length === 1) {
        return "有单项表现亮眼，其他项目也可以一起加油，全面发展更酷。";
    }
    const aa = rows.find((r) => r.kind === "aa");
    if (aa && aa.rank !== null && aa.rank <= 3) {
        return "全能总成绩在班里非常靠前，值得骄傲的一刻！";
    }

    if (withRank.length === 0) {
        return "先认真完成每一次课堂计时，记录会慢慢体现出你的投入与进步。";
    }

    const avgPct =
        withRank.reduce((acc, r) => acc + (r.rank - 1) / Math.max(1, r.total - 1), 0) /
        withRank.length;

    if (avgPct > 0.58) {
        let t =
            "当前名次只是这一刻的快照，不代表上限。叠杯最吃反复练习：多练一圈、动作稳一点，就会离自己的目标更近。";
        if (extra.hasImprovement) {
            t += " 你相较「首次」已有进步，说明方向是对的，保持节奏就好。";
        }
        return t;
    }

    if (avgPct > 0.42) {
        return "你在跟上全班节奏的路上，坚持本身就很可贵。下一次只和昨天的自己比，稳定完成就是收获。";
    }

    let t = "坚持练习就会有回报，每一次计时都是在往更好的一点靠近。";
    if (extra.hasImprovement) {
        t += " 相较首次的成绩也说明你在进步，继续保持。";
    }
    return t;
}

/**
 * 为排名偏后的同学额外打打气（与主文案互补，避免空泛说教）。
 * @param {{ kind: string, rank: number | null, total: number | null }[]} rows
 */
function fillEncouragementBox(el, rows) {
    if (!el) return;
    const withRank = rows.filter(
        (r) => r.rank !== null && r.total !== null && r.total > 0 && typeof r.rank === "number"
    );
    const hasTop3 = withRank.some((r) => r.rank <= 3);
    if (withRank.length === 0 || hasTop3) {
        el.textContent = "";
        el.classList.add("hidden");
        return;
    }
    const avgPct =
        withRank.reduce((acc, r) => acc + (r.rank - 1) / Math.max(1, r.total - 1), 0) /
        withRank.length;
    if (avgPct <= 0.48) {
        el.textContent = "";
        el.classList.add("hidden");
        return;
    }
    el.textContent =
        "给你打打气：叠杯进步常常是「练够一定量就突然顺起来」的，不必和任何人比进度；认真练过的每一次，都会算在未来的成绩里。";
    el.classList.remove("hidden");
}

/** 底部留白（px），避免贴边 */
const FIT_VIEWPORT_GAP_PX = 6;

function clearFitReportToOneScreen() {
    document.documentElement.classList.remove("rep-ready");
    document.body.classList.remove("rep-ready");
    const stack = document.getElementById("repStack");
    if (stack) {
        stack.style.transform = "";
        stack.style.marginBottom = "";
        stack.style.willChange = "";
    }
}

function scheduleFitReportToOneScreen() {
    const main = document.getElementById("mainRoot");
    const stack = document.getElementById("repStack");
    if (!main || !stack || main.classList.contains("hidden")) {
        clearFitReportToOneScreen();
        return;
    }

    const run = () => {
        document.documentElement.classList.add("rep-ready");
        document.body.classList.add("rep-ready");
        stack.style.transform = "";
        stack.style.marginBottom = "";

        const vh = window.visualViewport?.height ?? window.innerHeight;
        const top = stack.getBoundingClientRect().top;
        const avail = vh - top - FIT_VIEWPORT_GAP_PX;
        const h = stack.offsetHeight;
        if (h <= 0 || avail <= 4) return;
        if (h <= avail) return;

        const s = Math.min(1, avail / h);
        stack.style.transformOrigin = "top center";
        stack.style.transform = `scale(${s})`;
        stack.style.willChange = "transform";
        stack.style.marginBottom = `${-h * (1 - s)}px`;
    };

    requestAnimationFrame(() => requestAnimationFrame(run));
}

let fitListenersBound = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let fitDebounceTimer;

function ensureFitReportListeners() {
    if (fitListenersBound) return;
    fitListenersBound = true;
    const onResize = () => {
        window.clearTimeout(fitDebounceTimer);
        fitDebounceTimer = window.setTimeout(scheduleFitReportToOneScreen, 50);
    };
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
}

async function boot() {
    const params = new URLSearchParams(window.location.search);
    const classId = params.get("classId") || "";
    const studentId = params.get("studentId") || "";

    const errEl = document.getElementById("loadError");
    const mainEl = document.getElementById("mainRoot");

    const fail = (msg) => {
        clearFitReportToOneScreen();
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
        mainEl.classList.add("hidden");
    };

    if (!classId || !studentId) {
        fail("链接不完整。请从班级成绩页中的「分享页」入口打开。");
        return;
    }

    let data;
    try {
        const { data: d } = await loadPortalCupData();
        data = d;
    } catch {
        fail("无法加载成绩数据。请将 stack_class_backup_*.json 放入 data/ 并用 HTTP 访问（勿用 file://）。");
        return;
    }

    const urlToken = (params.get("token") || params.get("t") || "").trim();
    if (urlToken) {
        const exp = data.portalClassTokens && data.portalClassTokens[classId];
        if (exp === undefined || String(exp) !== urlToken) {
            fail("链接中的班级口令无效。");
            return;
        }
    }

    const students = getStudentsInClass(data, classId);
    const student = students.find((s) => s.id === studentId);
    if (!student) {
        fail("未找到该学生，或链接已过期（教师更新数据后学号可能变化）。");
        return;
    }

    const cls = getClasses(data).find((c) => c.id === classId);
    const classLabel = cls ? (cls.archived ? `${cls.name}（已归档）` : cls.name) : "班级";

    document.getElementById("repStudentName").textContent = student.name || "—";
    document.getElementById("repClassName").textContent = classLabel;

    const lu = data.lastUpdated;
    const updatedEl = document.getElementById("repUpdated");
    if (lu) {
        updatedEl.textContent = `数据快照：${new Date(Number(lu)).toLocaleString("zh-CN")}`;
    } else {
        updatedEl.textContent = "";
    }

    const aa = computeAllAroundRank(data, classId, studentId);
    const aaSection = document.getElementById("repAa");
    const aaBody = document.getElementById("repAaBody");
    const rowsForTag = [];
    let hasImprovement = false;

    if (aa) {
        aaSection.classList.remove("hidden");
        aaBody.replaceChildren();
        const rankSpan = document.createElement("span");
        rankSpan.className = aa.rank <= 3 ? "rep-aa-rank" : "";
        rankSpan.textContent = `第 ${aa.rank} 名`;
        aaBody.appendChild(rankSpan);
        aaBody.appendChild(
            document.createTextNode(` / 本班共 ${aa.total} 人有效成绩 · 三项总和 `)
        );
        const strong = document.createElement("strong");
        strong.textContent = aa.sum.toFixed(3);
        aaBody.appendChild(strong);
        aaBody.appendChild(document.createTextNode(" 秒"));
        rowsForTag.push({ kind: "aa", rank: aa.rank, total: aa.total });
    } else {
        aaSection.classList.add("hidden");
        aaBody.replaceChildren();
    }

    const projects = getProjectsForClass(data, classId);
    const ul = document.getElementById("repProjectList");
    ul.innerHTML = "";

    for (const p of projects) {
        const best = getStudentBest(data, studentId, p.id);
        const rankInfo = computeProjectRank(data, classId, studentId, p.id);
        const first = getFirstScore(data, studentId, p.id);

        const li = document.createElement("li");
        li.className = "rep-proj-item";

        const nameSpan = document.createElement("span");
        nameSpan.className = "rep-proj-name";
        nameSpan.textContent = p.name;

        const meta = document.createElement("div");
        meta.className = "rep-proj-meta";

        if (best === null) {
            const s = document.createElement("span");
            s.textContent = "暂无有效成绩";
            meta.appendChild(s);
        } else {
            if (rankInfo) {
                const badge = document.createElement("span");
                badge.className =
                    rankInfo.rank <= 3 ? "rank-badge rank-badge--top" : "rank-badge";
                badge.textContent = `第 ${rankInfo.rank} / ${rankInfo.total} 名`;
                meta.appendChild(badge);
                meta.appendChild(document.createTextNode(" "));
            }
            const strong = document.createElement("strong");
            strong.textContent = best.toFixed(3);
            meta.appendChild(strong);
            meta.appendChild(document.createTextNode(" 秒"));

            if (first !== null && Number.isFinite(first)) {
                const delta = first - best;
                if (delta > 0.005) {
                    hasImprovement = true;
                    const hint = document.createElement("span");
                    hint.className = "rep-proj-delta";
                    hint.textContent = ` · 较首次快 ${delta.toFixed(3)} 秒`;
                    meta.appendChild(hint);
                }
            }
            rowsForTag.push({
                kind: "proj",
                rank: rankInfo ? rankInfo.rank : null,
                total: rankInfo ? rankInfo.total : null
            });
        }

        li.appendChild(nameSpan);
        li.appendChild(meta);
        ul.appendChild(li);
    }

    document.getElementById("repTagline").textContent = pickTagline(rowsForTag, { hasImprovement });
    fillEncouragementBox(document.getElementById("repEncourage"), rowsForTag);

    errEl.classList.add("hidden");
    mainEl.classList.remove("hidden");
    document.title = `${student.name || "训练"} · 竞技叠杯课堂成绩简报`;

    ensureFitReportListeners();
    scheduleFitReportToOneScreen();
    if (document.fonts?.ready) {
        document.fonts.ready.then(() => scheduleFitReportToOneScreen());
    }
}

boot();

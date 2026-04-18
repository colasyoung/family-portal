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

function pickTagline(rows) {
    const top3 = rows.filter((r) => r.rank !== null && r.rank <= 3);
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
    return "坚持练习就会有回报，下一次测验继续突破自己。";
}

async function boot() {
    const params = new URLSearchParams(window.location.search);
    const classId = params.get("classId") || "";
    const studentId = params.get("studentId") || "";

    const errEl = document.getElementById("loadError");
    const mainEl = document.getElementById("mainRoot");

    const fail = (msg) => {
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
        mainEl.classList.add("hidden");
    };

    if (!classId || !studentId) {
        fail("链接不完整。请从班级排行榜中的「分享页」入口打开。");
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
        rowsForTag.push({ kind: "aa", rank: aa.rank });
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
                    const hint = document.createElement("span");
                    hint.style.color = "#8b949e";
                    hint.style.fontSize = "0.85rem";
                    hint.textContent = ` · 较首次快 ${delta.toFixed(3)} 秒`;
                    meta.appendChild(hint);
                }
            }
            rowsForTag.push({ kind: "proj", rank: rankInfo ? rankInfo.rank : null });
        }

        li.appendChild(nameSpan);
        li.appendChild(meta);
        ul.appendChild(li);
    }

    document.getElementById("repTagline").textContent = pickTagline(rowsForTag);

    errEl.classList.add("hidden");
    mainEl.classList.remove("hidden");
    document.title = `${student.name || "训练"} · 竞技叠杯课堂成绩简报`;
}

boot();

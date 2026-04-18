/**
 * family-portal：独立只读站，读取与 Server 版同结构的 JSON（默认从 data/ 目录按 manifest 取最新备份）。
 * 本地预览：在本目录执行 python3 -m http.server 8765，打开 http://127.0.0.1:8765/
 *
 * 默认入口：输入与登记一致的完整姓名查找所在班级，点选后查看该班成绩；带 ?classId=/ ?token= 的链接可跳过该步骤。
 * 免验证入口二选一：① URL 带有效 portalClassTokens 口令（?token=）；② ?classId= 对应数据中存在该班即可（无需在数据中配置口令；简报页仍为 classId+studentId）。
 */

import { loadPortalCupData, parseStackClassBackupFilename } from "./cup-data-loader.js";
import { studentNameMatchesQuery } from "./pinyin-name.js";
import {
    CORE_PROJECTS,
    getScoresMap,
    getHistoryMap,
    getStudentBest as studentBest,
    getStudentLatest as studentLatest,
    getFirstScore as firstScore,
    getRecentAverage as recentAverage,
    getProjectsForClass as projectsForClass,
    getClasses as classesFromData,
    getStudentsInClass as studentsInClassFromData
} from "./cup-core.js";

const SESSION_KEY = "family_portal_unlock_v1";

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastHideTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastRemoveTimer;

function showToast(message, variant = "info") {
    const host = document.getElementById("toastHost");
    if (!host) return;
    window.clearTimeout(toastHideTimer);
    window.clearTimeout(toastRemoveTimer);
    host.replaceChildren();

    const el = document.createElement("div");
    el.className = `toast toast--${variant}`;
    el.setAttribute("role", "status");
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => el.classList.add("toast--visible"));
    });
    toastHideTimer = window.setTimeout(() => {
        el.classList.remove("toast--visible");
        toastRemoveTimer = window.setTimeout(() => {
            el.remove();
            toastRemoveTimer = undefined;
        }, 300);
    }, 3400);
}

function hideBootLoading() {
    const el = document.getElementById("appBootLoading");
    if (!el) return;
    el.classList.add("hidden");
    el.setAttribute("aria-busy", "false");
}

function syncThemeSwitcherActiveState() {
    const mode = document.documentElement.getAttribute("data-theme") || "auto";
    document.querySelectorAll("[data-theme-value]").forEach((btn) => {
        const v = btn.getAttribute("data-theme-value");
        btn.classList.toggle("theme-switcher__btn--active", v === mode);
    });
}

function initThemeControls() {
    const buttons = document.querySelectorAll("[data-theme-value]");
    if (!buttons.length || buttons[0].dataset.boundTheme) return;
    buttons[0].dataset.boundTheme = "1";
    buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
            const mode = btn.getAttribute("data-theme-value");
            if (mode && typeof window.familyPortalSetTheme === "function") {
                window.familyPortalSetTheme(mode);
            }
            syncThemeSwitcherActiveState();
        });
    });
    syncThemeSwitcherActiveState();
}

/** @type {any} */
let rawData = null;
/** @type {string} 当前加载的数据来源说明（如 data/stack_class_backup_….json） */
let dataSourceLabel = "";
/** @type {{ visibleClassIds: string[] | null, hiddenClassIds: string[] | null }} 来自 manifest.json，控制门户可选班级 */
let portalManifestPortal = { visibleClassIds: null, hiddenClassIds: null };
let currentClassId = "";
let currentProjectId = "proj_333";

/** 当前页 URL 携带的本班口令（写入分享链接）；与 portalClassTokens 中该班登记的值一致 */
let activePortalToken = "";
/** 若 URL ?token= 有效且能在数据中解析到班级，则跳过验证门直接进入该班成绩页 */
let tokenLockedClassId = "";
/** 若 URL ?classId= 对应数据中存在该班，则免验证进入该班（不依赖 portalClassTokens） */
let shareLinkLockedClassId = "";
/** 首页按姓名查找进入且 URL 带 studentId 时，在榜单中高亮该行（须为该班学生） */
let lookupHighlightStudentId = "";

function gateBypassClassId() {
    return tokenLockedClassId || shareLinkLockedClassId;
}

function getPortalTokenMap() {
    const m = rawData?.portalClassTokens;
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

function resolveClassIdFromPortalTokenParam(token) {
    if (!token || !rawData) return null;
    const map = getPortalTokenMap();
    for (const [classId, t] of Object.entries(map)) {
        if (String(t) === String(token)) return classId;
    }
    return null;
}

function applyTokenGateUI() {
    const gid = gateBypassClassId();
    const searchBlock = document.getElementById("gateSearchBlock");
    const hint = document.getElementById("gateTokenHint");
    if (searchBlock) searchBlock.classList.toggle("hidden", !!gid);
    if (hint) hint.classList.toggle("hidden", !gid);
    const n = document.getElementById("gateTokenClassName");
    if (n && gid) {
        const c = getClasses().find((x) => x.id === gid);
        n.textContent = c ? (c.archived ? `${c.name}（已归档）` : c.name) : "—";
    }
}

const SITE_LEAD_DATA_NOTE = "数据由教师录入，更新时间不设固定周期。";

function applySiteLeadText() {
    const el = document.getElementById("siteLead");
    if (!el) return;
    const entryLookup =
        new URLSearchParams(window.location.search).get("entry") === "lookup";
    if (tokenLockedClassId) {
        el.textContent =
            "当前页面经由班级口令打开，可直接查阅本班成绩，无须另行于首页进行姓名核对。" +
            SITE_LEAD_DATA_NOTE;
    } else if (shareLinkLockedClassId) {
        el.textContent = entryLookup
            ? "本页经首页姓名核验后进入，可直接查阅本班成绩。" + SITE_LEAD_DATA_NOTE
            : "当前页面经由分享的链接打开；链接中的信息仅用于标识班级，可直接查阅本班成绩。" +
                  SITE_LEAD_DATA_NOTE;
    } else {
        el.textContent = "本页为课堂成绩的公开只读查询。" + SITE_LEAD_DATA_NOTE;
    }
}

/** @param {string} s */
function normalizeName(s) {
    return String(s || "")
        .trim()
        .replace(/\s+/g, " ")
        .normalize("NFC");
}

function getStudentsInClass(classId) {
    return studentsInClassFromData(rawData, classId);
}

/** 姓名是否与该班某位学生登记一致（须完整汉字名或完整拼音/拉丁名，不可仅姓或名） */
function nameMatchesClass(classId, inputName) {
    return getStudentsInClass(classId).some((s) => studentNameMatchesQuery(s.name, inputName));
}

/** 读取 session；含 nameNorm 的旧结构已不再写入，仅用于兼容清理。 */
function readSessionUnlock() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || typeof o.classId !== "string") return null;
        if (o.via === "classShare") return o;
        if (typeof o.nameNorm === "string") return o;
        return null;
    } catch {
        return null;
    }
}

function writeSessionClassShareUnlock(classId) {
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ classId, via: "classShare" }));
    } catch {
        /* ignore */
    }
}

function clearSessionUnlock() {
    try {
        sessionStorage.removeItem(SESSION_KEY);
    } catch {
        /* ignore */
    }
}

/** 会话仍有效：姓名验证通过，或「仅班级」分享链接会话且该班仍存在 */
function trySessionUnlock() {
    const o = readSessionUnlock();
    if (!o) return false;
    const classes = getClasses();
    if (!classes.some((c) => String(c.id) === String(o.classId))) {
        clearSessionUnlock();
        return false;
    }
    if (o.via === "classShare") {
        currentClassId = o.classId;
        return true;
    }
    if (!nameMatchesClass(o.classId, o.nameNorm)) {
        clearSessionUnlock();
        return false;
    }
    currentClassId = o.classId;
    return true;
}

/**
 * 是否可不依赖门户班级列表进入主界面（URL 免验证或已有有效会话）。
 * 与 trySessionUnlock 判定一致但不写入 currentClassId。
 */
function canEnterWithoutPortalClassPicker() {
    if (gateBypassClassId()) return true;
    const o = readSessionUnlock();
    if (!o) return false;
    if (!getClasses().some((c) => String(c.id) === String(o.classId))) return false;
    if (o.via === "classShare") return true;
    if (typeof o.nameNorm !== "string") return false;
    return nameMatchesClass(o.classId, o.nameNorm);
}

/** 清除无效会话（与 trySessionUnlock 一致，但不写入 currentClassId）。门户列表为空且提前 return 时仍需执行，否则会话无法被 trySessionUnlock 清理。 */
function pruneInvalidSessionUnlock() {
    const o = readSessionUnlock();
    if (!o) return;
    const classes = getClasses();
    if (!classes.some((c) => String(c.id) === String(o.classId))) {
        clearSessionUnlock();
        return;
    }
    if (o.via === "classShare") return;
    if (typeof o.nameNorm !== "string") {
        clearSessionUnlock();
        return;
    }
    if (!nameMatchesClass(o.classId, o.nameNorm)) clearSessionUnlock();
}

function setGateError(msg) {
    const el = document.getElementById("gateError");
    if (!el) return;
    if (msg) {
        el.textContent = msg;
        el.classList.remove("hidden");
    } else {
        el.textContent = "";
        el.classList.add("hidden");
    }
}

function showGatePanel() {
    document.getElementById("gatePanel")?.classList.remove("hidden");
    document.getElementById("mainPanel")?.classList.add("hidden");
}

function showMainPanel() {
    document.getElementById("gatePanel")?.classList.add("hidden");
    document.getElementById("mainPanel")?.classList.remove("hidden");
}

function updateCurrentClassLabel() {
    const el = document.getElementById("currentClassLabel");
    if (!el || !currentClassId) return;
    const c = getClasses().find((x) => x.id === currentClassId);
    el.textContent = c ? (c.archived ? `${c.name}（已归档）` : c.name) : "";
}

function getScores() {
    return getScoresMap(rawData);
}

function getHistory() {
    return getHistoryMap(rawData);
}

function getStudentBest(studentId, projectId) {
    return studentBest(rawData, studentId, projectId);
}

function getStudentLatest(studentId, projectId) {
    return studentLatest(rawData, studentId, projectId);
}

function getStudentLatestDiff(studentId, projectId) {
    const scores = getScores();
    const key = `${studentId}_${projectId}`;
    const data = scores[key];
    if (!data || data.scratch) return null;
    return data.latestDiff;
}

function getFirstScore(studentId, projectId) {
    return firstScore(rawData, studentId, projectId);
}

function getRecentAverage(studentId, projectId) {
    return recentAverage(rawData, studentId, projectId);
}

function getProjectsForClass(classId) {
    return projectsForClass(rawData, classId);
}

function getClasses() {
    return classesFromData(rawData);
}

/** 门户「按姓名查找」时允许匹配的班级（受 manifest 白/黑名单约束） */
function getPortalGateClasses() {
    let list = getClasses();
    const vis = portalManifestPortal.visibleClassIds;
    if (Array.isArray(vis) && vis.length > 0) {
        const allow = new Set(vis.map(String));
        list = list.filter((c) => allow.has(String(c.id)));
    }
    const hid = portalManifestPortal.hiddenClassIds;
    if (Array.isArray(hid) && hid.length > 0) {
        const deny = new Set(hid.map(String));
        list = list.filter((c) => !deny.has(String(c.id)));
    }
    return list;
}

function getStudents() {
    return rawData.students || [];
}

function renderProjectTabs() {
    const el = document.getElementById("projectTabs");
    if (!el || !currentClassId) return;
    const projects = getProjectsForClass(currentClassId);
    const items = [
        ...projects.map((p) => ({ id: p.id, name: p.name, isAllAround: false })),
        { id: "all_around", name: "All-around 三项总和", isAllAround: true }
    ];
    el.innerHTML = "";
    for (const item of items) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "project-tab" + (item.id === currentProjectId ? " active" : "");
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", item.id === currentProjectId ? "true" : "false");
        btn.textContent = item.name;
        btn.dataset.projectId = item.id;
        btn.addEventListener("click", () => {
            currentProjectId = item.id;
            renderProjectTabs();
            renderRankings();
        });
        el.appendChild(btn);
    }
}

function metricValue(item, sortType, isAll) {
    if (isAll) return item.totalTime;
    if (sortType === "latest") return item.latest !== null ? item.latest : null;
    if (sortType === "avg") return item.avg !== null ? item.avg : null;
    if (sortType === "improve") return item.firstDiff !== null ? item.firstDiff : null;
    return item.best;
}

function renderRankings() {
    const container = document.getElementById("rankingsContainer");
    const sortType = document.getElementById("sortSelect")?.value || "best";
    if (!container || !currentClassId) return;

    const students = getStudents().filter((s) => s.classId === currentClassId);
    const rankProject = currentProjectId;
    const isAll = rankProject === "all_around";

    if (isAll) {
        const core = ["proj_333", "proj_366", "proj_cycle"];
        const tmp = [];
        for (const stu of students) {
            let total = 0;
            let ok = true;
            for (const pid of core) {
                const b = getStudentBest(stu.id, pid);
                if (b === null) {
                    ok = false;
                    break;
                }
                total += b;
            }
            if (ok) tmp.push({ studentId: stu.id, totalTime: total });
        }
        tmp.sort((a, b) => a.totalTime - b.totalTime);
        const stuMap = Object.fromEntries(students.map((s) => [s.id, s]));
        const firstScore = tmp.length ? tmp[0].totalTime : null;
        const list = tmp.map((item, idx) => {
            const gap = idx === 0 ? null : (item.totalTime - tmp[idx - 1].totalTime).toFixed(3);
            const gapToFirst =
                firstScore !== null ? (item.totalTime - firstScore).toFixed(3) : null;
            return {
                rank: idx + 1,
                studentId: item.studentId,
                name: stuMap[item.studentId]?.name,
                score: item.totalTime,
                gap,
                gapToFirst,
                recentAvg: "—",
                firstDiff: "—"
            };
        });
        paintTable(container, list, sortType, true);
        if (lookupHighlightStudentId && isMainPanelVisible()) queueScrollToLookupHighlight();
        return;
    }

    const dataList = [];
    for (const stu of students) {
        const best = getStudentBest(stu.id, rankProject);
        if (best === null) continue;
        const latest = getStudentLatest(stu.id, rankProject);
        const avg = getRecentAverage(stu.id, rankProject);
        const avgDisplay = avg !== null ? avg.toFixed(3) : "不足10次";
        const firstScore = getFirstScore(stu.id, rankProject);
        const firstDiff =
            firstScore !== null && best !== null ? best - firstScore : null;
        const firstDiffDisplay =
            firstDiff !== null
                ? firstDiff > 0
                    ? `+${firstDiff.toFixed(3)}`
                    : firstDiff.toFixed(3)
                : "—";
        dataList.push({
            studentId: stu.id,
            name: stu.name,
            best,
            latest,
            firstDiff,
            avg,
            avgDisplay,
            firstDiffDisplay
        });
    }

    switch (sortType) {
        case "best":
            dataList.sort((a, b) => a.best - b.best);
            break;
        case "latest":
            dataList.sort((a, b) => {
                const av = a.latest !== null && typeof a.latest === "number" ? a.latest : null;
                const bv = b.latest !== null && typeof b.latest === "number" ? b.latest : null;
                if (av === null && bv === null) return 0;
                if (av === null) return 1;
                if (bv === null) return -1;
                return av - bv;
            });
            break;
        case "improve":
            dataList.sort((a, b) => {
                const av = a.firstDiff !== null ? a.firstDiff : null;
                const bv = b.firstDiff !== null ? b.firstDiff : null;
                if (av === null && bv === null) return 0;
                if (av === null) return 1;
                if (bv === null) return -1;
                return av - bv;
            });
            break;
        case "avg":
            dataList.sort((a, b) => {
                const aVal = a.avg !== null ? a.avg : null;
                const bVal = b.avg !== null ? b.avg : null;
                if (aVal === null && bVal === null) return 0;
                if (aVal === null) return 1;
                if (bVal === null) return -1;
                return aVal - bVal;
            });
            break;
        default:
            dataList.sort((a, b) => a.best - b.best);
    }

    const list = dataList.map((item, idx) => {
        const curVal = metricValue(item, sortType, false);
        const prevVal = idx === 0 ? null : metricValue(dataList[idx - 1], sortType, false);
        const gap =
            idx === 0 || curVal === null || prevVal === null ? null : (curVal - prevVal).toFixed(3);
        const firstMetric = dataList.length ? metricValue(dataList[0], sortType, false) : null;
        const gapToFirst =
            firstMetric !== null && curVal !== null ? (curVal - firstMetric).toFixed(3) : null;
        return {
            rank: idx + 1,
            studentId: item.studentId,
            name: item.name,
            score: curVal,
            gap,
            gapToFirst,
            recentAvg: item.avgDisplay,
            firstDiff: item.firstDiffDisplay
        };
    });

    paintTable(container, list, sortType, false);
    if (lookupHighlightStudentId && isMainPanelVisible()) queueScrollToLookupHighlight();
}

function isMainPanelVisible() {
    const p = document.getElementById("mainPanel");
    return !!(p && !p.classList.contains("hidden"));
}

function queueScrollToLookupHighlight() {
    if (!lookupHighlightStudentId) return;
    const run = () => {
        const el = document.querySelector("#rankingsContainer tbody.rank-entry--highlight");
        if (el) {
            const reduce =
                typeof window.matchMedia === "function" &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
        }
    };
    requestAnimationFrame(() => {
        requestAnimationFrame(run);
    });
}

function paintTable(container, list, sortType, isAll) {
    if (!list.length) {
        container.innerHTML = '<div class="message">暂无有效成绩数据</div>';
        return;
    }
    let scoreLabel = "成绩(秒)";
    if (isAll) scoreLabel = "三项总和(秒)";
    else if (sortType === "latest") scoreLabel = "最新成绩(秒)";
    else if (sortType === "avg") scoreLabel = "近10次平均(秒)";
    else if (sortType === "improve") scoreLabel = "进步幅度(秒)";

    const escLabel = escapeHtml;
    const shareParams = (sid) => {
        const p = new URLSearchParams({ classId: currentClassId, studentId: sid });
        const tok = activePortalToken || getPortalTokenMap()[currentClassId];
        if (tok) p.set("token", String(tok));
        return `report.html?${p.toString()}`;
    };

    let html =
        '<table class="rank-table rank-table--stack"><thead><tr>' +
        `<th class="col-num" scope="col">排名</th><th class="col-name-head" scope="col">姓名</th>` +
        `<th class="col-metric" scope="col">${escLabel(scoreLabel)}</th>` +
        `<th class="col-metric" scope="col">与前一名差距</th><th class="col-metric" scope="col">近10次平均</th>` +
        `<th class="col-metric" scope="col">较首次</th><th class="col-metric" scope="col">距第一名差距</th>` +
        `<th class="col-share" scope="col">分享</th></tr></thead>`;

    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const gapHtml = item.gap
            ? `<span class="metric-badge metric-muted">+${item.gap}s</span>`
            : '<span class="metric-badge metric-muted">—</span>';
        const gapFirst = item.gapToFirst ? `+${item.gapToFirst}s` : "—";
        const scoreHtml =
            item.score === null || typeof item.score !== "number" ? "—" : item.score.toFixed(3);
        const avgRaw = sortType === "avg" && item.recentAvg === "不足10次" ? "—" : item.recentAvg;
        const avgHtml =
            avgRaw === "—"
                ? '<span class="metric-badge metric-muted">—</span>'
                : `<span class="metric-badge metric-muted">${avgRaw}</span>`;
        const firstHtml = (() => {
            const v = (item.firstDiff || "—").trim();
            if (v === "—") return '<span class="metric-badge metric-muted">—</span>';
            if (v.startsWith("-")) return `<span class="metric-badge metric-good">${v}s</span>`;
            if (v.startsWith("+")) return `<span class="metric-badge metric-warn">${v}s</span>`;
            return `<span class="metric-badge metric-muted">${v}s</span>`;
        })();

        const tierClass =
            item.rank === 1
                ? "rank-name-banner--gold"
                : item.rank === 2
                  ? "rank-name-banner--silver"
                  : item.rank === 3
                    ? "rank-name-banner--bronze"
                    : "rank-name-banner--plain";

        const nameEsc = escapeHtml(item.name || "");
        const shareHref = shareParams(item.studentId);
        const sidStr = String(item.studentId ?? "");
        const isLookupHighlight =
            Boolean(lookupHighlightStudentId) && sidStr === String(lookupHighlightStudentId);
        const highlightClass = isLookupHighlight ? " rank-entry--highlight" : "";
        const lookupPillHtml = isLookupHighlight
            ? `<span class="rank-lookup-pill" title="首页姓名查找的匹配行">本次查找</span>`
            : "";
        html += `<tbody class="rank-entry${highlightClass}" data-student-id="${escapeHtml(sidStr)}">`;
        html += `<tr class="rank-entry__banner"><td class="rank-entry__banner-cell" colspan="8">`;
        html += `<div class="rank-name-banner ${tierClass}" role="group" aria-label="第 ${item.rank} 名">`;
        html += `<span class="rank-name-banner__badge" aria-hidden="true">${item.rank}</span>`;
        html += `<span class="rank-name-banner__name">${nameEsc}${lookupPillHtml}</span>`;
        html += `</div></td></tr>`;
        html += `<tr class="rank-entry__metrics">`;
        html += `<td class="col-num desktop-only">${item.rank}</td>`;
        html += `<td class="col-name desktop-only">${nameEsc}${lookupPillHtml}</td>`;
        html += `<td class="col-metric" data-label="${escLabel(scoreLabel)}">${scoreHtml}</td>`;
        html += `<td class="col-metric" data-label="与前一名">${gapHtml}</td>`;
        html += `<td class="col-metric" data-label="近10次平均">${avgHtml}</td>`;
        html += `<td class="col-metric" data-label="较首次">${firstHtml}</td>`;
        html += `<td class="col-metric" data-label="距第一名">${gapFirst}</td>`;
        html += `<td class="col-share" data-label="分享简报"><a class="share-report-link" href="${escapeHtml(
            shareHref
        )}" target="_blank" rel="noopener noreferrer">分享页</a></td>`;
        html += `</tr></tbody>`;
    }
    html += "</table>";
    container.innerHTML = html;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function loadData() {
    const { data, source, portal } = await loadPortalCupData();
    rawData = data;
    dataSourceLabel = source || "";
    portalManifestPortal = portal || { visibleClassIds: null, hiddenClassIds: null };
}

function updateDataFooterMeta() {
    const meta = document.getElementById("dataUpdated");
    if (!meta) return;
    const lu = rawData?.lastUpdated;
    if (lu) {
        const d = new Date(Number(lu));
        let t = `数据快照时间：${d.toLocaleString("zh-CN")}（以导出为准）`;
        if (dataSourceLabel) t += ` · ${dataSourceLabel}`;
        meta.textContent = t;
        return;
    }
    if (dataSourceLabel) {
        const fname = dataSourceLabel.replace(/^.*\//, "");
        const parsed = parseStackClassBackupFilename(fname);
        meta.textContent = parsed
            ? `成绩备份日期：${parsed.date}（来自文件 ${fname}）`
            : `数据来源：${dataSourceLabel}`;
        return;
    }
    meta.textContent = "";
}

/**
 * 在门户可见班级中按姓名匹配学生（须完整汉字名或完整拼音/拉丁名）；同一班级只保留一条。
 * @param {string} rawInput 用户输入（trim 前由调用方保证非空）
 * @returns {Array<{ student: object, cls: object }>}
 */
function findNameMatchesInPortal(rawInput) {
    const raw = String(rawInput ?? "").trim();
    if (!raw) return [];
    const portalIds = new Set(getPortalGateClasses().map((c) => String(c.id)));
    const classById = new Map(getClasses().map((c) => [String(c.id), c]));
    const byClass = new Map();
    for (const s of getStudents()) {
        if (!portalIds.has(String(s.classId))) continue;
        if (!studentNameMatchesQuery(s.name, raw)) continue;
        const cls = classById.get(String(s.classId));
        if (!cls) continue;
        if (!byClass.has(s.classId)) byClass.set(s.classId, { student: s, cls });
    }
    return Array.from(byClass.values()).sort((a, b) =>
        a.cls.name.localeCompare(b.cls.name, "zh-CN")
    );
}

function clearGateMatchUI() {
    const section = document.getElementById("gateMatchSection");
    const hint = document.getElementById("gateMatchHint");
    const list = document.getElementById("gateMatchList");
    const summary = document.getElementById("gateMatchSummary");
    const nameEl = document.getElementById("gateMatchName");
    if (section) {
        section.classList.add("hidden");
        section.setAttribute("aria-hidden", "true");
    }
    if (summary) summary.classList.add("hidden");
    if (nameEl) nameEl.textContent = "";
    if (hint) {
        hint.textContent = "";
        hint.classList.add("hidden");
    }
    if (list) {
        list.replaceChildren();
        list.classList.add("hidden");
    }
}

function classDisplayName(cls) {
    return cls.archived ? `${cls.name}（已归档）` : cls.name;
}

/** 列表与按钮上展示的登记姓名 */
function displayStudentName(student) {
    const n = normalizeName(student?.name);
    return n || String(student?.name || "").trim() || "—";
}

function runGateNameSearch() {
    setGateError("");
    clearGateMatchUI();
    const raw = document.getElementById("gateNameInput")?.value || "";
    const trimmed = raw.trim();
    if (!trimmed) {
        setGateError("请输入与登记一致的完整姓名（汉字全名，或无声调汉语拼音全拼）。");
        document.getElementById("gateNameInput")?.focus();
        return;
    }
    const matches = findNameMatchesInPortal(raw);
    if (!matches.length) {
        setGateError(
            "未在公开班级中找到匹配。请确认已输入登记全名（汉字或无声调拼音；可连写或加空格，英文名可先名后姓），不能只填姓或名。仍无法匹配可向任课教师核实。"
        );
        return;
    }
    const section = document.getElementById("gateMatchSection");
    const hint = document.getElementById("gateMatchHint");
    const list = document.getElementById("gateMatchList");
    if (section) {
        section.classList.remove("hidden");
        section.setAttribute("aria-hidden", "false");
    }
    const summary = document.getElementById("gateMatchSummary");
    const nameEl = document.getElementById("gateMatchName");
    if (summary && nameEl) {
        if (matches.length === 1) {
            nameEl.textContent = displayStudentName(matches[0].student);
            summary.classList.remove("hidden");
        } else {
            nameEl.textContent = "";
            summary.classList.add("hidden");
        }
    }
    if (hint) {
        if (matches.length > 1) {
            hint.textContent = `在 ${matches.length} 个班级中找到匹配，请选择所在班级。`;
            hint.classList.remove("hidden");
        } else {
            hint.textContent = "";
            hint.classList.add("hidden");
        }
    }
    if (!list) return;
    list.classList.remove("hidden");
    for (const { student, cls } of matches) {
        const li = document.createElement("li");
        li.className = "gate-match-list__item";
        li.setAttribute("role", "listitem");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-outline gate-match-btn";
        const sn = displayStudentName(student);
        const cdn = classDisplayName(cls);
        const primary = document.createElement("span");
        primary.className = "gate-match-btn__primary";
        primary.textContent = cdn;
        const cta = document.createElement("span");
        cta.className = "gate-match-btn__cta";
        cta.textContent = "进入";
        btn.append(primary, cta);
        btn.setAttribute("aria-label", `进入${cdn}，登记姓名「${sn}」`);
        btn.addEventListener("click", () => {
            window.location.assign(
                getClassEntryUrl(cls.id, { fromNameLookup: true, studentId: student.id })
            );
        });
        li.appendChild(btn);
        list.appendChild(li);
    }
}

function enterMainFromUnlock() {
    const projects = getProjectsForClass(currentClassId);
    if (projects.some((p) => p.id === "proj_333")) {
        currentProjectId = "proj_333";
    } else {
        currentProjectId = projects[0]?.id || "all_around";
    }
    updateCurrentClassLabel();
    renderProjectTabs();
    renderRankings();
    updateCopyShareLinkButton();
}

/**
 * 进入某班成绩页的地址（与「复制分享链接」一致：含 classId，若有口令则同时带 token）。
 * 姓名查找点选班级时用 `fromNameLookup` 附带 entry=lookup 与 studentId，便于页头文案并在榜单中高亮该生。
 */
function getClassEntryUrl(classId, opts) {
    const u = new URL("index.html", window.location.href);
    u.searchParams.set("classId", classId);
    const tok = activePortalToken || getPortalTokenMap()[classId];
    if (tok) u.searchParams.set("token", String(tok));
    if (opts?.fromNameLookup) {
        u.searchParams.set("entry", "lookup");
        if (opts.studentId != null && opts.studentId !== "") {
            u.searchParams.set("studentId", String(opts.studentId));
        }
    }
    return u.href;
}

function getShareUrlForCurrentClass() {
    if (!currentClassId) return "";
    return getClassEntryUrl(currentClassId);
}

function updateCopyShareLinkButton() {
    const btn = document.getElementById("copyShareLinkBtn");
    if (!btn) return;
    btn.hidden = false;
    btn.disabled = !currentClassId;
}

function bindCopyShareLink() {
    const btn = document.getElementById("copyShareLinkBtn");
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = "1";
    const defaultLabel = btn.dataset.labelDefault || btn.textContent?.trim() || "复制分享链接";
    btn.addEventListener("click", async () => {
        const href = getShareUrlForCurrentClass();
        if (!href) {
            showToast("无法生成分享链接。", "err");
            return;
        }
        try {
            await navigator.clipboard.writeText(href);
            btn.textContent = "已复制 ✓";
            btn.classList.add("btn-copied");
            showToast(
                "已复制本班分享链接。通过该链接打开无需经总入口按姓名查找，即可查看本班成绩。",
                "ok"
            );
            window.setTimeout(() => {
                btn.textContent = defaultLabel;
                btn.classList.remove("btn-copied");
            }, 1800);
        } catch {
            showToast("无法自动复制，请手动选择并复制下方链接。", "err");
            window.prompt("请手动复制以下链接：", href);
        }
    });
}

function bindMainControls() {
    document.getElementById("sortSelect")?.addEventListener("change", () => renderRankings());

    document.getElementById("switchClassBtn")?.addEventListener("click", () => {
        if (tokenLockedClassId || shareLinkLockedClassId) {
            const via = tokenLockedClassId ? "口令" : "分享";
            if (
                window.confirm(
                    `切换班级将离开本班${via}链接（免验证），并打开总入口（需重新输入姓名查找班级）。确定吗？`
                )
            ) {
                window.location.href = "index.html";
            }
            return;
        }
        clearSessionUnlock();
        const nameInput = document.getElementById("gateNameInput");
        if (nameInput) {
            nameInput.value = "";
            nameInput.focus();
        }
        clearGateMatchUI();
        setGateError("");
        showGatePanel();
    });
}

function showError(msg) {
    const el = document.getElementById("loadError");
    const main = document.getElementById("mainPanel");
    const gate = document.getElementById("gatePanel");
    if (el) {
        el.textContent = msg;
        el.classList.remove("hidden");
    }
    if (main) main.classList.add("hidden");
    if (gate) gate.classList.add("hidden");
}

async function boot() {
    initThemeControls();
    try {
        await loadData();
    } catch (e) {
        hideBootLoading();
        showError(
            (e && e.message) ||
                "加载失败。请将 stack_class_backup_*.json 放入 data/ 并维护 manifest.json（见 data/README.txt），用本地 HTTP 打开（勿用 file://）。"
        );
        return;
    }
    hideBootLoading();
    document.getElementById("loadError")?.classList.add("hidden");

    const pageParams = new URLSearchParams(window.location.search);
    const rawUrlToken = (pageParams.get("token") || pageParams.get("t") || "").trim();
    const urlClassId = (pageParams.get("classId") || "").trim();

    // 无 ?token/?classId 的总入口：清会话，避免从分享/classId 页后退到此仍被 classShare 自动带入主页
    if (!rawUrlToken && !urlClassId) {
        clearSessionUnlock();
    }

    tokenLockedClassId = resolveClassIdFromPortalTokenParam(rawUrlToken) || "";
    activePortalToken = tokenLockedClassId ? rawUrlToken : "";

    if (rawUrlToken && !tokenLockedClassId) {
        activePortalToken = "";
    }

    const classes = getClasses();
    if (tokenLockedClassId && !classes.some((c) => c.id === tokenLockedClassId)) {
        tokenLockedClassId = "";
        activePortalToken = "";
    }

    shareLinkLockedClassId = "";
    if (!tokenLockedClassId && urlClassId && classes.some((c) => c.id === urlClassId)) {
        shareLinkLockedClassId = urlClassId;
    }

    if (gateBypassClassId()) {
        const o = readSessionUnlock();
        const gid = gateBypassClassId();
        if (o && String(o.classId) !== String(gid)) clearSessionUnlock();
    }

    lookupHighlightStudentId = "";
    if (pageParams.get("entry") === "lookup") {
        const hsid = (pageParams.get("studentId") || "").trim();
        const gid = gateBypassClassId();
        if (
            hsid &&
            gid &&
            getStudents().some((s) => String(s.id) === hsid && String(s.classId) === String(gid))
        ) {
            lookupHighlightStudentId = hsid;
        }
    }

    applyTokenGateUI();
    applySiteLeadText();

    updateDataFooterMeta();

    pruneInvalidSessionUnlock();

    if (!classes.length) {
        showGatePanel();
        setGateError("当前数据中没有班级，请教师更新 data/ 下成绩文件后再试。");
        document.getElementById("gateSearchBtn")?.setAttribute("disabled", "disabled");
        return;
    }

    if (!getPortalGateClasses().length && !canEnterWithoutPortalClassPicker()) {
        showGatePanel();
        setGateError(
            "门户未配置可选班级：请在 data/manifest.json 中设置 visibleClassIds，或调整 hiddenClassIds（见 data/README.txt）。"
        );
        document.getElementById("gateSearchBtn")?.setAttribute("disabled", "disabled");
        return;
    }

    if (urlClassId && !shareLinkLockedClassId && !tokenLockedClassId) {
        clearSessionUnlock();
        setGateError(
            "链接中的班级标识无效或已过期（该班不存在或教师已更新数据）。请从总入口输入姓名查找所在班级。"
        );
    } else if (rawUrlToken && !tokenLockedClassId && !shareLinkLockedClassId) {
        clearSessionUnlock();
        setGateError(
            "链接中的班级口令无效或已停用。请向老师索取最新链接，或从总入口输入姓名查找班级。"
        );
    }

    document.getElementById("gateForm")?.addEventListener("submit", (ev) => {
        ev.preventDefault();
        runGateNameSearch();
    });

    bindMainControls();
    bindCopyShareLink();

    if (tokenLockedClassId) {
        clearSessionUnlock();
        currentClassId = tokenLockedClassId;
        enterMainFromUnlock();
        showMainPanel();
        if (lookupHighlightStudentId) queueScrollToLookupHighlight();
        return;
    }

    if (shareLinkLockedClassId) {
        currentClassId = shareLinkLockedClassId;
        writeSessionClassShareUnlock(shareLinkLockedClassId);
        enterMainFromUnlock();
        showMainPanel();
        if (lookupHighlightStudentId) queueScrollToLookupHighlight();
        return;
    }

    if (trySessionUnlock()) {
        enterMainFromUnlock();
        showMainPanel();
    } else {
        showGatePanel();
        document.getElementById("gateNameInput")?.focus();
    }
}

boot();

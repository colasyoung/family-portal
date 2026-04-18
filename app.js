/**
 * family-portal：独立只读站，读取与 Server 版同结构的 JSON（默认从 data/ 目录按 manifest 取最新备份）。
 * 本地预览：在本目录执行 python3 -m http.server 8765，打开 http://127.0.0.1:8765/
 *
 * 默认入口：选择班级并输入该班学生姓名（与登记一致）验证后查看榜单；同一会话内刷新可保持验证（sessionStorage）。
 * 免验证入口二选一：① URL 带有效 portalClassTokens 口令（?token=）；② ?classId= 对应数据中存在该班即可（无需在数据中配置口令；简报页仍为 classId+studentId）。
 */

import { loadPortalCupData, parseStackClassBackupFilename } from "./cup-data-loader.js";
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
let currentClassId = "";
let currentProjectId = "proj_333";

/** 当前页 URL 携带的本班口令（写入分享链接）；与 portalClassTokens 中该班登记的值一致 */
let activePortalToken = "";
/** 若 URL ?token= 有效且能在数据中解析到班级，则跳过验证门直接进入该班榜单 */
let tokenLockedClassId = "";
/** 若 URL ?classId= 对应数据中存在该班，则免验证进入该班（不依赖 portalClassTokens） */
let shareLinkLockedClassId = "";

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
    const field = document.getElementById("gateClassField");
    const hint = document.getElementById("gateTokenHint");
    const nameLabel = document.getElementById("gateNameStepLabel");
    if (field) field.classList.toggle("hidden", !!gid);
    if (hint) hint.classList.toggle("hidden", !gid);
    const n = document.getElementById("gateTokenClassName");
    if (n && gid) {
        const c = getClasses().find((x) => x.id === gid);
        n.textContent = c ? (c.archived ? `${c.name}（已归档）` : c.name) : "—";
    }
    const sel = document.getElementById("gateClassSelect");
    if (sel) {
        if (gid) {
            sel.value = gid;
            sel.removeAttribute("required");
        } else {
            sel.setAttribute("required", "required");
        }
    }
    if (nameLabel) nameLabel.textContent = gid ? "① 学生姓名" : "② 学生姓名";
}

function applySiteLeadText() {
    const el = document.getElementById("siteLead");
    if (!el) return;
    if (tokenLockedClassId) {
        el.textContent =
            "当前通过班级口令链接浏览本班榜单（无需输入学生姓名）。数据由教师不定期更新。";
    } else if (shareLinkLockedClassId) {
        el.textContent =
            "当前通过班级分享链接浏览本班榜单（仅含班级标识，无需再次输入姓名）。数据由教师不定期更新。";
    } else {
        el.textContent =
            "只读榜单：选择班级并输入该班学生姓名验证通过后即可查看课堂成绩；数据由教师不定期更新。";
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

/** 姓名是否与该班某位学生登记一致（规范化后全等） */
function nameMatchesClass(classId, inputName) {
    const n = normalizeName(inputName);
    if (!n) return false;
    return getStudentsInClass(classId).some((s) => normalizeName(s.name) === n);
}

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

function writeSessionUnlock(classId, nameNorm) {
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ classId, nameNorm }));
    } catch {
        /* ignore */
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
    if (!classes.some((c) => c.id === o.classId)) {
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
        html += `<tbody class="rank-entry">`;
        html += `<tr class="rank-entry__banner"><td class="rank-entry__banner-cell" colspan="8">`;
        html += `<div class="rank-name-banner ${tierClass}" role="group" aria-label="第 ${item.rank} 名">`;
        html += `<span class="rank-name-banner__badge" aria-hidden="true">${item.rank}</span>`;
        html += `<span class="rank-name-banner__name">${nameEsc}</span>`;
        html += `</div></td></tr>`;
        html += `<tr class="rank-entry__metrics">`;
        html += `<td class="col-num desktop-only">${item.rank}</td>`;
        html += `<td class="col-name desktop-only">${nameEsc}</td>`;
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
    const { data, source } = await loadPortalCupData();
    rawData = data;
    dataSourceLabel = source || "";
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

function populateGateClassSelect() {
    const sel = document.getElementById("gateClassSelect");
    if (!sel) return;
    const classes = getClasses();
    sel.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "请选择班级";
    sel.appendChild(ph);
    for (const c of classes) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.archived ? `${c.name}（已归档）` : c.name;
        sel.appendChild(opt);
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

function getShareUrlForCurrentClass() {
    if (!currentClassId) return "";
    const u = new URL("index.html", window.location.href);
    u.searchParams.set("classId", currentClassId);
    const tok = activePortalToken || getPortalTokenMap()[currentClassId];
    if (tok) u.searchParams.set("token", String(tok));
    return u.href;
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
                "已复制本班分享链接。通过分享链接打开无需验证即可查看班级排行榜。",
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
            if (
                window.confirm(
                    "切换班级将离开本班分享链接（免验证），并打开总入口（需重新选择班级并验证）。确定吗？"
                )
            ) {
                window.location.href = "index.html";
            }
            return;
        }
        clearSessionUnlock();
        const gateClass = document.getElementById("gateClassSelect");
        const nameInput = document.getElementById("gateNameInput");
        if (gateClass) gateClass.value = currentClassId || "";
        if (nameInput) {
            nameInput.value = "";
            nameInput.focus();
        }
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
        if (o && o.classId !== gateBypassClassId()) clearSessionUnlock();
    }

    populateGateClassSelect();
    const gid = gateBypassClassId();
    if (gid) {
        const sel = document.getElementById("gateClassSelect");
        if (sel) sel.value = gid;
    }
    applyTokenGateUI();
    applySiteLeadText();

    updateDataFooterMeta();

    if (!classes.length) {
        showGatePanel();
        setGateError("当前数据中没有班级，请教师更新 data/ 下成绩文件后再试。");
        document.getElementById("gateSubmitBtn")?.setAttribute("disabled", "disabled");
        return;
    }

    if (urlClassId && !shareLinkLockedClassId && !tokenLockedClassId) {
        clearSessionUnlock();
        setGateError(
            "分享链接无效或已过期（班级不存在或教师已更新数据）。请从总入口选择班级并验证。"
        );
    } else if (rawUrlToken && !tokenLockedClassId && !shareLinkLockedClassId) {
        clearSessionUnlock();
        setGateError(
            "链接中的班级口令无效或已停用。请向老师索取最新链接，或从总入口手动选择班级。"
        );
    }

    document.getElementById("gateForm")?.addEventListener("submit", (ev) => {
        ev.preventDefault();
        setGateError("");
        const classId = document.getElementById("gateClassSelect")?.value || "";
        const rawName = document.getElementById("gateNameInput")?.value || "";
        if (!classId) {
            setGateError("请先选择班级。");
            return;
        }
        const roster = getStudentsInClass(classId);
        if (!roster.length) {
            setGateError("该班级暂无学生名单，无法验证。");
            return;
        }
        if (!normalizeName(rawName)) {
            setGateError("请输入该班一名学生的姓名。");
            document.getElementById("gateNameInput")?.focus();
            return;
        }
        if (!nameMatchesClass(classId, rawName)) {
            setGateError("姓名与所选班级不符。请核对是否与系统登记完全一致（勿多空格）。");
            return;
        }
        currentClassId = classId;
        writeSessionUnlock(classId, normalizeName(rawName));
        enterMainFromUnlock();
        showMainPanel();
    });

    document.getElementById("gateClassSelect")?.addEventListener("change", () => {
        setGateError("");
    });

    bindMainControls();
    bindCopyShareLink();

    if (tokenLockedClassId) {
        clearSessionUnlock();
        currentClassId = tokenLockedClassId;
        enterMainFromUnlock();
        showMainPanel();
        return;
    }

    if (shareLinkLockedClassId) {
        currentClassId = shareLinkLockedClassId;
        writeSessionClassShareUnlock(shareLinkLockedClassId);
        enterMainFromUnlock();
        showMainPanel();
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

/**
 * 与 Server 版成绩 JSON（根目录 data.json 或导出备份）结构对齐的只读数据工具（family-portal 内共享）
 */

export const CORE_PROJECT_IDS = ["proj_333", "proj_366", "proj_cycle"];

export const CORE_PROJECTS = [
    { id: "proj_333", name: "3-3-3", isCustom: false },
    { id: "proj_366", name: "3-6-3", isCustom: false },
    { id: "proj_cycle", name: "Cycle", isCustom: false }
];

export function applyScoresTombstones(scores, tombstones) {
    if (!scores || typeof scores !== "object") return {};
    if (!tombstones || typeof tombstones !== "object") return { ...scores };
    const out = {};
    for (const key of Object.keys(scores)) {
        const rec = scores[key];
        const delAt = tombstones[key];
        const delTs = Number(delAt);
        if (!Number.isFinite(delTs) || delTs <= 0) {
            out[key] = rec;
            continue;
        }
        const recTs = rec && typeof rec === "object" ? Number(rec.updatedAt || 0) : 0;
        if (!Number.isFinite(recTs) || recTs <= 0) continue;
        if (recTs > delTs) out[key] = rec;
    }
    return out;
}

export function applyHistoryTombstones(history, tombstones) {
    if (!history || typeof history !== "object") return {};
    if (!tombstones || typeof tombstones !== "object") return { ...history };
    const out = {};
    for (const key of Object.keys(history)) {
        const records = Array.isArray(history[key]) ? history[key] : [];
        const del = Array.isArray(tombstones[key]) ? tombstones[key] : [];
        const delSet = new Set(del.map((x) => Number(x)).filter((x) => Number.isFinite(x)));
        const filtered = records.filter(
            (r) => r && Number.isFinite(Number(r.timestamp)) && !delSet.has(Number(r.timestamp))
        );
        if (filtered.length) out[key] = filtered;
    }
    return out;
}

export function getScoresMap(data) {
    return applyScoresTombstones(data.scores || {}, data.scoresTombstones || {});
}

export function getHistoryMap(data) {
    return applyHistoryTombstones(data.history || {}, data.historyTombstones || {});
}

export function getStudentBest(data, studentId, projectId) {
    const scores = getScoresMap(data);
    const key = `${studentId}_${projectId}`;
    const rec = scores[key];
    if (!rec || rec.scratch) return null;
    return rec.bestTime;
}

export function getStudentLatest(data, studentId, projectId) {
    const scores = getScoresMap(data);
    const key = `${studentId}_${projectId}`;
    const rec = scores[key];
    if (!rec || rec.scratch) return null;
    return rec.latestTime;
}

export function getFirstScore(data, studentId, projectId) {
    const history = getHistoryMap(data);
    const key = `${studentId}_${projectId}`;
    const records = history[key] || [];
    if (records.length === 0) return null;
    const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
    return sorted[0].time;
}

export function getRecentAverage(data, studentId, projectId) {
    const history = getHistoryMap(data);
    const key = `${studentId}_${projectId}`;
    const records = history[key] || [];
    if (records.length < 10) return null;
    const sortedByTime = [...records].sort((a, b) => a.timestamp - b.timestamp);
    const last10 = sortedByTime.slice(-10).map((r) => r.time);
    last10.sort((a, b) => a - b);
    const trimmed = last10.slice(1, -1);
    const sum = trimmed.reduce((a, b) => a + b, 0);
    return sum / trimmed.length;
}

export function getStudentsInClass(data, classId) {
    return (data.students || []).filter((s) => s.classId === classId);
}

export function getProjectsForClass(data, classId) {
    const custom = (data.customProjectsByClass && data.customProjectsByClass[classId]) || [];
    return [...CORE_PROJECTS, ...custom];
}

export function getClasses(data) {
    const list = data.classes || [];
    const active = list.filter((c) => !c.archived);
    const archived = list.filter((c) => c.archived);
    return [...active, ...archived];
}

/**
 * @returns {{ rank: number, total: number, best: number } | null}
 */
export function computeProjectRank(data, classId, studentId, projectId) {
    const roster = getStudentsInClass(data, classId);
    const rows = [];
    for (const s of roster) {
        const b = getStudentBest(data, s.id, projectId);
        if (b !== null) rows.push({ id: s.id, best: b });
    }
    rows.sort((a, b) => a.best - b.best);
    const idx = rows.findIndex((r) => r.id === studentId);
    if (idx < 0) return null;
    return { rank: idx + 1, total: rows.length, best: rows[idx].best };
}

/**
 * @returns {{ rank: number, total: number, sum: number } | null}
 */
export function computeAllAroundRank(data, classId, studentId) {
    const roster = getStudentsInClass(data, classId);
    const rows = [];
    for (const s of roster) {
        let sum = 0;
        let ok = true;
        for (const pid of CORE_PROJECT_IDS) {
            const b = getStudentBest(data, s.id, pid);
            if (b === null) {
                ok = false;
                break;
            }
            sum += b;
        }
        if (ok) rows.push({ id: s.id, sum });
    }
    rows.sort((a, b) => a.sum - b.sum);
    const idx = rows.findIndex((r) => r.id === studentId);
    if (idx < 0) return null;
    return { rank: idx + 1, total: rows.length, sum: rows[idx].sum };
}

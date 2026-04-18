/**
 * 从 data/ 目录加载成绩 JSON：优先读 manifest.json 中的列表，
 * 按「课堂系统导出」命名 stack_class_backup_YYYY-MM-DD(_N).json 取**最新**一份。
 * 兼容：根目录遗留的 data.json。
 */

const MANIFEST_PATH = "./data/manifest.json";
const LEGACY_DATA_JSON = "./data.json";
const FIXED_ALIAS = "./data/stack_class_backup.json";

/**
 * 与 Server 版「导出备份」一致：
 * stack_class_backup_YYYY-MM-DD.json
 * stack_class_backup_YYYY-MM-DD_2.json …
 * @returns {{ date: string, suffix: number } | null}
 */
export function parseStackClassBackupFilename(filename) {
    const m = String(filename).match(/^stack_class_backup_(\d{4}-\d{2}-\d{2})(?:_(\d+))?\.json$/i);
    if (!m) return null;
    return { date: m[1], suffix: m[2] ? parseInt(m[2], 10) : 0 };
}

/** 新文件优先：日期大者优先；同日则后缀大者优先（_3 > _2 > 无） */
export function compareStackClassBackupDesc(a, b) {
    const pa = parseStackClassBackupFilename(a);
    const pb = parseStackClassBackupFilename(b);
    if (!pa && !pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    if (pa.date !== pb.date) return pa.date < pb.date ? 1 : -1;
    return pb.suffix - pa.suffix;
}

function sortNewestFirst(filenames) {
    return [...filenames].filter((f) => parseStackClassBackupFilename(f)).sort(compareStackClassBackupDesc);
}

async function fetchJsonOk(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    try {
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * 门户班级展示：manifest.json 可选字段，与 files 并列。
 * - visibleClassIds：非空时仅展示列表中的 classId（白名单）
 * - hiddenClassIds：从门户列表中排除这些 classId
 * @param {any} manifest
 * @returns {{ visibleClassIds: string[] | null, hiddenClassIds: string[] | null }}
 */
export function parseManifestPortal(manifest) {
    if (!manifest || typeof manifest !== "object") {
        return { visibleClassIds: null, hiddenClassIds: null };
    }
    const vis = manifest.visibleClassIds;
    const hid = manifest.hiddenClassIds;
    return {
        visibleClassIds: Array.isArray(vis) ? vis.map(String) : null,
        hiddenClassIds: Array.isArray(hid) ? hid.map(String) : null
    };
}

/**
 * @returns {Promise<{ data: any, source: string, portal: ReturnType<typeof parseManifestPortal> }>}
 */
export async function loadPortalCupData() {
    const bust = Date.now();

    let manifest = null;
    try {
        const mr = await fetch(`${MANIFEST_PATH}?bust=${bust}`, { cache: "no-store" });
        if (mr.ok) manifest = await mr.json();
    } catch {
        /* ignore */
    }

    const portal = parseManifestPortal(manifest);

    const listed = Array.isArray(manifest?.files) ? manifest.files.map(String) : [];
    const parsed = sortNewestFirst(listed);
    const extras = listed.filter((f) => !parseStackClassBackupFilename(f));
    const tryOrder = [...parsed, ...extras];

    for (const name of tryOrder) {
        const url = `./data/${encodeURIComponent(name)}`;
        const data = await fetchJsonOk(`${url}?bust=${bust}`);
        if (data) return { data, source: `data/${name}`, portal };
    }

    const alias = await fetchJsonOk(`${FIXED_ALIAS}?bust=${bust}`);
    if (alias) return { data: alias, source: "data/stack_class_backup.json", portal };

    const legacy = await fetchJsonOk(`${LEGACY_DATA_JSON}?bust=${bust}`);
    if (legacy) return { data: legacy, source: "data.json（根目录遗留）", portal };

    throw new Error(
        "无法加载成绩数据。请将 stack_class_backup_*.json 放入 data/ 并维护 data/manifest.json，或运行 node tools/update-data-manifest.mjs"
    );
}

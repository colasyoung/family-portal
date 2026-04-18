#!/usr/bin/env node
/**
 * 扫描 family-portal/data/ 下 stack_class_backup_*.json，重写 data/manifest.json。
 * 用法（在 family-portal 目录）：node tools/update-data-manifest.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { compareStackClassBackupDesc } from "../cup-data-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const manifestPath = path.join(dataDir, "manifest.json");

const re = /^stack_class_backup_\d{4}-\d{2}-\d{2}(?:_\d+)?\.json$/i;

function main() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const names = fs
        .readdirSync(dataDir)
        .filter((f) => re.test(f) && f !== "manifest.json")
        .sort(compareStackClassBackupDesc);

    const manifest = {
        comment:
            "由 tools/update-data-manifest.mjs 生成；也可手动编辑 files。网页会取其中「最新」命名的一份。",
        files: names
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    console.log(`已写入 ${path.relative(root, manifestPath)}，共 ${names.length} 个 stack_class 备份：`);
    names.forEach((n) => console.log(`  - ${n}`));
}

main();

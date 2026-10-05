/**
 * 历史清理脚本 —— 给 `git filter-branch --tree-filter` 用。
 *
 * 每一份历史快照会被 checkout 到一个临时目录，这个脚本在那里跑（cwd = 那份树）。
 *
 * ## 为什么是**黑名单**而不是白名单
 *
 * 第一版用的是扩展名白名单（.ts/.py/.csv/.md/.json/.txt），结果**漏掉了 `.html`** ——
 * 设计对比样张 `docs/design/2026-10-05-ui-directions.html` 里写着我从真库取的
 * 真实学号，而它的扩展名不在白名单里，扫描和重写都跳过了它。
 *
 * 白名单的失效方式是"静默漏掉"：新增一种文件类型时，没人会想起来改这个列表。
 * 现在反过来 —— 只跳过**明确知道是二进制**的扩展名，其余一律按文本处理。
 *
 * 三件事：
 *   1. 文本文件里把**真名**换成假名
 *   2. 文本文件里把**真学号**换成假学号（读 data/_idmap.json）
 *   3. 二进制夹具 xlsx 换成现在这份干净的（zip 压缩过，文本替换清不掉）
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { join, extname, basename } from "node:path";

/** 明确是二进制的扩展名 —— 只有这些会被跳过 */
const BINARY_EXT = new Set([
  ".xlsx", ".xls", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".zip", ".gz", ".tar", ".7z", ".sqlite", ".db", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4",
]);

/** 与 src/cli/anonymize.ts 的映射保持一致 */
const NAMES = {
  方镝睿: "赵雨桐",
  王涛: "李海燕",
  兰詩卉: "周雅静",
  王晶晶: "吴佳琪",
  王惟: "郑晓明",
  马俊杰: "孙志强",
  史一秀: "黄秀英",
  王俊陆: "徐俊宇",
  付一鸣: "何一鸣",
  于兆涵: "高子涵",
  马辰鑫: "林浩然",
  "乃比江·依米提": "阿迪拉·艾山",
};

const FIXTURE_SRC = process.env.ZC_FIXTURE_SRC ?? "";
const IDMAP = process.env.ZC_IDMAP ?? "";
const IDS = IDMAP && existsSync(IDMAP) ? JSON.parse(readFileSync(IDMAP, "utf8")) : {};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

for (const file of walk(".")) {
  const ext = extname(file).toLowerCase();

  // 二进制夹具：整份换成干净的
  if (ext === ".xlsx" && FIXTURE_SRC) {
    const src = join(FIXTURE_SRC, basename(file));
    if (existsSync(src)) copyFileSync(src, file);
    continue;
  }

  if (BINARY_EXT.has(ext)) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // 不是 UTF-8 就当二进制跳过
  }
  // 含 NUL 的几乎一定是二进制
  if (text.includes("\u0000")) continue;

  const before = text;
  for (const [real, fake] of Object.entries(NAMES)) {
    if (text.includes(real)) text = text.split(real).join(fake);
  }
  for (const [real, fake] of Object.entries(IDS)) {
    if (text.includes(real)) text = text.split(real).join(fake);
  }
  if (text !== before) writeFileSync(file, text, "utf8");
}

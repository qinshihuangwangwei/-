/**
 * 把各部门已有的 A 项成绩表装载进账本
 *
 *   node src/cli/importA.ts ./data/zongce.sqlite <成绩表.xlsx> [--dry-run] [--term N]
 *
 * ## 为什么需要它，以及它为什么是**诚实**的
 *
 * A 项在系统里的正道是：各部部长在切片工作台逐人录入 → 副部长复核 →
 * 部长批准 → 冻结。那是设计要走的路。
 *
 * 但现实中，各部的分数**本来就是先在一张 Excel 里汇总好的**。
 * 让人对着屏幕把一百多号人乘二十几个子项重新敲一遍，
 * 既慢，又多一层敲错的机会 —— 那不是"透明"，那是自找的错误来源。
 *
 * 所以这个命令做的事是：**把那张表搬进账本，并如实标明它是搬进来的。**
 *
 * ## 两点让这件事站得住
 *
 * 1. **事件类型是 `IMPORT`**，不是 `ENTRY`。
 *    `score_events.event_type` 里本来就有这个值（迁移 001），
 *    设计时就预留了"这条分是搬运来的，不是谁的判断"。
 *    账本因此不会把一张表格冒充成某个人的评审意见。
 * 2. **账本只增不改**。装载之后切片仍然是 OPEN，照样要走复核、批准、冻结；
 *    公示之后照样可以申诉。这个命令不跳过任何一道监督。
 *
 * ## 幂等
 *
 * 写入的是 `目标分 − 当前分`。目标分已经达到时差值为 0，**不产生事件**。
 * 所以重复执行是安全的，只补差额。这也意味着它永远不会覆盖已有的分 ——
 * 分数只通过追加新事件来改变。
 *
 * ## 换算规则
 *
 * 表里给的是**总分**，账本记的是 **delta**：
 *
 *   · ACCUMULATE 项：当前分从 0 起，delta = 表里的值
 *   · BASELINE 项（A6 遵纪守法，基线 5、上限 6）：
 *     当前分**已经含基线**，所以表里的 5 分对应 delta 0，不产生事件；
 *     表里 4 分对应 delta −1（扣分）。基线制项不接受正向加分，
 *     这一点由 `assertWithinBounds` 自己把关，这里不绕开它。
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { openDatabase, type Db } from "../db/db.ts";
import { systemClock } from "../domain/clock.ts";
import { activeTerm, getTerm } from "../domain/term.ts";
import { getItem } from "../domain/item.ts";
import { listSlices, record, scoreOf, type Slice } from "../domain/slice.ts";
import { cellText, ImportError, parseNumericCell, readTable } from "../import/table.ts";
import type { CellValue } from "../import/xlsx.ts";

/**
 * 列 → 计分项。
 *
 * **不按表头文字猜。** 这个文件的表头是三层合并单元格，文字里有全角括号、
 * 换行、以及"参与学生工作情况（12分）"这种**子组上限**和真正的项目上限
 * 并存的写法 —— 猜错一列，一百多号人的一项分就整体错位。
 *
 * 所以写死映射，然后**用它去校验**：`columnCaps` 从表里抽出每一列声明的上限，
 * 和数据库里该项的上限逐一对账，不一致就拒绝导入。
 * 25 个列的上限如果全部吻合，映射几乎不可能是错的；
 * 有一个不吻合，说明表格和系统的认知已经分叉，那才是必须停下来的时刻。
 */
const COLUMNS: ReadonlyArray<{
  col: string;
  itemId: number;
  label: string;
  /**
   * 表头里没写上限时，用什么去对账。
   *
   * C 项（附加分）那一列的表头只有一个 "C" —— 这个文件的作者没给它标分，
   * 所以 `declaredCap` 读不到东西。但"读不到"不等于"不用查"：
   * 写上代码里的期望值，数据库的 cap 一旦被改动就会在这里露出来。
   */
  fallbackCap?: number;
}> = [
  { col: "D", itemId: 1, label: "A1 志愿服务立项及开展" },
  { col: "E", itemId: 2, label: "A1 日常志愿服务及社会服务奉献" },
  { col: "F", itemId: 3, label: "A2 学生干部任职加分" },
  { col: "G", itemId: 4, label: "A2 参与学生工作·主管部门评定" },
  { col: "H", itemId: 5, label: "A2 参与学生工作·班级评定" },
  { col: "I", itemId: 6, label: "A2 劳动" },
  { col: "J", itemId: 7, label: "A3 党建活动" },
  { col: "K", itemId: 8, label: "A3 班团活动" },
  { col: "M", itemId: 9, label: "A3 青年大学习" },
  { col: "N", itemId: 10, label: "A3 突出贡献" },
  { col: "O", itemId: 11, label: "A4 寝室检查" },
  { col: "P", itemId: 12, label: "A4 校、院级公寓文化节活动" },
  { col: "Q", itemId: 13, label: "A4 星级寝室评比" },
  { col: "R", itemId: 14, label: "A5 立项加分" },
  { col: "S", itemId: 15, label: "A5 团体社会实践" },
  { col: "T", itemId: 16, label: "A5 个人社会实践" },
  { col: "U", itemId: 17, label: "A6 遵纪守法（基线制）" },
  { col: "X", itemId: 18, label: "A7 社团" },
  { col: "Y", itemId: 19, label: "A7 文艺类" },
  { col: "Z", itemId: 20, label: "A7 体育类" },
  { col: "AA", itemId: 21, label: "A7 创新创业类" },
  { col: "AB", itemId: 22, label: "A7 其他素质能力" },
  { col: "AC", itemId: 23, label: "A8 易班·个人活跃度" },
  { col: "AD", itemId: 24, label: "A8 易班APP线上活动" },
  { col: "AE", itemId: 25, label: "A8 易班线下活动" },
  // C 项也在同一张表里（表头只写 "C"，表尾的 S=A*0.3+B*0.7+C 印证了它就是附加分）。
  // B 项**不在这里** —— 它是导入的事实数据，走 b_scores 那条通道，不进账本。
  { col: "AJ", itemId: 26, label: "C 附加分", fallbackCap: 12 },
];

const ACTOR_NOTE = "cli:import-a";

// ---------------------------------------------------------------------------
// 列号
// ---------------------------------------------------------------------------

function columnIndex(letter: string): number {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 从某一列里抽出**最后**一个 `（N分）` 声明的上限。 */
function declaredCap(rows: readonly CellValue[][], colIndex: number, until: number): number | null {
  let found: number | null = null;
  for (let r = 0; r < until; r += 1) {
    const text = cellText(rows[r]?.[colIndex] ?? null).replace(/\s/g, "");
    if (text === "") continue;
    for (const m of text.matchAll(/[（(](\d+(?:\.\d+)?)分[)）]/g)) {
      found = Number(m[1]);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

interface Row {
  sheet: string;
  excelRow: number;
  studentId: string;
  name: string;
  className: string;
  values: Map<number, number>;
}

interface Survey {
  sheets: number;
  rows: Row[];
  /** 学号出现两次的：源文件要去重，这里不猜哪个对 */
  duplicates: Array<{ studentId: string; where: string[] }>;
  /** 每列声明的上限，用来和数据库对账 */
  caps: Map<number, { col: string; declared: number | null }>;
  /** 表里出现、名册里没有的学号 */
  unknownStudents: Map<string, string>;
}

function survey(buffer: Buffer, filename: string): Survey {
  const table = readTable(buffer, filename);

  const rows: Row[] = [];
  const seen = new Map<string, string[]>();
  const unknown = new Map<string, string>();
  const caps = new Map<number, { col: string; declared: number | null }>();

  for (const sheet of table.sheets) {
    const grid = sheet.rows;

    // 表头行：哪一行有「学号」
    let headerRow = -1;
    let idCol = -1;
    let nameCol = -1;
    let classCol = -1;
    for (let r = 0; r < Math.min(grid.length, 12); r += 1) {
      const row = grid[r] ?? [];
      const found = row.findIndex((c) => cellText(c).replace(/\s/g, "") === "学号");
      if (found >= 0) {
        headerRow = r;
        idCol = found;
        nameCol = row.findIndex((c) => cellText(c).replace(/\s/g, "") === "姓名");
        classCol = row.findIndex((c) => cellText(c).replace(/\s/g, "") === "班级");
        break;
      }
    }

    if (headerRow < 0) {
      throw new ImportError(
        "NO_HEADER",
        `工作表「${sheet.name}」里找不到「学号」这一列。` +
          `这个命令按固定的列位置读 A 项成绩表，表头对不上就没法安全地往下走。`,
        [`该表前 3 行：${grid.slice(0, 3).map((r) => r.map(cellText).join(" | ")).join(" ／ ")}`],
      );
    }
    if (nameCol < 0) {
      throw new ImportError("NO_NAME_COLUMN", `工作表「${sheet.name}」里找不到「姓名」列。`);
    }

    // 数据从哪一行开始：学号列出现像学号的东西
    let dataStart = headerRow + 1;
    while (dataStart < grid.length) {
      const v = cellText(grid[dataStart]?.[idCol] ?? null).replace(/\s/g, "");
      if (/^\d{6,}$/.test(v)) break;
      dataStart += 1;
    }

    // 对账：每一列声明的上限
    for (const { col, itemId } of COLUMNS) {
      if (caps.has(itemId)) continue;
      caps.set(itemId, { col, declared: declaredCap(grid, columnIndex(col), dataStart) });
    }

    for (let r = dataStart; r < grid.length; r += 1) {
      const row = grid[r] ?? [];
      const studentId = cellText(row[idCol] ?? null).replace(/\s/g, "");
      if (!/^\d{6,}$/.test(studentId)) continue;

      const name = cellText(row[nameCol] ?? null).trim();
      const className = classCol >= 0 ? cellText(row[classCol] ?? null).trim() : "";

      const values = new Map<number, number>();
      for (const { col, itemId } of COLUMNS) {
        const raw = cellText(row[columnIndex(col)] ?? null).trim();
        if (raw === "") continue;
        const n = parseNumericCell(raw);
        if (n === null) continue;
        if (n === 0) continue; // 0 分不需要事件：没有事件就是 0
        values.set(itemId, n);
      }

      rows.push({ sheet: sheet.name, excelRow: r + 1, studentId, name, className, values });

      const where = seen.get(studentId) ?? [];
      where.push(`「${sheet.name}」第 ${r + 1} 行`);
      seen.set(studentId, where);
    }
  }

  const duplicates = [...seen.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([studentId, where]) => ({ studentId, where }));

  return {
    sheets: table.sheets.length,
    rows,
    duplicates,
    caps,
    unknownStudents: unknown,
  };
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function main(): number {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const termFlag = args.indexOf("--term");
  const termId = termFlag >= 0 ? Number(args[termFlag + 1]) : null;

  const dbPath = positional[0];
  const filePath = positional[1];

  if (!dbPath || !filePath) {
    console.error(
      "\n用法：node src/cli/importA.ts <数据库> <成绩表.xlsx> [--dry-run] [--term N]\n",
    );
    return 1;
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    console.error(
      `\n❌ 读不到成绩表：${filePath}\n   ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const db = openDatabase(dbPath);
  const clock = systemClock;

  try {
    const term = termId !== null ? getTerm(db, termId) : activeTerm(db, clock);
    if (!term) {
      console.error("\n❌ 没有找到可导入的周期（当前没有生效中的周期）。\n");
      return 1;
    }

    const filename = filePath.replace(/^.*[\\/]/, "");

    // 文件指纹。理由里带上它，日后才能回答"这条分到底是从哪一份文件来的"——
    // 同名文件改一个数字再发一次是常态，文件名区分不了。
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const shortHash = sha256.slice(0, 12);

    const s = survey(buffer, filename);

    console.log("");
    console.log(`数据库：${dbPath}`);
    console.log(`成绩表：${filename}`);
    console.log(`        sha256 ${shortHash}…`);
    console.log(`周期：  #${term.id} ${term.name}（${term.status}）`);
    console.log("");
    console.log(`  工作表      ${s.sheets} 个`);
    console.log(`  数据行      ${s.rows.length} 行`);

    // ---- 对账：表格声明的上限 vs 数据库里的上限 -------------------------------
    const mismatches: string[] = [];
    const missing: string[] = [];

    for (const { col, itemId, label, fallbackCap } of COLUMNS) {
      let item;
      try {
        item = getItem(db, itemId);
      } catch {
        missing.push(`  ${col} 列 → 计分项 id=${itemId}（${label}）在数据库里不存在`);
        continue;
      }
      const declared = s.caps.get(itemId)?.declared ?? null;
      const expected = declared ?? fallbackCap ?? null;

      if (expected === null) {
        mismatches.push(`  ${col} 列「${label}」：表里没读到上限，数据库是 ${item.cap}`);
      } else if (expected !== item.cap) {
        mismatches.push(
          `  ${col} 列「${label}」：${declared === null ? "代码里期望" : "表里声明"} ` +
            `${expected} 分，数据库里是 ${item.cap} 分`,
        );
      }
    }

    if (missing.length > 0 || mismatches.length > 0) {
      console.error("");
      console.error("❌ 表格和系统的计分项对不上，**没有写入任何东西**。");
      for (const m of missing) console.error(m);
      for (const m of mismatches) console.error(m);
      console.error("");
      console.error("   上限对不上意味着两边对「这项值多少分」的认知已经分叉。");
      console.error("   继续导只会把错的分写进账本，而账本改不了。请先核对。");
      console.error("");
      return 1;
    }

    console.log(`  列映射      25 项，上限与数据库逐一吻合 ✅`);

    // ---- 名册核对 -----------------------------------------------------------
    for (const row of s.rows) {
      const stu = db.prepare("SELECT id, name, grade FROM students WHERE id = ?").get(row.studentId) as
        | { id: string; name: string; grade: number }
        | undefined;
      if (!stu) s.unknownStudents.set(row.studentId, row.name);
    }

    if (s.duplicates.length > 0) {
      console.log("");
      console.log(`  ⚠️ 有 ${s.duplicates.length} 个学号在表里出现多次：`);
      for (const d of s.duplicates.slice(0, 5)) {
        console.log(`     ${d.studentId} —— ${d.where.join("、")}`);
      }
      console.log("     两个不同的分数不可能都对。**这些行整行跳过**，请先在源文件里改掉。");
    }

    if (s.unknownStudents.size > 0) {
      console.log("");
      console.log(`  ⚠️ 有 ${s.unknownStudents.size} 个学号不在名册里（这些行跳过）：`);
      for (const [id, name] of [...s.unknownStudents].slice(0, 5)) console.log(`     ${id} ${name}`);
    }

    // ---- 找切片、算 delta ---------------------------------------------------
    const slices = listSlices(db, term.id);
    const sliceOf = new Map<number, Slice>();
    for (const s2 of slices) sliceOf.set(s2.itemId, s2);

    const dupIds = new Set(s.duplicates.map((d) => d.studentId));

    interface Plan {
      slice: Slice;
      studentId: string;
      itemId: number;
      current: number;
      target: number;
      delta: number;
      reason: string;
    }

    const plans: Plan[] = [];
    const problems: string[] = [];
    const unchanged = { n: 0 };

    for (const row of s.rows) {
      if (dupIds.has(row.studentId)) continue;
      if (s.unknownStudents.has(row.studentId)) continue;

      const stu = db.prepare("SELECT grade FROM students WHERE id = ?").get(row.studentId) as {
        grade: number;
      };

      for (const [itemId, target] of row.values) {
        const slice = slices.find((x) => x.itemId === itemId && x.grade === stu.grade);
        if (!slice) {
          problems.push(`${row.studentId} 计分项 ${itemId}：找不到 ${stu.grade} 级的切片`);
          continue;
        }
        const item = getItem(db, itemId);
        const current = scoreOf(db, term.id, row.studentId, itemId);
        const delta = Math.round((target - current) * 100) / 100;

        if (delta === 0) {
          unchanged.n += 1;
          continue;
        }

        plans.push({
          slice,
          studentId: row.studentId,
          itemId,
          current,
          target,
          delta,
          reason:
            `来源：${filename} sha256:${shortHash}／${row.sheet}／` +
            `${COLUMNS.find((c) => c.itemId === itemId)!.col} 列「${item.name}」（第 ${row.excelRow} 行）`,
        });
      }
    }

    // 切片得有人认领才录得进去 —— 这是设计的一部分，这里不绕开
    const unowned = [
      ...new Set(
        plans.filter((p) => p.slice.ownerId === null).map((p) => `${p.slice.id} ${p.slice.status}`),
      ),
    ];
    const notOpen = [
      ...new Set(plans.filter((p) => p.slice.status !== "OPEN").map((p) => String(p.slice.id))),
    ];

    console.log("");
    console.log(`  目标分已达成（无需写入）  ${unchanged.n} 处`);
    console.log(`  需要写入的调整            ${plans.length} 处`);

    if (notOpen.length > 0) {
      console.error("");
      console.error(`❌ 切片 ${notOpen.join("、")} 不是「录入中」，不能写入。`);
      console.error("   已提交或已冻结的切片只能通过申诉流程改动。");
      return 1;
    }

    if (unowned.length > 0) {
      console.error("");
      console.error(`❌ 切片 ${unowned.join("、")} 还没有分派负责人，任何人都不能录入。`);
      console.error("   切片必须派到具体的人头上 —— 这是有意的，");
      console.error("   「没人认领」不能被静默当成 0 分。");
      console.error("");
      console.error("   到「本部门」页或「责任指派」页把它们派出去，再回来跑这个命令。");
      return 1;
    }

    if (plans.length === 0) {
      console.log("");
      console.log("账本里已经是表里的分数，没有要写入的。");
      console.log("");
      return 0;
    }

    if (dryRun) {
      console.log("");
      console.log("--dry-run：什么都不写。示例前 8 条：");
      for (const p of plans.slice(0, 8)) {
        console.log(
          `  ${p.studentId} 切片${p.slice.id} ${p.current} → ${p.target}（${p.delta > 0 ? "+" : ""}${p.delta}）`,
        );
      }
      console.log("");
      console.log(`去掉 --dry-run 才会真的写入 ${plans.length} 条事件。`);
      console.log("");
      return 0;
    }

    // ---- 写入 ---------------------------------------------------------------
    console.log("");
    console.log("写入中……");

    const failures: string[] = [];
    let written = 0;

    for (const p of plans) {
      try {
        record(db, {
          sliceId: p.slice.id,
          studentId: p.studentId,
          delta: p.delta,
          actorId: p.slice.ownerId!,
          reason: p.reason,
          // **这条分是搬运来的，不是谁的判断** —— 账本要如实标注
          eventType: "IMPORT",
        });
        written += 1;
      } catch (error) {
        failures.push(
          `${p.studentId} 切片${p.slice.id}（${p.current} → ${p.target}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    for (const p of problems) failures.push(p);

    console.log("");
    console.log(`✅ 已写入 ${written} 条事件（类型 IMPORT）`);

    if (failures.length > 0) {
      console.log("");
      console.log(`❌ 有 ${failures.length} 处没写进去：`);
      for (const f of failures.slice(0, 12)) console.log(`   · ${f}`);
      if (failures.length > 12) console.log(`   …还有 ${failures.length - 12} 处`);
    }

    console.log("");
    console.log("   接下来：这些切片仍然要走复核 → 批准 → 冻结，");
    console.log("   公示之后仍然可以申诉。这个命令没有跳过任何一道监督。");
    console.log("");

    return failures.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof ImportError) {
      console.error(`\n❌ ${error.message}`);
      for (const d of error.diagnostics) console.error(`   ${d}`);
      console.error("");
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(main());
}

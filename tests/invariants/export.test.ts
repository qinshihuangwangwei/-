/**
 * M3.3 公示表导出 —— 不变量测试
 *
 * 设计文档 M3.3：**沿用现有 Excel 格式**。
 *
 * 这里最要紧的一条验证是**交叉验证**：用我们自己写的 xlsx 写出器产出的文件，
 * 交给 Python 的 openpyxl（一个完全独立的实现）去读。
 * 自己写自己读能通过，只能说明两边犯了同一个错。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import { createTerm, transition } from "../../src/domain/term.ts";
import { importRoster } from "../../src/domain/roster.ts";
import { importBScore } from "../../src/domain/bscore.ts";
import { createSlice, record, submit, review, approve } from "../../src/domain/slice.ts";
import { publish } from "../../src/domain/publication.ts";
import { listStudents } from "../../src/domain/student.ts";
import { seedAndAssignAll, SPORTS } from "../helpers/term-fixture.ts";
import { exportPublicityWorkbook, HEADER_PATHS } from "../../src/export/publicity.ts";
import { writeZip, crc32 } from "../../src/export/zip.ts";
import { readWorkbook } from "../../src/import/xlsx.ts";
import { listEntries, readEntry } from "../../src/import/zip.ts";

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const T0 = "2026-03-01T09:00:00.000Z";
const TERM = 1;
const ITEM_SPORTS = 20;

interface World {
  db: Db;
  clock: FixedClock;
}

function world(): World {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);

  createTerm(db, { id: TERM, name: "2025-2026 春季学期" });
  importRoster(db, fixture("roster-ok.xlsx"), "roster-ok.xlsx");
  seedAndAssignAll(db, TERM, clock);
  importBScore(db, TERM, fixture("bscore-ok.xlsx"), "bscore-ok.xlsx", {
    actorId: "teacher",
  }, clock);

  const slice = createSlice(db, {
    termId: TERM,
    itemId: ITEM_SPORTS,
    grade: 2025,
    ownerId: "owner-1",
  });

  // 给前两名学生录一点分，让 A 项不是全 0
  // 明确指定学号：listStudents 按 年级/班级/学号 排序，第一个不是 2599000001
  record(db, { sliceId: slice.id, studentId: "2599000001", delta: 6, actorId: "owner-1", reason: "校运动会第一名" });
  record(db, { sliceId: slice.id, studentId: "2599000003", delta: 3, actorId: "owner-1", reason: "校运动会参与" });

  submit(db, slice.id, "owner-1", clock);
  // 复核必须是**另一个人** —— 三级流转的意义就在这里。
  // 这份夹具原来让 owner-1 自己复核自己，是代码允许、设计不允许的那种写法。
  review(db, slice.id, "deputy-1", clock);
  approve(db, slice.id, "head-1", clock);

  transition(db, TERM, "ASSIGNING", clock);
  transition(db, TERM, "ENTERING", clock);
  publish(db, TERM, "chair-1", clock);

  return { db, clock };
}

// ---------------------------------------------------------------------------
// 1. ZIP 写入器
// ---------------------------------------------------------------------------

describe("ZIP 写入器", () => {
  test("写出来的 ZIP 能被自己的读取器读回来", () => {
    const zip = writeZip([
      { name: "a.txt", content: "你好" },
      { name: "dir/b.bin", content: Buffer.from([1, 2, 3, 255]) },
    ]);

    const entries = listEntries(zip);
    assert.deepEqual(entries.map((e) => e.name).sort(), ["a.txt", "dir/b.bin"]);

    const a = entries.find((e) => e.name === "a.txt")!;
    assert.equal(readEntry(zip, a).toString("utf8"), "你好");

    const b = entries.find((e) => e.name === "dir/b.bin")!;
    assert.deepEqual([...readEntry(zip, b)], [1, 2, 3, 255]);
  });

  test("★ 中央目录里的偏移量是相对文件开头的绝对值", () => {
    // 写成相对数据区的偏移，Excel 会说文件损坏，而错误信息指不到原因
    const zip = writeZip([
      { name: "first.txt", content: "x".repeat(500) },
      { name: "second.txt", content: "y" },
    ]);

    const entries = listEntries(zip);
    const second = entries.find((e) => e.name === "second.txt")!;

    assert.ok(
      second.localHeaderOffset > 0,
      "第二个条目的偏移量必须大于 0 —— 说明它是绝对偏移，不是相对数据区",
    );
    assert.equal(readEntry(zip, second).toString("utf8"), "y");
  });

  test("CRC32 与已知值一致", () => {
    // "123456789" 的 CRC32 是标准测试向量 0xCBF43926
    assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
  });

  test("内容不可压缩时退化为 stored，读出来仍然正确", () => {
    const random = Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37 + 11) % 256));
    const zip = writeZip([{ name: "r.bin", content: random }]);
    const entry = listEntries(zip)[0]!;

    assert.ok(readEntry(zip, entry).equals(random));
  });
});

// ---------------------------------------------------------------------------
// 2. xlsx 写入器
// ---------------------------------------------------------------------------

describe("XLSX 写入器", () => {
  test("数字与文本往返一致", () => {
    const buf = writeZipIfNeeded();

    const back = readWorkbook(buf);
    const rows = back[0]!.rows;

    assert.equal(rows[0]?.[0], "学号");
    assert.equal(rows[1]?.[0], "2599000001");
    assert.equal(rows[1]?.[2], 88.5);
  });

  test("中文与特殊字符被正确转义", () => {
    const { writeWorkbook } = require0();
    const buf = writeWorkbook([
      { name: "含:非法*字符?", rows: [["a<b>c&d\"e'f"]] },
    ]);

    const back = readWorkbook(buf);
    assert.equal(back[0]!.rows[0]?.[0], "a<b>c&d\"e'f");
    assert.match(back[0]!.name, /含_非法_字符_/, "Excel 禁止的工作表名字符必须被替换掉");
  });

  test("合并区域被写进文件", () => {
    const { writeWorkbook } = require0();
    const buf = writeWorkbook([
      { name: "s", rows: [["标题"], ["a", "b"]], merges: ["A1:B1"] },
    ]);

    const xml = readEntryByName(buf, "xl/worksheets/sheet1.xml");
    assert.match(xml, /<mergeCell ref="A1:B1"\/>/);
  });

  test("空行也写出来，行号不错位", () => {
    const { writeWorkbook } = require0();
    const buf = writeWorkbook([{ name: "s", rows: [["a"], [], ["c"]] }]);

    const back = readWorkbook(buf);
    assert.equal(back[0]!.rows[2]?.[0], "c", "第三行的内容必须还在第三行");
  });
});

// ---------------------------------------------------------------------------
// 3. 公示表导出
// ---------------------------------------------------------------------------

describe("公示表导出", () => {
  test("导出成功并给出文件名", () => {
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);

    assert.match(result.filename, /综合测评成绩公示-\d{8}-\d{4}\.xlsx$/);
    assert.equal(result.rows, 10);
    assert.ok(result.content.length > 1000, "文件不该是空的");
  });

  test("★ 文件名带周期号与导出时刻 —— 否则旧文件和新文件同名", () => {
    // 真实发生过：使用者对着几周前导出的一份表问"怎么可能每个人都是 1.5 分"。
    // 那份表没有错，它只是过时了 —— 而文件名分毫不差地和刚导出的一样，
    // 所以他没有任何线索。周期号也一样重要：系统里可以有多个同名周期。
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);

    assert.ok(
      result.filename.includes(`周期${TERM}`),
      `文件名里要有周期号（有多个同名周期时，这是唯一的区分）：${result.filename}`,
    );
    assert.match(result.filename, /-\d{8}-\d{4}\.xlsx$/, "文件名结尾要是导出时刻");
  });

  test("★ 表头结构是四行：标题 + 三级表头", () => {
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);
    const rows = readWorkbook(result.content)[0]!.rows;

    // 第 1 行标题
    assert.match(String(rows[0]?.[0] ?? ""), /综合测评成绩公示/);

    // 第 2 行：学号/姓名/班级 + 各大类
    assert.equal(rows[1]?.[0], "学号");
    assert.equal(rows[1]?.[1], "姓名");
    assert.equal(rows[1]?.[2], "班级");
    assert.equal(rows[1]?.[3], "A1（社会公德）（6分）");

    // 第 3 行：子项
    assert.equal(rows[2]?.[3], "志愿服务立项及开展（4分）");

    // 第 4 行：孙项。A2-2「主管部门评定」是第 4 个计分项 → 列 = 3 + 3 = 6
    assert.equal(rows[2]?.[6], "参与学生工作情况（12分）", "三级表头的中项在第三行");
    assert.equal(rows[3]?.[6], "主管部门评定（6分）", "三级表头的子项在第四行");

    // A6 没有下级，整格纵向合并（只出现在第 2 行）
    const a6Column = 3 + 16;
    assert.equal(rows[1]?.[a6Column], "A6（遵纪守法）（6分）");
    // 写入器不给 null 单元格生成 <c>，读取器那一格就是空的（undefined）
    assert.ok(!rows[2]?.[a6Column], "A6 没有下级，第三行应为空");

    // 末列是总分公式说明
    const lastIndex = 3 + 26 + 5;
    assert.equal(rows[1]?.[lastIndex], "S=A*0.3+B*0.7+C");
  });

  test("★ 表头布局覆盖全部 26 个计分项", () => {
    for (let id = 1; id <= 26; id += 1) {
      assert.ok(HEADER_PATHS[id], `计分项 ${id} 没有表头布局`);
    }

    // A6 是单格纵向合并（没有下级）
    assert.equal(HEADER_PATHS[17]?.length, 1);
    // A2-2 是三级
    assert.equal(HEADER_PATHS[4]?.length, 3);
  });

  test("★ 导出的分数与账本重放结果一致", () => {
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);
    const rows = readWorkbook(result.content)[0]!.rows;

    const students = listStudents(w.db);
    const first = students.find((s) => s.id === "2599000001")!;
    const row = rows.find((r) => r[0] === first.id);
    assert.ok(row, "导出表里应当有这名学生");

    // 体育类在第 20 号计分项 → 数据列 = 3 + (20-1) = 22
    assert.equal(row![22], 6, "账本里录了 6 分，导出表里就该是 6 分");

    // A 项合计（第 3+26 = 29 列）
    const aTotal = row![3 + 26] as number;
    assert.ok(typeof aTotal === "number" && aTotal >= 6);
  });

  test("★ 总分 S = A×0.3 + B×0.7 + C", () => {
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);
    const rows = readWorkbook(result.content)[0]!.rows;

    const row = rows.find((r) => r[0] === "2599000001")!;

    const a = row[3 + 26] as number;
    const a03 = row[3 + 26 + 1] as number;
    const b = row[3 + 26 + 2] as number;
    const b07 = row[3 + 26 + 3] as number;
    const c = row[3 + 26 + 4] as number;
    const s = row[3 + 26 + 5] as number;

    assert.equal(a03, Math.round(a * 0.3 * 10000) / 10000);
    assert.equal(b07, Math.round(b * 0.7 * 10000) / 10000);
    assert.equal(s, Math.round((a * 0.3 + b * 0.7 + c) * 10000) / 10000);
  });

  test("可以只导出某个年级", () => {
    const w = world();
    const db2 = openDatabase(":memory:");
    void db2;

    const result = exportPublicityWorkbook(w.db, TERM, w.clock, { grade: 2025 });
    assert.equal(result.rows, 10);
  });

  test("名册为空时明确报错，而不是导出一张空表", () => {
    const db = openDatabase(":memory:");
    const clock = fixedClock(T0);
    createTerm(db, { id: TERM, name: "空周期" });

    assert.throws(
      () => exportPublicityWorkbook(db, TERM, clock),
      /名册里还没有学生/,
    );
  });

  test("★ 尾部带上上下文：离开系统之后文件能自己说明自己", () => {
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);
    const rows = readWorkbook(result.content)[0]!.rows;

    const flat = rows.map((r) => String(r[0] ?? "")).join("\n");
    assert.match(flat, /只能追加、不能修改的账本/);
    assert.match(flat, /计分项共 26 项/);
    assert.match(flat, /切片完成情况/);
  });

  test("★ 未提交的计分项会被记录成警告", () => {
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);

    assert.ok(result.warnings.length > 0, "有计分项没做完时必须留下警告");
    assert.ok(
      result.warnings.some((x) => /没有分派负责人|没有建立切片|没人做/.test(x)),
      `警告内容应当说清是哪一类问题，实际：${result.warnings.join(" / ")}`,
    );
  });

  test("★ 「没有切片」与「没有分派负责人」是两类不同的问题，警告要分开说", () => {
    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);

    // world() 走的是 transition(...ENTERING)，状态机会自动建立全部切片，
    // 因此这里应当是「有切片但没分派负责人」，而不是「没建切片」。
    assert.ok(
      result.warnings.some((x) => /没有分派负责人/.test(x)),
      `实际警告：${result.warnings.join(" / ")}`,
    );
    assert.ok(
      !result.warnings.some((x) => /没有建立切片/.test(x)),
      "切片已由状态机自动建立，不该报「没建切片」",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 交叉验证：交给 Python 的独立实现去读
// ---------------------------------------------------------------------------

describe("★ 交叉验证", () => {
  test("导出文件能被 openpyxl 独立读出（不是自己读自己）", async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync, rmSync } = await import("node:fs");

    const w = world();
    const result = exportPublicityWorkbook(w.db, TERM, w.clock);

    const path = join(process.cwd(), "data", "_export-check.xlsx");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    writeFileSync(path, result.content);

    try {
      const out = execFileSync(
        "python",
        [
          "-X",
          "utf8",
          "-c",
          `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb.worksheets[0]
print(json.dumps({
  "sheets": wb.sheetnames,
  "dims": ws.dimensions,
  "a1": ws["A1"].value,
  "b2": ws["B2"].value,
  "d2": ws["D2"].value,
  "d3": ws["D3"].value,
  "merged": len(ws.merged_cells.ranges),
  "rows": ws.max_row,
}))
`,
          path,
        ],
        { encoding: "utf8" },
      );

      const info = JSON.parse(out.trim()) as {
        sheets: string[];
        a1: string;
        b2: string;
        d2: string;
        d3: string;
        merged: number;
        rows: number;
      };

      assert.deepEqual(info.sheets, ["2025-2026 春季学期"]);
      assert.match(info.a1, /综合测评成绩公示/);
      assert.equal(info.b2, "姓名");
      assert.equal(info.d2, "A1（社会公德）（6分）");
      assert.equal(info.d3, "志愿服务立项及开展（4分）");
      assert.ok(info.merged > 20, `合并区域只有 ${info.merged} 个，表头结构可能没写对`);
      // 标题 + 三行表头 + 10 学生 + 尾部
      // 尾部 = 空行 + 3 行上下文 + 每一条警告各一行。
      // **警告要写进文件本体** —— 使用者手上只有这个 .xlsx，服务端日志他看不到；
      // 文件还会被转发，那些"这些列其实是 0 分而不是没人加分"的话得跟着它走。
      const footer = 4 + result.warnings.length;
      assert.equal(
        info.rows,
        1 + 3 + 10 + footer,
        `标题 + 三行表头 + 10 学生 + 尾部 ${footer} 行（含 ${result.warnings.length} 条警告）`,
      );
      assert.ok(result.warnings.length > 0, "这份夹具本来就有没做完的计分项，应当产生警告");
    } finally {
      rmSync(path, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function require0(): {
  writeWorkbook: (
    sheets: Array<{ name: string; rows: Array<Array<string | number | null>>; merges?: string[] }>,
  ) => Buffer;
} {
  return xlsxModule as never;
}

function writeZipIfNeeded(): Buffer {
  return xlsxModule.writeWorkbook([
    { name: "s", rows: [["学号", "姓名", "B分"], ["2599000001", "赵雨桐", 88.5]] },
  ]);
}

function readEntryByName(zip: Buffer, name: string): string {
  const entry = listEntries(zip).find((e) => e.name === name);
  assert.ok(entry, `ZIP 里没有 ${name}`);
  return readEntry(zip, entry!).toString("utf8");
}

import * as xlsxModule from "../../src/export/xlsx.ts";

/**
 * M3.1 表格读取与列识别 —— 不变量测试
 *
 * 对应设计文档附录 C。
 *
 * 夹具是**真的 xlsx 文件**（由 `tests/fixtures/make-fixtures.py` 生成，
 * 刻意包含多工作表、合并表头、空单元格、身份证号列这些真实情形）。
 * 用假数据测导入，等于没测。
 *
 * 这里要钉死的核心是附录 C.1 的那个决定：**不接 AI，把宽容体现在诊断上。**
 * 因此最后几条测试专门检查"失败时说清楚了没有" ——
 * 一个只会说"格式错误"的导入功能，等于把排查工作全推给管理员。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listEntries, readEntryByName } from "../../src/import/zip.ts";
import {
  readWorkbook,
  columnIndexOf,
  columnNameOf,
  decodeXmlEntities,
} from "../../src/import/xlsx.ts";
import { parseCsv, detectDelimiter } from "../../src/import/csv.ts";
import {
  readTable,
  findStudentIdColumn,
  findScoreColumn,
  findNameColumn,
  findClassColumn,
  guessHeaderRow,
  cellText,
  explainDetection,
  ImportError,
} from "../../src/import/table.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const FIXTURES = join(process.cwd(), "tests", "fixtures");

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

const ROSTER = new Map([
  ["2599000001", "赵雨桐"],
  ["2599000002", "李海燕"],
  ["2599000003", "周雅静"],
  ["2599000004", "黄秀英"],
  ["2599000005", "孙志强"],
  ["2599000017", "徐俊宇"],
  ["2599000018", "何一鸣"],
  ["2599000020", "高子涵"],
  ["2599000021", "林浩然"],
  ["2599000024", "阿迪拉·艾山"],
]);

const ROSTER_IDS = new Set(ROSTER.keys());
const ROSTER_NAMES = new Set(ROSTER.values());

// ---------------------------------------------------------------------------
// 1. ZIP
// ---------------------------------------------------------------------------

describe("ZIP 读取", () => {
  test("能列出 xlsx 内部的条目", () => {
    const entries = listEntries(fixture("roster-ok.xlsx"));
    const names = entries.map((e) => e.name);

    assert.ok(names.includes("[Content_Types].xml"));
    assert.ok(names.includes("xl/workbook.xml"));
    assert.ok(names.some((n) => n.startsWith("xl/worksheets/")));
  });

  test("能读出并解压条目内容", () => {
    const xml = readEntryByName(fixture("roster-ok.xlsx"), "xl/workbook.xml");
    assert.ok(xml, "应当能读到 workbook.xml");
    assert.match(xml!.toString("utf8"), /<workbook/);
  });

  test("不存在的条目返回 null，而不是抛错", () => {
    assert.equal(readEntryByName(fixture("roster-ok.xlsx"), "xl/nope.xml"), null);
  });

  test("不是 ZIP 的文件会被明确拒绝", () => {
    assert.throws(
      () => listEntries(Buffer.from("这不是一个 zip 文件")),
      /找不到中央目录结尾标记|不是有效的 ZIP/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. XLSX
// ---------------------------------------------------------------------------

describe("XLSX 读取", () => {
  test("读出工作表名与内容", () => {
    const sheets = readWorkbook(fixture("roster-ok.xlsx"));
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0]?.name, "学生名册");

    const rows = sheets[0]!.rows;
    assert.equal(cellText(rows[0]?.[0] ?? null), "学号");
    assert.equal(cellText(rows[1]?.[0] ?? null), "2599000001");
    assert.equal(cellText(rows[1]?.[1] ?? null), "赵雨桐");
  });

  test("★ 空单元格被整格省略时，后面的列不错位", () => {
    // bscore-realistic 的第 E 列刻意隔几行留空。
    // 若按"出现顺序"数列号，后面所有列都会错位 ——
    // 后果是"B 分列读成了 S 列"，而且极难发现。
    const sheets = readWorkbook(fixture("bscore-realistic.xlsx"));
    const rows = sheets[0]!.rows;

    const headerRow = 1; // 第二行是合并表头的上半部分
    assert.equal(cellText(rows[headerRow]?.[0] ?? null), "学号");
    assert.equal(cellText(rows[headerRow]?.[6] ?? null), "B（100分）");
    assert.equal(cellText(rows[headerRow]?.[7] ?? null), "S");

    // 第 4 行（i=0）E 列是空的，但 B 分仍应在第 G 列
    const firstData = rows[3]!;
    assert.equal(cellText(firstData[0] ?? null), "2599000001");
    assert.equal(firstData[4] ?? null, null, "E 列应当为空");
    assert.ok(typeof firstData[6] === "number", "G 列（B 分）必须是数字");
  });

  test("学号保持字符串，不被转成数字", () => {
    const sheets = readWorkbook(fixture("roster-ok.xlsx"));
    const value = sheets[0]!.rows[1]?.[0];

    assert.equal(typeof value, "string", "学号转成数字后前导零会丢，且再也对不上名册");
    assert.equal(value, "2599000001");
  });

  test("多工作表都能读出来", () => {
    const sheets = readWorkbook(fixture("bscore-multi-sheet.xlsx"));
    assert.deepEqual(sheets.map((s) => s.name), ["说明", "成绩明细"]);
  });

  test("列引用换算", () => {
    assert.equal(columnIndexOf("A1"), 0);
    assert.equal(columnIndexOf("B1"), 1);
    assert.equal(columnIndexOf("Z1"), 25);
    assert.equal(columnIndexOf("AA1"), 26);
    assert.equal(columnIndexOf("AB1"), 27);
    assert.equal(columnNameOf(0), "A");
    assert.equal(columnNameOf(26), "AA");
  });

  test("XML 实体解码", () => {
    assert.equal(decodeXmlEntities("a&amp;b"), "a&b");
    assert.equal(decodeXmlEntities("&lt;tag&gt;"), "<tag>");
    assert.equal(decodeXmlEntities("&#65;&#x42;"), "AB");
  });

  test("旧版 .xls 被明确拒绝并给出可执行的建议", () => {
    assert.throws(
      () => readTable(Buffer.from("x"), "成绩.xls"),
      (e) => e instanceof ImportError && e.code === "UNSUPPORTED_FORMAT" &&
        /另存为/.test((e as Error).message),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. CSV
// ---------------------------------------------------------------------------

describe("CSV 读取", () => {
  test("能读带 BOM 的 CSV（Excel 另存为时会加）", () => {
    const table = readTable(fixture("roster-bom.csv"), "roster-bom.csv");
    const rows = table.sheets[0]!.rows;

    assert.equal(
      cellText(rows[0]?.[0] ?? null),
      "学号",
      "BOM 没去掉的话表头会变成 \\ufeff学号，任何按名字找列的逻辑都会失败",
    );
  });

  test("引号内的换行不会被当成换行", () => {
    const rows = parseCsv('a,"第一行\n第二行",c\n1,2,3');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.[1], "第一行\n第二行");
  });

  test("转义的引号（两个双引号）还原成一个", () => {
    const rows = parseCsv('a,"他说""你好""",c');
    assert.equal(rows[0]?.[1], '他说"你好"');
  });

  test("分隔符自动判断：逗号、制表符、分号", () => {
    assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
    assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
    assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  });

  test("前导零的数字串保留为字符串", () => {
    const rows = parseCsv("学号,分数\n0123456,88");
    assert.equal(rows[1]?.[0], "0123456", "前导零丢掉就再也对不上名册了");
    assert.equal(rows[1]?.[1], 88);
  });

  test("全空的行被丢掉", () => {
    const rows = parseCsv("a,b\n,,\n1,2");
    assert.equal(rows.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 4. 表头与列识别
// ---------------------------------------------------------------------------

describe("表头识别", () => {
  test("干净的表头在第一行", () => {
    const rows = parseCsv("学号,姓名\n1,甲");
    assert.equal(guessHeaderRow(rows), 0);
  });

  test("★ 前面有标题行时能找到真正的表头", () => {
    const sheets = readWorkbook(fixture("roster-with-title.xlsx"));
    const headerRow = guessHeaderRow(sheets[0]!.rows);

    assert.equal(cellText(sheets[0]!.rows[headerRow]?.[1] ?? null), "学号");
  });
});

describe("列识别", () => {
  test("干净的名册：三列都认得出来", () => {
    const table = readTable(fixture("roster-ok.xlsx"), "roster-ok.xlsx");

    assert.equal(findStudentIdColumn(table, ROSTER_IDS).best?.columnName, "A");
    assert.equal(findNameColumn(table, ROSTER_NAMES).best?.columnName, "B");
    assert.equal(findClassColumn(table).best?.columnName, "C");
  });

  test("★ 学号存成数字也能认出来（靠名册命中率，不靠格式）", () => {
    const table = readTable(fixture("roster-with-title.xlsx"), "roster-with-title.xlsx");
    const found = findStudentIdColumn(table, ROSTER_IDS);

    // 这一列的学号已经被 Excel 转成数字了，格式判据会失分，
    // 但名册命中率是 100%，因此仍然认得出来
    assert.ok(found.best, "应当认出学号列");
    assert.equal(found.best!.columnName, "B");
    assert.equal(found.best!.referenceHitRate, 1);
  });

  test("★ 命中率是最强判据：身份证号列被排除，真正的学号列被选中", () => {
    const table = readTable(fixture("bscore-idcard.xlsx"), "bscore-idcard.xlsx");
    const found = findStudentIdColumn(table, ROSTER_IDS);

    assert.equal(found.best?.columnName, "B", "应当选中真正的学号列");
    assert.equal(found.best?.referenceHitRate, 1);

    const aColumn = found.rejected.find((r) => r.columnName === "A");
    assert.ok(aColumn, "身份证号列应当被记录在排除理由里");
    assert.match(aColumn!.reason, /命中率/);
  });

  test("成绩列认得出（表头含关键词）", () => {
    const table = readTable(fixture("bscore-ok.xlsx"), "bscore-ok.xlsx");
    const found = findScoreColumn(table, { max: 150 });

    assert.equal(found.best?.columnName, "B");
  });

  test("★ 成绩在第二张工作表里也找得到", () => {
    const table = readTable(fixture("bscore-multi-sheet.xlsx"), "bscore-multi-sheet.xlsx");
    assert.equal(table.sheets.length, 2);

    const found = findScoreColumn(table, { max: 150 });
    assert.equal(found.best?.sheetName, "成绩明细");
    assert.equal(found.best?.header, "学业成绩");
  });

  test("★ 仿真实综测表：在合并表头里找到 B 列", () => {
    const table = readTable(fixture("bscore-realistic.xlsx"), "bscore-realistic.xlsx");
    const found = findScoreColumn(table, {
      max: 150,
      keywords: ["B", "学业", "成绩"],
    });

    assert.ok(found.best, "应当在多列数字里认出 B 分列");
    assert.equal(
      found.best!.columnName,
      "G",
      `B（100分）在第 G 列，实际选中 ${found.best!.columnName}`,
    );
    assert.equal(found.best!.header, "B（100分）");
  });

  test("多个候选时全部列出，不自动决定", () => {
    const table = readTable(fixture("bscore-realistic.xlsx"), "bscore-realistic.xlsx");
    const found = findScoreColumn(table, { max: 150 });

    assert.ok(
      found.candidates.length > 1,
      "仿真实表里有多个数字列（A、B、S），应当都列为候选让人确认",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 诊断信息（附录 C.4 的核心要求）
// ---------------------------------------------------------------------------

describe("★ 失败时要说清楚为什么", () => {
  test("学号完全对不上时，报出命中率而不是「格式错误」", () => {
    const table = readTable(fixture("bscore-no-match.xlsx"), "bscore-no-match.xlsx");
    const found = findStudentIdColumn(table, ROSTER_IDS);

    assert.equal(found.best, null, "全都对不上，不该硬认一个");

    const lines = explainDetection("学号列", found, table).join("\n");

    assert.match(lines, /未找到学号列/);
    assert.match(lines, /命中率/, "必须给出命中率数字");
    assert.match(lines, /名册（10 人）/, "必须说明名册有多少人，便于对照");
    assert.ok(!/^格式错误$/.test(lines), "禁止无信息报错");
  });

  test("多个疑似列各自给出被排除的原因", () => {
    const table = readTable(fixture("bscore-idcard.xlsx"), "bscore-idcard.xlsx");
    const found = findStudentIdColumn(table, ROSTER_IDS);

    const lines = explainDetection("学号列", found, table).join("\n");
    assert.match(lines, /已识别学号列/);
  });

  test("文件里连一张表都没有时，给出可执行的排查方向", () => {
    const table = readTable(fixture("roster-bom.csv"), "roster-bom.csv");
    const empty = findStudentIdColumn(
      { sheets: [{ name: "空表", rows: [] }], source: "空表" },
      ROSTER_IDS,
    );

    const lines = explainDetection("学号列", empty, table).join("\n");
    assert.match(lines, /未找到学号列/);
    assert.match(lines, /合并单元格|导错了文件/);
  });

  test("识别成功时也说明识别到了哪一列，便于人工复核", () => {
    const table = readTable(fixture("bscore-ok.xlsx"), "bscore-ok.xlsx");
    const found = findStudentIdColumn(table, ROSTER_IDS);

    const lines = explainDetection("学号列", found, table).join("\n");
    assert.match(lines, /工作表「成绩」/);
    assert.match(lines, /第 A 列/);
    assert.match(lines, /共 10 个值/);
  });
});

// ---------------------------------------------------------------------------
// 6. 单元格取值
// ---------------------------------------------------------------------------

describe("单元格取值", () => {
  test("数字与文本都能转成字符串", () => {
    assert.equal(cellText(88.5), "88.5");
    assert.equal(cellText(88), "88");
    assert.equal(cellText("  x  "), "x");
    assert.equal(cellText(null), "");
  });
});

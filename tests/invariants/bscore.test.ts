/**
 * M3.2 B 项成绩导入 —— 不变量测试
 *
 * 设计文档附录 C / D。B 项是**导入的事实数据**，不进账本（附录 C.7）：
 * 账本记录"人的判断"，导入记录"数据的搬运"。
 *
 * 因此这里守的不是"防人改分"，而是另外三条：
 *
 *   1. **可复现** —— 同一份文件导入两次，结果完全相同。
 *   2. **可追溯** —— 每次导入留下原始文件（含 sha256）与识别出的列映射。
 *   3. **可发现** —— 变动比例异常时要求二次确认。
 *      这是列映射错位最有效的兜底：差异会夸张到一眼看出来。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import { createTerm, transition } from "../../src/domain/term.ts";
import { importRoster } from "../../src/domain/roster.ts";
import { listStudents } from "../../src/domain/student.ts";
import { scoreBreakdown } from "../../src/domain/publication.ts";
import {
  previewBScore,
  importBScore,
  listImportJobs,
  bScoreOf,
  bScoreCount,
  CHANGE_RATIO_ALERT,
} from "../../src/domain/bscore.ts";
import { ImportError } from "../../src/import/table.ts";
import { sha256Of } from "../../src/import/archive.ts";

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const T0 = "2026-03-01T09:00:00.000Z";
const TERM = 1;
const DATA_DIR = "./data/test-bscore";

interface World {
  db: Db;
  clock: FixedClock;
}

function world(): World {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);
  createTerm(db, { id: TERM, name: "2025-2026 春季学期" });
  importRoster(db, fixture("roster-ok.xlsx"), "roster-ok.xlsx");
  return { db, clock };
}

function csv(rows: Array<[string, string]>): Buffer {
  return Buffer.from(
    "\ufeff" + ["学号,B分", ...rows.map((r) => r.join(","))].join("\n"),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// 1. 预览
// ---------------------------------------------------------------------------

describe("预览", () => {
  test("★ 预览不写库", () => {
    const w = world();
    const preview = previewBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "bscore-ok.xlsx");

    assert.equal(preview.stats.total, 10);
    assert.equal(bScoreCount(w.db, TERM), 0, "预览阶段不能写库");
  });

  test("识别出学号列与成绩列", () => {
    const w = world();
    const preview = previewBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "bscore-ok.xlsx");

    assert.equal(preview.columns.studentId?.columnName, "A");
    assert.equal(preview.columns.score?.columnName, "B");
    assert.equal(preview.columns.studentId?.referenceHitRate, 1, "学号全部命中名册");
  });

  test("★ 仿真实综测表：在合并表头里找到 B 列", () => {
    const w = world();
    const preview = previewBScore(
      w.db,
      TERM,
      fixture("bscore-realistic.xlsx"),
      "bscore-realistic.xlsx",
    );

    assert.ok(preview.columns.score, "应当认出成绩列");
    assert.equal(
      preview.columns.score!.header,
      "B（100分）",
      `实际选中 ${preview.columns.score!.columnName} 列（${preview.columns.score!.header}）`,
    );

    // 多列数字都像成绩时，必须提示人工核对
    assert.ok(
      preview.diagnostics.some((l) => /都像成绩|核对/.test(l)),
      "多个候选列时必须提示人工确认",
    );
  });

  test("★ 成绩在第二张工作表里也找得到", () => {
    const w = world();
    const preview = previewBScore(
      w.db,
      TERM,
      fixture("bscore-multi-sheet.xlsx"),
      "bscore-multi-sheet.xlsx",
    );

    assert.equal(preview.sheetName, "成绩明细");
    assert.equal(preview.stats.total, 10);
  });

  test("★ 学号列是身份证号时被排除，并给出命中率诊断", () => {
    const w = world();
    const preview = previewBScore(
      w.db,
      TERM,
      fixture("bscore-idcard.xlsx"),
      "bscore-idcard.xlsx",
    );

    assert.equal(preview.columns.studentId?.columnName, "B", "应选中真正的学号列");
    assert.equal(preview.columns.score?.header, "综合成绩");
  });

  test("名册为空时直接说明要先导名册", () => {
    const db = openDatabase(":memory:");
    const clock = fixedClock(T0);
    createTerm(db, { id: TERM, name: "空" });

    const preview = previewBScore(db, TERM, fixture("bscore-ok.xlsx"), "bscore-ok.xlsx");
    assert.ok(
      preview.diagnostics.some((l) => /还没有学生名册/.test(l)),
      "B 项必须与名册对应，缺名册时要明确说",
    );
    assert.equal(preview.canCommit, false);
  });

  test("不在名册中的学号被标为 UNKNOWN", () => {
    const w = world();
    // 用名册里的全部学生 + 1 个陌生学号。
    // 为什么不能只用两行：名册命中率低于 80% 时整列会被判为"不是学号列"，
    // 这是设计使然（命中率太低说明多半导错了文件），
    // 而"个别学号对不上"要靠足够的正常行数才显得出来。
    const buffer = csv([
      ...listStudents(w.db).map((s) => [s.id, "88"] as [string, string]),
      ["9999999999", "77"],
    ]);

    const preview = previewBScore(w.db, TERM, buffer, "mix.csv");
    assert.equal(preview.stats.unknownStudents, 1);
    assert.ok(preview.diagnostics.some((l) => /不在名册中|不在名册里/.test(l)));
  });

  test("非数字成绩（缺考、缓考）被跳过并说明", () => {
    const w = world();
    const students = listStudents(w.db);

    const buffer = csv([
      [students[0]!.id, "缺考"],
      ...students.slice(1).map((s) => [s.id, "88"] as [string, string]),
    ]);

    const preview = previewBScore(w.db, TERM, buffer, "mixed.csv");
    assert.equal(preview.stats.skipped, 1);
    assert.ok(preview.diagnostics.some((l) => /不是数字/.test(l)));
  });

  test("★ 整列都不是数字时，判定为「没有成绩列」而不是逐行跳过", () => {
    const w = world();
    const buffer = csv([
      ...listStudents(w.db).map((s) => [s.id, "缺考"] as [string, string]),
    ]);

    const preview = previewBScore(w.db, TERM, buffer, "allsick.csv");
    assert.equal(preview.columns.score, null, "整列非数字说明这根本不是成绩列");
    assert.equal(preview.canCommit, false);
  });

  test("全角数字与百分号也能解析", () => {
    const w = world();
    const buffer = csv([
      ["2599000001", "８８"],
      ["2599000002", "77%"],
    ]);

    const preview = previewBScore(w.db, TERM, buffer, "fullwidth.csv");
    const scores = preview.rows.filter((r) => r.score !== null).map((r) => r.score);
    assert.deepEqual(scores.sort((a, b) => a! - b!), [77, 88]);
  });
});

// ---------------------------------------------------------------------------
// 2. 导入
// ---------------------------------------------------------------------------

describe("导入", () => {
  test("导入后 B 项就位", () => {
    const w = world();
    const result = importBScore(
      w.db,
      TERM,
      fixture("bscore-ok.xlsx"),
      "bscore-ok.xlsx",
      { actorId: "teacher", dataDir: DATA_DIR },
      w.clock,
    );

    assert.equal(result.inserted, 10);
    assert.equal(bScoreCount(w.db, TERM), 10);
    assert.equal(bScoreOf(w.db, TERM, "2599000001"), 60);
  });

  test("★ 幂等：同一份文件导入两次结果相同", () => {
    const w = world();

    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    const second = importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 10);
    assert.equal(bScoreCount(w.db, TERM), 10, "不能出现重复记录");
  });

  test("★ 无变化时连 updated_at 都不动 —— 重复导入是真正的空操作", () => {
    const w = world();
    const opts = { actorId: "teacher", dataDir: DATA_DIR };

    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", opts, w.clock);
    const before = w.db
      .prepare("SELECT updated_at FROM b_scores WHERE student_id = '2599000001'")
      .get() as { updated_at: string };

    w.clock.advance(60_000);
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", opts, w.clock);

    const after = w.db
      .prepare("SELECT updated_at FROM b_scores WHERE student_id = '2599000001'")
      .get() as { updated_at: string };

    assert.equal(after.updated_at, before.updated_at);
  });

  test("成绩变了会被更新", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    const changed = csv([
      ["2599000001", "95"],
      ...listStudents(w.db)
        .slice(1)
        .map((s) => [s.id, String(bScoreOf(w.db, TERM, s.id) ?? 0)] as [string, string]),
    ]);

    const result = importBScore(w.db, TERM, changed, "changed.csv", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    assert.equal(result.updated, 1);
    assert.equal(bScoreOf(w.db, TERM, "2599000001"), 95);
  });

  test("★ 没导入过 → null；导入 0 分 → 0。两者不是一回事", () => {
    const w = world();

    assert.equal(bScoreOf(w.db, TERM, "2599000001"), null, "没导入过应当是 null");

    const buffer = csv([["2599000001", "0"]]);
    importBScore(w.db, TERM, buffer, "zero.csv", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    assert.equal(bScoreOf(w.db, TERM, "2599000001"), 0, "0 分是有效成绩");
  });

  test("★ 列识别失败时中止，且不留下半截数据", () => {
    const w = world();

    assert.throws(
      () =>
        importBScore(
          w.db,
          TERM,
          Buffer.from("完全不是表格的内容", "utf8"),
          "junk.csv",
          { actorId: "teacher", dataDir: DATA_DIR },
          w.clock,
        ),
      (e) => e instanceof ImportError,
    );

    assert.equal(bScoreCount(w.db, TERM), 0, "失败的导入必须整体回滚");
  });
});

// ---------------------------------------------------------------------------
// 3. 变动比例告警（附录 C.5）
// ---------------------------------------------------------------------------

describe("★ 变动比例超阈值要求二次确认", () => {
  test("小幅变动不触发确认", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    // 只改一个人 → 10% 变动
    const buffer = csv([
      ["2599000001", "95"],
      ...listStudents(w.db)
        .slice(1)
        .map((s) => [s.id, String(bScoreOf(w.db, TERM, s.id) ?? 0)] as [string, string]),
    ]);

    const preview = previewBScore(w.db, TERM, buffer, "small.csv");
    assert.ok(preview.stats.changeRatio <= CHANGE_RATIO_ALERT);
    assert.equal(preview.requiresConfirmation, false);
  });

  test("★ 大范围变动触发确认，未确认则拒绝导入", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    // 把所有人的分数都改掉 → 100% 变动
    const allChanged = csv(
      listStudents(w.db).map((s, i) => [s.id, String(50 + i)] as [string, string]),
    );

    const preview = previewBScore(w.db, TERM, allChanged, "big.csv");
    assert.ok(preview.stats.changeRatio > CHANGE_RATIO_ALERT);
    assert.equal(preview.requiresConfirmation, true);
    assert.ok(
      preview.diagnostics.some((l) => /列选错了/.test(l)),
      "必须点明最可能的原因：列选错了",
    );

    assert.throws(
      () =>
        importBScore(w.db, TERM, allChanged, "big.csv", {
          actorId: "teacher",
          dataDir: DATA_DIR,
        }, w.clock),
      (e) => e instanceof ImportError && e.code === "NEEDS_CONFIRMATION",
    );

    assert.equal(bScoreOf(w.db, TERM, "2599000001"), 60, "未确认时分数不变");
  });

  test("确认后可以提交", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    const allChanged = csv(
      listStudents(w.db).map((s, i) => [s.id, String(50 + i)] as [string, string]),
    );

    const result = importBScore(w.db, TERM, allChanged, "big.csv", {
      actorId: "teacher",
      dataDir: DATA_DIR,
      confirmed: true,
    }, w.clock);

    assert.equal(result.updated, 10);
    assert.equal(
      bScoreOf(w.db, TERM, "2599000001"),
      50 + listStudents(w.db).findIndex((s) => s.id === "2599000001"),
      "listStudents 按 年级/班级/学号 排序，期望值要按同一顺序算",
    );
  });

  test("首次导入（全是新增）不触发确认", () => {
    const w = world();
    const preview = previewBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx");

    assert.equal(
      preview.requiresConfirmation,
      false,
      "第一次导入没有「变动」可言，不该拦",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 审计与归档（附录 C.6）
// ---------------------------------------------------------------------------

describe("★ 每次导入都可追溯", () => {
  test("留下一条不可改的审计记录", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "bscore-ok.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    const jobs = listImportJobs(w.db, { kind: "BSCORE" });
    assert.equal(jobs.length, 1);

    const job = jobs[0]!;
    assert.equal(job.filename, "bscore-ok.xlsx");
    assert.equal(job.inserted, 10);
    assert.equal(job.actorId, "teacher");
    assert.equal(job.mapping["studentId"], "A");
    assert.equal(job.mapping["score"], "B");
    assert.match(job.fileSha256, /^[0-9a-f]{64}$/);
  });

  test("★ 审计记录不可改写、不可删除", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    assert.throws(
      () => w.db.exec("UPDATE import_jobs SET inserted = 999"),
      /AUDIT_IMMUTABLE/,
    );
    assert.throws(() => w.db.exec("DELETE FROM import_jobs"), /AUDIT_IMMUTABLE/);
  });

  test("★ 原始文件被归档，且 sha256 与审计记录一致", () => {
    const w = world();
    rmSync(DATA_DIR, { recursive: true, force: true });

    const content = fixture("bscore-ok.xlsx");
    const result = importBScore(w.db, TERM, content, "bscore-ok.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    assert.ok(result.archivedPath, "应当归档原始文件");
    assert.ok(existsSync(result.archivedPath!), "归档文件应当真的存在");

    const archived = readFileSync(result.archivedPath!);
    assert.ok(archived.equals(content), "归档内容必须与上传的原件逐字节一致");

    assert.equal(sha256Of(archived), result.sha256);
    assert.equal(
      listImportJobs(w.db, { kind: "BSCORE" })[0]?.fileSha256,
      result.sha256,
      "日后可以拿归档文件核对「当时导的确实是这一份」",
    );

    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test("同一份文件重复上传只归档一次", () => {
    const w = world();
    rmSync(DATA_DIR, { recursive: true, force: true });

    const opts = { actorId: "teacher", dataDir: DATA_DIR };
    const first = importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", opts, w.clock);
    const second = importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "b.xlsx", opts, w.clock);

    assert.equal(first.archivedPath, second.archivedPath, "内容相同 → 同一个归档");
    assert.equal(first.sha256, second.sha256);

    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test("文件名里的路径分隔符不会写到目录外面去", () => {
    const w = world();
    rmSync(DATA_DIR, { recursive: true, force: true });

    const result = importBScore(
      w.db,
      TERM,
      fixture("bscore-ok.xlsx"),
      "../../../etc/passwd.xlsx",
      { actorId: "teacher", dataDir: DATA_DIR },
      w.clock,
    );

    // 路径分隔符在 Windows 上是反斜杠，比较前先归一化
    const normalized = result.archivedPath!.replace(/\\/g, "/");
    assert.ok(
      normalized.startsWith("data/test-bscore/imports/"),
      `归档路径跑出数据目录了：${result.archivedPath}`,
    );
    assert.ok(
      !normalized.includes("etc/passwd"),
      `文件名里的 ../ 竟然穿透了目录：${result.archivedPath}`,
    );

    rmSync(DATA_DIR, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 5. B 项不进账本（附录 C.7）
// ---------------------------------------------------------------------------

describe("★ B 项不进入 A/C 账本", () => {
  test("导入 B 项不产生任何账本事件", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    const events = (
      w.db.prepare("SELECT COUNT(*) AS n FROM score_events").get() as { n: number }
    ).n;

    assert.equal(
      events,
      0,
      "账本记录「人的判断」，导入记录「数据的搬运」—— B 项不该混进账本",
    );
  });

  test("合成总分时 B 项参与计算", () => {
    const w = world();
    importBScore(w.db, TERM, fixture("bscore-ok.xlsx"), "a.xlsx", {
      actorId: "teacher",
      dataDir: DATA_DIR,
    }, w.clock);

    const b = bScoreOf(w.db, TERM, "2599000001");
    assert.equal(b, 60);

    // A 项还没录，所以 A=0、C=0
    const breakdown = scoreBreakdown(w.db, TERM, { kind: "staff" }, "2599000001", w.clock);
    assert.equal(breakdown.totalWithB(b!), 0 * 0.3 + 60 * 0.7 + 0);
  });
});

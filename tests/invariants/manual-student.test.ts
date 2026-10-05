/**
 * 手工添加 / 修改学生 —— 不变量测试
 *
 * 导入做得再稳也会有漏读，所以需要一条人工兜底的路。
 * 但这条路的性质与导入不同：**它绕过了一切格式识别，直接由人指定**。
 *
 * 因此这里守两件事：
 *
 *   1. **它能用** —— 漏读的学生能补进来，学号与姓名是硬要求
 *      （注册要用「学号 + 姓名」两要素校验，缺姓名的人永远登不进来）。
 *   2. **它留痕** —— 名册是所有分数的归属基础，悄悄塞一个人进来，
 *      影响的不是一条记录，而是这个人在所有计分项上的归属。
 *      因此每次改动都写 roster_changes，且不可改删。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import {
  saveStudentManually,
  listRosterAudit,
  searchStudents,
} from "../../src/domain/roster.ts";
import { listStudents, getStudent } from "../../src/domain/student.ts";
import { registerStudent, login } from "../../src/auth/account.ts";
import { ImportError } from "../../src/import/table.ts";

const T0 = "2026-03-01T09:00:00.000Z";
const ADMIN = "teacher";

function world(): { db: Db; clock: FixedClock } {
  return { db: openDatabase(":memory:"), clock: fixedClock(T0) };
}

function add(
  w: { db: Db; clock: FixedClock },
  input: { studentId: string; name: string; className?: string; actorId?: string },
) {
  return saveStudentManually(w.db, {
    studentId: input.studentId,
    name: input.name,
    className: input.className ?? "计算机2501",
    actorId: input.actorId ?? ADMIN,
    clock: w.clock,
  });
}

// ---------------------------------------------------------------------------
// 1. 添加
// ---------------------------------------------------------------------------

describe("手工添加学生", () => {
  test("能加进来，年级由学号推出", () => {
    const w = world();
    const result = add(w, { studentId: "2599000001", name: "赵雨桐" });

    assert.equal(result.action, "ADD");
    assert.equal(result.previous, null);
    assert.equal(result.student.grade, 2025);

    const stored = getStudent(w.db, "2599000001");
    assert.equal(stored.name, "赵雨桐");
    assert.equal(stored.className, "计算机2501");
  });

  test("★ 加进来的学生立刻可以注册并登录", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "赵雨桐" });

    // 这是这个功能的全部意义：让漏读的人能真正用起来
    registerStudent(w.db, {
      studentId: "2599000001",
      name: "赵雨桐",
      initialPassword: "123456",
      clock: w.clock,
    });

    assert.equal(login(w.db, { userId: "2599000001", password: "123456" }).account.id, "2599000001");
  });

  test("学号与姓名前后空白会被去掉", () => {
    const w = world();
    const result = add(w, { studentId: "  2599000001  ", name: "  赵雨桐  " });

    assert.equal(result.student.id, "2599000001");
    assert.equal(result.student.name, "赵雨桐");
  });

  test("班级可以留空 —— 但明确说出来它影响什么", () => {
    const w = world();
    const result = add(w, { studentId: "2599000001", name: "赵雨桐", className: "" });

    assert.equal(result.student.className, "");
    assert.equal(listStudents(w.db).length, 1);
  });

  test("★ 学号为空被拒绝", () => {
    const w = world();
    assert.throws(
      () => add(w, { studentId: "   ", name: "赵雨桐" }),
      (e) => e instanceof ImportError && e.code === "STUDENT_ID_REQUIRED",
    );
  });

  test("★ 姓名为空被拒绝，且说明为什么不能空", () => {
    const w = world();

    assert.throws(
      () => add(w, { studentId: "2599000001", name: "  " }),
      (e) =>
        e instanceof ImportError &&
        e.code === "NAME_REQUIRED" &&
        /注册/.test((e as Error).message),
      "报错要说明后果 —— 缺姓名的学生永远登不进来",
    );

    assert.equal(listStudents(w.db).length, 0, "失败的添加不该留下半截数据");
  });

  test("学号推不出年级时仍然加入，年级记为 0", () => {
    const w = world();
    const result = add(w, { studentId: "ABC123", name: "某同学" });

    assert.equal(result.student.grade, 0, "推不出就记 0，由界面提示管理员核对");
    assert.equal(getStudent(w.db, "ABC123").grade, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. 修改（学号已存在）
// ---------------------------------------------------------------------------

describe("学号已存在时是修改", () => {
  test("改姓名与班级", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "方滴睿", className: "计算机2501" });

    const result = add(w, {
      studentId: "2599000001",
      name: "赵雨桐",
      className: "计算机2502",
    });

    assert.equal(result.action, "UPDATE");
    assert.equal(result.previous?.name, "方滴睿");
    assert.equal(result.previous?.className, "计算机2501");

    assert.equal(getStudent(w.db, "2599000001").name, "赵雨桐");
    assert.equal(getStudent(w.db, "2599000001").className, "计算机2502");
  });

  test("不会因为学号重复而多出一条记录", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "甲" });
    add(w, { studentId: "2599000001", name: "乙" });

    assert.equal(listStudents(w.db).length, 1);
  });

  test("★ 改名之后注册用的姓名随之变化（两要素校验读的是这里）", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "错名字" });
    add(w, { studentId: "2599000001", name: "正确名字" });

    assert.throws(
      () =>
        registerStudent(w.db, {
          studentId: "2599000001",
          name: "错名字",
          initialPassword: "123456",
          clock: w.clock,
        }),
      /不匹配/,
    );

    assert.doesNotThrow(() =>
      registerStudent(w.db, {
        studentId: "2599000001",
        name: "正确名字",
        initialPassword: "123456",
        clock: w.clock,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 留痕
// ---------------------------------------------------------------------------

describe("★ 每一次人工改动都留痕", () => {
  test("新增会记一条 ADD", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "赵雨桐" });

    const audit = listRosterAudit(w.db);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, "ADD");
    assert.equal(audit[0]?.studentId, "2599000001");
    assert.equal(audit[0]?.actorId, ADMIN);
    assert.equal(audit[0]?.previousName, null);
  });

  test("修改会记下改前改后", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "甲", className: "计算机2501" });
    add(w, { studentId: "2599000001", name: "乙", className: "计算机2502" });

    const audit = listRosterAudit(w.db);
    assert.equal(audit.length, 2);
    assert.equal(audit[0]?.action, "UPDATE");
    assert.equal(audit[0]?.previousName, "甲", "要记下改之前是什么");
    assert.equal(audit[0]?.previousClassName, "计算机2501");
    assert.equal(audit[1]?.action, "ADD");
  });

  test("记录里带着操作人", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "甲", actorId: "chair-a" });

    assert.equal(listRosterAudit(w.db)[0]?.actorId, "chair-a");
  });

  test("★ 改动记录不可改写、不可删除", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "甲" });

    assert.throws(
      () => w.db.exec("UPDATE roster_changes SET name = '改了'"),
      /ROSTER_AUDIT_IMMUTABLE/,
    );
    assert.throws(() => w.db.exec("DELETE FROM roster_changes"), /ROSTER_AUDIT_IMMUTABLE/);
  });

  test("★ 失败的添加不留下记录", () => {
    const w = world();

    assert.throws(() => add(w, { studentId: "2599000001", name: "  " }));
    assert.equal(listRosterAudit(w.db).length, 0);
  });

  test("记录按时间倒序，最近的在前", () => {
    const w = world();
    add(w, { studentId: "2599000001", name: "甲" });
    w.clock.advance(60_000);
    add(w, { studentId: "2599000002", name: "乙" });

    const audit = listRosterAudit(w.db);
    assert.equal(audit[0]?.studentId, "2599000002");
    assert.equal(audit[1]?.studentId, "2599000001");
  });
});

// ---------------------------------------------------------------------------
// 4. 搜索
// ---------------------------------------------------------------------------

describe("搜索名册", () => {
  function seeded() {
    const w = world();
    add(w, { studentId: "2599000001", name: "赵雨桐", className: "计算机2501" });
    add(w, { studentId: "2599000002", name: "李海燕", className: "计算机2501" });
    add(w, { studentId: "2599000019", name: "孙志强", className: "大数据2501" });
    return w;
  }

  test("空查询返回全部", () => {
    assert.equal(searchStudents(seeded().db, "").length, 3);
    assert.equal(searchStudents(seeded().db, "   ").length, 3);
  });

  test("按学号搜", () => {
    const found = searchStudents(seeded().db, "2599000001");
    assert.deepEqual(found.map((s) => s.name), ["赵雨桐"]);
  });

  test("按学号片段搜", () => {
    // 片段从夹具里**实际存在的学号**推导，不写死。
    // 写死的话，夹具的学号一变（比如这次脱敏）这条就红，
    // 而它测的是"输片段能搜到"，不是"某个具体的号还在"。
    const all = searchStudents(seeded().db, "").map((s) => s.id);
    const fragment = all[0]!.slice(0, 8);
    const expected = all.filter((id) => id.startsWith(fragment)).length;

    assert.ok(expected >= 2, "这条测试需要至少两个学号共享前缀才有意义");
    assert.equal(searchStudents(seeded().db, fragment).length, expected);
  });

  test("按姓名搜", () => {
    assert.deepEqual(searchStudents(seeded().db, "李海燕").map((s) => s.id), ["2599000002"]);
  });

  test("按班级搜", () => {
    assert.equal(searchStudents(seeded().db, "大数据").length, 1);
  });

  test("搜不到就返回空，不报错", () => {
    assert.deepEqual(searchStudents(seeded().db, "查无此人"), []);
  });
});

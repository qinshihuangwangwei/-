/**
 * M2.2 全套计分项与责任指派 —— 不变量测试
 *
 * 对应设计文档 §3.1 与附录 A/B。
 *
 * 这里钉死三条：
 *
 *   1. **附录 A 的算术必须成立。** A 项八个大类、25 个子项，分值之和
 *      必须正好是 100。这张表是从真实数据里读出来的，抄错一位就是每人错几分。
 *
 *   2. **未指派即禁止录入。** 而且报错必须**列出具体是哪几项** ——
 *      否则管理员拿到一句"还有未指派的项"只能一项项去数，最后还是会漏。
 *
 *   3. **改派要留历史。** 学期末要能回答"这一项当时是谁负责的"，
 *      而不是只知道"现在是谁"。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import {
  DEPARTMENTS,
  DEPARTMENT_ID,
  SCORING_ITEMS,
  A_TOTAL_CAP,
  groupTotals,
  seedReferenceData,
} from "../../src/db/seed.ts";
import {
  activeAssignments,
  assignItem,
  assignDefaults,
  assignmentHistory,
  assignmentProgress,
  assertAllItemsAssigned,
  departmentOfItem,
  departmentsWithoutItems,
  itemsOfDepartment,
  unassignedItems,
  AssignmentError,
} from "../../src/domain/assignment.ts";
import { listItems } from "../../src/domain/item.ts";
import { createTerm, transition } from "../../src/domain/term.ts";
import { seedAndAssignAll } from "../helpers/term-fixture.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T0 = "2026-03-01T09:00:00.000Z";
const TERM = 1;

function world(opts: { seed?: boolean } = {}): { db: Db; clock: FixedClock } {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);
  if (opts.seed !== false) seedReferenceData(db);
  createTerm(db, { id: TERM, name: "2025-2026 春季学期" });
  return { db, clock };
}

// ---------------------------------------------------------------------------
// 1. 参考数据
// ---------------------------------------------------------------------------

describe("参考数据：附录 A 与附录 B", () => {
  test("★ 附录 A 的算术成立：A 项八个大类合计正好 100 分", () => {
    const totals = groupTotals();
    const map = Object.fromEntries(totals.map((t) => [t.groupCode, t.cap]));

    assert.deepEqual(map, {
      A1: 6,
      A2: 18,
      A3: 13,
      A4: 16,
      A5: 8,
      A6: 6,
      A7: 25,
      A8: 8,
      C: 12,
    });

    const aTotal = totals
      .filter((t) => t.groupCode.startsWith("A"))
      .reduce((sum, t) => sum + t.cap, 0);

    assert.equal(aTotal, A_TOTAL_CAP, "A 项合计必须是 100 分");
  });

  test("A 项有 25 个子项，加 C 项共 26 个", () => {
    const aItems = SCORING_ITEMS.filter((i) => i.groupCode.startsWith("A"));
    assert.equal(aItems.length, 25);
    assert.equal(SCORING_ITEMS.length, 26);
  });

  test("★ A6 遵纪守法是基线制，基线 5 分", () => {
    const discipline = SCORING_ITEMS.find((i) => i.groupCode === "A6");

    assert.equal(discipline?.mode, "BASELINE");
    assert.equal(
      discipline?.baseline,
      5,
      "真实数据里 147 人恒为 5 分：按累加制实现会让每人凭空少 5 分，且因为所有人一起少，没人会发现",
    );
  });

  test("除 A6 外全部是累加制", () => {
    const baselineItems = SCORING_ITEMS.filter((i) => i.mode === "BASELINE");
    assert.deepEqual(baselineItems.map((i) => i.groupCode), ["A6"]);
  });

  test("部门清单是 12 个，与附录 B 一致", () => {
    assert.equal(DEPARTMENTS.length, 12);
    assert.deepEqual(
      DEPARTMENTS.map((d) => d.name),
      [
        "办公室",
        "生活实践部",
        "网络思政部",
        "新闻采编部",
        "公共权益部",
        "青年发展部",
        "心理健康部",
        "学习部",
        "组织部",
        "宣传部",
        "体育部",
        "文艺部",
      ],
    );
  });

  test("★ 四项存疑归属被显式标记，而不是悄悄给了默认值", () => {
    const uncertain = SCORING_ITEMS.filter((i) => i.needsConfirmation);
    const names = uncertain.map((i) => `${i.groupCode} ${i.name}`).sort();

    assert.deepEqual(names, [
      "A2 参与学生工作·班级评定",
      "A6 遵纪守法",
      "A7 其他素质能力",
      "A7 社团",
    ]);
  });

  test("播种幂等：跑两次结果相同", () => {
    const db = openDatabase(":memory:");

    const first = seedReferenceData(db);
    const second = seedReferenceData(db);

    assert.equal(first.departmentsInserted, 12);
    assert.equal(first.itemsInserted, 26);
    assert.equal(second.departmentsInserted, 0);
    assert.equal(second.itemsInserted, 0);

    assert.equal(listItems(db).length, 26);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM departments").get() as { n: number }).n,
      12,
    );
  });

  test("播种不覆盖已有数据", () => {
    const db = openDatabase(":memory:");
    seedReferenceData(db);

    // 有人改动过上限
    db.exec("UPDATE scoring_items SET cap = 7 WHERE id = 20");

    seedReferenceData(db); // 再播一次

    const item = db
      .prepare("SELECT cap FROM scoring_items WHERE id = 20")
      .get() as { cap: number };
    assert.equal(item.cap, 7, "播种只增不改，否则已经算过的分数会对不上");
  });

  test("每个计分项都有默认责任部门（存疑的也有，供参考）", () => {
    for (const item of SCORING_ITEMS) {
      assert.ok(
        item.defaultDepartment !== null,
        `${item.name} 没有默认部门，批量指派时会静默漏掉`,
      );
    }
  });

  test("默认部门都真实存在于部门清单中", () => {
    const names = new Set(DEPARTMENTS.map((d) => d.name));
    for (const item of SCORING_ITEMS) {
      assert.ok(
        names.has(item.defaultDepartment!),
        `${item.name} 的默认部门「${item.defaultDepartment}」不在清单里`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 指派
// ---------------------------------------------------------------------------

describe("指派责任部门", () => {
  test("指派一个计分项", () => {
    const { db, clock } = world();

    const assignment = assignItem(db, {
      termId: TERM,
      itemId: 20, // 体育类
      departmentId: DEPARTMENT_ID["体育部"]!,
      by: "chair-a",
      clock,
    });

    assert.equal(assignment.departmentId, DEPARTMENT_ID["体育部"]!);
    assert.equal(departmentOfItem(db, TERM, 20), DEPARTMENT_ID["体育部"]!);
  });

  test("重复指派给同一部门被拒绝", () => {
    const { db, clock } = world();
    const sports = DEPARTMENT_ID["体育部"]!;

    assignItem(db, { termId: TERM, itemId: 20, departmentId: sports, by: "chair-a", clock });

    assert.throws(
      () => assignItem(db, { termId: TERM, itemId: 20, departmentId: sports, by: "chair-a", clock }),
      (e) => e instanceof AssignmentError && e.code === "ALREADY_ASSIGNED",
    );
  });

  test("★ 改派保留历史：旧记录只被撤销，不被改写", () => {
    const { db, clock } = world();
    const sports = DEPARTMENT_ID["体育部"]!;
    const arts = DEPARTMENT_ID["文艺部"]!;

    assignItem(db, { termId: TERM, itemId: 20, departmentId: sports, by: "chair-a", clock });
    clock.advance(60_000);
    assignItem(db, {
      termId: TERM,
      itemId: 20,
      departmentId: arts,
      by: "chair-b",
      reason: "体育类活动由文艺部合并承办",
      clock,
    });

    const history = assignmentHistory(db, TERM, 20);
    assert.equal(history.length, 2, "改派不是原地修改，是撤销 + 新增");

    assert.equal(history[0]?.departmentId, sports);
    assert.equal(history[0]?.revokedBy, "chair-b");
    assert.match(history[0]?.revokeReason ?? "", /文艺部/);

    assert.equal(history[1]?.departmentId, arts);
    assert.equal(history[1]?.revokedAt, null, "新记录是生效中的那条");

    assert.equal(departmentOfItem(db, TERM, 20), arts, "当前责任部门是新的");
  });

  test("指派记录不可改写", () => {
    const { db, clock } = world();
    const assignment = assignItem(db, {
      termId: TERM,
      itemId: 20,
      departmentId: DEPARTMENT_ID["体育部"]!,
      by: "chair-a",
      clock,
    });

    assert.throws(
      () =>
        db.exec(`UPDATE item_assignments SET department_id = 3 WHERE id = ${assignment.id}`),
      /ASSIGNMENT_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec(`UPDATE item_assignments SET item_id = 19 WHERE id = ${assignment.id}`),
      /ASSIGNMENT_IMMUTABLE/,
    );
  });

  test("指派记录不可删除", () => {
    const { db, clock } = world();
    assignItem(db, {
      termId: TERM,
      itemId: 20,
      departmentId: DEPARTMENT_ID["体育部"]!,
      by: "chair-a",
      clock,
    });

    assert.throws(() => db.exec("DELETE FROM item_assignments"), /ASSIGNMENT_IMMUTABLE/);
  });

  test("指派不存在的周期 / 计分项 / 部门都会报错", () => {
    const { db, clock } = world();
    const sports = DEPARTMENT_ID["体育部"]!;

    assert.throws(
      () => assignItem(db, { termId: 999, itemId: 20, departmentId: sports, by: "a", clock }),
      (e) => e instanceof AssignmentError && e.code === "TERM_NOT_FOUND",
    );
    assert.throws(
      () => assignItem(db, { termId: TERM, itemId: 999, departmentId: sports, by: "a", clock }),
      (e) => e instanceof AssignmentError && e.code === "ITEM_NOT_FOUND",
    );
    assert.throws(
      () => assignItem(db, { termId: TERM, itemId: 20, departmentId: 999, by: "a", clock }),
      (e) => e instanceof AssignmentError && e.code === "DEPARTMENT_NOT_FOUND",
    );
  });

  test("一个计分项同时只能有一个责任部门", () => {
    const { db, clock } = world();
    assignItem(db, {
      termId: TERM,
      itemId: 20,
      departmentId: DEPARTMENT_ID["体育部"]!,
      by: "a",
      clock,
    });

    assert.equal(activeAssignments(db, TERM).filter((a) => a.itemId === 20).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. 批量指派
// ---------------------------------------------------------------------------

describe("按默认模板批量指派", () => {
  test("★ 存疑的四项不被自动指派", () => {
    const { db, clock } = world();

    const result = assignDefaults(db, { termId: TERM, by: "chair-a", clock });

    assert.equal(result.assigned.length, 22);
    assert.equal(
      result.needsDecision.length,
      4,
      "连需求方都说不清归谁的四项，给个默认值等于用猜测掩盖真实的空白",
    );

    assert.deepEqual(
      result.needsDecision.map((i) => i.groupCode).sort(),
      ["A2", "A6", "A7", "A7"],
    );
  });

  test("批量指派后，未指派的就是那四项", () => {
    const { db, clock } = world();
    assignDefaults(db, { termId: TERM, by: "chair-a", clock });

    const missing = unassignedItems(db, TERM).map((i) => `${i.groupCode} ${i.name}`);
    assert.deepEqual(missing.sort(), [
      "A2 参与学生工作·班级评定",
      "A6 遵纪守法",
      "A7 其他素质能力",
      "A7 社团",
    ]);
  });

  test("批量指派是幂等的：已有的不重复指派", () => {
    const { db, clock } = world();

    assignDefaults(db, { termId: TERM, by: "chair-a", clock });
    const second = assignDefaults(db, { termId: TERM, by: "chair-a", clock });

    assert.equal(second.assigned.length, 0);
    assert.equal(activeAssignments(db, TERM).length, 22);
  });

  test("批量指派后不产生撤销记录", () => {
    const { db, clock } = world();
    assignDefaults(db, { termId: TERM, by: "chair-a", clock });

    const revoked = assignmentHistory(db, TERM).filter((a) => a.revokedAt !== null);
    assert.equal(revoked.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. 守卫：未指派禁止录入
// ---------------------------------------------------------------------------

describe("未指派即禁止录入", () => {
  test("★ 漏一项就进不了录入状态，且报错列出具体是哪一项", () => {
    const { db, clock } = world();

    // 除了 A7-3 体育类，其他全部指派
    for (const item of listItems(db)) {
      if (item.id === 20) continue;
      assignItem(db, {
        termId: TERM,
        itemId: item.id,
        departmentId: DEPARTMENT_ID["办公室"]!,
        by: "chair-a",
        clock,
      });
    }

    assert.throws(
      () => assertAllItemsAssigned(db, TERM),
      (e) => {
        assert.ok(e instanceof AssignmentError);
        assert.equal((e as AssignmentError).code, "UNASSIGNED_ITEMS");
        const message = (e as Error).message;
        assert.match(message, /还有 1 个计分项/);
        assert.match(message, /A7 体育类/, "必须点名是哪一项，只说『还有未指派的项』等于没说");
        return true;
      },
    );
  });

  test("★ 未指派时，周期状态机拒绝进入录入", () => {
    const { db, clock } = world();
    assignDefaults(db, { termId: TERM, by: "chair-a", clock });

    transition(db, TERM, "ASSIGNING", clock);

    assert.throws(
      () => transition(db, TERM, "ENTERING", clock),
      (e) => e instanceof AssignmentError && e.code === "UNASSIGNED_ITEMS",
      "守卫放在状态机里而不是调用方，因为『任何人都不能绕过它』比『记得调用它』可靠",
    );
  });

  test("全部指派后放行", () => {
    const { db, clock } = world();
    transition(db, TERM, "ASSIGNING", clock);
    seedAndAssignAll(db, TERM, clock);

    const term = transition(db, TERM, "ENTERING", clock);
    assert.equal(term.status, "ENTERING");
  });

  test("★ 一个计分项都没有时，也被拒绝（不是「全部指派完毕」）", () => {
    const db = openDatabase(":memory:");
    const clock = fixedClock(T0);
    createTerm(db, { id: TERM, name: "空库" });
    transition(db, TERM, "ASSIGNING", clock);

    assert.throws(
      () => transition(db, TERM, "ENTERING", clock),
      (e) => e instanceof AssignmentError && e.code === "NO_ITEMS_CONFIGURED",
      "空集不等于「都指派好了」——否则一个没导入细则的库会安静地进入录入状态",
    );
  });

  test("多漏几项时报错逐一列出", () => {
    const { db, clock } = world();
    transition(db, TERM, "ASSIGNING", clock);
    assignDefaults(db, { termId: TERM, by: "chair-a", clock });

    try {
      transition(db, TERM, "ENTERING", clock);
      assert.fail("应当抛错");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /还有 4 个计分项/);
      for (const name of ["班级评定", "遵纪守法", "社团", "其他素质能力"]) {
        assert.match(message, new RegExp(name), `报错里没提到「${name}」`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 部门视角
// ---------------------------------------------------------------------------

describe("部门视角", () => {
  test("能查出某部门负责哪些计分项", () => {
    const { db, clock } = world();
    seedAndAssignAll(db, TERM, clock);

    const sports = itemsOfDepartment(db, TERM, DEPARTMENT_ID["体育部"]!);
    assert.deepEqual(sports.map((i) => i.name), ["体育类"]);

    const office = itemsOfDepartment(db, TERM, DEPARTMENT_ID["办公室"]!);
    assert.ok(office.length >= 5, `办公室应当负责多项，实际 ${office.length} 项`);
  });

  test("能查出没有任何计分项的部门", () => {
    const { db, clock } = world();
    seedAndAssignAll(db, TERM, clock);

    const idle = departmentsWithoutItems(db, TERM).map((d) => d.name);

    assert.ok(idle.includes("新闻采编部"));
    assert.ok(idle.includes("宣传部"));
    assert.ok(idle.includes("心理健康部"));
    assert.ok(
      !idle.includes("体育部"),
      "体育部负责体育类，不该出现在闲置名单里",
    );
  });

  test("指派进度可查", () => {
    const { db, clock } = world();

    let progress = assignmentProgress(db, TERM);
    assert.deepEqual(
      { total: progress.total, assigned: progress.assigned },
      { total: 26, assigned: 0 },
    );

    assignDefaults(db, { termId: TERM, by: "chair-a", clock });

    progress = assignmentProgress(db, TERM);
    assert.deepEqual(
      { total: progress.total, assigned: progress.assigned },
      { total: 26, assigned: 22 },
    );
    assert.equal(progress.remaining.length, 4);
  });

  test("★ 换一个部门负责，只是换数据，不改代码", () => {
    const { db, clock } = world();
    seedAndAssignAll(db, TERM, clock);

    assert.deepEqual(
      itemsOfDepartment(db, TERM, DEPARTMENT_ID["体育部"]!).map((i) => i.name),
      ["体育类"],
    );

    // 把体育类改派给文艺部
    assignItem(db, {
      termId: TERM,
      itemId: 20,
      departmentId: DEPARTMENT_ID["文艺部"]!,
      by: "chair-a",
      reason: "今年体育类活动由文艺部承办",
      clock,
    });

    assert.deepEqual(itemsOfDepartment(db, TERM, DEPARTMENT_ID["体育部"]!), []);
    assert.deepEqual(
      itemsOfDepartment(db, TERM, DEPARTMENT_ID["文艺部"]!).map((i) => i.name),
      ["文艺类", "体育类"],
    );
  });

  test("同一个周期里不同计分项可以归不同部门，互不干扰", () => {
    const { db, clock } = world();
    seedAndAssignAll(db, TERM, clock);

    const active = activeAssignments(db, TERM);
    assert.equal(active.length, 26);
    assert.equal(new Set(active.map((a) => a.departmentId)).size > 1, true);
    assert.equal(new Set(active.map((a) => a.itemId)).size, 26, "一个计分项只能有一个部门");
  });
});

/**
 * M2.1b 任职与身份 —— 不变量测试
 *
 * 三条系统级约束：
 *   1. 编制上限（主席 2、每部部长 1、副部长 2）
 *   2. 一人一职
 *   3. 管理员与主席不可兼于一身 —— 否则双签会被一个人凑齐
 *
 * 以及最实际的一条：**"干事"这个词必须有真实来源**。
 * A2-1 学生干部任职加分（6 分）读的是已审批的在任记录，
 * 而不是学生注册时自己勾的那个。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import {
  bootstrapAdmin,
  grantAdmin,
  isAdmin,
  appointChair,
  appointDeptLead,
  dismiss,
  applyToJoin,
  approveJoin,
  rejectJoin,
  pendingApplications,
  activeMembership,
  currentChairs,
  departmentLeads,
  resolveActor,
  servingOfficers,
  listMemberships,
  ESTABLISHMENT,
  MembershipError,
} from "../../src/domain/membership.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T0 = "2026-03-01T09:00:00.000Z";
const DEPT_SPORTS = 1;
const DEPT_OFFICE = 2;

/** 名册里的人。s01–s08 是普通学生，s09–s12 专门用来当各部门负责人。 */
const PEOPLE = [
  "s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08",
  "s09", "s10", "s11", "s12",
];

interface World {
  db: Db;
  clock: FixedClock;
}

function world(): World {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);

  db.exec(`
    INSERT INTO departments (id, name) VALUES (${DEPT_SPORTS}, '体育部'), (${DEPT_OFFICE}, '办公室');
  `);

  for (const id of PEOPLE) {
    const n = id.slice(1);
    db.prepare(
      "INSERT INTO students (id, name, class_name, grade) VALUES (?, ?, ?, 2025)",
    ).run(id, `学生${n}`, "计算机2501");
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)",
    ).run(id, id, `学生${n}`, T0);
  }

  // 老师账号：没有学号，不是学生
  db.prepare(
    "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('teacher', NULL, '学院老师', 'x', ?)",
  ).run(T0);

  return { db, clock };
}

// ---------------------------------------------------------------------------
// 1. 管理员
// ---------------------------------------------------------------------------

describe("管理员", () => {
  test("首个管理员必须用初始化命令创建", () => {
    const { db, clock } = world();

    bootstrapAdmin(db, "teacher", clock);
    assert.equal(isAdmin(db, "teacher"), true);

    assert.throws(
      () => bootstrapAdmin(db, "s01", clock),
      (e) => e instanceof MembershipError && e.code === "ADMIN_ALREADY_EXISTS",
      "系统内没有自助注册为管理员的路径",
    );
  });

  test("已有管理员后，只能由既有管理员任命", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    grantAdmin(db, "s01", "teacher", clock);
    assert.equal(isAdmin(db, "s01"), true);
  });

  test("★ 管理员不能被任命为主席（双签会被一个人凑齐）", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    assert.throws(
      () => appointChair(db, { userId: "teacher", by: "teacher", clock }),
      (e) =>
        e instanceof MembershipError && e.code === "ROLE_CONFLICT_ADMIN_CHAIR",
    );
  });

  test("★ 主席不能被任命为管理员（另一半）", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    appointChair(db, { userId: "s01", by: "teacher", clock });

    assert.throws(
      () => grantAdmin(db, "s01", "teacher", clock),
      (e) =>
        e instanceof MembershipError && e.code === "ROLE_CONFLICT_ADMIN_CHAIR",
      "同一个人兼任两种角色，异议裁决的双签就变成一个人签两次",
    );
  });

  test("管理员不是学生会职位，不出现在任职表里", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    assert.equal(listMemberships(db, { userId: "teacher" }).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. 编制上限
// ---------------------------------------------------------------------------

describe("编制上限", () => {
  test("主席最多两人", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    appointChair(db, { userId: "s01", by: "teacher", clock });
    appointChair(db, { userId: "s02", by: "teacher", clock });
    assert.equal(currentChairs(db).length, ESTABLISHMENT.CHAIR);

    assert.throws(
      () => appointChair(db, { userId: "s03", by: "teacher", clock }),
      (e) => e instanceof MembershipError && e.code === "ESTABLISHMENT_EXCEEDED",
      "免职会留下记录，直接换人不会 —— 满编时必须先免后任",
    );
  });

  test("每个部门只能有一位部长", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    assert.throws(
      () =>
        appointDeptLead(db, {
          userId: "s02",
          departmentId: DEPT_SPORTS,
          role: "HEAD",
          by: "teacher",
          clock,
        }),
      (e) => e instanceof MembershipError && e.code === "ESTABLISHMENT_EXCEEDED",
    );

    // 另一个部门不受影响
    appointDeptLead(db, {
      userId: "s02",
      departmentId: DEPT_OFFICE,
      role: "HEAD",
      by: "teacher",
      clock,
    });
    assert.equal(departmentLeads(db, DEPT_OFFICE).head?.userId, "s02");
  });

  test("每个部门最多两位副部长", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    for (const userId of ["s01", "s02"]) {
      appointDeptLead(db, {
        userId,
        departmentId: DEPT_SPORTS,
        role: "DEPUTY",
        by: "teacher",
        clock,
      });
    }
    assert.equal(
      departmentLeads(db, DEPT_SPORTS).deputies.length,
      ESTABLISHMENT.DEPUTY_PER_DEPARTMENT,
    );

    assert.throws(
      () =>
        appointDeptLead(db, {
          userId: "s03",
          departmentId: DEPT_SPORTS,
          role: "DEPUTY",
          by: "teacher",
          clock,
        }),
      (e) => e instanceof MembershipError && e.code === "ESTABLISHMENT_EXCEEDED",
    );
  });

  test("免职后空出编制", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    const head = appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });
    dismiss(db, { membershipId: head.id, by: "teacher", clock });

    appointDeptLead(db, {
      userId: "s02",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    assert.equal(departmentLeads(db, DEPT_SPORTS).head?.userId, "s02");
  });
});

// ---------------------------------------------------------------------------
// 3. 一人一职
// ---------------------------------------------------------------------------

describe("一人一职", () => {
  test("不能在两个部门同时任职", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    assert.throws(
      () =>
        appointDeptLead(db, {
          userId: "s01",
          departmentId: DEPT_OFFICE,
          role: "HEAD",
          by: "teacher",
          clock,
        }),
      (e) => e instanceof MembershipError && e.code === "ALREADY_HAS_POSITION",
    );
  });

  test("免职后可以担任新职位", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    const first = appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });
    dismiss(db, { membershipId: first.id, by: "teacher", clock });

    appointChair(db, { userId: "s01", by: "teacher", clock });
    assert.equal(activeMembership(db, "s01")?.role, "CHAIR");
  });
});

// ---------------------------------------------------------------------------
// 4. 任职记录不可改写
// ---------------------------------------------------------------------------

describe("任职记录不可改写", () => {
  test("★ 只能写入离任时间，不能改写任命内容", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    const head = appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    assert.throws(
      () => db.exec(`UPDATE memberships SET role = 'CHAIR' WHERE id = ${head.id}`),
      /MEMBERSHIP_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec(`UPDATE memberships SET user_id = 's02' WHERE id = ${head.id}`),
      /MEMBERSHIP_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec(`UPDATE memberships SET appointed_by = '别人' WHERE id = ${head.id}`),
      /MEMBERSHIP_IMMUTABLE/,
    );
  });

  test("任职记录不可删除", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    appointChair(db, { userId: "s01", by: "teacher", clock });

    assert.throws(
      () => db.exec("DELETE FROM memberships"),
      /MEMBERSHIP_IMMUTABLE/,
    );
  });

  test("写入离任时间是允许的", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    const chair = appointChair(db, { userId: "s01", by: "teacher", clock });

    db.exec(
      `UPDATE memberships SET ended_at = '${T0}', ended_by = 'teacher' WHERE id = ${chair.id}`,
    );

    assert.equal(activeMembership(db, "s01"), null);
    assert.equal(listMemberships(db, { userId: "s01" }).length, 1, "记录本身还在");
  });

  test("免职留下的是离任时间，不是把记录抹掉", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    const head = appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    clock.advance(1000);
    const ended = dismiss(db, { membershipId: head.id, by: "teacher", clock });

    assert.equal(ended.endedBy, "teacher");
    assert.equal(ended.appointedBy, "teacher");
    assert.equal(ended.appointedAt, T0);
    assert.equal(ended.role, "HEAD");
  });

  test("不能重复免职", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    const head = appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    dismiss(db, { membershipId: head.id, by: "teacher", clock });
    assert.throws(
      () => dismiss(db, { membershipId: head.id, by: "teacher", clock }),
      (e) => e instanceof MembershipError && e.code === "ALREADY_DISMISSED",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 干事身份
// ---------------------------------------------------------------------------

describe("干事身份必须有真实来源", () => {
  test("★ 申请不等于干事 —— 未审批前没有任何职位", () => {
    const { db, clock } = world();

    applyToJoin(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      note: null,
      clock,
    });

    assert.equal(
      activeMembership(db, "s01"),
      null,
      "自己勾一下就是干事，等于白送 6 分干部任职加分",
    );
    assert.equal(resolveActor(db, "s01").roles.includes("MEMBER"), false);
  });

  test("部长审批通过后成为干事", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    const head = appointDeptLead(db, {
      userId: "s09",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    const application = applyToJoin(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      note: "想加入体育部",
      clock,
    });

    const membership = approveJoin(db, {
      applicationId: application.id,
      by: head.userId,
      clock,
    });

    assert.equal(membership.role, "MEMBER");
    assert.equal(membership.departmentId, DEPT_SPORTS);
    assert.equal(resolveActor(db, "s01").roles.includes("MEMBER"), true);
  });

  test("★ 只有本部门的部长或副部长能审批加入申请", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    const sportsHead = appointDeptLead(db, {
      userId: "s09",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    }).userId;
    const officeHead = appointDeptLead(db, {
      userId: "s10",
      departmentId: DEPT_OFFICE,
      role: "HEAD",
      by: "teacher",
      clock,
    }).userId;

    const application = applyToJoin(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      note: null,
      clock,
    });

    assert.throws(
      () =>
        approveJoin(db, {
          applicationId: application.id,
          by: officeHead,
          clock,
        }),
      (e) => e instanceof MembershipError && e.code === "NOT_DEPARTMENT_LEAD",
      "干事身份关系到干部任职加分，不能由外人代批",
    );

    assert.equal(
      approveJoin(db, { applicationId: application.id, by: sportsHead, clock })
        .role,
      "MEMBER",
    );
  });

  test("已有职位的人不能再申请加入", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    appointChair(db, { userId: "s01", by: "teacher", clock });

    assert.throws(
      () =>
        applyToJoin(db, {
          userId: "s01",
          departmentId: DEPT_SPORTS,
          note: null,
          clock,
        }),
      (e) => e instanceof MembershipError && e.code === "ALREADY_HAS_POSITION",
    );
  });

  test("不能重复提交待审批申请", () => {
    const { db, clock } = world();
    applyToJoin(db, { userId: "s01", departmentId: DEPT_SPORTS, note: null, clock });

    assert.throws(
      () =>
        applyToJoin(db, {
          userId: "s01",
          departmentId: DEPT_OFFICE,
          note: null,
          clock,
        }),
      (e) => e instanceof MembershipError && e.code === "APPLICATION_PENDING",
    );
  });

  test("驳回后可以再申请", () => {
    const { db, clock } = world();
    const first = applyToJoin(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      note: null,
      clock,
    });
    rejectJoin(db, {
      applicationId: first.id,
      by: "head-x",
      reason: "本学期名额已满",
      clock,
    });

    const second = applyToJoin(db, {
      userId: "s01",
      departmentId: DEPT_OFFICE,
      note: null,
      clock,
    });
    assert.equal(second.status, "PENDING");
  });

  test("待审批列表按部门隔离", () => {
    const { db, clock } = world();
    applyToJoin(db, { userId: "s01", departmentId: DEPT_SPORTS, note: null, clock });
    applyToJoin(db, { userId: "s02", departmentId: DEPT_OFFICE, note: null, clock });

    assert.equal(pendingApplications(db, DEPT_SPORTS).length, 1);
    assert.equal(pendingApplications(db, DEPT_SPORTS)[0]?.userId, "s01");
    assert.equal(pendingApplications(db, DEPT_OFFICE)[0]?.userId, "s02");
  });

  test("★ 干部任职加分名单只读已审批的在任记录", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    const head = appointDeptLead(db, {
      userId: "s09",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    // s01 提交了申请但还没批 —— 不该出现在名单里
    applyToJoin(db, { userId: "s01", departmentId: DEPT_SPORTS, note: null, clock });

    // s02 走了完整流程
    const app2 = applyToJoin(db, {
      userId: "s02",
      departmentId: DEPT_SPORTS,
      note: null,
      clock,
    });
    approveJoin(db, { applicationId: app2.id, by: head.userId, clock });

    const officers = servingOfficers(db, { departmentId: DEPT_SPORTS });
    const ids = officers.map((o) => o.userId).sort();

    assert.deepEqual(ids, ["s02", "s09"], "只有部长和已批准干事在名单上");
    assert.ok(!ids.includes("s01"), "未审批的申请者不能进干部加分名单");
  });

  test("离任后不再出现在干部名单里", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    const head = appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    assert.equal(servingOfficers(db, { departmentId: DEPT_SPORTS }).length, 1);
    dismiss(db, { membershipId: head.id, by: "teacher", clock });
    assert.equal(servingOfficers(db, { departmentId: DEPT_SPORTS }).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. 角色解析
// ---------------------------------------------------------------------------

describe("角色解析", () => {
  test("普通学生只有 STUDENT 角色", () => {
    const { db } = world();
    const actor = resolveActor(db, "s01");

    assert.deepEqual([...actor.roles], ["STUDENT"]);
    assert.equal(actor.studentId, "s01");
    assert.equal(actor.departmentId, null);
  });

  test("部长同时保有学生身份", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    appointDeptLead(db, {
      userId: "s01",
      departmentId: DEPT_SPORTS,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    const actor = resolveActor(db, "s01");
    assert.ok(actor.roles.includes("STUDENT"), "部长也是学生");
    assert.ok(actor.roles.includes("HEAD"));
    assert.equal(actor.departmentId, DEPT_SPORTS);
  });

  test("主席没有部门", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);
    appointChair(db, { userId: "s01", by: "teacher", clock });

    const actor = resolveActor(db, "s01");
    assert.ok(actor.roles.includes("CHAIR"));
    assert.equal(actor.departmentId, null, "主席是全院的，不属于任何部门");
  });

  test("老师的账号没有学生身份", () => {
    const { db, clock } = world();
    bootstrapAdmin(db, "teacher", clock);

    const actor = resolveActor(db, "teacher");
    assert.deepEqual([...actor.roles], ["ADMIN"]);
    assert.equal(actor.studentId, null);
  });

  test("不存在的账号解析为空角色", () => {
    const { db } = world();
    const actor = resolveActor(db, "不存在");

    assert.deepEqual([...actor.roles], []);
    assert.equal(actor.studentId, null);
  });
});

/**
 * 加入申请的生命周期 —— 回归测试
 *
 * ## 起因
 *
 * 使用者报：「已经成为了某个部门的成员的人在自己的我的页面为什么还能选部门」。
 *
 * 我先按字面去查，把 37 个有职务的账号逐个打开 `/me` —— **一个都没有选部门**，
 * 服务端判定是对的。但顺着这条线查到了真库里的一条脏数据：
 *
 *     #1  2599000023（吴佳琪）→ 办公室  [PENDING]
 *
 * 而**她已经是办公室的部长**。
 *
 * ## 这条申请是谁也处理不掉的
 *
 * 起因是两个操作的时间差：她先提交了加入申请，之后（在申请还没批的情况下）
 * 被任命成了部长。`insertMembership` 当时只管写职务，不管那条申请。于是：
 *
 *   · 她自己打开「我的」页看不到它 —— membershipState 先看职务，显示"办公室 / 部长"
 *   · 部门部长打开「本部门」页却看得到它，挂在「待审批的加入申请」里
 *   · 真去点「批准」，`approveJoin` 的 assertNoActiveMembership 把它挡回去
 *
 * 一条"看得见、批不动、也没人知道该怎么处理"的记录 —— 而且它**看起来
 * 就像"已经是成员的人还能选部门"**，正是使用者报的那个现象。
 *
 * ## 修法
 *
 * 代码侧：`insertMembership` 把该用户所有 PENDING 申请一并置为 `WITHDRAWN`。
 * 数据侧：迁移 014 清掉已经产生的存量脏数据。
 *
 * 这个文件守住三件事：
 *   1. 有职务的人在任何页面都不会看到"选部门"
 *   2. 拿到职务时，之前那条申请自动作废 —— 不回弹、不复活
 *   3. 操作失败时说人话，不是一句 400
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { seedReferenceData } from "../../src/db/seed.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import { dispatch, type DispatcherDeps } from "../../src/http/router.ts";
import { SessionStore, SESSION_COOKIE } from "../../src/http/session.ts";
import { PendingUploads } from "../../src/http/uploads.ts";
import { ROUTES } from "../../src/http/routes.ts";
import {
  appointChair,
  appointDeptLead,
  applyToJoin,
  approveJoin,
  bootstrapAdmin,
  getApplication,
} from "../../src/domain/membership.ts";
import { createTerm } from "../../src/domain/term.ts";
import * as m014 from "../../src/db/migrations/014_withdraw_stale_join_applications.ts";

const T0 = "2026-03-01T09:00:00.000Z";
const SECRET = "test-secret-0123456789-0123456789-0123456789";
const DEPT = 1;

const ADMIN = "teacher";
const CHAIR = "2599000008";
const HEAD = "2599000009";
const APPLICANT = "2599000012";

interface World {
  db: Db;
  clock: FixedClock;
  deps: DispatcherDeps;
}

function world(): World {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);
  const deps: DispatcherDeps = {
    db,
    clock,
    objectionSecret: SECRET,
    sessions: new SessionStore(),
    uploads: new PendingUploads(),
    dataDir: "./data",
  };

  seedReferenceData(db);

  const insertStudent = db.prepare(
    "INSERT INTO students (id, name, class_name, grade) VALUES (?, ?, '计算机2501', 2025)",
  );
  const insertUser = db.prepare(
    "INSERT INTO users (id, student_id, display_name, password_hash, must_change_password, status, created_at) VALUES (?, ?, ?, 'x', 0, 'ACTIVE', ?)",
  );

  for (const [id, name] of [
    [CHAIR, "主席甲"],
    [HEAD, "部长乙"],
    [APPLICANT, "申请人戊"],
  ] as const) {
    insertStudent.run(id, name);
    insertUser.run(id, id, name, T0);
  }
  insertUser.run(ADMIN, null, "学院老师", T0);

  bootstrapAdmin(db, ADMIN, clock);
  appointChair(db, { userId: CHAIR, by: ADMIN, clock });
  appointDeptLead(db, { userId: HEAD, departmentId: DEPT, role: "HEAD", by: ADMIN, clock });
  createTerm(db, { id: 1, name: "2026-2027秋季学期" });

  return { db, clock, deps };
}

async function get(w: World, path: string, userId: string) {
  const res = await dispatch(w.deps, ROUTES, {
    method: "GET",
    path,
    cookies: { [SESSION_COOKIE]: w.deps.sessions.create(userId, w.clock.now().getTime()).sid },
    query: {},
    body: {},
    files: [],
  });
  return {
    status: res.status,
    html: typeof res.body === "string" ? res.body : res.body.toString("utf8"),
  };
}

async function post(w: World, path: string, userId: string, body: Record<string, string> = {}) {
  const res = await dispatch(w.deps, ROUTES, {
    method: "POST",
    path,
    cookies: { [SESSION_COOKIE]: w.deps.sessions.create(userId, w.clock.now().getTime()).sid },
    query: {},
    body,
    files: [],
  });
  return {
    status: res.status,
    location: decodeURIComponent(res.headers["location"] ?? ""),
  };
}

/** 「我的」页上有没有那个选部门的下拉框 */
const hasDepartmentPicker = (html: string): boolean => html.includes('name="departmentId"');

// ---------------------------------------------------------------------------
// 1. 「我的」页只在该有的时候出现选部门
// ---------------------------------------------------------------------------

describe("「我的」页的选部门", () => {
  test("★ 什么职务都没有的学生 —— 出现，这是对的", async () => {
    const w = world();
    const res = await get(w, "/me", APPLICANT);

    assert.equal(res.status, 200);
    assert.ok(hasDepartmentPicker(res.html), "没有职务的人本来就该能申请加入");
  });

  test("★ 已经提交申请（待审批）—— 不再出现，改成说清在等谁", async () => {
    const w = world();
    applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });

    const res = await get(w, "/me", APPLICANT);
    assert.ok(!hasDepartmentPicker(res.html), "已经申请了还让人再申请一次，是让人以为上次没成功");
    assert.match(res.html, /待审批/);
  });

  test("★ 已经是干事 —— 不出现", async () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    approveJoin(w.db, { applicationId: app.id, by: HEAD, clock: w.clock });

    const res = await get(w, "/me", APPLICANT);
    assert.ok(!hasDepartmentPicker(res.html));
    assert.match(res.html, /干事/);
  });

  test("★ 已经有职务的人，在每个页面都不会看到选部门", async () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    approveJoin(w.db, { applicationId: app.id, by: HEAD, clock: w.clock });

    for (const path of ["/", "/me", "/work", "/dept", "/publicity"]) {
      const res = await get(w, path, APPLICANT);
      if (res.status !== 200) continue;
      assert.ok(
        !hasDepartmentPicker(res.html),
        `${path} 上出现了选部门 —— 这个人已经是部门 ${DEPT} 的干事了`,
      );
    }
  });

  test("转任主席之后（不属于任何部门）也不会冒出来", async () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    approveJoin(w.db, { applicationId: app.id, by: HEAD, clock: w.clock });

    // 先免职再任命主席，走真实路径
    w.db.prepare("UPDATE memberships SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL")
      .run(T0, APPLICANT);
    appointChair(w.db, { userId: APPLICANT, by: ADMIN, clock: w.clock });

    const res = await get(w, "/me", APPLICANT);
    assert.ok(!hasDepartmentPicker(res.html));
    assert.match(res.html, /主席/);
  });
});

// ---------------------------------------------------------------------------
// 2. 拿到职务时，之前那条申请必须作废
// ---------------------------------------------------------------------------

describe("拿到职务之后，之前那条加入申请", () => {
  test("★ 自动作废 —— 不能留成一条谁也处理不掉的记录", async () => {
    const w = world();
    const app = applyToJoin(w.db, {
      userId: APPLICANT,
      departmentId: DEPT,
      note: "想加入",
      clock: w.clock,
    });
    assert.equal(getApplication(w.db, app.id).status, "PENDING");

    // 申请还没批，先被任命成了主席
    appointChair(w.db, { userId: APPLICANT, by: ADMIN, clock: w.clock });

    assert.equal(
      getApplication(w.db, app.id).status,
      "WITHDRAWN",
      "不清掉的话：申请人自己看不见它，部长却看得见，还批不动",
    );
  });

  test("★ 被任命为部门负责人时同样作废", async () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });

    // 申请人换成副部长 —— 先把他从干事申请里摘出来，直接任命（此时他没有职务）
    appointDeptLead(w.db, {
      userId: APPLICANT,
      departmentId: DEPT,
      role: "DEPUTY",
      by: ADMIN,
      clock: w.clock,
    });

    assert.equal(getApplication(w.db, app.id).status, "WITHDRAWN");
  });

  test("★ 部长那边不再列出他 —— 「待审批的加入申请」必须空", async () => {
    const w = world();
    applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    appointChair(w.db, { userId: APPLICANT, by: ADMIN, clock: w.clock });

    const res = await get(w, "/dept", HEAD);
    assert.equal(res.status, 200);
    assert.ok(
      !res.html.includes(APPLICANT),
      "他已经有职务了，却还挂在「待审批的加入申请」里 —— " +
        "使用者看到的正是这个：一个已经是成员的人还在「选部门」",
    );
  });

  test("★ 部长去批一条已作废的申请：说人话，不是 400", async () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    appointChair(w.db, { userId: APPLICANT, by: ADMIN, clock: w.clock });

    const res = await post(w, `/dept/applications/${app.id}/approve`, HEAD);

    assert.equal(res.status, 303, "被拒绝时应当跳回去并说明，而不是一个没有出路的 400 错误页");
    assert.match(decodeURIComponent(res.location), /err=/);
  });

  test("★ 作废的申请不会复活 —— 免职之后也不该重新出现", async () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    appointChair(w.db, { userId: APPLICANT, by: ADMIN, clock: w.clock });

    // 免职
    w.db.prepare("UPDATE memberships SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL")
      .run(T0, APPLICANT);

    assert.equal(
      getApplication(w.db, app.id).status,
      "WITHDRAWN",
      "如果只是「暂时跳过」而不是真的作废，免职之后这条旧申请会自己冒出来",
    );

    // 他现在没有职务了，可以重新申请 —— 但那是**新的一条**
    const fresh = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    assert.notEqual(fresh.id, app.id);
    assert.equal(getApplication(w.db, fresh.id).status, "PENDING");
  });
});

// ---------------------------------------------------------------------------
// 3. 存量脏数据：迁移 014
// ---------------------------------------------------------------------------

describe("迁移 014 清掉存量的僵尸申请", () => {
  test("★ 已经有职务、申请却还挂着的，标成 WITHDRAWN", () => {
    const w = world();

    // 手工造一条"先申请、后拿到职务"的脏数据（绕过代码侧的新守卫）
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    w.db
      .prepare(
        "INSERT INTO memberships (user_id, department_id, role, appointed_by, appointed_at) VALUES (?, ?, 'HEAD', 'test', ?)",
      )
      .run(APPLICANT, DEPT, T0);
    assert.equal(getApplication(w.db, app.id).status, "PENDING", "先确认脏数据确实造出来了");

    w.db.exec(m014.sql);

    const after = getApplication(w.db, app.id);
    assert.equal(after.status, "WITHDRAWN");
    assert.equal(
      after.decidedBy,
      "system:migration-014",
      "这条记录不是人点的，就不该写成人点的",
    );
    assert.ok(after.decidedAt, "要留下处理时间");
  });

  test("★ 真的还没有职务的申请，一个字都不动", () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });

    w.db.exec(m014.sql);

    assert.equal(
      getApplication(w.db, app.id).status,
      "PENDING",
      "迁移只该清掉僵尸，不能顺手把还在等的申请也作废了",
    );
  });

  test("已批准 / 已驳回的申请不被改写", () => {
    const w = world();
    const app = applyToJoin(w.db, { userId: APPLICANT, departmentId: DEPT, note: null, clock: w.clock });
    approveJoin(w.db, { applicationId: app.id, by: HEAD, clock: w.clock });

    w.db.exec(m014.sql);

    assert.equal(getApplication(w.db, app.id).status, "APPROVED");
  });
});

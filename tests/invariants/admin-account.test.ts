/**
 * 管理员任免、账号管理、指派历史 —— 回归测试
 *
 * 这四项的领域函数从第一版就在（`grantAdmin` / `revokeAdmin` /
 * `resetPassword` / `setAccountStatus` / `assignmentHistory`），守卫也写好了，
 * **缺的全是入口**。其中两处尤其难看，因为系统已经在向人承诺它们存在：
 *
 *   · `npm run passwd` 打印的提示里写着"平时学生忘记密码由本部门部长或管理员
 *     在网页上重置" —— 那一页不存在。
 *   · 登录失败时会说"账号已被停用，请联系管理员" —— 但没有人能停用账号。
 *
 * 补入口的同时也补了三条以前**完全没有**的守卫：
 *   · 任命管理员的人自己必须是管理员（原来只靠路由层的权限动作挡）
 *   · 不能罢免自己 / 不能罢免最后一个管理员
 *   · 不能停用自己 / 不能停用最后一个还能登录的管理员
 *
 * 三条守卫防的都是同一件事：**把自己锁在门外**。那种状态下只能回服务器敲命令恢复，
 * 对一个挂在局域网里给学院用的系统，那等于停摆。
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
  bootstrapAdmin,
  grantAdmin,
  revokeAdmin,
  appointDeptLead,
  MembershipError,
} from "../../src/domain/membership.ts";
import { createTerm } from "../../src/domain/term.ts";
import { assignItem, assignmentHistory } from "../../src/domain/assignment.ts";
import { registerStudent, resetPassword, AuthError } from "../../src/auth/account.ts";

const T0 = "2026-03-01T09:00:00.000Z";
const SECRET = "test-secret-0123456789-0123456789-0123456789";
const TERM = 1;

const ADMIN = "teacher";
/** 第二个管理员，用来验证"不能罢免自己"与"不能罢免最后一个"的区别 */
const ADMIN2 = "teacher2";
const HEAD = "2599000009";
const STAFF = "2599000010";
const OUTSIDER = "2599000011";

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

  const insertUser = db.prepare(
    "INSERT INTO users (id, student_id, display_name, password_hash, must_change_password, status, created_at) VALUES (?, ?, ?, 'x', 0, 'ACTIVE', ?)",
  );
  for (const [id, name] of [
    [HEAD, "部长乙"],
    [STAFF, "干事丙"],
    [OUTSIDER, "外部门丁"],
  ] as const) {
    db.prepare(
      "INSERT INTO students (id, name, class_name, grade) VALUES (?, ?, '计算机2501', 2025)",
    ).run(id, name);
    insertUser.run(id, id, name, T0);
  }
  insertUser.run(ADMIN, null, "学院老师", T0);
  insertUser.run(ADMIN2, null, "另一位老师", T0);

  bootstrapAdmin(db, ADMIN, clock);
  appointDeptLead(db, { userId: HEAD, departmentId: 1, role: "HEAD", by: ADMIN, clock });

  // 让干事丙成为部门 1 的在任成员（干事走"申请 → 部长批"这条真实路径）
  db.prepare(
    "INSERT INTO memberships (user_id, department_id, role, appointed_by, appointed_at) VALUES (?, 1, 'MEMBER', ?, ?)",
  ).run(STAFF, HEAD, T0);

  createTerm(db, { id: TERM, name: "2026-2027秋季学期" });

  return { db, clock, deps };
}

function as(w: World, userId: string): string {
  return w.deps.sessions.create(userId, w.clock.now().getTime()).sid;
}

async function visit(w: World, path: string, userId: string) {
  const res = await dispatch(w.deps, ROUTES, {
    method: "GET",
    path,
    cookies: { [SESSION_COOKIE]: as(w, userId) },
    query: {},
    body: {},
    files: [],
  });
  return {
    status: res.status,
    html: typeof res.body === "string" ? res.body : res.body.toString("utf8"),
    location: res.headers["location"] ?? null,
  };
}

async function post(
  w: World,
  path: string,
  userId: string,
  body: Record<string, string> = {},
) {
  const res = await dispatch(w.deps, ROUTES, {
    method: "POST",
    path,
    cookies: { [SESSION_COOKIE]: as(w, userId) },
    query: {},
    body,
    files: [],
  });
  return {
    status: res.status,
    html: typeof res.body === "string" ? res.body : res.body.toString("utf8"),
    location: res.headers["location"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1. 管理员任免
// ---------------------------------------------------------------------------

describe("任命管理员", () => {
  test("★ 管理员能把别人任命为管理员", () => {
    const w = world();
    grantAdmin(w.db, ADMIN2, ADMIN, w.clock);

    const n = (
      w.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE revoked_at IS NULL").get() as {
        n: number;
      }
    ).n;
    assert.equal(n, 2);
  });

  test("★ 不是管理员的人任命不了 —— 否则它就是一条后门", () => {
    const w = world();

    assert.throws(
      () => grantAdmin(w.db, OUTSIDER, STAFF, w.clock),
      (e) => e instanceof MembershipError && e.code === "NOT_ADMIN",
      "原来这条只靠路由层的权限动作挡着，grantAdmin 本身谁调都行",
    );
  });

  test("`bootstrap` 是唯一例外：首次启动时系统里一个管理员都没有", () => {
    const db = openDatabase(":memory:");
    const clock = fixedClock(T0);
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, must_change_password, status, created_at) VALUES ('teacher', NULL, '老师', 'x', 0, 'ACTIVE', ?)",
    ).run(T0);

    assert.doesNotThrow(() => bootstrapAdmin(db, "teacher", clock));
  });

  test("★ 管理员不能兼任主席", () => {
    const w = world();
    w.db.prepare(
      "INSERT INTO memberships (user_id, department_id, role, appointed_by, appointed_at) VALUES (?, NULL, 'CHAIR', ?, ?)",
    ).run(OUTSIDER, ADMIN, T0);

    assert.throws(
      () => grantAdmin(w.db, OUTSIDER, ADMIN, w.clock),
      /主席/,
      "异议裁决要求「一位主席 + 一位管理员」双签，靠的是两个不同的账号",
    );
  });
});

describe("罢免管理员", () => {
  test("★ 不能罢免自己", () => {
    const w = world();
    grantAdmin(w.db, ADMIN2, ADMIN, w.clock);

    assert.throws(
      () => revokeAdmin(w.db, ADMIN, ADMIN, w.clock),
      (e) => e instanceof MembershipError && e.code === "CANNOT_REVOKE_SELF",
      "罢免之后你就再也进不来了",
    );
  });

  test("★ 不能罢免最后一个在任管理员", () => {
    const w = world();

    assert.throws(
      () => revokeAdmin(w.db, ADMIN, ADMIN2, w.clock),
      (e) => e instanceof MembershipError && e.code === "LAST_ADMIN",
      "关掉唯一的运营入口，系统就停摆了",
    );
  });

  test("有两个管理员时可以罢免其中一个", () => {
    const w = world();
    grantAdmin(w.db, ADMIN2, ADMIN, w.clock);

    revokeAdmin(w.db, ADMIN2, ADMIN, w.clock);

    const n = (
      w.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE revoked_at IS NULL").get() as {
        n: number;
      }
    ).n;
    assert.equal(n, 1);
  });

  test("★ 罢免留痕：记下是谁撤的", () => {
    const w = world();
    grantAdmin(w.db, ADMIN2, ADMIN, w.clock);
    revokeAdmin(w.db, ADMIN2, ADMIN, w.clock);

    const row = w.db
      .prepare("SELECT revoked_by AS by, revoked_at AS at FROM admins WHERE user_id = ?")
      .get(ADMIN2) as { by: string; at: string };

    assert.equal(row.by, ADMIN, "管理员是权限最大的身份，涉及它的每个动作都该追得到人");
    assert.ok(row.at.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 2. 网页重置密码
// ---------------------------------------------------------------------------

describe("重置他人密码", () => {
  test("★ 管理员能重置任何人的密码", () => {
    const w = world();
    const { tempPassword } = resetPassword(w.db, {
      userId: OUTSIDER,
      by: ADMIN,
      clock: w.clock,
    });

    assert.ok(tempPassword.length >= 6);
  });

  test("★ 部长只能重置本部门成员的密码", () => {
    const w = world();

    assert.doesNotThrow(() =>
      resetPassword(w.db, { userId: STAFF, by: HEAD, clock: w.clock }),
    );

    assert.throws(
      () => resetPassword(w.db, { userId: OUTSIDER, by: HEAD, clock: w.clock }),
      (e) => e instanceof AuthError && e.code === "NOT_ALLOWED_TO_RESET",
      "外部门的人不归这个部长管 —— 否则任何一个部长都能重置全院学生的密码",
    );
  });

  test("★ 重置出来的临时密码只显示一次，且不进查询串", async () => {
    const w = world();
    // STAFF 在夹具里已经有账号了 —— 直接用，这里要测的是"重置之后怎么显示"
    const res = await post(w, `/admin/accounts/${STAFF}/reset-password`, ADMIN);

    assert.equal(res.status, 200, "应当是直接渲染，不是重定向");
    assert.equal(res.location, null, "一次性密码绝不能进 Location 头");

    const shown = /font-family:monospace">\s*([A-Za-z0-9]+)\s*</.exec(res.html)?.[1];
    assert.ok(shown, "页面上必须把临时密码显示出来");
    assert.ok(
      !res.html.includes(shown.repeat(2)),
      "只显示一次 —— 页面上不该出现第二遍",
    );
  });

  test("★ 页面本身把全部账号列出来，并且提供重置入口", async () => {
    const w = world();
    const res = await visit(w, "/admin/accounts", ADMIN);

    assert.equal(res.status, 200);
    assert.match(res.html, new RegExp(`/admin/accounts/${STAFF}/reset-password`));
    assert.match(res.html, /重置密码/);
  });

  test("★ 一般学生打不开账号管理页", async () => {
    const w = world();
    const res = await visit(w, "/admin/accounts", OUTSIDER);
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------------------
// 3. 停用 / 启用
// ---------------------------------------------------------------------------

describe("停用与启用账号", () => {
  test("★ 停用之后登不进来，启用之后又能了", async () => {
    const w = world();

    const off = await post(w, `/admin/accounts/${STAFF}/status`, ADMIN, { status: "DISABLED" });
    assert.equal(off.status, 303);
    assert.equal(
      (w.db.prepare("SELECT status FROM users WHERE id = ?").get(STAFF) as { status: string })
        .status,
      "DISABLED",
    );

    const on = await post(w, `/admin/accounts/${STAFF}/status`, ADMIN, { status: "ACTIVE" });
    assert.equal(on.status, 303);
    assert.equal(
      (w.db.prepare("SELECT status FROM users WHERE id = ?").get(STAFF) as { status: string })
        .status,
      "ACTIVE",
      "停用是可逆的 —— 停用不是删除",
    );
  });

  test("★ 页面上不给自己停用的按钮", async () => {
    const w = world();
    const res = await visit(w, "/admin/accounts", ADMIN);

    assert.match(res.html, /不能停用自己/);
    assert.ok(
      !res.html.includes(`/admin/accounts/${ADMIN}/status`),
      "按钮不该出现 —— 出现了再报错，等于让人先失败一次",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 指派历史
// ---------------------------------------------------------------------------

describe("指派历史", () => {
  test("★ 改派之后旧记录留着，标成已撤销", async () => {
    const w = world();

    assignItem(w.db, {
      termId: TERM,
      itemId: 1,
      departmentId: 1,
      by: ADMIN,
      reason: null,
      clock: w.clock,
    });
    assignItem(w.db, {
      termId: TERM,
      itemId: 1,
      departmentId: 2,
      by: ADMIN,
      reason: "原部门本学期没人做",
      clock: w.clock,
    });

    const history = assignmentHistory(w.db, TERM, 1);
    assert.equal(history.length, 2, "旧指派必须留在历史里");
    assert.equal(history[0]!.revokedAt !== null, true);
    assert.equal(history[0]!.revokeReason, "原部门本学期没人做");
    assert.equal(history[1]!.revokedAt, null, "最新的那条是在任的");
  });

  test("★ 指派页上能看到这张表", async () => {
    const w = world();
    assignItem(w.db, {
      termId: TERM,
      itemId: 1,
      departmentId: 1,
      by: ADMIN,
      reason: null,
      clock: w.clock,
    });

    const res = await visit(w, "/chair/assignments", ADMIN);
    assert.equal(res.status, 200);
    assert.match(res.html, /指派历史/);
    assert.match(res.html, /在任/);
  });

  test("改派之后，历史里的旧记录显示「已撤销」", async () => {
    const w = world();
    assignItem(w.db, { termId: TERM, itemId: 1, departmentId: 1, by: ADMIN, reason: null, clock: w.clock });
    assignItem(w.db, { termId: TERM, itemId: 1, departmentId: 2, by: ADMIN, reason: "换部门", clock: w.clock });

    const res = await visit(w, "/chair/assignments", ADMIN);
    assert.match(res.html, /已撤销/);
    assert.match(res.html, /换部门/);
  });
});

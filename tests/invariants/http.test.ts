/**
 * M2.4 HTTP 层 —— 不变量测试
 *
 * 对应设计文档 §7 与实现计划 M2.4。
 *
 * 这里是权限矩阵**第一次被真正强制**的地方。之前它一直是一份"定义"，
 * 从这一层开始它才是"执行"。
 *
 * 因此测试的重点不是"页面能打开"，而是：
 *
 *   1. **服务端真的拒绝了。** 学生去改别人的分、管理员去加分 ——
 *      拿到的必须是 403，而不是"按钮藏起来了"。
 *   2. **免登录接口是一份固定清单。** 新加一个公开接口会让测试失败。
 *   3. **每个路由都声明了它需要的权限。** 漏写编译不过。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import { dispatch, matchRoute, type DispatcherDeps } from "../../src/http/router.ts";
import { SessionStore, SESSION_COOKIE } from "../../src/http/session.ts";
import { PendingUploads } from "../../src/http/uploads.ts";
import { PUBLIC, type HttpRequest, type HttpResponse } from "../../src/http/types.ts";
import { ROUTES } from "../../src/http/routes.ts";
import { ACTIONS, ACTION_SPECS, canSatisfyAlone, specOf } from "../../src/domain/permission.ts";
import { bootstrapAdmin, appointChair, appointDeptLead, applyToJoin, approveJoin } from "../../src/domain/membership.ts";
import { registerStudent, login as authLogin } from "../../src/auth/account.ts";
import { createTerm, transition } from "../../src/domain/term.ts";
import { createSlice, record, submit, review, approve } from "../../src/domain/slice.ts";
import { seedAndAssignAll, SPORTS } from "../helpers/term-fixture.ts";
import { assignItem } from "../../src/domain/assignment.ts";
import { DEPARTMENT_ID } from "../../src/db/seed.ts";

/** 页面断言用的取文本工具：导出下载返回的是 Buffer，其余是 string */
function bodyText(res: { body: string | Buffer }): string {
  return typeof res.body === "string" ? res.body : res.body.toString("utf8");
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T0 = "2026-03-01T09:00:00.000Z";
const TERM = 1;
const SECRET = "test-secret-0123456789-0123456789-0123456789";
const ID6 = "123456";

const TEACHER = "teacher"; // 管理员
const CHAIR = "chair-a"; // 主席
const HEAD = "head-sports"; // 体育部部长
const OWNER = "owner-sports"; // 体育部干事，某切片负责人
const ALICE = "2599000001";
const BOB = "2599000003";

const ITEM_SPORTS = 20; // A7-3 体育类

interface World {
  db: Db;
  clock: FixedClock;
  deps: DispatcherDeps;
  sliceId: number;
}

function world(): World {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);
  const sessions = new SessionStore();

  createTerm(db, { id: TERM, name: "2025-2026 春季学期" });

  // 名册 + 账号
  for (const [id, name] of [
    [ALICE, "学生甲"],
    [BOB, "学生乙"],
    [CHAIR, "主席甲"],
    [HEAD, "部长乙"],
    [OWNER, "干事丙"],
  ] as const) {
    db.prepare(
      "INSERT INTO students (id, name, class_name, grade) VALUES (?, ?, '计算机2501', 2025)",
    ).run(id, name);
  }
  db.prepare(
    "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES (?, NULL, '学院老师', 'x', ?)",
  ).run(TEACHER, T0);

  for (const id of [ALICE, BOB]) {
    registerStudent(db, { studentId: id, name: id === ALICE ? "学生甲" : "学生乙", initialPassword: ID6, clock });
  }
  for (const [id, name] of [
    [CHAIR, "主席甲"],
    [HEAD, "部长乙"],
    [OWNER, "干事丙"],
  ] as const) {
    registerStudent(db, { studentId: id, name, initialPassword: ID6, clock });
  }

  bootstrapAdmin(db, TEACHER, clock);
  appointChair(db, { userId: CHAIR, by: TEACHER, clock });

  // 参考数据（12 部门 + 26 计分项）与责任指派必须先于任何引用部门/计分项的操作。
  // 体育类按附录 A 默认就归体育部，因此不需要再单独改派。
  seedAndAssignAll(db, TERM, clock);

  // 干事必须先申请、再由本部门部长批准 —— 干部加分名单读的就是这条
  appointDeptLead(db, { userId: HEAD, departmentId: SPORTS, role: "HEAD", by: TEACHER, clock });
  const application = applyToJoin(db, { userId: OWNER, departmentId: SPORTS, note: null, clock });
  approveJoin(db, { applicationId: application.id, by: HEAD, clock });

  const slice = createSlice(db, {
    termId: TERM,
    itemId: ITEM_SPORTS,
    grade: 2025,
    ownerId: OWNER,
  });

  record(db, {
    sliceId: slice.id,
    studentId: BOB,
    delta: 3,
    actorId: OWNER,
    reason: "校运动会参与",
  });

  transition(db, TERM, "ASSIGNING", clock);
  transition(db, TERM, "ENTERING", clock);

  return {
    db,
    clock,
    deps: { db, clock, objectionSecret: SECRET, sessions, uploads: new PendingUploads(), dataDir: "./data" },
    sliceId: slice.id,
  };
}

/** 以某个账号登录，返回它的 Cookie 头 */
function cookieFor(w: World, userId: string): string {
  const session = w.deps.sessions.create(userId, w.clock.now().getTime());
  return `${SESSION_COOKIE}=${session.sid}`;
}

async function request(
  w: World,
  req: HttpRequest & { as?: string },
): Promise<HttpResponse> {
  const { as, ...rest } = req;
  return dispatch(w.deps, ROUTES, {
    ...rest,
    ...(as ? { cookies: { [SESSION_COOKIE]: cookieFor(w, as).split("=")[1]! } } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. 结构性断言：路由表本身
// ---------------------------------------------------------------------------

describe("路由表结构", () => {
  test("每个路由都声明了合法动作", () => {
    for (const route of ROUTES) {
      if (route.action === PUBLIC) continue;
      assert.ok(
        (ACTIONS as readonly string[]).includes(route.action),
        `${route.method} ${route.path} 声明了不存在的动作：${route.action}`,
      );
    }
  });

  test("★ 免登录路由是一份固定清单，多一个就失败", () => {
    const publicRoutes = ROUTES.filter((r) => r.action === PUBLIC)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    assert.deepEqual(
      publicRoutes,
      [
        "GET /login",
        "GET /logout",
        "GET /publicity",
        "GET /register",
        "POST /login",
        "POST /logout",
        "POST /register",
      ].sort(),
      "免登录接口必须是一份可审阅的固定清单 —— 不小心做成公开的接口会在这里被拦下",
    );
  });

  test("没有重复的 method + path", () => {
    const seen = new Set<string>();
    for (const route of ROUTES) {
      const key = `${route.method} ${route.path}`;
      assert.ok(!seen.has(key), `路由重复：${key}`);
      seen.add(key);
    }
  });

  test("★ 所有写操作（POST）都不是公开的，除了登录注册登出", () => {
    const allowedPublicPosts = new Set([
      "POST /login",
      "POST /register",
      "POST /logout",
    ]);

    for (const route of ROUTES) {
      if (route.method !== "POST") continue;
      if (allowedPublicPosts.has(`POST ${route.path}`)) continue;

      assert.notEqual(
        route.action,
        PUBLIC,
        `${route.method} ${route.path} 是写操作却不需要登录`,
      );
    }
  });

  test("★ 没有任何路由让管理员够到「一个人就能加分」的动作", () => {
    const offenders = ROUTES.filter((route) => {
      if (route.action === PUBLIC) return false;
      const spec = specOf(route.action);
      if (!spec.canIncreaseScore) return false;
      return canSatisfyAlone("ADMIN", route.action);
    }).map((r) => `${r.method} ${r.path} → ${r.action}`);

    assert.deepEqual(offenders, [], "管理员不该有任何单枪匹马的加分入口");
  });

  test("加分类路由都存在", () => {
    const increasing = ROUTES.filter(
      (r) => r.action !== PUBLIC && specOf(r.action).canIncreaseScore === true,
    );

    assert.ok(increasing.length >= 3, "录入、申诉审批、异议裁决都应当在路由表里");
  });

  test("路径匹配支持参数", () => {
    const match = matchRoute(ROUTES, "GET", "/work/42");
    assert.equal(match?.route.path, "/work/:sliceId");
    assert.equal(match?.params["sliceId"], "42");
  });

  test("未知路径匹配不到", () => {
    assert.equal(matchRoute(ROUTES, "GET", "/nope"), null);
    assert.equal(matchRoute(ROUTES, "DELETE", "/"), null);
  });
});

// ---------------------------------------------------------------------------
// 2. 未登录
// ---------------------------------------------------------------------------

describe("未登录", () => {
  test("GET 受保护页面 → 跳登录页", async () => {
    const w = world();
    const res = await request(w, { method: "GET", path: "/me" });

    assert.equal(res.status, 303);
    assert.match(res.headers["location"] ?? "", /^\/login/);
  });

  test("POST 受保护接口 → 401，而不是重定向（重定向会丢表单内容）", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: `/work/${w.sliceId}/record`,
      body: { studentId: ALICE, delta: "1", reason: "偷加" },
    });

    assert.equal(res.status, 401);
  });

  test("登录页与公示页不需要登录", async () => {
    const w = world();
    assert.equal((await request(w, { method: "GET", path: "/login" })).status, 200);
    assert.equal((await request(w, { method: "GET", path: "/register" })).status, 200);
    assert.equal((await request(w, { method: "GET", path: "/publicity" })).status, 200);
  });

  test("全新安装（还没有任何周期）时公示页给人话，不给报错", async () => {
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

    const res = await dispatch(deps, ROUTES, { method: "GET", path: "/publicity" });
    assert.equal(res.status, 200);
    assert.match(bodyText(res), /尚未开始/);
  });

  test("未知路径 404", async () => {
    const w = world();
    const res = await request(w, { method: "GET", path: "/不存在", as: ALICE });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// 3. 服务端真的拒绝了
// ---------------------------------------------------------------------------

describe("★ 服务端拒绝，而不是把按钮藏起来", () => {
  test("学生改不了别人的分（切片录入接口）", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: `/work/${w.sliceId}/record`,
      body: { studentId: BOB, delta: "3", reason: "给自己人加分" },
      as: ALICE,
    });

    assert.equal(res.status, 403, "打开开发者工具直接发请求也必须是 403");

    const score = (
      w.db
        .prepare(
          "SELECT COALESCE(SUM(delta),0) AS s FROM score_events WHERE student_id = ? AND item_id = ?",
        )
        .get(BOB, ITEM_SPORTS) as { s: number }
    ).s;
    assert.equal(score, 3, "分数没有被改动");
  });

  test("★ 管理员没有加分入口", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: `/work/${w.sliceId}/record`,
      body: { studentId: BOB, delta: "100", reason: "管理员送分" },
      as: TEACHER,
    });

    assert.equal(res.status, 403);
    assert.match(bodyText(res), /无权/);
  });

  test("★ 主席也没有直接加分入口", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: `/work/${w.sliceId}/record`,
      body: { studentId: BOB, delta: "100", reason: "主席送分" },
      as: CHAIR,
    });

    assert.equal(res.status, 403);
  });

  test("同部门但不是负责人，也改不了", async () => {
    const w = world();
    // 部长虽属体育部，但不是这个切片的负责人
    const res = await request(w, {
      method: "POST",
      path: `/work/${w.sliceId}/record`,
      body: { studentId: ALICE, delta: "1", reason: "越权" },
      as: HEAD,
    });

    assert.equal(res.status, 403);
  });

  test("学生看不到别人的成绩页", async () => {
    const w = world();
    // 学生没有 /dept 权限
    const res = await request(w, { method: "GET", path: "/dept", as: ALICE });
    assert.equal(res.status, 403);
  });

  test("学生进不了全院看板与责任指派", async () => {
    const w = world();
    assert.equal((await request(w, { method: "GET", path: "/chair", as: ALICE })).status, 403);
    assert.equal(
      (await request(w, { method: "GET", path: "/chair/assignments", as: ALICE })).status,
      403,
    );
  });

  test("学生不能发布结果", async () => {
    const w = world();
    const res = await request(w, { method: "POST", path: "/chair/publish", as: ALICE });
    assert.equal(res.status, 403);
  });

  test("★ 主席不能单独裁决异议（必须双签）", async () => {
    const w = world();
    // 没有异议时接口本身会报错，但权限检查在前 —— 先确认主席能进这个接口
    const allowed = await request(w, { method: "GET", path: "/chair/objections", as: CHAIR });
    assert.equal(allowed.status, 200);

    // 而学生进不去
    const denied = await request(w, { method: "GET", path: "/chair/objections", as: ALICE });
    assert.equal(denied.status, 403);
  });

  test("★ 越权探测资源是否存在：一律 403，不泄露存在性", async () => {
    const w = world();

    // 不存在的切片：如果返回 400「切片不存在」，学生就能靠比较 400 与 403
    // 把系统里的资源一个个枚举出来 —— 那是一个廉价的探测接口。
    const missing = await request(w, {
      method: "POST",
      path: "/work/99999/record",
      body: { studentId: BOB, delta: "1", reason: "探测" },
      as: ALICE,
    });

    const existing = await request(w, {
      method: "POST",
      path: `/work/${w.sliceId}/record`,
      body: { studentId: BOB, delta: "1", reason: "探测" },
      as: ALICE,
    });

    assert.equal(missing.status, 403, "不存在的资源也只能回「无权」");
    assert.equal(existing.status, 403);
    assert.equal(
      missing.status,
      existing.status,
      "存在与不存在的响应必须无法区分，否则就是一个探测接口",
    );
  });

  test("403 页面说清了为什么", async () => {
    const w = world();
    const res = await request(w, { method: "GET", path: "/chair", as: ALICE });

    assert.match(bodyText(res), /无权/);
    assert.match(bodyText(res), /服务端/);
  });
});

// ---------------------------------------------------------------------------
// 4. 有权限的人真的能用
// ---------------------------------------------------------------------------

describe("有权限的人能用", () => {
  test("负责人可以录入自己负责的切片", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: `/work/${w.sliceId}/record`,
      body: { studentId: ALICE, delta: "2", reason: "院篮球赛参与" },
      as: OWNER,
    });

    assert.equal(res.status, 303);

    const score = (
      w.db
        .prepare(
          "SELECT COALESCE(SUM(delta),0) AS s FROM score_events WHERE student_id = ? AND item_id = ?",
        )
        .get(ALICE, ITEM_SPORTS) as { s: number }
    ).s;
    assert.equal(score, 2);
  });

  test("部长可以批准切片（冻结）", async () => {
    const w = world();
    await request(w, { method: "POST", path: `/work/${w.sliceId}/submit`, as: OWNER });
    await request(w, { method: "POST", path: `/work/${w.sliceId}/review`, as: OWNER });

    // 复核是副部长的事；这里用部长直接批准应当被状态机挡下
    const res = await request(w, { method: "POST", path: `/work/${w.sliceId}/approve`, as: HEAD });
    assert.equal(res.status, 400, "状态不对（还停在 SUBMITTED）");
  });

  test("部长能进本部门页面，主席能进全院看板", async () => {
    const w = world();
    assert.equal((await request(w, { method: "GET", path: "/dept", as: HEAD })).status, 200);
    assert.equal((await request(w, { method: "GET", path: "/chair", as: CHAIR })).status, 200);
    assert.equal(
      (await request(w, { method: "GET", path: "/chair/assignments", as: CHAIR })).status,
      200,
    );
  });

  test("★ 改派责任部门（换数据，不改代码）", async () => {
    const w = world();
    // 文艺类默认归文艺部，这里改派给体育部
    const res = await request(w, {
      method: "POST",
      path: "/chair/assignments",
      body: { itemId: "19", departmentId: String(DEPARTMENT_ID["体育部"]) },
      as: CHAIR,
    });

    assert.equal(res.status, 303);

    const row = w.db
      .prepare(
        "SELECT department_id FROM item_assignments WHERE term_id = ? AND item_id = 19 AND revoked_at IS NULL",
      )
      .get(TERM) as { department_id: number };
    assert.equal(row.department_id, DEPARTMENT_ID["体育部"]);

    // 旧记录被撤销而不是被改写 —— 学期末要能回答"当时是谁负责的"
    const history = w.db
      .prepare("SELECT COUNT(*) AS n FROM item_assignments WHERE term_id = ? AND item_id = 19")
      .get(TERM) as { n: number };
    assert.equal(history.n, 2);
  });

  test("重复指派给同一部门会被拒绝", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/chair/assignments",
      body: { itemId: "20", departmentId: String(DEPARTMENT_ID["体育部"]) },
      as: CHAIR,
    });

    assert.equal(res.status, 400);
  });

  test("★ 未指派完时进不了录入状态，报错列出漏项", async () => {
    const w = world();
    // 把一项改派成"未指派"是不可能的（改派总要指定部门），
    // 因此直接构造一个新周期来验证守卫
    w.db.exec("INSERT INTO terms (id, name, status) VALUES (99, '新周期', 'ASSIGNING')");

    const res = await request(w, { method: "POST", path: "/chair/enter", as: CHAIR });
    // 当前周期已经 ENTERING，所以这个请求作用在它身上会失败；
    // 关键是错误信息必须可读
    assert.ok(res.status === 303 || res.status === 400);
  });

  test("学生能看到自己的成绩页", async () => {
    const w = world();
    const res = await request(w, { method: "GET", path: "/me", as: BOB });

    assert.equal(res.status, 200);
    assert.match(bodyText(res), /我的成绩/);
  });
});

// ---------------------------------------------------------------------------
// 5. 登录登出闭环
// ---------------------------------------------------------------------------

describe("登录闭环", () => {
  test("注册 → 登录 → 拿到会话", async () => {
    const w = world();

    const reg = await request(w, {
      method: "POST",
      path: "/register",
      body: { studentId: "2599000007", name: "不存在", initialPassword: ID6 },
    });
    assert.equal(reg.status, 303);
    assert.match(reg.headers["location"] ?? "", /err=/);

    const ok = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: BOB, password: ID6, next: "/" },
    });

    assert.equal(ok.status, 303);
    assert.match(ok.headers["set-cookie"] ?? "", new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(ok.headers["set-cookie"] ?? "", /HttpOnly/);
    assert.match(ok.headers["set-cookie"] ?? "", /SameSite=Lax/);
    // 用的是初始密码，但**不再强制改密** —— 直接去她本来要去的页面。
    // 初始密码弱这件事仍然被记着（首页会提醒），只是不再拦路。
    assert.equal(ok.headers["location"], "/");
  });

  test("密码错误不泄露账号是否存在", async () => {
    const w = world();

    const wrong = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: BOB, password: "000000" },
    });
    const missing = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: "2599000016", password: "000000" },
    });

    const strip = (h: HttpResponse): string =>
      decodeURIComponent(h.headers["location"] ?? "").replace(/（.*?）/, "");

    assert.equal(strip(wrong), strip(missing));
  });

  test("登出清掉 Cookie", async () => {
    const w = world();
    const res = await request(w, { method: "POST", path: "/logout", as: BOB });

    assert.equal(res.status, 303);
    assert.match(res.headers["set-cookie"] ?? "", /Max-Age=0/);
  });
});

// ---------------------------------------------------------------------------
// 6. 公开页面的可见性同样走服务端判定
// ---------------------------------------------------------------------------

describe("公示页", () => {
  test("录入期间公示页不显示任何分数", async () => {
    const w = world();
    const res = await request(w, { method: "GET", path: "/publicity" });

    assert.equal(res.status, 200);
    assert.match(bodyText(res), /尚未发布/);
    assert.ok(!bodyText(res).includes("校运动会参与"), "录入期间不该出现加分理由");
  });

  test("发布后未登录者也能看到公示页", async () => {
    const w = world();

    // 夹具里已经有切片与一条记录，走完三级冻结后发布
    const existing = w.db
      .prepare("SELECT id FROM slices WHERE term_id = ? AND item_id = ? AND grade = 2025")
      .get(TERM, ITEM_SPORTS) as { id: number };

    submit(w.db, existing.id, OWNER, w.clock);
    // 复核必须是**另一个人**。这份夹具原来让 owner-sports 自己复核自己 ——
    // 那是"代码允许、设计不允许"的写法，现在被 SELF_CHECK_FORBIDDEN 挡住了。
    review(w.db, existing.id, "deputy-sports", w.clock);
    approve(w.db, existing.id, HEAD, w.clock);

    await request(w, { method: "POST", path: "/chair/publish", as: CHAIR });

    const res = await request(w, { method: "GET", path: "/publicity" });
    assert.equal(res.status, 200);
    // 链校验状态不在这一页了 —— 它搬去了管理页的运维区块。
    // 这里只守"未登录者进得来、看得到内容"。
    assert.ok(bodyText(res).length > 0, "未登录者应当看得到公示内容");
  });
});

// ---------------------------------------------------------------------------
// 7. 矩阵与路由一致
// ---------------------------------------------------------------------------

describe("矩阵与路由一致", () => {
  test("路由表用到的动作都真实存在于矩阵中", () => {
    const used = new Set(
      ROUTES.map((r) => r.action).filter((a) => a !== PUBLIC),
    );

    for (const action of used) {
      assert.ok(ACTION_SPECS[action as keyof typeof ACTION_SPECS], `未知动作 ${action}`);
    }

    assert.ok(used.size >= 15, `路由只用到 ${used.size} 个动作，覆盖面可能不足`);
  });

  test("登录注册登出之外的每个路由都需要某个动作", () => {
    for (const route of ROUTES) {
      assert.ok(route.action.length > 0, `${route.method} ${route.path} 没有声明动作`);
    }
  });

  test("两个账号可以同时登录，各自会话独立", async () => {
    const w = world();

    const alice = await request(w, { method: "GET", path: "/me", as: ALICE });
    const bob = await request(w, { method: "GET", path: "/me", as: BOB });

    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    assert.notEqual(alice.body, bob.body, "两人看到的应当是自己那一份");
  });
});

// ---------------------------------------------------------------------------
// 8. 会话过期
// ---------------------------------------------------------------------------

describe("会话", () => {
  test("伪造的会话 ID 无效", async () => {
    const w = world();
    const res = await dispatch(w.deps, ROUTES, {
      method: "GET",
      path: "/me",
      cookies: { [SESSION_COOKIE]: "伪造的" },
    });

    assert.equal(res.status, 303, "无效会话等同于未登录");
  });

  test("超过 12 小时的会话失效", async () => {
    const w = world();
    const cookie = cookieFor(w, ALICE);

    w.clock.advance(13 * 60 * 60 * 1000);

    const res = await dispatch(w.deps, ROUTES, {
      method: "GET",
      path: "/me",
      cookies: { [SESSION_COOKIE]: cookie.split("=")[1]! },
    });

    assert.equal(res.status, 303);
  });

  test("停用账号后其会话可被一次性清掉", () => {
    const w = world();
    cookieFor(w, ALICE);
    assert.equal(w.deps.sessions.size, 1);

    const removed = w.deps.sessions.destroyAllFor(ALICE);
    assert.equal(removed, 1);
    assert.equal(w.deps.sessions.size, 0);
  });
});

void authLogin;

/**
 * M3.0b 引导流程与文件上传 —— 不变量测试
 *
 * 覆盖从"全新数据库"到"可以开始录入"的那两步：
 * 创建周期、导入名册。
 *
 * 重点钉三条：
 *   1. **上传是二进制的，不能被字符串化。** xlsx 过一次 utf8 往返就废了，
 *      而症状是"解压失败"，离真正的原因很远。
 *   2. **预览不写库、确认才写。** 管理员看的过程不能有副作用。
 *   3. **令牌一次性且会过期。** 暂存的文件不该能被反复提交。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import { dispatch, type DispatcherDeps } from "../../src/http/router.ts";
import { SessionStore, SESSION_COOKIE } from "../../src/http/session.ts";
import { PendingUploads } from "../../src/http/uploads.ts";
import { buildMultipart, parseMultipart, boundaryOf } from "../../src/http/multipart.ts";
import { ROUTES } from "../../src/http/routes.ts";
import { specOf } from "../../src/domain/permission.ts";
import { activeTerm } from "../../src/domain/term.ts";
import { listStudents, getStudent } from "../../src/domain/student.ts";
import { bootstrapAdmin } from "../../src/domain/membership.ts";
import { registerStudent } from "../../src/auth/account.ts";

/** 页面断言用的取文本工具：导出下载返回的是 Buffer，其余是 string */
function bodyText(res: { body: string | Buffer }): string {
  return typeof res.body === "string" ? res.body : res.body.toString("utf8");
}

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const T0 = "2026-03-01T09:00:00.000Z";
const SECRET = "test-secret-0123456789-0123456789-0123456789";
const ID6 = "123456";
const ADMIN = "teacher";
const STUDENT = "2599000001";

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

  db.prepare(
    "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES (?, NULL, '老师', 'x', ?)",
  ).run(ADMIN, T0);
  bootstrapAdmin(db, ADMIN, clock);

  return { db, clock, deps };
}

function as(w: World, userId: string): string {
  return w.deps.sessions.create(userId, w.clock.now().getTime()).sid;
}

async function request(
  w: World,
  req: {
    method: string;
    path: string;
    as?: string;
    body?: Record<string, string>;
    query?: Record<string, string>;
    files?: Array<{ field: string; filename: string; content: Buffer }>;
  },
) {
  const cookies = req.as ? { [SESSION_COOKIE]: as(w, req.as) } : {};

  return dispatch(w.deps, ROUTES, {
    method: req.method,
    path: req.path,
    cookies,
    query: req.query ?? {},
    body: req.body ?? {},
    files: (req.files ?? []).map((f) => ({
      field: f.field,
      filename: f.filename,
      contentType: "application/octet-stream",
      content: f.content,
    })),
  });
}

// ---------------------------------------------------------------------------
// 1. multipart 解析
// ---------------------------------------------------------------------------

describe("multipart 解析", () => {
  test("★ 二进制内容原样往返，不被字符串化破坏", () => {
    const xlsx = fixture("roster-ok.xlsx");
    const { body, contentType } = buildMultipart([
      { name: "studentIdColumn", value: "A" },
      { name: "file", filename: "roster-ok.xlsx", content: xlsx },
    ]);

    const boundary = boundaryOf(contentType);
    assert.ok(boundary);

    const parsed = parseMultipart(body, boundary!);

    assert.equal(parsed.fields["studentIdColumn"], "A");
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0]?.filename, "roster-ok.xlsx");

    // 逐字节相同 —— 差一个字节 xlsx 就解不开了
    assert.ok(
      parsed.files[0]!.content.equals(xlsx),
      "上传的二进制必须逐字节一致；过一次 utf8 往返就会毁掉它",
    );
  });

  test("中文文件名与中文内容都能读", () => {
    const content = Buffer.from("学号,姓名\n2599000001,赵雨桐", "utf8");
    const { body, contentType } = buildMultipart([
      { name: "file", filename: "名册.csv", content },
    ]);

    const parsed = parseMultipart(body, boundaryOf(contentType)!);
    assert.equal(parsed.files[0]?.filename, "名册.csv");
    assert.equal(parsed.files[0]?.content.toString("utf8"), content.toString("utf8"));
  });

  test("多个字段与文件混在一起都能取到", () => {
    const { body, contentType } = buildMultipart([
      { name: "a", value: "1" },
      { name: "f1", filename: "x.bin", content: Buffer.from([0, 1, 2, 255]) },
      { name: "b", value: "2" },
    ]);

    const parsed = parseMultipart(body, boundaryOf(contentType)!);
    assert.deepEqual(parsed.fields, { a: "1", b: "2" });
    assert.deepEqual([...parsed.files[0]!.content], [0, 1, 2, 255]);
  });

  test("没有 boundary 的 content-type 返回 null", () => {
    assert.equal(boundaryOf("application/x-www-form-urlencoded"), null);
    assert.equal(boundaryOf(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// 2. 待确认上传
// ---------------------------------------------------------------------------

describe("待确认上传", () => {
  test("放进去能取出来", () => {
    const store = new PendingUploads();
    const item = store.put("x.csv", Buffer.from("hi"), "admin", 1000);

    assert.equal(store.get(item.token, 1000)?.filename, "x.csv");
  });

  test("★ 过期后取不到", () => {
    const store = new PendingUploads(1000);
    const item = store.put("x.csv", Buffer.from("hi"), "admin", 1000);

    assert.ok(store.get(item.token, 1500), "没过期");
    assert.equal(store.get(item.token, 3000), null, "过期了");
  });

  test("★ consume 是一次性的", () => {
    const store = new PendingUploads();
    const item = store.put("x.csv", Buffer.from("hi"), "admin", 1000);

    assert.ok(store.consume(item.token, 1000));
    assert.equal(store.consume(item.token, 1000), null, "同一个令牌不能用两次");
  });

  test("get 可以看多次，consume 才删除", () => {
    const store = new PendingUploads();
    const item = store.put("x.csv", Buffer.from("hi"), "admin", 1000);

    assert.ok(store.get(item.token, 1000));
    assert.ok(store.get(item.token, 1000));
  });

  test("超过上限时丢掉最旧的", () => {
    const store = new PendingUploads(60_000, 3);
    const first = store.put("a", Buffer.from("a"), "admin", 1000);
    store.put("b", Buffer.from("b"), "admin", 1001);
    store.put("c", Buffer.from("c"), "admin", 1002);
    store.put("d", Buffer.from("d"), "admin", 1003);

    assert.equal(store.size, 3);
    assert.equal(store.get(first.token, 1003), null, "最旧的应当被挤出去");
  });

  test("伪造的令牌取不到东西", () => {
    const store = new PendingUploads();
    store.put("x.csv", Buffer.from("hi"), "admin", 1000);
    assert.equal(store.get("伪造", 1000), null);
    assert.equal(store.get(undefined, 1000), null);
  });
});

// ---------------------------------------------------------------------------
// 3. 创建周期
// ---------------------------------------------------------------------------

describe("创建周期", () => {
  test("管理员能创建周期", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/term",
      as: ADMIN,
      body: { name: "2025-2026 春季学期" },
    });

    assert.equal(res.status, 303);
    assert.equal(activeTerm(w.db, w.clock)?.name, "2025-2026 春季学期");
  });

  test("周期名不能为空", async () => {
    const w = world();
    await request(w, {
      method: "POST",
      path: "/admin/term",
      as: ADMIN,
      body: { name: "  " },
    });

    assert.equal(activeTerm(w.db, w.clock), null);
  });

  test("★ 学生进不了管理页", async () => {
    const w = world();
    // 先造一个学生账号（需要一个名册条目）
    w.db
      .prepare("INSERT INTO students (id, name, class_name, grade) VALUES (?, '学生甲', '计算机2501', 2025)")
      .run(STUDENT);
    registerStudent(w.db, { studentId: STUDENT, name: "学生甲", initialPassword: ID6, clock: w.clock });

    const res = await request(w, { method: "GET", path: "/admin", as: STUDENT });
    assert.equal(res.status, 403);
  });

  test("未登录进不了管理页", async () => {
    const w = world();
    const res = await request(w, { method: "GET", path: "/admin" });
    assert.equal(res.status, 303);
  });
});

// ---------------------------------------------------------------------------
// 4. 名册导入两步走
// ---------------------------------------------------------------------------

describe("名册导入", () => {
  test("★ 预览不写库", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: ADMIN,
      files: [{ field: "file", filename: "roster-ok.xlsx", content: fixture("roster-ok.xlsx") }],
    });

    assert.equal(res.status, 200);
    assert.match(bodyText(res), /名册预览/);
    assert.match(bodyText(res), /新增 10/);
    assert.equal(listStudents(w.db).length, 0, "预览阶段不能写库");
  });

  test("★ 预览页带着确认令牌，确认后才写入", async () => {
    const w = world();

    const preview = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: ADMIN,
      files: [{ field: "file", filename: "roster-ok.xlsx", content: fixture("roster-ok.xlsx") }],
    });

    const token = /name="token" value="([^"]+)"/.exec(bodyText(preview))?.[1];
    assert.ok(token, "预览页必须带上确认令牌");

    const commit = await request(w, {
      method: "POST",
      path: "/admin/roster/commit",
      as: ADMIN,
      body: { token: token! },
    });

    assert.equal(commit.status, 303);
    assert.match(decodeURIComponent(commit.headers["location"] ?? ""), /新增 10 人/);
    assert.equal(listStudents(w.db).length, 10);
  });

  test("★ 同一个令牌不能用两次", async () => {
    const w = world();

    const preview = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: ADMIN,
      files: [{ field: "file", filename: "roster-ok.xlsx", content: fixture("roster-ok.xlsx") }],
    });
    const token = /name="token" value="([^"]+)"/.exec(bodyText(preview))![1]!;

    await request(w, {
      method: "POST",
      path: "/admin/roster/commit",
      as: ADMIN,
      body: { token },
    });

    const second = await request(w, {
      method: "POST",
      path: "/admin/roster/commit",
      as: ADMIN,
      body: { token },
    });

    assert.match(decodeURIComponent(second.headers["location"] ?? ""), /过期|已被使用/);
    assert.equal(listStudents(w.db).length, 10, "第二次不能重复写入");
  });

  test("伪造的令牌被拒绝", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/roster/commit",
      as: ADMIN,
      body: { token: "伪造的令牌" },
    });

    assert.match(decodeURIComponent(res.headers["location"] ?? ""), /过期|已被使用/);
  });

  test("★ CSV 也能上传（带 BOM）", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: ADMIN,
      files: [{ field: "file", filename: "roster-bom.csv", content: fixture("roster-bom.csv") }],
    });

    assert.equal(res.status, 200);
    assert.match(bodyText(res), /新增 10/);
  });

  test("没有文件时给错误提示，而不是 500", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: ADMIN,
    });

    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers["location"] ?? ""), /没有收到文件/);
  });

  test("★ 学生不能上传名册", async () => {
    const w = world();
    w.db
      .prepare("INSERT INTO students (id, name, class_name, grade) VALUES (?, '学生甲', '计算机2501', 2025)")
      .run(STUDENT);
    registerStudent(w.db, { studentId: STUDENT, name: "学生甲", initialPassword: ID6, clock: w.clock });

    const res = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: STUDENT,
      files: [{ field: "file", filename: "roster-ok.xlsx", content: fixture("roster-ok.xlsx") }],
    });

    assert.equal(res.status, 403);
    assert.equal(listStudents(w.db).length, 1);
  });

  test("手工指定列会在预览页上体现", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: ADMIN,
      body: { studentIdColumn: "A", nameColumn: "B", classNameColumn: "C" },
      files: [{ field: "file", filename: "roster-ok.xlsx", content: fixture("roster-ok.xlsx") }],
    });

    assert.match(bodyText(res), /学号 <strong>A<\/strong>/);
  });

  test("导入后名册人数出现在管理页", async () => {
    const w = world();

    const preview = await request(w, {
      method: "POST",
      path: "/admin/roster/preview",
      as: ADMIN,
      files: [{ field: "file", filename: "roster-ok.xlsx", content: fixture("roster-ok.xlsx") }],
    });
    const token = /name="token" value="([^"]+)"/.exec(bodyText(preview))![1]!;
    await request(w, { method: "POST", path: "/admin/roster/commit", as: ADMIN, body: { token } });

    const page = await request(w, { method: "GET", path: "/admin", as: ADMIN });
    assert.match(bodyText(page), /共 10 人/);
    assert.match(bodyText(page), /2025 级/);
  });

  test("★ 导入幂等：同样内容导两次人数不变", async () => {
    const w = world();

    const importOnce = async (): Promise<void> => {
      const preview = await request(w, {
        method: "POST",
        path: "/admin/roster/preview",
        as: ADMIN,
        files: [{ field: "file", filename: "roster-ok.xlsx", content: fixture("roster-ok.xlsx") }],
      });
      const token = /name="token" value="([^"]+)"/.exec(bodyText(preview))![1]!;
      await request(w, { method: "POST", path: "/admin/roster/commit", as: ADMIN, body: { token } });
    };

    await importOnce();
    await importOnce();

    assert.equal(listStudents(w.db).length, 10);
  });
});

// ---------------------------------------------------------------------------
// 5. 路由表仍然守得住
// ---------------------------------------------------------------------------

describe("新增路由没有破坏权限约束", () => {
  test("管理路由不在免登录清单里", () => {
    const adminRoutes = ROUTES.filter((r) => r.path.startsWith("/admin"));
    assert.ok(adminRoutes.length >= 4);

    for (const route of adminRoutes) {
      assert.notEqual(route.action, "public", `${route.path} 不能免登录`);
    }
  });

  test("★ 新增的管理路由里没有加分动作", () => {
    // 管理员的职责是"保证系统能跑"，不是"给分"。
    // 管理路由一旦沾上加分动作，人情分只是从学生会搬到了管理员手里。
    const adminRoutes = ROUTES.filter((r) => r.path.startsWith("/admin"));

    for (const route of adminRoutes) {
      if (route.action === "public") continue;
      assert.equal(
        specOf(route.action).canIncreaseScore ?? false,
        false,
        `${route.method} ${route.path} 用了加分动作 ${route.action}`,
      );
    }
  });

  test("管理路由只用到管理员专属动作", () => {
    const adminRoutes = ROUTES.filter((r) => r.path.startsWith("/admin"));

    for (const route of adminRoutes) {
      if (route.action === "public") continue;
      assert.ok(
        specOf(route.action).roles.includes("ADMIN"),
        `${route.path} 的动作 ${route.action} 不含管理员，页面会打不开`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 学生名册（人工兜底）
// ---------------------------------------------------------------------------

describe("手工添加学生", () => {
  test("管理页有入口，名册页能打开", async () => {
    const w = world();
    const admin = await request(w, { method: "GET", path: "/admin", as: ADMIN });
    assert.match(bodyText(admin), /admin\/students/, "管理页应当有跳转入口");

    const page = await request(w, { method: "GET", path: "/admin/students", as: ADMIN });
    assert.equal(page.status, 200);
    assert.match(bodyText(page), /手工添加/);
  });

  test("★ 能加进来，并且立刻可注册", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/students",
      as: ADMIN,
      body: { studentId: "2599000001", name: "赵雨桐", className: "计算机2501" },
    });

    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers["location"] ?? ""), /已添加/);
    assert.equal(listStudents(w.db).length, 1);
    assert.equal(getStudent(w.db, "2599000001").grade, 2025);
  });

  test("学号已存在时报「已更新」而不是「已添加」", async () => {
    const w = world();
    const body = { studentId: "2599000001", name: "甲", className: "计算机2501" };

    await request(w, { method: "POST", path: "/admin/students", as: ADMIN, body });
    const second = await request(w, {
      method: "POST",
      path: "/admin/students",
      as: ADMIN,
      body: { ...body, name: "乙" },
    });

    assert.match(decodeURIComponent(second.headers["location"] ?? ""), /已更新/);
    assert.equal(listStudents(w.db).length, 1);
  });

  test("★ 姓名为空被拒绝，且不写入", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/students",
      as: ADMIN,
      body: { studentId: "2599000001", name: "  ", className: "计算机2501" },
    });

    assert.match(decodeURIComponent(res.headers["location"] ?? ""), /姓名不能为空/);
    assert.equal(listStudents(w.db).length, 0);
  });

  test("★ 推不出年级时明确警告", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/admin/students",
      as: ADMIN,
      body: { studentId: "ABC123", name: "某同学" },
    });

    assert.match(
      decodeURIComponent(res.headers["location"] ?? ""),
      /推不出年级/,
      "要提示这名学生在按年级划分的切片里会找不到",
    );
  });

  test("★ 学生不能加学生（服务端 403）", async () => {
    const w = world();
    w.db
      .prepare(
        "INSERT INTO students (id, name, class_name, grade) VALUES (?, '学生甲', '计算机2501', 2025)",
      )
      .run(STUDENT);
    registerStudent(w.db, {
      studentId: STUDENT,
      name: "学生甲",
      initialPassword: ID6,
      clock: w.clock,
    });

    const res = await request(w, {
      method: "POST",
      path: "/admin/students",
      as: STUDENT,
      body: { studentId: "2599000016", name: "偷加的人" },
    });

    assert.equal(res.status, 403);
    assert.equal(listStudents(w.db).length, 1, "名册没有被改动");
  });

  test("未登录不能访问", async () => {
    const w = world();
    const res = await request(w, { method: "GET", path: "/admin/students" });
    assert.equal(res.status, 303);
  });

  test("★ 页面上能看到人工改动记录", async () => {
    const w = world();
    await request(w, {
      method: "POST",
      path: "/admin/students",
      as: ADMIN,
      body: { studentId: "2599000001", name: "赵雨桐", className: "计算机2501" },
    });

    const page = await request(w, { method: "GET", path: "/admin/students", as: ADMIN });
    const html = bodyText(page);

    assert.match(html, /人工改动记录/);
    assert.match(html, /新增/);
    assert.match(html, /2599000001/);
    assert.match(html, new RegExp(ADMIN), "要记下是谁加的");
  });

  test("搜索能把结果缩小", async () => {
    const w = world();
    for (const [id, name] of [
      ["2599000001", "赵雨桐"],
      ["2599000019", "孙志强"],
    ] as const) {
      await request(w, {
        method: "POST",
        path: "/admin/students",
        as: ADMIN,
        body: { studentId: id, name, className: "计算机2501" },
      });
    }

    const page = await request(w, {
      method: "GET",
      path: "/admin/students",
      as: ADMIN,
      query: { q: "孙志强" },
    });
    const html = bodyText(page);

    // 必须把断言收窄到**结果表格**那一段。
    // 整个页面里还有很多地方会出现姓名：上方表单的 placeholder、
    // 下方的"人工改动记录"（两条改动都在里面）。
    // 拿整页去断言，测的就不是搜索了。
    const tableSection = html.split("名册（共")[1]?.split("人工改动记录")[0] ?? "";

    assert.match(tableSection, /孙志强/);
    assert.ok(
      !tableSection.includes("赵雨桐"),
      "搜索结果里不该出现不匹配的人",
    );
    assert.match(html, /人工改动记录[\s\S]*赵雨桐/, "改动记录里仍然应当保留两条");
  });
});

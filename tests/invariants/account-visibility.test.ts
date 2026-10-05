/**
 * "我的账号还在吗" —— 回归测试
 *
 * 这个文件来自一次真实的困惑：数据库里 `teacher` 好端端地当着管理员，
 * 但使用者却在问"怎么没有 teacher 帐号了"。
 *
 * 库没问题，代码也没崩。问题是**这个系统从不把"账号存在"这件事显示出来**：
 *
 *   1. 登录框标签写"学号"，还带 `inputmode="numeric"` ——
 *      `teacher` 根本不是学号，手机上那个数字键盘连字母都打不出来。
 *   2. 登录页只说"第一次使用请先注册"，只字不提管理员账号。
 *   3. 输错了报"学号或密码不正确" —— 又一次把人往"我是不是没这个账号"上引。
 *   4. 想重建账号，`admin:init` 拒绝执行，而拒绝的话里**没有** `passwd`。
 *   5. 重启服务时不报任何账号信息：屏幕上没有消息，而这既可能是
 *      "账号好好的"，也可能是"这段代码没跑到"。
 *
 * 前四条在这里钉死；第五条在 smoke 里验。
 *
 * 贯穿的一条：**失败必须看得见**。一个"账号明明在、却让人以为没了"的
 * 系统，和一个真的丢了账号的系统，对使用者的效果是一样的。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import { dispatch, type DispatcherDeps } from "../../src/http/router.ts";
import { SessionStore, SESSION_COOKIE } from "../../src/http/session.ts";
import { PendingUploads } from "../../src/http/uploads.ts";
import { ROUTES } from "../../src/http/routes.ts";
import { loginPage, registerPage } from "../../src/http/views.ts";
import { bootstrapAdmin, grantAdmin } from "../../src/domain/membership.ts";
import { getAccount, resetPasswordOffline } from "../../src/auth/account.ts";
import { createFirstAdmin } from "../../src/cli/admin.ts";
import { accountBanner } from "../../src/cli/serve.ts";

const T0 = "2026-03-01T09:00:00.000Z";
const SECRET = "test-secret-0123456789-0123456789-0123456789";
const ADMIN = "teacher";
const ADMIN_NAME = "郑晓明";

function bodyText(res: { body: string | Buffer }): string {
  return typeof res.body === "string" ? res.body : res.body.toString("utf8");
}

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
    "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES (?, NULL, ?, 'x', ?)",
  ).run(ADMIN, ADMIN_NAME, T0);
  bootstrapAdmin(db, ADMIN, clock);
  resetPasswordOffline(db, { userId: ADMIN, newPassword: "wang-pass-2026", clock });

  return { db, clock, deps };
}

async function request(
  w: World,
  req: { method: string; path: string; body?: Record<string, string>; cookies?: Record<string, string> },
) {
  return dispatch(w.deps, ROUTES, {
    method: req.method,
    path: req.path,
    cookies: req.cookies ?? {},
    query: {},
    body: req.body ?? {},
    files: [],
  });
}

// ---------------------------------------------------------------------------
// 1. 登录框必须能装下 "teacher"
// ---------------------------------------------------------------------------

describe("登录框能装下非学号的账号", () => {
  test("★ 账号字段不能是数字键盘 —— 手机上会打不出 teacher", () => {
    const html = loginPage({ next: "/" });

    const field = /<input[^>]*name="userId"[^>]*>/.exec(html)?.[0];
    assert.ok(field, "要能找到账号输入框");

    assert.ok(
      !/inputmode="numeric"/.test(field),
      "inputmode=numeric 会让手机弹出纯数字键盘，`teacher` 一个字都打不进去。" +
        "这个字段装的是账号，不只是学号。",
    );
    assert.ok(
      !/type="number"/.test(field),
      "type=number 会直接拒绝字母",
    );
  });

  test("标签要说清楚这里也能填管理员账号", () => {
    const html = loginPage({ next: "/" });
    assert.match(html, /管理员账号/, "只写「学号」会让人以为管理员账号不存在");
  });

  test("★ 页面上要给出忘了密码时的出路", () => {
    // 这条测试原本断言页面里出现 `npm run passwd` —— 那是**给开发者看的命令**，
    // 而这一页的读者是丢了密码的学生和老师。文案清理时把它换成了使用者能执行的动作：
    // 让另一位管理员在「账号」页重置。
    //
    // 意图没变，而且要求更严了：不能只说"账号还在"，
    // 必须给出**这一页的读者真的做得到**的那一步。
    const html = loginPage({ next: "/" });

    assert.match(html, /密码忘了不会导致账号消失/, "要说清「忘记密码 ≠ 账号没了」");
    assert.match(html, /管理员/, "要说明找谁");
    assert.match(html, /重置/, "要说明对方能做什么");
    assert.ok(
      !html.includes("npm run"),
      "登录页的读者是学生和老师，不该出现要在服务器上敲的命令",
    );
  });

  test("注册页的学号仍然用数字键盘（学生学号确实是数字）", () => {
    const html = registerPage({});
    const field = /<input[^>]*name="studentId"[^>]*>/.exec(html)?.[0];
    assert.ok(field);
    assert.match(field, /inputmode="numeric"/, "这里限制成数字是对的，别顺手删掉");
  });
});

// ---------------------------------------------------------------------------
// 2. 失败提示不能把人往"账号没了"上引
// ---------------------------------------------------------------------------

describe("登录失败的提示", () => {
  test("★ 说「账号」而不是「学号」", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: ADMIN, password: "错的密码", next: "/" },
    });

    const location = decodeURIComponent(res.headers["location"] ?? "");
    assert.match(location, /账号或密码不正确/);
    assert.ok(
      !/学号或密码/.test(location),
      "管理员账号不是学号，写「学号」会让人怀疑自己根本没有账号",
    );
  });

  test("★ 账号不存在与密码错误报同一句话（防账号枚举）", async () => {
    const w = world();

    const wrongPassword = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: ADMIN, password: "错的密码", next: "/" },
    });
    const noSuchUser = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: "根本不存在的人", password: "错的密码", next: "/" },
    });

    const strip = (loc: string | undefined): string =>
      decodeURIComponent(loc ?? "").replace(/（.*?）/, "（X）");

    assert.equal(
      strip(wrongPassword.headers["location"]),
      strip(noSuchUser.headers["location"]),
      "两者的措辞必须一致，否则就成了一个账号枚举接口",
    );
  });

  test("账号前后空格会被忽略（复制粘贴常带空格）", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: `  ${ADMIN}  `, password: "wang-pass-2026", next: "/admin" },
    });

    assert.equal(res.status, 303);
    assert.ok(
      res.headers["set-cookie"],
      "带空格的账号也应当登录成功，而不是报「账号或密码不正确」",
    );
  });

  test("★ 登录成功就直接去原本要去的页面，不再被押去改密", async () => {
    const w = world();
    const res = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: ADMIN, password: "wang-pass-2026", next: "/admin" },
    });

    // 这个账号刚被离线重置过（must_change_password = 1），
    // 但那个标记现在只用来**提醒**，不再拦路。
    assert.equal(res.headers["location"], "/admin");
  });

  test("★ 用初始密码登录不再被强制改密（提醒仍然存在）", async () => {
    const w = world();

    // 重置一次，标记回到 1
    resetPasswordOffline(w.db, {
      userId: ADMIN,
      newPassword: "temp-pass-2026",
      clock: w.clock,
    });

    const res = await request(w, {
      method: "POST",
      path: "/login",
      body: { userId: ADMIN, password: "temp-pass-2026", next: "/me" },
    });

    assert.equal(res.headers["location"], "/me", "不再押去 /password");

    // 但"你还在用初始密码"这件事仍然要被说出来 —— 标记没有变成装饰
    assert.equal(getAccount(w.db, ADMIN).mustChangePassword, true);
  });
});

// ---------------------------------------------------------------------------
// 3. 拒绝创建管理员时，要把人指向正确的命令
// ---------------------------------------------------------------------------

describe("已有管理员时拒绝 admin:init", () => {
  test("★ 拒绝的话里必须点名现有管理员，并指向 passwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "zongce-admin-"));
    const dbPath = join(dir, "z.sqlite");

    try {
      createFirstAdmin(dbPath, ADMIN, ADMIN_NAME, "first-pass-2026");

      let message = "";
      assert.throws(
        () => createFirstAdmin(dbPath, ADMIN, ADMIN_NAME, "second-pass-2026"),
        (error: unknown) => {
          message = error instanceof Error ? error.message : String(error);
          return true;
        },
      );

      // 光说"已经有管理员了"，使用者读到的却是"那我的账号呢？"
      assert.match(message, new RegExp(ADMIN), "要说出管理员是谁");
      assert.match(message, new RegExp(ADMIN_NAME), "要说出管理员叫什么");

      assert.match(
        message,
        /npm run passwd/,
        "想重建账号的人多半只是忘了密码 —— 拒绝的同时必须给出重置密码的路，" +
          "否则他只会以为账号真的没了",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("拒绝之后数据库没有被改动", () => {
    const dir = mkdtempSync(join(tmpdir(), "zongce-admin-"));
    const dbPath = join(dir, "z.sqlite");

    try {
      createFirstAdmin(dbPath, ADMIN, ADMIN_NAME, "first-pass-2026");
      try {
        createFirstAdmin(dbPath, "另一个管理员", "别人", "another-pass-1");
      } catch {
        // 预期之内
      }

      const db = openDatabase(dbPath);
      try {
        const n = (
          db.prepare("SELECT COUNT(*) AS n FROM admins WHERE revoked_at IS NULL").get() as {
            n: number;
          }
        ).n;
        assert.equal(n, 1, "被拒绝的命令不能留下任何痕迹");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 会话与账号无关：重启服务不会弄丢账号
// ---------------------------------------------------------------------------

describe("重启服务不会弄丢账号", () => {
  test("★ 会话没了，但账号还在、还能登进来", async () => {
    const w = world();

    // 模拟重启：换一个全新的 SessionStore，就等于所有人被登出
    const afterRestart: DispatcherDeps = { ...w.deps, sessions: new SessionStore() };

    const res = await dispatch(afterRestart, ROUTES, {
      method: "POST",
      path: "/login",
      cookies: {},
      query: {},
      body: { userId: ADMIN, password: "wang-pass-2026", next: "/admin" },
      files: [],
    });

    assert.equal(res.status, 303);
    assert.ok(
      res.headers["set-cookie"],
      "重启只该让人重新登录一次，不该让人以为账号没了",
    );
  });

  test("带着旧 Cookie 访问会跳登录页，而不是报账号不存在", async () => {
    const w = world();
    const res = await request(w, {
      method: "GET",
      path: "/admin",
      cookies: { [SESSION_COOKIE]: "早就失效的会话" },
    });

    assert.equal(res.status, 303);
    assert.match(res.headers["location"] ?? "", /\/login/);
  });
});

// ---------------------------------------------------------------------------
// 5. 启动横幅要主动确认账号存在，而不是保持沉默
// ---------------------------------------------------------------------------

describe("启动横幅", () => {
  test("★ 有管理员时要把名字报出来，不能一声不吭", () => {
    const w = world();
    const text = accountBanner(w.db, "./data/zongce.sqlite").join("\n");

    assert.match(text, new RegExp(ADMIN), "重启服务时应当确认 teacher 还在");
    assert.match(text, new RegExp(ADMIN_NAME), "顺便确认是哪个人的账号");
    assert.ok(
      !/第一次运行/.test(text),
      "库里明明有管理员却说「第一次运行」，会直接制造出「账号没了」的错觉",
    );
  });

  test("★ 有管理员时顺便给出忘记密码的出路", () => {
    const w = world();
    const text = accountBanner(w.db, "./data/zongce.sqlite").join("\n");
    assert.match(
      text,
      /npm run passwd/,
      "「我登不上去」和「我没有账号」在使用者心里是同一件事，要在同一屏回答掉",
    );
  });

  test("★ 没有管理员时给出创建命令，且不谎称有账号", () => {
    const db = openDatabase(":memory:");
    const text = accountBanner(db, "./data/zongce.sqlite").join("\n");

    assert.match(text, /第一次运行/);
    assert.match(text, /npm run admin:init/);
    assert.ok(
      !/npm run passwd/.test(text),
      "一个账号都还没有，重置密码的命令此刻没有意义",
    );
  });

  test("多个管理员都要列出来", () => {
    const w = world();
    w.db
      .prepare(
        "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('teacher2', NULL, '另一位老师', 'x', ?)",
      )
      .run(T0);
    // bootstrapAdmin 故意只肯创建**第一个**管理员（否则它就是个后门），
    // 所以第二个必须走正式的任命路径。
    grantAdmin(w.db, "teacher2", ADMIN, w.clock);

    const text = accountBanner(w.db, "./data/zongce.sqlite").join("\n");
    assert.match(text, /teacher（郑晓明）/);
    assert.match(text, /teacher2（另一位老师）/);
  });

  test("被撤职的管理员不再出现在横幅里", () => {
    const w = world();
    w.db.prepare("UPDATE admins SET revoked_at = ? WHERE user_id = ?").run(T0, ADMIN);

    const text = accountBanner(w.db, "./data/zongce.sqlite").join("\n");
    assert.match(text, /第一次运行/, "撤职之后就没有在任管理员了");
  });
});

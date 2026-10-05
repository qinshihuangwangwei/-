#!/usr/bin/env node
/**
 * 端到端冒烟：全新数据库 → 可用状态
 *
 *   node scripts/smoke.ts
 *
 * 单元测试验的是每一块零件；这个脚本验的是**装起来能不能用** ——
 * 起真实 HTTP 服务、发真实请求、上传真实 xlsx。
 *
 * 跑通的标志是这一段：
 *   创建周期 → 导入名册 → 学生注册 → 学生登录 → 看到自己的成绩页
 *
 * 这正是之前缺的那一段：在没有管理入口之前，系统装起来是跑不动的。
 */

import { mkdirSync, rmSync } from "node:fs";

import { openDatabase } from "../src/db/db.ts";
import { seedReferenceData } from "../src/db/seed.ts";
import { bootstrapAdmin } from "../src/domain/membership.ts";
import { systemClock } from "../src/domain/clock.ts";
import { loadObjectionSecret } from "../src/config.ts";
import { SessionStore } from "../src/http/session.ts";
import { PendingUploads } from "../src/http/uploads.ts";
import { startServer } from "../src/http/router.ts";
import { ROUTES } from "../src/http/routes.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFirstAdmin } from "../src/cli/admin.ts";

const DATA_DIR = "./data/smoke";
const DB_PATH = `${DATA_DIR}/smoke-e2e.sqlite`;
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * 冒烟测试**必须**待在自己的目录里。
 *
 * 这不是洁癖。冒烟测试跑的是运维那一段（快照 + 存档），而快照的文件名
 * 是固定的 `zongce-<日期>.sqlite` —— 和真实部署产出的备份**一模一样**。
 *
 * 曾经发生过的事：`npm run smoke` 把测试库（3 个账号 / 11 名学生 /
 * "2025-2026 春季学期"）的快照写进了 `./data/backups/`，
 * 文件名是 `zongce-2026-09-26.sqlite`，看起来就是当天那份真备份。
 *
 * 真正的数据库（1 个账号 / 55 名学生 / "2026-2027秋季学期"）好端端地
 * 在 `./data/zongce.sqlite` —— 但**一个照着那份"备份"去恢复的人，
 * 会静默地得到一库测试数据**，而且没有任何提示告诉他出错了。
 *
 * 所以这里不只是换个路径，还要在跑起来之前就把它挡住。
 */
export function assertIsolatedDataDir(
  dataDir: string = DATA_DIR,
  dbPath: string = DB_PATH,
): void {
  // 名单写死并解析成绝对路径，两个理由：
  //
  //   1. **写死**：拿 dataDir 跟自己比就成了空检查，改坏了自己也发现不了。
  //   2. **resolve**：`./data`、`.\data`、`data`、`D:\...\data`
  //      指的是同一个目录。只比字符串会漏掉后面几种写法 ——
  //      而这条守卫漏掉一次，代价就是一份冒充真备份的测试快照。
  const deploymentDirs = ["./data", ".", "./data/"].map((d) => resolve(d));

  if (deploymentDirs.includes(resolve(dataDir))) {
    throw new Error(
      `冒烟测试的数据目录不能是部署目录（${dataDir}）——\n` +
        "它会把测试数据库的快照写进真实的 ./data/backups/，" +
        "而那些文件与真备份同名。",
    );
  }

  if (/zongce\.sqlite$/.test(dbPath)) {
    throw new Error(`冒烟测试不能直接用真实数据库（${dbPath}）——它会往里写数据。`);
  }
}

let failures = 0;

function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) failures += 1;
}

class Client {
  #cookie = "";

  async get(path: string): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      redirect: "manual",
      headers: this.#cookie ? { cookie: this.#cookie } : {},
    });
  }

  async post(path: string, body: Record<string, string>): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(this.#cookie ? { cookie: this.#cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });
  }

  async upload(path: string, filename: string, content: Buffer, fields: Record<string, string> = {}): Promise<Response> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("file", new Blob([new Uint8Array(content)]), filename);

    return fetch(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: this.#cookie ? { cookie: this.#cookie } : {},
      body: form,
    });
  }

  captureCookie(res: Response): void {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const value = line.split(";")[0];
      if (value?.startsWith("zc_sid=")) this.#cookie = value;
    }
  }

  get hasSession(): boolean {
    return this.#cookie !== "";
  }
}

async function main(): Promise<void> {
  assertIsolatedDataDir();

  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }

  // 存档与快照也要一起清掉。
  //
  // 数据库每次重建，存档却跨天累积 —— 结果是：昨天那份存档记着"当时有 1 条事件"，
  // 今天账本重置成 0 条，外部存档校验就报「账本比存档时更短了：中间有事件被删除」。
  // **那个报错完全正确**（这正是外部存档存在的意义），但它说的是测试自己的状态，
  // 不是产品的问题。一个冒烟测试必须每次从干净状态开始，否则它会随日期飘。
  for (const dir of [`${DATA_DIR}/anchors`, `${DATA_DIR}/backups`]) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(`${DATA_DIR}/anchors`, { recursive: true });
  mkdirSync(`${DATA_DIR}/backups`, { recursive: true });

  // 只删冒烟测试自己的那份密钥。
  //
  // 这里原本删的是 `./data/.objection-key` —— 真实部署的异议密钥。
  // 那个密钥是"匿名但可追责"的支点：异议用 HMAC(密钥, 学期:学号) 记录，
  // 换个密钥，**之前所有异议的匿名标识就全部对不上号了**。
  // 一个跑测试的命令不该有这个副作用。
  rmSync(`${DATA_DIR}/.objection-key`, { force: true });

  const db = openDatabase(DB_PATH);
  const clock = systemClock;

  // 参考数据（12 个部门 + 26 个计分项）。serve.ts 启动时也会做，
  // 这里显式做一次，让冒烟脚本与真实启动路径一致。
  seedReferenceData(db);

  // 初始管理员只能由命令创建 —— 系统里没有自助注册为管理员的路径。
  // 这里直接调用 CLI 的同名函数，让冒烟覆盖真实路径。
  createFirstAdmin(DB_PATH, "teacher", "学院老师", "admin-pass-123");

  const server = await startServer({
    db,
    clock,
    objectionSecret: loadObjectionSecret({ dataDir: DATA_DIR }),
    sessions: new SessionStore(),
    uploads: new PendingUploads(),
    dataDir: DATA_DIR,
    routes: ROUTES,
    host: "127.0.0.1",
    port: PORT,
  });

  console.log(`\n服务已启动：${server.url}\n`);

  const client = new Client();

  try {
    // ---- 1. 未登录时什么都做不了 ----
    console.log("① 未登录");
    const anon = await client.get("/admin");
    check("管理页需要登录", anon.status === 303, `→ ${anon.status}`);

    const publicPage = await client.get("/publicity");
    check("公示页公开可访问（空库给人话而不是报错）", publicPage.status === 200);

    // ---- 2. 管理员登录 ----
    console.log("\n② 管理员登录");
    // 管理员的密码是直接写入的 'x'，这里用不到登录；
    // 直接构造会话更省事，也顺便验证会话层本身可用
    const session = new SessionStore();
    void session;

    const login = await client.post("/login", {
      userId: "teacher",
      password: "admin-pass-123",
      next: "/admin",
    });
    client.captureCookie(login);
    check("管理员登录成功", login.status === 303 && client.hasSession, `→ ${login.status}`);
    check(
      "★ 登录后直接去原本要去的页面（不再被强制改密）",
      (login.headers.get("location") ?? "") === "/admin",
      `→ ${login.headers.get("location")}`,
    );

    await client.post("/password", {
      oldPassword: "admin-pass-123",
      newPassword: "admin-pass-456",
    });

    // ---- 3. 创建周期 ----
    console.log("\n③ 创建周期");
    const createTerm = await client.post("/admin/term", { name: "2025-2026 春季学期" });
    check("创建周期", createTerm.status === 303);

    const adminPage = await client.get("/admin");
    const adminHtml = await adminPage.text();
    check("管理页显示周期已创建", adminHtml.includes("2025-2026 春季学期"));
    check("管理页提示名册待导入", adminHtml.includes("待办"));

    // ---- 4. 上传名册（预览） ----
    console.log("\n④ 导入名册（预览 → 确认）");
    const roster = readFileSync("tests/fixtures/roster-ok.xlsx");

    const preview = await client.upload("/admin/roster/preview", "roster-ok.xlsx", roster);
    const previewHtml = await preview.text();
    check("预览返回 200", preview.status === 200, `→ ${preview.status}`);
    check("预览显示识别结果", previewHtml.includes("名册预览"));
    check("预览显示新增 10 人", previewHtml.includes("新增 10"));
    check(
      "★ 预览阶段没有写库",
      (db.prepare("SELECT COUNT(*) AS n FROM students").get() as { n: number }).n === 0,
    );

    const token = /name="token" value="([^"]+)"/.exec(previewHtml)?.[1];
    check("预览页带确认令牌", Boolean(token));

    // ---- 5. 确认导入 ----
    const commit = await client.post("/admin/roster/commit", { token: token ?? "" });
    check("确认导入", commit.status === 303);

    const rosterCount = (
      db.prepare("SELECT COUNT(*) AS n FROM students").get() as { n: number }
    ).n;
    check("★ 名册已写入", rosterCount === 10, `实际 ${rosterCount} 人`);

    // ---- 5.5 手工补录（导入漏读时的兜底） ----
    console.log("\n⑤ 手工补录学生");
    const studentsPage = await client.get("/admin/students");
    check("名册页能打开", studentsPage.status === 200);

    const addOne = await client.post("/admin/students", {
      studentId: "2599000016",
      name: "补录学生",
      className: "计算机2501",
    });
    check("手工添加学生", addOne.status === 303);

    const rosterAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM students").get() as { n: number }
    ).n;
    check("★ 名册人数增加", rosterAfter === 11, `实际 ${rosterAfter} 人`);

    const auditRows = (
      db.prepare("SELECT COUNT(*) AS n FROM roster_changes").get() as { n: number }
    ).n;
    check("★ 人工改动留下了记录", auditRows === 1, `${auditRows} 条`);

    // 补录的人应当能立刻注册 —— 这是这个功能的全部意义
    const ghost = new Client();
    const ghostRegister = await ghost.post("/register", {
      studentId: "2599000016",
      name: "补录学生",
      initialPassword: "123456",
    });
    check("★ 补录的学生可以注册", ghostRegister.status === 303);

    // ---- 6. 学生注册与登录 ----
    console.log("\n⑤ 学生注册与登录");
    const student = new Client();

    const register = await student.post("/register", {
      studentId: "2599000001",
      name: "赵雨桐",
      initialPassword: "123456",
    });
    check("学生注册", register.status === 303);

    const badLogin = await student.post("/login", {
      userId: "2599000001",
      password: "000000",
    });
    check("错误密码被拒绝", badLogin.status === 303 && !student.hasSession);

    const goodLogin = await student.post("/login", {
      userId: "2599000001",
      password: "123456",
      next: "/me",
    });
    student.captureCookie(goodLogin);
    check("学生登录成功", goodLogin.status === 303 && student.hasSession);
    check(
      "★ 学生用初始密码登录也不再被强制改密",
      (goodLogin.headers.get("location") ?? "") === "/me",
      `→ ${goodLogin.headers.get("location")}`,
    );

    // ---- 7. 学生能看自己的页，进不去管理员页 ----
    console.log("\n⑥ 权限在服务端生效");
    const me = await student.get("/me");
    check("学生能打开「我的」页（身份 + 成绩 + 申诉）", me.status === 200);

    const forbidden = await student.get("/admin");
    check("★ 学生进不了管理页（服务端 403）", forbidden.status === 403, `→ ${forbidden.status}`);

    const forbiddenRecord = await student.post("/work/1/record", {
      studentId: "2599000001",
      delta: "100",
      reason: "自己给自己加分",
    });
    check("★ 学生加不了分（服务端 403）", forbiddenRecord.status === 403, `→ ${forbiddenRecord.status}`);

    // ---- 8. B 项成绩导入 ----
    console.log("\n⑦ 导入 B 项成绩（预览 → 确认）");
    const bscore = readFileSync("tests/fixtures/bscore-ok.xlsx");

    const bPreview = await client.upload("/admin/bscore/preview", "bscore-ok.xlsx", bscore);
    const bHtml = await bPreview.text();
    check("B 项预览返回 200", bPreview.status === 200, `→ ${bPreview.status}`);
    check("识别出 B 项成绩列", /B 项 <strong>B<\/strong>/.test(bHtml));
    check("预览显示新增 10 人", bHtml.includes("新增 10"));
    check(
      "★ 预览阶段没有写库",
      (db.prepare("SELECT COUNT(*) AS n FROM b_scores").get() as { n: number }).n === 0,
    );

    const bToken = /name="token" value="([^"]+)"/.exec(bHtml)?.[1];
    const bCommit = await client.post("/admin/bscore/commit", { token: bToken ?? "" });
    check("确认导入 B 项", bCommit.status === 303);

    const bCount = (
      db.prepare("SELECT COUNT(*) AS n FROM b_scores").get() as { n: number }
    ).n;
    check("★ B 项已写入", bCount === 10, `实际 ${bCount} 人`);

    const audit = db
      .prepare("SELECT filename, inserted, file_sha256 FROM import_jobs WHERE kind = 'BSCORE'")
      .get() as { filename: string; inserted: number; file_sha256: string } | undefined;
    check("★ 留下了导入审计", audit?.inserted === 10, audit?.filename ?? "无记录");
    check("★ 审计里记了原始文件哈希", /^[0-9a-f]{64}$/.test(audit?.file_sha256 ?? ""));

    const eventsAfterB = (
      db.prepare("SELECT COUNT(*) AS n FROM score_events").get() as { n: number }
    ).n;
    check("★ B 项没有混进 A/C 账本", eventsAfterB === 0, `账本事件 ${eventsAfterB} 条`);

    // ---- 9. 责任指派 ----
    console.log("\n⑧ 进入录入状态");
    const assign = await client.post("/chair/assignments/bulk", {});
    check("批量指派默认模板", assign.status === 303);

    const remaining = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM scoring_items WHERE id NOT IN (SELECT item_id FROM item_assignments WHERE term_id = 1 AND revoked_at IS NULL)",
        )
        .get() as { n: number }
    ).n;
    check("★ 有 4 项存疑归属没有被自动指派", remaining === 4, `实际剩 ${remaining} 项`);

    const enter = await client.post("/chair/enter", {});
    const enterMsg = decodeURIComponent(enter.headers.get("location") ?? "");
    check(
      "★ 未指派完时进不了录入状态，且报错列出漏项",
      enter.status === 400 || enterMsg.includes("未指派") || enterMsg.includes("不能进入录入"),
      `→ ${enter.status}`,
    );

    // 管理员不是主席，先看看它有没有权限发布
    const asTeacherChair = await client.get("/chair");
    check("管理员能看全院看板", asTeacherChair.status === 200);

    // ---- 10. 导出公示表 ----
    console.log("\n⑨ 导出公示表");
    const exported = await client.get("/chair/export");
    check("导出返回 200", exported.status === 200, `→ ${exported.status}`);
    check(
      "响应是 xlsx 类型",
      (exported.headers.get("content-type") ?? "").includes("spreadsheetml"),
    );
    check(
      "文件名带中文（RFC 5987 编码）",
      (exported.headers.get("content-disposition") ?? "").includes("filename*=UTF-8''"),
    );

    const bytes = Buffer.from(await exported.arrayBuffer());
    check("拿到的是真实文件", bytes.length > 2000, `${bytes.length} 字节`);
    check(
      "★ 是 ZIP 容器（xlsx 的本质）",
      bytes[0] === 0x50 && bytes[1] === 0x4b,
      `开头两字节 ${bytes[0]?.toString(16)} ${bytes[1]?.toString(16)}`,
    );

    // 用自己的读取器回读，确认结构完整
    const { readWorkbook } = await import("../src/import/xlsx.ts");
    const sheet = readWorkbook(bytes)[0]!;
    check("★ 回读工作表名正确", sheet.name === "2025-2026 春季学期", sheet.name);
    check("★ 回读到四行表头 + 数据", sheet.rows.length >= 1 + 3 + 10, `${sheet.rows.length} 行`);
    check("表头第一列是学号", sheet.rows[1]?.[0] === "学号");

    // ---- 11. 运维：快照 + 链尾哈希存档 + 校验 ----
    console.log("\n⑩ 运维（快照 + 存档 + 校验）");
    const { runDailyOps, opsAlerts, lastSuccessfulOpsDate } = await import(
      "../src/ops/daily.ts"
    );
    const { listAnchors } = await import("../src/ops/anchor.ts");
    const { listSnapshots } = await import("../src/ops/backup.ts");

    const ops = await runDailyOps(db, { dataDir: DATA_DIR, clock, force: true });

    check("运维全部成功", ops.ok, ops.failures.join("；"));
    check("生成了数据库快照", (ops.snapshot.value?.bytes ?? 0) > 0);
    check(
      "存下了链尾哈希",
      /^[0-9a-f]{64}$/.test(ops.anchor.value?.record.tipHash ?? ""),
    );
    check("比对了历史存档", (ops.verify.value?.checked ?? 0) >= 1);
    check("没有未处理的失败记录", opsAlerts(db).length === 0);
    check("记录了最近成功日期", lastSuccessfulOpsDate(db) !== null);

    // 同一天再跑一次应当跳过
    const again = await runDailyOps(db, { dataDir: DATA_DIR, clock });
    check("★ 同一天重复跑会跳过（幂等）", again.skipped === true);

    check("存档文件落在数据目录外于数据库的独立目录", listAnchors(`${DATA_DIR}/anchors`).length >= 1);
    check("快照文件同上", listSnapshots(`${DATA_DIR}/backups`).length >= 1);

    // ★ 篡改之后用历史存档校验，必须失败
    const { writeAnchor, verifyAgainstAnchor } = await import("../src/ops/anchor.ts");
    const { computeHash, verifyChain } = await import("../src/db/ledger.ts");

    // 顺序很关键：**先有历史，再有存档，最后才是篡改。**
    // 存档只能证明"写作那一刻账本长这样"，因此它必须写在篡改之前。
    const ZERO = "0".repeat(64);
    db.prepare(
      `INSERT INTO score_events
         (term_id, student_id, item_id, delta, event_type, actor_id, reason,
          created_at, prev_hash, self_hash)
       VALUES (1, '2599000001', 20, 1, 'ENTRY', 'owner-x', '冒烟测试用',
               '2026-03-01T09:00:00.000Z', ?, ?)`,
    ).run(ZERO, ZERO);

    const { record: honest } = writeAnchor(db, `${DATA_DIR}/anchors`, clock);
    check("存档记下了当时的事件数", honest.eventCount === 1, `${honest.eventCount} 条`);

    // 篡改**已有**的一条事件，而不是追加一条。
    //
    // 追加不影响前缀，因此旧存档照样对得上 —— 那是对的，不是漏洞：
    // 存档证明的是"某一天账本长这样"，之后正常长出来的部分与它无关。
    // 能被存档抓住的，是**改写历史**。

    // 重算整条链，让链自身自洽（模拟拿到数据库权限的人）。
    // 第一步必须先拆掉触发器 —— 这正是攻击者也要做的事，
    // 也是"触发器挡不住 DDL"那句话的具体含义。
    db.exec("DROP TRIGGER score_events_no_update");
    db.exec("UPDATE score_events SET delta = 99 WHERE id = 1");

    const allRows = db
      .prepare("SELECT * FROM score_events ORDER BY id")
      .all() as unknown as Record<string, unknown>[];
    let prev = ZERO;
    for (const row of allRows) {
      const body = {
        termId: row["term_id"] as number,
        studentId: row["student_id"] as string,
        itemId: row["item_id"] as number,
        delta: row["delta"] as number,
        eventType: row["event_type"] as string,
        actorId: row["actor_id"] as string,
        reason: row["reason"] as string,
        sourceEventId: null,
        appealId: null,
        objectionId: null,
        createdAt: row["created_at"] as string,
      };
      const self = computeHash(prev, body);
      db.exec(
        `UPDATE score_events SET prev_hash = '${prev}', self_hash = '${self}' WHERE id = ${row["id"]}`,
      );
      prev = self;
    }

    check("★ 重算之后的链是自洽的（链校验挡不住这种情况）", verifyChain(db).ok === true);

    const verdict = verifyAgainstAnchor(db, honest);
    check(
      "★ 但历史存档对不上 —— 这正是外部存档存在的理由",
      verdict.ok === false,
      verdict.ok ? "" : verdict.reason.slice(0, 60),
    );
  } finally {
    await server.close();
    db.close();
  }

  console.log(
    failures === 0
      ? "\n✅ 端到端冒烟全部通过 —— 全新数据库可以走到「可用」状态。\n"
      : `\n❌ 有 ${failures} 项未通过。\n`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("\n冒烟失败：", error);
    process.exit(1);
  });
}

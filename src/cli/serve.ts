/**
 * 启动服务
 *
 *   node src/cli/serve.ts ./data/zongce.sqlite --port 3081 [--host 0.0.0.0]
 *   node src/cli/serve.ts ./data/zongce.sqlite --clock-offset 4d   # 测试：时间前移 4 天
 *
 * 开发阶段直接跑在局域网上、用 IP 访问即可 —— 不需要域名、备案、证书。
 * 学生把手机连到同一个 WiFi，打开 http://<你的电脑IP>:3081 就能用。
 *
 * 一条安全提醒：`--host 0.0.0.0` 会让同一网络里的所有人访问得到。
 * 开发时这样最方便，但**上线前**必须换成正式域名 + HTTPS，
 * 并把 ZONGCE_SECURE_COOKIE=1 打开（否则会话 Cookie 不带 Secure 标记）。
 *
 * `--clock-offset` 只给测试用：它把整个系统的时间往前拨，
 * 用来跨过 72 小时申诉窗口、直接看公示期。打开之后每个页面底部都会
 * 挂一条横幅 —— 别拿着拨过的时间当真。
 */

import { dirname } from "node:path";

import { openDatabase, type Db } from "../db/db.ts";
import { seedReferenceData } from "../db/seed.ts";
import {
  describeDuration,
  parseDuration,
  shiftedClock,
  systemClock,
} from "../domain/clock.ts";
import { loadObjectionSecret } from "../config.ts";
import { SessionStore } from "../http/session.ts";
import { PendingUploads } from "../http/uploads.ts";
import { startServer } from "../http/router.ts";
import { ROUTES } from "../http/routes.ts";
import { startScheduler } from "../jobs/scheduler.ts";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/**
 * 启动时该怎么介绍"这台机器上有哪些管理员"。
 *
 * ## 为什么有管理员时也要说话
 *
 * 这里原本只在**一个管理员都没有**时才打印，有管理员时一声不吭。
 * 于是重启服务的人如果记不清自己叫什么账号，屏幕上就一片沉默 ——
 * 而沉默既可能意味着"账号好好的"，也可能意味着"这段代码压根没跑到"。
 * 两者看起来一模一样。
 *
 * 真实后果：有人明明有账号，却在问"怎么没有 teacher 帐号了"。
 * 数据库里它好端端地当着管理员，只是**没有任何地方显示过它存在**。
 *
 * 报出已有的管理员，重启就从"没有消息"变成了一次**明确的确认**；
 * 顺带把忘记密码时的出路放在同一屏里 —— 因为"我登不上去"和
 * "我没有账号"在使用者心里是同一件事，得在同一处回答掉。
 */
export function accountBanner(db: Db, dbPath: string): string[] {
  const admins = db
    .prepare(
      `SELECT a.user_id AS id, u.display_name AS name
         FROM admins a
         JOIN users u ON u.id = a.user_id
        WHERE a.revoked_at IS NULL
        ORDER BY a.appointed_at, a.user_id`,
    )
    .all() as Array<{ id: string; name: string }>;

  if (admins.length === 0) {
    // 全新安装时数据库里一个账号都没有，直接打开页面只会看到一个登不进去的
    // 登录框 —— 使用者不知道下一步该做什么。把命令直接打出来，
    // 比在 README 里写一段"请先创建管理员"有用得多。
    return [
      "",
      "┌─ 这是第一次运行，还没有管理员账号 ──────────────────────",
      "│",
      "│  请另开一个终端执行（把路径与姓名换成你自己的）：",
      "│",
      `│    npm run admin:init -- ${dbPath} teacher 学院老师`,
      "│",
      "│  它会打印一个初始密码，用它登录后可以修改。",
      "│  系统里没有自助注册为管理员的路径 —— 这是有意的。",
      "└─────────────────────────────────────────────────────",
      "",
    ];
  }

  return [
    `[serve] 管理员：${admins.map((a) => `${a.id}（${a.name}）`).join("、")}`,
    `[serve] 忘记密码：npm run passwd -- ${dbPath} ${admins[0]?.id ?? "<账号>"}`,
  ];
}

async function main(): Promise<void> {
  const dbPath =
    process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".sqlite")) ??
    "./data/zongce.sqlite";

  const host = arg("host", "127.0.0.1");
  // 默认端口刻意避开 3080：那是 DSH Web（本项目的开发工具界面）的端口。
  // 两者撞在一起时，综测系统会以 EADDRINUSE 起不来，而原因看起来
  // 完全与开发工具无关 —— 排查半天才会想到。
  const port = Number(arg("port", "3081"));

  const db = openDatabase(dbPath);

  // 参考数据幂等播种：新库第一次启动时会写入 12 个部门与 26 个计分项。
  // 已有数据不会被覆盖。
  const seeded = seedReferenceData(db);
  if (seeded.departmentsInserted > 0 || seeded.itemsInserted > 0) {
    console.log(
      `[init] 已写入参考数据：部门 ${seeded.departmentsInserted} 个，计分项 ${seeded.itemsInserted} 项`,
    );
  }

  const dataDir = dirname(dbPath);
  const objectionSecret = loadObjectionSecret({ dataDir });
  const sessions = new SessionStore();
  const uploads = new PendingUploads();

  // 时间旅行开关 —— **只给测试用**。
  //
  // 「72 小时申诉窗口」到「公示期」是纯时间驱动的。没有这个开关，
  // 想看一眼公示页就得真等三天，那条最有价值的流程等于测不了。
  //
  // 打开之后它会在**每一个页面**上留一条横幅（见 router 里那段），
  // 所以不会有"忘了自己在测试时间"这种事。
  const offsetText = arg("clock-offset", "");
  let clock = systemClock;
  let timeShiftNote: string | undefined;

  if (offsetText !== "") {
    const offsetMs = parseDuration(offsetText);
    if (offsetMs === null) {
      console.error(
        `\n❌ --clock-offset 读不懂：${offsetText}\n` +
          `   用法：--clock-offset 90m / 4h / 3d / 3d12h（只接受正数，单位 m/h/d）\n`,
      );
      process.exit(1);
    }
    clock = shiftedClock(systemClock, offsetMs);
    timeShiftNote = `已前移 ${describeDuration(offsetMs)}`;
  }

  const server = await startServer({
    db,
    clock,
    objectionSecret,
    sessions,
    uploads,
    dataDir,
    // 展开而不是写 `timeShiftNote: undefined` —— 项目开着
    // exactOptionalPropertyTypes，"有值就是有值、没有就是没有"。
    ...(timeShiftNote ? { timeShiftNote } : {}),
    routes: ROUTES,
    host,
    port,
  });

  // 定时任务只做物化，不参与授权 —— 它挂掉系统依然正确。
  const stopScheduler = startScheduler(db, { clock, dataDir });

  // 账号信息横幅。
  //
  // 单独抽出来是为了能被测试 —— 这段文案做的是件正经事：
  // **让"账号还在"这件事看得见。**
  for (const line of accountBanner(db, dbPath)) {
    console.log(line);
  }

  console.log(`[serve] 已启动：${server.url}`);
  console.log(`[serve] 数据库：${dbPath}`);
  console.log(`[serve] 换端口：npm run serve -- ${dbPath} --port ${port + 1}`);
  console.log(`[serve] 异议密钥：${dirname(dbPath)}/.objection-key（务必与数据库分开备份）`);
  if (timeShiftNote) {
    console.log("");
    console.log("┌─ ⚠️  测试模式：时间被拨过 ────────────────────────────");
    console.log(`│  ${timeShiftNote}`);
    console.log(`│  当前时间视为：${clock.now().toISOString()}`);
    console.log("│  页面底部会一直挂着一条横幅提醒这件事。");
    console.log("│  正式使用时**不要**带 --clock-offset 启动。");
    console.log("└──────────────────────────────────────────────────────");
    console.log("");
  }
  if (host === "0.0.0.0") {
    console.log("[serve] 注意：正在监听所有网卡，同一网络内均可访问。上线前请改用 HTTPS。");
  }

  const shutdown = (): void => {
    stopScheduler();
    void server.close().then(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[serve] 启动失败：", error);
    process.exit(1);
  });
}

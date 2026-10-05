/**
 * 一次性 tick —— 供 cron / systemd timer 调用
 *
 *   node src/cli/tick.ts ./data/zongce.sqlite
 *
 * 也可以常驻跑：
 *   node src/cli/tick.ts ./data/zongce.sqlite --watch
 *
 * 再强调一次：这个命令**不是正确性的必要条件**。
 * 周期窗口的关闭、申诉审批权的转移，都由时间推导。
 * 它的作用是及时把推导结果落库，让历史记录不留空白。
 */

import { openDatabase } from "../db/db.ts";
import { systemClock } from "../domain/clock.ts";
import { startScheduler, tick } from "../jobs/scheduler.ts";

function main(argv: string[]): number {
  const args = argv.slice(2);
  const watch = args.includes("--watch");
  const path = args.find((a) => !a.startsWith("--")) ?? "./data/zongce.sqlite";

  const db = openDatabase(path);

  if (watch) {
    const intervalMs = 60_000;
    console.log(`[tick] 常驻模式，每 ${intervalMs / 1000} 秒一次，数据库：${path}`);
    const stop = startScheduler(db, {
      intervalMs,
      clock: systemClock,
      onError: (e) => console.error("[tick] 执行失败：", e),
    });

    const shutdown = (): void => {
      stop();
      db.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return 0;
  }

  const result = tick(db, systemClock);

  const advanced = result.terms.filter((t) => t.status !== "DRAFT").length;
  console.log(
    `[tick] 周期 ${advanced} 个，申诉升级 ${result.appealsEscalated} 条`,
  );

  for (const term of result.terms) {
    console.log(`  - ${term.id} ${term.name} → ${term.status}`);
  }

  db.close();
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}

/**
 * 手动跑一次每日运维
 *
 *   node src/cli/ops.ts ./data/zongce.sqlite            # 跑一轮（当天已跑过则跳过）
 *   node src/cli/ops.ts ./data/zongce.sqlite --force    # 强制重跑
 *   node src/cli/ops.ts ./data/zongce.sqlite --verify   # 只校验账本，不写任何东西
 *
 * 为什么要有这个命令：定时任务在服务进程里，而"备份到底有没有在跑"
 * 是运维最需要能立刻回答的问题。一条命令跑一下，比翻日志快得多。
 */

import { openDatabase } from "../db/db.ts";
import { systemClock } from "../domain/clock.ts";
import {
  anchorDir,
  backupDir,
  listOpsRuns,
  lastSuccessfulOpsDate,
  opsAlerts,
  runDailyOps,
} from "../ops/daily.ts";
import { listAnchors, verifyAllAnchors } from "../ops/anchor.ts";
import { listSnapshots } from "../ops/backup.ts";
import { dirname } from "node:path";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const verifyOnly = args.includes("--verify");

  const dbPath =
    args.find((a) => !a.startsWith("--") && a.endsWith(".sqlite")) ??
    "./data/zongce.sqlite";
  const dataDir = dirname(dbPath);

  const db = openDatabase(dbPath);

  try {
    if (verifyOnly) {
      const result = verifyAllAnchors(db, anchorDir(dataDir));

      console.log(`\n账本校验：比对 ${result.results.length} 份历史存档\n`);

      for (const item of result.results) {
        console.log(`  ${item.ok ? "✅" : "❌"} ${item.anchor.date}`);
        if (!item.ok) console.log(`     ${item.reason}`);
      }

      // 只校验不写入 —— 这是刻意的：查一下账本不该改变任何东西
      console.log(result.ok ? "\n全部一致。\n" : "\n发现不一致，详见上文。\n");
      return result.ok ? 0 : 1;
    }

    const result = await runDailyOps(db, { dataDir, clock: systemClock, force });

    if (result.skipped) {
      console.log(`\n今天（${result.date}）已经成功跑过，跳过。用 --force 强制重跑。\n`);
      return 0;
    }

    console.log(`\n运维日期：${result.date}\n`);

    const line = (label: string, ok: boolean, detail: string): void => {
      console.log(`  ${ok ? "✅" : "❌"} ${label}：${detail}`);
    };

    line(
      "快照",
      result.snapshot.ok,
      result.snapshot.value
        ? `${(result.snapshot.value.bytes / 1024).toFixed(0)} KB → ${result.snapshot.value.path}`
        : (result.snapshot.error ?? "未执行"),
    );
    line(
      "存档",
      result.anchor.ok,
      result.anchor.value
        ? `账本 ${result.anchor.value.record.eventCount} 条，链尾 ${result.anchor.value.record.tipHash.slice(0, 12)}…`
        : (result.anchor.error ?? "未执行"),
    );
    line(
      "校验",
      result.verify.ok && (result.verify.value?.failed.length ?? 1) === 0,
      result.verify.value
        ? `比对 ${result.verify.value.checked} 份历史存档`
        : (result.verify.error ?? "未执行"),
    );
    line("投递", result.deliver.ok, result.deliver.ok ? "已投递" : (result.deliver.error ?? ""));

    if (result.failures.length > 0) {
      console.log("\n失败详情：");
      for (const failure of result.failures) console.log(`  · ${failure}`);
    }

    const alerts = opsAlerts(db);
    if (alerts.length > 0) {
      console.log(`\n⚠️  共有 ${alerts.length} 条未处理的失败记录：`);
      for (const alert of alerts.slice(0, 5)) {
        console.log(`  · [${alert.createdAt.slice(0, 16)}] ${alert.kind} — ${alert.detail}`);
      }
    }

    console.log(
      `\n现状：快照 ${listSnapshots(backupDir(dataDir)).length} 份 · ` +
        `存档 ${listAnchors(anchorDir(dataDir)).length} 份 · ` +
        `最近成功 ${lastSuccessfulOpsDate(db) ?? "从未"}\n`,
    );

    return result.ok ? 0 : 1;
  } finally {
    void listOpsRuns;
    db.close();
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("\n运维失败：", error);
      process.exit(1);
    });
}

/**
 * 批量初始化账号
 *
 *   node src/cli/initAccounts.ts ./data/zongce.sqlite 000000
 *   node src/cli/initAccounts.ts ./data/zongce.sqlite 000000 --dry-run
 *
 * ## 它做两件事
 *
 * 1. 名册里**还没有账号**的学生 → 按学号 + 姓名建账号
 * 2. **已经存在**的账号（包括管理员）→ 密码改成同一个
 *
 * 第 2 条必须说清楚：这个命令的语义是"让每个人都能用这个密码登进来"，
 * 不是"只给缺账号的人补一个"。所以已经在用自己密码的人也会被覆盖 ——
 * 那是有意的，但执行前它会先把要改的清单和数量报出来。
 *
 * ## 为什么需要一个命令，而不是在网页上点
 *
 * 全院一百多人，逐个在「账号」页重置是不现实的。而这类批量操作
 * 本来就只有能在这台机器上执行命令的人做得了 —— 信任边界是文件系统，
 * 和 `admin:init` / `passwd` 一致。
 *
 * ## 代价
 *
 * 统一初始密码意味着**任何知道某位同学学号的人都能登进他的账号**。
 * 这是开学发号阶段的正常做法，但它不能长期维持：
 * 系统会在每个人的首页提示"你还在使用系统发给你的密码"，
 * 但那只提醒，不拦路。发完号就该让各人改掉。
 */

import { openDatabase } from "../db/db.ts";
import { systemClock } from "../domain/clock.ts";
import { listStudents } from "../domain/student.ts";
import {
  hasAccount,
  registerStudent,
  resetPasswordOffline,
} from "../auth/account.ts";

const DEFAULT_PASSWORD = "000000";

interface Plan {
  /** 名册里有、但还没有账号的学生 */
  toCreate: Array<{ id: string; name: string }>;
  /** 已经有账号的（含管理员）—— 密码会被重置 */
  toReset: Array<{ id: string; isAdmin: boolean }>;
  /** 名册里没有、也不是管理员的账号：不碰 */
  untouched: string[];
}

function plan(db: ReturnType<typeof openDatabase>): Plan {
  const students = listStudents(db);

  const toCreate: Plan["toCreate"] = [];
  const toReset: Plan["toReset"] = [];

  for (const s of students) {
    if (hasAccount(db, s.id)) {
      toReset.push({ id: s.id, isAdmin: false });
    } else {
      toCreate.push({ id: s.id, name: s.name });
    }
  }

  // 非学生账号（管理员、老师）。名册里没有他们，但"所有人都能登进来"
  // 这句话包含他们 —— 使用者明确要求管理员也用同一个密码。
  const others = db
    .prepare("SELECT id FROM users WHERE student_id IS NULL ORDER BY id")
    .all() as { id: string }[];

  const rosterIds = new Set(students.map((s) => s.id));
  for (const u of others) {
    if (rosterIds.has(u.id)) continue;
    if (hasAccount(db, u.id)) toReset.push({ id: u.id, isAdmin: true });
  }

  // 名册里没有、但学生字段又不为空的账号：学号已经离开名册了。
  // 不动它们 —— 那可能是毕业或者转专业，不该被这次批量操作顺手改掉密码。
  const untouched = (
    db
      .prepare("SELECT id FROM users WHERE student_id IS NOT NULL ORDER BY id")
      .all() as { id: string }[]
  )
    .map((u) => u.id)
    .filter((id) => !rosterIds.has(id));

  return { toCreate, toReset, untouched };
}

function main(): number {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");

  const dbPath = positional[0] ?? "./data/zongce.sqlite";
  const password = positional[1] ?? DEFAULT_PASSWORD;

  if (password.length < 6) {
    console.error(`\n❌ 密码至少 6 位（当前 ${password.length} 位）\n`);
    return 1;
  }

  let db;
  try {
    db = openDatabase(dbPath);
  } catch (error) {
    console.error(
      `\n❌ 打不开数据库：${dbPath}\n   ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const clock = systemClock;

  try {
    const p = plan(db);

    console.log("");
    console.log(`数据库：${dbPath}`);
    console.log(`初始密码：${password}${password === DEFAULT_PASSWORD ? "（默认）" : ""}`);
    console.log("");
    console.log(`  名册学生总数   ${p.toCreate.length + p.toReset.filter((r) => !r.isAdmin).length}`);
    console.log(`  要新建账号     ${p.toCreate.length} 个`);
    console.log(`  要重置密码     ${p.toReset.length} 个（其中管理员 ${p.toReset.filter((r) => r.isAdmin).length} 个）`);

    if (p.untouched.length > 0) {
      console.log(
        `  不动的账号     ${p.untouched.length} 个（已不在名册里，可能是毕业/转专业）`,
      );
    }

    if (dryRun) {
      console.log("");
      console.log("--dry-run：什么都不写。去掉这个参数才真的执行。");
      console.log("");
      return 0;
    }

    if (p.toCreate.length === 0 && p.toReset.length === 0) {
      console.log("\n没有要处理的账号。\n");
      return 0;
    }

    console.log("");
    console.log("开始处理（每账号一次 scrypt 哈希，约 0.1 秒）……");

    const started = Date.now();
    let created = 0;
    let reset = 0;
    const failures: string[] = [];

    p.toCreate.forEach((s, index) => {
      try {
        registerStudent(db, {
          studentId: s.id,
          name: s.name,
          initialPassword: password,
          clock,
        });
        created += 1;
      } catch (error) {
        failures.push(`${s.id}（${s.name}）：${error instanceof Error ? error.message : String(error)}`);
      }
      if ((index + 1) % 20 === 0) {
        process.stdout.write(`  已新建 ${created} 个…\r`);
      }
    });

    p.toReset.forEach((u) => {
      try {
        resetPasswordOffline(db, { userId: u.id, newPassword: password, clock });
        reset += 1;
      } catch (error) {
        failures.push(`${u.id}：${error instanceof Error ? error.message : String(error)}`);
      }
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log("");
    console.log(`✅ 完成（${seconds} 秒）`);
    console.log(`   新建账号   ${created} 个`);
    console.log(`   重置密码   ${reset} 个`);

    if (failures.length > 0) {
      console.log("");
      console.log(`❌ 有 ${failures.length} 个没成功：`);
      for (const f of failures.slice(0, 10)) console.log(`   · ${f}`);
      if (failures.length > 10) console.log(`   …还有 ${failures.length - 10} 个`);
    }

    console.log("");
    console.log("   下一步：学生用「学号 + 初始密码」登录。");
    console.log("   首页会提示他们还在用系统发的密码 —— 建议尽快各自改掉。");
    console.log("");

    return failures.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(main());
}

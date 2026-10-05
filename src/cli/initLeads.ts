/**
 * 批量补齐各部门的部长与副部长
 *
 *   node src/cli/initLeads.ts ./data/zongce.sqlite              # 随机任命，默认种子
 *   node src/cli/initLeads.ts ./data/zongce.sqlite --seed 7     # 换一批人
 *   node src/cli/initLeads.ts ./data/zongce.sqlite --dry-run    # 只看会任命谁
 *
 * ## 它做什么
 *
 * 遍历全部部门，**把空缺的座位填满**：每部门部长 1 人、副部长 2 人
 * （上限取自 `ESTABLISHMENT`，不是这里写死的数字）。
 *
 * 只填空缺，不罢免任何人 —— 已经有人的座位原样不动。所以重复执行是安全的。
 *
 * ## 为什么用随机
 *
 * 真实的任免是主席在 `/chair/leads` 上一个一个做的，那是这套系统的正经路径。
 * 这个命令是给**搭建与测试阶段**用的：一个部门一个部门去点
 * 三十多次，只为了把系统跑起来，没有意义。
 *
 * 所以任命人记成 `cli:init-leads` 而不是管理员的名字 ——
 * **这条记录要如实说明它不是人点的**。审计里的人名一旦开始不准确，
 * 整条记录就都不可信了。
 *
 * ## 候选人从哪来
 *
 * 名册里有账号的学生，且：账号在用、不是管理员、当前没有任何在任职务。
 * 一个人同时只能有一个职务 —— 这是 `appointDeptLead` 自己的守卫，
 * 这里只是不去挑那些注定会被拒绝的人。
 */

import { openDatabase } from "../db/db.ts";
import { systemClock } from "../domain/clock.ts";
import { ESTABLISHMENT, appointDeptLead } from "../domain/membership.ts";

const APPOINTED_BY = "cli:init-leads";
const DEFAULT_SEED = 20260929;

/** mulberry32：小、快、可复现。够用来打乱一份名单。 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function main(): number {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const seedIndex = args.indexOf("--seed");
  const seed = seedIndex >= 0 ? Number(args[seedIndex + 1]) : DEFAULT_SEED;

  const dbPath = positional[0] ?? "./data/zongce.sqlite";

  if (!Number.isFinite(seed)) {
    console.error("\n❌ --seed 需要一个数字\n");
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
  const random = makeRandom(seed);

  try {
    const departments = db
      .prepare("SELECT id, name FROM departments ORDER BY id")
      .all() as { id: number; name: string }[];

    if (departments.length === 0) {
      console.error(
        "\n❌ 数据库里一个部门都没有。先启动一次服务（会把 12 个部门播种进去），再跑这个命令。\n",
      );
      return 1;
    }

    // 候选人：名册里有账号的学生，账号在用、不是管理员、当前没有在任职务
    const candidates = shuffle(
      db
        .prepare(
          `SELECT u.id AS id, u.display_name AS name
             FROM users u
            WHERE u.student_id IS NOT NULL
              AND u.status = 'ACTIVE'
              AND NOT EXISTS (SELECT 1 FROM admins a
                               WHERE a.user_id = u.id AND a.revoked_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM memberships m
                               WHERE m.user_id = u.id AND m.ended_at IS NULL)
            ORDER BY u.id`,
        )
        .all() as { id: string; name: string }[],
      random,
    );

    // 现有的负责人，用来判断哪些座位是空的
    const active = db
      .prepare(
        "SELECT user_id AS userId, department_id AS departmentId, role FROM memberships WHERE ended_at IS NULL",
      )
      .all() as { userId: string; departmentId: number | null; role: string }[];

    const headsOf = (id: number): number =>
      active.filter((m) => m.departmentId === id && m.role === "HEAD").length;
    const deputiesOf = (id: number): number =>
      active.filter((m) => m.departmentId === id && m.role === "DEPUTY").length;

    const needHeads = departments.reduce(
      (sum, d) => sum + Math.max(0, ESTABLISHMENT.HEAD_PER_DEPARTMENT - headsOf(d.id)),
      0,
    );
    const needDeputies = departments.reduce(
      (sum, d) => sum + Math.max(0, ESTABLISHMENT.DEPUTY_PER_DEPARTMENT - deputiesOf(d.id)),
      0,
    );
    const needed = needHeads + needDeputies;

    console.log("");
    console.log(`数据库：${dbPath}`);
    console.log(`随机种子：${seed}（换一个数字就换一批人）`);
    console.log("");
    console.log(`  部门数         ${departments.length}`);
    console.log(`  可用候选人     ${candidates.length}（名册里有账号、无在任职务、非管理员）`);
    console.log(`  空缺：部长 ${needHeads} 个，副部长 ${needDeputies} 个`);
    console.log("");

    if (needed === 0) {
      console.log("所有座位都已经有人了，没有要做的。\n");
      return 0;
    }

    if (candidates.length < needed) {
      console.error(
        `❌ 候选人不够：需要 ${needed} 人，只有 ${candidates.length} 人。\n` +
          `   先跑 npm run accounts:init 把名册里的账号开出来。\n`,
      );
      return 1;
    }

    const pool = [...candidates];
    const take = (): { id: string; name: string } => pool.shift()!;

    const plan: Array<{
      department: string;
      role: string;
      userId: string;
      name: string;
    }> = [];

    for (const d of departments) {
      for (let i = headsOf(d.id); i < ESTABLISHMENT.HEAD_PER_DEPARTMENT; i += 1) {
        const p = take();
        plan.push({ department: d.name, role: "HEAD", userId: p.id, name: p.name });
      }
      for (let i = deputiesOf(d.id); i < ESTABLISHMENT.DEPUTY_PER_DEPARTMENT; i += 1) {
        const p = take();
        plan.push({ department: d.name, role: "DEPUTY", userId: p.id, name: p.name });
      }
    }

    console.log("即将任命：");
    let lastDept = "";
    for (const item of plan) {
      if (item.department !== lastDept) {
        console.log(`  ${item.department}`);
        lastDept = item.department;
      }
      console.log(
        `      ${item.role === "HEAD" ? "部长  " : "副部长"}  ${item.userId}  ${item.name}`,
      );
    }

    if (dryRun) {
      console.log("");
      console.log("--dry-run：什么都不写。去掉这个参数才真的执行。");
      console.log("");
      return 0;
    }

    console.log("");
    const failures: string[] = [];
    let done = 0;

    for (const item of plan) {
      const departmentId = departments.find((d) => d.name === item.department)!.id;
      try {
        appointDeptLead(db, {
          userId: item.userId,
          departmentId,
          role: item.role === "HEAD" ? "HEAD" : "DEPUTY",
          by: APPOINTED_BY,
          clock,
        });
        done += 1;
      } catch (error) {
        failures.push(
          `${item.department} ${item.role} ${item.userId}：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.log(`✅ 已任命 ${done} 人（任命人记为 ${APPOINTED_BY}）`);

    if (failures.length > 0) {
      console.log("");
      console.log(`❌ 有 ${failures.length} 个没成功：`);
      for (const f of failures) console.log(`   · ${f}`);
    }

    console.log("");
    console.log("   这些人是**批量填的**，不是主席在网页上一个一个任命的 ——");
    console.log("   准备好之后，去 /chair/leads 按真实情况调整。");
    console.log("   调整会留下记录：旧任命标成已撤销，不会消失。");
    console.log("");

    return failures.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(main());
}

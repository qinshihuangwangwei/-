/**
 * 把还没有职务的学生随机分配成各部门的干事
 *
 *   node src/cli/initMembers.ts ./data/zongce.sqlite              # 随机，默认种子
 *   node src/cli/initMembers.ts ./data/zongce.sqlite --seed 7     # 换一批
 *   node src/cli/initMembers.ts ./data/zongce.sqlite --dry-run    # 只看会怎么分
 *
 * ## 它做什么
 *
 * 找出**当前没有任何在任职务**的学生，随机分到各部门当干事（MEMBER）。
 * 已经有职务的人一个都不动 —— 一个人同时只能有一个职务。
 *
 * 分配用**洗牌 + 轮转**（round-robin）而不是纯随机：
 * 纯随机会让某个部门一个干事都没有、另一个部门二十个。
 * 洗牌保证谁去哪个部门是随机的，轮转保证每个部门人数相当。
 * 种子固定，所以同一批人能复现。
 *
 * ## 为什么 `by` 记成 cli:init-members
 *
 * 干事在系统里的正道是"学生申请 → 部长批准"。这个命令**跳过申请那一步**，
 * 所以它不该冒充任何人的批准。任命人如实写成 `cli:init-members`：
 * 审计里的人名一旦开始不准确，整条记录就都不可信了。
 *
 * 准备好之后去各部门的「本部门」页按真实情况调整 —— 免职会留下记录，
 * 旧记录不会消失。
 */

import { openDatabase } from "../db/db.ts";
import { systemClock } from "../domain/clock.ts";
import { assignMember } from "../domain/membership.ts";

const APPOINTED_BY = "cli:init-members";
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
        "\n❌ 数据库里一个部门都没有。先启动一次服务（会把 12 个部门播种进去）。\n",
      );
      return 1;
    }

    // 候选人：名册里有账号、账号在用、不是管理员、当前没有任何在任职务
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

    const withPosition = db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE ended_at IS NULL")
      .get() as { n: number };

    console.log("");
    console.log(`数据库：${dbPath}`);
    console.log(`随机种子：${seed}（换一个数字就换一批人）`);
    console.log("");
    console.log(`  部门数             ${departments.length}`);
    console.log(`  已有职务的人       ${withPosition.n}（不动他们）`);
    console.log(`  待分配的候选人     ${candidates.length}`);
    console.log("");

    if (candidates.length === 0) {
      console.log("所有学生都已经有职务了，没有要做的。\n");
      return 0;
    }

    // 洗牌之后轮转：谁去哪个部门是随机的，人数是均等的
    const plan = candidates.map((c, index) => ({
      ...c,
      department: departments[index % departments.length]!,
    }));

    const perDept = new Map<number, number>();
    for (const p of plan) {
      perDept.set(p.department.id, (perDept.get(p.department.id) ?? 0) + 1);
    }

    console.log("分配方案：");
    for (const d of departments) {
      console.log(`  ${d.name.padEnd(12)} ${perDept.get(d.id) ?? 0} 人`);
    }

    if (dryRun) {
      console.log("");
      console.log("--dry-run：什么都不写。示例前 8 条：");
      for (const p of plan.slice(0, 8)) {
        console.log(`  ${p.id} ${p.name}  → ${p.department.name}`);
      }
      console.log("");
      console.log(`去掉 --dry-run 才会真的写入 ${plan.length} 条任职。`);
      console.log("");
      return 0;
    }

    console.log("");
    const failures: string[] = [];
    let done = 0;

    for (const p of plan) {
      try {
        assignMember(db, {
          userId: p.id,
          departmentId: p.department.id,
          by: APPOINTED_BY,
          clock,
        });
        done += 1;
      } catch (error) {
        failures.push(
          `${p.id} ${p.name} → ${p.department.name}：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.log(`✅ 已分派 ${done} 人为干事（任命人记为 ${APPOINTED_BY}）`);

    if (failures.length > 0) {
      console.log("");
      console.log(`❌ 有 ${failures.length} 个没成功：`);
      for (const f of failures.slice(0, 10)) console.log(`   · ${f}`);
    }

    console.log("");
    console.log("   这些人是**批量分的**，不是本人申请、部长批准的 ——");
    console.log("   他们只是在测试环境里被铺进去的。准备好之后去各部门的");
    console.log("   「本部门」页按真实情况调整；免职会留下记录，旧记录不会消失。");
    console.log("");

    return failures.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(main());
}

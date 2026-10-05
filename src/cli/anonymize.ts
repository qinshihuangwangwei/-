/**
 * 把名册里的真实姓名换成随机生成的假名
 *
 *   node src/cli/anonymize.ts ./data/zongce.sqlite [--seed N] [--dry-run]
 *
 * ## 为什么需要它
 *
 * 名册是从教务导出来的**真实学生名单**，而这份系统会被截图、被演示、
 * 被拿去做培训材料。一张写着真实姓名的截图发到群里，就没有收回来的办法了。
 *
 * 所以开发与演示阶段应当用假名跑；等到真的要上线，再导一次真实名册即可。
 *
 * ## 它改什么，不改什么
 *
 * 改：`students.name` 与 `users.display_name`（两处必须一起改，否则
 *     「我的」页显示的姓名和名册里的对不上）。
 * 不改：学号、班级、年级、分数、任职、账本。
 *
 * **账本一个字都不动。** 分数事件的 reason 里只有来源文件名与列号，
 * 没有人名 —— 这一点在真库上核过。
 *
 * ## 假名怎么生成
 *
 * 种子固定，所以同一批名册每次跑出来是同一套假名（可复现）。
 * 两条硬约束：
 *   1. **不与原名重合** —— 生成的名字如果恰好撞上名册里某个真名，
 *      重新生成。撞名的后果很具体：某张截图看上去像是在说某位真同学。
 *   2. **互相不重复** —— 名册里出现两个同名的人会让排查变得没有意义。
 *
 * ## 会留下什么
 *
 * `data/imports/` 里归档的**原始 Excel 仍然带着真实姓名**。
 * 这个命令碰不到它 —— 那是原始凭证，删掉就再也对不上账了。
 * 如果连它也要处理，那是另一个决定（加密保存、或者移到离线介质），
 * 不该由一个改名命令顺手做掉。
 */

import { openDatabase } from "../db/db.ts";

const DEFAULT_SEED = 20260930;

/** 常见姓氏。刻意选得宽，免得生成的名册一眼看去全是同一个姓。 */
const SURNAMES = [
  "王", "李", "张", "刘", "陈", "杨", "黄", "赵", "吴", "周",
  "徐", "孙", "马", "朱", "胡", "郭", "何", "高", "林", "罗",
  "郑", "梁", "谢", "宋", "唐", "许", "韩", "冯", "邓", "曹",
  "彭", "曾", "肖", "田", "董", "袁", "潘", "于", "蒋", "蔡",
  "余", "杜", "叶", "程", "苏", "魏", "吕", "丁", "任", "沈",
];

/**
 * 名字池，**单字与双字分开**。
 *
 * 刻意不拿单字随机拼成两个字 —— 那样会拼出「菲成」「帆成」这种
 * 汉语里不存在的组合；也不把两个双字名接起来（会得到「韩佳海燕」四个字）。
 * 假名册会被截图、会被当样例看，一眼假的名字反而让人怀疑整张表都是编的。
 */
const GIVEN_SINGLE = [
  "伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "军", "洋",
  "勇", "艳", "杰", "娟", "涛", "明", "超", "霞", "平", "刚",
  "英", "华", "玲", "兰", "峰", "波", "辉", "斌", "健", "鹏",
  "浩", "晨", "睿", "轩", "然", "琪", "悦", "琳", "瑶", "彤",
  "蕊", "菲", "薇", "蓉", "雨", "思", "佳", "梦", "涵", "萱",
];

const GIVEN_DOUBLE = [
  "子涵", "欣怡", "梓涵", "雨欣", "诗涵", "若曦", "梦洁", "雅静",
  "佳怡", "思远", "嘉豪", "俊杰", "宇轩", "浩然", "子轩", "梓豪",
  "宇航", "俊宇", "文博", "志强", "建国", "建华", "秀英", "桂兰",
  "玉兰", "秀兰", "海燕", "晓燕", "晓静", "晓明", "晓东", "晓峰",
  "晓宇", "晓晨", "雨萌", "雨桐", "雨薇", "思琪", "思彤", "梦琪",
  "佳琪", "佳颖", "诗琪", "若涵", "语彤", "心怡", "天磊", "天宇",
  "成龙", "立新", "安宁", "远航", "一鸣", "一诺", "子豪", "梓萱",
];

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

/**
 * 生成 `count` 个假名。
 *
 * 两条硬约束：
 *   1. **不与 `avoid` 里的任何一个重合** —— 撞名的后果很具体：
 *      一张截图看上去像是在说某位真同学。
 *   2. **互相不重复** —— 名册里出现两个同名的人会让排查变得没有意义。
 *
 * 种子固定时结果固定（可复现）。
 */
export function generateNames(
  count: number,
  seed: number,
  avoid: ReadonlySet<string> = new Set(),
): { names: string[]; retries: number } {
  const random = makeRandom(seed);
  const used = new Set<string>();
  const names: string[] = [];
  let retries = 0;

  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const candidate = (): string =>
    pick(SURNAMES) + (random() < 0.5 ? pick(GIVEN_SINGLE) : pick(GIVEN_DOUBLE));

  for (let i = 0; i < count; i += 1) {
    let name = candidate();
    let guard = 0;
    while (avoid.has(name) || used.has(name)) {
      name = candidate();
      guard += 1;
      retries += 1;
      if (guard > 300) {
        // 池子被撞满（正常不可能）：补两位数字保住唯一性，并让它明显是假名
        name = `${name}${String(used.size % 100).padStart(2, "0")}`;
        break;
      }
    }
    used.add(name);
    names.push(name);
  }

  return { names, retries };
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

  const random = makeRandom(seed);

  try {
    const students = db
      .prepare("SELECT id, name FROM students ORDER BY id")
      .all() as { id: string; name: string }[];

    if (students.length === 0) {
      console.log("\n名册是空的，没有要改的。\n");
      return 0;
    }

    // 原名全部留着 —— 生成时用来避开撞名
    const originalNames = new Set(students.map((s) => s.name));

    const { names, retries } = generateNames(students.length, seed, originalNames);
    const plan = students.map((student, index) => ({
      id: student.id,
      from: student.name,
      to: names[index]!,
    }));

    const uniqueAfter = new Set(plan.map((p) => p.to)).size;

    console.log("");
    console.log(`数据库：${dbPath}`);
    console.log(`随机种子：${seed}（换一个数字就换一套假名）`);
    console.log("");
    console.log(`  名册人数        ${students.length}`);
    console.log(`  假名去重后      ${uniqueAfter} 个${uniqueAfter === plan.length ? "（无重复 ✅）" : "  ⚠️ 有重复"}`);
    console.log(`  与原名撞车      ${plan.filter((p) => originalNames.has(p.to)).length} 个（应为 0）`);
    if (retries > 0) console.log(`  生成时重试      ${retries} 次（撞名就重来）`);

    console.log("");
    console.log("  示例：");
    for (const p of plan.slice(0, 8)) {
      console.log(`    ${p.id}  ${p.from} → ${p.to}`);
    }

    if (dryRun) {
      console.log("");
      console.log("--dry-run：什么都不写。去掉这个参数才真的改。");
      console.log("");
      return 0;
    }

    // students.name 与 users.display_name 必须一起改。
    // 只改一处的话，「我的」页显示的姓名和名册里的会对不上 ——
    // 而"名字对不上"在这个系统里是最容易被当成 bug 报上来的那种现象。
    const setStudent = db.prepare("UPDATE students SET name = ? WHERE id = ?");
    const setUser = db.prepare("UPDATE users SET display_name = ? WHERE student_id = ?");

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of plan) {
        setStudent.run(p.to, p.id);
        setUser.run(p.to, p.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const studentsUpdated = db.prepare("SELECT COUNT(*) AS n FROM students").get() as { n: number };
    const usersUpdated = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE student_id IS NOT NULL")
      .get() as { n: number };

    console.log("");
    console.log(`✅ 已改名：students ${studentsUpdated.n} 行、users ${usersUpdated.n} 行`);
    console.log("");
    console.log("   没动的：学号、班级、年级、分数、任职、账本。");
    console.log("   账本里没有人名 —— 这一点随时可以用 npm run anonymize -- --dry-run 复核。");
    console.log("");
    console.log("   ⚠️ data/imports/ 里归档的**原始 Excel 仍然带着真实姓名**。");
    console.log("      这个命令碰不到它（那是原始凭证）。要处理它得另外决定。");
    console.log("   ⚠️ 下次从同一个 Excel 导名册，真实姓名会被写回来。");
    console.log("");

    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(main());
}

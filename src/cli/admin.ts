/**
 * 创建首个管理员
 *
 *   node src/cli/admin.ts ./data/zongce.sqlite teacher 学院老师
 *
 * 设计文档 §7.2：**系统里没有任何"自助注册为管理员"的路径。**
 * 首个管理员只能用这个命令在服务器上创建 —— 那意味着操作者
 * 本来就有服务器的访问权，这是唯一说得通的信任起点。
 *
 * 之后新增管理员必须由既有管理员在网页上任命。这个命令**拒绝**在
 * 已有管理员的情况下再创建，就是为了不让它变成一条绕开任免流程的后门。
 */

import { openDatabase } from "../db/db.ts";
import { generateTempPassword, hashPassword } from "../auth/password.ts";
import { bootstrapAdmin, isAdmin } from "../domain/membership.ts";
import { systemClock } from "../domain/clock.ts";

export function createFirstAdmin(
  dbPath: string,
  userId: string,
  displayName: string,
  password: string,
): void {
  const db = openDatabase(dbPath);
  const clock = systemClock;

  try {
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM admins WHERE revoked_at IS NULL")
      .get() as { n: number };

    if (existing.n > 0) {
      const admins = db
        .prepare(
          `SELECT a.user_id AS id, u.display_name AS name
             FROM admins a
             JOIN users u ON u.id = a.user_id
            WHERE a.revoked_at IS NULL
            ORDER BY a.appointed_at, a.user_id`,
        )
        .all() as Array<{ id: string; name: string }>;

      throw new Error(
        "系统里已经有管理员了：\n" +
          admins.map((a) => `  · ${a.id}（${a.name}）`).join("\n") +
          "\n\n新增管理员必须由既有管理员在网页上任命，" +
          "不能用这个命令绕过 —— 否则它就成了一个后门。\n\n" +
          "如果你要做的其实是「登录不上去了」，那这个命令帮不了你 ——\n" +
          "账号一直都在，缺的只是密码。重置密码用：\n" +
          `  npm run passwd -- ${dbPath} ${admins[0]?.id ?? "teacher"}\n`,
      );
    }

    const now = clock.now().toISOString();

    const user = db
      .prepare("SELECT id FROM users WHERE id = ?")
      .get(userId) as { id: string } | undefined;

    if (user) {
      db.prepare("UPDATE users SET display_name = ?, password_hash = ?, must_change_password = 1 WHERE id = ?")
        .run(displayName, hashPassword(password), userId);
    } else {
      db.prepare(
        `INSERT INTO users (id, student_id, display_name, password_hash, must_change_password, status, created_at)
         VALUES (?, NULL, ?, ?, 1, 'ACTIVE', ?)`,
      ).run(userId, displayName, hashPassword(password), now);
    }

    bootstrapAdmin(db, userId, clock);

    console.log(`\n✅ 已创建管理员：${userId}（${displayName}）`);
    console.log(`\n初始密码：${password}`);
    console.log("请立即登录并修改密码。\n");
    console.log(`启动服务：npm run serve -- ${dbPath}`);
  } finally {
    db.close();
  }
}


function main(): number {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dbPath = args[0] ?? "./data/zongce.sqlite";
  const userId = args[1] ?? "teacher";
  const displayName = args[2] ?? "学院老师";
  const password = args[3] ?? generateTempPassword();

  try {
    createFirstAdmin(dbPath, userId, displayName, password);
    return 0;
  } catch (error) {
    console.error(
      `\n❌ ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main());
}

export { isAdmin };

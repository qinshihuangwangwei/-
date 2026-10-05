/**
 * 忘记密码时的离线重置
 *
 *   node src/cli/passwd.ts ./data/zongce.sqlite teacher            # 随机生成新密码
 *   node src/cli/passwd.ts ./data/zongce.sqlite teacher MyNewPass1 # 指定新密码
 *
 * ## 为什么这个命令存在，而 admin:init 却拒绝在有管理员时再执行
 *
 * 两者的差别不在于"危险程度"，而在于**是否引入新的主体**：
 *
 *   - `admin:init` 会**创建**一个管理员。允许它在已有管理员时执行，
 *     就等于给了一条绕开任免流程、悄悄多出一个管理员的路。
 *   - 本命令只重置**已存在**账号的密码，不新增任何人。
 *
 * 而且信任边界本来就一样：能在这台机器上执行命令的人，本来就能直接
 * 读写数据库文件。假装不给这条路，只会把人逼去手改 SQL ——
 * 那反而绕过了长度校验、口令哈希、强制改密标记这些真正有用的东西。
 *
 * 重置后 `must_change_password` 会被置回 1：这里打印出来的密码是临时的。
 * 注意那个标记**只是提醒，不是闸门** —— 登录不会再强制跳改密页。
 */

import { openDatabase } from "../db/db.ts";
import { systemClock } from "../domain/clock.ts";
import { resetPasswordOffline } from "../auth/account.ts";
import { generateTempPassword } from "../auth/password.ts";
import { isAdmin } from "../domain/membership.ts";

function main(): number {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  const dbPath = args[0] ?? "./data/zongce.sqlite";
  const userId = args[1];
  const password = args[2] ?? generateTempPassword();

  if (!userId) {
    console.error(
      "\n用法：npm run passwd -- <数据库路径> <账号> [新密码]\n" +
        "  省略新密码则随机生成一个。\n\n" +
        "  例：npm run passwd -- ./data/zongce.sqlite teacher\n",
    );
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

  try {
    const result = resetPasswordOffline(db, {
      userId,
      newPassword: password,
      clock: systemClock,
    });

    console.log("");
    console.log(`✅ 已重置账号：${result.account.id}（${result.account.displayName}）`);
    console.log(`   身份：${result.wasAdmin ? "管理员" : "普通账号"}`);
    console.log("");
    console.log(`   新密码：${password}`);
    console.log("");
    console.log("   下次登录会被要求修改密码。");

    if (!result.wasAdmin) {
      console.log("");
      console.log(
        "   注：这个账号不是管理员。平时学生忘记密码由本部门部长或管理员在网页上重置，\n" +
          "   这个命令是没人能登录时的兜底。",
      );
    }

    console.log("");
    console.log(`   启动服务：npm run dev -- ${dbPath}`);
    console.log("");

    if (!isAdmin(db, userId) && result.wasAdmin) {
      console.log("   ⚠️ 状态异常：账号的管理员身份似乎刚刚消失，请检查数据库。\n");
    }

    return 0;
  } catch (error) {
    console.error(
      `\n❌ ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(main());
}

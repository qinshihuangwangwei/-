/**
 * 账号
 *
 * 设计文档 §9。注册走名册白名单，初始密码为身份证后 6 位，首次登录强制改密。
 *
 * 三个安全细节，都不大但都不该写错：
 *
 * 1. **登录失败不区分"账号不存在"与"密码错误"。**
 *    分开报错等于送给攻击者一个账号枚举接口 —— 他能据此确认某个学号有没有注册。
 *
 * 2. **账号不存在时也要走一遍哈希计算。**
 *    否则"不存在"立刻返回、"存在但密码错"要等 100ms，时序本身就把答案说出去了。
 *
 * 3. **注册时学号与姓名必须同时对得上名册。**
 *    只对学号的话，随便填个名字就能把别人的账号占掉。
 */

import type { DatabaseSync } from "node:sqlite";

import { transaction } from "../db/db.ts";
import {
  generateTempPassword,
  hashPassword,
  verifyPassword,
  assertPasswordAcceptable,
  PasswordError,
} from "./password.ts";
import { departmentLeads, activeMembership, isAdmin } from "../domain/membership.ts";
import type { Clock } from "../domain/clock.ts";

export interface Account {
  id: string;
  studentId: string | null;
  displayName: string;
  mustChangePassword: boolean;
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
}

export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

interface AccountRow {
  id: string;
  student_id: string | null;
  display_name: string;
  must_change_password: number;
  status: string;
  created_at: string;
}

function toAccount(raw: Record<string, unknown>): Account {
  const row = raw as unknown as AccountRow;
  return {
    id: row.id,
    studentId: row.student_id,
    displayName: row.display_name,
    mustChangePassword: row.must_change_password === 1,
    status: row.status as Account["status"],
    createdAt: row.created_at,
  };
}

export function getAccount(db: DatabaseSync, userId: string): Account {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!row) {
    throw new AuthError("ACCOUNT_NOT_FOUND", `账号 ${userId} 不存在`);
  }
  return toAccount(row);
}

export function hasAccount(db: DatabaseSync, userId: string): boolean {
  return db.prepare("SELECT 1 AS x FROM users WHERE id = ?").get(userId) !== undefined;
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export interface RegisterInput {
  studentId: string;
  name: string;
  /** 初始密码。按设计为身份证后 6 位，但系统不校验内容，也不存储它。 */
  initialPassword: string;
  clock: Clock;
}

/**
 * 学生自助注册。
 *
 * 名册白名单：学号 + 姓名必须**同时**对得上 `students` 表。
 * 身份证后 6 位只作为初始密码，系统不比对来源、不做唯一性约束 ——
 * 它是密码，不是身份标识。
 */
export function registerStudent(db: DatabaseSync, input: RegisterInput): Account {
  return transaction(db, () => {
    assertPasswordAcceptable(input.initialPassword);

    const roster = db
      .prepare("SELECT id, name FROM students WHERE id = ?")
      .get(input.studentId) as { id: string; name: string } | undefined;

    if (!roster) {
      throw new AuthError(
        "NOT_ON_ROSTER",
        `学号 ${input.studentId} 不在本期名册中。请核对学号，或联系管理员确认名册是否已导入。`,
      );
    }

    if (roster.name !== input.name.trim()) {
      throw new AuthError(
        "NAME_MISMATCH",
        `学号 ${input.studentId} 与姓名不匹配。` +
          `只对学号不对姓名的话，随便填个名字就能把别人的账号占掉。`,
      );
    }

    if (hasAccount(db, input.studentId)) {
      throw new AuthError(
        "ALREADY_REGISTERED",
        `学号 ${input.studentId} 已注册。忘记密码请联系本部门部长或管理员重置。`,
      );
    }

    db.prepare(
      `INSERT INTO users (id, student_id, display_name, password_hash, must_change_password, status, created_at)
       VALUES (?, ?, ?, ?, 1, 'ACTIVE', ?)`,
    ).run(
      input.studentId,
      input.studentId,
      roster.name,
      hashPassword(input.initialPassword),
      input.clock.now().toISOString(),
    );

    return getAccount(db, input.studentId);
  });
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/** 账号不存在时用来消耗掉同等的时间，避免时序泄露账号是否存在 */
const DUMMY_HASH = hashPassword("x".repeat(24));

export interface LoginResult {
  account: Account;
  mustChangePassword: boolean;
}

export function login(
  db: DatabaseSync,
  input: { userId: string; password: string },
): LoginResult {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(input.userId);

  if (!row) {
    // 关键：也要算一遍哈希，否则"不存在"立刻返回、"密码错"要等 100ms。
    // 时序本身就是答案。
    verifyPassword(input.password, DUMMY_HASH);
    throw invalidCredentials(input.userId);
  }

  const account = toAccount(row);

  if (!verifyPassword(input.password, (row as unknown as { password_hash: string }).password_hash)) {
    throw invalidCredentials(input.userId);
  }

  if (account.status === "DISABLED") {
    throw new AuthError(
      "ACCOUNT_DISABLED",
      `账号 ${input.userId} 已被停用，请联系管理员`,
    );
  }

  return { account, mustChangePassword: account.mustChangePassword };
}

/** 统一的失败信息：不区分"账号不存在"与"密码错误" */
function invalidCredentials(userId: string): AuthError {
  // 措辞用"账号"而不是"学号"：管理员账号（如 teacher）本来就不是学号，
  // 提示里写"学号"会让人以为"是不是我这个账号根本不存在"。
  return new AuthError("INVALID_CREDENTIALS", `账号或密码不正确（${userId}）`);
}

// ---------------------------------------------------------------------------
// 改密
// ---------------------------------------------------------------------------

export function changePassword(
  db: DatabaseSync,
  input: {
    userId: string;
    oldPassword: string;
    newPassword: string;
    clock: Clock;
  },
): Account {
  return transaction(db, () => {
    const found = login(db, {
      userId: input.userId,
      password: input.oldPassword,
    });

    assertPasswordAcceptable(input.newPassword);

    if (input.newPassword === input.oldPassword) {
      throw new AuthError(
        "PASSWORD_UNCHANGED",
        "新密码与当前密码相同，请换一个",
      );
    }

    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    ).run(hashPassword(input.newPassword), input.userId);

    void found;
    return getAccount(db, input.userId);
  });
}

/**
 * 重置密码。
 *
 * 只有管理员，或该生**所在部门**的部长/副部长可以做。
 *
 * 刻意不重置成身份证后 6 位：系统里根本不存身份证号，
 * 而且"重置成初始密码"意味着任何知道该生身份证号的人都能登进去。
 * 改成随机临时密码、只显示一次。
 *
 * `must_change_password` 会被置为 1 —— 但它现在**只是提醒，不是闸门**：
 * 登录不再强制跳改密页，只有首页那句"你还在使用系统发给你的密码"。
 * 代价要认清：重置密码的人**知道**这个临时密码，所以对方不改，
 * 那个人就一直能登他的号。这一条只能靠提醒，靠不了拦截。
 */
export function resetPassword(
  db: DatabaseSync,
  input: { userId: string; by: string; clock: Clock },
): { tempPassword: string } {
  return transaction(db, () => {
    if (!hasAccount(db, input.userId)) {
      throw new AuthError("ACCOUNT_NOT_FOUND", `账号 ${input.userId} 不存在`);
    }

    if (!isAdmin(db, input.by)) {
      const target = activeMembership(db, input.userId);
      if (!target || target.departmentId === null) {
        throw new AuthError(
          "NOT_ALLOWED_TO_RESET",
          `只有管理员可以重置 ${input.userId} 的密码：该生没有在任部门职位，找不到可以负责的部长。`,
        );
      }

      const { head, deputies } = departmentLeads(db, target.departmentId);
      const allowed =
        head?.userId === input.by || deputies.some((d) => d.userId === input.by);

      if (!allowed) {
        throw new AuthError(
          "NOT_ALLOWED_TO_RESET",
          `${input.by} 不是部门 ${target.departmentId} 的部长或副部长，无权重置该生密码。`,
        );
      }
    }

    const tempPassword = generateTempPassword();

    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?",
    ).run(hashPassword(tempPassword), input.userId);

    return { tempPassword };
  });
}

/**
 * 离线重置（服务器端命令专用）。
 *
 * 与 `resetPassword` 的区别只有一条：**不检查调用者的权限。**
 *
 * 这不是放松，而是承认现实：能在这台机器上执行命令的人，
 * 本来就能直接读写数据库文件。**信任边界是文件系统，不是这个函数。**
 * 装模作样地要求"先登录才能重置密码"，只会把忘了密码的人逼去手改 SQL ——
 * 那反而绕过了这里所有的校验（长度、哈希、强制改密标记）。
 *
 * 两道仍然保留的约束：
 *
 * 1. **目标账号必须已存在。** 不能借它创建新账号 ——
 *    否则它就成了绕开"任命流程"的后门，而 `admin:init` 拒绝重复执行
 *    正是为了堵这一点。
 * 2. **必须强制改密。** 命令打印出来的密码是临时的，下次登录必须换掉。
 */
export function resetPasswordOffline(
  db: DatabaseSync,
  input: { userId: string; newPassword: string; clock: Clock },
): { account: Account; wasAdmin: boolean } {
  return transaction(db, () => {
    if (!hasAccount(db, input.userId)) {
      throw new AuthError(
        "ACCOUNT_NOT_FOUND",
        `账号 ${input.userId} 不存在。这个命令只能重置**已有**账号的密码 —— ` +
          `要新建管理员请用 npm run admin:init。`,
      );
    }

    assertPasswordAcceptable(input.newPassword);

    const wasAdmin = isAdmin(db, input.userId);

    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1, status = 'ACTIVE' WHERE id = ?",
    ).run(hashPassword(input.newPassword), input.userId);

    return { account: getAccount(db, input.userId), wasAdmin };
  });
}

/**
 * 停用 / 启用账号。
 *
 * `by` 是必填的，虽然现在只有两条守卫用到它 —— 但这两条都很要紧：
 *
 * 1. **不能停用自己。** 停用之后你自己也登不进来，谁也救不了你。
 * 2. **不能停用最后一个在任管理员。** 同上，系统会失去唯一的运营入口。
 *
 * 停用是可逆的（把 status 改回 ACTIVE 即可），所以它比"删除"温和；
 * 但"把唯一的出口关上"这件事，无论可不可逆都不该被允许。
 */
export function setAccountStatus(
  db: DatabaseSync,
  input: { userId: string; status: "ACTIVE" | "DISABLED"; by: string },
): Account {
  getAccount(db, input.userId);

  if (input.status === "DISABLED") {
    if (input.userId === input.by) {
      throw new AuthError(
        "CANNOT_DISABLE_SELF",
        "不能停用自己的账号。停用之后你就再也登不进来了，请让另一位管理员操作。",
      );
    }

    if (isAdmin(db, input.userId)) {
      const activeAdmins = db
        .prepare(
          `SELECT COUNT(*) AS n FROM admins a
             JOIN users u ON u.id = a.user_id
            WHERE a.revoked_at IS NULL AND u.status = 'ACTIVE'`,
        )
        .get() as { n: number };

      if (activeAdmins.n <= 1) {
        throw new AuthError(
          "LAST_ACTIVE_ADMIN",
          `${input.userId} 是最后一个还能登录的管理员，不能停用。` +
            `否则就没人能创建周期、导入名册、任命主席了。`,
        );
      }
    }
  }

  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(input.status, input.userId);
  return getAccount(db, input.userId);
}

export { PasswordError };

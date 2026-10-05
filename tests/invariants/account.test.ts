/**
 * M2.1c 账号与登录 —— 不变量测试
 *
 * 三个安全细节，都不大，但都不该写错：
 *   1. 登录失败不区分"账号不存在"与"密码错误"
 *   2. 账号不存在时也要算一遍哈希（否则时序泄露答案）
 *   3. 注册时学号与姓名必须同时对得上名册
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import {
  registerStudent,
  login,
  changePassword,
  resetPassword,
  setAccountStatus,
  getAccount,
  hasAccount,
  AuthError,
} from "../../src/auth/account.ts";
import {
  hashPassword,
  verifyPassword,
  generateTempPassword,
  assertPasswordAcceptable,
  PasswordError,
  MIN_PASSWORD_LENGTH,
} from "../../src/auth/password.ts";
import { bootstrapAdmin, appointDeptLead, applyToJoin, approveJoin } from "../../src/domain/membership.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T0 = "2026-03-01T09:00:00.000Z";
const ID6 = "123456"; // 假装是身份证后 6 位
const DEPT = 1;

function world(): { db: Db; clock: FixedClock } {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);

  db.exec(`INSERT INTO departments (id, name) VALUES (${DEPT}, '体育部');`);

  for (const [id, name] of [
    ["s01", "学生甲"],
    ["s02", "学生乙"],
    ["s03", "学生丙"],
    ["s09", "部长丁"],
  ] as const) {
    db.prepare(
      "INSERT INTO students (id, name, class_name, grade) VALUES (?, ?, '计算机2501', 2025)",
    ).run(id, name);
  }

  return { db, clock };
}

// ---------------------------------------------------------------------------
// 1. 口令哈希
// ---------------------------------------------------------------------------

describe("口令哈希", () => {
  test("同一口令两次哈希结果不同（加盐）", () => {
    assert.notEqual(hashPassword("abcdef"), hashPassword("abcdef"));
  });

  test("校验能通过", () => {
    const stored = hashPassword("abcdef");
    assert.equal(verifyPassword("abcdef", stored), true);
    assert.equal(verifyPassword("abcdeg", stored), false);
    assert.equal(verifyPassword("", stored), false);
  });

  test("存储串里不含明文", () => {
    const stored = hashPassword("MySecret123");
    assert.ok(!stored.includes("MySecret123"));
    assert.match(stored, /^scrypt\$/);
  });

  test("损坏的存储串不会让校验崩溃", () => {
    for (const bad of ["", "x", "scrypt$bad", "scrypt$1$2$3$4$5"]) {
      assert.equal(verifyPassword("abcdef", bad), false);
    }
  });

  test("★ 会去掉零宽字符与首尾空白（从微信复制身份证号常带这些）", () => {
    const stored = hashPassword("123456");
    assert.equal(verifyPassword("123456\u200B", stored), true, "零宽空格不该导致登录失败");
    assert.equal(verifyPassword("  123456  ", stored), true);
    assert.equal(verifyPassword("１２３４５６", stored), true, "全角数字应被 NFKC 归一化");
  });

  test("密码长度下限是 6（身份证后 6 位正好够）", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 6);
    assert.doesNotThrow(() => assertPasswordAcceptable("123456"));
    assert.throws(
      () => assertPasswordAcceptable("12345"),
      (e) => e instanceof PasswordError && e.code === "PASSWORD_TOO_SHORT",
    );
  });

  test("临时密码够长且不含易混字符", () => {
    const temp = generateTempPassword();
    assert.ok(temp.length >= 10);
    assert.ok(!/[0O1lI]/.test(temp), `临时密码含易混字符：${temp}`);
    assert.notEqual(generateTempPassword(), temp, "每次都该不同");
  });
});

// ---------------------------------------------------------------------------
// 2. 注册
// ---------------------------------------------------------------------------

describe("注册", () => {
  test("名册内的学生可以注册", () => {
    const { db, clock } = world();
    const account = registerStudent(db, {
      studentId: "s01",
      name: "学生甲",
      initialPassword: ID6,
      clock,
    });

    assert.equal(account.studentId, "s01");
    assert.equal(account.displayName, "学生甲");
    assert.equal(account.mustChangePassword, true, "初始密码必须强制改掉");
    assert.equal(account.status, "ACTIVE");
  });

  test("★ 不在名册中的学号被拒绝", () => {
    const { db, clock } = world();
    assert.throws(
      () =>
        registerStudent(db, {
          studentId: "s99",
          name: "查无此人",
          initialPassword: ID6,
          clock,
        }),
      (e) => e instanceof AuthError && e.code === "NOT_ON_ROSTER",
    );
  });

  test("★ 学号对了但姓名不对，照样拒绝", () => {
    const { db, clock } = world();
    assert.throws(
      () =>
        registerStudent(db, {
          studentId: "s01",
          name: "别人",
          initialPassword: ID6,
          clock,
        }),
      (e) => e instanceof AuthError && e.code === "NAME_MISMATCH",
      "只对学号不对姓名的话，随便填个名字就能把别人的账号占掉",
    );
  });

  test("不能重复注册", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    assert.throws(
      () =>
        registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock }),
      (e) => e instanceof AuthError && e.code === "ALREADY_REGISTERED",
    );
  });

  test("初始密码太短被拒绝，且不留下账号", () => {
    const { db, clock } = world();
    assert.throws(() =>
      registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: "123", clock }),
    );
    assert.equal(hasAccount(db, "s01"), false, "失败的注册不该留下半截账号");
  });

  test("★ 系统里不存明文密码", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    const row = db
      .prepare("SELECT password_hash FROM users WHERE id = 's01'")
      .get() as { password_hash: string };

    assert.ok(!row.password_hash.includes(ID6), "身份证后 6 位严禁明文落库");
    assert.match(row.password_hash, /^scrypt\$/);
  });
});

// ---------------------------------------------------------------------------
// 3. 登录
// ---------------------------------------------------------------------------

describe("登录", () => {
  test("初始密码可以登录，并被要求改密", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    const result = login(db, { userId: "s01", password: ID6 });
    assert.equal(result.account.studentId, "s01");
    assert.equal(result.mustChangePassword, true);
  });

  test("★ 账号不存在与密码错误，报错完全相同", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    let notFound = "";
    let wrongPassword = "";
    let codeA = "";
    let codeB = "";

    try {
      login(db, { userId: "s99", password: ID6 });
    } catch (e) {
      notFound = (e as Error).message.replace(/（.*）/, "");
      codeA = (e as AuthError).code;
    }
    try {
      login(db, { userId: "s01", password: "000000" });
    } catch (e) {
      wrongPassword = (e as Error).message.replace(/（.*）/, "");
      codeB = (e as AuthError).code;
    }

    assert.equal(
      notFound,
      wrongPassword,
      "分开报错等于送给攻击者一个账号枚举接口",
    );
    assert.equal(codeA, codeB);
    assert.equal(codeA, "INVALID_CREDENTIALS");
  });

  test("★ 账号不存在时也消耗同等的计算时间（防时序侧信道）", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    const time = (fn: () => void): number => {
      const start = process.hrtime.bigint();
      try {
        fn();
      } catch {
        /* 预期抛错 */
      }
      return Number(process.hrtime.bigint() - start);
    };

    // 各跑几轮取最短，去掉 JIT 与调度噪声
    const sample = (userId: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i += 1) {
        best = Math.min(best, time(() => login(db, { userId, password: "000000" })));
      }
      return best;
    };

    const existing = sample("s01");
    const missing = sample("s99");

    // 只要"不存在"这条路真的走了哈希，两者应在同一量级。
    // 阈值取得很宽松，只要求缺失分支不是"立刻返回"。
    const ratio = missing / existing;
    assert.ok(
      ratio > 0.2,
      `账号不存在的分支明显更快（比值 ${ratio.toFixed(2)}）——` +
        `时序本身就把"这个学号存不存在"说出来了`,
    );
  });

  test("停用的账号登不进去", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });
    setAccountStatus(db, { userId: "s01", status: "DISABLED", by: "teacher" });

    assert.throws(
      () => login(db, { userId: "s01", password: ID6 }),
      (e) => e instanceof AuthError && e.code === "ACCOUNT_DISABLED",
    );
  });

  test("★ 不能停用自己 —— 停用之后就再也登不进来", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    assert.throws(
      () =>
        setAccountStatus(db, { userId: "s01", status: "DISABLED", by: "s01" }),
      (e) => e instanceof AuthError && e.code === "CANNOT_DISABLE_SELF",
    );
    assert.equal(getAccount(db, "s01").status, "ACTIVE");
  });

  test("★ 不能停用最后一个还能登录的管理员", () => {
    const { db, clock } = world();
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, must_change_password, status, created_at) VALUES ('teacher', NULL, '学院老师', ?, 0, 'ACTIVE', ?)",
    ).run(hashPassword("whatever"), T0);
    bootstrapAdmin(db, "teacher", clock);

    assert.throws(
      () =>
        setAccountStatus(db, {
          userId: "teacher",
          status: "DISABLED",
          by: "someone-else",
        }),
      (e) => e instanceof AuthError && e.code === "LAST_ACTIVE_ADMIN",
      "这是系统唯一的运营入口，关上就没人能创建周期、导入名册、任命主席了",
    );
  });

  test("停用是可逆的，资料和分数都还在", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    setAccountStatus(db, { userId: "s01", status: "DISABLED", by: "teacher" });
    const back = setAccountStatus(db, { userId: "s01", status: "ACTIVE", by: "teacher" });

    assert.equal(back.status, "ACTIVE");
    assert.equal(login(db, { userId: "s01", password: ID6 }).account.id, "s01");
  });
});

// ---------------------------------------------------------------------------
// 4. 改密
// ---------------------------------------------------------------------------

describe("改密", () => {
  test("改密成功后不再要求改密", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    const account = changePassword(db, {
      userId: "s01",
      oldPassword: ID6,
      newPassword: "newpass123",
      clock,
    });

    assert.equal(account.mustChangePassword, false);
    assert.equal(login(db, { userId: "s01", password: "newpass123" }).mustChangePassword, false);
  });

  test("旧密码不对改不了", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    assert.throws(
      () =>
        changePassword(db, {
          userId: "s01",
          oldPassword: "000000",
          newPassword: "newpass123",
          clock,
        }),
      (e) => e instanceof AuthError && e.code === "INVALID_CREDENTIALS",
    );
  });

  test("新密码与旧密码相同被拒绝", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    assert.throws(
      () =>
        changePassword(db, {
          userId: "s01",
          oldPassword: ID6,
          newPassword: ID6,
          clock,
        }),
      (e) => e instanceof AuthError && e.code === "PASSWORD_UNCHANGED",
    );
  });

  test("改密失败时原密码仍然有效", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    assert.throws(() =>
      changePassword(db, {
        userId: "s01",
        oldPassword: ID6,
        newPassword: "短",
        clock,
      }),
    );

    assert.equal(login(db, { userId: "s01", password: ID6 }).account.id, "s01");
  });

  test("改密后旧密码失效", () => {
    const { db, clock } = world();
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });
    changePassword(db, { userId: "s01", oldPassword: ID6, newPassword: "newpass123", clock });

    assert.throws(() => login(db, { userId: "s01", password: ID6 }));
  });
});

// ---------------------------------------------------------------------------
// 5. 重置
// ---------------------------------------------------------------------------

describe("重置密码", () => {
  test("管理员可以重置任何人的密码", () => {
    const { db, clock } = world();
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('teacher', NULL, '老师', 'x', ?)",
    ).run(T0);
    bootstrapAdmin(db, "teacher", clock);
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    const { tempPassword } = resetPassword(db, { userId: "s01", by: "teacher", clock });

    assert.ok(tempPassword.length >= 10);
    assert.equal(login(db, { userId: "s01", password: tempPassword }).mustChangePassword, true);
  });

  test("★ 本部门部长可以重置干事密码", () => {
    const { db, clock } = world();
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('teacher', NULL, '老师', 'x', ?)",
    ).run(T0);
    bootstrapAdmin(db, "teacher", clock);

    // s09 当部长
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('s09', 's09', '部长丁', 'x', ?)",
    ).run(T0);
    appointDeptLead(db, {
      userId: "s09",
      departmentId: DEPT,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    // s01 加入体育部
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });
    const app = applyToJoin(db, { userId: "s01", departmentId: DEPT, note: null, clock });
    approveJoin(db, { applicationId: app.id, by: "s09", clock });

    const { tempPassword } = resetPassword(db, { userId: "s01", by: "s09", clock });
    assert.equal(login(db, { userId: "s01", password: tempPassword }).account.id, "s01");
  });

  test("★ 别的部门的人不能重置", () => {
    const { db, clock } = world();
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('teacher', NULL, '老师', 'x', ?)",
    ).run(T0);
    bootstrapAdmin(db, "teacher", clock);

    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('s09', 's09', '部长丁', 'x', ?)",
    ).run(T0);
    appointDeptLead(db, {
      userId: "s09",
      departmentId: DEPT,
      role: "HEAD",
      by: "teacher",
      clock,
    });

    registerStudent(db, { studentId: "s03", name: "学生丙", initialPassword: ID6, clock });

    assert.throws(
      () => resetPassword(db, { userId: "s03", by: "s09", clock }),
      (e) => e instanceof AuthError && e.code === "NOT_ALLOWED_TO_RESET",
    );
  });

  test("重置出来的密码不是身份证后 6 位", () => {
    const { db, clock } = world();
    db.prepare(
      "INSERT INTO users (id, student_id, display_name, password_hash, created_at) VALUES ('teacher', NULL, '老师', 'x', ?)",
    ).run(T0);
    bootstrapAdmin(db, "teacher", clock);
    registerStudent(db, { studentId: "s01", name: "学生甲", initialPassword: ID6, clock });

    const { tempPassword } = resetPassword(db, { userId: "s01", by: "teacher", clock });

    assert.notEqual(
      tempPassword,
      ID6,
      "重置成初始密码意味着任何知道该生身份证号的人都能登进去",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. 账号读取
// ---------------------------------------------------------------------------

describe("账号读取", () => {
  test("读不到的账号抛错而不是返回空", () => {
    const { db } = world();
    assert.throws(
      () => getAccount(db, "不存在"),
      (e) => e instanceof AuthError && e.code === "ACCOUNT_NOT_FOUND",
    );
  });
});

/**
 * 迁移 006 —— 账号、管理员、任职、加入申请
 *
 * 一条设计要点：**任职记录（memberships）不可改写。**
 *
 * 任命与免职都是事实。谁任命的、什么时候任的、什么时候离的，都必须留得住 ——
 * 否则换届之后就再也回答不了"去年这 6 分是谁批的"。
 *
 * 因此 memberships 只允许 INSERT，以及**唯一一种** UPDATE：
 * 写入离任时间（ended_at / ended_by）。其余字段一律锁死。
 * 想重新任命？插一条新记录，历史留着。
 */

export const id = "006_identity_membership";

export const sql = `
-- ---------------------------------------------------------------------------
-- 账号
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                   TEXT PRIMARY KEY,      -- 登录名。学生账号即学号
  student_id           TEXT REFERENCES students(id),  -- 学生账号才有
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  -- 初始密码（身份证后 6 位）登录后必须改掉
  must_change_password INTEGER NOT NULL DEFAULT 1
                         CHECK (must_change_password IN (0, 1)),
  status               TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at           TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 管理员
--
-- 单独一张表，刻意不放进 memberships：
-- 管理员是"维护系统的人"，不是学生会的职位。混在一起会让人以为
-- 管理员是学生组织里的一个头衔，而它的实际含义是"能改配置的人"。
-- ---------------------------------------------------------------------------
CREATE TABLE admins (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  appointed_by TEXT NOT NULL,
  appointed_at TEXT NOT NULL,
  revoked_at   TEXT
);

-- ---------------------------------------------------------------------------
-- 任职记录（学生会职位）
--
-- CHAIR 不挂部门（department_id 为 NULL），其余职位必须挂部门。
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  department_id INTEGER REFERENCES departments(id),
  role          TEXT NOT NULL CHECK (role IN ('CHAIR', 'HEAD', 'DEPUTY', 'MEMBER')),
  appointed_by  TEXT NOT NULL,
  appointed_at  TEXT NOT NULL,
  ended_at      TEXT,
  ended_by      TEXT,

  CHECK (
    (role = 'CHAIR' AND department_id IS NULL) OR
    (role <> 'CHAIR' AND department_id IS NOT NULL)
  )
);

CREATE INDEX idx_memberships_user ON memberships (user_id, ended_at);
CREATE INDEX idx_memberships_dept ON memberships (department_id, role, ended_at);

-- 任命记录不可改写，只能补一笔离任时间
CREATE TRIGGER memberships_no_rewrite
BEFORE UPDATE ON memberships
WHEN OLD.user_id       IS NOT NEW.user_id
  OR OLD.department_id IS NOT NEW.department_id
  OR OLD.role          IS NOT NEW.role
  OR OLD.appointed_by  IS NOT NEW.appointed_by
  OR OLD.appointed_at  IS NOT NEW.appointed_at
BEGIN
  SELECT RAISE(ABORT, 'MEMBERSHIP_IMMUTABLE: 任命记录不可改写，只能写入离任时间');
END;

CREATE TRIGGER memberships_no_delete
BEFORE DELETE ON memberships
BEGIN
  SELECT RAISE(ABORT, 'MEMBERSHIP_IMMUTABLE: 任职记录不可删除');
END;

-- ---------------------------------------------------------------------------
-- 干事加入申请
--
-- 学生自己选部门，但要部长审批通过才算数。
-- 这一条直接关系到 A2-1 学生干部任职加分（6 分）：
-- 如果注册时勾一下就是干事，那就是白送 6 分 —— 比人情分还容易。
-- ---------------------------------------------------------------------------
CREATE TABLE join_applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  note          TEXT,
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_join_applications_dept
  ON join_applications (department_id, status);
`;

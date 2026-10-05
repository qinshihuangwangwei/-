/**
 * 迁移 001 —— 初始化账本世界
 *
 * 对应设计文档 §4「数据模型」与 §5「追加式账本」。
 *
 * 本迁移只建"账本活下去所必需"的最小表集合：
 *   terms / students / scoring_items / score_events
 * 其余表（departments、memberships、slices、appeals、objections…）留到后续迁移。
 */

export const id = "001_init";

export const sql = `
-- 注：schema_migrations 由迁移执行器（src/db/migrate.ts）负责创建，此处不重复建。

-- ---------------------------------------------------------------------------
-- 周期
-- ---------------------------------------------------------------------------
CREATE TABLE terms (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 学生
-- ---------------------------------------------------------------------------
CREATE TABLE students (
  id         TEXT PRIMARY KEY,        -- 学号
  name       TEXT NOT NULL,
  class_name TEXT NOT NULL,
  grade      INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 计分项
--
-- mode 字段对应设计文档 §5.6：真实数据显示 A6 遵纪守法恒为 5 分，
-- 是"基线制"（默认给分、只录扣分），而非"不申请就 0"的累加制。
-- 把这两种模式混为一谈会让每名学生凭空少 5 分，且因为所有人一起少，
-- 排名看起来依然正常，没有任何人会察觉。
-- ---------------------------------------------------------------------------
CREATE TABLE scoring_items (
  id         INTEGER PRIMARY KEY,
  group_code TEXT NOT NULL,           -- 'A1'..'A8' | 'C'
  name       TEXT NOT NULL,
  cap        REAL NOT NULL,           -- 分值上限
  mode       TEXT NOT NULL CHECK (mode IN ('ACCUMULATE', 'BASELINE')),
  baseline   REAL NOT NULL DEFAULT 0  -- BASELINE 模式的基准分
);

-- ---------------------------------------------------------------------------
-- 追加式账本
--
-- 这张表只允许 INSERT。任何"修改"都表现为追加一条新事件。
-- ---------------------------------------------------------------------------
CREATE TABLE score_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id         INTEGER NOT NULL REFERENCES terms(id),
  student_id      TEXT    NOT NULL REFERENCES students(id),
  item_id         INTEGER NOT NULL REFERENCES scoring_items(id),
  delta           REAL    NOT NULL,   -- 可正可负
  event_type      TEXT    NOT NULL CHECK (event_type IN (
                            'ENTRY', 'CORRECTION', 'APPEAL_GRANT',
                            'OBJECTION_GRANT', 'REJECT', 'IMPORT')),
  actor_id        TEXT    NOT NULL,
  reason          TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  source_event_id INTEGER REFERENCES score_events(id),
  appeal_id       INTEGER,
  objection_id    INTEGER,
  created_at      TEXT    NOT NULL,
  prev_hash       TEXT    NOT NULL CHECK (length(prev_hash) = 64),
  self_hash       TEXT    NOT NULL CHECK (length(self_hash) = 64)
);

CREATE INDEX idx_score_events_lookup
  ON score_events (term_id, student_id, item_id);

-- ---------------------------------------------------------------------------
-- 物理不可改删
--
-- SQLite 没有 REVOKE（那是 MySQL/Postgres 的语法），也没有权限系统，
-- 实际强制手段是触发器。它挡得住所有 SQL 层的 UPDATE/DELETE，
-- 但挡不住 DROP TRIGGER 之后的篡改 —— 挡住那一类攻击的是哈希链本身。
-- 三层缺一不可：触发器挡日常，哈希链挡内部，外部存档挡有完整库权限的人。
-- ---------------------------------------------------------------------------
CREATE TRIGGER score_events_no_update
BEFORE UPDATE ON score_events
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: UPDATE forbidden on score_events');
END;

CREATE TRIGGER score_events_no_delete
BEFORE DELETE ON score_events
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: DELETE forbidden on score_events');
END;
`;

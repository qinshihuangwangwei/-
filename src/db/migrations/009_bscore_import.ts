/**
 * 迁移 009 —— B 项成绩与导入审计
 *
 * 设计文档附录 C.6 / C.7。两条设计约束落在这里：
 *
 * 1. **B 项不进入 A/C 账本。**
 *    `score_events` 只承载"由人给出、需要理由和材料"的分（A 项与 C 项）。
 *    B 项是**导入的事实数据**，不产生 delta 事件，单独存 `b_scores`。
 *    区分标准是：**账本记录「人的判断」，导入记录「数据的搬运」。**
 *
 * 2. **导入动作本身必须可审计。**
 *    每次导入都留一条不可改的记录：原始文件哈希、识别出的列映射、
 *    解析/写入/跳过各多少行、谁在什么时候做的。
 *    日后任何时候都能回答"这个 B 分是从哪份文件、哪一列来的"。
 */

export const id = "009_bscore_import";

export const sql = `
-- ---------------------------------------------------------------------------
-- B 项成绩
--
-- 以 (term_id, student_id) 为唯一键：同一学期重复导入是 UPSERT，
-- 结果与导入一次相同（附录 D 的幂等要求）。
-- ---------------------------------------------------------------------------
CREATE TABLE b_scores (
  term_id    INTEGER NOT NULL REFERENCES terms(id),
  student_id TEXT    NOT NULL REFERENCES students(id),
  score      REAL    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (term_id, student_id)
);

CREATE INDEX idx_b_scores_student ON b_scores (student_id);

-- ---------------------------------------------------------------------------
-- 导入审计
-- ---------------------------------------------------------------------------
CREATE TABLE import_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT    NOT NULL CHECK (kind IN ('ROSTER', 'BSCORE', 'CSCORE')),
  term_id           INTEGER REFERENCES terms(id),

  filename          TEXT    NOT NULL,
  file_sha256       TEXT    NOT NULL,
  -- 归档后的原始文件路径。永久保留，供日后核对。
  archived_path     TEXT,

  -- 识别出的列映射：{"studentId":"A","score":"G"}
  mapping_json      TEXT    NOT NULL,
  sheet_name        TEXT,

  parsed_rows       INTEGER NOT NULL,
  inserted          INTEGER NOT NULL,
  updated           INTEGER NOT NULL,
  unchanged         INTEGER NOT NULL,
  skipped           INTEGER NOT NULL,
  unknown_students  INTEGER NOT NULL,

  actor_id          TEXT    NOT NULL,
  created_at        TEXT    NOT NULL
);

CREATE INDEX idx_import_jobs_term ON import_jobs (term_id, kind, id);

-- 审计记录只增不改：如果"某次导入"能被悄悄抹掉，那它就不算审计
CREATE TRIGGER import_jobs_no_update
BEFORE UPDATE ON import_jobs
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE: UPDATE forbidden on import_jobs');
END;

CREATE TRIGGER import_jobs_no_delete
BEFORE DELETE ON import_jobs
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE: DELETE forbidden on import_jobs');
END;
`;

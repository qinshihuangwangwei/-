/**
 * 迁移 013 —— 导入审计不再外键引用周期
 *
 * ## 这是一次"两个正确决定撞在一起"的修复
 *
 * 三条规则各自都对：
 *
 *   1. **审计只增不改**（`import_jobs` 有 BEFORE UPDATE / DELETE 触发器）——
 *      如果"某次导入"能被悄悄抹掉，那它就不算审计。这是这个项目的核心。
 *   2. **零账本足迹的周期可以删除** —— 否则建错的周期永远清不掉。
 *   3. `import_jobs.term_id` 指向 `terms(id)` —— 正常的规范化。
 *
 * 合在一起得到一个谁都没想要的结果：
 *
 *   **任何做过导入的周期都永远删不掉。**
 *
 * 删周期 → 被外键挡住；想解除关联 → `UPDATE` 被触发器挡住；
 * 想连审计一起删 → `DELETE` 也被触发器挡住。三条路全封死。
 * 使用者看到的是 `FOREIGN KEY constraint failed`，一句没人能据此行动的话。
 *
 * ## 为什么去掉外键，而不是放松触发器
 *
 * 审计记录说的是：「某天，某人，把某个文件导入了 **2 号周期**」。
 * 这句话在 2 号周期被删掉之后**依然为真** —— 它描述的是过去发生的事。
 *
 * 外键要求被引用的行必须存在，等于要求**过去不能消失**。
 * 一条审计如果要靠删除它记录的对象才能删除，那它就没有独立的价值。
 * **审计必须能比它的记录对象活得久**，这是它存在的意义。
 *
 * 所以：`term_id` 退化成一个普通的历史标注 —— 数字留着，
 * 只是不再要求那个周期还在。查不到对应周期，就是查不到。
 *
 * ## 数据与触发器原样保留
 *
 * 表重建（SQLite 不支持直接删外键），但：
 *   · 所有行原样搬过去，一列不动
 *   · 两个不可改触发器原样重建 —— 这次修复**不放松任何审计约束**
 *   · 索引原样重建
 */

export const id = "013_audit_no_term_fk";

export const sql = `
CREATE TABLE import_jobs_rebuilt (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT    NOT NULL CHECK (kind IN ('ROSTER', 'BSCORE', 'CSCORE')),

  -- 历史标注：这条导入是**为哪个周期**做的。
  -- 刻意不加 REFERENCES：周期可以被删，而这条记录不会跟着消失 ——
  -- 它描述的是过去发生的事，不要求那个周期还在。
  term_id           INTEGER,

  filename          TEXT    NOT NULL,
  file_sha256       TEXT    NOT NULL,
  archived_path     TEXT,
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

INSERT INTO import_jobs_rebuilt (
  id, kind, term_id, filename, file_sha256, archived_path, mapping_json, sheet_name,
  parsed_rows, inserted, updated, unchanged, skipped, unknown_students, actor_id, created_at
)
SELECT
  id, kind, term_id, filename, file_sha256, archived_path, mapping_json, sheet_name,
  parsed_rows, inserted, updated, unchanged, skipped, unknown_students, actor_id, created_at
FROM import_jobs;

DROP TABLE import_jobs;
ALTER TABLE import_jobs_rebuilt RENAME TO import_jobs;

CREATE INDEX idx_import_jobs_term ON import_jobs (term_id, kind, id);

-- 审计记录只增不改 —— 与迁移 009 完全一致，这次修复没有放松任何约束
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

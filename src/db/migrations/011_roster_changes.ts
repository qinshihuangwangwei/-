/**
 * 迁移 011 —— 名册人工改动
 *
 * 导入有 `import_jobs` 留痕，但"手动加一个学生"如果什么都不记，
 * 它就成了一条暗门：谁都能悄悄往名册里塞一个人，而这个人之后是要拿分的。
 *
 * 名册是所有分数的**归属基础**。多一个人、少一个人、班级错了，
 * 影响的不是一条记录，而是这个人在所有计分项上的归属。
 * 因此它和分数一样需要留痕。
 *
 * 与其它审计表一致：只增不改、不可删除。
 */

export const id = "011_roster_changes";

export const sql = `
CREATE TABLE roster_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,

  student_id TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('ADD', 'UPDATE')),

  -- 改动后的值
  name       TEXT NOT NULL,
  class_name TEXT NOT NULL,
  grade      INTEGER NOT NULL,

  -- 改动前的值（新增时为 NULL）
  previous_name       TEXT,
  previous_class_name TEXT,

  actor_id   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_roster_changes_student ON roster_changes (student_id, id);
CREATE INDEX idx_roster_changes_actor ON roster_changes (actor_id, id);

CREATE TRIGGER roster_changes_no_update
BEFORE UPDATE ON roster_changes
BEGIN
  SELECT RAISE(ABORT, 'ROSTER_AUDIT_IMMUTABLE: UPDATE forbidden on roster_changes');
END;

CREATE TRIGGER roster_changes_no_delete
BEFORE DELETE ON roster_changes
BEGIN
  SELECT RAISE(ABORT, 'ROSTER_AUDIT_IMMUTABLE: DELETE forbidden on roster_changes');
END;
`;

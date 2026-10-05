/**
 * 迁移 007 —— 计分项责任指派
 *
 * 「哪个部门负责哪个计分项」每学期由主席或管理员指派一次，
 * 并且**改派要留历史**。
 *
 * 与任职记录同理：指派是事实。换了部门负责，旧记录必须留着 ——
 * 否则学期末追责时会发现"这一项到底是谁做的"变成了罗生门。
 *
 * 因此本表只允许 INSERT，以及唯一一种 UPDATE：写入撤销时间。
 */

export const id = "007_item_assignments";

export const sql = `
CREATE TABLE item_assignments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id       INTEGER NOT NULL REFERENCES terms(id),
  item_id       INTEGER NOT NULL REFERENCES scoring_items(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),

  assigned_by   TEXT NOT NULL,
  assigned_at   TEXT NOT NULL,

  revoked_at    TEXT,
  revoked_by    TEXT,
  revoke_reason TEXT
);

-- 一个周期里，同一个计分项同时只能有一个责任部门
CREATE UNIQUE INDEX idx_item_assignments_active
  ON item_assignments (term_id, item_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_item_assignments_dept
  ON item_assignments (term_id, department_id);

-- 指派记录不可改写，只能补一笔撤销时间
CREATE TRIGGER item_assignments_no_rewrite
BEFORE UPDATE ON item_assignments
WHEN OLD.term_id       IS NOT NEW.term_id
  OR OLD.item_id       IS NOT NEW.item_id
  OR OLD.department_id IS NOT NEW.department_id
  OR OLD.assigned_by   IS NOT NEW.assigned_by
  OR OLD.assigned_at   IS NOT NEW.assigned_at
BEGIN
  SELECT RAISE(ABORT, 'ASSIGNMENT_IMMUTABLE: 指派记录不可改写，只能写入撤销时间');
END;

CREATE TRIGGER item_assignments_no_delete
BEFORE DELETE ON item_assignments
BEGIN
  SELECT RAISE(ABORT, 'ASSIGNMENT_IMMUTABLE: 指派记录不可删除');
END;
`;

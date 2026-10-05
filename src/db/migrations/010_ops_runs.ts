/**
 * 迁移 010 —— 运维任务记录
 *
 * 每日快照与链尾哈希存档都要留痕。理由不是"留个日志好看"，
 * 而是：**失败必须看得见。**
 *
 * 一个每天默默失败的备份任务，比没有备份更危险 ——
 * 它让人以为自己有备份。因此这里的记录有两种状态，
 * 而 `FAILED` 会在管理页上显示成告警。
 */

export const id = "010_ops_runs";

export const sql = `
CREATE TABLE ops_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('SNAPSHOT', 'ANCHOR', 'VERIFY', 'DELIVER')),
  status        TEXT    NOT NULL CHECK (status IN ('OK', 'FAILED')),

  -- 人类可读的结果说明。失败时这里是原因，成功时是产出物的摘要。
  detail        TEXT    NOT NULL,
  artifact_path TEXT,

  -- 这一轮任务对应的业务日期（YYYY-MM-DD），用于"每天只跑一次"
  op_date       TEXT    NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 1,

  created_at    TEXT    NOT NULL
);

CREATE INDEX idx_ops_runs_date ON ops_runs (op_date, kind);
CREATE INDEX idx_ops_runs_status ON ops_runs (status, id);

-- 运维记录只增不改：如果失败记录可以被抹掉，告警就没有意义
CREATE TRIGGER ops_runs_no_update
BEFORE UPDATE ON ops_runs
BEGIN
  SELECT RAISE(ABORT, 'OPS_IMMUTABLE: UPDATE forbidden on ops_runs');
END;

CREATE TRIGGER ops_runs_no_delete
BEFORE DELETE ON ops_runs
BEGIN
  SELECT RAISE(ABORT, 'OPS_IMMUTABLE: DELETE forbidden on ops_runs');
END;
`;

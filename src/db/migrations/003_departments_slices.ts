/**
 * 迁移 003 —— 部门与切片
 *
 * 切片（Slice）= 计分项 × 年级，是录入与审批的最小单位。
 * 一个学期约 26 个计分项 × 4 个年级 = 104 个切片。
 */

export const id = "003_departments_slices";

export const sql = `
CREATE TABLE departments (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE slices (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL REFERENCES terms(id),
  item_id INTEGER NOT NULL REFERENCES scoring_items(id),
  grade   INTEGER NOT NULL,

  -- 负责人。可为空 —— 空表示"没人认领"。
  -- 未分派的切片不允许任何人录入，且会在公示页显式标注（设计文档 §6.2）。
  owner_id TEXT,

  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'SUBMITTED', 'REVIEWED', 'FROZEN')),

  submitted_at TEXT,
  reviewed_at  TEXT,
  frozen_at    TEXT,

  -- 一个周期里，同一个计分项 + 同一个年级只有一个切片
  UNIQUE (term_id, item_id, grade)
);

CREATE INDEX idx_slices_term_status ON slices (term_id, status);
`;

/**
 * 迁移 002 —— 周期状态机所需的字段
 *
 * 注意这里**故意没有**任何 `appeal_window` / `deadline` / `extend` 之类的列。
 * 窗口时长是代码里的常量（`src/domain/term.ts`），不是数据库配置。
 *
 * 理由：任何可配置的东西，最终都会有人去配置它。一个"紧急延长窗口"的开关，
 * 只会在最需要它的那一刻被打开 —— 而那正是它不该被打开的时刻。
 * `tests/invariants/term.test.ts` 里有一条结构性断言守着这一点。
 */

export const id = "002_term_state";

export const sql = `
ALTER TABLE terms ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'
  CHECK (status IN ('DRAFT', 'ASSIGNING', 'ENTERING', 'PUBLISHED', 'PUBLIC', 'ARCHIVED'));

-- 发布时刻。一经写入不再改动，72 小时窗口从它起算。
ALTER TABLE terms ADD COLUMN published_at TEXT;

-- 归档时刻。仅由定时任务物化，不参与任何授权判定。
ALTER TABLE terms ADD COLUMN archived_at TEXT;
`;

/**
 * 迁移 015 —— 记下每一步流转是谁做的
 *
 * ## 起因
 *
 * `slices` 表原来只有三个时间戳：`submitted_at` / `reviewed_at` / `frozen_at`。
 * **没有记是谁做的。**
 *
 * 于是"这一片是谁批准的"这个问题在数据里根本无从回答 ——
 * 而整套系统的卖点就是可追溯。分数事件记得清清楚楚（`score_events.actor_id`），
 * 但把它冻结起来的那一步反而是一片空白。
 *
 * 这个缺口平时不显形，一旦有人问"这一项的分是谁拍板的"就露出来了：
 * 页面上只能显示"已冻结"，显示不出"谁冻的"。
 *
 * 它还挡住了另一件事：**没法在数据上验证职责分离**。
 * 想加"不能批准自己负责的切片"这条守卫，就得先能看见谁批的 ——
 * 否则规则写在代码里，而历史记录里看不出它有没有被绕过。
 *
 * ## 为什么是加列而不是新建审计表
 *
 * 这三步各发生**一次**，是切片自身的属性，不是流水。
 * 建成一对多只会让"当前复核人是谁"要靠 ORDER BY 才能查出来。
 *
 * 旧数据留空。**不猜、不回填** —— 那些切片在加列之前确实没有记录，
 * 这一点应该如实保留，而不是从别处推一个看上去合理的名字填进去。
 * 页面上显示成"未记录"比显示一个猜出来的名字诚实得多。
 */

export const id = "015_slice_transition_actors";

export const sql = `
ALTER TABLE slices ADD COLUMN submitted_by TEXT;
ALTER TABLE slices ADD COLUMN reviewed_by  TEXT;
ALTER TABLE slices ADD COLUMN approved_by  TEXT;

-- 按人查"我都做过什么"会用到，也方便核对职责分离
CREATE INDEX idx_slices_reviewed_by ON slices (reviewed_by);
CREATE INDEX idx_slices_approved_by ON slices (approved_by);
`;

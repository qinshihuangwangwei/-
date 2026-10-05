/**
 * 迁移 004 —— 发布者留痕
 *
 * 发布是本系统里最重的一个动作：它决定了申诉窗口从哪一刻起算。
 * 谁按下了这个按钮，必须能被回答。
 */

export const id = "004_term_publisher";

export const sql = `
ALTER TABLE terms ADD COLUMN published_by TEXT;
`;

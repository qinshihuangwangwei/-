/**
 * 迁移 012 —— 管理员罢免留痕
 *
 * `admins` 表原来只有 `appointed_by`，没有"谁罢免的"。
 * 罢免本身会写 `revoked_at`，所以"什么时候没的"查得到；
 * 但"谁撤的"查不到 —— 而管理员是系统里权限最大的身份，
 * 涉及它的每一个动作都该能追到人。
 *
 * `Membership` 那张表早就有 `ended_by` 了（任免是留痕的），
 * 管理员这边漏了一个对称的字段。补上。
 *
 * 只加列，不改任何已有数据。历史记录里这一列是 NULL ——
 * 那时候确实没记，如实留空，不编一个。
 */

export const id = "012_admin_revoked_by";

export const sql = `
ALTER TABLE admins ADD COLUMN revoked_by TEXT;
`;

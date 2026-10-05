/**
 * 迁移 014 —— 清掉"已经有职务、申请却还挂着"的加入申请
 *
 * ## 症状
 *
 * 真实数据里出过这样一条：
 *
 *     #1  2599000023（吴佳琪）→ 办公室  [PENDING]
 *
 * 而她**已经是办公室的部长**。
 *
 * 起因是两个人操作的时间差：她先提交了加入办公室的申请，
 * 之后（在申请还没被批准的情况下）被任命成了部长。
 * `insertMembership` 当时只管写职务，不管那条申请。
 *
 * 后果是这条申请**谁也处理不掉**：
 *
 *   · 她自己打开「我的」页看不到它 —— `membershipState` 先看职务，显示的是"办公室 / 部长"
 *   · 部门部长打开「本部门」页却看得到它，挂在「待审批的加入申请」里
 *   · 真去点「批准」，`approveJoin` 的 `assertNoActiveMembership` 会把它挡回去
 *
 * 于是它变成一条"看得见、批不动、也没人知道该怎么处理"的记录 ——
 * 而且它**看起来就像"已经是成员的人还能选部门"**，这正是使用者报的那个现象。
 *
 * ## 修法
 *
 * 代码侧：`insertMembership` 现在会把该用户所有 PENDING 申请一并置为 `WITHDRAWN`。
 * 数据侧：这条迁移把已经产生的历史脏数据清掉。
 *
 * 用 `WITHDRAWN` 而不是删除 —— 申请是发生过的事，留着，只是标成作废。
 * 这个状态在迁移 006 建表时就在 CHECK 约束里，本来就是为这种情况准备的。
 *
 * `decided_by` 记 `system:migration-014` 而不是某个人的名字：
 * **这条记录不是人点的，就不该写成人点的。** 审计里的人名一旦开始不准确，
 * 整条记录就都不可信了。
 */

export const id = "014_withdraw_stale_join_applications";

export const sql = `
UPDATE join_applications
   SET status     = 'WITHDRAWN',
       decided_by = 'system:migration-014',
       decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'PENDING'
   AND EXISTS (
         SELECT 1 FROM memberships m
          WHERE m.user_id = join_applications.user_id
            AND m.ended_at IS NULL
       );
`;

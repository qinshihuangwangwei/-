/**
 * 测试夹具：把一个周期准备到"可以进入录入"的状态
 *
 * 因为未指派责任部门就进不了录入状态（设计文档 §3.1），
 * 任何需要推进周期状态的测试都得先完成指派。
 *
 * 这里刻意**显式指派**那四个 `needsConfirmation` 的计分项，
 * 而不是让 `assignDefaults` 顺手带上 —— 生产代码里它们必须由人决定，
 * 测试里也一样。绕过守卫的测试夹具，会让守卫看起来比实际更牢固。
 */

import type { DatabaseSync } from "node:sqlite";

import { seedReferenceData, DEPARTMENT_ID } from "../../src/db/seed.ts";
import {
  assignDefaults,
  assignItem,
  unassignedItems,
} from "../../src/domain/assignment.ts";
import type { Clock } from "../../src/domain/clock.ts";

export const OFFICE = DEPARTMENT_ID["办公室"]!;
export const SPORTS = DEPARTMENT_ID["体育部"]!;

/** 播种参考数据，并把全部计分项指派完 —— 含需要人工决定的四项 */
export function seedAndAssignAll(
  db: DatabaseSync,
  termId: number,
  clock: Clock,
  by = "admin",
  fallbackDepartment = OFFICE,
): void {
  seedReferenceData(db);
  assignDefaults(db, { termId, by, clock });

  for (const item of unassignedItems(db, termId)) {
    assignItem(db, {
      termId,
      itemId: item.id,
      departmentId: fallbackDepartment,
      by,
      reason: "测试夹具：显式决定存疑计分项的归属",
      clock,
    });
  }
}

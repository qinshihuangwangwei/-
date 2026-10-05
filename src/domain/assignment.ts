/**
 * 计分项责任指派
 *
 * 设计文档 §3.1。**每学期由主席或管理员逐项指派「计分项 → 责任部门」。**
 *
 * 为什么必须是可配置的数据而不是写死在代码里：
 * A 项细则每年会变，各院归属也不同。需求方本人也无法确认 12 个部门与
 * 26 个计分项的准确对应关系 —— 有 4 项至今存疑（见 `needsConfirmation`）。
 * 写死必然错，而且错了要改代码。
 *
 * 最关键的一条守卫：**有任何一个计分项未指派，周期不允许进入录入状态。**
 * 未指派即禁止录入，而不是默认归某人 —— 默认值就是人情分的温床。
 */

import type { DatabaseSync } from "node:sqlite";

import { transaction } from "../db/db.ts";
import { SCORING_ITEMS, DEPARTMENT_ID } from "../db/seed.ts";
import { listItems, type ScoringItem } from "./item.ts";
import type { Clock } from "./clock.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ItemAssignment {
  id: number;
  termId: number;
  itemId: number;
  departmentId: number;
  assignedBy: string;
  assignedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export class AssignmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AssignmentError";
    this.code = code;
  }
}

interface AssignmentRow {
  id: number;
  term_id: number;
  item_id: number;
  department_id: number;
  assigned_by: string;
  assigned_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

function toAssignment(raw: Record<string, unknown>): ItemAssignment {
  const row = raw as unknown as AssignmentRow;
  return {
    id: row.id,
    termId: row.term_id,
    itemId: row.item_id,
    departmentId: row.department_id,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
  };
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function activeAssignments(
  db: DatabaseSync,
  termId: number,
): ItemAssignment[] {
  return db
    .prepare(
      `SELECT * FROM item_assignments
        WHERE term_id = ? AND revoked_at IS NULL ORDER BY item_id`,
    )
    .all(termId)
    .map(toAssignment);
}

/** 某个计分项当前的责任部门；未指派返回 null */
export function departmentOfItem(
  db: DatabaseSync,
  termId: number,
  itemId: number,
): number | null {
  const row = db
    .prepare(
      `SELECT department_id FROM item_assignments
        WHERE term_id = ? AND item_id = ? AND revoked_at IS NULL`,
    )
    .get(termId, itemId) as { department_id: number } | undefined;

  return row?.department_id ?? null;
}

/** 指派历史，含已撤销的 —— 学期末追责靠它 */
export function assignmentHistory(
  db: DatabaseSync,
  termId: number,
  itemId?: number,
): ItemAssignment[] {
  const sql =
    itemId === undefined
      ? "SELECT * FROM item_assignments WHERE term_id = ? ORDER BY item_id, id"
      : "SELECT * FROM item_assignments WHERE term_id = ? AND item_id = ? ORDER BY id";

  const params = itemId === undefined ? [termId] : [termId, itemId];
  return db.prepare(sql).all(...params).map(toAssignment);
}

/** 尚未指派责任部门的计分项 */
export function unassignedItems(db: DatabaseSync, termId: number): ScoringItem[] {
  const assigned = new Set(activeAssignments(db, termId).map((a) => a.itemId));
  return listItems(db).filter((item) => !assigned.has(item.id));
}

/** 某部门在本周期负责的计分项 */
export function itemsOfDepartment(
  db: DatabaseSync,
  termId: number,
  departmentId: number,
): ScoringItem[] {
  const itemIds = new Set(
    activeAssignments(db, termId)
      .filter((a) => a.departmentId === departmentId)
      .map((a) => a.itemId),
  );
  return listItems(db).filter((item) => itemIds.has(item.id));
}

/** 没有任何计分项在手的部门（新闻采编部、宣传部、心理健康部通常在此列） */
export function departmentsWithoutItems(
  db: DatabaseSync,
  termId: number,
): { id: number; name: string }[] {
  const busy = new Set(activeAssignments(db, termId).map((a) => a.departmentId));

  return (
    db.prepare("SELECT id, name FROM departments ORDER BY id").all() as {
      id: number;
      name: string;
    }[]
  ).filter((d) => !busy.has(d.id));
}

// ---------------------------------------------------------------------------
// 指派
// ---------------------------------------------------------------------------

export interface AssignInput {
  termId: number;
  itemId: number;
  departmentId: number;
  by: string;
  reason?: string | null;
  clock: Clock;
}

/**
 * 指派（或改派）一个计分项的责任部门。
 *
 * 改派不做原地修改：先撤销旧记录、再插一条新的。
 * 学期末要能回答"这一项当时是谁负责的"，而不是只知道"现在是谁"。
 */
export function assignItem(db: DatabaseSync, input: AssignInput): ItemAssignment {
  return transaction(db, () => {
    const term = db.prepare("SELECT id FROM terms WHERE id = ?").get(input.termId);
    if (!term) {
      throw new AssignmentError("TERM_NOT_FOUND", `周期 ${input.termId} 不存在`);
    }

    const item = db
      .prepare("SELECT id, group_code, name FROM scoring_items WHERE id = ?")
      .get(input.itemId) as { id: number; group_code: string; name: string } | undefined;
    if (!item) {
      throw new AssignmentError("ITEM_NOT_FOUND", `计分项 ${input.itemId} 不存在`);
    }

    const dept = db
      .prepare("SELECT id, name FROM departments WHERE id = ?")
      .get(input.departmentId) as { id: number; name: string } | undefined;
    if (!dept) {
      throw new AssignmentError(
        "DEPARTMENT_NOT_FOUND",
        `部门 ${input.departmentId} 不存在`,
      );
    }

    const now = input.clock.now().toISOString();
    const current = departmentOfItem(db, input.termId, input.itemId);

    if (current !== null && current === input.departmentId) {
      throw new AssignmentError(
        "ALREADY_ASSIGNED",
        `${item.group_code} ${item.name} 已经由${dept.name}负责，无需重复指派`,
      );
    }

    if (current !== null) {
      db.prepare(
        `UPDATE item_assignments
            SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
          WHERE term_id = ? AND item_id = ? AND revoked_at IS NULL`,
      ).run(
        now,
        input.by,
        input.reason ?? "改派给其他部门",
        input.termId,
        input.itemId,
      );
    }

    const info = db
      .prepare(
        `INSERT INTO item_assignments
           (term_id, item_id, department_id, assigned_by, assigned_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.termId, input.itemId, input.departmentId, input.by, now);

    const row = db
      .prepare("SELECT * FROM item_assignments WHERE id = ?")
      .get(Number(info.lastInsertRowid));

    return toAssignment(row!);
  });
}

export interface BulkAssignResult {
  assigned: ItemAssignment[];
  /** 需要人工决定、没有被自动指派的计分项 */
  needsDecision: ScoringItem[];
}

/**
 * 按附录 A 的默认模板批量指派。
 *
 * **刻意跳过 `needsConfirmation` 的四项**（A2-3 班级评定、A6 遵纪守法、
 * A7-1 社团、A7-5 其他素质能力）。
 *
 * 这四项连需求方都说不清归谁。给它们一个默认值，等于用一个看起来合理的
 * 猜测掩盖一个真实的空白 —— 而这正是"未指派禁止录入"要防的事。
 * 它们必须由人明确决定，否则周期进不了录入状态。
 */
export function assignDefaults(
  db: DatabaseSync,
  input: { termId: number; by: string; clock: Clock },
): BulkAssignResult {
  return transaction(db, () => {
    const assigned: ItemAssignment[] = [];
    const needsDecision: ScoringItem[] = [];

    const byId = new Map(SCORING_ITEMS.map((i) => [i.id, i]));

    for (const item of listItems(db)) {
      const seed = byId.get(item.id);

      if (!seed || seed.defaultDepartment === null || seed.needsConfirmation) {
        if (departmentOfItem(db, input.termId, item.id) === null) {
          needsDecision.push(item);
        }
        continue;
      }

      if (departmentOfItem(db, input.termId, item.id) !== null) continue;

      const departmentId = DEPARTMENT_ID[seed.defaultDepartment];
      if (departmentId === undefined) {
        throw new AssignmentError(
          "UNKNOWN_DEPARTMENT",
          `计分项 ${item.name} 的默认部门「${seed.defaultDepartment}」不在部门清单中`,
        );
      }

      assigned.push(
        assignItem(db, {
          termId: input.termId,
          itemId: item.id,
          departmentId,
          by: input.by,
          reason: "按附录 A 默认模板批量指派",
          clock: input.clock,
        }),
      );
    }

    return { assigned, needsDecision };
  });
}

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

/**
 * 断言所有计分项都已指派责任部门。
 *
 * 由 `term.transition(..., "ENTERING")` 调用 —— **未指派就进不了录入状态**。
 * 报错信息里必须列出**具体是哪几项**，否则管理员拿到一句"还有未指派的项"
 * 只能一项一项去数，最后还是会漏。
 */
export function assertAllItemsAssigned(db: DatabaseSync, termId: number): void {
  const all = listItems(db);

  // "一个计分项都没有"不等于"所有计分项都指派好了"。
  // 少了这一条，一个没导入细则的库会安静地进入录入状态，
  // 然后所有部门都发现自己无事可做 —— 而且没人知道为什么。
  if (all.length === 0) {
    throw new AssignmentError(
      "NO_ITEMS_CONFIGURED",
      "系统里还没有任何计分项，无法进入录入状态。请先导入综测细则（参考数据播种）。",
    );
  }

  const missing = unassignedItems(db, termId);
  if (missing.length === 0) return;

  const list = missing
    .map((i) => `  · ${i.groupCode} ${i.name}（上限 ${i.cap} 分）`)
    .join("\n");

  throw new AssignmentError(
    "UNASSIGNED_ITEMS",
    `还有 ${missing.length} 个计分项没有指派责任部门，不能进入录入状态：\n${list}\n` +
      `未指派即禁止录入 —— 默认归某个部门，就等于把没人认领的活静默变成某人的责任。`,
  );
}

/** 指派进度，供主席看板显示 */
export function assignmentProgress(
  db: DatabaseSync,
  termId: number,
): { total: number; assigned: number; remaining: ScoringItem[] } {
  const all = listItems(db);
  const remaining = unassignedItems(db, termId);
  return { total: all.length, assigned: all.length - remaining.length, remaining };
}

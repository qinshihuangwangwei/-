/**
 * 追加式账本
 *
 * 设计文档 §5。这是整个系统的地基，三条性质必须成立：
 *
 *   1. **只增不改** —— 数据库触发器从物理上禁止 UPDATE/DELETE（见 001_init 迁移）。
 *      本模块刻意**不提供** `updateEvent` / `deleteEvent` 之类的函数。
 *      所谓"修改分数"，唯一表达方式是再追加一条 delta 相反或修正的事件。
 *
 *   2. **分数是算出来的，不是存的** —— 任何学生的任何计分项得分，
 *      都由其事件流重放得出（`replayScore`）。因此不存在"表和账对不上"的可能：
 *      表就是账。
 *
 *   3. **篡改可定位** —— 每条事件带 `prev_hash` / `self_hash`。
 *      改动任何一条历史事件，都会让校验在**那一条**上失败（`verifyChain`）。
 *
 * 哈希链的能力边界（必须说清楚）：触发器挡得住 SQL 层的改删，挡不住
 * `DROP TRIGGER` 之后的改删 —— 因为拿到数据库文件的人本来就能执行 DDL。
 * 挡住那一类攻击的是哈希链加外部存档（设计文档 §5.3）。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { transaction } from "./db.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "ENTRY", // 负责人录入
  "CORRECTION", // 更正（录入期内的自我修正，或异议裁决后的调整）
  "APPEAL_GRANT", // 申诉三级通过
  "OBJECTION_GRANT", // 匿名异议裁决通过
  "REJECT", // 申诉/异议被驳回（delta 恒为 0，仅为留痕）
  "IMPORT", // 导入留痕
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface AppendEventInput {
  termId: number;
  studentId: string;
  itemId: number;
  /** 分值变化，可正可负。REJECT 类事件应为 0。 */
  delta: number;
  eventType: EventType;
  actorId: string;
  /** 理由。非空，且不允许纯空白 —— 数据库层也有 CHECK 兜底。 */
  reason: string;
  sourceEventId?: number | null;
  appealId?: number | null;
  objectionId?: number | null;
  /** 可注入，便于测试与重放。默认取当前时间。 */
  createdAt?: string;
}

export interface ScoreEvent {
  id: number;
  termId: number;
  studentId: string;
  itemId: number;
  delta: number;
  eventType: EventType;
  actorId: string;
  reason: string;
  sourceEventId: number | null;
  appealId: number | null;
  objectionId: number | null;
  createdAt: string;
  prevHash: string;
  selfHash: string;
}

export type ChainVerification =
  | { ok: true; length: number }
  | { ok: false; length: number; brokenAtId: number; reason: string };

export class LedgerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** 创世事件的前哈希：64 个 0 */
export const GENESIS_HASH = "0".repeat(64);

// ---------------------------------------------------------------------------
// 哈希
// ---------------------------------------------------------------------------

/**
 * 参与哈希计算的字段，顺序固定。
 *
 * 用 JSON 数组而不是对象：对象的键序在语言层面虽有保证，
 * 但数组的顺序是**显式写在代码里**的，将来加字段时不可能悄悄改变已有事件的哈希。
 */
interface HashableBody {
  termId: number;
  studentId: string;
  itemId: number;
  delta: number;
  eventType: string;
  actorId: string;
  reason: string;
  sourceEventId: number | null;
  appealId: number | null;
  objectionId: number | null;
  createdAt: string;
}

function canonicalize(body: HashableBody): string {
  return JSON.stringify([
    body.termId,
    body.studentId,
    body.itemId,
    body.delta,
    body.eventType,
    body.actorId,
    body.reason,
    body.sourceEventId,
    body.appealId,
    body.objectionId,
    body.createdAt,
  ]);
}

/**
 * self_hash = SHA256(prev_hash ‖ US ‖ canonical_body)
 *
 * 中间夹一个 US（U+001F，单元分隔符）是为了防止
 * prev_hash 与 body 的边界被拼接歧义吞掉。
 */
export function computeHash(prevHash: string, body: HashableBody): string {
  return createHash("sha256")
    .update(prevHash + "\u001f" + canonicalize(body), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

interface EventRow {
  id: number;
  term_id: number;
  student_id: string;
  item_id: number;
  delta: number;
  event_type: string;
  actor_id: string;
  reason: string;
  source_event_id: number | null;
  appeal_id: number | null;
  objection_id: number | null;
  created_at: string;
  prev_hash: string;
  self_hash: string;
}

function toEvent(row: EventRow): ScoreEvent {
  return {
    id: row.id,
    termId: row.term_id,
    studentId: row.student_id,
    itemId: row.item_id,
    delta: row.delta,
    eventType: row.event_type as EventType,
    actorId: row.actor_id,
    reason: row.reason,
    sourceEventId: row.source_event_id,
    appealId: row.appeal_id,
    objectionId: row.objection_id,
    createdAt: row.created_at,
    prevHash: row.prev_hash,
    selfHash: row.self_hash,
  };
}

function bodyOf(event: ScoreEvent): HashableBody {
  return {
    termId: event.termId,
    studentId: event.studentId,
    itemId: event.itemId,
    delta: event.delta,
    eventType: event.eventType,
    actorId: event.actorId,
    reason: event.reason,
    sourceEventId: event.sourceEventId,
    appealId: event.appealId,
    objectionId: event.objectionId,
    createdAt: event.createdAt,
  };
}

// ---------------------------------------------------------------------------
// 追加事件
// ---------------------------------------------------------------------------

/**
 * 向账本追加一条事件。这是**唯一**能改变分数的入口。
 *
 * 整体在一个 IMMEDIATE 事务里完成：取链尾哈希 → 计算 self_hash → 插入。
 * 用 IMMEDIATE 而非 DEFERRED 是为了立刻取得写锁，
 * 避免两个并发追加读到同一个链尾、产生分叉。
 */
export function appendEvent(db: DatabaseSync, input: AppendEventInput): ScoreEvent {
  const { reason } = input;

  if (typeof reason !== "string" || reason.trim() === "") {
    throw new LedgerError(
      "REASON_REQUIRED",
      "事件理由不能为空：每一分都必须能回答「为什么」。空理由的账本与没有账本没有区别。",
    );
  }

  if (typeof input.delta !== "number" || !Number.isFinite(input.delta)) {
    throw new LedgerError(
      "INVALID_DELTA",
      `delta 必须是有限数值，收到：${String(input.delta)}`,
    );
  }

  if (!EVENT_TYPES.includes(input.eventType)) {
    throw new LedgerError(
      "INVALID_EVENT_TYPE",
      `未知事件类型：${String(input.eventType)}`,
    );
  }

  const createdAt = input.createdAt ?? new Date().toISOString();

  const run = (): ScoreEvent => {
    const tail = db
      .prepare("SELECT self_hash FROM score_events ORDER BY id DESC LIMIT 1")
      .get() as { self_hash: string } | undefined;

    const prevHash = tail?.self_hash ?? GENESIS_HASH;

    const body: HashableBody = {
      termId: input.termId,
      studentId: input.studentId,
      itemId: input.itemId,
      delta: input.delta,
      eventType: input.eventType,
      actorId: input.actorId,
      reason,
      sourceEventId: input.sourceEventId ?? null,
      appealId: input.appealId ?? null,
      objectionId: input.objectionId ?? null,
      createdAt,
    };

    const selfHash = computeHash(prevHash, body);

    const info = db
      .prepare(
        `INSERT INTO score_events
           (term_id, student_id, item_id, delta, event_type, actor_id, reason,
            source_event_id, appeal_id, objection_id, created_at, prev_hash, self_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.termId,
        body.studentId,
        body.itemId,
        body.delta,
        body.eventType,
        body.actorId,
        body.reason,
        body.sourceEventId,
        body.appealId,
        body.objectionId,
        body.createdAt,
        prevHash,
        selfHash,
      );

    return {
      id: Number(info.lastInsertRowid),
      termId: body.termId,
      studentId: body.studentId,
      itemId: body.itemId,
      delta: body.delta,
      eventType: input.eventType,
      actorId: body.actorId,
      reason: body.reason,
      sourceEventId: body.sourceEventId,
      appealId: body.appealId,
      objectionId: body.objectionId,
      createdAt: body.createdAt,
      prevHash,
      selfHash,
    };
  };

  // 整体在一个 IMMEDIATE 事务里：取链尾 → 算哈希 → 插入。
  // 若调用方已开事务（例如切片录入要把"检查上限"和"追加事件"绑在一起），
  // 则复用外层事务，保证两件事要么都成功要么都不发生。
  return transaction(db, run);
}
// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

/** 某学生某计分项在当前周期的得分 —— 由事件流重放得出，不是存储值。 */
export function replayScore(
  db: DatabaseSync,
  termId: number,
  studentId: string,
  itemId: number,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(delta), 0) AS total
         FROM score_events
        WHERE term_id = ? AND student_id = ? AND item_id = ?`,
    )
    .get(termId, studentId, itemId) as { total: number } | undefined;

  return row?.total ?? 0;
}

export interface ItemScore {
  itemId: number;
  delta: number;
}

/** 某学生在某周期的全部分项得分（只含出现过事件的计分项）。 */
export function replayStudent(
  db: DatabaseSync,
  termId: number,
  studentId: string,
): ItemScore[] {
  const rows = db
    .prepare(
      `SELECT item_id, SUM(delta) AS delta
         FROM score_events
        WHERE term_id = ? AND student_id = ?
        GROUP BY item_id
        ORDER BY item_id`,
    )
    .all(termId, studentId) as { item_id: number; delta: number }[];

  return rows.map((r) => ({ itemId: r.item_id, delta: r.delta }));
}

/** 某学生某计分项的事件流，按时间正序。公示页直接展示这个。 */
export function listEvents(
  db: DatabaseSync,
  termId: number,
  studentId: string,
  itemId?: number,
): ScoreEvent[] {
  const rows = (
    itemId === undefined
      ? db
          .prepare(
            `SELECT * FROM score_events
              WHERE term_id = ? AND student_id = ?
              ORDER BY id`,
          )
          .all(termId, studentId)
      : db
          .prepare(
            `SELECT * FROM score_events
              WHERE term_id = ? AND student_id = ? AND item_id = ?
              ORDER BY id`,
          )
          .all(termId, studentId, itemId)
  ) as unknown as EventRow[];

  return rows.map(toEvent);
}

// ---------------------------------------------------------------------------
// 链校验
// ---------------------------------------------------------------------------

/**
 * 全链校验。
 *
 * 逐条重算哈希，并检查相邻事件的 prev_hash 是否衔接。
 * 失败时返回**被篡改的那一条 id** —— 只说"校验失败"是没用的，
 * 必须能指出是哪一条，否则无法追责。
 */
export function verifyChain(db: DatabaseSync): ChainVerification {
  const rows = db
    .prepare("SELECT * FROM score_events ORDER BY id")
    .all() as unknown as EventRow[];

  let expectedPrev = GENESIS_HASH;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        length: rows.length,
        brokenAtId: row.id,
        reason:
          row.id === rows[0]?.id
            ? `创世事件的前哈希应为全 0，实际为 ${row.prev_hash.slice(0, 12)}…`
            : `第 ${row.id} 条事件的前哈希与上一条的自哈希不衔接：` +
              `历史中有事件被删除或插入`,
      };
    }

    const recomputed = computeHash(row.prev_hash, bodyOf(toEvent(row)));

    if (recomputed !== row.self_hash) {
      return {
        ok: false,
        length: rows.length,
        brokenAtId: row.id,
        reason:
          `第 ${row.id} 条事件的内容与其自哈希不符：` +
          `重算得 ${recomputed.slice(0, 12)}…，存储为 ${row.self_hash.slice(0, 12)}…`,
      };
    }

    expectedPrev = row.self_hash;
  }

  return { ok: true, length: rows.length };
}

/** 链尾哈希，供每日外部存档使用（设计文档 §5.3）。 */
export function chainTip(db: DatabaseSync): { id: number | null; hash: string } {
  const row = db
    .prepare("SELECT id, self_hash FROM score_events ORDER BY id DESC LIMIT 1")
    .get() as { id: number; self_hash: string } | undefined;

  return row
    ? { id: row.id, hash: row.self_hash }
    : { id: null, hash: GENESIS_HASH };
}

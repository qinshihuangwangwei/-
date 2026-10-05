/**
 * M1.1 账本地基 —— 不变量测试
 *
 * 对应设计文档 §5「追加式账本」与 §11「测试策略」。
 *
 * 这一组测试盯的不是功能，是性质：
 *   1. 账本物理上不可改删
 *   2. 分数由事件重放得出，而不是存储的
 *   3. 哈希链能定位篡改位置
 *   4. 没有理由的事件写不进去
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import {
  appendEvent,
  replayScore,
  verifyChain,
} from "../../src/db/ledger.ts";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const TERM = 1;
const ALICE = "2599000001";
const BOB = "2599000003";
const ITEM_SPORTS = 1; // A7-3 体育类（6 分）
const ITEM_C = 99; // C 项（上限 12 分）

function freshDb(): Db {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO terms (id, name) VALUES (${TERM}, '2024-2025 秋季学期');
    INSERT INTO students (id, name, class_name, grade)
      VALUES ('${ALICE}', '学生甲', '计算机2501', 2025),
             ('${BOB}',   '学生乙', '计算机2501', 2025);
    INSERT INTO scoring_items (id, group_code, name, cap, mode, baseline)
      VALUES (${ITEM_SPORTS}, 'A7', '体育类', 6, 'ACCUMULATE', 0),
             (${ITEM_C},      'C',  '附加分', 12, 'ACCUMULATE', 0);
  `);
  return db;
}

function entry(
  db: Db,
  studentId: string,
  itemId: number,
  delta: number,
  reason = "校运动会田径 100 米第一名",
) {
  return appendEvent(db, {
    termId: TERM,
    studentId,
    itemId,
    delta,
    eventType: "ENTRY",
    actorId: "owner-sports-2025",
    reason,
  });
}

// ---------------------------------------------------------------------------
// 1. 不可改删
// ---------------------------------------------------------------------------

describe("账本物理不可改删", () => {
  test("UPDATE 被数据库拒绝，且原值不变", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3);

    assert.throws(
      () => db.exec("UPDATE score_events SET delta = 999"),
      /LEDGER_IMMUTABLE/,
    );

    assert.equal(replayScore(db, TERM, ALICE, ITEM_SPORTS), 3);
  });

  test("DELETE 被数据库拒绝，事件依然存在", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3);

    assert.throws(
      () => db.exec("DELETE FROM score_events"),
      /LEDGER_IMMUTABLE/,
    );

    assert.equal(replayScore(db, TERM, ALICE, ITEM_SPORTS), 3);
  });

  test("连把 delta 改成自己原值也会被拒绝（不存在'无害的 UPDATE'）", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3);

    assert.throws(
      () => db.exec("UPDATE score_events SET delta = delta"),
      /LEDGER_IMMUTABLE/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 理由非空是硬约束
// ---------------------------------------------------------------------------

describe("理由非空", () => {
  test("空字符串理由被拒绝", () => {
    const db = freshDb();
    assert.throws(
      () => entry(db, ALICE, ITEM_SPORTS, 3, ""),
      /reason|理由/i,
    );
  });

  test("纯空白理由被拒绝", () => {
    const db = freshDb();
    assert.throws(
      () => entry(db, ALICE, ITEM_SPORTS, 3, "   \n\t "),
      /reason|理由/i,
    );
  });

  test("被拒绝的事件不会在账本里留下任何痕迹", () => {
    const db = freshDb();
    assert.throws(() => entry(db, ALICE, ITEM_SPORTS, 3, ""));

    const row = db
      .prepare("SELECT COUNT(*) AS n FROM score_events")
      .get() as { n: number };
    assert.equal(row.n, 0, "失败的写入必须完全回滚，不能留下半截事件");
  });
});

// ---------------------------------------------------------------------------
// 3. 分数由重放得出
// ---------------------------------------------------------------------------

describe("分数由事件重放得出", () => {
  test("多条加分累加", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3, "校运动会 100 米第一名");
    entry(db, ALICE, ITEM_SPORTS, 2, "院篮球赛冠军");
    entry(db, ALICE, ITEM_SPORTS, 1.5, "趣味运动会");

    assert.equal(replayScore(db, TERM, ALICE, ITEM_SPORTS), 6.5);
  });

  test("delta 可以为负，减分同样靠追加事件", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 6, "初始录入");

    appendEvent(db, {
      termId: TERM,
      studentId: ALICE,
      itemId: ITEM_SPORTS,
      delta: -2,
      eventType: "CORRECTION",
      actorId: "head-sports",
      reason: "该生未实际参加决赛，据实核减",
    });

    assert.equal(replayScore(db, TERM, ALICE, ITEM_SPORTS), 4);
  });

  test("学生的分数互不串台", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3, "甲的加分");
    entry(db, BOB, ITEM_SPORTS, 5, "乙的加分");

    assert.equal(replayScore(db, TERM, ALICE, ITEM_SPORTS), 3);
    assert.equal(replayScore(db, TERM, BOB, ITEM_SPORTS), 5);
  });

  test("计分项之间互不串台", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3, "体育类加分");
    entry(db, ALICE, ITEM_C, 4, "挑战杯省级一等奖");

    assert.equal(replayScore(db, TERM, ALICE, ITEM_SPORTS), 3);
    assert.equal(replayScore(db, TERM, ALICE, ITEM_C), 4);
  });

  test("没有事件的计分项得 0 分", () => {
    const db = freshDb();
    assert.equal(replayScore(db, TERM, ALICE, ITEM_C), 0);
  });
});

// ---------------------------------------------------------------------------
// 4. 哈希链
// ---------------------------------------------------------------------------

describe("哈希链", () => {
  test("未篡改时校验通过", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3);
    entry(db, BOB, ITEM_SPORTS, 5);
    entry(db, ALICE, ITEM_C, 4);

    assert.deepEqual(verifyChain(db), { ok: true, length: 3 });
  });

  test("空账本校验通过，长度为 0", () => {
    const db = freshDb();
    assert.deepEqual(verifyChain(db), { ok: true, length: 0 });
  });

  test("链是连续的：每条事件的 prev_hash 等于上一条的 self_hash", () => {
    const db = freshDb();
    const a = entry(db, ALICE, ITEM_SPORTS, 3);
    const b = entry(db, BOB, ITEM_SPORTS, 5);

    assert.equal(a.prevHash, "0".repeat(64), "创世事件的前哈希必须是全 0");
    assert.equal(b.prevHash, a.selfHash);
  });

  test("篡改中间一条 → 校验失败，并精确指出是第几条", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3);
    const target = entry(db, BOB, ITEM_SPORTS, 5);
    entry(db, ALICE, ITEM_C, 4);

    // 模拟拿到数据库文件的人：先拆掉触发器，再改数据。
    // 触发器挡不住 DDL，能挡住 DDL 攻击的是哈希链本身。
    db.exec("DROP TRIGGER score_events_no_update");
    db.exec(`UPDATE score_events SET delta = 6 WHERE id = ${target.id}`);

    const result = verifyChain(db);
    assert.equal(result.ok, false);
    assert.equal(
      (result as { ok: false; brokenAtId: number }).brokenAtId,
      target.id,
      "必须定位到被改的那一条，而不是只说'校验失败'",
    );
  });

  test("删掉中间一条也会被发现", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3);
    const target = entry(db, BOB, ITEM_SPORTS, 5);
    entry(db, ALICE, ITEM_C, 4);

    db.exec("DROP TRIGGER score_events_no_delete");
    db.exec(`DELETE FROM score_events WHERE id = ${target.id}`);

    const result = verifyChain(db);
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; brokenAtId: number }).brokenAtId, 3);
  });

  test("篡改事件的理由（而不是分值）同样会被发现", () => {
    const db = freshDb();
    entry(db, ALICE, ITEM_SPORTS, 3);
    const target = entry(db, BOB, ITEM_SPORTS, 5, "原始理由");

    db.exec("DROP TRIGGER score_events_no_update");
    db.exec(`UPDATE score_events SET reason = '编造的理由' WHERE id = ${target.id}`);

    const result = verifyChain(db);
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; brokenAtId: number }).brokenAtId, target.id);
  });

  test("self_hash 覆盖全部字段：任意字段变化都会改变哈希", () => {
    const db = freshDb();
    const a = entry(db, ALICE, ITEM_SPORTS, 3, "理由甲");
    const b = entry(db, ALICE, ITEM_SPORTS, 3, "理由乙");

    assert.notEqual(a.selfHash, b.selfHash, "理由不同，哈希必须不同");
  });
});

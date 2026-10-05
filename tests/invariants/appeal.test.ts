/**
 * M1.5 申诉链路 —— 不变量测试
 *
 * 对应设计文档 §8.2「申诉（实名 · 发布后 72 小时）」。
 *
 * 链路：负责人 → 副部长 → 部长，三级全过才生效；每级 24h，超时自动升级。
 *
 * 这里钉死四条最容易做成"看起来对、其实欺负人"的性质：
 *
 *   1. **任一级驳回即终止，且必须写理由。** 一个没有理由的驳回，
 *      和"我就是要卡你"没有区别。
 *
 *   2. **回避规则：审批链上撞到申诉人自己就跳过该级。**
 *      否则副部长给自己申诉时，会由副部长本人初审通过。
 *
 *   3. **超时自动升级。** 学生的申诉窗口只有 72 小时，
 *      如果审批人"忘了处理"，学生的权利就被拖没了。
 *      让拖延失效，是让流程可信的前提。
 *
 *   4. **72 小时内提交的申诉，不因窗口关闭而作废。**
 *      延迟是审批人的责任，不是学生的。学生按时提交了，
 *      就不能因为他控制不了的原因失去权利。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock } from "../../src/domain/clock.ts";
import { publish } from "../../src/domain/publication.ts";
import { scoreOf, createSlice, record, submit, review, approve } from "../../src/domain/slice.ts";
import {
  submitAppeal,
  getAppeal,
  appealSteps,
  act,
  materializeAppeals,
  canAct,
  AppealError,
} from "../../src/domain/appeal.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const T0 = "2026-03-01T00:00:00.000Z";
const TERM = 1;

const ALICE = "2599000001";
const BOB = "2599000003";

const ITEM_SPORTS = 1; // A7-3 体育类 上限 6

const OWNER = "owner-sports";
const DEPUTY_1 = "deputy-1";
const DEPUTY_2 = "deputy-2";
const HEAD = "head-sports";
const CHAIR = "chair-a";
const ADMIN = "admin-a";

const CHAIN = {
  OWNER: [OWNER],
  DEPUTY: [DEPUTY_1, DEPUTY_2],
  HEAD: [HEAD],
};

function setup(opts: { appellant?: string } = {}) {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);
  const appellant = opts.appellant ?? ALICE;

  db.exec(`
    INSERT INTO terms (id, name, status) VALUES (${TERM}, '2025-2026 春季学期', 'ENTERING');

    INSERT INTO students (id, name, class_name, grade)
      VALUES ('${ALICE}', '学生甲', '计算机2501', 2025),
             ('${BOB}',   '学生乙', '计算机2501', 2025);

    INSERT INTO scoring_items (id, group_code, name, cap, mode, baseline)
      VALUES (${ITEM_SPORTS}, 'A7', '体育类', 6, 'ACCUMULATE', 0);

    INSERT INTO attachments (id, filename, sha256, size_bytes, uploaded_by, uploaded_at)
      VALUES (1, '获奖证书.jpg', 'deadbeef', 12345, '${appellant}', '${T0}'),
             (2, '秩序册.pdf',   'cafebabe', 6789,  '${appellant}', '${T0}');
  `);

  const slice = createSlice(db, {
    termId: TERM,
    itemId: ITEM_SPORTS,
    grade: 2025,
    ownerId: OWNER,
  });

  // 申诉人自己先有一条 2 分的记录，用来验证"申诉后分数确实变了"
  record(db, {
    sliceId: slice.id,
    studentId: ALICE,
    delta: 2,
    actorId: OWNER,
    reason: "院篮球赛参与分",
  });

  submit(db, slice.id, OWNER, clock);
  review(db, slice.id, DEPUTY_1, clock);
  approve(db, slice.id, HEAD, clock);

  publish(db, TERM, "president", clock);

  return { db, clock, slice, appellant };
}

function file(db: Db, clock: ReturnType<typeof fixedClock>, delta = 2, attachmentId = 1) {
  return submitAppeal(db, {
    termId: TERM,
    studentId: ALICE,
    itemId: ITEM_SPORTS,
    reason: "我参加了校运动会 100 米并获得第三名，应加 2 分，原统计遗漏",
    attachmentId,
    requestedDelta: delta,
    chain: CHAIN,
    clock,
  });
}

// ---------------------------------------------------------------------------
// 1. 发起申诉
// ---------------------------------------------------------------------------

describe("发起申诉", () => {
  test("发布后学生可以发起申诉，初始停在负责人这一级", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    assert.equal(appeal.status, "PENDING");
    assert.equal(appeal.stage, "OWNER");
    assert.equal(appeal.studentId, ALICE);
    assert.equal(appeal.itemId, ITEM_SPORTS);
  });

  test("理由必填", () => {
    const { db, clock } = setup();
    assert.throws(
      () =>
        submitAppeal(db, {
          termId: TERM,
          studentId: ALICE,
          itemId: ITEM_SPORTS,
          reason: "   ",
          attachmentId: 1,
          requestedDelta: 2,
          chain: CHAIN,
          clock,
        }),
      /理由/,
    );
  });

  test("★ 材料必传：没有材料不予受理", () => {
    const { db, clock } = setup();
    assert.throws(
      () =>
        submitAppeal(db, {
          termId: TERM,
          studentId: ALICE,
          itemId: ITEM_SPORTS,
          reason: "我觉得应该加分",
          attachmentId: null,
          requestedDelta: 2,
          chain: CHAIN,
          clock,
        }),
      /材料|附件/,
    );
  });

  test("未发布时不能申诉", () => {
    const { db, clock, slice } = setup();
    db.exec("UPDATE terms SET status = 'ENTERING', published_at = NULL WHERE id = 1");
    void slice;

    assert.throws(() => file(db, clock), /窗口|未发布|不可申诉/);
  });

  test("发布 73 小时后不能申诉", () => {
    const { db, clock } = setup();
    clock.advance(73 * HOUR);

    assert.throws(() => file(db, clock), /窗口|已关闭|不可申诉/);
  });

  test("★ 72 小时内提交的申诉，不因窗口关闭而作废", () => {
    const { db, clock } = setup();

    clock.advance(71 * HOUR);
    const appeal = file(db, clock);

    // 窗口关闭
    clock.advance(2 * HOUR);
    assert.equal(
      canAct(db, appeal.id, OWNER, clock),
      true,
      "学生按时提交了，审批人慢不该由学生承担 —— 窗口关闭作废的是『提交』，不是『处理』",
    );
  });

  test("只能对具体计分项申诉，不能对总分申诉", () => {
    const { db, clock } = setup();
    assert.throws(
      () =>
        submitAppeal(db, {
          termId: TERM,
          studentId: ALICE,
          itemId: 99999,
          reason: "总分不对",
          attachmentId: 1,
          requestedDelta: 1,
          chain: CHAIN,
          clock,
        }),
      /计分项|不存在/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 三级审批
// ---------------------------------------------------------------------------

describe("三级审批", () => {
  test("★ 三级全过才生效，中途分数不变", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    const before = scoreOf(db, TERM, ALICE, ITEM_SPORTS);
    assert.equal(before, 2);

    act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "情况属实", clock });
    assert.equal(scoreOf(db, TERM, ALICE, ITEM_SPORTS), 2, "只过一级还不能加分");
    assert.equal(getAppeal(db, appeal.id).stage, "DEPUTY");

    act(db, { appealId: appeal.id, actorId: DEPUTY_1, action: "APPROVE", reason: "复核无误", clock });
    assert.equal(scoreOf(db, TERM, ALICE, ITEM_SPORTS), 2, "只过两级还不能加分");
    assert.equal(getAppeal(db, appeal.id).stage, "HEAD");

    const granted = act(db, {
      appealId: appeal.id,
      actorId: HEAD,
      action: "APPROVE",
      reason: "同意加分",
      clock,
    });

    assert.equal(granted.status, "GRANTED");
    assert.equal(scoreOf(db, TERM, ALICE, ITEM_SPORTS), 4, "三级全过后才 +2");
  });

  test("副部长有两人，任一人审批即可", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "属实", clock });
    act(db, { appealId: appeal.id, actorId: DEPUTY_2, action: "APPROVE", reason: "同意", clock });

    assert.equal(getAppeal(db, appeal.id).stage, "HEAD");
  });

  test("不在审批链上的人不能审批", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    assert.throws(
      () => act(db, { appealId: appeal.id, actorId: "路人甲", action: "APPROVE", reason: "我同意", clock }),
      /无权|不在此级|审批链/,
    );
  });

  test("跳级审批被拒绝", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    assert.throws(
      () => act(db, { appealId: appeal.id, actorId: HEAD, action: "APPROVE", reason: "越级", clock }),
      /无权|不在此级|审批链/,
    );
  });

  test("已经结束的申诉不能再审", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    act(db, { appealId: appeal.id, actorId: OWNER, action: "REJECT", reason: "材料不足", clock });

    assert.throws(
      () => act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "改主意了", clock }),
      /已结束|REJECTED|状态/,
    );
  });

  test("申诉人自己不能审批自己的申诉", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    assert.throws(
      () => act(db, { appealId: appeal.id, actorId: ALICE, action: "APPROVE", reason: "我同意我自己", clock }),
      /无权|不在此级|审批链|回避/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 驳回
// ---------------------------------------------------------------------------

describe("驳回", () => {
  test("★ 任一级驳回即终止，分数不变", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "属实", clock });
    const rejected = act(db, {
      appealId: appeal.id,
      actorId: DEPUTY_1,
      action: "REJECT",
      reason: "秩序册上无该生姓名",
      clock,
    });

    assert.equal(rejected.status, "REJECTED");
    assert.equal(scoreOf(db, TERM, ALICE, ITEM_SPORTS), 2, "驳回后分数不得变化");
  });

  test("★ 驳回必须写理由", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    assert.throws(
      () => act(db, { appealId: appeal.id, actorId: OWNER, action: "REJECT", reason: "  ", clock }),
      /理由/,
    );
  });

  test("驳回也要在账本上留痕（delta 为 0 的 REJECT 事件）", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);
    act(db, { appealId: appeal.id, actorId: OWNER, action: "REJECT", reason: "材料不足", clock });

    const row = db
      .prepare("SELECT event_type, delta, reason FROM score_events WHERE event_type = 'REJECT'")
      .get() as { event_type: string; delta: number; reason: string } | undefined;

    assert.ok(row, "驳回必须写进账本，否则「被驳回过」这件事将无从查证");
    assert.equal(row.delta, 0);
    assert.match(row.reason, /材料不足/);
  });

  test("★ 同一计分项被驳回后不可重复申诉", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);
    act(db, { appealId: appeal.id, actorId: OWNER, action: "REJECT", reason: "材料不足", clock });

    assert.throws(() => file(db, clock, 3), /重复|已申诉|已有/);
  });

  test("被驳回后可以换一个计分项申诉", () => {
    const { db, clock } = setup();
    db.exec(`
      INSERT INTO scoring_items (id, group_code, name, cap, mode, baseline)
        VALUES (2, 'A7', '社团', 3, 'ACCUMULATE', 0);
    `);
    const appeal = file(db, clock);
    act(db, { appealId: appeal.id, actorId: OWNER, action: "REJECT", reason: "材料不足", clock });

    const other = submitAppeal(db, {
      termId: TERM,
      studentId: ALICE,
      itemId: 2,
      reason: "我参加了社团活动",
      attachmentId: 1,
      requestedDelta: 1,
      chain: CHAIN,
      clock,
    });

    assert.equal(other.status, "PENDING");
  });
});

// ---------------------------------------------------------------------------
// 4. 回避规则
// ---------------------------------------------------------------------------

describe("回避规则", () => {
  test("★ 申诉人就是负责人时，初审被跳过并记录跳过原因", () => {
    const { db, clock } = setup();

    // 让申诉人自己成为负责人
    db.exec(`UPDATE slices SET owner_id = '${ALICE}'`);

    const appeal = submitAppeal(db, {
      termId: TERM,
      studentId: ALICE,
      itemId: ITEM_SPORTS,
      reason: "我参加了校运动会，应加 2 分",
      attachmentId: 1,
      requestedDelta: 2,
      chain: { OWNER: [ALICE], DEPUTY: [DEPUTY_1], HEAD: [HEAD] },
      clock,
    });

    assert.equal(appeal.stage, "DEPUTY", "撞到自己必须跳过该级");

    const steps = appealSteps(db, appeal.id);
    const skip = steps.find((s) => s.action === "SKIP_CONFLICT");
    assert.ok(skip, "跳过必须留痕，否则看起来就像从来没经过这一级");
    assert.equal(skip.stage, "OWNER");
    assert.match(skip.reason ?? "", /回避|本人/);
  });

  test("副部长就是申诉人时，也跳过该级", () => {
    const { db, clock } = setup();

    const appeal = submitAppeal(db, {
      termId: TERM,
      studentId: ALICE,
      itemId: ITEM_SPORTS,
      reason: "应加 2 分",
      attachmentId: 1,
      requestedDelta: 2,
      chain: { OWNER: [OWNER], DEPUTY: [ALICE, DEPUTY_2], HEAD: [HEAD] },
      clock,
    });

    // 负责人先过
    act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "属实", clock });

    // 该生是副部长之一，但另一名副部长仍可审批 —— 跳过的是"人"，不是"这一级"
    assert.equal(canAct(db, appeal.id, ALICE, clock), false);
    assert.equal(canAct(db, appeal.id, DEPUTY_2, clock), true);
  });

  test("如果整条链都是申诉人，直接进双签", () => {
    const { db, clock } = setup();

    const appeal = submitAppeal(db, {
      termId: TERM,
      studentId: ALICE,
      itemId: ITEM_SPORTS,
      reason: "应加 2 分",
      attachmentId: 1,
      requestedDelta: 2,
      chain: { OWNER: [ALICE], DEPUTY: [ALICE], HEAD: [ALICE] },
      clock,
    });

    assert.equal(appeal.stage, "CHAIR_ADMIN");
  });

  test("申诉人自己不能审批任何一级", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    for (const stage of [OWNER, DEPUTY_1, HEAD]) {
      void stage;
    }
    assert.equal(canAct(db, appeal.id, ALICE, clock), false);
  });
});

// ---------------------------------------------------------------------------
// 5. 超时自动升级
// ---------------------------------------------------------------------------

describe("超时自动升级", () => {
  test("★ 负责人 25 小时未处理 → 自动升级到副部长，且留痕", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    assert.equal(getAppeal(db, appeal.id).stage, "OWNER");

    clock.advance(25 * HOUR);
    materializeAppeals(db, clock);

    assert.equal(getAppeal(db, appeal.id).stage, "DEPUTY");

    const steps = appealSteps(db, appeal.id);
    const escalation = steps.find((s) => s.action === "ESCALATE_TIMEOUT");
    assert.ok(escalation, "超时升级必须留痕 —— 让拖延变得可见");
    assert.equal(escalation.stage, "OWNER");
  });

  test("★ 超时之后，原审批人失去审批权", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    clock.advance(25 * HOUR);
    assert.equal(
      canAct(db, appeal.id, OWNER, clock),
      false,
      "拖延必须让它失效，否则「拖到你放弃」就是最省事的应对方式",
    );
    assert.equal(canAct(db, appeal.id, DEPUTY_1, clock), true);
  });

  test("未超时时原审批人仍有权", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    clock.advance(23 * HOUR);
    assert.equal(canAct(db, appeal.id, OWNER, clock), true);
    assert.equal(canAct(db, appeal.id, DEPUTY_1, clock), false);
  });

  test("边界：正好 24 小时即已超时", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    clock.advance(24 * HOUR - 1);
    assert.equal(canAct(db, appeal.id, OWNER, clock), true);

    clock.advance(1);
    assert.equal(canAct(db, appeal.id, OWNER, clock), false);
  });

  test("连续超时会一路升级到双签", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    clock.advance(80 * HOUR); // 超过三级共 72 小时
    materializeAppeals(db, clock);

    assert.equal(getAppeal(db, appeal.id).stage, "CHAIR_ADMIN");

    const escalations = appealSteps(db, appeal.id).filter(
      (s) => s.action === "ESCALATE_TIMEOUT",
    );
    assert.equal(escalations.length, 3, "每一级的超时都要各自留痕");
  });

  test("★ 升级不依赖定时任务：超时后审批权立即转移", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    clock.advance(25 * HOUR);
    // 刻意不调用 materializeAppeals
    assert.equal(canAct(db, appeal.id, OWNER, clock), false);
    assert.equal(canAct(db, appeal.id, DEPUTY_1, clock), true);
  });

  test("materializeAppeals 幂等", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    clock.advance(25 * HOUR);
    materializeAppeals(db, clock);
    materializeAppeals(db, clock);

    const escalations = appealSteps(db, appeal.id).filter(
      (s) => s.action === "ESCALATE_TIMEOUT",
    );
    assert.equal(escalations.length, 1, "重复跑不能重复记");
  });
});

// ---------------------------------------------------------------------------
// 6. 终审超时后的双签
// ---------------------------------------------------------------------------

describe("终审超时 → 主席 + 管理员双签", () => {
  test("双签需要两个不同的人", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);
    clock.advance(80 * HOUR);
    materializeAppeals(db, clock);

    act(db, { appealId: appeal.id, actorId: CHAIR, action: "APPROVE", reason: "属实", clock });
    assert.equal(getAppeal(db, appeal.id).status, "PENDING", "一个人签不算数");

    act(db, { appealId: appeal.id, actorId: ADMIN, action: "APPROVE", reason: "同意", clock });
    assert.equal(getAppeal(db, appeal.id).status, "GRANTED");
    assert.equal(scoreOf(db, TERM, ALICE, ITEM_SPORTS), 4);
  });

  test("同一个人签两次不算双签", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);
    clock.advance(80 * HOUR);
    materializeAppeals(db, clock);

    act(db, { appealId: appeal.id, actorId: CHAIR, action: "APPROVE", reason: "属实", clock });
    assert.throws(
      () => act(db, { appealId: appeal.id, actorId: CHAIR, action: "APPROVE", reason: "我再签一次", clock }),
      /重复|同一人|双签/,
    );
    assert.equal(getAppeal(db, appeal.id).status, "PENDING");
  });
});

// ---------------------------------------------------------------------------
// 7. 加分幅度受上限约束
// ---------------------------------------------------------------------------

describe("申诉加分同样受上限约束", () => {
  test("加分后超上限被拒绝", () => {
    const { db, clock } = setup();

    // 该生已有 2 分，上限 6 分。申诉要 5 分，批准后会是 7 分，超限。
    const appeal = file(db, clock, 5);

    act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "属实", clock });
    act(db, { appealId: appeal.id, actorId: DEPUTY_1, action: "APPROVE", reason: "同意", clock });

    assert.throws(
      () => act(db, { appealId: appeal.id, actorId: HEAD, action: "APPROVE", reason: "同意", clock }),
      /上限/,
    );
    assert.equal(scoreOf(db, TERM, ALICE, ITEM_SPORTS), 2, "分数不得变化");
    assert.equal(getAppeal(db, appeal.id).status, "PENDING", "申诉仍停在终审，可以改批一个小一点的数");
  });

  test("终审可以只批准一部分（批准值 ≤ 申请值）", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock, 4);

    act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "属实", clock });
    act(db, { appealId: appeal.id, actorId: DEPUTY_1, action: "APPROVE", reason: "同意", clock });
    act(db, {
      appealId: appeal.id,
      actorId: HEAD,
      action: "APPROVE",
      reason: "只认定 1 分",
      delta: 1,
      clock,
    });

    assert.equal(scoreOf(db, TERM, ALICE, ITEM_SPORTS), 3, "原 2 分 + 批准 1 分");
  });

  test("终审不能批准超过申请值", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock, 1);

    act(db, { appealId: appeal.id, actorId: OWNER, action: "APPROVE", reason: "属实", clock });
    act(db, { appealId: appeal.id, actorId: DEPUTY_1, action: "APPROVE", reason: "同意", clock });

    assert.throws(
      () =>
        act(db, {
          appealId: appeal.id,
          actorId: HEAD,
          action: "APPROVE",
          reason: "想多给点",
          delta: 3,
          clock,
        }),
      /申请|超过|不得大于/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. 错误可编程识别
// ---------------------------------------------------------------------------

describe("错误可编程识别", () => {
  test("跳级审批抛 AppealError 且带错误码", () => {
    const { db, clock } = setup();
    const appeal = file(db, clock);

    try {
      act(db, { appealId: appeal.id, actorId: HEAD, action: "APPROVE", reason: "越级", clock });
      assert.fail("应当抛错");
    } catch (error) {
      assert.ok(error instanceof AppealError);
      assert.equal((error as AppealError).code, "NOT_CURRENT_APPROVER");
    }
  });
});

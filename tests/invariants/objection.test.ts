/**
 * M2.3 匿名异议与双签 —— 不变量测试
 *
 * 对应设计文档 §8.3 / §8.4 / §8.5。
 *
 * 这里有一组不太常见的测试：**直接读源码与 schema，断言某些东西不存在。**
 *
 * 因为匿名的承诺不是"我们不会去查"，而是"**查不到**"。
 * 一个可以被口头保证的东西，也可以被口头推翻；一个在 schema 与源码层面
 * 都不存在的东西，才是真的不存在。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock, type FixedClock } from "../../src/domain/clock.ts";
import { createTerm, transition, effectiveStatus, publicityOverdueDays } from "../../src/domain/term.ts";
import { publish } from "../../src/domain/publication.ts";
import { createSlice, record, submit, review, approve } from "../../src/domain/slice.ts";
import { verifyChain } from "../../src/db/ledger.ts";
import { renderPublicityPage } from "../../src/ui/publicity.ts";
import {
  fileObjection,
  getObjection,
  listObjections,
  signObjection,
  objectionSignatures,
  objectionFingerprint,
  fingerprintSelfCheck,
  pendingObjectionCount,
  quotaUsed,
  OBJECTION_QUOTA_PER_TERM,
  ObjectionError,
} from "../../src/domain/objection.ts";
import { seedAndAssignAll, SPORTS, OFFICE } from "../helpers/term-fixture.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = "2026-03-01T09:00:00.000Z";
const TERM = 1;

const ALICE = "2599000001";
const BOB = "2599000003";

const OWNER = "owner-sports";
const DEPUTY = "deputy-1";
const HEAD = "head-sports";
const PRESIDENT = "chair-a";
const ADMIN = "teacher";

const SECRET = "test-secret-do-not-use-in-production-0123456789";

const ITEM_SPORTS = 20; // A7-3 体育类，上限 6

function world(): { db: Db; clock: FixedClock } {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);

  db.exec(`
    INSERT INTO terms (id, name, status) VALUES (${TERM}, '2025-2026 春季学期', 'DRAFT');

    INSERT INTO students (id, name, class_name, grade)
      VALUES ('${ALICE}', '学生甲', '计算机2501', 2025),
             ('${BOB}',   '学生乙', '计算机2501', 2025),
             ('${PRESIDENT}', '主席甲', '计算机2502', 2025),
             ('${ADMIN}', '学院老师', '', 2025);

    INSERT INTO attachments (id, filename, sha256, size_bytes, uploaded_by, uploaded_at)
      VALUES (1, '秩序册.pdf', 'aa11', 2048, '${ALICE}', '${T0}'),
             (2, '成绩单.png', 'bb22', 3072, '${ALICE}', '${T0}');
  `);

  seedAndAssignAll(db, TERM, clock);

  const slice = createSlice(db, {
    termId: TERM,
    itemId: ITEM_SPORTS,
    grade: 2025,
    ownerId: OWNER,
  });

  record(db, {
    sliceId: slice.id,
    studentId: BOB,
    delta: 6,
    actorId: OWNER,
    reason: "校运动会多项获奖",
  });

  submit(db, slice.id, OWNER, clock);
  review(db, slice.id, DEPUTY, clock);
  approve(db, slice.id, HEAD, clock);

  transition(db, TERM, "ASSIGNING", clock);
  transition(db, TERM, "ENTERING", clock);
  publish(db, TERM, PRESIDENT, clock);
  clock.advance(73 * HOUR); // 进入公示期

  return { db, clock };
}

function file(
  db: Db,
  clock: FixedClock,
  overrides: Partial<Parameters<typeof fileObjection>[1]> = {},
) {
  return fileObjection(db, {
    termId: TERM,
    targetStudentId: BOB,
    itemId: ITEM_SPORTS,
    reason: "学生乙并未参加校运动会决赛，秩序册第 12 页无其姓名",
    attachmentId: 1,
    submitterStudentId: "someone-else",
    secret: SECRET,
    clock,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. 结构性断言：匿名的可验证性
// ---------------------------------------------------------------------------

describe("匿名是可验证的，不是被承诺的", () => {
  test("★ objections 表的列集合完全确定 —— 多一列就会失败", () => {
    const { db } = world();

    const columns = (
      db.prepare("PRAGMA table_info(objections)").all() as { name: string }[]
    )
      .map((c) => c.name)
      .sort();

    assert.deepEqual(
      columns,
      [
        "attachment_id",
        "created_at",
        "decided_at",
        "decision_reason",
        "granted_delta",
        "id",
        "item_id",
        "proposal_by",
        "proposal_decision",
        "proposal_delta",
        "proposal_reason",
        "reason",
        "status",
        "submitter_fingerprint",
        "target_student_id",
        "term_id",
      ].sort(),
      "列集合一旦变化就重新审视：新列会不会让发起人变得可识别？",
    );
  });

  test("★ 没有任何一列能指回发起人的账号", () => {
    const { db } = world();

    const columns = (
      db.prepare("PRAGMA table_info(objections)").all() as { name: string }[]
    ).map((c) => c.name);

    const identifying = columns.filter((name) =>
      /^(user_id|submitter_id|submitter_student_id|created_by|author_id|reporter_id|student_id)$/i.test(
        name,
      ),
    );

    assert.deepEqual(
      identifying,
      [],
      `objection 表出现了可以指回发起人的列：${identifying.join(", ")}`,
    );
  });

  test("★ objections 没有任何指向 users 表的外键", () => {
    const { db } = world();

    const fks = db.prepare("PRAGMA foreign_key_list(objections)").all() as {
      table: string;
      from: string;
    }[];

    const toUsers = fks.filter((fk) => fk.table === "users");
    assert.deepEqual(toUsers, [], "指向 users 的外键会让匿名变成一句空话");

    // target_student_id 指向被质疑的人，不是发起人 —— 这是允许且必需的
    assert.ok(fks.some((fk) => fk.table === "students" && fk.from === "target_student_id"));
  });

  test("★ 源码里不存在任何按指纹反查用户的函数", () => {
    const sources = collectSources(join(process.cwd(), "src"));

    const forbidden = /(resolve|find|lookup|reveal|deanonym\w*|identify|whoSubmitted)\w*Fingerprint/i;
    const offenders = sources.filter((f) => forbidden.test(f.content));

    assert.deepEqual(
      offenders.map((f) => f.path),
      [],
      "出现了疑似反查指纹的函数",
    );
  });

  test("★ 源码里没有把 objections 与 users 连起来的 SQL", () => {
    const sources = collectSources(join(process.cwd(), "src"));

    const patterns = [
      /FROM\s+objections[\s\S]{0,300}?JOIN\s+users/i,
      /JOIN\s+objections/i,
      /FROM\s+users[\s\S]{0,300}?JOIN\s+objections/i,
    ];

    for (const source of sources) {
      for (const pattern of patterns) {
        assert.ok(
          !pattern.test(source.content),
          `${source.path} 里出现了 objections 与 users 的关联查询 —— ` +
            `一旦能关联，匿名就没了`,
        );
      }
    }
  });

  test("指纹确定性、按周期隔离、随密钥变化", () => {
    assert.equal(fingerprintSelfCheck(SECRET), true);
    assert.equal(fingerprintSelfCheck("another-secret"), true);
  });

  test("指纹是 64 位十六进制，不含可识别信息", () => {
    const fp = objectionFingerprint(SECRET, TERM, ALICE);
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.ok(!fp.includes(ALICE));
  });

  test("公示页上不显示发起人（因为根本没有这个信息）", () => {
    const { db, clock } = world();
    // 刻意用一个不在名册上的学号当发起人 —— 如果它能出现在页面上，
    // 说明页面拿到了发起人身份
    const ghost = "2599000016";
    file(db, clock, { submitterStudentId: ghost });

    const html = renderPublicityPage(db, TERM, { kind: "staff" }, clock);
    assert.ok(!html.includes(ghost), "公示页不该出现发起人的学号");
  });
});

// ---------------------------------------------------------------------------
// 2. 发起异议
// ---------------------------------------------------------------------------

describe("发起异议", () => {
  test("公示期可以发起", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    assert.equal(objection.status, "PENDING");
    assert.equal(objection.targetStudentId, BOB);
    assert.equal(objection.itemId, ITEM_SPORTS);
  });

  test("★ 非公示期不能发起（录入期、72 小时窗口内都不行）", () => {
    const { db, clock } = world();
    db.exec("UPDATE terms SET status = 'ENTERING', published_at = NULL, archived_at = NULL WHERE id = 1");

    assert.throws(
      () => file(db, clock),
      (e) => e instanceof ObjectionError && e.code === "NOT_PUBLIC_WINDOW",
      "72 小时窗口内学生看不到别人的分，此时的质疑不可能有依据",
    );
  });

  test("理由必填", () => {
    const { db, clock } = world();
    assert.throws(
      () => file(db, clock, { reason: "   " }),
      (e) => e instanceof ObjectionError && e.code === "REASON_REQUIRED",
    );
  });

  test("★ 材料必传 —— 匿名意味着裁决人只能凭材料判断", () => {
    const { db, clock } = world();
    assert.throws(
      () => file(db, clock, { attachmentId: null }),
      (e) => e instanceof ObjectionError && e.code === "ATTACHMENT_REQUIRED",
    );
  });

  test("★ 限流：同一学号在一个公示期最多两条", () => {
    const { db, clock } = world();
    const who = "2599000015";

    file(db, clock, { submitterStudentId: who });
    file(db, clock, { submitterStudentId: who });

    assert.equal(quotaUsed(db, TERM, SECRET, who), OBJECTION_QUOTA_PER_TERM);
    assert.throws(
      () => file(db, clock, { submitterStudentId: who }),
      (e) => e instanceof ObjectionError && e.code === "QUOTA_EXCEEDED",
    );
  });

  test("限流不影响别人", () => {
    const { db, clock } = world();

    file(db, clock, { submitterStudentId: "a" });
    file(db, clock, { submitterStudentId: "a" });

    assert.doesNotThrow(() => file(db, clock, { submitterStudentId: "b" }));
    assert.equal(quotaUsed(db, TERM, SECRET, "b"), 1);
  });

  test("换一个公示期，额度重置", () => {
    const { db, clock } = world();
    const who = "2599000015";
    file(db, clock, { submitterStudentId: who });
    file(db, clock, { submitterStudentId: who });

    db.exec("INSERT INTO terms (id, name, status) VALUES (2, '下一学期', 'PUBLIC')");
    db.exec(
      `UPDATE terms SET published_at = '${T0}' WHERE id = 2`,
    );

    assert.doesNotThrow(() =>
      file(db, clock, { termId: 2, submitterStudentId: who }),
    );
  });

  test("同一个学号在不同周期得到不同指纹，无法跨学期串联", () => {
    assert.notEqual(
      objectionFingerprint(SECRET, 1, ALICE),
      objectionFingerprint(SECRET, 2, ALICE),
    );
  });

  test("换密钥后指纹完全不同（密钥泄露与否决定匿名强度）", () => {
    assert.notEqual(
      objectionFingerprint(SECRET, TERM, ALICE),
      objectionFingerprint("other", TERM, ALICE),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 双签
// ---------------------------------------------------------------------------

describe("双签裁决", () => {
  test("★ 只有主席签，不生效", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    const afterFirst = signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: -6,
      reason: "核对秩序册，该生确实未参赛",
      clock,
    });

    assert.equal(afterFirst.outcome, "PROPOSED");
    assert.equal(afterFirst.objection.status, "PENDING", "一个人签不算数");
    assert.equal(scoreOfItem(db, BOB), 6, "分数未变");
  });

  test("★ 双签齐了才生效，且分数真的变了", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: -6,
      reason: "核对秩序册，该生确实未参赛",
      clock,
    });

    const decided = signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "UPHOLD",
      delta: -6,
      reason: "同意，已向体育部核实",
      clock,
    });

    assert.equal(decided.outcome, "CONFIRMED");
    assert.equal(decided.objection.status, "UPHELD");
    assert.equal(decided.objection.grantedDelta, -6);
    assert.equal(scoreOfItem(db, BOB), 0, "异议成立后分数被减掉了");
    assert.equal(verifyChain(db).ok, true);
  });

  test("★ 可加也可减 —— 两个方向都要能走", () => {
    const { db, clock } = world();

    // 先制造一个"少给了分"的场景：把乙的分改成 2
    db.exec("DROP TRIGGER score_events_no_update");
    db.exec("UPDATE score_events SET delta = 2 WHERE id = 1");

    const objection = file(db, clock, {
      reason: "学生乙实际获得第二名，应加 4 分而非 2 分",
    });

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: 4,
      reason: "核对成绩单，确为第二名",
      clock,
    });
    signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "UPHOLD",
      delta: 4,
      reason: "同意",
      clock,
    });

    assert.equal(scoreOfItem(db, BOB), 6);
  });

  test("★ 同一角色签两次不行（必须一位主席 + 一位管理员）", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: 0,
      reason: "维持原判",
      clock,
    });

    assert.throws(
      () =>
        signObjection(db, {
          objectionId: objection.id,
          signerId: "chair-b",
          signerRole: "CHAIR",
          decision: "UPHOLD",
          delta: 0,
          reason: "我也同意",
          clock,
        }),
      (e) => e instanceof ObjectionError && e.code === "ROLE_ALREADY_SIGNED",
      "两位主席签等于没有制衡 —— 双签的意义就在于两个不同的角色各出一人",
    );
  });

  test("同一账号不能签两次", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: 0,
      reason: "维持原判",
      clock,
    });

    assert.throws(
      () =>
        signObjection(db, {
          objectionId: objection.id,
          signerId: PRESIDENT,
          signerRole: "CHAIR",
          decision: "UPHOLD",
          delta: 0,
          reason: "我再签一次",
          clock,
        }),
      (e) => e instanceof ObjectionError && e.code === "DUPLICATE_SIGNER",
    );
  });

  test("★ 两人意见不一致 → 退回待处理，分歧留痕（且必须提交）", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: -6,
      reason: "材料属实，应减分",
      clock,
    });

    const dissent = signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "DISMISS",
      reason: "材料不足以证明未参赛",
      clock,
    });

    assert.equal(dissent.outcome, "DISSENTED");
    assert.match(dissent.outcome === "DISSENTED" ? dissent.message : "", /意见不一致/);

    const after = getObjection(db, objection.id);
    assert.equal(after.status, "PENDING", "分歧不能让异议自动通过或自动作废");
    assert.equal(after.proposalDecision, null, "提案被清空，等两人重新表意");
    assert.equal(scoreOfItem(db, BOB), 6, "分数不变");

    // 这一条是关键：分歧记录必须**真的落库**。
    // 若用抛错表达分歧，整个事务会回滚，"两人吵过一架"在事后完全看不到，
    // 公示期照样能归档 —— 那 §8.5 就白写了。
    const steps = objectionSignatures(db, objection.id);
    assert.equal(steps.length, 2, "分歧必须留下记录");
    assert.equal(steps[1]?.outcome, "DISSENTED", "分歧必须留痕");
  });

  test("不成立的异议不改分", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "DISMISS",
      reason: "已核实，秩序册姓名遗漏",
      clock,
    });
    const decided = signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "DISMISS",
      reason: "同意",
      clock,
    });

    assert.equal(decided.outcome, "CONFIRMED");
    assert.equal(decided.objection.status, "DISMISSED");
    assert.equal(scoreOfItem(db, BOB), 6);
  });

  test("已裁决的异议不能再签", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "DISMISS",
      reason: "不成立",
      clock,
    });
    signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "DISMISS",
      reason: "同意",
      clock,
    });

    assert.throws(
      () =>
        signObjection(db, {
          objectionId: objection.id,
          signerId: "someone",
          signerRole: "ADMIN",
          decision: "UPHOLD",
          reason: "改主意了",
          clock,
        }),
      (e) => e instanceof ObjectionError && e.code === "OBJECTION_CLOSED",
    );
  });

  test("签署必须写理由", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    assert.throws(
      () =>
        signObjection(db, {
          objectionId: objection.id,
          signerId: PRESIDENT,
          signerRole: "CHAIR",
          decision: "DISMISS",
          reason: "  ",
          clock,
        }),
      (e) => e instanceof ObjectionError && e.code === "REASON_REQUIRED",
    );
  });

  test("★ 异议改分同样受上限约束", () => {
    const { db, clock } = world();
    const objection = file(db, clock, { reason: "应再加 5 分" });

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: 5,
      reason: "同意加分",
      clock,
    });

    assert.throws(
      () =>
        signObjection(db, {
          objectionId: objection.id,
          signerId: ADMIN,
          signerRole: "ADMIN",
          decision: "UPHOLD",
          delta: 5,
          reason: "同意",
          clock,
        }),
      /上限/,
      "走异议也不能突破上限 —— 三条改分通道受同一套约束",
    );
  });

  test("签署记录不可改写、不可删除", () => {
    const { db, clock } = world();
    const objection = file(db, clock);
    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "DISMISS",
      reason: "不成立",
      clock,
    });

    assert.throws(
      () => db.exec("UPDATE objection_signatures SET decision = 'UPHOLD'"),
      /LEDGER_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec("DELETE FROM objection_signatures"),
      /LEDGER_IMMUTABLE/,
    );
  });

  test("签署留痕包含双方姓名与理由", () => {
    const { db, clock } = world();
    const objection = file(db, clock);
    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: -6,
      reason: "材料属实",
      clock,
    });
    signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "UPHOLD",
      delta: -6,
      reason: "已核实",
      clock,
    });

    const steps = objectionSignatures(db, objection.id);
    assert.deepEqual(
      steps.map((s) => s.signerId),
      [PRESIDENT, ADMIN],
    );
    assert.deepEqual(
      steps.map((s) => s.outcome),
      ["PROPOSED", "CONFIRMED"],
    );
    assert.equal(steps[0]?.signerRole, "CHAIR");
    assert.equal(steps[1]?.signerRole, "ADMIN");
  });
});

// ---------------------------------------------------------------------------
// 4. 公示期顺延（§8.5）
// ---------------------------------------------------------------------------

describe("公示期满有未裁决异议 → 不归档", () => {
  test("★ 无异议时按时归档", () => {
    const { db, clock } = world();
    clock.advance(7 * DAY + 1);

    assert.equal(effectiveStatus(db, TERM, clock), "ARCHIVED");
  });

  test("★ 有未裁决异议就不归档，公示期自动顺延", () => {
    const { db, clock } = world();
    file(db, clock);

    clock.advance(7 * DAY + 1);

    assert.equal(
      effectiveStatus(db, TERM, clock),
      "PUBLIC",
      "带着未处理异议归档，等于让『拖着不办』成为最省事的应对方式",
    );
    assert.equal(pendingObjectionCount(db, TERM), 1);
  });

  test("裁决完毕之后才归档", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    clock.advance(7 * DAY + 1);
    assert.equal(effectiveStatus(db, TERM, clock), "PUBLIC");

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "DISMISS",
      reason: "已核实",
      clock,
    });
    assert.equal(effectiveStatus(db, TERM, clock), "PUBLIC", "一个人签还不够");

    signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "DISMISS",
      reason: "同意",
      clock,
    });
    assert.equal(effectiveStatus(db, TERM, clock), "ARCHIVED");
  });

  test("意见不一致导致的退回，同样会继续顺延", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: -6,
      reason: "应减分",
      clock,
    });
    const dissent = signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "DISMISS",
      reason: "不同意",
      clock,
    });

    assert.equal(dissent.outcome, "DISSENTED");

    clock.advance(7 * DAY + 1);
    assert.equal(
      effectiveStatus(db, TERM, clock),
      "PUBLIC",
      "吵完架还没结论，公示期同样不能归档",
    );
  });

  test("★ 顺延天数可算出来，供公示页显示", () => {
    const { db, clock } = world();
    file(db, clock);

    const term = {
      id: TERM,
      name: "x",
      status: "PUBLIC" as const,
      publishedAt: T0,
      archivedAt: null,
    };

    assert.equal(publicityOverdueDays(term, clock), 0, "还没到期，不算顺延");

    clock.advance(7 * DAY + 2 * DAY + HOUR);
    assert.equal(publicityOverdueDays(term, clock), 2, "超过公示期 2 天多，应算 2 天");

    void db;
  });
});

// ---------------------------------------------------------------------------
// 5. 公示页呈现
// ---------------------------------------------------------------------------

describe("公示页要让人看见", () => {
  test("★ 公示页显示待裁决异议与顺延天数", () => {
    const { db, clock } = world();
    file(db, clock);

    clock.advance(7 * DAY + 2 * DAY);
    const html = renderPublicityPage(db, TERM, { kind: "staff" }, clock);

    assert.match(html, /异议/, "公示页必须提到异议");
    assert.match(html, /未裁决|待处理/, "必须显示异议还没裁");
    assert.match(html, /顺延/, "必须显示公示期已顺延");
    assert.match(html, /2 天/, "必须给出顺延天数");
  });

  test("没有待裁决异议时不显示顺延提示", () => {
    const { db, clock } = world();
    const html = renderPublicityPage(db, TERM, { kind: "staff" }, clock);

    assert.ok(!html.includes("顺延"));
  });

  test("公示页列出异议的处理结果，可加可减都写清楚", () => {
    const { db, clock } = world();
    const objection = file(db, clock);

    signObjection(db, {
      objectionId: objection.id,
      signerId: PRESIDENT,
      signerRole: "CHAIR",
      decision: "UPHOLD",
      delta: -6,
      reason: "材料属实，应减分",
      clock,
    });
    signObjection(db, {
      objectionId: objection.id,
      signerId: ADMIN,
      signerRole: "ADMIN",
      decision: "UPHOLD",
      delta: -6,
      reason: "已向体育部核实",
      clock,
    });

    const html = renderPublicityPage(db, TERM, { kind: "staff" }, clock);
    assert.ok(html.includes("成立"), "应显示异议成立");
    assert.ok(html.includes("材料属实，应减分"), "应显示裁决理由");
  });
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function scoreOfItem(db: Db, studentId: string): number {
  const sliceRow = db
    .prepare("SELECT mode, baseline FROM scoring_items WHERE id = ?")
    .get(ITEM_SPORTS) as { mode: string; baseline: number };

  const sum = (
    db
      .prepare(
        "SELECT COALESCE(SUM(delta), 0) AS s FROM score_events WHERE term_id = ? AND student_id = ? AND item_id = ?",
      )
      .get(TERM, studentId, ITEM_SPORTS) as { s: number }
  ).s;

  return sliceRow.mode === "BASELINE" ? sliceRow.baseline + sum : sum;
}

function getTermRow(db: Db): { id: number; name: string; status: string } {
  return db.prepare("SELECT id, name, status FROM terms WHERE id = ?").get(TERM) as {
    id: number;
    name: string;
    status: string;
  };
}

interface SourceFile {
  path: string;
  content: string;
}

function collectSources(root: string): SourceFile[] {
  const out: SourceFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        out.push({
          path: full.replace(process.cwd(), "").replace(/\\/g, "/"),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };

  walk(root);
  return out;
}

void SPORTS;
void OFFICE;
void listObjections;

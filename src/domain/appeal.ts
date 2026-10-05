/**
 * 申诉链路
 *
 * 设计文档 §8.2。实名申诉，发布后 72 小时内发起。
 *
 *   负责人初审 → 副部长复审 → 部长终审，三级全过才生效
 *   每级 24 小时，超时自动升级；终审超时转主席 + 管理员双签
 *
 * 四条设计意图，每一条都在测试里有守门的断言：
 *
 * 1. **驳回必须写理由。** 没有理由的驳回，和"我就是要卡你"没有区别。
 *
 * 2. **回避。** 审批链上撞到申诉人自己就跳过该级 —— 否则副部长给自己申诉时，
 *    会由副部长本人初审通过。
 *
 * 3. **超时自动升级。** 学生的申诉窗口只有 72 小时。如果审批人"忘了处理"，
 *    学生的权利就被拖没了。让拖延失效，是让流程可信的前提。
 *
 * 4. **72 小时内提交的申诉不因窗口关闭而作废。** 窗口关闭关闭的是"提交"，
 *    不是"处理"。延迟是审批人的责任，不是学生的。
 */

import type { DatabaseSync } from "node:sqlite";

import { transaction } from "../db/db.ts";
import { appendEvent, type ScoreEvent } from "../db/ledger.ts";
import { getItem } from "./item.ts";
import { canAppeal } from "./term.ts";
import { assertWithinBounds } from "./slice.ts";
import type { Clock } from "./clock.ts";

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 每一级的处理时限：24 小时。与申诉窗口一样是常量，不可配置。 */
export const STAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 双签需要的人数 */
export const DOUBLE_SIGN_COUNT = 2;

export const PERSON_STAGES = ["OWNER", "DEPUTY", "HEAD"] as const;
export type PersonStage = (typeof PERSON_STAGES)[number];

export type Stage = PersonStage | "CHAIR_ADMIN" | "DONE";

export const APPEAL_STATUSES = ["PENDING", "GRANTED", "REJECTED"] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export const STEP_ACTIONS = [
  "APPROVE",
  "REJECT",
  "SKIP_CONFLICT",
  "ESCALATE_TIMEOUT",
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** 提交时快照的审批链 */
export interface AppealChain {
  OWNER: readonly string[];
  DEPUTY: readonly string[];
  HEAD: readonly string[];
}

export interface Appeal {
  id: number;
  termId: number;
  studentId: string;
  itemId: number;
  reason: string;
  attachmentId: number;
  requestedDelta: number;
  chain: AppealChain;
  status: AppealStatus;
  stage: Stage;
  stageEnteredAt: string;
  signers: string[];
  submittedAt: string;
  decidedAt: string | null;
}

export interface AppealStep {
  id: number;
  appealId: number;
  stage: Exclude<Stage, "DONE">;
  actorId: string | null;
  action: StepAction;
  reason: string | null;
  actedAt: string;
}

export class AppealError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppealError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

interface AppealRow {
  id: number;
  term_id: number;
  student_id: string;
  item_id: number;
  reason: string;
  attachment_id: number;
  requested_delta: number;
  chain_json: string;
  status: string;
  stage: string;
  stage_entered_at: string;
  signers_json: string;
  submitted_at: string;
  decided_at: string | null;
}

function toAppeal(raw: Record<string, unknown>): Appeal {
  const row = raw as unknown as AppealRow;
  return {
    id: row.id,
    termId: row.term_id,
    studentId: row.student_id,
    itemId: row.item_id,
    reason: row.reason,
    attachmentId: row.attachment_id,
    requestedDelta: row.requested_delta,
    chain: JSON.parse(row.chain_json) as AppealChain,
    status: row.status as AppealStatus,
    stage: row.stage as Stage,
    stageEnteredAt: row.stage_entered_at,
    signers: JSON.parse(row.signers_json) as string[],
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
  };
}

export function getAppeal(db: DatabaseSync, appealId: number): Appeal {
  const row = db.prepare("SELECT * FROM appeals WHERE id = ?").get(appealId);
  if (!row) {
    throw new AppealError("APPEAL_NOT_FOUND", `申诉 ${appealId} 不存在`);
  }
  return toAppeal(row);
}

interface StepRow {
  id: number;
  appeal_id: number;
  stage: string;
  actor_id: string | null;
  action: string;
  reason: string | null;
  acted_at: string;
}

export function appealSteps(db: DatabaseSync, appealId: number): AppealStep[] {
  return db
    .prepare("SELECT * FROM appeal_steps WHERE appeal_id = ? ORDER BY id")
    .all(appealId)
    .map((raw) => {
      const row = raw as unknown as StepRow;
      return {
        id: row.id,
        appealId: row.appeal_id,
        stage: row.stage as Exclude<Stage, "DONE">,
        actorId: row.actor_id,
        action: row.action as StepAction,
        reason: row.reason,
        actedAt: row.acted_at,
      };
    });
}

// ---------------------------------------------------------------------------
// 阶段推导
// ---------------------------------------------------------------------------

function writeStep(
  db: DatabaseSync,
  appealId: number,
  stage: Exclude<Stage, "DONE">,
  action: StepAction,
  actorId: string | null,
  reason: string | null,
  clock: Clock,
): void {
  db.prepare(
    `INSERT INTO appeal_steps (appeal_id, stage, actor_id, action, reason, acted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(appealId, stage, actorId, action, reason, clock.now().toISOString());
}

/**
 * 从 `from` 之后的第一个「有人可审」的阶段。
 *
 * 审批链上撞到申诉人自己的阶段会被跳过，并各记一条 SKIP_CONFLICT ——
 * 跳过必须留痕，否则事后看起来就像从来没经过这一级。
 */
function firstActionableStage(
  db: DatabaseSync,
  appealId: number,
  chain: AppealChain,
  studentId: string,
  after: PersonStage | null,
  clock: Clock,
): Stage {
  const startIndex = after === null ? 0 : PERSON_STAGES.indexOf(after) + 1;

  for (let i = startIndex; i < PERSON_STAGES.length; i += 1) {
    const stage = PERSON_STAGES[i]!;
    const actors = chain[stage].filter((id) => id !== studentId);

    if (actors.length > 0) return stage;

    writeStep(
      db,
      appealId,
      stage,
      "SKIP_CONFLICT",
      studentId,
      "回避：该级审批人即申诉人本人，依回避规则跳过本级",
      clock,
    );
  }

  return "CHAIR_ADMIN";
}

function nextPersonStage(stage: Stage): PersonStage | null {
  if (stage === "OWNER") return "DEPUTY";
  if (stage === "DEPUTY") return "HEAD";
  return null;
}

/**
 * 由存储的阶段与当前时刻**推导**出的实际阶段。
 *
 * 与周期状态机同理：超时升级由时间推导，不依赖定时任务。
 * 定时任务一挂，不能让"拖延"变成一种有效的战术。
 */
function deriveStage(appeal: Appeal, clock: Clock): Stage {
  if (appeal.stage === "DONE" || appeal.stage === "CHAIR_ADMIN") return appeal.stage;

  let stage: Stage = appeal.stage;
  let enteredAt = Date.parse(appeal.stageEnteredAt);
  const now = clock.now().getTime();

  // 用"是三级中的某一级"做循环条件，而不是"不等于终止态"：
  // 后者会让类型收窄与运行时推进打架。
  while (stage === "OWNER" || stage === "DEPUTY" || stage === "HEAD") {
    if (now < enteredAt + STAGE_WINDOW_MS) break;

    enteredAt += STAGE_WINDOW_MS;
    // 超时只推进阶段，不做回避跳过：时间流逝与"谁在任"无关。
    stage = stage === "HEAD" ? "CHAIR_ADMIN" : (nextPersonStage(stage) ?? "CHAIR_ADMIN");
  }

  return stage;
}

/** 当前实际阶段（已计入超时升级） */
export function currentStage(db: DatabaseSync, appealId: number, clock: Clock): Stage {
  return deriveStage(getAppeal(db, appealId), clock);
}

/**
 * 某人此刻能否审批这条申诉。
 *
 * 注意：**超时之后原审批人立即失去权力**，无需等定时任务。
 */
export function canAct(
  db: DatabaseSync,
  appealId: number,
  actorId: string,
  clock: Clock,
): boolean {
  const appeal = getAppeal(db, appealId);
  if (appeal.status !== "PENDING") return false;

  // 本人回避：任何人不能审批自己的申诉
  if (actorId === appeal.studentId) return false;

  const stage = deriveStage(appeal, clock);
  if (stage === "DONE") return false;

  if (stage === "CHAIR_ADMIN") {
    return !appeal.signers.includes(actorId);
  }

  return appeal.chain[stage].includes(actorId);
}

// ---------------------------------------------------------------------------
// 发起申诉
// ---------------------------------------------------------------------------

export interface SubmitAppealInput {
  termId: number;
  studentId: string;
  itemId: number;
  reason: string;
  attachmentId: number | null;
  requestedDelta: number;
  chain: AppealChain;
  clock: Clock;
}

export function submitAppeal(db: DatabaseSync, input: SubmitAppealInput): Appeal {
  const { clock } = input;

  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new AppealError(
      "REASON_REQUIRED",
      "申诉理由不能为空。没有理由的申诉无法被审理，也无法被回应。",
    );
  }

  if (input.attachmentId === null || input.attachmentId === undefined) {
    throw new AppealError(
      "ATTACHMENT_REQUIRED",
      "申诉必须上传证明材料。无材料的申诉不予受理 —— " +
        "加分的依据必须是一份可以被别人核查的东西，而不是一句话。",
    );
  }

  const attachment = db
    .prepare("SELECT id FROM attachments WHERE id = ?")
    .get(input.attachmentId);

  if (!attachment) {
    throw new AppealError("ATTACHMENT_NOT_FOUND", `材料 ${input.attachmentId} 不存在`);
  }

  // 刻意**不校验**材料的上传者是不是申诉人本人。
  //
  // 曾经加过这条校验，后来去掉了，理由有两条：
  //
  // 1. 它会挡掉正当流程。材料由班长代收、同学帮忙上传，在院里是常态；
  //    硬性拒绝会把"本人发起、他人代传"这种完全合理的情形一起挡在门外。
  //
  // 2. 它挡不住真正的攻击。要冒用他人身份提交申诉，先得登录成那个人 ——
  //    那是身份认证（M2.1）该管的事，不是材料表该管的事。
  //
  // 系统的职责是把事实摆到审批人面前，**判断真伪是三级审批的事**。
  // 因此上传者信息会被完整记录，并在审批界面与公示页显示（见 appealDetail）。
  // 材料与申诉人不是同一人时，审批人会看到提示，自行判断要不要采信。

  if (!Number.isFinite(input.requestedDelta) || input.requestedDelta <= 0) {
    throw new AppealError("INVALID_DELTA", "申诉申请的分值必须是正数");
  }

  return transaction(db, () => {
    const item = getItem(db, input.itemId); // 不存在则抛错

    if (!canAppeal(db, input.termId, clock)) {
      throw new AppealError(
        "APPEAL_WINDOW_CLOSED",
        "当前不处于申诉窗口：只有发布后的 72 小时内可以发起申诉。",
      );
    }

    const rejected = db
      .prepare(
        `SELECT id FROM appeals
          WHERE term_id = ? AND student_id = ? AND item_id = ? AND status = 'REJECTED'`,
      )
      .get(input.termId, input.studentId, input.itemId);
    if (rejected) {
      throw new AppealError(
        "DUPLICATE_APPEAL",
        `该计分项（${item.groupCode} ${item.name}）此前已有被驳回的申诉，不可重复申诉。`,
      );
    }

    const now = clock.now().toISOString();

    const info = db
      .prepare(
        `INSERT INTO appeals
           (term_id, student_id, item_id, reason, attachment_id, requested_delta,
            chain_json, status, stage, stage_entered_at, signers_json, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'OWNER', ?, '[]', ?)`,
      )
      .run(
        input.termId,
        input.studentId,
        input.itemId,
        input.reason,
        input.attachmentId,
        input.requestedDelta,
        JSON.stringify(input.chain),
        now,
        now,
      );

    const appealId = Number(info.lastInsertRowid);

    // 起点就要做回避判定：如果负责人本人就是申诉人，直接进副部长这一级
    const stage = firstActionableStage(
      db,
      appealId,
      input.chain,
      input.studentId,
      null,
      clock,
    );

    db.prepare("UPDATE appeals SET stage = ? WHERE id = ?").run(stage, appealId);

    return getAppeal(db, appealId);
  });
}

// ---------------------------------------------------------------------------
// 审批
// ---------------------------------------------------------------------------

export interface ActInput {
  appealId: number;
  actorId: string;
  action: "APPROVE" | "REJECT";
  reason: string;
  /** 终审时可只批准一部分；省略则按申请值批准 */
  delta?: number;
  clock: Clock;
}

export function act(db: DatabaseSync, input: ActInput): Appeal {
  // 先把已发生的超时升级落库并**独立提交**，再判权限。
  //
  // 顺序与事务边界都很重要：这样"负责人超时后还想驳回"这种情况被拒绝时，
  // 他的超时记录不会被一起回滚掉。拖延的证据不能在拒绝拖延的同时消失。
  materializeAppeal(db, input.appealId, input.clock);

  return transaction(db, () => {
    const appeal = getAppeal(db, input.appealId);

    if (appeal.status !== "PENDING") {
      throw new AppealError(
        "APPEAL_CLOSED",
        `申诉 ${appeal.id} 已结束（当前状态 ${appeal.status}），不能再审批。`,
      );
    }

    if (typeof input.reason !== "string" || input.reason.trim() === "") {
      throw new AppealError(
        "REASON_REQUIRED",
        `审批必须写明理由。没有理由的${input.action === "REJECT" ? "驳回" : "通过"}，` +
          `与「我就是要这样」没有区别。`,
      );
    }

    const stage = deriveStage(appeal, input.clock);

    if (stage === "DONE") {
      throw new AppealError("APPEAL_CLOSED", `申诉 ${appeal.id} 已结束`);
    }

    if (input.actorId === appeal.studentId) {
      throw new AppealError(
        "SELF_APPROVAL_FORBIDDEN",
        "回避：任何人不能审批自己的申诉。",
      );
    }

    const isChairStage = stage === "CHAIR_ADMIN";
    const allowed = isChairStage
      ? !appeal.signers.includes(input.actorId)
      : appeal.chain[stage].includes(input.actorId);

    if (!allowed) {
      throw new AppealError(
        "NOT_CURRENT_APPROVER",
        `无权审批：申诉当前处于 ${stage} 阶段，${input.actorId} 不在此级的审批链上` +
          (isChairStage ? "，或已经签署过（双签需要两个不同的人）" : "") +
          "。",
      );
    }

    const now = input.clock.now().toISOString();

    // ---- 驳回：任一级驳回即终止 ----
    if (input.action === "REJECT") {
      writeStep(db, appeal.id, stage, "REJECT", input.actorId, input.reason, input.clock);

      db.prepare(
        "UPDATE appeals SET status = 'REJECTED', stage = 'DONE', decided_at = ? WHERE id = ?",
      ).run(now, appeal.id);

      appendEvent(db, {
        termId: appeal.termId,
        studentId: appeal.studentId,
        itemId: appeal.itemId,
        delta: 0,
        eventType: "REJECT",
        actorId: input.actorId,
        reason: `[申诉 #${appeal.id} 于 ${stage} 级驳回] ${input.reason}`,
        appealId: appeal.id,
      });

      return getAppeal(db, appeal.id);
    }

    // ---- 通过 ----
    writeStep(db, appeal.id, stage, "APPROVE", input.actorId, input.reason, input.clock);

    if (isChairStage) {
      const signers = [...appeal.signers, input.actorId];
      const enough = signers.length >= DOUBLE_SIGN_COUNT;

      db.prepare("UPDATE appeals SET signers_json = ? WHERE id = ?").run(
        JSON.stringify(signers),
        appeal.id,
      );

      if (!enough) {
        return getAppeal(db, appeal.id);
      }

      return grant(db, getAppeal(db, appeal.id), input, now);
    }

    // 人级阶段：推进到下一个有人可审的阶段
    const next = nextPersonStage(stage);

    if (next === null) {
      // 终审通过 → 生效
      return grant(db, appeal, input, now);
    }

    const nextStage = firstActionableStage(
      db,
      appeal.id,
      appeal.chain,
      appeal.studentId,
      stage,
      input.clock,
    );

    db.prepare("UPDATE appeals SET stage = ?, stage_entered_at = ? WHERE id = ?").run(
      nextStage,
      now,
      appeal.id,
    );

    return getAppeal(db, appeal.id);
  });
}

/** 终审通过：校验上限、写入 APPEAL_GRANT、置为已通过 */
function grant(
  db: DatabaseSync,
  appeal: Appeal,
  input: ActInput,
  now: string,
): Appeal {
  const item = getItem(db, appeal.itemId);
  const delta = input.delta ?? appeal.requestedDelta;

  if (delta <= 0) {
    throw new AppealError("INVALID_DELTA", "批准的加分必须是正数");
  }
  if (delta > appeal.requestedDelta) {
    throw new AppealError(
      "DELTA_EXCEEDS_REQUEST",
      `批准的加分（${delta}）不得大于申请值（${appeal.requestedDelta}）。` +
        `申诉是学生主张权利，不是审批人赠送人情的通道。`,
    );
  }

  // 申诉加分和录入加分受完全相同的上限管，不存在"走申诉就能突破上限"
  assertWithinBounds(db, item, appeal.termId, appeal.studentId, delta);

  appendEvent(db, {
    termId: appeal.termId,
    studentId: appeal.studentId,
    itemId: appeal.itemId,
    delta,
    eventType: "APPEAL_GRANT",
    actorId: input.actorId,
    reason: `[申诉 #${appeal.id} 三级通过] ${input.reason}`,
    appealId: appeal.id,
  });

  db.prepare(
    "UPDATE appeals SET status = 'GRANTED', stage = 'DONE', decided_at = ? WHERE id = ?",
  ).run(now, appeal.id);

  return getAppeal(db, appeal.id);
}

// ---------------------------------------------------------------------------
// 超时升级物化
// ---------------------------------------------------------------------------

/**
 * 把某条申诉推导出的阶段落库，并为每一次超时升级补写留痕。
 *
 * 为什么 `act` 也要调用它？因为留痕不能等定时任务。
 *
 * 授权判定（`canAct`）从一开始就按超时后的阶段生效 —— 这部分不依赖任何后台任务。
 * 但如果**记录**只在定时任务里写，那么"任务恰好没跑"和"没人拖过"在事后看起来
 * 一模一样，而这两件事的意义完全相反。让记录在任何人触碰这条申诉时就立即补上，
 * 拖延就再也藏不住。
 */
function materializeAppealRow(
  db: DatabaseSync,
  appealId: number,
  clock: Clock,
): Appeal {
  const appeal = getAppeal(db, appealId);
  if (appeal.status !== "PENDING") return appeal;

  const derived = deriveStage(appeal, clock);
  if (derived === appeal.stage) return appeal;

  let stage: Stage = appeal.stage;
  let enteredAt = Date.parse(appeal.stageEnteredAt);

  while (stage !== derived && stage !== "DONE") {
    enteredAt += STAGE_WINDOW_MS;
    writeStep(
      db,
      appealId,
      stage as Exclude<Stage, "DONE">,
      "ESCALATE_TIMEOUT",
      null,
      `本级 ${STAGE_WINDOW_MS / 3600000} 小时内未处理，自动升级`,
      { now: () => new Date(enteredAt) },
    );
    stage = stage === "HEAD" ? "CHAIR_ADMIN" : (nextPersonStage(stage) ?? "CHAIR_ADMIN");
  }

  db.prepare("UPDATE appeals SET stage = ?, stage_entered_at = ? WHERE id = ?").run(
    derived,
    new Date(enteredAt).toISOString(),
    appealId,
  );

  return getAppeal(db, appealId);
}

/**
 * 独立事务版本。**必须独立提交**。
 *
 * 因为 `act` 会在权限检查失败时抛错回滚 —— 如果超时留痕和权限检查在同一个事务里，
 * "负责人超时后还想驳回"这种最需要留下记录的场景，恰恰会把记录一起回滚掉。
 *
 * 拖延的证据，不能在拒绝拖延的同时被丢掉。
 */
export function materializeAppeal(
  db: DatabaseSync,
  appealId: number,
  clock: Clock,
): Appeal {
  return transaction(db, () => materializeAppealRow(db, appealId, clock));
}

/**
 * 对所有待处理申诉跑一遍物化。定时任务调用它。
 *
 * 与周期状态机同理：它**不参与授权**。即使从未被调用，`canAct` 也已按超时后的
 * 阶段在判定了。它存在的意义是让"谁在拖"变成可查的记录。
 */
export function materializeAppeals(db: DatabaseSync, clock: Clock): number {
  return transaction(db, () => {
    const ids = (
      db.prepare("SELECT id FROM appeals WHERE status = 'PENDING' ORDER BY id").all() as {
        id: number;
      }[]
    ).map((r) => r.id);

    let changed = 0;
    for (const id of ids) {
      const before = getAppeal(db, id).stage;
      if (materializeAppealRow(db, id, clock).stage !== before) changed += 1;
    }
    return changed;
  });
}

/** 某学生某计分项是否存在被驳回的申诉（用于前端提示"不可重复申诉"） */
export function hasRejectedAppeal(
  db: DatabaseSync,
  termId: number,
  studentId: string,
  itemId: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM appeals
        WHERE term_id = ? AND student_id = ? AND item_id = ? AND status = 'REJECTED'`,
    )
    .get(termId, studentId, itemId);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// 审批人视角的申诉全貌
// ---------------------------------------------------------------------------

export interface Attachment {
  id: number;
  filename: string;
  sha256: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

export function getAttachment(db: DatabaseSync, attachmentId: number): Attachment {
  const raw = db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
  if (!raw) {
    throw new AppealError("ATTACHMENT_NOT_FOUND", `材料 ${attachmentId} 不存在`);
  }
  const row = raw as unknown as {
    id: number;
    filename: string;
    sha256: string;
    size_bytes: number;
    uploaded_by: string;
    uploaded_at: string;
  };
  return {
    id: row.id,
    filename: row.filename,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

export interface AppealDetail {
  appeal: Appeal;
  attachment: Attachment;
  /**
   * 材料上传者与申诉人不是同一人。
   *
   * **这不是错误，是需要审批人注意的事实。** 系统不替人判断真伪，
   * 只负责把"这份材料是谁传的"摆到台面上。班长代收、同学代传都是正常的，
   * 但审批人有权知道，并据此决定要不要向本人核实。
   */
  materialFromThirdParty: boolean;
  steps: AppealStep[];
  /** 当前该谁审批（已计入超时升级） */
  awaitingStage: Stage;
  /** 当前阶段可以审批的人 */
  awaitingActors: string[];
}

export function appealDetail(
  db: DatabaseSync,
  appealId: number,
  clock: Clock,
): AppealDetail {
  const appeal = getAppeal(db, appealId);
  const attachment = getAttachment(db, appeal.attachmentId);
  const stage = deriveStage(appeal, clock);

  const awaitingActors =
    stage === "DONE"
      ? []
      : stage === "CHAIR_ADMIN"
        ? appeal.signers.length === 0
          ? ["主席", "管理员"]
          : ["（已有 1 人签署，还差 1 人）"]
        : appeal.chain[stage].filter((id) => id !== appeal.studentId);

  return {
    appeal,
    attachment,
    materialFromThirdParty: attachment.uploadedBy !== appeal.studentId,
    steps: appealSteps(db, appealId),
    awaitingStage: stage,
    awaitingActors,
  };
}

/** 申诉产生的事件（供公示页展示"这一分是申诉加上来的"） */export function appealEvents(db: DatabaseSync, appealId: number): ScoreEvent[] {
  return db
    .prepare("SELECT * FROM score_events WHERE appeal_id = ? ORDER BY id")
    .all(appealId)
    .map((raw) => {
      const r = raw as unknown as {
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
      };
      return {
        id: r.id,
        termId: r.term_id,
        studentId: r.student_id,
        itemId: r.item_id,
        delta: r.delta,
        eventType: r.event_type as ScoreEvent["eventType"],
        actorId: r.actor_id,
        reason: r.reason,
        sourceEventId: r.source_event_id,
        appealId: r.appeal_id,
        objectionId: r.objection_id,
        createdAt: r.created_at,
        prevHash: r.prev_hash,
        selfHash: r.self_hash,
      } satisfies ScoreEvent;
    });
}

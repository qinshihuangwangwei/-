/**
 * 迁移 005 —— 材料与申诉
 *
 * 申诉链路的审批人**在提交时快照**到 appeals.chain_json 里，
 * 而不是每次审批时去查当前谁在任。
 *
 * 理由：一份申诉应当由**收到它时在任的人**裁决。中途换届不应该改变谁来判它，
 * 否则"卡在换届前提交"和"换届后提交"会得到不同的裁决者，
 * 这本身就是一个可以被利用的缝隙。
 */

export const id = "005_appeals";

export const sql = `
-- ---------------------------------------------------------------------------
-- 材料
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 申诉
--
-- 只能由本人发起（student_id 即申诉人），实名。
-- ---------------------------------------------------------------------------
CREATE TABLE appeals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id         INTEGER NOT NULL REFERENCES terms(id),
  student_id      TEXT    NOT NULL REFERENCES students(id),
  item_id         INTEGER NOT NULL REFERENCES scoring_items(id),

  reason          TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  attachment_id   INTEGER NOT NULL REFERENCES attachments(id),

  requested_delta REAL    NOT NULL,

  -- 提交时快照的审批链：{"OWNER":[...], "DEPUTY":[...], "HEAD":[...]}
  chain_json      TEXT    NOT NULL,

  status          TEXT    NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'GRANTED', 'REJECTED')),

  stage           TEXT    NOT NULL
                    CHECK (stage IN ('OWNER', 'DEPUTY', 'HEAD', 'CHAIR_ADMIN', 'DONE')),

  -- 当前这一级的进入时刻。每级 24 小时，超时自动升级。
  stage_entered_at TEXT   NOT NULL,

  -- 双签已签过的人（JSON 数组）。仅 CHAIR_ADMIN 级使用。
  signers_json    TEXT    NOT NULL DEFAULT '[]',

  submitted_at    TEXT    NOT NULL,
  decided_at      TEXT
);

CREATE INDEX idx_appeals_term_student_item
  ON appeals (term_id, student_id, item_id);

-- ---------------------------------------------------------------------------
-- 审批留痕
--
-- 每一次通过、驳回、回避跳过、超时升级都写一条。这张表是"谁在拖"的唯一答案。
-- ---------------------------------------------------------------------------
CREATE TABLE appeal_steps (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  appeal_id INTEGER NOT NULL REFERENCES appeals(id),
  stage     TEXT    NOT NULL CHECK (stage IN ('OWNER', 'DEPUTY', 'HEAD', 'CHAIR_ADMIN')),
  actor_id  TEXT,
  action    TEXT    NOT NULL CHECK (action IN (
                      'APPROVE', 'REJECT', 'SKIP_CONFLICT', 'ESCALATE_TIMEOUT')),
  reason    TEXT,
  acted_at  TEXT    NOT NULL
);

CREATE INDEX idx_appeal_steps_appeal ON appeal_steps (appeal_id);

-- 审批留痕同样只增不改：如果"跳过了哪一级"可以被悄悄抹掉，
-- 回避规则就形同虚设。
CREATE TRIGGER appeal_steps_no_update
BEFORE UPDATE ON appeal_steps
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: UPDATE forbidden on appeal_steps');
END;

CREATE TRIGGER appeal_steps_no_delete
BEFORE DELETE ON appeal_steps
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: DELETE forbidden on appeal_steps');
END;
`;

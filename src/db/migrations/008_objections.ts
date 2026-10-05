/**
 * 迁移 008 —— 匿名异议
 *
 * 设计文档 §8.3 / §8.4。这张表最要紧的一点是它**没有什么**：
 *
 *   objections 表里**不存在任何指向用户的外键、也没有 user_id 列。**
 *
 * 只有 `submitter_fingerprint` —— 一个 HMAC 值，用于限流（同一学号在同一周期
 * 最多提 2 条），但**不可反推**。限流靠"同一个学号算出同一个指纹"实现，
 * 而不是靠"记下是谁"。
 *
 * 为什么需要这个通道（设计文档 §8.3）：
 * 72 小时申诉窗口内学生只能看到自己的分，因此无法发现"别人被乱加分"。
 * 等到公示期能看到了，系统已经锁死。若不设此通道，"给关系户多加分"
 * 这一最典型的人情分将绕过全部检查。
 */

export const id = "008_objections";

export const sql = `
CREATE TABLE objections (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id           INTEGER NOT NULL REFERENCES terms(id),

  -- 被质疑的是"某个人的某个计分项"，不是总分
  target_student_id TEXT    NOT NULL REFERENCES students(id),
  item_id           INTEGER NOT NULL REFERENCES scoring_items(id),

  reason            TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  attachment_id     INTEGER NOT NULL REFERENCES attachments(id),

  -- 发起人的不可逆指纹。HMAC(服务端密钥, 周期:学号)。
  -- 密钥存在数据库之外，因此翻遍这个库也推不出是谁提的。
  submitter_fingerprint TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'PENDING'
           CHECK (status IN ('PENDING', 'UPHELD', 'DISMISSED')),

  -- 待签署的提案：第一位签署人提出，第二位确认后才生效
  proposal_decision TEXT CHECK (proposal_decision IN ('UPHOLD', 'DISMISS')),
  proposal_delta    REAL,
  proposal_reason   TEXT,
  proposal_by       TEXT,

  -- 生效后的结果
  granted_delta   REAL,
  decision_reason TEXT,

  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX idx_objections_term_status ON objections (term_id, status);
CREATE INDEX idx_objections_fingerprint ON objections (term_id, submitter_fingerprint);
CREATE INDEX idx_objections_target ON objections (term_id, target_student_id, item_id);

-- ---------------------------------------------------------------------------
-- 双签留痕
--
-- 每一次签署（含意见不一致导致的否决）都写一条，只增不改。
-- ---------------------------------------------------------------------------
CREATE TABLE objection_signatures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  objection_id INTEGER NOT NULL REFERENCES objections(id),
  signer_id    TEXT    NOT NULL,
  -- 签署时的角色。主席与管理员必须各出一人，因此记下来。
  signer_role  TEXT    NOT NULL CHECK (signer_role IN ('CHAIR', 'ADMIN')),
  decision     TEXT    NOT NULL CHECK (decision IN ('UPHOLD', 'DISMISS')),
  delta        REAL,
  outcome      TEXT    NOT NULL CHECK (outcome IN ('PROPOSED', 'CONFIRMED', 'DISSENTED')),
  reason       TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  signed_at    TEXT    NOT NULL
);

CREATE INDEX idx_objection_signatures ON objection_signatures (objection_id);

CREATE TRIGGER objection_signatures_no_update
BEFORE UPDATE ON objection_signatures
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: UPDATE forbidden on objection_signatures');
END;

CREATE TRIGGER objection_signatures_no_delete
BEFORE DELETE ON objection_signatures
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: DELETE forbidden on objection_signatures');
END;
`;

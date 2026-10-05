/**
 * 参考数据：12 个部门 + 26 个计分项
 *
 * 数据来源：设计文档附录 A（A 项细则）与附录 B（部门清单），
 * 依据是真实的 `25级综测成绩*.xlsx`。
 *
 * **为什么是函数而不是迁移？**
 *
 * 1. 参考数据需要可修正。迁移是一次性的、只能向前的；如果哪天发现某个分项的
 *    名称或上限写错了，补一个迁移去改是可行的，但"参考数据"每次修改都占用一个
 *    迁移号，很快就乱。函数式播种可以随时修正、重复执行。
 * 2. 幂等可以显式测试。`seedReferenceData` 有"跑两次结果相同"的测试，
 *    迁移只能靠"迁移表里记了一行"来保证，测不到。
 *
 * 播种**只增不改**：已存在的 id 会被跳过。想改分值上限，用显式的管理操作，
 * 而不是靠偷偷改种子文件 —— 那会让已经算过的分数对不上。
 */

import type { DatabaseSync } from "node:sqlite";

import { transaction } from "./db.ts";

// ---------------------------------------------------------------------------
// 部门（附录 B）
// ---------------------------------------------------------------------------

export const DEPARTMENTS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: "办公室" },
  { id: 2, name: "生活实践部" },
  { id: 3, name: "网络思政部" },
  { id: 4, name: "新闻采编部" },
  { id: 5, name: "公共权益部" },
  { id: 6, name: "青年发展部" },
  { id: 7, name: "心理健康部" },
  { id: 8, name: "学习部" },
  { id: 9, name: "组织部" },
  { id: 10, name: "宣传部" },
  { id: 11, name: "体育部" },
  { id: 12, name: "文艺部" },
];

/** 部门名 → id，便于按名字引用（测试与配置里比裸数字好读） */
export const DEPARTMENT_ID: Readonly<Record<string, number>> = Object.fromEntries(
  DEPARTMENTS.map((d) => [d.name, d.id]),
);

// ---------------------------------------------------------------------------
// 计分项（附录 A）
// ---------------------------------------------------------------------------

export interface SeedItem {
  id: number;
  groupCode: string;
  name: string;
  cap: number;
  mode: "ACCUMULATE" | "BASELINE";
  baseline: number;
  /** 默认责任部门（部门名）。null 表示尚无定论，指派时必须人工选择。 */
  defaultDepartment: string | null;
  /** 需求方当前无法确认归属，开学后需核实 */
  needsConfirmation?: boolean;
}

export const SCORING_ITEMS: readonly SeedItem[] = [
  // ---- A1 社会公德（6 分）----
  { id: 1, groupCode: "A1", name: "志愿服务立项及开展", cap: 4, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "青年发展部" },
  { id: 2, groupCode: "A1", name: "日常志愿服务及社会服务奉献", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "青年发展部" },

  // ---- A2 学生工作（18 分）----
  { id: 3, groupCode: "A2", name: "学生干部任职加分", cap: 6, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "办公室" },
  { id: 4, groupCode: "A2", name: "参与学生工作·主管部门评定", cap: 6, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "办公室" },
  { id: 5, groupCode: "A2", name: "参与学生工作·班级评定", cap: 4, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "办公室", needsConfirmation: true },
  { id: 6, groupCode: "A2", name: "劳动", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "生活实践部" },

  // ---- A3 党团活动（13 分）----
  { id: 7, groupCode: "A3", name: "党建活动", cap: 3, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "组织部" },
  { id: 8, groupCode: "A3", name: "班团活动", cap: 5, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "组织部" },
  { id: 9, groupCode: "A3", name: "青年大学习", cap: 3, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "组织部" },
  { id: 10, groupCode: "A3", name: "突出贡献", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "组织部" },

  // ---- A4 公寓建设（16 分）----
  { id: 11, groupCode: "A4", name: "寝室检查", cap: 12, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "生活实践部" },
  { id: 12, groupCode: "A4", name: "校、院级公寓文化节活动", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "生活实践部" },
  { id: 13, groupCode: "A4", name: "星级寝室评比", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "生活实践部" },

  // ---- A5 社会实践（8 分）----
  { id: 14, groupCode: "A5", name: "立项加分", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "青年发展部" },
  { id: 15, groupCode: "A5", name: "团体社会实践", cap: 3, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "青年发展部" },
  { id: 16, groupCode: "A5", name: "个人社会实践", cap: 3, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "青年发展部" },

  // ---- A6 遵纪守法（6 分）----
  //
  // 真实数据里 147 名学生**全部为 5 分**，无一例外 —— 它是基线制，
  // 不是"不申请就 0 分"。按累加制实现会让每人凭空少 5 分，
  // 而且因为所有人一起少，排名看起来依然正常，没人会发现。
  { id: 17, groupCode: "A6", name: "遵纪守法", cap: 6, mode: "BASELINE", baseline: 5, defaultDepartment: "办公室", needsConfirmation: true },

  // ---- A7 校园文化活动（25 分）----
  { id: 18, groupCode: "A7", name: "社团", cap: 3, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "公共权益部", needsConfirmation: true },
  { id: 19, groupCode: "A7", name: "文艺类", cap: 5, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "文艺部" },
  { id: 20, groupCode: "A7", name: "体育类", cap: 6, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "体育部" },
  { id: 21, groupCode: "A7", name: "创新创业类", cap: 3, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "学习部" },
  { id: 22, groupCode: "A7", name: "其他素质能力", cap: 8, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "办公室", needsConfirmation: true },

  // ---- A8 易班工作（8 分）----
  { id: 23, groupCode: "A8", name: "易班·个人活跃度", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "网络思政部" },
  { id: 24, groupCode: "A8", name: "易班APP线上活动", cap: 4, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "网络思政部" },
  { id: 25, groupCode: "A8", name: "易班线下活动", cap: 2, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "网络思政部" },

  // ---- C 项（12 分）----
  // 由学生办公室主管，条目制，每笔须附材料。
  { id: 26, groupCode: "C", name: "附加分", cap: 12, mode: "ACCUMULATE", baseline: 0, defaultDepartment: "办公室" },
];

/** A 项满分。附录 A 的各级分值之和必须正好等于它。 */
export const A_TOTAL_CAP = 100;

// ---------------------------------------------------------------------------
// 播种
// ---------------------------------------------------------------------------

export interface SeedResult {
  departmentsInserted: number;
  itemsInserted: number;
}

/**
 * 幂等播种。已存在的 id 跳过，不覆盖、不报错。
 *
 * 跑两次结果完全相同 —— 有测试守着这一点。
 */
export function seedReferenceData(db: DatabaseSync): SeedResult {
  return transaction(db, () => {
    let departmentsInserted = 0;
    let itemsInserted = 0;

    const insertDept = db.prepare(
      "INSERT OR IGNORE INTO departments (id, name) VALUES (?, ?)",
    );
    for (const dept of DEPARTMENTS) {
      const info = insertDept.run(dept.id, dept.name);
      if (Number(info.changes) > 0) departmentsInserted += 1;
    }

    const insertItem = db.prepare(
      `INSERT OR IGNORE INTO scoring_items (id, group_code, name, cap, mode, baseline)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of SCORING_ITEMS) {
      const info = insertItem.run(
        item.id,
        item.groupCode,
        item.name,
        item.cap,
        item.mode,
        item.baseline,
      );
      if (Number(info.changes) > 0) itemsInserted += 1;
    }

    return { departmentsInserted, itemsInserted };
  });
}

// ---------------------------------------------------------------------------
// 自检：附录 A 的算术必须成立
// ---------------------------------------------------------------------------

export interface GroupTotal {
  groupCode: string;
  cap: number;
}

/** 按大类汇总分值，用于断言附录 A 的算术 */
export function groupTotals(): GroupTotal[] {
  const totals = new Map<string, number>();
  for (const item of SCORING_ITEMS) {
    totals.set(item.groupCode, (totals.get(item.groupCode) ?? 0) + item.cap);
  }
  return [...totals.entries()]
    .map(([groupCode, cap]) => ({ groupCode, cap }))
    .sort((a, b) => a.groupCode.localeCompare(b.groupCode));
}

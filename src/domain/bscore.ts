/**
 * B 项成绩导入
 *
 * 设计文档附录 C / D。
 *
 * B 项来自教务系统，是**导入的事实数据**，不产生账本事件（附录 C.7）：
 * 账本记录"人的判断"，导入记录"数据的搬运"。
 *
 * 因此这里的保障重点与 A/C 项不同 —— 不是"防人改分"，而是：
 *
 * 1. **可复现**：同一份文件导入两次，结果完全相同。
 * 2. **可追溯**：每次导入留下原始文件（含 sha256）与识别出的列映射。
 * 3. **可发现**：导入前列出与上次的差异；变动比例异常时要求二次确认。
 *
 * 第 3 条是这里最重要的兜底。列映射一旦错位（把 A 项列当成 B 项列），
 * 差异会夸张到一眼就能看出来 —— 这比任何格式校验都管用。
 */

import type { DatabaseSync } from "node:sqlite";

import { transaction } from "../db/db.ts";
import {
  cellText,
  columnByName,
  explainDetection,
  findScoreColumn,
  findStudentIdColumn,
  anySheetMatchesRoster,
  parseNumericCell,
  readTable,
  ImportError,
  type ColumnCandidate,
  type Table,
} from "../import/table.ts";
import { archiveImportFile } from "../import/archive.ts";
import { listStudents, type Student } from "./student.ts";
import type { Clock } from "./clock.ts";

/** 变动比例超过这个阈值就要求管理员二次确认（附录 C.5） */
export const CHANGE_RATIO_ALERT = 0.3;

export type BScoreChange = "NEW" | "UNCHANGED" | "UPDATED" | "SKIPPED" | "UNKNOWN";

export interface BScoreRow {
  studentId: string;
  studentName: string | null;
  score: number | null;
  previous: number | null;
  change: BScoreChange;
  issue: string | null;
}

export interface BScorePreview {
  source: string;
  sheetName: string | null;
  columns: {
    studentId: ColumnCandidate | null;
    score: ColumnCandidate | null;
  };
  candidates: {
    studentId: ColumnCandidate[];
    score: ColumnCandidate[];
  };
  rows: BScoreRow[];
  stats: {
    total: number;
    newCount: number;
    unchanged: number;
    updated: number;
    skipped: number;
    unknownStudents: number;
    /** 变动比例（不含跳过与未知） */
    changeRatio: number;
  };
  /** 名册里有、本次文件中没有的学生 */
  missingFromFile: Student[];
  diagnostics: string[];
  canCommit: boolean;
  /** 变动比例异常，需要管理员明确确认 */
  requiresConfirmation: boolean;
}

export interface PreviewBScoreOptions {
  studentIdColumn?: string | null;
  scoreColumn?: string | null;
}

// ---------------------------------------------------------------------------
// 预览
// ---------------------------------------------------------------------------

export function previewBScore(
  db: DatabaseSync,
  termId: number,
  buffer: Buffer,
  filename: string,
  options: PreviewBScoreOptions = {},
): BScorePreview {
  const table = readTable(buffer, filename);
  const students = new Map(listStudents(db).map((s) => [s.id, s]));

  const idDetection = findStudentIdColumn(table, new Set(students.keys()));
  const scoreDetection = findScoreColumn(table, {
    min: 0,
    max: 150,
    keywords: ["B", "学业", "成绩", "分数", "综合"],
  });

  const idColumn = pick(table, idDetection, options.studentIdColumn);
  const scoreColumn = pick(table, scoreDetection, options.scoreColumn);

  const diagnostics: string[] = [];

  if (students.size === 0) {
    diagnostics.push(
      "❗ 系统里还没有学生名册。B 项成绩必须与名册对应 —— " +
        "请先到管理页导入名册，再导入 B 项。",
    );
  }

  diagnostics.push(...explainDetection("学号列", idDetection, table));
  diagnostics.push(...explainDetection("B 项成绩列", scoreDetection, table));

  if (!idColumn || !scoreColumn) {
    return {
      source: filename,
      sheetName: null,
      columns: { studentId: null, score: null },
      candidates: {
        studentId: idDetection.candidates,
        score: scoreDetection.candidates,
      },
      rows: [],
      stats: {
        total: 0,
        newCount: 0,
        unchanged: 0,
        updated: 0,
        skipped: 0,
        unknownStudents: 0,
        changeRatio: 0,
      },
      missingFromFile: [],
      diagnostics,
      canCommit: false,
      requiresConfirmation: false,
    };
  }

  if (scoreDetection.candidates.length > 1 && !options.scoreColumn) {
    diagnostics.push(
      `⚠️ 文件里有 ${scoreDetection.candidates.length} 列数字都像成绩，` +
        `系统选了得票最高的「${scoreColumn.header ?? scoreColumn.columnName}」列。` +
        `请在下面核对 —— 选错列的典型症状是变动比例异常。`,
    );
  }

  const previousScores = loadScores(db, termId);

  // ---- 逐张工作表处理 ----
  //
  // 与名册导入同理：一个班一张表是常见布局，只在"找到列的那张表"里抽数据
  // 会静默丢掉其余全部学生。真实文件里四张表共 147 人，只读一张就是 57 人。
  //
  // 同样要按**整份文件**判断命中率，而不是逐张表：名册里可能还没有
  // 这份成绩表覆盖的班级（比如名册导入只导进了一个班）。
  // 逐张表否决会让那些"名册里还没有的班级"永远导不进来。
  const referenceIds = new Set(students.keys());
  const allowNewStudents = anySheetMatchesRoster(table, referenceIds);

  const rows: BScoreRow[] = [];
  const seenIds = new Set<string>();
  const parsedSheets: Array<{ sheetName: string; count: number }> = [];

  for (const [sheetIndex, sheet] of table.sheets.entries()) {
    const sheetId = pick(
      table,
      findStudentIdColumn(table, referenceIds, { sheetIndex, allowNewStudents }),
      options.studentIdColumn,
    );
    if (!sheetId) continue;

    const sheetScore = pick(
      table,
      findScoreColumn(table, {
        min: 0,
        max: 150,
        keywords: ["B", "学业", "成绩", "分数", "综合"],
        sheetIndex,
      }),
      options.scoreColumn,
    );
    if (!sheetScore) continue;

    const extracted = extractRows(
      sheet.rows,
      sheetId,
      sheetScore,
      students,
      previousScores,
      diagnostics,
    );

    rows.push(...extracted.rows);
    for (const id of extracted.seenIds) seenIds.add(id);

    parsedSheets.push({ sheetName: sheet.name, count: extracted.rows.length });
  }

  if (parsedSheets.length > 1) {
    diagnostics.push(
      `ℹ️ 文件里有 ${table.sheets.length} 张工作表，其中 ${parsedSheets.length} 张含成绩数据，` +
        `已全部读取：` +
        parsedSheets.map((s) => `「${s.sheetName}」${s.count} 行`).join("、"),
    );
  }

  const missingFromFile = [...students.values()].filter((s) => !seenIds.has(s.id));

  const comparable = rows.filter(
    (r) => r.change === "NEW" || r.change === "UNCHANGED" || r.change === "UPDATED",
  ).length;

  const updated = rows.filter((r) => r.change === "UPDATED").length;
  const changeRatio = comparable === 0 ? 0 : updated / comparable;

  const stats = {
    total: rows.length,
    newCount: rows.filter((r) => r.change === "NEW").length,
    unchanged: rows.filter((r) => r.change === "UNCHANGED").length,
    updated,
    skipped: rows.filter((r) => r.change === "SKIPPED").length,
    unknownStudents: rows.filter((r) => r.change === "UNKNOWN").length,
    changeRatio,
  };

  if (stats.unknownStudents > 0) {
    diagnostics.push(
      `❗ 有 ${stats.unknownStudents} 个学号不在名册中，会被跳过。` +
        `如果数量很大，多半是导入错了文件或名册不对 —— 请先核对再提交。`,
    );
  }

  if (missingFromFile.length > 0) {
    diagnostics.push(
      `ℹ️ 名册里有 ${missingFromFile.length} 人不在本次文件中，` +
        `他们的 B 项会保持原样（没有就留空）。`,
    );
  }

  const requiresConfirmation = changeRatio > CHANGE_RATIO_ALERT;

  if (requiresConfirmation) {
    diagnostics.push(
      `⚠️ 变动比例 ${(changeRatio * 100).toFixed(1)}%，超过 ` +
        `${(CHANGE_RATIO_ALERT * 100).toFixed(0)}% 的警戒线。\n` +
        `   这通常意味着**列选错了**（比如把 A 项列当成了 B 项列）。` +
        `请展开下面的逐行明细确认；确实要大范围更新的话，勾选确认后提交。`,
    );
  }

  return {
    source: filename,
    // 有多张表时不再报单一表名 —— 只报一张会让人以为只读了那一张
    sheetName:
      parsedSheets.length === 1
        ? parsedSheets[0]!.sheetName
        : parsedSheets.map((s) => s.sheetName).join("、"),
    columns: { studentId: idColumn, score: scoreColumn },
    candidates: {
      studentId: idDetection.candidates,
      score: scoreDetection.candidates,
    },
    rows,
    stats,
    missingFromFile,
    diagnostics,
    canCommit: rows.some(
      (r) => r.change === "NEW" || r.change === "UPDATED" || r.change === "UNCHANGED",
    ),
    requiresConfirmation,
  };
}

function pick(
  table: Table,
  detection: { best: ColumnCandidate | null; candidates: ColumnCandidate[] },
  forced: string | null | undefined,
): ColumnCandidate | null {
  if (!forced) return detection.best;
  return columnByName(table, forced) ?? detection.best;
}

function extractRows(
  rawRows: readonly (readonly (string | number | null)[])[],
  idColumn: ColumnCandidate,
  scoreColumn: ColumnCandidate,
  students: ReadonlyMap<string, Student>,
  previousScores: ReadonlyMap<string, number>,
  diagnostics: string[],
): { rows: BScoreRow[]; seenIds: Set<string> } {
  const rows: BScoreRow[] = [];
  const seenIds = new Set<string>();
  let nonNumeric = 0;

  for (let r = idColumn.headerRow + 1; r < rawRows.length; r += 1) {
    const row = rawRows[r] ?? [];
    if (row.every((c) => cellText(c) === "")) continue;

    const studentId = cellText(row[idColumn.columnIndex] ?? null);
    const rawScore = cellText(row[scoreColumn.columnIndex] ?? null);

    if (studentId === "") {
      rows.push({
        studentId: "",
        studentName: null,
        score: null,
        previous: null,
        change: "SKIPPED",
        issue: `第 ${r + 1} 行学号为空`,
      });
      continue;
    }

    seenIds.add(studentId);
    const student = students.get(studentId);

    if (!student) {
      rows.push({
        studentId,
        studentName: null,
        score: null,
        previous: null,
        change: "UNKNOWN",
        issue: "学号不在名册中",
      });
      continue;
    }

    const score = parseNumericCell(rawScore);
    if (score === null) {
      nonNumeric += 1;
      rows.push({
        studentId,
        studentName: student.name,
        score: null,
        previous: previousScores.get(studentId) ?? null,
        change: "SKIPPED",
        issue: rawScore === "" ? "成绩为空" : `成绩「${rawScore}」不是数字`,
      });
      continue;
    }

    const previous = previousScores.get(studentId);

    rows.push({
      studentId,
      studentName: student.name,
      score,
      previous: previous ?? null,
      change:
        previous === undefined ? "NEW" : previous === score ? "UNCHANGED" : "UPDATED",
      issue: null,
    });
  }

  if (nonNumeric > 0) {
    diagnostics.push(
      `⚠️ 有 ${nonNumeric} 行的成绩不是数字（可能是「缺考」「缓考」之类的标注），会被跳过。`,
    );
  }

  return { rows, seenIds };
}



function loadScores(db: DatabaseSync, termId: number): Map<string, number> {
  return new Map(
    (
      db
        .prepare("SELECT student_id, score FROM b_scores WHERE term_id = ?")
        .all(termId) as { student_id: string; score: number }[]
    ).map((r) => [r.student_id, r.score]),
  );
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export interface ImportBScoreOptions extends PreviewBScoreOptions {
  actorId: string;
  /** 原始文件归档目录。省略则只记哈希、不落盘。 */
  dataDir?: string;
  /** 变动比例超阈值时，必须显式确认才允许提交 */
  confirmed?: boolean;
}

export interface ImportBScoreResult {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  unknownStudents: number;
  sha256: string;
  archivedPath: string | null;
  jobId: number;
}

export function importBScore(
  db: DatabaseSync,
  termId: number,
  buffer: Buffer,
  filename: string,
  options: ImportBScoreOptions,
  clock: Clock,
): ImportBScoreResult {
  const preview = previewBScore(db, termId, buffer, filename, options);

  if (!preview.columns.studentId || !preview.columns.score) {
    throw new ImportError(
      "COLUMNS_NOT_DETECTED",
      `无法从「${filename}」中识别出学号列或 B 项成绩列，导入已中止。\n` +
        preview.diagnostics.join("\n"),
      preview.diagnostics,
    );
  }

  if (preview.requiresConfirmation && options.confirmed !== true) {
    throw new ImportError(
      "NEEDS_CONFIRMATION",
      `本次导入的变动比例为 ${(preview.stats.changeRatio * 100).toFixed(1)}%，` +
        `超过 ${(CHANGE_RATIO_ALERT * 100).toFixed(0)}% 的警戒线。` +
        `这通常意味着列选错了 —— 请核对逐行明细后勾选确认再提交。`,
      preview.diagnostics,
    );
  }

  // 归档放在事务之前：文件系统写入不参与事务回滚，
  // 放进事务里只会造成"库回滚了、文件还在"的错觉（反过来才是安全的）。
  const archived = options.dataDir
    ? archiveImportFile(options.dataDir, filename, buffer)
    : null;

  const sha256 = archived?.sha256 ?? "";

  return transaction(db, () => {
    const now = clock.now().toISOString();

    const upsert = db.prepare(
      `INSERT INTO b_scores (term_id, student_id, score, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(term_id, student_id) DO UPDATE SET
         score = excluded.score,
         updated_at = excluded.updated_at`,
    );

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let unknownStudents = 0;

    for (const row of preview.rows) {
      switch (row.change) {
        case "UNKNOWN":
          unknownStudents += 1;
          continue;
        case "SKIPPED":
          skipped += 1;
          continue;
        case "UNCHANGED":
          // 真正的空操作：不动 updated_at，让"重复导入"确实什么都没发生
          unchanged += 1;
          continue;
        case "NEW":
        case "UPDATED": {
          upsert.run(termId, row.studentId, row.score!, now);
          if (row.change === "NEW") inserted += 1;
          else updated += 1;
          continue;
        }
      }
    }

    const mapping = {
      studentId: preview.columns.studentId?.columnName ?? null,
      studentIdSheet: preview.columns.studentId?.sheetName ?? null,
      score: preview.columns.score?.columnName ?? null,
      scoreHeader: preview.columns.score?.header ?? null,
    };

    const info = db
      .prepare(
        `INSERT INTO import_jobs
           (kind, term_id, filename, file_sha256, archived_path, mapping_json, sheet_name,
            parsed_rows, inserted, updated, unchanged, skipped, unknown_students,
            actor_id, created_at)
         VALUES ('BSCORE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        termId,
        filename,
        sha256,
        archived?.path ?? null,
        JSON.stringify(mapping),
        preview.sheetName,
        preview.stats.total,
        inserted,
        updated,
        unchanged,
        skipped,
        unknownStudents,
        options.actorId,
        now,
      );

    return {
      inserted,
      updated,
      unchanged,
      skipped,
      unknownStudents,
      sha256,
      archivedPath: archived?.path ?? null,
      jobId: Number(info.lastInsertRowid),
    };
  });
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export interface ImportJob {
  id: number;
  kind: string;
  termId: number | null;
  filename: string;
  fileSha256: string;
  archivedPath: string | null;
  mapping: Record<string, unknown>;
  parsedRows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  unknownStudents: number;
  actorId: string;
  createdAt: string;
}

/**
 * 解析列映射 JSON。
 *
 * 容错而非信任：这一列是历史数据，万一某条记录写坏了，
 * 应该让那一行显示成"映射不可读"，而不是让整个管理页 400 打不开 ——
 * 一个坏行不该拖垮审计记录的展示。
 */
function parseMapping(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw: text };
  } catch {
    return { raw: text };
  }
}

export function listImportJobs(
  db: DatabaseSync,
  filter: { termId?: number; kind?: string } = {},
): ImportJob[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.termId !== undefined) {
    clauses.push("term_id = ?");
    params.push(filter.termId);
  }
  if (filter.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM import_jobs ${where} ORDER BY id DESC`)
    .all(...params)
    .map((raw) => {
      const row = raw as unknown as {
        id: number;
        kind: string;
        term_id: number | null;
        filename: string;
        file_sha256: string;
        archived_path: string | null;
        mapping_json: string;
        parsed_rows: number;
        inserted: number;
        updated: number;
        unchanged: number;
        skipped: number;
        unknown_students: number;
        actor_id: string;
        created_at: string;
      };
      return {
        id: row.id,
        kind: row.kind,
        termId: row.term_id,
        filename: row.filename,
        fileSha256: row.file_sha256,
        archivedPath: row.archived_path,
        mapping: parseMapping(row.mapping_json),
        parsedRows: row.parsed_rows,
        inserted: row.inserted,
        updated: row.updated,
        unchanged: row.unchanged,
        skipped: row.skipped,
        unknownStudents: row.unknown_students,
        actorId: row.actor_id,
        createdAt: row.created_at,
      };
    });
}

/** 某学生某学期的 B 项；没有记录返回 null（不是 0 —— 0 分与没导入是两回事） */
export function bScoreOf(
  db: DatabaseSync,
  termId: number,
  studentId: string,
): number | null {
  const row = db
    .prepare("SELECT score FROM b_scores WHERE term_id = ? AND student_id = ?")
    .get(termId, studentId) as { score: number } | undefined;
  return row?.score ?? null;
}

/** 已导入 B 项的人数 */
export function bScoreCount(db: DatabaseSync, termId: number): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM b_scores WHERE term_id = ?").get(termId) as {
      n: number;
    }
  ).n;
}

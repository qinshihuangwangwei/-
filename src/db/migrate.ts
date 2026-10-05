/**
 * 迁移执行器
 *
 * 迁移按数组顺序执行，已执行的记录在 schema_migrations 里，重复调用幂等。
 * 每个迁移在独立事务中执行：失败即整体回滚，不留半截 schema。
 */

import type { DatabaseSync } from "node:sqlite";

import * as m001 from "./migrations/001_init.ts";
import * as m002 from "./migrations/002_term_state.ts";
import * as m003 from "./migrations/003_departments_slices.ts";
import * as m004 from "./migrations/004_term_publisher.ts";
import * as m005 from "./migrations/005_appeals.ts";
import * as m006 from "./migrations/006_identity_membership.ts";
import * as m007 from "./migrations/007_item_assignments.ts";
import * as m008 from "./migrations/008_objections.ts";
import * as m009 from "./migrations/009_bscore_import.ts";
import * as m010 from "./migrations/010_ops_runs.ts";
import * as m011 from "./migrations/011_roster_changes.ts";
import * as m012 from "./migrations/012_admin_revoked_by.ts";
import * as m013 from "./migrations/013_audit_no_term_fk.ts";
import * as m014 from "./migrations/014_withdraw_stale_join_applications.ts";
import * as m015 from "./migrations/015_slice_transition_actors.ts";

const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
  m015,
];

export function runMigrations(db: DatabaseSync): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const already = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );

  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (already.has(migration.id)) continue;

    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      ).run(migration.id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `迁移 ${migration.id} 执行失败，已回滚：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    applied.push(migration.id);
  }

  return applied;
}

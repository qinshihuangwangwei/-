/**
 * 数据库连接
 *
 * 用 Node 24 内置的 `node:sqlite`，因此本项目**没有任何原生依赖** ——
 * 对"学生自己部署到一台服务器上"这个场景来说，这一点比性能重要得多：
 * 不需要编译器、不需要 node-gyp、不需要预编译二进制。
 *
 * 所有 SQLite 访问都收在这个模块和 db/ 目录里。`node:sqlite` 目前仍是
 * experimental，万一将来 API 变动，替换面被限制在这里。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runMigrations } from "./migrate.ts";

export type Db = DatabaseSync;

export interface OpenOptions {
  /** 数据库文件路径，默认内存库（测试用） */
  path?: string;
}

export function openDatabase(pathOrOptions: string | OpenOptions = ":memory:"): Db {
  const path =
    typeof pathOrOptions === "string"
      ? pathOrOptions
      : (pathOrOptions.path ?? ":memory:");

  // 先建好父目录。
  //
  // SQLite 不会替你创建目录 —— 它只会报 `unable to open database file`，
  // 而那个错误完全指不到"目录不存在"这个真正的原因。
  //
  // 这一步是必需的而不是锦上添花：`data/` 在 .gitignore 里，
  // 因此**每一次全新克隆都不存在这个目录**，而 README 的第一条命令
  // 就是 `npm run serve -- ./data/zongce.sqlite`。不建目录，快速开始就跑不通。
  ensureParentDirectory(path);

  const db = new DatabaseSync(path);

  // 外键约束。SQLite 默认关闭，必须显式打开，
  // 否则 REFERENCES 只是注释。
  db.exec("PRAGMA foreign_keys = ON");

  if (path !== ":memory:") {
    // WAL 让读不阻塞写。内存库不支持 WAL，设了也无意义。
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }

  runMigrations(db);

  return db;
}

/** 目录已存在就什么都不做；创建失败时给出能照着排查的信息 */
function ensureParentDirectory(path: string): void {
  if (path === ":memory:" || path.startsWith("file:")) return;

  const dir = dirname(resolve(path));
  if (dir === "" || existsSync(dir)) return;

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(
      `无法创建数据库所在目录：${dir}\n` +
        `原因：${error instanceof Error ? error.message : String(error)}\n` +
        `请手动创建该目录，或换一个可写的路径。`,
      { cause: error },
    );
  }
}

/**
 * 事务辅助。已在事务中时直接复用，否则开一个 IMMEDIATE 事务。
 *
 * 用 IMMEDIATE 而非 DEFERRED：立刻取得写锁。否则两个并发请求可能
 * 各自读到同一个链尾哈希、各自算出不同的 self_hash，把链分叉。
 *
 * 嵌套复用很重要 —— 领域层（如切片录入）需要把"检查上限"和"追加事件"
 * 放在同一个事务里，否则检查通过之后、写入之前的状态变化会让上限失效。
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const already = (db as unknown as { isTransaction?: unknown }).isTransaction === true;
  if (already) return fn();

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

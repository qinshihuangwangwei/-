/**
 * 数据库连接 —— 回归测试
 *
 * 这个文件的存在理由是**一次真实的首次运行失败**：
 *
 *   $ npm run serve -- ./data/zongce.sqlite
 *   [serve] 启动失败：Error: unable to open database file
 *
 * `data/` 在 .gitignore 里，因此**每一次全新克隆都不存在这个目录**，
 * 而 README 的第一条命令就是上面那句。SQLite 不会替你创建目录，
 * 它只会报 `unable to open database file` —— 那个错误完全指不到真正的原因。
 *
 * 这个测试盯的就是"父目录不存在时能不能开库"。它跑得很快，
 * 但它守住的是**别人第一次接触这个项目时的体验**。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/db.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "zongce-db-"));
}

describe("打开数据库", () => {
  test("★ 父目录不存在时会自动创建（全新克隆的第一条命令靠它）", () => {
    const root = tempRoot();
    const path = join(root, "data", "zongce.sqlite");

    assert.equal(existsSync(join(root, "data")), false, "前提：目录确实不存在");

    const db = openDatabase(path);
    try {
      assert.ok(existsSync(path), "数据库文件应当已被创建");
      db.exec("SELECT 1");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("多层不存在的目录也能一路建出来", () => {
    const root = tempRoot();
    const path = join(root, "a", "b", "c", "zongce.sqlite");

    const db = openDatabase(path);
    try {
      assert.ok(existsSync(path));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("目录已存在时不受影响", () => {
    const root = tempRoot();
    const path = join(root, "zongce.sqlite");

    const first = openDatabase(path);
    first.close();

    const second = openDatabase(path);
    try {
      // 迁移是幂等的，重新打开不该报错
      assert.equal(
        (second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number })
          .n > 0,
        true,
      );
    } finally {
      second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(":memory: 不受影响，也不会误建目录", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("SELECT 1");
    } finally {
      db.close();
    }

    assert.equal(existsSync(":memory:"), false);
  });

  test("路径指向一个文件而非目录时，报错要能看懂", () => {
    const root = tempRoot();
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "我是一个文件");

    try {
      assert.throws(
        () => openDatabase(join(blocker, "zongce.sqlite")),
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(
            message,
            /无法创建数据库所在目录|unable to open|ENOTDIR|EEXIST/,
            `错误信息应当能看懂，实际：${message}`,
          );
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("新建的库外键约束是打开的（否则 REFERENCES 只是注释）", () => {
    const root = tempRoot();
    const db = openDatabase(join(root, "nested", "zongce.sqlite"));
    try {
      assert.equal(
        (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
        1,
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

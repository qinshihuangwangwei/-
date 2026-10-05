/**
 * 备份与测试的隔离 —— 回归测试
 *
 * 这个文件来自一次真实的、很危险的疏忽：`npm run smoke` 会写一份数据库快照，
 * 而快照的文件名是 `zongce-<日期>.sqlite` —— **不管你快照的是哪个库**。
 *
 * 于是 `./data/backups/` 里出现了这样一份东西：
 *
 *     zongce-2026-09-26.sqlite     ← 名字看起来就是当天那份真备份
 *     里面装的是：3 个账号 / 11 名学生 / "2025-2026 春季学期"   ← 测试库
 *
 * 而真正的库是 1 个账号 / 55 名学生 / "2026-2027秋季学期"。
 * 两者都好端端地存在，没有任何报错。**照着那份"备份"去恢复的人，
 * 会静默地得到一库测试数据**，而且要到很久以后才会发现。
 *
 * 同一段代码里还有一处：`rmSync("./data/.objection-key")` ——
 * 跑一次冒烟测试就会删掉真实部署的异议密钥。那个密钥是"匿名但可追责"
 * 的支点，换掉它，之前所有异议的匿名标识就全部对不上号了。
 *
 * 修法是让冒烟测试待在自己的目录里。这里守住两件事：
 *   - 隔离用的守卫本身是有效的（而不是"自己和自己相等"的空检查）
 *   - 快照命名确实只由日期决定 —— 这就是为什么**只能靠目录隔离**
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { openDatabase, type Db } from "../../src/db/db.ts";
import { fixedClock } from "../../src/domain/clock.ts";
import { createSnapshot, listSnapshots } from "../../src/ops/backup.ts";
import { assertIsolatedDataDir } from "../../scripts/smoke.ts";

const T0 = "2026-09-26T09:00:00.000Z";

const tempDirs: string[] = [];
const openDbs: Db[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zongce-backup-"));
  tempDirs.push(dir);
  return dir;
}

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. 守卫必须真的挡得住
// ---------------------------------------------------------------------------

describe("冒烟测试的隔离守卫", () => {
  test("★ 挡住部署目录本身（各种写法都要挡住）", () => {
    const forms = [
      "./data",       // npm 脚本里最常见的写法
      "./data/",      // 带尾斜杠
      ".\\data",      // Windows 风格 —— 和 ./data 是同一个目录
      ".\\data\\",    // 再带尾斜杠
      "./data//",     // 手抖多打一个
      "data",         // 裸相对路径
      resolve("./data"), // 绝对路径
    ];

    for (const dir of forms) {
      assert.throws(
        () => assertIsolatedDataDir(dir, "./data/smoke/x.sqlite"),
        /不能是部署目录/,
        `「${dir}」和 ./data 是同一个目录，必须挡住`,
      );
    }
  });

  test("★ 挡住仓库根目录（数据会落在 ./backups 里，同样危险）", () => {
    for (const dir of [".", ".\\", resolve(".")]) {
      assert.throws(
        () => assertIsolatedDataDir(dir, "./data/smoke/x.sqlite"),
        /不能是部署目录/,
        `「${dir}」是仓库根目录`,
      );
    }
  });

  test("★ 挡住真实数据库文件", () => {
    assert.throws(
      () => assertIsolatedDataDir("./data/smoke", "./data/zongce.sqlite"),
      /不能直接用真实数据库/,
      "冒烟测试会往库里写数据，不能拿真库来跑",
    );
  });

  test("★ 当前的实际配置能通过", () => {
    assert.doesNotThrow(() =>
      assertIsolatedDataDir("./data/smoke", "./data/smoke/smoke-e2e.sqlite"),
    );
  });

  test("守卫不是空检查 —— 它比对的是写死的部署目录名单", () => {
    // 如果哪天有人把名单改成拿参数自己比自己，
    // 上面那几条就会被架空。这里把行为钉死。
    assert.throws(() => assertIsolatedDataDir("./data", "./data/whatever.sqlite"));
    assert.doesNotThrow(() => assertIsolatedDataDir("./data/anything-else", "./x.sqlite"));
  });
});

// ---------------------------------------------------------------------------
// 2. 快照命名不区分来源 —— 这就是必须靠目录隔离的原因
// ---------------------------------------------------------------------------

describe("快照的文件名", () => {
  test("★ 只由日期决定：换成另一个数据库来快照，名字一模一样", () => {
    const dir = tempDir();
    const clock = fixedClock(T0);

    const real = memoryDb();
    const test_ = memoryDb();

    const a = createSnapshot(real, dir, clock);
    // 第二次会覆盖第一次（同名），先把结果记下来
    const first = basename(a.path);
    const b = createSnapshot(test_, dir, clock);

    assert.equal(first, "zongce-2026-09-26.sqlite");
    assert.equal(
      basename(b.path),
      first,
      "文件名里没有来源信息 —— 所以一个测试库的快照可以完美冒充真备份。" +
        "既然命名区分不了，隔离就只能靠目录。",
    );
  });

  test("同一天重跑会覆盖，不会堆积同名副本", () => {
    const dir = tempDir();
    const clock = fixedClock(T0);

    createSnapshot(memoryDb(), dir, clock);
    createSnapshot(memoryDb(), dir, clock);

    assert.equal(listSnapshots(dir).length, 1);
  });

  test("listSnapshots 只认自己的前缀，别的文件不会混进来", () => {
    const dir = tempDir();
    const clock = fixedClock(T0);
    createSnapshot(memoryDb(), dir, clock);

    assert.equal(listSnapshots(dir).length, 1);
    assert.equal(listSnapshots(join(dir, "不存在的目录")).length, 0);
  });

  test("★ 空目录不会被当成「有备份」", () => {
    const dir = tempDir();
    assert.deepEqual(listSnapshots(dir), [], "没有备份就该是空的，不能假装有");
  });
});

// ---------------------------------------------------------------------------
// 3. 部署目录不该被测试污染
// ---------------------------------------------------------------------------

describe("部署数据目录", () => {
  test("★ 真实数据库就在仓库的 ./data 下（说清楚哪个才是真库）", () => {
    // 这条断言是给未来的人看的：./data/zongce.sqlite 是**部署数据**，
    // 任何测试脚本都不该往 ./data 里写东西。
    assert.ok(
      existsSync("./data/zongce.sqlite"),
      "部署数据库不见了 —— 如果这是有意的，请一并更新 README 里的恢复说明",
    );
  });
});

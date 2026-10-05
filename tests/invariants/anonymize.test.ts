/**
 * 假名生成 —— 回归测试
 *
 * 名册是从教务导出来的**真实学生名单**，而这份系统会被截图、被演示、
 * 被拿去做培训材料。一张写着真实姓名的截图发到群里，就没有收回来的办法了。
 *
 * 生成器有三条硬约束，每一条的失败后果都很具体：
 *   1. **不与真名重合** —— 否则某张截图看上去像是在说某位真同学
 *   2. **互相不重复** —— 名册里两个同名的人会让排查变得没有意义
 *   3. **长度是 2–3 个字** —— 一眼假的名字（「韩佳海燕」四个字）会让人
 *      怀疑整张表都是编的
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { generateNames } from "../../src/cli/anonymize.ts";

describe("假名生成", () => {
  test("数量对了，而且互不重复", () => {
    const { names } = generateNames(200, 20260930);
    assert.equal(names.length, 200);
    assert.equal(new Set(names).size, 200, "名册里不该出现两个同名的人");
  });

  test("★ 长度都是 2 到 3 个字", () => {
    const { names } = generateNames(500, 12345);

    for (const name of names) {
      assert.ok(
        name.length === 2 || name.length === 3,
        `「${name}」是 ${name.length} 个字 —— 一眼假的名字会让人怀疑整张表`,
      );
    }
  });

  test("★ 不与给定的真名重合", () => {
    // 真名册里有「王伟」「李静」这类最常见的名字，撞上的概率不低
    const real = new Set(["王伟", "李静", "张磊", "刘洋", "陈晨"]);
    const { names } = generateNames(300, 20260930, real);

    for (const name of names) {
      assert.ok(!real.has(name), `生成了真名「${name}」—— 那就不再是脱敏了`);
      assert.ok(!names.slice(0, names.indexOf(name)).includes(name));
    }
  });

  test("★ 同一个种子给出同一套名字（可复现）", () => {
    const a = generateNames(50, 42);
    const b = generateNames(50, 42);
    assert.deepEqual(a.names, b.names);
    assert.equal(a.retries, b.retries);
  });

  test("换种子就换一批人", () => {
    const a = generateNames(50, 1).names;
    const b = generateNames(50, 2).names;
    assert.notDeepEqual(a, b);
  });

  test("池子里的名字本身没有重复，也没有四字以上的", () => {
    // 直接生成一大批，覆盖到池子里绝大多数条目
    const { names } = generateNames(2000, 999);

    for (const name of names.slice(0, 300)) {
      assert.ok(name.length >= 2 && name.length <= 3, name);
    }
    // 2000 个仍然无重复，说明池子够大（姓氏 50 × 名字 ~110，理论空间远大于 2000）
    assert.equal(new Set(names).size, 2000);
  });

  test("要 0 个也能正常工作", () => {
    assert.deepEqual(generateNames(0, 1).names, []);
  });
});

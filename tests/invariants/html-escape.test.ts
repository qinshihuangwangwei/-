/**
 * HTML 转义与 raw() —— 回归测试
 *
 * ## 起因
 *
 * 使用者报「公示面板是乱码」。实际是公示页把 HTML **当成文本转义显示**了：
 *
 *     &lt;h2&gt;统计完成情况总览&lt;/h2&gt;
 *     &lt;table&gt;&lt;thead&gt;&lt;tr&gt;&lt;th&gt;计分项&lt;/th&gt;
 *
 * 嵌套的部分甚至被转义了两次：`&amp;lt;span class=&amp;quot;baseline&amp;quot;&amp;gt;`。
 *
 * ## 根因：raw() 是个空操作
 *
 *     export function raw(value: string): string { return value; }
 *
 * `html` 标签对**每一个**插值都转义，包括被 `raw()` 包过的。于是：
 *
 *   · `raw()` 放在普通模板字符串里 → 碰巧有效（`toString()` 生效）
 *   · `raw()` 放在 `html` 标签里     → 被转义，页面上显示出一堆标签源码
 *
 * 上面那三行账本状态区用的是普通模板字符串，所以正常；
 * 公示总览用的是 `html` 标签，所以坏掉。**同一个函数一处说真话一处说假话，
 * 比没有这个函数更难查。**
 *
 * 修法是让 `raw()` 返回一个真的标记对象，`html` 认得它。
 * 这条测试守着三件事：
 *   1. 用户输入**永远**被转义（这是公示页的安全底线）
 *   2. 包过 `raw()` 的片段原样插入
 *   3. 嵌套多层也不会被转义第二次
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/db.ts";
import { seedReferenceData } from "../../src/db/seed.ts";
import { fixedClock } from "../../src/domain/clock.ts";
import { createTerm } from "../../src/domain/term.ts";
import { escapeHtml, html, raw } from "../../src/ui/html.ts";
import { renderPublicityPage } from "../../src/ui/publicity.ts";

// ---------------------------------------------------------------------------
// 1. 转义是默认
// ---------------------------------------------------------------------------

describe("转义是默认行为", () => {
  test("★ 用户输入一律被转义", () => {
    assert.equal(escapeHtml("<b>嗨</b>"), "&lt;b&gt;嗨&lt;/b&gt;");
    assert.equal(html`${"<img onerror=alert(1)>"}`, "&lt;img onerror=alert(1)&gt;");
  });

  test("★ 加分理由里的脚本出不来", () => {
    const reason = `<img src=x onerror="alert(1)">`;
    const out = html`<td>${reason}</td>`;

    assert.ok(!out.includes("<img"), "理由由三级人员填写，一个不转义的 <img> 就能把公示页变成执行点");
    assert.match(out, /&lt;img/);
  });

  test("五种危险字符都转", () => {
    assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  });

  test("null / undefined 变成空串，不变成字符串 \"null\"", () => {
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    assert.equal(html`[${null}]`, "[]");
  });
});

// ---------------------------------------------------------------------------
// 2. raw() 原样插入
// ---------------------------------------------------------------------------

describe("raw() 原样插入", () => {
  test("★ 在 html 标签里不被转义", () => {
    assert.equal(html`${raw("<h2>标题</h2>")}`, "<h2>标题</h2>");
  });

  test("★ 在普通模板字符串里也照常工作", () => {
    // 这一条是原来"碰巧有效"的那条路径 —— 修完之后必须仍然有效
    assert.equal(`${raw("<h2>标题</h2>")}`, "<h2>标题</h2>");
    assert.equal("前" + raw("<b>中</b>") + "后", "前<b>中</b>后");
  });

  test("★ 嵌套两层也不会被转义第二次", () => {
    const inner = html`<span class="baseline">基线 5 分</span>`;
    const middle = html`<td>${raw(inner)}</td>`;
    const outer = html`<table>${raw(middle)}</table>`;

    assert.equal(outer, `<table><td><span class="baseline">基线 5 分</span></td></table>`);
    assert.ok(!outer.includes("&amp;lt;"), "双层转义是这次故障的第二个症状");
  });

  test("★ 忘了包 raw 的片段仍然会被转义（默认安全）", () => {
    const fragment = html`<b>粗</b>`;
    // 直接把 html 的结果当普通插值用 —— 少了 raw()，于是被转义
    const out = html`<div>${fragment}</div>`;

    assert.equal(out, "<div>&lt;b&gt;粗&lt;/b&gt;</div>");
    assert.ok(!out.includes("<b>"), "默认必须偏向安全：漏包 raw 是难看，漏转义是漏洞");
  });
});

// ---------------------------------------------------------------------------
// 3. 公示页真的渲染出标签
// ---------------------------------------------------------------------------

describe("公示页渲染真标签", () => {
  function fixture() {
    const db = openDatabase(":memory:");
    const clock = fixedClock("2026-03-01T09:00:00.000Z");
    seedReferenceData(db);
    db.prepare(
      "INSERT INTO students (id, name, class_name, grade) VALUES ('2599000001', '赵雨桐', '计算机2501', 2025)",
    ).run();
    createTerm(db, { id: 1, name: "2026-2027秋季学期" });
    return { db, clock };
  }

  test("★ 未发布时的「统计完成情况总览」是真表格，不是标签源码", () => {
    const { db, clock } = fixture();
    const page = renderPublicityPage(db, 1, { kind: "staff" }, clock);

    assert.ok(
      !page.includes("&lt;h2&gt;"),
      "这一条就是使用者看到的「乱码」：页面上显示出了 HTML 源码",
    );
    assert.ok(!page.includes("&lt;table&gt;"), "表格不能变成文字");
    assert.ok(!page.includes("&amp;lt;"), "不能有第二层转义");
    assert.match(page, /<h2>统计完成情况总览<\/h2>/);
    assert.match(page, /<table>/);
    assert.match(page, /<th>计分项<\/th>/);
  });

  test("★ A6 遵纪守法的基线标签正常渲染成一个 span", () => {
    const { db, clock } = fixture();
    const page = renderPublicityPage(db, 1, { kind: "staff" }, clock);

    assert.match(page, /<span class="baseline">基线 5 分<\/span>/);
  });

  test("页面自带 charset，且正文没有替换字符", () => {
    const { db, clock } = fixture();
    const page = renderPublicityPage(db, 1, { kind: "staff" }, clock);

    assert.match(page, /<meta charset="utf-8">/);
    assert.equal((page.match(/\uFFFD/g) ?? []).length, 0, "出现替换字符说明编码环节坏了");
    assert.match(page, /2026-2027秋季学期/);
  });
});

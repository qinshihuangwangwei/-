/**
 * 交互增强的渐进增强契约 —— 回归测试
 *
 * 这一轮加了：表格排序、表格筛选、明细展开、上限刻度实时更新。
 * 它们**全部是增强**：服务端照旧渲染完整的 26 个页面，
 * 脚本只是把它变得更好用。
 *
 * 这条底线不是洁癖。公示页的职责是**存证** ——
 * 一个必须先加载 JS 才能读的公示页，存不了证。
 * 而且这个项目零依赖零构建，真要做 SPA 等于另开一个项目（设计文档 §10.2）。
 *
 * 所以这里守三件事：
 *   1. 没有 JS 时，页面上的信息一条不少
 *   2. 服务端不渲染任何"按下去没反应"的控件
 *   3. `<details>` 这类能独立工作的原生元素尽量用起来
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/db.ts";
import { fixedClock } from "../../src/domain/clock.ts";
import { publish } from "../../src/domain/publication.ts";
import { createSlice, record, submit, review, approve } from "../../src/domain/slice.ts";
import { renderPublicityPage } from "../../src/ui/publicity.ts";
import { THEME_CSS } from "../../src/ui/theme.ts";
import { loginPage, layout } from "../../src/http/views.ts";

const T0 = "2026-03-01T00:00:00.000Z";
const SECRET = "test-secret-0123456789-0123456789-0123456789";
const TERM = 1;
const ALICE = "2599000001";
const OWNER = "owner-sports";

function world() {
  const db = openDatabase(":memory:");
  const clock = fixedClock(T0);

  db.exec(`
    INSERT INTO terms (id, name, status) VALUES (${TERM}, '2025-2026 春季学期', 'ENTERING');
    INSERT INTO students (id, name, class_name, grade)
      VALUES ('${ALICE}', '学生甲', '计算机2501', 2025);
    INSERT INTO scoring_items (id, group_code, name, cap, mode, baseline)
      VALUES (1, 'A7', '体育类', 6, 'ACCUMULATE', 0);
  `);

  const slice = createSlice(db, { termId: TERM, itemId: 1, grade: 2025, ownerId: OWNER });
  record(db, { sliceId: slice.id, studentId: ALICE, delta: 3, actorId: OWNER, reason: "校运会" });
  submit(db, slice.id, OWNER, clock);
  review(db, slice.id, "deputy", clock);
  approve(db, slice.id, "head", clock);
  publish(db, TERM, "president", clock);

  return { db, clock };
}

const STAFF = { kind: "staff" } as const;

describe("交互增强不改变「只读」这件事", () => {
  test("★ 明细用原生 <details> —— 没有 JS 也点得开", () => {
    // 146 个人的明细原来一次性全摊开。改成 <details> 而不是自绘折叠面板，
    // 是因为它是 HTML 原生元素：**无 JS 时照常可展开**。
    const { db, clock } = world();
    const html = renderPublicityPage(db, TERM, STAFF, clock);

    assert.ok(html.includes('<details class="person">'), "明细要放进 details");
    assert.ok(html.includes("<summary>"), "details 要有 summary");
    assert.match(html, /<summary><h2 id="s-/, "锚点要留在 summary 里，总表才跳得过来");
  });

  test("★ 排序与筛选要用的钩子在服务端就写好了", () => {
    // 脚本按 data-* 找表格；这些属性是服务端渲染的，
    // 所以"哪些表可排序"这件事不依赖脚本。
    const { db, clock } = world();
    const html = renderPublicityPage(db, TERM, STAFF, clock);

    assert.match(html, /<table data-sortable[^>]*>/, "总表要可排序");
    assert.match(html, /data-filterable/, "总表要可筛选");
  });

  test("★ 服务端不渲染排序按钮 —— 免得出现按不动的按钮", () => {
    const { db, clock } = world();
    const html = renderPublicityPage(db, TERM, STAFF, clock);
    const body = html
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<script>[\s\S]*?<\/script>/g, "");

    assert.ok(!body.includes("class=\"sort\""), "排序按钮由脚本注入");
    assert.ok(!body.includes("全部展开"), "展开按钮由脚本创建");
  });

  test("★★ 所有脚本都包在 <script> 里", () => {
    // 这条是拿真实 bug 换来的：把 UI_SCRIPT 直接 ${} 进模板，
    // 脚本会以**纯文本**形式显示在页面上。
    const { db, clock } = world();
    const html = renderPublicityPage(db, TERM, STAFF, clock);

    const styled = html.replace(/<style>[\s\S]*?<\/style>/g, "");
    const outside = styled.replace(/<script>[\s\S]*?<\/script>/g, "");

    assert.ok(!outside.includes("function ready"), "有脚本漏在 <script> 外面");
    assert.ok(!outside.includes("localStorage"), "有脚本漏在 <script> 外面");
  });

  test("★ 增强脚本不去动 data-* 之外的钩子", () => {
    // 权限、状态机、跳转都不该被前端碰。脚本只做展示层的三件事。
    const { db, clock } = world();
    const html = renderPublicityPage(db, TERM, STAFF, clock);
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]!)
      .join("\n");

    assert.ok(!script.includes("fetch("), "增强脚本不该发请求 —— 那就不再是纯展示层");
    assert.ok(!script.includes("XMLHttpRequest"), "同上");
    assert.ok(!script.includes("document.cookie"), "增强脚本不该碰会话");
  });
});

describe("页面容器不会把内容挤到左边", () => {
  test("★★ .sheet 必须居中", () => {
    // 这条是拿真实 bug 换来的：公示页原来是 body { margin: 0 auto;
    // max-width: 60rem }（居中），改成 .sheet { max-width: 72rem } 时
    // 把 `margin: 0 auto` 弄丢了 —— 于是内容卡在左边的 1152px 里，
    // 宽屏上右半页一片空白，整页看起来偏左。
    //
    // 限制宽度本身是对的（正文一行别太长），但**限制了就必须居中**。
    const rule = /\.sheet\s*\{([^}]*)\}/.exec(THEME_CSS)?.[1] ?? "";

    assert.ok(rule, "找不到 .sheet 规则");
    assert.match(rule, /max-width/, "宽度要有限制，否则宽屏上正文一行太长");
    assert.match(
      rule,
      /margin:\s*[^;]*auto/,
      "限了宽就必须居中 —— 否则内容贴左、右边留一大片空白",
    );
  });

  test("★ 公示页用的是 .sheet 容器", () => {
    const { db, clock } = world();
    const html = renderPublicityPage(db, TERM, STAFF, clock);

    assert.match(html, /<main class="sheet">/, "这一页是独立渲染的，得自己套上容器");
  });

  test("★★ 没有侧边栏的页面不能套两列栅格", () => {
    // 这条也是拿真实 bug 换来的。`.app` 是 `13rem 1fr` 两列，
    // 没有 <aside> 的时候 `.col` 会变成**第一个**栅格子元素、
    // 落进那个 13rem 的窄列 —— 整页被压成一条贴在左边。
    // 登录页就是这么坏掉的（用户报："紧贴左边，甚至把一些格式都挤错了"）。
    const login = loginPage({ next: "/" });

    assert.ok(login.includes('<div class="app no-side">'), "没有导航时要加 no-side");
    assert.ok(!login.includes('<div class="app">'), "不能留一个空的第一列");
  });

  test("★ 有侧边栏的页面仍然是两列", () => {
    const home = layout("正文", {
      title: "首页",
      nav: [
        { href: "/", label: "首页", group: "我的", abbr: "首" },
        { href: "/me", label: "我的", group: "我的", abbr: "我" },
      ],
    });

    assert.ok(home.includes('<div class="app">'), "有导航时用两列");
    assert.ok(!home.includes("app no-side"), "有导航时不该塌成一列");
    assert.ok(home.includes('<aside class="side">'), "侧边栏要在");
  });

  test("★ no-side 在 CSS 里确实塌成了一列", () => {
    const rule = /\.app\.no-side\s*\{([^}]*)\}/.exec(THEME_CSS)?.[1] ?? "";
    assert.ok(rule, "找不到 .app.no-side 规则");
    assert.match(rule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, "要塌成单列");
  });
});

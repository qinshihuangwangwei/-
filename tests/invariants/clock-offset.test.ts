/**
 * 时间旅行开关 —— 回归测试
 *
 * ## 为什么需要这个功能
 *
 * 「72 小时申诉窗口」到「公示期」是纯时间驱动的状态机。
 * 生产用的是 `systemClock`，没有任何东西能让它快进 ——
 * 想看一眼公示页长什么样，就得真的等三天。
 * 那不是"严格"，那是把一条最有价值的流程变成测不了的东西。
 *
 * `fixedClock` 早就在做同样的事，只是它只被测试代码用。这个文件守的是
 * 「把它接到 `serve` 上」这一层：解析时长、以及在页面上**显形**。
 *
 * 时间旅行本身不可怕，可怕的是有人拿着被拨过的时间当真。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  describeDuration,
  parseDuration,
  shiftedClock,
  fixedClock,
} from "../../src/domain/clock.ts";
import { withTimeShiftBanner } from "../../src/http/router.ts";

describe("时长解析", () => {
  test("分钟 / 小时 / 天", () => {
    assert.equal(parseDuration("90m"), 90 * 60_000);
    assert.equal(parseDuration("4h"), 4 * 3_600_000);
    assert.equal(parseDuration("3d"), 3 * 86_400_000);
  });

  test("可以叠加", () => {
    assert.equal(parseDuration("3d12h"), 3 * 86_400_000 + 12 * 3_600_000);
    assert.equal(parseDuration("1d 2h 30m"), 86_400_000 + 2 * 3_600_000 + 30 * 60_000);
  });

  test("★ 看不懂就整体拒绝 —— 不能猜", () => {
    // 「4days 被当成 4」这种静默误读，比直接报错危险得多：
    // 使用者以为自己拨了四天，实际只拨了四分钟，然后对着没变化的页面困惑。
    for (const bad of ["", "   ", "4days", "abc", "4", "-3d", "0d", "3d 4x"]) {
      assert.equal(parseDuration(bad), null, `应当拒绝：${JSON.stringify(bad)}`);
    }
  });

  test("负数被拒绝 —— 往前拨会让已经发生的事看起来还没发生", () => {
    assert.equal(parseDuration("-1d"), null);
  });

  test("说成人话", () => {
    assert.equal(describeDuration(3 * 86_400_000), "3 天");
    assert.equal(describeDuration(86_400_000 + 4 * 3_600_000), "1 天4 小时");
    assert.equal(describeDuration(45 * 60_000), "45 分");
  });
});

describe("平移时钟", () => {
  test("整体前移，且不回写底层时钟", () => {
    const base = fixedClock("2026-03-01T00:00:00.000Z");
    const shifted = shiftedClock(base, 3 * 86_400_000);

    assert.equal(shifted.now().toISOString(), "2026-03-04T00:00:00.000Z");
    assert.equal(base.now().toISOString(), "2026-03-01T00:00:00.000Z", "底层时钟不受影响");
  });

  test("底层时钟走动时，平移量保持不变", () => {
    const base = fixedClock("2026-03-01T00:00:00.000Z");
    const shifted = shiftedClock(base, 3_600_000);

    base.advance(60_000);
    assert.equal(shifted.now().toISOString(), "2026-03-01T01:01:00.000Z");
  });
});

describe("横幅", () => {
  const html = (body: string): { status: number; headers: Record<string, string>; body: string } => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
  });

  test("★ 时间被拨过时，每个页面都挂一条横幅", () => {
    const out = withTimeShiftBanner(html("<html><body><p>嗨</p></body></html>"), "已前移 3 天");
    const text = String(out);

    assert.match(text, /测试模式/);
    assert.match(text, /已前移 3 天/);
    assert.ok(text.indexOf("<p>嗨</p>") < text.indexOf("测试模式"), "横幅插在正文之后");
  });

  test("★ 没有拨过时间就一个字都不加", () => {
    const out = withTimeShiftBanner(html("<html><body>x</body></html>"), undefined);
    assert.equal(out, "<html><body>x</body></html>");
  });

  test("★ 非 HTML 响应一个字节都不动 —— 宁可没有横幅，也不要把 HTML 插进 xlsx", () => {
    const xlsx = Buffer.from("PK\u0003\u0004fake");
    const out = withTimeShiftBanner(
      { status: 200, headers: { "content-type": "application/vnd.ms-excel" }, body: xlsx },
      "已前移 3 天",
    );
    assert.equal(out, xlsx);

    const json = withTimeShiftBanner(
      { status: 200, headers: { "content-type": "application/json" }, body: '{"a":1}' },
      "已前移 3 天",
    );
    assert.equal(json, '{"a":1}');
  });

  test("没有 </body> 的结构原样返回", () => {
    const out = withTimeShiftBanner(html("<p>半截"), "已前移 3 天");
    assert.equal(out, "<p>半截");
  });

  test("横幅里的文字被转义", () => {
    const out = String(
      withTimeShiftBanner(html("<body></body>"), '<script>alert(1)</script>'),
    );
    assert.ok(!out.includes("<script>alert(1)</script>"));
    assert.match(out, /&lt;script&gt;/);
  });
});

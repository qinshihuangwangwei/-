/**
 * 可注入的时钟
 *
 * 这是整个项目最值钱的一个抽象。没有它，"72 小时申诉窗口"只能靠真的等三天来测；
 * 有了它，时间旅行是一行代码。
 *
 * 硬性约定：**领域层任何地方都不得直接调用 `new Date()`**，
 * 一律通过 `Clock` 取当前时间。唯一的例外是 ledger 里 `createdAt` 的默认值，
 * 且它也接受注入。
 */

export interface Clock {
  now(): Date;
}

/** 生产环境用的时钟 */
export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FixedClock extends Clock {
  /** 拨到指定时刻 */
  set(when: string | Date): void;
  /** 前进指定毫秒数（可为负） */
  advance(ms: number): void;
}

/**
 * 固定时钟。测试里用它把时间拨来拨去。
 *
 * `now()` 返回副本，调用方无法通过修改返回值来影响时钟内部状态 ——
 * 否则一个不小心的 `clock.now().setHours(...)` 就能让测试产生幻觉。
 */
export function fixedClock(start: string | Date): FixedClock {
  let current = toDate(start);

  return {
    now: () => new Date(current.getTime()),
    set: (when) => {
      current = toDate(when);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function toDate(value: string | Date): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(value.getTime());
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`无法解析为时间：${String(value)}`);
  }
  return date;
}

/**
 * 整体平移的时钟 —— **只给测试用**。
 *
 * ## 为什么需要它
 *
 * 「72 小时申诉窗口」到「公示期」是纯时间驱动的状态机。
 * 生产用的是 `systemClock`，没有任何东西能让它快进 ——
 * 于是想看一眼公示页长什么样，就得真的等三天。
 * 那不是"严格"，那是把一条最有价值的流程变成测不了的东西。
 *
 * 这不是新机制：`fixedClock` 早就在做同样的事，只是它只被测试代码用。
 * 这里把它接到 `serve` 上，并**强迫它在页面上显形**
 * （见 router 里那段横幅）—— 时间旅行本身不可怕，
 * 可怕的是有人拿着被拨过的时间当真。
 */
export function shiftedClock(base: Clock, offsetMs: number): Clock {
  return { now: () => new Date(base.now().getTime() + offsetMs) };
}

/**
 * 解析 `90m` / `4h` / `3d` / `3d12h` 这样的时长。
 *
 * 单位只认 m（分）、h（时）、d（天）。不接受零或负数 ——
 * 往回调时间会让"已经发生的事"看起来还没发生，
 * 那种状态连测试都不该制造。
 */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([mhd])/gi)];
  let total = 0;
  let consumed = 0;

  for (const part of parts) {
    const value = Number(part[1]);
    const unit = part[2]!.toLowerCase();
    const factor = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    total += value * factor;
    consumed += part[0].length;
  }

  // 有没被认出来的字符就整体拒绝 —— 宁可报错，也不要"4days 被当成 4"。
  if (consumed !== trimmed.replace(/\s/g, "").length) return null;
  return total > 0 ? total : null;
}

/** 把毫秒数说成人话，用于横幅 */
export function describeDuration(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  return parts.join("") || "0 分";
}

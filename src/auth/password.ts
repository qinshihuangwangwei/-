/**
 * 密码哈希
 *
 * 用 Node 内置的 `scrypt`，因此没有任何加密库依赖。
 * 参数取 OWASP 推荐的 N=2^14, r=8, p=1。
 *
 * 关于本系统里那个特殊的初始密码（身份证后 6 位）：
 * 它**只作为密码存在**，必须以哈希存储，严禁明文落库。
 * 它不承担任何身份标识功能 —— 两个人恰好后 6 位相同是完全允许的，
 * 因为它是密码不是 ID。因此这里不做唯一性约束，也不做逆向查询。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

/** 最短密码长度。身份证后 6 位正好是 6 位，所以下限定在 6。 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * 最大长度。scrypt 对超长输入不敏感（先做一次 SHA-256 预处理也可以），
 * 但设个上限能挡住"用超长密码把 CPU 打满"这种低级骚扰。
 */
export const MAX_PASSWORD_LENGTH = 128;

export class PasswordError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PasswordError";
    this.code = code;
  }
}

/**
 * 规范化。
 *
 * 用 NFKC 并去掉首尾空白与中间的零宽字符 —— 学生从微信里复制身份证号时，
 * 很容易带上不可见字符。这类问题表现为"密码明明是对的却登不上"，
 * 而且极难排查，所以在入口处一次性处理掉。
 */
function normalize(plain: string): string {
  return plain.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

export function assertPasswordAcceptable(plain: string): void {
  const value = normalize(plain);

  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(
      "PASSWORD_TOO_SHORT",
      `密码至少 ${MIN_PASSWORD_LENGTH} 位（当前 ${value.length} 位）`,
    );
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordError(
      "PASSWORD_TOO_LONG",
      `密码最长 ${MAX_PASSWORD_LENGTH} 位`,
    );
  }
}

/** 生成 `scrypt$N$r$p$salt$hash` 形式的口令串 */
export function hashPassword(plain: string): string {
  const value = normalize(plain);
  const salt = randomBytes(SALT_LENGTH);

  const key = scryptSync(value, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * 校验口令。
 *
 * 用 `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同的字节上短路，
 * 泄露"猜对了前几位"的信息。对本地系统来说这是小事，但没有理由写错。
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");

  let actual: Buffer;
  try {
    actual = scryptSync(normalize(plain), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 生成一次性临时密码，用于管理员或部长重置。
 *
 * 刻意**不使用**身份证后 6 位：系统里根本不存身份证号，
 * 而且"重置成初始密码"意味着任何知道该生身份证号的人都能登进去。
 * 临时密码由系统随机生成、只显示一次、下次登录必须改掉。
 */
export function generateTempPassword(): string {
  // 去掉容易看错的 0/O/1/l/I，这些字符在手机上手抄会出错
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

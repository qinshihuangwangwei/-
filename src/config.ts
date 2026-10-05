/**
 * 配置
 *
 * 目前只有一样东西需要认真处理：**异议匿名指纹的密钥**。
 *
 * 它必须存在数据库**之外**。存在库里的话，任何拿到数据库文件的人
 * 都能穷举学号把指纹对回去 —— 那样"匿名"就只是没做界面而已。
 *
 * 因此：环境变量优先，其次是数据目录下的独立密钥文件（权限 0600）。
 * 部署时要注意：**备份数据库时不要把密钥一起备到同一个地方**，
 * 否则备份本身就变成了突破口。
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OBJECTION_KEY_FILENAME = ".objection-key";

export interface LoadSecretOptions {
  /** 数据目录。密钥文件默认放在这里。 */
  dataDir: string;
  /** 允许测试注入 */
  env?: Record<string, string | undefined>;
}

/**
 * 读取（或首次生成）异议密钥。
 *
 * 生成后写入 `<dataDir>/.objection-key`，权限 0600。
 */
export function loadObjectionSecret(options: LoadSecretOptions): string {
  const env = options.env ?? process.env;

  const fromEnv = env["ZONGCE_OBJECTION_SECRET"];
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (fromEnv !== undefined && fromEnv.length > 0 && fromEnv.length < 32) {
    throw new Error(
      "ZONGCE_OBJECTION_SECRET 太短。匿名强度取决于这个密钥的熵 —— " +
        "至少 32 个字符，建议直接用 `openssl rand -base64 48` 生成。",
    );
  }

  const keyPath = join(options.dataDir, OBJECTION_KEY_FILENAME);

  if (existsSync(keyPath)) {
    const value = readFileSync(keyPath, "utf8").trim();
    if (value.length < 32) {
      throw new Error(`密钥文件 ${keyPath} 内容过短，可能已损坏`);
    }
    return value;
  }

  const secret = randomBytes(48).toString("base64");
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, secret, { encoding: "utf8", mode: 0o600 });

  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略即可。
    // 靠的是"这个文件不在数据库里"这一点，而不是文件权限。
  }

  return secret;
}

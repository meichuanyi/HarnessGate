import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 主进程开鉴权（HG_AUTH 非 off）时给 WS URL 拼上 token；token 文件缺失/为空时原样返回。
 *
 *  必须共享而非各写一份：2026-11-05 服务端开启鉴权时只给 mcp-admin.ts 补了 token，
 *  mcp-sessions.ts（核心 MCP）裸连被服务端 close(4401)，客户端却傻等 hello 直到 6s
 *  超时，报"连接超时"误导排查方向——两端从此统一走这里，防再漂移。 */
export function wsUrlWithToken(base: string): string {
  let token = process.env.HG_TOKEN ?? "";
  if (!token) {
    try {
      token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
    } catch {
      return base;
    }
  }
  if (!token) return base;
  return base + (base.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}

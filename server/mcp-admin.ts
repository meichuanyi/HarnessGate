import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { wsUrlWithToken } from "./ws-auth.ts";

/**
 * HarnessGate 管理面 MCP Server (stdio)：受管 MCP 服务器 + 技能库的增删改查。
 *
 * 与核心 MCP（mcp-sessions.ts：sessions/goals/sentinel/notification/schedules）分工：
 * 管理工具单列一个条目（harnessgate-admin），建会话时按需勾选携带——不常驻核心
 * 工具的 schema token，改中枢代码也不会波及只勾了核心的会话。
 *
 * 全部操作经主进程 WS 通道（与 web/插件共用同一消息面：mcp-list/mcp-save/mcp-delete/
 * skills/skills-save/skills-delete/skills-mount/skills-read），不直写 mcp.json 和技能
 * 目录——名字校验、热载指纹、审计、广播全留在主进程单一事实源。
 *
 * 生效语义（写进工具描述与返回文本，agent 读了才知道正确用法）：
 * - MCP 集合在会话创建时经 ACP session.initialize 注入。保存/删除只对之后新建/恢复
 *   的会话生效，当前及已运行会话不回填。刚保存的服务器要立刻用：核心 MCP 的
 *   sessions_create 传 mcpServerIds（id 或名字均可）。
 * - 技能挂载是 harness 级（同 harness 的会话共享挂载集），对已运行会话通常不可见，
 *   新建/恢复会话后生效。
 */

const HG_WS_URL = process.env.HG_WS_URL || "ws://127.0.0.1:9830/ws";

interface WsClient {
  ws: WebSocket;
  hello: Record<string, unknown>;
  close: () => void;
}

function connectWs(timeoutMs = 6000): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlWithToken(HG_WS_URL));
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`连接 HarnessGate WebSocket 超时 (${HG_WS_URL})`));
    }, timeoutMs);

    let helloReceived = false;

    ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!helloReceived && msg.type === "hello") {
          helloReceived = true;
          clearTimeout(timer);
          resolve({
            ws,
            hello: msg,
            close: () => {
              try { ws.close(); } catch {}
            },
          });
        }
      } catch {}
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket 连接失败: ${err.message}`));
    });
  });
}

/** 发一条消息并等满足条件的响应。中途收到 error 即失败（本连接只发过一个请求，
 *  error 只可能是对它的答复）。超时/失败都会摘掉监听，不泄漏。 */
function rpc<T = Record<string, unknown>>(
  client: WsClient,
  msg: Record<string, unknown>,
  match: (m: Record<string, unknown>) => boolean,
  timeoutMs = 6000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (raw: WebSocket.Data) => {
      try {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (m.type === "error") {
          cleanup();
          reject(new Error(String(m.message ?? "后端错误")));
          return;
        }
        if (match(m)) {
          cleanup();
          resolve(m as T);
        }
      } catch {}
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待后端响应超时 (${String(msg.type)})`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.ws.off("message", onMsg);
    };
    client.ws.on("message", onMsg);
    client.ws.send(JSON.stringify(msg));
  });
}

const rid = () => randomUUID().slice(0, 8);

/** mcp_list 返回条目的精简投影（env/headers 里的值没必要进 agent 上下文） */
function slimMcp(s: Record<string, unknown>) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: s.enabled,
    note: s.note,
    ...(s.type === "stdio" ? { command: s.command, args: s.args } : { url: s.url }),
  };
}

const EFFECT_NOTE_MCP =
  "⚠️ 生效语义：MCP 集合在会话创建时注入——本次变更只对之后新建/恢复的会话生效，当前及已运行会话不回填。要立刻用：sessions_create 传 mcpServerIds:[\"<名字或id>\"]；或保持 enabled=true 走新建会话的默认勾选。";
const EFFECT_NOTE_SKILL =
  "⚠️ 生效语义：挂载是 harness 级（同 harness 会话共享），对已运行会话通常不可见——新建/恢复会话后生效。";

const server = new Server(
  { name: "harnessgate-admin", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mcp_list",
      description:
        "列出 HarnessGate 受管的全局 MCP 服务器清单（id/名称/类型/新建会话默认勾选/启动命令）。新建会话想携带某服务器时，把它的 id 或名字填进核心 MCP sessions_create 的 mcpServerIds 参数。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mcp_save",
      description:
        "新增或更新一个受管 MCP 服务器（按 name 匹配已有条目则原地更新，未提供的字段保留原值）。stdio 型给 command/args/env；http(sse) 型给 url/headers。保存后对之后新建的会话生效，当前及已运行会话不回填——要立刻用请在 sessions_create 的 mcpServerIds 里携带。",
      inputSchema: {
        type: "object",
        required: ["name", "type"],
        properties: {
          name: { type: "string", description: "agent 侧服务器标识，只能字母/数字/._-" },
          type: { type: "string", enum: ["stdio", "http", "sse"], description: "传输类型" },
          command: { type: "string", description: "stdio：可执行文件（建议绝对路径）" },
          args: { type: "array", items: { type: "string" }, description: "stdio：启动参数" },
          env: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } } },
            description: "stdio：环境变量",
          },
          url: { type: "string", description: "http/sse：服务器地址（http(s):// 开头）" },
          headers: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } } },
            description: "http/sse：请求头（如鉴权）",
          },
          enabled: { type: "boolean", description: "新建会话时的默认勾选状态，默认 true" },
          note: { type: "string", description: "备注（用途/注意事项）" },
        },
      },
    },
    {
      name: "mcp_delete",
      description:
        "删除一个受管 MCP 服务器（按 name 或 id）。已存档会话不受影响（恢复时未知 id 会被静默跳过）。",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "服务器名称或 id" },
        },
      },
    },
    {
      name: "skills_list",
      description:
        "列出技能主库（~/.harnessgate/skills）与各 harness 的挂载情况。技能=写进 SKILL.md 的可复用能力，挂载后由该 harness 的新建会话携带（常驻成本只有 name+description）。",
      inputSchema: {
        type: "object",
        properties: {
          harnessId: { type: "string", description: "只看某个 harness 的挂载（可选）" },
        },
      },
    },
    {
      name: "skills_read",
      description: "读取某个技能的完整正文（SKILL.md 内容）。",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", description: "技能名" } },
      },
    },
    {
      name: "skills_save",
      description:
        "在技能主库新增或更新一个技能（Markdown 正文）。保存只入库，不挂载任何 harness——用 skills_mount 挂载后，该 harness 的新建/恢复会话才会携带。",
      inputSchema: {
        type: "object",
        required: ["name", "description", "body"],
        properties: {
          name: { type: "string", description: "技能名，只能字母/数字/._-" },
          description: { type: "string", description: "一句话用途说明（会常驻挂载会话的提示词，写精炼）" },
          body: { type: "string", description: "SKILL.md 正文（不含 frontmatter，name/description 由参数生成）" },
        },
      },
    },
    {
      name: "skills_delete",
      description: "从技能主库删除一个技能（会先自动从所有 harness 摘除挂载）。",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", description: "技能名" } },
      },
    },
    {
      name: "skills_mount",
      description:
        "把主库技能挂载到某 harness（on=false 摘除）。挂载是 harness 级、同 harness 会话共享；对已运行会话通常不可见，新建/恢复后生效。",
      inputSchema: {
        type: "object",
        required: ["name", "harnessId"],
        properties: {
          name: { type: "string", description: "技能名（skills_list 的 library 里选）" },
          harnessId: { type: "string", description: "harness id（skills_list 的 mounts 里有清单，如 claude / zcode）" },
          on: { type: "boolean", description: "true=挂载（默认），false=摘除" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    const client = await connectWs();

    // ----------------------------------------------------
    // MCP 服务器管理
    // ----------------------------------------------------
    if (name === "mcp_list") {
      const r = await rpc(client, { type: "mcp-list" }, (m) => m.type === "mcp");
      const servers = (r.servers as Array<Record<string, unknown>>) ?? [];
      client.close();
      return { content: [{ type: "text", text: JSON.stringify(servers.map(slimMcp), null, 2) }] };
    }

    if (name === "mcp_save") {
      const wantName = String(args.name ?? "").trim();
      const type = args.type === "http" || args.type === "sse" ? args.type : "stdio";
      // 先拉清单：按 name 找已有条目（原地更新，未提供的字段保留原值）
      const before = await rpc<{ servers: Array<Record<string, unknown>> }>(
        client,
        { type: "mcp-list" },
        (m) => m.type === "mcp",
      );
      const existing = (before.servers ?? []).find((s) => s.name === wantName);
      const provided: Record<string, unknown> = { name: wantName, type };
      if (args.command !== undefined) provided.command = String(args.command).trim();
      if (args.args !== undefined) provided.args = Array.isArray(args.args) ? args.args.map(String) : [];
      if (args.env !== undefined) provided.env = args.env;
      if (args.url !== undefined) provided.url = String(args.url).trim();
      if (args.headers !== undefined) provided.headers = args.headers;
      if (args.enabled !== undefined) provided.enabled = Boolean(args.enabled);
      if (args.note !== undefined) provided.note = String(args.note);
      const merged = { ...(existing ?? {}), ...provided };
      if (existing) merged.id = existing.id;

      const saved = await rpc<{ servers: Array<Record<string, unknown>> }>(
        client,
        { type: "mcp-save", server: merged },
        (m) => m.type === "mcp" && ((m.servers as Array<Record<string, unknown>>) ?? []).some((s) => s.name === wantName),
      );
      const entry = ((saved.servers ?? []) as Array<Record<string, unknown>>).find((s) => s.name === wantName);
      client.close();
      return {
        content: [
          {
            type: "text",
            text: `已${existing ? "更新" : "保存"} MCP 服务器 "${wantName}"（id: ${entry?.id}，type: ${type}，新建会话默认勾选: ${merged.enabled !== false ? "是" : "否"}）。\n${EFFECT_NOTE_MCP}`,
          },
        ],
      };
    }

    if (name === "mcp_delete") {
      const key = String(args.name ?? "").trim();
      const before = await rpc<{ servers: Array<Record<string, unknown>> }>(
        client,
        { type: "mcp-list" },
        (m) => m.type === "mcp",
      );
      const target = (before.servers ?? []).find((s) => s.id === key || s.name === key);
      if (!target) {
        client.close();
        return { content: [{ type: "text", text: `没有找到 MCP 服务器: ${key}` }], isError: true };
      }
      await rpc(
        client,
        { type: "mcp-delete", id: target.id },
        (m) => m.type === "mcp" && !(((m.servers as Array<Record<string, unknown>>) ?? []).some((s) => s.id === target.id)),
      );
      client.close();
      return {
        content: [
          { type: "text", text: `已删除 MCP 服务器 "${target.name}"（id: ${target.id}）。已存档会话恢复时未知 id 会被静默跳过，不受影响。\n${EFFECT_NOTE_MCP}` },
        ],
      };
    }

    // ----------------------------------------------------
    // 技能库管理
    // ----------------------------------------------------
    if (name === "skills_list") {
      const wantHarness = args.harnessId ? String(args.harnessId) : undefined;
      const myRid = rid();
      const r = await rpc<{ library: Array<Record<string, unknown>>; mounts: Array<Record<string, unknown>> }>(
        client,
        { type: "skills", reqId: myRid },
        (m) => m.type === "skills" && m.reqId === myRid,
      );
      client.close();
      const library = (r.library ?? []).map((s) => ({
        name: s.name,
        description: s.description,
        mountedOn: s.mountedOn,
      }));
      const mounts = (r.mounts ?? [])
        .filter((m) => !wantHarness || m.harnessId === wantHarness)
        .map((m) => ({ harnessId: m.harnessId, skills: m.skills }));
      return { content: [{ type: "text", text: JSON.stringify({ library, mounts }, null, 2) }] };
    }

    if (name === "skills_read") {
      const skillName = String(args.name ?? "").trim();
      const myRid = rid();
      const r = await rpc<{ content: string }>(
        client,
        { type: "skills-read", name: skillName, reqId: myRid },
        (m) => m.type === "skills-content" && m.reqId === myRid,
      );
      client.close();
      return { content: [{ type: "text", text: r.content }] };
    }

    if (name === "skills_save") {
      const skill = {
        name: String(args.name ?? "").trim(),
        description: String(args.description ?? "").trim(),
        body: String(args.body ?? ""),
      };
      const reqId = rid();
      await rpc(
        client,
        { type: "skills-save", skill, reqId },
        (m) => m.type === "skills" && m.reqId === reqId,
      );
      client.close();
      return {
        content: [
          {
            type: "text",
            text: `技能 "${skill.name}" 已保存到主库（尚未挂载任何 harness——需要的话接着调 skills_mount）。\n${EFFECT_NOTE_SKILL}`,
          },
        ],
      };
    }

    if (name === "skills_delete") {
      const skillName = String(args.name ?? "").trim();
      const reqId = rid();
      await rpc(
        client,
        { type: "skills-delete", name: skillName, reqId },
        (m) => m.type === "skills" && m.reqId === reqId,
      );
      client.close();
      return { content: [{ type: "text", text: `技能 "${skillName}" 已删除（若曾挂载，软链已一并摘除）。` }] };
    }

    if (name === "skills_mount") {
      const skillName = String(args.name ?? "").trim();
      const harnessId = String(args.harnessId ?? "").trim();
      const on = args.on !== false;
      const reqId = rid();
      await rpc(
        client,
        { type: "skills-mount", name: skillName, harnessId, on, reqId },
        (m) => m.type === "skills" && m.reqId === reqId,
      );
      client.close();
      return {
        content: [
          {
            type: "text",
            text: `已${on ? "挂载" : "摘除"}：技能 "${skillName}" ${on ? "→" : "←"} harness "${harnessId}"。\n${EFFECT_NOTE_SKILL}`,
          },
        ],
      };
    }

    client.close();
    return { content: [{ type: "text", text: `未知工具调用: ${name}` }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `操作失败: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// 父进程（harness 会话）退出后 stdin 会 EOF——必须跟着退，否则孤儿进程越积越多
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));

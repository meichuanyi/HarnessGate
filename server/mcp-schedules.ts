import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** HarnessGate 定时任务 MCP server（stdio）：
 *  让任意 harness 的 agent 用正规工具面操作 HarnessGate 的定时任务——
 *  list（查询）、create（创建）、run（立即运行）、delete（删除）、enable（启停）。
 *  由 HarnessGate 自身按需拉起（stdio 单次会话生命周期），操作直写 schedules.json 并广播。 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = process.env.HG_DATA_DIR ?? join(homedir(), ".harnessgate");
const FILE = join(DATA_DIR, "schedules.json");

type Cadence =
  | { type: "daily"; at: string }
  | { type: "interval"; everyMinutes: number }
  | { type: "weekly"; days: number[]; at: string }
  | { type: "cron"; expr: string };

type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  harnessId: string;
  cwd?: string;
  autoApprove?: string;
  cadence: Cadence;
  overlap: "skip";
  sessionMode: "fresh" | "dedicated";
  promptTemplate: string;
  createdAt: string;
  state: Record<string, unknown>;
};

function load(): Schedule[] {
  try {
    return (JSON.parse(readFileSync(FILE, "utf8")) as { schedules?: Schedule[] }).schedules ?? [];
  } catch {
    return [];
  }
}

function save(list: Schedule[]): void {
  const tmp = `${FILE}.tmp`;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(tmp, JSON.stringify({ version: 1, schedules: list }, null, 1));
  renameSync(tmp, FILE);
}

const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function cadenceDesc(c: Cadence): string {
  if (c.type === "daily") return `每天 ${c.at}`;
  if (c.type === "interval") return `每 ${c.everyMinutes} 分钟`;
  if (c.type === "weekly") return `每周${(c.days ?? []).map((d) => WD[d] ?? d).join("/")} ${c.at}`;
  return `cron: ${c.expr}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const server = new Server(
  { name: "harnessgate-schedules", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "schedules_list",
      description: "列出 HarnessGate 里的全部定时任务（名称/频率/下次触发/上次结果）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "schedules_create",
      description:
        "创建定时任务：到点自动驱动一个 agent 会话执行 promptTemplate。每天/每周/间隔三种频率；" +
        "不指定 cwd 时使用自动工作区（自动 git init）",
      inputSchema: {
        type: "object",
        required: ["name", "harnessId", "cadence", "promptTemplate"],
        properties: {
          name: { type: "string", description: "任务名（简短）" },
          harnessId: { type: "string", description: "执行用的 harness id（如 zcode）" },
          cadence: {
            type: "object",
            description: "频率：{type:'daily',at:'HH:MM'} | {type:'interval',everyMinutes:N} | {type:'weekly',days:[0-6],at:'HH:MM'}",
          },
          promptTemplate: { type: "string", description: "每次触发执行的完整 prompt" },
          cwd: { type: "string", description: "工作目录（空 = 自动工作区）" },
          autoApprove: { type: "string", enum: ["off", "readonly", "all"], description: "自动决策档位，默认 all" },
        },
      },
    },
    {
      name: "schedules_run",
      description: "立即运行一个定时任务（不等到点）",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "任务 id" } },
      },
    },
    {
      name: "schedules_delete",
      description: "删除定时任务（含其自动工作区产物，不可恢复）",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "任务 id" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "schedules_list") {
      const list = load().map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        harnessId: s.harnessId,
        cadence: cadenceDesc(s.cadence),
        nextFireAt: (s.state as Record<string, unknown>)?.nextFireAt ?? null,
        lastStatus: (s.state as Record<string, unknown>)?.lastStatus ?? null,
        running: Boolean((s.state as Record<string, unknown>)?.running),
      }));
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }

    if (name === "schedules_create") {
      const a = args as Record<string, unknown>;
      const required = ["name", "harnessId", "cadence", "promptTemplate"] as const;
      for (const k of required) {
        if (!a[k]) throw new Error(`缺少必填字段: ${k}`);
      }
      const list = load();
      const id = Math.random().toString(36).slice(2, 10);
      const rec = {
        id,
        name: String(a.name).slice(0, 40),
        enabled: true,
        harnessId: String(a.harnessId),
        cwd: typeof a.cwd === "string" ? a.cwd : undefined,
        autoApprove: "all",
        cadence: a.cadence,
        overlap: "skip",
        sessionMode: "fresh",
        promptTemplate: String(a.promptTemplate),
        createdAt: new Date().toISOString(),
        state: {},
      };
      list.push(rec as never);
      save(list);
      return { content: [{ type: "text", text: `已创建定时任务 ${id}（每天触发前注意 promptTemplate 是否可执行）` }] };
    }

    if (name === "schedules_run") {
      const id = String((args as Record<string, unknown>).id);
      const list = load();
      const s = list.find((x) => x.id === id);
      if (!s) throw new Error(`找不到任务 ${id}`);
      // 立即运行 = 通过 HarnessGate 的 schedule-run HTTP/WS 入口；这里直接提示调用方走主服务
      return {
        content: [{ type: "text", text: `请在 HarnessGate（http://127.0.0.1:9830）对该任务执行 schedule-run；MCP 侧不代触发，避免绕过审计` }],
      };
    }

    if (name === "schedules_delete") {
      const id = String((args as Record<string, unknown>).id);
      const list = load().filter((s) => s.id !== id);
      save(list);
      return { content: [{ type: "text", text: `已删除 ${id}` }] };
    }

    return { content: [{ type: "text", text: `未知工具 ${name}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `错误: ${err instanceof Error ? err.message : String(err)}` }] };
  }
});

function a_id(args: unknown): string {
  return String((args as Record<string, unknown>)?.id ?? "");
}

const transport = new StdioServerTransport();
await server.connect(transport);

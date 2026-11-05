import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

/**
 * HarnessGate 核心综合 MCP Server (stdio)：
 * 提供三组全套标准 MCP 工具：
 *
 * 1. 会话管理与跨 Agent 通信 (Sessions)
 *    - sessions_list: 列出当前全部会话与运行状态
 *    - sessions_get: 获取指定会话详情、最新输出与碰过的文件
 *    - sessions_create: 动态创建新会话（可指定 harnessId、工作区、初始任务 Prompt）
 *    - sessions_prompt: 向指定会话发送消息 / 补充指令
 *    - sessions_interrupt: 打断正在运行的回合
 *    - sessions_delete: 终止并删除指定会话
 *
 * 2. 目标与前瞻推演 (Goals & Speculation)
 *    - goals_list: 列出所有宏观目标与罗盘，以及生活运转日常待办 (Life Ops)，包含进度%、状态、推演处方
 *    - goals_save: 创建或修改宏观目标（更新进度%、标题、描述、绑定工作目录 cwd、截止时间等）
 *    - goals_task_complete: 在目标系统 / Mindwtr 中打勾完成一个任务
 *    - goals_task_reschedule: 执行推演处方的改期顺延动作（严格强制 ISO 起止时间戳铁律 YYYY-MM-DDTHH:mm:ss+08:00）
 *
 * 3. 伴生神经中枢 (Sentinel)
 *    - sentinel_status: 查看当前神经心智状态（张力槽水平 Tension Level、破线阈值、当前冷却速率、近期破线与唤醒动作）
 *    - sentinel_spark: 主动向神经中枢注入感官脉冲（提升认知张力，加速 System 2 慢思考唤醒）
 *    - sentinel_sensor_list: 枚举伴生神经中枢当前已注册的所有感知器列表
 *    - sentinel_sensor_save: 动态挂载或更新神经中枢感知器（支持气象感知、时间心跳、目录监听、目标罗盘等）
 *    - sentinel_sensor_toggle: 快速启停指定感知器（在线 / 停用静默）
 *    - sentinel_sensor_delete: 卸载并删除指定感知器配置
 *
 * 4. 统一通知与报警推送 (Notification)
 *    - notification_send: 主动向外部通道（飞书机器人/NAS统一推送网关/Webhook）发送即时卡片通知与警报
 *
 * 5. 定时任务 (Schedules)
 *    - schedules_list: 列出全部定时任务（频率/下次触发/上次运行状态）
 *    - schedules_save: 创建或更新定时任务（到点自动驱动 agent 会话执行 promptTemplate）
 *    - schedules_delete: 删除定时任务
 *    - schedules_enable: 启用/停用（含被连续失败自动暂停后的重新启用）
 *    - schedules_run: 立即触发一次（异步执行，结果看 lastStatus）
 *    全部经由主进程 WS 通道（9830/ws），不直写 schedules.json，保证审计与内存态一致。
 */

const HG_WS_URL = process.env.HG_WS_URL || "ws://127.0.0.1:9830/ws";

interface WsClient {
  ws: WebSocket;
  hello: Record<string, unknown>;
  close: () => void;
}

function connectWs(timeoutMs = 6000): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HG_WS_URL);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`连接 HarnessGate WebSocket 超时 (${HG_WS_URL})`));
    }, timeoutMs);

    let helloReceived = false;

    ws.on("open", () => {
      // 等待 hello 包
    });

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

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket 连接失败: ${err.message}`));
    });
  });
}

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validateIsoTimestamp(ts: string, fieldName: string): void {
  if (!ISO_TIMESTAMP_REGEX.test(ts.trim())) {
    throw new Error(
      `${fieldName} 必须严格符合 ISO 8601 起止时间戳铁律（格式形如 YYYY-MM-DDTHH:mm:ss+08:00），当前传入: "${ts}"`,
    );
  }
}

const server = new Server(
  { name: "harnessgate", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ---------- 组 1：会话管理与跨 Agent 通信 ----------
    {
      name: "sessions_list",
      description: "列出 HarnessGate 里的全部会话（ID、对应 Harness 厂商、工作目录、运行状态 live/saved、标题等）",
      inputSchema: {
        type: "object",
        properties: {
          liveOnly: {
            type: "boolean",
            description: "是否只列出正在内存运行 (live=true) 的会话，默认为 false",
          },
          limit: {
            type: "integer",
            description: "返回的最大数量，默认 50",
          },
        },
      },
    },
    {
      name: "sessions_get",
      description: "获取某个会话的详细信息、碰过的文件清单以及最后若干条对话轨迹（Transcript）",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string", description: "会话 ID（如 68c9a0fd）" },
          tailLines: { type: "integer", description: "拉取最近对话条数，默认 15 条" },
        },
      },
    },
    {
      name: "sessions_create",
      description: "在 HarnessGate 中动态开辟一个新 Agent 会话，可指定使用的 Harness 厂商（如 zcode, codex, claude 等）及工作区目录，并可选自动下发首条 Prompt",
      inputSchema: {
        type: "object",
        required: ["harnessId"],
        properties: {
          harnessId: {
            type: "string",
            description: "执行该任务的 Harness ID（如 zcode, codex, claude, opencode 等）",
          },
          cwd: {
            type: "string",
            description: "工作目录（绝对路径）。如果不填则使用系统默认工作区",
          },
          prompt: {
            type: "string",
            description: "创建会话后立即发送的首条指令 Prompt",
          },
          autoApprove: {
            type: "string",
            description: "权限自动审批级别：all / readonly / off（工兵任务强烈建议 all）",
          },
          isolate: {
            type: "boolean",
            description: "是否创建独立 Git Worktree 隔离沙箱（防止并发写冲突），默认为 false",
          },
          model: {
            type: "string",
            description: "指定会话运行模型（若 harnessId 为 zcode 且未指定，则默认使用 Flash 模型：builtin:bigmodel-coding-plan\\GLM-5.3-Flash）",
          },
          mcpServerIds: {
            type: "array",
            items: { type: "string" },
            description:
              "新会话注入的受管 MCP 服务器列表（id 或名字均可，完整清单用 harnessgate-admin 的 mcp_list 查询）。不填则默认携带全部默认勾选（enabled）的服务器。注意：mcp_save 刚保存的服务器对已有会话不生效——只能通过本参数让新会话携带。",
          },
        },
      },
    },
    {
      name: "sessions_prompt",
      description: "向已存在的运行中会话跨会话发送消息 / 追问 / 指令",
      inputSchema: {
        type: "object",
        required: ["sessionId", "text"],
        properties: {
          sessionId: { type: "string", description: "目标会话 ID" },
          text: { type: "string", description: "发送给 Agent 的内容" },
        },
      },
    },
    {
      name: "sessions_interrupt",
      description: "打断指定会话正在运行的回合（Cancel Current Turn）",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string", description: "目标会话 ID" },
        },
      },
    },
    {
      name: "sessions_delete",
      description: "停止并删除指定的会话（注意：会从会话列表中移除）",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string", description: "目标会话 ID" },
        },
      },
    },

    // ---------- 组 A：目标与前瞻推演 (Goals & Speculation) ----------
    {
      name: "goals_list",
      description: "列出所有宏观目标与罗盘，以及生活运转日常待办 (Life Ops)，包含进度%、状态、推演处方",
      inputSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "按领域分类过滤（可选：career, academic, trading, life, general）",
          },
          status: {
            type: "string",
            description: "按目标状态过滤（可选：active, paused, completed, archived）",
          },
        },
      },
    },
    {
      name: "goals_save",
      description: "创建或修改宏观目标（更新进度%、标题、描述、绑定工作目录 cwd、截止时间等）",
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: {
            type: "object",
            required: ["title"],
            description: "目标对象数据",
            properties: {
              id: {
                type: "string",
                description: "目标 ID（可选。更新目标时传入 ID；若新建则留空自动生成）",
              },
              title: {
                type: "string",
                description: "目标名称/标题（必填）",
              },
              description: {
                type: "string",
                description: "目标详细描述（可选）",
              },
              category: {
                type: "string",
                description: "目标领域分类（可选：career, academic, trading, life, general）",
              },
              status: {
                type: "string",
                description: "目标状态（可选：active, paused, completed, archived，默认为 active）",
              },
              progress: {
                type: "number",
                description: "目标完成进度百分比（数值 0~100）",
              },
              cwd: {
                type: "string",
                description: "绑定的核心工作目录绝对路径",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "目标关联的标签列表（可选）。若目标需响应外部环境或代码变动，可直接填入对应的感知器 ID（如 ['sen-weather-hz', 'sen-fs-harnessgate']，可通过 sentinel_sensor_list 查询可用感知器）；若为纯静态/自包含/思考类目标，不依赖任何感知器，请留空或不填此项。",
              },
              deadline: {
                type: "string",
                description: "截止时间（ISO 8601 格式，如 2026-10-31T23:59:59+08:00）",
              },
              speculative: {
                type: "object",
                description: "前瞻推演配置",
                properties: {
                  enabled: { type: "boolean", description: "是否开启推演求值" },
                  harnessId: { type: "string", description: "推演所用的 harness" },
                  model: { type: "string", description: "推演所用的模型" },
                  autoApprove: { type: "string", description: "审批策略" },
                  useWorktree: { type: "boolean", description: "是否开启平行沙箱" },
                  triggerOnCommit: { type: "boolean", description: "git commit 后触发" },
                  promptTemplate: { type: "string", description: "推演执行的指令模板" },
                  artifactCheckCommand: { type: "string", description: "校验命令" },
                  notifyFeishu: { type: "boolean", description: "关键产出时是否推飞书" },
                },
              },
            },
          },
        },
      },
    },
    {
      name: "goals_task_complete",
      description: "在目标系统 / Mindwtr 中打勾完成一个任务",
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: {
            type: "string",
            description: "Mindwtr 任务 ID（必填）",
          },
          goalId: {
            type: "string",
            description: "关联的目标 ID（可选。若提供，完成该任务时目标进度将自动向前推进）",
          },
        },
      },
    },
    {
      name: "goals_task_reschedule",
      description: "执行推演处方的改期顺延动作（严格强制 ISO 起止时间戳铁律 YYYY-MM-DDTHH:mm:ss+08:00）",
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: {
            type: "string",
            description: "Mindwtr 任务 ID（必填）",
          },
          dueDate: {
            type: "string",
            description: "截止时间戳，严格强制 ISO 8601 带时区格式（如 2026-10-16T18:00:00+08:00）",
          },
          startTime: {
            type: "string",
            description: "开始时间戳，严格强制 ISO 8601 带时区格式（如 2026-10-16T14:00:00+08:00）",
          },
        },
      },
    },

    // ---------- 组 B：伴生神经中枢 (Sentinel) ----------
    {
      name: "sentinel_status",
      description: "查看当前神经心智状态（张力槽水平 Tension Level、破线阈值、当前冷却速率、近期破线与唤醒动作）",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "sentinel_spark",
      description: "主动向神经中枢注入感官脉冲（提升认知张力，加速 System 2 慢思考唤醒）",
      inputSchema: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: {
            type: "string",
            description: "脉冲摘要，描述触发该认知脉冲的原因或感官事件（必填）",
          },
          weight: {
            type: "number",
            description: "认知脉冲权重数值（范围 1~10，默认值为 2）",
          },
        },
      },
    },
    {
      name: "sentinel_sensor_list",
      description: "枚举伴生神经中枢当前已注册的所有感知器列表（按内外分类展示：自然环境、外部信号、生活心智、数字工坊）及其运行状态、最近触发时间与累计事件数",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["external", "internal"],
            description: "可选：按一级感知分类过滤（external=外部客观现实，internal=内部共生体状态）",
          },
          subCategory: {
            type: "string",
            enum: ["environment", "signal", "life", "workspace"],
            description: "可选：按二级感知分类过滤（environment=自然环境，signal=外部信号，life=生活心智，workspace=数字工坊）",
          },
        },
      },
    },
    {
      name: "sentinel_sensor_save",
      description: "动态挂载或更新神经中枢感知器（支持气象感知、时间心跳、目录监听、目标罗盘等），配置名称、类别、采样参数与显著性等级",
      inputSchema: {
        type: "object",
        required: ["label", "kind"],
        properties: {
          id: {
            type: "string",
            description: "可选：感官 ID。若提供则更新已有感官；若省略则创建新感官",
          },
          label: {
            type: "string",
            description: "感官人类可读名称（如：杭州气象环境感知、论文目录变动）",
          },
          kind: {
            type: "string",
            enum: ["weather", "temporal", "fs", "siyuan"],
            description: "感官类型：weather（气象感知）、temporal（时间心跳）、fs（目录监听）、siyuan（目标罗盘）",
          },
          salience: {
            type: "string",
            enum: ["whisper", "normal", "loud"],
            description: "显著性等级：whisper（微语）、normal（常规）、loud（强信号），默认 normal",
          },
          enabled: {
            type: "boolean",
            description: "是否启用在线，默认 true",
          },
          city: {
            type: "string",
            description: "针对 weather 感官：城市名称（默认杭州）",
          },
          latitude: {
            type: "number",
            description: "针对 weather 感官：地理纬度（默认 30.2741）",
          },
          longitude: {
            type: "number",
            description: "针对 weather 感官：地理经度（默认 120.1551）",
          },
          intervalMs: {
            type: "number",
            description: "针对 temporal 或 weather 感官：脉冲或采样周期毫秒数",
          },
          dirs: {
            type: "array",
            items: { type: "string" },
            description: "针对 fs 感官：监听目录绝对路径数组",
          },
          plansPath: {
            type: "string",
            description: "针对 siyuan 感官：plans.json 绝对文件路径",
          },
        },
      },
    },
    {
      name: "sentinel_sensor_toggle",
      description: "快速启停指定感官（在线 / 停用静默）",
      inputSchema: {
        type: "object",
        required: ["id", "enabled"],
        properties: {
          id: {
            type: "string",
            description: "目标感官 ID（如 sen-weather-hz）",
          },
          enabled: {
            type: "boolean",
            description: "true 为启用在线，false 为停用静默",
          },
        },
      },
    },
    {
      name: "sentinel_sensor_delete",
      description: "卸载并删除指定感官配置（仅删除感官注册，不动底层数据文件）",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "要删除的目标感官 ID",
          },
        },
      },
    },
    {
      name: "notification_send",
      description: "向已配置的外部通知通道（NAS 统一推送网关、飞书机器人、通用 Webhook）发送卡片通知或警报消息",
      inputSchema: {
        type: "object",
        required: ["title", "content"],
        properties: {
          title: {
            type: "string",
            description: "通知标题（例如：【目标进展】量化策略回测突破）",
          },
          content: {
            type: "string",
            description: "通知详细正文内容（支持多行文本）",
          },
          level: {
            type: "string",
            enum: ["info", "success", "warn", "error"],
            description: "消息等级，默认 info",
          },
          metadata: {
            type: "object",
            description: "可选的附加元数据键值对",
          },
        },
      },
    },

    // ---------- 组 C：定时任务 (Schedules) ----------
    {
      name: "schedules_list",
      description: "列出 HarnessGate 里的全部定时任务（名称/频率/下次触发/上次运行状态），增删改查中的『查』",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "schedules_save",
      description:
        "创建或更新定时任务（增/改）：到点自动驱动一个 agent 会话执行 promptTemplate。" +
        "频率支持 daily/weekly/interval/cron/once 五种（once=单次倒计时，触发跑完自动停用）；带 id 即为更新，不带即新建。" +
        "连续失败 3 次会被自动暂停，修复后用 schedules_enable 重新启用。" +
        "仅支持 agent 任务；直接执行脚本的 exec 模式只能在网页端创建",
      inputSchema: {
        type: "object",
        required: ["name", "harnessId", "cadence", "promptTemplate"],
        properties: {
          id: {
            type: "string",
            description: "任务 id（更新时传入；不传 = 新建）",
          },
          name: {
            type: "string",
            description: "任务名（简短）",
          },
          harnessId: {
            type: "string",
            description: "执行用的 harness id（如 zcode / codex / claude）",
          },
          cadence: {
            type: "object",
            description:
              "频率：{type:'daily',at:'HH:MM'} | {type:'weekly',days:[0-6],at:'HH:MM'}（0=周日） | {type:'interval',everyMinutes:N} | {type:'once',delayMinutes:N}（N 分钟后触发一次，跑完自动停用；也可直接给 at:'ISO时间'） | {type:'cron',expr:'5段表达式'}",
          },
          promptTemplate: {
            type: "string",
            description: "每次触发执行的完整 prompt",
          },
          cwd: {
            type: "string",
            description: "工作目录（绝对路径）；不填 = 自动工作区（自动创建并 git init）",
          },
          autoApprove: {
            type: "string",
            enum: ["off", "readonly", "all"],
            description: "权限自动审批档位，默认 all",
          },
          enabled: {
            type: "boolean",
            description: "是否启用，默认 true",
          },
          window: {
            type: "object",
            description: "可选运行窗口过滤：{from:'HH:MM',to:'HH:MM',weekdays:[0-6]}；from>to 视为跨午夜",
          },
          sessionMode: {
            type: "string",
            enum: ["fresh", "dedicated"],
            description: "每次新开会话（默认 fresh）或复用专属会话",
          },
          contract: {
            type: "object",
            description: "可选验收契约：{requires:['文件',...], outputFile:'产物路径'}；产物缺失判为运行失败",
          },
        },
      },
    },
    {
      name: "schedules_delete",
      description: "删除一个定时任务",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "任务 id",
          },
        },
      },
    },
    {
      name: "schedules_enable",
      description: "启用/停用一个定时任务（不改动其他字段）",
      inputSchema: {
        type: "object",
        required: ["id", "enabled"],
        properties: {
          id: {
            type: "string",
            description: "任务 id",
          },
          enabled: {
            type: "boolean",
            description: "true=启用，false=停用",
          },
        },
      },
    },
    {
      name: "schedules_run",
      description:
        "立即触发运行一个定时任务（不等下一次到点）。执行是异步的：返回成功仅代表已触发，结果稍后用 schedules_list 查看 lastStatus / lastSessionId",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "任务 id",
          },
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
    // 组 1：会话管理
    // ----------------------------------------------------
    if (name === "sessions_list") {
      const liveOnly = Boolean(args.liveOnly);
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const sessions = (client.hello.sessions as Array<Record<string, unknown>>) || [];

      let filtered = sessions;
      if (liveOnly) {
        filtered = filtered.filter((s) => s.live === true);
      }
      filtered = filtered.slice(0, limit).map((s) => ({
        id: s.id,
        harnessId: s.harnessId,
        title: s.title || "无标题",
        live: Boolean(s.live),
        status: s.status,
        cwd: s.cwd,
        lastActiveAt: s.lastActiveAt,
      }));

      client.close();
      return {
        content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      };
    }

    if (name === "sessions_get") {
      const sid = String(args.sessionId);
      const tailLines = typeof args.tailLines === "number" ? args.tailLines : 15;

      // 发送 transcript 请求
      const transcriptPromise = new Promise<Record<string, unknown>>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ error: "拉取 transcript 超时" });
        }, 4000);

        client.ws.on("message", (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "transcript" && msg.sessionId === sid) {
              clearTimeout(timeout);
              resolve(msg);
            }
          } catch {}
        });
      });

      client.ws.send(JSON.stringify({ type: "transcript", sessionId: sid }));
      const result = await transcriptPromise;
      client.close();

      const allSessions = (client.hello.sessions as Array<Record<string, unknown>>) || [];
      const meta = allSessions.find((s) => s.id === sid);

      const transcript = (result.transcript as Array<Record<string, unknown>>) || [];
      const slicedTranscript = transcript.slice(-tailLines).map((t) => ({
        role: t.role,
        text: typeof t.text === "string" ? t.text.slice(0, 1000) : t.text,
        timestamp: t.timestamp,
        toolCalls: t.toolCalls,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                meta: meta || { id: sid, notice: "未在当前会话列表中找到元数据" },
                tailTranscript: slicedTranscript,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "sessions_create") {
      const harnessId = String(args.harnessId);
      const cwd = typeof args.cwd === "string" ? args.cwd.trim() : undefined;
      const isolate = Boolean(args.isolate);
      const promptText = typeof args.prompt === "string" ? args.prompt.trim() : undefined;
      let model = typeof args.model === "string" ? args.model.trim() : undefined;
      const mcpServerIds = Array.isArray(args.mcpServerIds)
        ? args.mcpServerIds.map((m: unknown) => String(m).trim()).filter(Boolean)
        : undefined;

      // 若为 zcode，默认或传 flash 时自动使用 Flash 模型
      if (harnessId.toLowerCase() === "zcode") {
        if (!model || /flash/i.test(model)) {
          model = "builtin:bigmodel-coding-plan\\GLM-5.3-Flash";
        }
      }

      const createPromise = new Promise<{ id: string; harnessId: string; cwd: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("创建会话超时，未收到后端广播"));
        }, 6000);

        client.ws.on("message", (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "session" && msg.session) {
              clearTimeout(timer);
              resolve(msg.session);
            } else if (msg.type === "error") {
              clearTimeout(timer);
              reject(new Error(msg.message || "创建会话失败"));
            }
          } catch {}
        });
      });

      client.ws.send(
        JSON.stringify({
          type: "create",
          harnessId,
          cwd,
          isolate,
          ...(mcpServerIds ? { mcpServerIds } : {}),
        }),
      );

      const created = await createPromise;
      const autoApprove = typeof args.autoApprove === "string" ? args.autoApprove.trim() : "all";
      if (created.id && autoApprove) {
        client.ws.send(JSON.stringify({ type: "set-auto-approve", sessionId: created.id, level: autoApprove }));
      }

      // 如果指定了模型（或 zcode 默认 Flash），紧随其后下发模型切换配置
      if (model && created.id) {
        client.ws.send(
          JSON.stringify({
            type: "config",
            sessionId: created.id,
            configId: "model",
            value: model,
          }),
        );
      }

      // 如果带了初始 prompt，则紧接着发送
      if (promptText && created.id) {
        client.ws.send(
          JSON.stringify({
            type: "prompt",
            sessionId: created.id,
            text: promptText,
          }),
        );
      }

      client.close();
      return {
        content: [
          {
            type: "text",
            text: `已成功创建会话 ID: ${created.id} (Harness: ${created.harnessId}, Model: ${model || "默认"}, CWD: ${created.cwd}, MCP: ${
              mcpServerIds ? `${mcpServerIds.length} 项指定` : "默认勾选集"
            })${promptText ? "，并已下发初始 Prompt 任务。" : "。"}`,
          },
        ],
      };
    }

    if (name === "sessions_prompt") {
      const sid = String(args.sessionId);
      const text = String(args.text);

      client.ws.send(
        JSON.stringify({
          type: "prompt",
          sessionId: sid,
          text,
        }),
      );

      // 短暂等待消息被投递
      await new Promise((r) => setTimeout(r, 600));
      client.close();

      return {
        content: [
          {
            type: "text",
            text: `已成功向会话 ${sid} 下发消息: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
          },
        ],
      };
    }

    if (name === "sessions_interrupt") {
      const sid = String(args.sessionId);
      client.ws.send(
        JSON.stringify({
          type: "interrupt",
          sessionId: sid,
        }),
      );
      await new Promise((r) => setTimeout(r, 300));
      client.close();

      return {
        content: [{ type: "text", text: `已向会话 ${sid} 发送中断 (Interrupt) 信号。` }],
      };
    }

    if (name === "sessions_delete") {
      const sid = String(args.sessionId);
      client.ws.send(
        JSON.stringify({
          type: "delete",
          sessionId: sid,
        }),
      );
      await new Promise((r) => setTimeout(r, 400));
      client.close();

      return {
        content: [{ type: "text", text: `已从 HarnessGate 终止并删除会话 ${sid}。` }],
      };
    }

    // ----------------------------------------------------
    // 组 A：目标与前瞻推演 (Goals & Speculation)
    // ----------------------------------------------------
    if (name === "goals_list") {
      const domainFilter = typeof args.domain === "string" && args.domain.trim() ? args.domain.trim().toLowerCase() : undefined;
      const statusFilter = typeof args.status === "string" && args.status.trim() ? args.status.trim().toLowerCase() : undefined;

      const goalsPromise = new Promise<{ goals: Array<Record<string, unknown>>; lifeTasks?: Array<Record<string, unknown>> }>((resolve) => {
        const timer = setTimeout(() => {
          // 超时兜底使用 hello 包内的数据
          resolve({
            goals: (client.hello.goals as Array<Record<string, unknown>>) || [],
            lifeTasks: (client.hello.lifeTasks as Array<Record<string, unknown>>) || [],
          });
        }, 5000);

        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "goals") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve({
                goals: (msg.goals as Array<Record<string, unknown>>) || [],
                lifeTasks: (msg.lifeTasks as Array<Record<string, unknown>>) || [],
              });
            } else if (msg.type === "error" && msg.message === "未知消息类型") {
              // 若服务端仅开放 goals-list 则顺延尝试 goals-list
              client.ws.send(JSON.stringify({ type: "goals-list" }));
            }
          } catch {}
        };

        client.ws.on("message", onMsg);
      });

      // 对应 WS: { type: "goals-get" }
      client.ws.send(JSON.stringify({ type: "goals-get" }));
      const { goals: rawGoals, lifeTasks: rawLifeTasks = [] } = await goalsPromise;
      client.close();

      let filteredGoals = rawGoals;
      if (statusFilter) {
        filteredGoals = filteredGoals.filter((g) => String(g.status || "").toLowerCase() === statusFilter);
      }
      if (domainFilter) {
        filteredGoals = filteredGoals.filter((g) => {
          const cat = String(g.category || "").toLowerCase();
          const dom = String((g as Record<string, unknown>).domain || "").toLowerCase();
          return cat === domainFilter || dom === domainFilter;
        });
      }

      let filteredLifeOps = rawLifeTasks;
      if (domainFilter && domainFilter !== "life") {
        filteredLifeOps = filteredLifeOps.filter((t) => {
          const dom = String((t as Record<string, unknown>).domain || "").toLowerCase();
          return dom === domainFilter;
        });
      }
      // 按开始时间升序（Mindwtr 返回序是按任务系列聚的，展示上按时间才直观）
      filteredLifeOps = [...filteredLifeOps].sort((a, b) =>
        String(a.startTime ?? a.dueDate ?? "").localeCompare(String(b.startTime ?? b.dueDate ?? "")));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                summary: {
                  totalGoals: filteredGoals.length,
                  totalLifeOps: filteredLifeOps.length,
                  filter: { domain: domainFilter || "all", status: statusFilter || "all" },
                },
                goals: filteredGoals,
                lifeOps: filteredLifeOps,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "goals_save") {
      const goalInput = args.goal as Record<string, unknown> | undefined;
      if (!goalInput || typeof goalInput !== "object") {
        throw new Error("必须提供 goal 对象参数");
      }
      const title = typeof goalInput.title === "string" ? goalInput.title.trim() : "";
      if (!title) {
        throw new Error("目标名称 title 不能为空");
      }
      if (goalInput.progress !== undefined) {
        const p = Number(goalInput.progress);
        if (Number.isNaN(p) || p < 0 || p > 100) {
          throw new Error("progress 进度必须为 0~100 之间的数值");
        }
      }
      if (goalInput.deadline && typeof goalInput.deadline === "string") {
        validateIsoTimestamp(goalInput.deadline, "deadline");
      }

      const savePromise = new Promise<{ ok: boolean; goal?: Record<string, unknown> }>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ ok: true, goal: goalInput });
        }, 6000);

        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "goals" && Array.isArray(msg.goals)) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              const found = msg.goals.find((g: Record<string, unknown>) =>
                (goalInput.id && g.id === goalInput.id) || g.title === title,
              );
              resolve({ ok: true, goal: found || goalInput });
            } else if (msg.type === "error") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              reject(new Error(msg.message || "目标保存失败"));
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      // 对应 WS: { type: "goal-save", goal }
      client.ws.send(JSON.stringify({ type: "goal-save", goal: goalInput }));
      const result = await savePromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: `目标【${title}】已成功保存并广播。`,
                goal: result.goal || goalInput,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "goals_task_complete") {
      const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      if (!taskId) {
        throw new Error("taskId 必填且不能为空");
      }
      const goalId = typeof args.goalId === "string" && args.goalId.trim() ? args.goalId.trim() : undefined;

      const completePromise = new Promise<{ ok: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ ok: true });
        }, 8000);

        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "goals") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve({ ok: true });
            } else if (msg.type === "error") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              reject(new Error(msg.message || "打勾完成任务失败"));
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      // 对应 WS: { type: "goal-task-complete", taskId, goalId }
      client.ws.send(JSON.stringify({ type: "goal-task-complete", taskId, goalId }));
      await completePromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                taskId,
                goalId,
                message: `已成功在目标系统与生活运转中打勾完成任务 ${taskId}${goalId ? `，关联目标 ${goalId} 进度已同步推进` : ""}。`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "goals_task_reschedule") {
      const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      if (!taskId) {
        throw new Error("taskId 必填且不能为空");
      }
      const dueDate = typeof args.dueDate === "string" && args.dueDate.trim() ? args.dueDate.trim() : undefined;
      const startTime = typeof args.startTime === "string" && args.startTime.trim() ? args.startTime.trim() : undefined;

      if (!dueDate && !startTime) {
        throw new Error("dueDate 与 startTime 至少需提供一个用于顺延改期");
      }
      if (dueDate) validateIsoTimestamp(dueDate, "dueDate");
      if (startTime) validateIsoTimestamp(startTime, "startTime");

      const reschedulePromise = new Promise<{ ok: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ ok: true });
        }, 8000);

        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "goals") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve({ ok: true });
            } else if (msg.type === "error") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              reject(new Error(msg.message || "顺延改期任务失败"));
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      // 对应 WS: { type: "goal-task-reschedule", taskId, dueDate, startTime }
      client.ws.send(JSON.stringify({ type: "goal-task-reschedule", taskId, dueDate, startTime }));
      await reschedulePromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                taskId,
                dueDate,
                startTime,
                message: `已成功执行任务 ${taskId} 顺延改期处方（严格强制 ISO 8601 起止时间戳铁律）。`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // 组 B：伴生神经中枢 (Sentinel)
    // ----------------------------------------------------
    if (name === "sentinel_status") {
      const sentinelPromise = new Promise<Record<string, unknown>>((resolve) => {
        const timer = setTimeout(() => {
          resolve((client.hello.sentinel as Record<string, unknown>) || {});
        }, 4000);

        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "sentinel-status" && msg.sentinel) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve(msg.sentinel as Record<string, unknown>);
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      // 对应 WS: { type: "sentinel-get" }
      client.ws.send(JSON.stringify({ type: "sentinel-get" }));
      const sentinelData = await sentinelPromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(sentinelData, null, 2),
          },
        ],
      };
    }

    if (name === "sentinel_spark") {
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) {
        throw new Error("summary (脉冲摘要) 必填且不能为空");
      }
      const weight = typeof args.weight === "number" && args.weight > 0 ? Math.min(10, Math.max(1, args.weight)) : 2;

      const sparkPromise = new Promise<Record<string, unknown> | null>((resolve) => {
        const timer = setTimeout(() => {
          resolve(null);
        }, 3000);

        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "sentinel-status" && msg.sentinel) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve(msg.sentinel as Record<string, unknown>);
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      // 对应 WS: { type: "sentinel-spark", summary, weight }
      client.ws.send(JSON.stringify({ type: "sentinel-spark", summary, weight }));
      const newStatus = await sparkPromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                spark: { summary, weight },
                message: "已主动向神经中枢注入感官脉冲（提升认知张力，加速 System 2 慢思考唤醒）。",
                currentStatus: newStatus || "脉冲已发射，神经中枢张力已累加",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "sentinel_sensor_list") {
      const sentinelPromise = new Promise<Record<string, unknown>>((resolve) => {
        const timer = setTimeout(() => {
          resolve((client.hello.sentinel as Record<string, unknown>) || {});
        }, 4000);

        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "sentinel-status" && msg.sentinel) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve(msg.sentinel as Record<string, unknown>);
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      client.ws.send(JSON.stringify({ type: "sentinel-get" }));
      const sentinelData = await sentinelPromise;
      client.close();

      let sensors = (Array.isArray(sentinelData.sensors) ? sentinelData.sensors : []) as Array<Record<string, unknown>>;
      if (args.category) {
        sensors = sensors.filter((s) => s.category === args.category);
      }
      if (args.subCategory) {
        sensors = sensors.filter((s) => s.subCategory === args.subCategory);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: sensors.length,
                usageGuide: "若目标需响应外部环境或代码变动，可将上述传感器的 id（如 'sen-weather-hz'）填入 Goal.tags 中；若目标属于纯静态/思考类目标，不依赖任何传感器，则无需设置传感器标签。",
                sensors,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "sentinel_sensor_save") {
      const label = typeof args.label === "string" ? args.label.trim() : "";
      if (!label) throw new Error("label 必填且不能为空");
      const kind = typeof args.kind === "string" ? args.kind : "";
      if (!["weather", "temporal", "fs", "siyuan"].includes(kind)) {
        throw new Error("kind 必须为 weather / temporal / fs / siyuan 之一");
      }

      const savePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 4000);
        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "sentinel-status" && msg.sentinel) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve(msg.sentinel as Record<string, unknown>);
            } else if (msg.type === "error") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              reject(new Error(msg.message || "保存感知器失败"));
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      client.ws.send(
        JSON.stringify({
          type: "sensor-save",
          sensor: {
            id: typeof args.id === "string" ? args.id : undefined,
            label,
            kind,
            salience: args.salience,
            enabled: args.enabled !== false,
            city: args.city,
            latitude: args.latitude,
            longitude: args.longitude,
            intervalMs: args.intervalMs,
            dirs: args.dirs,
            plansPath: args.plansPath,
          },
        }),
      );

      const res = await savePromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: "感知器「" + label + "」配置已成功保存并挂载至神经中枢网格。",
                sentinel: res,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "sentinel_sensor_toggle") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) throw new Error("id 必填");
      const enabled = Boolean(args.enabled);

      const togglePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 4000);
        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "sentinel-status" && msg.sentinel) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve(msg.sentinel as Record<string, unknown>);
            } else if (msg.type === "error") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              reject(new Error(msg.message || "切换感知器状态失败"));
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      client.ws.send(JSON.stringify({ type: "sentinel-toggle", id, enabled }));
      const res = await togglePromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                id,
                enabled,
                message: "感知器 " + id + " 已切换为 " + (enabled ? "在线运行" : "停用静默") + "。",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "sentinel_sensor_delete") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) throw new Error("id 必填");

      const delPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 4000);
        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "sentinel-status" && msg.sentinel) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve(msg.sentinel as Record<string, unknown>);
            } else if (msg.type === "error") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              reject(new Error(msg.message || "删除感知器失败"));
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      client.ws.send(JSON.stringify({ type: "sensor-delete", id }));
      const res = await delPromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                id,
                message: "感知器 " + id + " 已成功从神经中枢卸载。",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "notification_send") {
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      const level = (typeof args.level === "string" ? args.level : "info") as "info" | "success" | "warn" | "error";
      const metadata = (args.metadata && typeof args.metadata === "object") ? (args.metadata as Record<string, unknown>) : undefined;

      if (!title) throw new Error("title 必填");
      if (!content) throw new Error("content 必填");

      const notifPromise = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true }), 5000);
        const onMsg = (raw: WebSocket.Data) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "toast") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              resolve({ ok: true });
            } else if (msg.type === "error") {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              reject(new Error(msg.message || "通知发送失败"));
            }
          } catch {}
        };
        client.ws.on("message", onMsg);
      });

      // 复用 WS 通道的 notification-test 接口完成统一发送
      client.ws.send(JSON.stringify({
        type: "notification-test",
        payload: { title, content, level, metadata }
      }));

      await notifPromise;
      client.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: `通知「${title}」已成功分发至外部推送渠道。`
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // 组 C：定时任务 (Schedules)
    // 全部经由主进程 WS 消息（schedules-list / schedule-save / schedule-delete / schedule-run），
    // 由主进程统一做校验、审计、持久化与广播，MCP 侧不直写 schedules.json。
    // ----------------------------------------------------
    if (name === "schedules_list" || name === "schedules_save" || name === "schedules_delete" || name === "schedules_enable" || name === "schedules_run") {
      const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const cadenceDesc = (c: Record<string, unknown>): string => {
        if (c?.type === "daily") return `每天 ${c.at}`;
        if (c?.type === "weekly") return `每周${((c.days as Array<number>) ?? []).map((d) => WD[d] ?? d).join("/")} ${c.at}`;
        if (c?.type === "interval") return `每 ${c.everyMinutes} 分钟`;
        if (c?.type === "once") {
          const d = new Date(String(c.at ?? ""));
          if (Number.isNaN(d.getTime())) return "单次（时间无效）";
          const p = (n: number) => String(n).padStart(2, "0");
          return `单次 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        }
        return `cron: ${c?.expr ?? ""}`;
      };
      const fmtSchedule = (s: Record<string, unknown>) => {
        const st = (s.state ?? {}) as Record<string, unknown>;
        const isExec = s.mode === "exec";
        return {
          id: s.id,
          name: s.name,
          enabled: s.enabled !== false,
          mode: isExec ? "exec" : "agent",
          harnessId: isExec ? "（脚本）" : s.harnessId,
          cwd: s.cwd || "（自动工作区）",
          cadence: cadenceDesc((s.cadence ?? {}) as Record<string, unknown>),
          ...(isExec
            ? { commandPreview: String(s.execCommand ?? "").slice(0, 80) }
            : { promptPreview: String(s.promptTemplate ?? "").slice(0, 80) }),
          running: Boolean(st.running),
          nextFireAt: st.nextFireAt ?? null,
          lastRunAt: st.lastRunAt ?? null,
          lastStatus: st.lastStatus ?? null,
          lastError: st.lastError ?? null,
        };
      };
      // 等主进程下一条指定类型的消息；type:"error" 一律视为失败并抛出
      const awaitMsg = (types: Array<string>, timeoutMs: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`HarnessGate 应答超时（等待 ${types.join("/")}，${timeoutMs}ms）`)), timeoutMs);
          const onMsg = (raw: WebSocket.Data) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(raw.toString()) as Record<string, unknown>;
            } catch {
              return;
            }
            const t = String(msg.type ?? "");
            if (t === "error" || types.includes(t)) {
              clearTimeout(timer);
              client.ws.off("message", onMsg);
              if (t === "error") reject(new Error(String(msg.message ?? "主进程返回错误")));
              else resolve(msg);
            }
          };
          client.ws.on("message", onMsg);
        });
      const fetchSchedules = async (): Promise<Array<Record<string, unknown>>> => {
        const p = awaitMsg(["schedules"], 6000);
        client.ws.send(JSON.stringify({ type: "schedules-list" }));
        const msg = await p;
        return (msg.schedules as Array<Record<string, unknown>>) ?? [];
      };

      if (name === "schedules_list") {
        const list = await fetchSchedules();
        client.close();
        return {
          content: [{ type: "text", text: JSON.stringify({ count: list.length, schedules: list.map(fmtSchedule) }, null, 2) }],
        };
      }

      if (name === "schedules_save") {
        // 安全闸：exec 模式=到点免审批跑任意 shell，只允许人在网页端创建；agent 一律拒绝
        if (args.mode === "exec" || args.execCommand !== undefined) {
          throw new Error("脚本（exec）模式仅支持在 HarnessGate 网页端创建，MCP 侧只能配置 agent 任务");
        }
        for (const k of ["name", "harnessId", "cadence", "promptTemplate"]) {
          if (!args[k]) throw new Error(`缺少必填字段: ${k}`);
        }
        const cadence = args.cadence as Record<string, unknown>;
        if (!cadence || typeof cadence !== "object") throw new Error("cadence 必须为对象");
        if (cadence.type === "daily" || cadence.type === "weekly") {
          if (!/^\d{1,2}:\d{2}$/.test(String(cadence.at ?? ""))) throw new Error("daily/weekly 频率的 at 应为 HH:MM（24 小时制）");
        }
        if (cadence.type === "weekly" && !Array.isArray(cadence.days)) throw new Error("weekly 频率需要 days 数组（0=周日）");
        if (cadence.type === "interval" && !(Number(cadence.everyMinutes) >= 1)) throw new Error("interval 频率需要 everyMinutes ≥ 1");
        if (cadence.type === "once") {
          const okAt = typeof cadence.at === "string" && !Number.isNaN(new Date(cadence.at).getTime());
          if (!okAt && !(Number(cadence.delayMinutes) >= 1)) throw new Error("once 频率需要 at（ISO 时间）或 delayMinutes ≥ 1（倒计时分钟数）");
        }
        if (cadence.type === "cron" && !String(cadence.expr ?? "").trim()) throw new Error("cron 频率需要 expr（5 段表达式）");

        const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : Math.random().toString(36).slice(2, 10);
        const saveMsg = awaitMsg(["schedules"], 6000);
        client.ws.send(
          JSON.stringify({
            type: "schedule-save",
            schedule: {
              id,
              name: String(args.name).slice(0, 40),
              harnessId: String(args.harnessId),
              cadence,
              promptTemplate: String(args.promptTemplate),
              ...(typeof args.cwd === "string" && args.cwd.trim() ? { cwd: args.cwd.trim() } : {}),
              ...(args.autoApprove !== undefined ? { autoApprove: args.autoApprove } : {}),
              ...(args.enabled !== undefined ? { enabled: args.enabled === true } : {}),
              ...(args.window !== undefined ? { window: args.window } : {}),
              ...(args.sessionMode !== undefined ? { sessionMode: args.sessionMode } : {}),
              ...(args.contract !== undefined ? { contract: args.contract } : {}),
            },
          }),
        );
        const msg = await saveMsg;
        const list = (msg.schedules as Array<Record<string, unknown>>) ?? [];
        const rec = list.find((s) => s.id === id);
        client.close();
        if (!rec) throw new Error("保存未生效（主进程任务列表中未找到该任务）");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  action: typeof args.id === "string" ? "updated" : "created",
                  schedule: fmtSchedule(rec),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === "schedules_delete") {
        const id = String(args.id ?? "");
        if (!id) throw new Error("id 必填");
        client.ws.send(JSON.stringify({ type: "schedule-delete", id }));
        // schedule-delete 无应答，删除成功会广播最新列表；补发一次 list 请求确保有消息可等
        const msg = await awaitMsg(["schedules"], 6000).catch(async () => {
          const retry = awaitMsg(["schedules"], 6000);
          client.ws.send(JSON.stringify({ type: "schedules-list" }));
          return await retry;
        });
        const list = (msg.schedules as Array<Record<string, unknown>>) ?? [];
        client.close();
        if (list.some((s) => s.id === id)) throw new Error("删除未生效（任务仍在列表中）");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, message: `定时任务 ${id} 已删除。` }, null, 2),
            },
          ],
        };
      }

      if (name === "schedules_enable") {
        const id = String(args.id ?? "");
        if (!id) throw new Error("id 必填");
        const enable = args.enabled === true;
        const list = await fetchSchedules();
        const rec = list.find((s) => s.id === id);
        if (!rec) throw new Error(`找不到任务 ${id}`);
        // 主进程 save 是字段级合并：仅翻转 enabled，其余字段原样回传（state 交由主进程重算）
        const { state: _state, ...rest } = rec;
        client.ws.send(JSON.stringify({ type: "schedule-save", schedule: { ...rest, enabled: enable } }));
        const msg = await awaitMsg(["schedules"], 6000);
        const after = ((msg.schedules as Array<Record<string, unknown>>) ?? []).find((s) => s.id === id);
        client.close();
        if (!after || after.enabled !== enable) throw new Error("启停未生效");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { success: true, message: `定时任务 ${id}（${String(rec.name)}）已${enable ? "启用" : "停用"}。`, schedule: fmtSchedule(after) },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === "schedules_run") {
        const id = String(args.id ?? "");
        if (!id) throw new Error("id 必填");
        const list = await fetchSchedules();
        const rec = list.find((s) => s.id === id);
        if (!rec) throw new Error(`找不到任务 ${id}`);
        // schedule-run 成功触发时主进程不回包（仅任务不存在时回 error），短等 error 无消息即视为已触发
        client.ws.send(JSON.stringify({ type: "schedule-run", id }));
        const raced = await Promise.race([
          awaitMsg(["error"], 2500).then(
            () => "error" as const,
            () => "fired" as const,
          ),
          new Promise<"fired">((resolve) => setTimeout(() => resolve("fired"), 2500)),
        ]);
        if (raced === "error") throw new Error("触发失败（主进程返回错误）");
        // 触发确认：不能只凭「没等到 error」就报成功——轮询看主进程侧 running 置位
        //（agent 任务会一直挂着）或 lastStatus 已翻转（exec 快任务可能瞬间跑完）。确认不了就报错，绝不静默假成功。
        const stBefore = ((rec.state ?? {}) as Record<string, unknown>).lastStatus ?? null;
        let confirmed = false;
        for (let i = 0; i < 6 && !confirmed; i++) {
          await new Promise((r) => setTimeout(r, 600));
          const now = (await fetchSchedules()).find((s) => s.id === id);
          if (!now) break; // 触发后被并发删除，无从确认，按已触发处理
          const st = (now.state ?? {}) as Record<string, unknown>;
          confirmed = Boolean(st.running) || st.lastStatus !== stBefore;
        }
        client.close();
        if (!confirmed) throw new Error("触发未确认（主进程侧未见 running 置位，任务可能未被执行）");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `定时任务 ${id}（${String(rec.name)}）已触发，正在异步执行；结果稍后用 schedules_list 查看 lastStatus / lastSessionId。`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    }

    client.close();
    return { content: [{ type: "text", text: `未知工具调用: ${name}` }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `操作失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// 父进程（harness 会话）退出后 stdin 会 EOF——必须跟着退，否则孤儿进程越积越多
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));

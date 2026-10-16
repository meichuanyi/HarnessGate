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
            text: `已成功创建会话 ID: ${created.id} (Harness: ${created.harnessId}, Model: ${model || "默认"}, CWD: ${created.cwd})${
              promptText ? "，并已下发初始 Prompt 任务。" : "。"
            }`,
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

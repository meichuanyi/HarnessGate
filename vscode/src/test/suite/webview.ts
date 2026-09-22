import * as vscode from "vscode";
import { RENDERER_SOURCE } from "../../generated/renderer-source.ts";
import { mdToHtml } from "../../markdown.ts";

/**
 * 回归测试（用户报告：历史会话一直"加载中"、Markdown 渲染缺失）：
 * ① 根因是注入 Webview 的渲染器含 TS 类型标注，脚本语法错误全挂 → 注入串必须是合法 JS；
 * ② 渲染器功能正确性（插件版与注入版行为一致）；
 * ③ 历史会话的 transcript 能取到内容。
 */
export async function run(): Promise<void> {
  const results: Array<[string, boolean, string]> = [];
  const check = (name: string, ok: boolean, extra = "") => {
    results.push([name, ok, extra]);
    console.log(`${ok ? "✔" : "✘"} ${name}${extra ? "  " + extra : ""}`);
  };

  // ① 注入串必须是合法 JavaScript（类型标注会让 new Function 抛 SyntaxError）
  let compiled: () => unknown;
  try {
    compiled = new Function(RENDERER_SOURCE + "\nreturn mdToHtml;") as () => unknown;
    check("① 注入串是合法 JavaScript", true, `${RENDERER_SOURCE.length} 字符`);
  } catch (err) {
    check("① 注入串是合法 JavaScript", false, String(err).slice(0, 120));
    throw err;
  }

  // ② 渲染器功能：注入版与插件版行为一致
  const webMd = compiled() as (s: string) => string;
  const cases: Array<[string, string]> = [
    ["# 标题一", "<h1>标题一</h1>"],
    ["**加粗** 与 *斜体* 与 `code`", "<strong>加粗</strong>"],
    ["```python\nprint('hi')\n```", 'data-lang="python"'],
    ["| a | b |\n| - | - |\n| 1 | 2 |", "<table>"],
    ["- 甲\n- 乙", "<ul>"],
    ["1. 第一\n2. 第二", "<ol>"],
    ["> 引用一句", "<blockquote>"],
    ["---", "<hr>"],
    ["[文本](https://example.com)", 'href="https://example.com"'],
    ["<img src=x onerror=alert(1)>", "&lt;img"],
  ];
  let allOk = true;
  for (const [input, expect] of cases) {
    const a = mdToHtml(input);
    const b = webMd(input);
    if (!a.includes(expect)) {
      allOk = false;
      console.log("  ✘ 插件版渲染缺", JSON.stringify(expect), "←", JSON.stringify(input));
    }
    if (a !== b) {
      allOk = false;
      console.log("  ✘ 两版不一致", JSON.stringify(input));
    }
  }
  check("② Markdown 渲染（10 类用例，插件版=注入版）", allOk);
  check("② 未闭合代码围栏按代码块处理（流式中途）", mdToHtml("```js\nlet x = 1").includes("<pre"));
  {
    const tbl = mdToHtml("| a | b |\n| - | - |\n| 1 | 2 |");
    check("② 表格：表头/分隔行/数据行", tbl.includes("<thead>") && tbl.includes("<th>a</th>") && tbl.includes("<td>1</td>") && !tbl.includes("<td>-</td>"), tbl.slice(0, 80));
  }

  // ③ 历史会话：挑一个归档会话，通过协议拿 transcript，确认有内容
  const ext = vscode.extensions.getExtension("meichuan.harnessgate");
  const api = (await ext!.activate()) as unknown as {
    store: { sessions: Map<string, { id: string; status: string; live: boolean; title?: string }> };
    client: {
      send: (m: unknown) => boolean;
      on: (e: string, f: (m: unknown) => void) => void;
      off: (e: string, f: (m: unknown) => void) => void;
    };
  };
  for (let i = 0; i < 40 && api.store.sessions.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const saved = [...api.store.sessions.values()].find((s) => !s.live && (s.title || "").length > 3);
  check("③ 找到归档会话用于验证", Boolean(saved), saved?.title?.slice(0, 24) ?? "");

  if (saved) {
    const entries = await new Promise<Array<Record<string, unknown>>>((resolve) => {
      const onT = (m: unknown) => {
        const mm = m as Record<string, unknown>;
        if (mm.type === "transcript" && mm.sessionId === saved.id) {
          api.client.off("transcript", onT);
          resolve((mm.entries as Array<Record<string, unknown>>) ?? []);
        }
      };
      api.client.on("transcript", onT);
      api.client.send({ type: "transcript", sessionId: saved.id });
      setTimeout(() => resolve([]), 8000);
    });
    check("③ 历史会话能取到台账", entries.length > 0, `${entries.length} 条`);
    const kinds = entries.map((e) => String(e.kind));
    check("③ 台账里有助手回复（可渲染 Markdown）", kinds.includes("assistant"), `kinds=${[...new Set(kinds)].join("/")}`);
  }

  console.log("\n=== 完成 ===");
  const failed = results.filter(([, ok]) => !ok);
  console.log(`共 ${results.length} 项，失败 ${failed.length}`);
  if (failed.length) throw new Error(`${failed.length} 项未通过: ${failed.map(([n]) => n).join(", ")}`);
}

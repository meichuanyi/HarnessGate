// 在真实 VS Code 里打开聊天面板，抓 Webview 的 HTML，检查渲染器有没有被正确注入
const vscode = require("vscode");

async function run() {
  const ext = vscode.extensions.getExtension("harnessgate.harnessgate");
  const api = await ext.activate();
  for (let i = 0; i < 40 && !api.store.sessions.size; i++) await new Promise(r => setTimeout(r, 250));
  const s = [...api.store.sessions.values()].find(x => (x.title || "").length > 0) || [...api.store.sessions.values()][0];
  console.log("打开会话:", s.id, JSON.stringify((s.title || "").slice(0, 30)));

  // 拦截 createWebviewPanel，抓 panel.webview.html
  const orig = vscode.window.createWebviewPanel;
  let captured = null;
  vscode.window.createWebviewPanel = function (...args) {
    const p = orig.apply(this, args);
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(p.webview), "html")
      || Object.getOwnPropertyDescriptor(p.webview, "html");
    captured = p.webview.html;
    return p;
  };
  api.openChat(s.id);
  await new Promise(r => setTimeout(r, 2500));
  vscode.window.createWebviewPanel = orig;

  if (!captured) { console.log("✘ 没抓到 HTML"); throw new Error("no html"); }
  console.log("HTML 长度:", captured.length);
  const hasLiteral = captured.includes("${RENDERER_SOURCE}");
  const hasFn = captured.includes("function mdToHtml");
  const hasScript = captured.includes("acquireVsCodeApi");
  console.log("含未求值的 ${RENDERER_SOURCE}:", hasLiteral ? "✘ 是（脚本会语法错误）" : "✔ 否");
  console.log("含 mdToHtml 定义:", hasFn ? "✔ 是" : "✘ 否");
  console.log("含 acquireVsCodeApi:", hasScript ? "✔ 是" : "✘ 否");
  const i = captured.indexOf("<script>");
  console.log("--- <script> 后 300 字符 ---");
  console.log(captured.slice(i, i + 300));
  if (hasLiteral || !hasFn) throw new Error("渲染器注入有问题");
}
module.exports = { run };

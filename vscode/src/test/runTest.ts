import { runTests } from "@vscode/test-electron";
import * as path from "node:path";

async function main(): Promise<void> {
  // __dirname = <插件目录>/out-test，插件根就是它上一级
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = process.env.HG_TEST
    ? path.resolve(__dirname, `suite/${process.env.HG_TEST}.js`)
    : path.resolve(__dirname, "suite/index.js");
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ["--no-sandbox", "--disable-gpu", "--disable-workspace-trust", "--remote-debugging-port=9222"],
  });
}
main().catch((err) => {
  console.error("测试运行失败:", err);
  process.exit(1);
});

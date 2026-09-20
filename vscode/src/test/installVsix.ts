import { runTests } from "@vscode/test-electron";
import * as path from "node:path";

/**
 * 验证打包出的 .vsix 能被真实 VS Code 装上并连上服务。
 *   node out-test/installVsix.js
 * 需要先 npm run package，且本机 9830 上有服务在跑。
 */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, "..");
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(root, "out-test/suite/install.js"),
    launchArgs: ["--no-sandbox", "--disable-gpu"],
  });
}
main().catch((err) => {
  console.error("vsix 安装验证失败:", err);
  process.exit(1);
});

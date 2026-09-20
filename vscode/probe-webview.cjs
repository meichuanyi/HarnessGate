const path = require("path");
const { runTests } = require("@vscode/test-electron");
(async () => {
  await runTests({
    extensionDevelopmentPath: __dirname,
    extensionTestsPath: path.join(__dirname, "probe-suite.cjs"),
    launchArgs: ["--no-sandbox", "--disable-gpu"],
  });
})().catch((e) => { console.error(e); process.exit(1); });

import { build } from "esbuild";

await build({
  entryPoints: ["src/test/runTest.ts"],
  bundle: true,
  outfile: "out-test/runTest.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});
await build({
  entryPoints: ["src/test/suite/webview.ts"],
  bundle: true,
  outfile: "out-test/suite/webview.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});
await build({
  entryPoints: ["src/test/suite/index.ts"],
  bundle: true,
  outfile: "out-test/suite/index.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});
await build({
  entryPoints: ["src/test/suite/bigload.ts"],
  bundle: true,
  outfile: "out-test/suite/bigload.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});
await build({
  entryPoints: ["src/test/suite/openflow.ts"],
  bundle: true,
  outfile: "out-test/suite/openflow.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});
await build({
  entryPoints: ["src/test/suite/vis.ts"],
  bundle: true,
  outfile: "out-test/suite/vis.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});
console.log("测试代码已构建");

await build({
  entryPoints: ["src/test/installVsix.ts"],
  bundle: true,
  outfile: "out-test/installVsix.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});
await build({
  entryPoints: ["src/test/suite/install.ts"],
  bundle: true,
  outfile: "out-test/suite/install.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
});

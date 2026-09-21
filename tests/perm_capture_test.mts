/**
 * 权限决策采集单测：直接调 requestPermission（autoApprove 路径不依赖 agent 连接），
 * 断言 audit + transcript 落了 permKind/locations/input/raw/intent 等新字段。
 * 运行：npx tsx tests/perm_capture_test.mts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessSession } from "../server/session.ts";
import type { HarnessSpec } from "../server/types.ts";
import { AuditLog } from "../server/audit.ts";
import { WorkspaceHub } from "../server/workspace.ts";

const cwd = mkdtempSync(join(tmpdir(), "hg-permcap-"));
const audit = new AuditLog(join(cwd, "audit.jsonl"));
const spec = { id: "fake", label: "Fake", cmd: "true" } as unknown as HarnessSpec;
const session = new HarnessSession(spec, HarnessSession.newRecord(spec, cwd), audit, {
  onStatus: () => {}, onUpdate: () => {}, onTurnEnd: () => {},
  onPermission: () => {}, onLog: () => {}, onPersist: () => {},
}, new WorkspaceHub(audit));
session.autoApprove = "all";
(session as unknown as { intentTag: string }).intentTag = "T9 写测试文件";

const resp = await (session as unknown as {
  requestPermission(p: unknown): Promise<{ outcome: { outcome: string; optionId?: string } }>;
}).requestPermission({
  toolCall: {
    title: "rm -rf /tmp/old-cache",
    kind: "execute",
    locations: [{ path: "/tmp/old-cache" }],
    rawInput: { command: "rm -rf /tmp/old-cache", description: "清理旧缓存目录" },
  },
  options: [
    { optionId: "opt_reject", name: "Reject", kind: "reject_once" },
    { optionId: "opt_allow", name: "Allow Always", kind: "allow_always" },
  ],
});

const okResp = resp.outcome.outcome === "selected" && resp.outcome.optionId === "opt_allow";
console.log(`${okResp ? "✔" : "✘"} 决策选了 Allow Always（跳过 reject）: ${JSON.stringify(resp.outcome)}`);

const auditEntry = JSON.parse(readFileSync(join(cwd, "audit.jsonl"), "utf8").trim().split("\n").pop()!);
const checks: Array<[string, boolean, string]> = [
  ["audit.permKind = execute", auditEntry.permKind === "execute", String(auditEntry.permKind)],
  ["audit.locations 含路径", Array.isArray(auditEntry.locations) && auditEntry.locations[0] === "/tmp/old-cache", JSON.stringify(auditEntry.locations)],
  ["audit.input 含 description", /清理旧缓存目录/.test(auditEntry.input ?? ""), String(auditEntry.input).slice(0, 60)],
  ["audit.raw 完整请求", typeof auditEntry.raw === "string" && /toolCall/.test(auditEntry.raw), ""],
  ["audit.task = T9", auditEntry.task === "T9 写测试文件", String(auditEntry.task)],
  ["audit.reason = always 放行", /always/.test(auditEntry.reason ?? ""), String(auditEntry.reason)],
];
let bad = 0;
for (const [name, ok, extra] of checks) { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? "  " + extra : ""}`); if (!ok) bad++; }

// 全自动档：危险操作也自动决策（不挂起），但 audit 打 danger 标记供回溯
const respDanger = await (session as unknown as { requestPermission(p: unknown): Promise<{ outcome: { outcome: string; optionId?: string } }> }).requestPermission({
  toolCall: { title: "git push --force origin main", kind: "execute" },
  options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
});
const lines = readFileSync(join(cwd, "audit.jsonl"), "utf8").trim().split("\n");
const dEntry = lines.map((l) => JSON.parse(l)).filter((e) => e.danger === true).pop();
const dangerOk = dEntry && /force/.test(dEntry.title) && respDanger.outcome.outcome === "selected";
console.log(`${dangerOk ? "✔" : "✘"} 全自动对危险操作也决策（不挂起）+ danger 标记`, dangerOk ? "" : JSON.stringify(dEntry));
if (!dangerOk) bad++;

process.exit(bad || !okResp ? 1 : 0);

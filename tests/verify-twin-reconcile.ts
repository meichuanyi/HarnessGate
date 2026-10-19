/**
 * 双胞胎收编逻辑验证（server/history.ts reconcileTwin）。
 * 跑法：npx tsx tests/verify-twin-reconcile.ts
 * 用临时目录，不碰 ~/.harnessgate。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistorySync, type DiscoveredSession, type HistoryProvider } from "../server/history.ts";
import { SessionStore } from "../server/store.ts";
import type { TranscriptEntry } from "../server/types.ts";

let failed = 0;
const assert = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) failed += 1;
};

const tool = (id: string, ts: string): TranscriptEntry =>
  ({ kind: "tool", ts, toolCallId: id, title: `tool ${id}`, status: "completed" }) as TranscriptEntry;

const dir = mkdtempSync(join(tmpdir(), "twin-test-"));
const store = new SessionStore(join(dir, "sessions.json"));

const SESS = "sess_5b27572e-7a3c-45dc-a662-baa69cab6aea";
const ACP = "2f314e59-72b1-441b-b67f-f8489c6ab2d3";
const user = (text: string, ts: string): TranscriptEntry => ({ kind: "user", ts, text }) as TranscriptEntry;

// —— 场景 1 的数据：同一段对话的两条记录（UI 本体 + 修复前导入的残骸）——
const convTools = Array.from({ length: 10 }, (_, i) => tool(`call_${i}`, `2026-10-19T02:03:${10 + i}Z`));
const convTranscript = [user("做个贴屏日历", "2026-10-19T02:02:54Z"), ...convTools];
store.upsert({
  id: "twin0001", harnessId: "zcode", cwd: "/proj/a",
  createdAt: "2026-10-19T02:02:53.683Z", lastActiveAt: "2026-10-19T02:05:00.000Z",
  status: "saved", acpSessionId: ACP, resumable: true, origin: "new",
  tags: ["日历"],
  transcript: convTranscript,
});
store.upsert({
  id: "artifact1", harnessId: "zcode", cwd: "/proj/a",
  createdAt: "2026-10-19T02:03:35.119Z", lastActiveAt: "2026-10-19T02:05:00.000Z",
  status: "saved", acpSessionId: SESS, resumable: true, origin: "imported",
  starred: true, tags: ["收藏的"],
  transcript: convTranscript,
});

let nTools = 10;
const discovered: DiscoveredSession = {
  harnessId: "zcode", externalId: SESS, cwd: "/proj/a", title: "做个贴屏日历",
  createdAt: "2026-10-19T02:03:35.119Z", updatedAt: "2026-10-19T02:06:00.000Z",
  fingerprint: "10:111",
  load: () => [user("做个贴屏日历", "2026-10-19T02:02:54Z"), ...Array.from({ length: nTools }, (_, i) => tool(`call_${i}`, `2026-10-19T02:03:${10 + i}Z`))],
};
const provider: HistoryProvider = { id: "zcode", label: "ZCode", available: () => true, discover: () => [discovered] };

const liveSet = new Set<string>();
const sync = new HistorySync(store, join(dir, "history-index.json"), [provider], (l) => console.log("  [history]", l));
sync.liveLookup = (id) => liveSet.has(id);

console.log("— 场景1：本体已回收 + 导入残骸存在 → 收编 —");
sync.run();
{
  const all = store.all();
  assert(all.length === 1, `收编后只剩 1 条记录（实际 ${all.length}）`);
  const s = all[0]!;
  assert(s.id === "twin0001", `幸存者是本体 twin0001（实际 ${s.id}）`);
  assert(s.acpSessionId === SESS, `本体收养了 harness 侧会话 id（实际 ${s.acpSessionId}）`);
  assert(s.origin === "imported", `origin 转 imported 走 fork 优先恢复链（实际 ${s.origin}）`);
  assert(s.starred === true, `残骸的收藏并入（实际 ${s.starred}）`);
  assert((s.tags ?? []).length === 2, `标签并集（实际 ${JSON.stringify(s.tags)}）`);
}

console.log("— 场景2：对话增长后再同步 → 更新收养后的记录，不再新增 —");
discovered.fingerprint = "11:222";
nTools = 11;
sync.run();
{
  const all = store.all();
  assert(all.length === 1, `仍只有 1 条记录（实际 ${all.length}）`);
  const toolCount = all[0]!.transcript.filter((e) => e.kind === "tool").length;
  assert(toolCount === 11, `台账刷新到 11 个工具调用（实际 ${toolCount}）`);
}
console.log("— 场景2b：指纹没变 → 跳过（记录不动）—");
const before = JSON.stringify(store.all()[0]!.transcript.length);
discovered.fingerprint = "11:222";
sync.run();
assert(JSON.stringify(store.all()[0]!.transcript.length) === before, "无变化时不改写");

console.log("— 场景3：活动会话认领（实例存活：只认领，不改记录、不新增）—");
const liveTools = Array.from({ length: 4 }, (_, i) => tool(`live_${i}`, "2026-10-19T09:00:0" + i + "Z"));
store.upsert({
  id: "live0001", harnessId: "zcode", cwd: "/proj/b",
  createdAt: "2026-10-19T08:59:00.000Z", lastActiveAt: "2026-10-19T09:01:00.000Z",
  status: "ready", acpSessionId: "uuid-live-1111-2222-3333", resumable: true, origin: "new",
  transcript: [user("查下进度", "2026-10-19T08:59:10Z"), ...liveTools],
});
const discovered2: DiscoveredSession = {
  harnessId: "zcode", externalId: "sess_live", cwd: "/proj/b", title: "查下进度",
  createdAt: "2026-10-19T08:59:05.000Z", updatedAt: "2026-10-19T09:01:30.000Z",
  fingerprint: "4:333",
  load: () => [user("查下进度", "2026-10-19T08:59:10Z"), ...liveTools],
};
const sync2 = new HistorySync(store, join(dir, "history-index.json"), [{
  id: "zcode", label: "ZCode", available: () => true, discover: () => [discovered, discovered2],
}], (l) => console.log("  [history]", l));
sync2.liveLookup = (id) => liveSet.has(id);
liveSet.add("live0001");
sync2.run();
{
  const proj = store.all().filter((s) => s.cwd === "/proj/b");
  assert(proj.length === 1, `活动会话没有被复制（/proj/b 实际 ${proj.length} 条）`);
  assert(proj[0]!.id === "live0001" && proj[0]!.acpSessionId!.startsWith("uuid-live"), "活动实例的 acpSessionId 未被改写");
  assert(proj[0]!.status === "ready", "活动实例状态未被同步改掉");
}
console.log("— 场景3b：实例回收后再同步 → 走正常更新路径收养 sess_ id —");
liveSet.delete("live0001");
discovered2.fingerprint = "5:444";
sync2.run();
{
  const proj = store.all().filter((s) => s.cwd === "/proj/b");
  assert(proj.length === 1 && proj[0]!.acpSessionId === "sess_live", `回收后收养 sess_live（实际 ${proj[0]?.acpSessionId}）`);
}

console.log("— 场景4：无工具对话、同 cwd 两条相近记录 → 按时间最近认自己，不误收编 —");
store.upsert({
  id: "helloA", harnessId: "zcode", cwd: "/proj/c",
  createdAt: "2026-10-19T10:00:00.000Z", lastActiveAt: "2026-10-19T10:00:30.000Z",
  status: "saved", acpSessionId: "uuid-helloA", resumable: true, origin: "new",
  transcript: [user("你好", "2026-10-19T10:00:01Z")],
});
store.upsert({
  id: "helloB", harnessId: "zcode", cwd: "/proj/c",
  createdAt: "2026-10-19T10:02:00.000Z", lastActiveAt: "2026-10-19T10:02:30.000Z",
  status: "saved", acpSessionId: "uuid-helloB", resumable: true, origin: "new",
  transcript: [user("你好", "2026-10-19T10:02:01Z")],
});
const discovered3: DiscoveredSession = {
  harnessId: "zcode", externalId: "sess_helloA", cwd: "/proj/c", title: "你好",
  createdAt: "2026-10-19T10:00:02.000Z", updatedAt: "2026-10-19T10:00:30.000Z",
  fingerprint: "2:555",
  load: () => [
    user("你好", "2026-10-19T10:00:01Z"),
    { kind: "assistant", ts: "2026-10-19T10:00:20Z", text: "你好！有什么可以帮你？" } as TranscriptEntry,
    user("今天几号", "2026-10-19T10:00:25Z"),
    { kind: "assistant", ts: "2026-10-19T10:00:28Z", text: "今天是 2026-10-19。" } as TranscriptEntry,
  ],
};
const sync3 = new HistorySync(store, join(dir, "history-index.json"), [{
  id: "zcode", label: "ZCode", available: () => true, discover: () => [discovered3],
}], () => {});
sync3.run();
{
  const proj = store.all().filter((s) => s.cwd === "/proj/c");
  assert(proj.length === 2, `没把两条真实对话合并（/proj/c 实际 ${proj.length} 条）`);
  const a = proj.find((s) => s.id === "helloA");
  assert(a?.acpSessionId === "sess_helloA", `helloA 认领了自己的历史（实际 ${a?.acpSessionId}）`);
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

// test.mjs — dsh-lt-tasks 核心逻辑单测（store / lock / 状态机 / 工具闭环）
// 运行：node test.mjs
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as store from "./lib/store.js";
import * as lock from "./lib/lock.js";
import { tools } from "./lib/tools.js";

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; console.log("  \u2717 " + name); }
}

const tmp = await mkdtemp(join(tmpdir(), "lt-test-"));
process.env.DSH_LT_TASKS_ROOT = tmp;
process.env.DSH_LT_WS_ROOT = join(tmp, "ws-root");
const root = store.resolveTasksRoot();
const wsRoot = store.resolveWorkspaceRoot();
const exec = {};
const t = Object.fromEntries(tools.map((x) => [x.name, x]));

console.log("\n== store ==");
await mkdir(join(tmp, "refsrc"), { recursive: true });
await writeFile(join(tmp, "refsrc", "文献.md"), "# 参考文献\n内容\n", "utf8");
const { id, workspacePath } = await store.createTask(root, "测试任务", "验证", tmp + "/refsrc");
assert(id === "测试任务", "createTask 建任务（中文 id）");
assert(workspacePath.startsWith(wsRoot) && workspacePath.includes("lt-task-001"), "产出工作区落在桌面 ws-root/lt-task-001-*");
assert(workspacePath !== join(root, id), "产出区与任务库分离");
const list = await store.listTasks(root);
assert(list.length === 1 && list[0].status === "planning", "listTasks 返回筹划中");
await store.setStatus(root, id, "blocked");
assert((await store.readMeta(root, id)).status === "blocked", "setStatus 支持 blocked");
await store.setStatus(root, id, "review");
assert((await store.readMeta(root, id)).status === "review", "setStatus 支持 review");
await store.setStatus(root, id, "active");
assert((await store.bumpVersion(root, id)) === 2, "bumpVersion 递增");

console.log("\n== lock ==");
await lock.acquire(root, id, "s1");
assert((await lock.isLocked(root, id)).locked === true, "acquire 加锁");
let threw = false;
try { await lock.acquire(root, id, "s2"); } catch { threw = true; }
assert(threw, "二次 acquire 抛错");
await lock.release(root, id);
assert((await lock.isLocked(root, id)).locked === false, "release 解锁");

console.log("\n== 工具闭环 ==");
const adv = await t.advance_task.execute({ name: "测试任务" }, exec);
assert(adv.status === "active", "advance 置进行中");
assert(typeof adv.handoff === "string", "advance 返回 handoff 索引");
assert(adv.index === undefined && adv.refs === undefined && adv.goal === undefined, "advance 不通读文档（只返回 handoff）");

// 写一个带标题的 md 到产出工作区，验证 rebuildIndex 解析章节
await mkdir(workspacePath, { recursive: true });
await writeFile(join(workspacePath, "草稿.md"), "# 第一章\n## 1.1 节\n内容\n", "utf8");

const saved = await t.save_progress.execute({
  name: "测试任务",
  summary: "完成第一步",
  nextContent: "做第二步",
  filesChanged: "草稿.md\n数据.xlsx",
  decisions: "选方案 A",
  blockers: "- [ ] - 缺数据\n- 等硬件\n[ ] 等硬件2\n纯文本",
  tasklist: "- [x] 第一步\n- [ ] 第二步\n- [ ] 第三步\n"
}, exec);
assert(saved.version === 3, "save_progress 版本递增（store 测试已 bump 到 2，再 +1）");

const handoff = await store.readDoc(root, id, "handoff");
assert(handoff.includes("goal.md") && handoff.includes("index.md"), "handoff 是文档索引（任务库路径）");
assert(handoff.includes("产出工作区") && handoff.includes(workspacePath), "handoff 标注产出工作区路径");
assert(handoff.includes("## 下次推进") && handoff.includes("做第二步"), "handoff 含下次推进");
assert(!handoff.includes("完成第一步"), "handoff 不塞审计轨迹（简洁）");

const progress = await store.readDoc(root, id, "progress");
assert(progress.includes("总结：完成第一步") && progress.includes("决策：选方案 A"), "progress 含审计轨迹（总结+决策）");

const blockersDoc = await store.readDoc(root, id, "blockers");
assert(
  blockersDoc.includes("- [ 缺数据 ]") && blockersDoc.includes("- [ 等硬件 ]") &&
  blockersDoc.includes("- [ 等硬件2 ]") && blockersDoc.includes("- [ 纯文本 ]") &&
  !blockersDoc.includes("- [ ]"),
  "blockers 规整为 - [ 内容 ]"
);

const meta2 = await store.readMeta(root, id);
assert(meta2.status === "blocked", "save_progress 传 blockers 自动置 blocked");
assert(Number(meta2.taskDone) === 1 && Number(meta2.taskTotal) === 3, "tasklist 完成度 1/3");

const index = await store.readDoc(root, id, "index");
assert(index.includes("草稿.md") && index.includes("## 1.1 节"), "index 含文件路径 + 章节标题");

await t.pause_task.execute({ name: "测试任务" }, exec);
assert((await store.readMeta(root, id)).status === "paused", "pause");
await t.resume_task.execute({ name: "测试任务" }, exec);
assert((await store.readMeta(root, id)).status === "active", "resume");
const done = await t.complete_task.execute({ name: "测试任务" }, exec);
assert(done.status === "completed" && done.archiveSuggest, "complete 生成归档建议");

console.log("\n== 并发撞号回退 ==");
// 手动占掉 001 号产出目录，createTask 应自动落到 002（唯一性创建，不共用目录）
await mkdir(join(wsRoot, "lt-task-001-占位"), { recursive: true });
const c1 = await store.createTask(root, "并发A", "验证撞号", null);
assert(c1.wsFolder === "lt-task-002-并发a", "001 被占时新任务落到 002");
// 并发模拟：两个 create 同轮启动，产出目录必须互不相同
const [p1, p2] = await Promise.all([
  store.createTask(root, "并发B", "验证并发", null),
  store.createTask(root, "并发C", "验证并发", null)
]);
assert(p1.wsFolder !== p2.wsFolder && p1.workspacePath !== p2.workspacePath, "并发 create 产出目录不冲突");
const c1meta = await store.readMeta(root, c1.id);
assert(c1meta.workspacePath === c1.workspacePath, "meta.workspacePath 指向实际产出目录");

console.log("\n== delete_task 双端联动 ==");
const del1 = await t.delete_task.execute({ name: "并发A" }, exec);
assert(del1.ok === true, "delete_task 返回 ok");
const del2 = await t.delete_task.execute({ name: "并发B" }, exec);
const del3 = await t.delete_task.execute({ name: "并发C" }, exec);
const fs = await import("node:fs");
const gone = (p) => !fs.existsSync(p);
assert(gone(join(root, c1.id)) && gone(c1.workspacePath), "删除后任务库存档已删");
assert(gone(join(root, p2.id)) && gone(p2.workspacePath), "删除后并发任务产出目录已删");

console.log("\n结果：" + passed + " 通过, " + failed + " 失败");
process.exit(failed > 0 ? 1 : 0);

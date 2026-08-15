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
const root = store.resolveTasksRoot();
const exec = {};
const t = Object.fromEntries(tools.map((x) => [x.name, x]));

console.log("\n== store ==");
await mkdir(join(tmp, "refsrc"), { recursive: true });
await writeFile(join(tmp, "refsrc", "文献.md"), "# 参考文献\n内容\n", "utf8");
const { id } = await store.createTask(root, "测试任务", "验证", tmp + "/refsrc");
assert(id === "测试任务", "createTask 建任务（中文 id）");
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

// 写一个带标题的 md 到 v1，验证 rebuildIndex 解析章节
const v1 = join(root, id, "works", "v1");
await mkdir(v1, { recursive: true });
await writeFile(join(v1, "草稿.md"), "# 第一章\n## 1.1 节\n内容\n", "utf8");

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
assert(handoff.includes("goal.md") && handoff.includes("index.md"), "handoff 是文档索引");
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

console.log("\n结果：" + passed + " 通过, " + failed + " 失败");
process.exit(failed > 0 ? 1 : 0);

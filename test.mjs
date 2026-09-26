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
assert(typeof adv.next === "string" && typeof adv.tasklist === "string" && typeof adv.frozenDigest === "string", "advance 一次内联 next/tasklist/frozenDigest");
assert(adv.handoff === undefined && adv.index === undefined && adv.goal === undefined, "advance 不返回档案全文");

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
assert(handoff.includes("<!-- auto:begin -->") && handoff.includes("## 人工补充（工具不覆盖）"), "handoff 分自动区 + 手写区");
assert(handoff.includes("goal.md") && handoff.includes("index.md"), "handoff 是文档索引（任务库路径）");
assert(handoff.includes("产出工作区") && handoff.includes(workspacePath), "handoff 标注产出工作区路径");
assert(handoff.includes("## 开工必读") && handoff.includes("next.md"), "handoff 指向 next 主文件（不复制全文）");
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

console.log("\n== v0.3.0 冻结 / 参考资料 / 摘要读 ==");
await mkdir(join(tmp, "bigsrc"), { recursive: true });
for (let i = 0; i < 205; i++) await writeFile(join(tmp, "bigsrc", "f" + i + ".txt"), "x");
const { id: nid, workspacePath: nws } = await store.createTask(root, "新功能任务", "验证", [join(tmp, "refsrc"), join(tmp, "bigsrc")]);
assert(fs.existsSync(join(nws, "refs", "refsrc", "文献.md")), "小目录复制进 refs/");
assert(!fs.existsSync(join(nws, "refs", "bigsrc")), "大目录（205 文件）只登记不复制");
assert(store.refsRegisteredOf(await store.readDoc(root, nid, "refs")).length === 1, "仅登记清单 1 条");
await store.writeRefsManual(root, nid, "- 手写备注：原文在 D:\\somewhere");
await store.rebuildRefs(root, nid);
const refsDoc = await store.readDoc(root, nid, "refs");
assert(refsDoc.includes("手写备注") && store.refsRegisteredOf(refsDoc).length === 1, "rebuildRefs 不覆盖手写区与登记清单");
const addRes = await store.addRefs(root, nid, [join(tmp, "refsrc")], "更新");
assert(addRes.copied.length === 1 && addRes.failed.length === 0, "重复补资料：先解除只读再覆盖成功");

const fr = await t.freeze_task.execute({ name: "新功能任务", items: "提高波特率\n已定：TBPRD = 999U", reason: "用户否决" }, exec);
assert(fr.added.length === 2, "freeze_task 追加 2 条");
const fr2 = await t.freeze_task.execute({ name: "新功能任务", items: "提高波特率" }, exec);
assert(fr2.added.length === 0 && fr2.alreadyFrozen.length === 1, "冻结条目幂等不重复");
const adv2 = await t.advance_task.execute({ name: "新功能任务" }, exec);
assert(adv2.frozenDigest.includes("提高波特率") && adv2.frozenDigest.includes("TBPRD = 999U"), "advance 内联冻结摘要");
const sp = await t.save_progress.execute({ name: "新功能任务", summary: "把 TBPRD = 999U 改小试试", nextContent: "继续" }, exec);
assert(sp.warnings.length > 0, "命中冻结项返回告警（非阻断）");
assert(!("next" in sp), "save_progress 不回显 next");
const un = await t.unfreeze_task.execute({ name: "新功能任务", match: "提高波特率" }, exec);
assert(un.removed === 1, "unfreeze_task 解除 1 条");

const g1 = await t.get_task.execute({ name: "新功能任务" }, exec);
assert(!!g1.docIndex && !g1.docs && g1.docIndex.length === 12, "get_task 默认只回 12 项清单");
assert(JSON.stringify(g1).length < 3000, "get_task 摘要够小（<3000 字符）");
const g2 = await t.get_task.execute({ name: "新功能任务", docs: "blockers,review" }, exec);
assert(typeof g2.docs.blockers === "string" && typeof g2.docs.review === "string", "blockers/review 可读（旧版漏掉）");
await writeFile(join(root, nid, "progress.md"), ("填充内容".repeat(10) + "\n").repeat(200), "utf8");
let bigThrew = false;
try { await t.get_task.execute({ name: "新功能任务", docs: "progress" }, exec); } catch { bigThrew = true; }
assert(bigThrew, "大文档整读被拒");
const g3 = await t.get_task.execute({ name: "新功能任务", docs: "progress", lines: "1-2" }, exec);
assert(g3.docs.progress.text.split("\n").length === 2, "lines 分段可用");
const man = JSON.parse(await readFile(join(nws, "backups", "v2", "manifest.json"), "utf8"));
assert(man.mode === "manifest" && !fs.existsSync(join(nws, "backups", "v2", "workspace")), "默认清单模式快照（不复制内容）");

console.log("\n结果：" + passed + " 通过, " + failed + " 失败");
process.exit(failed > 0 ? 1 : 0);

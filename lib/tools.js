import { defineTool } from "@deepseek-ai/dsh-tools";
import { join } from "node:path";
import * as store from "./store.js";
import * as lock from "./lock.js";

/** 从执行上下文取会话 id（加锁用）。 */
function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? process.env.DSH_SESSION_ID ?? "unknown";
}

/** 按 name 或 id 找任务：精确优先，模糊唯一，多候选报错。 */
async function findTask(root, name) {
  const tasks = await store.listTasks(root);
  const exact = tasks.find((t) => t.name === name || t.id === name);
  if (exact) return exact;
  const fuzzy = tasks.filter((t) => (t.name || "").includes(name) || (t.id || "").includes(name));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`多个任务匹配「${name}」：${fuzzy.map((t) => t.name).join("、")}，请精确指定`);
  }
  throw new Error(`未找到任务「${name}」。现有任务：${tasks.map((t) => t.name).join("、") || "无"}`);
}

/** 输出渲染：值转 JSON 文本。 */
function renderJson(args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** 清洗一行阻塞/审查项：剥掉行首的列表标记 / checkbox / 多余横线，统一供 "- [ 内容 ]" 拼接。 */
function cleanLine(s) {
  const t = s.trim();
  const box = t.match(/^[-*]\s*\[(.*)\]$/);
  if (box) return box[1].trim();
  return t.replace(/^[-*]?\s*(?:\[[ xX]\]\s*)?[-*\s]*/, "").trim();
}

/** 输出 schema：对象 / 数组（ValueSchemaSpec 要求显式 additionalProperties 与 items）。 */
const OBJ_SCHEMA = { type: "object", additionalProperties: true };
const ARR_SCHEMA = { type: "array", items: { type: "object", additionalProperties: true } };

const createTask = defineTool({
  name: "create_task",
  description:
    "新建一个长期任务（筹划中状态）：在任务库建文件夹 + 10 个存档文档；可选建工作区并复制参考资料（只读）。",
  parameters: {
    name: { type: "string", required: true, description: "任务名（唯一）" },
    goal: { type: "string", required: true, description: "任务目标（写入 goal.md）" },
    refPath: { type: "string", description: "参考资料源路径（可选）；给定则建工作区并复制到 refs/ 并标记只读" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const { id, workspacePath } = await store.createTask(root, args.name, args.goal, args.refPath);
    return { id, name: args.name, status: "planning", workspacePath };
  }
});

const listTasks = defineTool({
  name: "list_tasks",
  description: "列出所有长期任务及其状态（筹划中/进行中/已暂停/已完成）。",
  parameters: {},
  output: { schema: ARR_SCHEMA, render: renderJson },
  async execute() {
    return store.listTasks(store.resolveTasksRoot());
  }
});

const getTask = defineTool({
  name: "get_task",
  description: "读取一个任务的完整存档（meta + 9 个文档）。",
  parameters: {
    name: { type: "string", required: true, description: "任务名" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const docs = {};
    for (const d of ["handoff", "goal", "frozen", "tasklist", "next", "progress", "refs", "index", "errors"]) {
      docs[d] = await store.readDoc(root, t.id, d).catch(() => "");
    }
    return { meta: await store.readMeta(root, t.id), docs };
  }
});

const advanceTask = defineTool({
  name: "advance_task",
  description:
    "推进一个长期任务：加锁（防并发），若筹划中则置为进行中，返回对接文档/目标/任务清单/工作区路径，供本窗口接续推进。",
  parameters: {
    name: { type: "string", required: true, description: "任务名" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args, exec) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const sid = sessionIdOf(exec);
    await lock.acquire(root, t.id, sid);
    await store.writeMeta(root, t.id, { lastSessionId: sid });
    const meta = await store.readMeta(root, t.id);
    if (meta.status === "planning") {
      await store.setStatus(root, t.id, "active");
    }
    const handoff = await store.readDoc(root, t.id, "handoff").catch(() => "");
    return {
      id: t.id,
      name: t.name,
      status: meta.status === "planning" ? "active" : meta.status,
      version: Number(meta.version) || 0,
      workspacePath: meta.workspacePath || join(root, t.id),
      handoff
    };
  }
});

const saveProgress = defineTool({
  name: "save_progress",
  description:
    "存档本次推进：写本次总结(progress)、结构化对接文档(handoff，含审计轨迹)、下次推进内容(next)，可选记录改动文件(filesChanged)/决策(decisions)/卡点(blockers)/错误(errors)/任务清单(tasklist)，版本 +1，释放锁。",
  parameters: {
    name: { type: "string", required: true, description: "任务名" },
    summary: { type: "string", required: true, description: "本次推进总结（写入 progress.md）" },
    nextContent: { type: "string", required: true, description: "下次推进主要内容（写入 next.md 与 handoff.md）" },
    filesChanged: { type: "string", description: "本次改动/产出的文件清单（可选，一行一个，写入 handoff 审计轨迹）" },
    decisions: { type: "string", description: "本次做出的关键决策（可选，写入 handoff 审计轨迹）" },
    blockers: { type: "string", description: "当前卡点/阻塞（可选，追加到 blockers.md 并将任务置为 blocked 状态）" },
    errors: { type: "string", description: "本次推进错误汇总（可选，追加 errors.md）" },
    review: { type: "string", description: "审查发现的问题（可选，追加 review.md，用于待审状态）" },
    tasklist: { type: "string", description: "更新后的推进任务清单（可选，覆盖 tasklist.md，自动统计完成度）" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args, exec) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const curMeta = await store.readMeta(root, t.id);
    const curVersion = Number(curMeta.version) || 0;
    // 审计轨迹写入 progress（历史总结），不塞进 handoff
    let progressBlock = "总结：" + args.summary;
    if (args.filesChanged) {
      progressBlock += "\n改动文件：\n" + args.filesChanged.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).map((l) => "  - " + l).join("\n");
    }
    if (args.decisions) progressBlock += "\n决策：" + args.decisions;
    await store.appendDoc(root, t.id, "progress", progressBlock);
    await store.writeDoc(root, t.id, "next", "# 下次推进主要内容\n\n" + args.nextContent + "\n");
    // 对接文档 = 极简索引（携带各文档完整路径 + 下次一句话，让下一个 AI 按需 read，不通读）
    const base = curMeta.workspacePath || join(root, t.id);
    const docsIndex = [
      ["目标", "goal"], ["冻结事项", "frozen"], ["任务清单", "tasklist"], ["历史总结", "progress"],
      ["参考资料", "refs"], ["工作流目录", "index"], ["错误汇总", "errors"], ["阻塞项", "blockers"], ["审查记录", "review"]
    ].map(([label, doc]) => "- " + label + "：" + join(base, doc + ".md")).join("\n");
    const handoff = [
      "# 对接文档",
      "",
      "## 下次推进",
      args.nextContent,
      "",
      "## 任务档案（按需 read，不要通读）",
      docsIndex,
      ""
    ].join("\n");
    await store.writeDoc(root, t.id, "handoff", handoff);
    if (args.errors) await store.appendDoc(root, t.id, "errors", args.errors);
    if (args.blockers) {
      let cur = await store.readDoc(root, t.id, "blockers").catch(() => "");
      cur = cur.replace(/- \[ （暂无阻塞） \]\n/g, "");
      const items = args.blockers.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      for (const it of items) cur += "- [ " + cleanLine(it) + " ]\n";
      await store.writeDoc(root, t.id, "blockers", cur);
      await store.setStatus(root, t.id, "blocked");
    }
    if (args.review) {
      let cur = await store.readDoc(root, t.id, "review").catch(() => "");
      cur = cur.replace(/- \[ （暂无） \]\n/g, "");
      const items = args.review.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      for (const it of items) cur += "- [ " + cleanLine(it) + " ]\n";
      await store.writeDoc(root, t.id, "review", cur);
    }
    if (args.tasklist) {
      await store.writeDoc(root, t.id, "tasklist", args.tasklist);
      const total = (args.tasklist.match(/^\s*-\s*\[[ x]\]/gm) || []).length;
      const done = (args.tasklist.match(/^\s*-\s*\[x\]/gm) || []).length;
      await store.writeMeta(root, t.id, { taskDone: done, taskTotal: total });
    }
    const version = await store.bumpVersion(root, t.id);
    await store.rebuildIndex(root, t.id, curVersion);
    await lock.release(root, t.id);
    return { ok: true, id: t.id, version, next: args.nextContent };
  }
});

const pauseTask = defineTool({
  name: "pause_task",
  description: "暂停一个任务（置为已暂停并释放锁）。",
  parameters: {
    name: { type: "string", required: true, description: "任务名" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    await store.setStatus(root, t.id, "paused");
    await lock.release(root, t.id);
    return { id: t.id, status: "paused" };
  }
});

const resumeTask = defineTool({
  name: "resume_task",
  description: "恢复一个已暂停/阻塞的任务（置为进行中）。",
  parameters: {
    name: { type: "string", required: true, description: "任务名" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    await store.setStatus(root, t.id, "active");
    return { id: t.id, status: "active" };
  }
});

const completeTask = defineTool({
  name: "complete_task",
  description:
    "完成一个长期任务（置为已完成并释放锁），生成「有价值问题总结 + 归档建议」供模型向用户确认后写入知识库/skill（本工具不自动写入）。",
  parameters: {
    name: { type: "string", required: true, description: "任务名" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const errors = await store.readDoc(root, t.id, "errors").catch(() => "");
    const progress = await store.readDoc(root, t.id, "progress").catch(() => "");
    await store.setStatus(root, t.id, "completed");
    await lock.release(root, t.id);
    const archiveSuggest = {
      task: t.name,
      problems: errors
        .split("\n")
        .filter((l) => l.trim().length > 0 && !l.startsWith("#"))
        .slice(0, 30),
      summaries: progress
        .split("\n")
        .filter((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("##"))
        .slice(0, 30),
      suggestion:
        "请向用户确认后，将以上有价值问题/经验归档到对应 skill（优先 dsh-plugin-development 或按领域新建），条目格式：problem → root cause → fix，并带 provenance。"
    };
    return { id: t.id, status: "completed", archiveSuggest };
  }
});

const deleteTask = defineTool({
  name: "delete_task",
  description: "删除一个长期任务（连同其任务库文件夹，不可恢复）。删除前请向用户确认。",
  parameters: {
    name: { type: "string", required: true, description: "任务名" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    await store.deleteTask(root, t.id);
    return { ok: true, id: t.id, deleted: t.name };
  }
});

export const tools = [
  createTask,
  listTasks,
  getTask,
  advanceTask,
  saveProgress,
  pauseTask,
  resumeTask,
  completeTask,
  deleteTask
];

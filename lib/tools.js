import { defineTool } from "@deepseek-ai/dsh-tools";
import { join } from "node:path";
import * as store from "./store.js";
import * as lock from "./lock.js";

/** 单文档内联上限（字符）：超过就必须分段读，避免一次灌进几十 KB。 */
const DOC_INLINE_GUARD = 8000;

/** 从执行上下文取会话 id（加锁用）。agent.id 即 session id；session.id 为兜底。 */
function sessionIdOf(exec) {
  return exec?.agent?.id ?? exec?.agent?.session?.id ?? process.env.DSH_SESSION_ID ?? "unknown";
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

/** 清洗一行阻塞/审查项：剥掉行首的列表标记 / checkbox / 多余横线。 */
function cleanLine(s) {
  const t = s.trim();
  const box = t.match(/^[-*]\s*\[(.*)\]$/);
  if (box) return box[1].trim();
  return t.replace(/^[-*]?\s*(?:\[[ xX]\]\s*)?[-*\s]*/, "").trim();
}

/** 解析冻结条目文本：一行一条；行首「已定：/口径：/spec:」标记为口径类（spec）。 */
function parseFrozenItems(text, reason = "") {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    let line = raw.trim().replace(/^[-*]\s*/, "").replace(/^\[\s*[xX ]?\s*\]\s*/, "");
    if (!line) continue;
    let kind = "freeze";
    const m = line.match(/^(已定|口径|spec)\s*[:：]\s*/);
    if (m) {
      kind = "spec";
      line = line.slice(m[0].length).trim();
    }
    if (!line) continue;
    out.push({ text: line, kind, reason });
  }
  return out;
}

/** 拆分多行/逗号分隔的路径或文档名列表。 */
function splitList(text) {
  return String(text || "")
    .split(/[\n,，;；]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** 输出 schema：对象 / 数组（ValueSchemaSpec 要求显式 additionalProperties 与 items）。 */
const OBJ_SCHEMA = { type: "object", additionalProperties: true };
const ARR_SCHEMA = { type: "array", items: { type: "object", additionalProperties: true } };
const NAME_PARAM = { type: "string", required: true, description: "任务名（唯一）" };

const createTask = defineTool({
  name: "create_task",
  description:
    "新建长期任务：任务库建 11 个存档文档，产出工作区建 lt-task-NNN-<主题> 文件夹（产出都放这里，返回后请 switch_workspace_root 切过去）。refs 给源路径则拷贝小资料进 refs/ 并置只读，大目录只登记路径。",
  parameters: {
    name: NAME_PARAM,
    goal: { type: "string", required: true, description: "任务目标（写入 goal.md）" },
    refs: { type: "string", description: "参考资料源路径（可选，一行一条）；小文件/小目录拷进 refs/ 并置只读，超 200 文件或 100 MB 的只登记路径" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args, exec) {
    const root = store.resolveTasksRoot();
    const refs = splitList(args.refs);
    const { id, workspacePath } = await store.createTask(root, args.name, args.goal, refs);
    const sid = sessionIdOf(exec);
    if (sid && sid !== "unknown") await store.writeMeta(root, id, { lastSessionId: sid });
    return { id, name: args.name, status: "planning", workspacePath };
  }
});

const listTasks = defineTool({
  name: "list_tasks",
  description: "列出所有长期任务及其状态（筹划中/进行中/已暂停/已阻塞/待审/已完成）。",
  parameters: {},
  output: { schema: ARR_SCHEMA, render: renderJson },
  async execute() {
    return store.listTasks(store.resolveTasksRoot());
  }
});

const getTask = defineTool({
  name: "get_task",
  description:
    "读长期任务档案：默认只回文档清单（名/字节/行数/标题），不吐正文。要正文用 docs 点名（逗号分隔）；单个文档超过 8000 字符必须配 lines:\"120-180\" 或 grep:\"正则\" 分段读，整读会被拒。",
  parameters: {
    name: NAME_PARAM,
    docs: {
      type: "string",
      description: "要正文的文档名，逗号分隔（可选）：handoff goal frozen tasklist next progress refs index errors blockers review"
    },
    lines: { type: "string", description: '行号区间，如 "120-180"（只在点名 1 个文档时可用）' },
    grep: { type: "string", description: "正则，返回命中行与行号（只在点名 1 个文档时可用）" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const stats = await store.docStats(root, t.id);
    const valid = stats.map((s) => s.doc);
    const wanted = splitList(args.docs);
    for (const w of wanted) if (!valid.includes(w)) throw new Error(`未知文档「${w}」。可选：${valid.join("、")}`);
    const meta = await store.readMeta(root, t.id);
    if (!wanted.length) {
      return {
        meta,
        docIndex: stats,
        totalBytes: stats.reduce((s, x) => s + x.bytes, 0),
        hint: "只回清单以省 token。需要正文用 docs 点名；大文档（>8000 字符）必须配 lines 或 grep 分段读。"
      };
    }
    const out = {};
    for (const w of wanted) {
      if (args.grep && wanted.length === 1) {
        out[w] = await store.grepDoc(root, t.id, w, args.grep);
        continue;
      }
      if (args.lines && wanted.length === 1) {
        const m = String(args.lines).match(/^(\d+)\s*[-~到]\s*(\d+)$/);
        if (!m) throw new Error('lines 格式应为 "起始-结束"，如 "120-180"');
        out[w] = await store.readDocSlice(root, t.id, w, m[1], m[2]);
        continue;
      }
      const st = stats.find((s) => s.doc === w);
      if (!st || st.bytes === 0) {
        out[w] = "";
        continue;
      }
      if (st.bytes > DOC_INLINE_GUARD) {
        throw new Error(
          `「${w}」${st.bytes} 字节 / ${st.lines} 行，超过 ${DOC_INLINE_GUARD} 字符内联上限：请用 lines:"a-b" 分段读、用 grep:"正则" 定位，或直接读文件 ${join(root, t.id, w + ".md")}`
        );
      }
      out[w] = await store.readDoc(root, t.id, w);
    }
    return { meta, docs: out, docIndex: stats };
  }
});

const advanceTask = defineTool({
  name: "advance_task",
  description:
    "推进长期任务：加锁、置进行中，并一次返回开工所需全部内容（next 全文、tasklist 全文、冻结清单摘要 frozenDigest、文档规模表、产出路径）。接手窗口读本返回值即可开工，不必再读任何档案文件。",
  parameters: { name: NAME_PARAM },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args, exec) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const sid = sessionIdOf(exec);
    await lock.acquire(root, t.id, sid);
    await store.writeMeta(root, t.id, { lastSessionId: sid });
    let meta = await store.readMeta(root, t.id);
    if (meta.status === "planning") {
      await store.setStatus(root, t.id, "active");
      meta = await store.readMeta(root, t.id);
    }
    const wsDir = meta.workspacePath || join(root, t.id);
    const [next, tasklist, frozenText, stats] = await Promise.all([
      store.readDoc(root, t.id, "next").catch(() => ""),
      store.readDoc(root, t.id, "tasklist").catch(() => ""),
      store.readDoc(root, t.id, "frozen").catch(() => ""),
      store.docStats(root, t.id)
    ]);
    const frozen = store.summarizeFrozen(frozenText, 3000);
    // 回包预算（字节）：收手窗口一次读完就够，超预算就逐级降级冻结摘要 → 任务清单截断 → 清单留空
    const PAYLOAD_BUDGET = 8000;
    const frozenBytes = Buffer.byteLength(frozenText, "utf8");
    const frozenPath = join(root, t.id, "frozen.md");
    let digest = frozen;
    let tasklistOut = tasklist;
    const build = (trimmed) => ({
      id: t.id,
      name: t.name,
      status: meta.status,
      version: Number(meta.version) || 0,
      workspacePath: wsDir,
      lockOwner: sid,
      next,
      tasklist: tasklistOut,
      frozenDigest: digest.text,
      frozen: { bytes: frozenBytes, path: frozenPath, bullets: digest.bulletCount, tables: digest.tableCount, truncated: digest.truncated },
      docIndex: stats,
      payloadBytes: 0,
      trimmed,
      rule: "冻结/已定项禁止改动，确需改先说明并取得用户同意；其余档案按需用 get_task 分段读，禁止整读 progress/index。"
    });
    const sizeOf = (o) => Buffer.byteLength(JSON.stringify(o), "utf8");
    let payload = build(false);
    if (sizeOf(payload) > PAYLOAD_BUDGET) {
      digest = store.summarizeFrozen(frozenText, 1200);
      payload = build(true);
    }
    if (sizeOf(payload) > PAYLOAD_BUDGET) {
      tasklistOut = tasklist.slice(0, 900) + "\n…（截断：全文见 tasklist.md）";
      payload = build(true);
    }
    if (sizeOf(payload) > PAYLOAD_BUDGET) {
      tasklistOut = "";
      payload = build(true);
    }
    payload.payloadBytes = sizeOf({ ...payload, payloadBytes: 0 });
    return payload;
  }
});

const saveProgress = defineTool({
  name: "save_progress",
  description:
    "存档本次推进：写 progress（总结+改动文件+决策）、重写 next、刷新 handoff（自动区含产出路径/开工必读/最近 10 条决策；手写区保留不覆盖），可追加冻结项 frozen、卡点、错误、审查、任务清单，版本 +1 并释放锁。",
  parameters: {
    name: NAME_PARAM,
    summary: { type: "string", required: true, description: "本次推进总结（写入 progress.md）" },
    nextContent: { type: "string", required: true, description: "下次推进主要内容（写入 next.md；handoff 只放指针，不复制全文）" },
    filesChanged: { type: "string", description: "本次改动/产出的文件清单（可选，一行一个）" },
    decisions: { type: "string", description: "本次做出的关键决策（可选，一行一个，累积进 handoff 最近 10 条，全文进 progress）" },
    frozen: { type: "string", description: "本次确认的冻结/口径项（可选，一行一条，追加进 frozen.md；口径类行首加「已定：」）" },
    blockers: { type: "string", description: "当前卡点/阻塞（可选，一行一条，追加 blockers.md 并置为 blocked）" },
    errors: { type: "string", description: "本次推进错误汇总（可选，追加 errors.md）" },
    review: { type: "string", description: "审查发现的问题（可选，追加 review.md）" },
    tasklist: { type: "string", description: "更新后的推进任务清单（可选，覆盖 tasklist.md，自动统计完成度）" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args, exec) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const curMeta = await store.readMeta(root, t.id);
    const wsDir = curMeta.workspacePath || join(root, t.id);
    const doc = (name) => join(root, t.id, name + ".md");

    // 冻结冲突检查（非阻断）：内容里出现冻结触发词就告警，提醒别再重复确认/别擅自改。
    const warnings = [];
    const frozenBefore = await store.readDoc(root, t.id, "frozen").catch(() => "");
    const digest = store.summarizeFrozen(frozenBefore, 3000);
    const payload = [args.summary, args.decisions, args.nextContent, args.tasklist].filter(Boolean).join("\n");
    const ownFrozen = String(args.frozen || "");
    const hit = store.frozenTokens(digest.text).filter((tk) => payload.includes(tk) && !ownFrozen.includes(tk));
    if (hit.length) {
      warnings.push("命中冻结/已定项：" + hit.slice(0, 5).join("、") + "（清单见 " + doc("frozen") + "；确需改动先向用户说明并解冻）");
    }

    let progressBlock = "总结：" + args.summary;
    if (args.filesChanged) {
      progressBlock +=
        "\n改动文件：\n" +
        args.filesChanged
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((l) => "  - " + l)
          .join("\n");
    }
    if (args.decisions) progressBlock += "\n决策：" + args.decisions;
    await store.appendDoc(root, t.id, "progress", progressBlock);
    await store.writeDoc(root, t.id, "next", "# 下次推进主要内容\n\n" + args.nextContent + "\n");

    let frozenResult = { added: [], dup: [] };
    if (args.frozen) frozenResult = await store.appendFrozen(root, t.id, parseFrozenItems(args.frozen));

    // handoff：自动区（工具重写）+ 手写区（保留），决策累积最近 10 条。
    const oldHandoff = await store.readDoc(root, t.id, "handoff").catch(() => "");
    const stamp = new Date().toISOString().slice(0, 10);
    const decisions = store.handoffDecisionsOf(oldHandoff).slice();
    if (args.decisions) {
      for (const d of args.decisions.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const line = "- " + stamp + " " + d;
        if (!decisions.includes(line)) decisions.push(line);
      }
    }
    const keptDecisions = decisions.slice(-10);
    const stats = await store.docStats(root, t.id);
    const sizeOf = (n) => {
      const s = stats.find((x) => x.doc === n);
      return s ? s.bytes + " 字节 / " + s.lines + " 行" : "—";
    };
    const auto = [
      "## 产出工作区（产出文件都放这里）",
      wsDir,
      "",
      "## 开工必读（advance_task 已内联，无需再读文件）",
      "- 下一步：" + doc("next") + "（" + sizeOf("next") + "）",
      "- 任务清单：" + doc("tasklist") + "（" + sizeOf("tasklist") + "）",
      "- 冻结/已定清单：" + doc("frozen") + "（" + sizeOf("frozen") + "；advance_task 返回摘要，改动前按章节定位分段读）",
      "",
      "### 关键决策（累积最近 10 条，全文见 progress.md）",
      ...(keptDecisions.length ? keptDecisions : ["- （暂无）"]),
      "",
      "## 其余档案（按需分段读，禁止整读 progress 与 index）",
      "- 目标 " + doc("goal"),
      "- 历史总结（含审计轨迹） " + doc("progress") + "（" + sizeOf("progress") + "）",
      "- 错误汇总 " + doc("errors"),
      "- 阻塞项 " + doc("blockers"),
      "- 审查记录 " + doc("review"),
      "- 参考资料 " + doc("refs"),
      "- 工作流目录 " + doc("index") + "（" + sizeOf("index") + "）"
    ];
    const handoff = [
      "# 对接文档",
      "",
      store.HANDOFF_BEGIN,
      ...auto,
      store.HANDOFF_END,
      "",
      store.HANDOFF_MANUAL_HEAD,
      store.handoffManualOf(oldHandoff)
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
    await store.rebuildIndex(root, t.id);
    const snap = await store.snapshotVersion(root, t.id, version);
    await lock.release(root, t.id);
    return {
      ok: true,
      id: t.id,
      version,
      workspacePath: wsDir,
      frozenAdded: frozenResult.added,
      snapshot: { mode: snap.mode || "manifest", path: snap.backupPath || "", ok: !!snap.ok, reason: snap.reason || "" },
      warnings
    };
  }
});

const freezeTask = defineTool({
  name: "freeze_task",
  description:
    "冻结已确认事项（追加进 frozen.md，同条目不重复）：此后每次 advance_task 都会带上冻结摘要，禁止再改、禁止当待定项重问。口径/数值类条目行首加「已定：」。",
  parameters: {
    name: NAME_PARAM,
    items: { type: "string", required: true, description: "冻结条目，一行一条；口径/数值类行首加「已定：」" },
    reason: { type: "string", description: "冻结原因（可选，记进条目）" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const res = await store.appendFrozen(root, t.id, parseFrozenItems(args.items, args.reason));
    return { id: t.id, added: res.added, alreadyFrozen: res.dup, path: join(root, t.id, "frozen.md") };
  }
});

const unfreezeTask = defineTool({
  name: "unfreeze_task",
  description: "解除冻结：删除 frozen.md 中含指定文字的条目，返回删除条数。只在用户明确同意后调用。",
  parameters: {
    name: NAME_PARAM,
    match: { type: "string", required: true, description: "要解除的条目文字（子串匹配）" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    const removed = await store.removeFrozen(root, t.id, args.match);
    return { id: t.id, removed, match: args.match };
  }
});

const addRefs = defineTool({
  name: "add_refs",
  description:
    "补/更新参考资料（建任务之后也能用，可反复调用）：小文件或小目录复制进产出区 refs/ 并置只读，复制前自动解除旧只读；超过 200 文件或 100 MB 的目录只登记绝对路径不复制。",
  parameters: {
    name: NAME_PARAM,
    paths: { type: "string", required: true, description: "源路径，一行一条（文件或目录，可多个）" },
    note: { type: "string", description: "备注（可选，记进仅登记清单）" }
  },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    return store.addRefs(root, t.id, splitList(args.paths), args.note || "");
  }
});

const listRefs = defineTool({
  name: "list_refs",
  description: "列出任务的参考资料：refs/ 实际文件（路径 + 字节，最多 200 条）与仅登记未复制的绝对路径。",
  parameters: { name: NAME_PARAM },
  output: { schema: OBJ_SCHEMA, render: renderJson },
  async execute(args) {
    const root = store.resolveTasksRoot();
    const t = await findTask(root, args.name);
    return store.listRefs(root, t.id);
  }
});

const pauseTask = defineTool({
  name: "pause_task",
  description: "暂停一个任务（置为已暂停并释放锁）。",
  parameters: { name: NAME_PARAM },
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
  description: "恢复一个已暂停/已阻塞的任务（置为进行中）。",
  parameters: { name: NAME_PARAM },
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
    "完成一个长期任务（置为已完成并释放锁），返回「有价值问题总结 + 归档建议」（各取最近 15 条，供向用户确认后写入知识库/skill，本工具不自动写入）。",
  parameters: { name: NAME_PARAM },
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
        .slice(0, 15),
      summaries: progress
        .split("\n")
        .filter((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("##"))
        .slice(0, 15),
      suggestion:
        "请向用户确认后，将以上有价值问题/经验归档到对应 skill（优先 dsh-plugin-development 或按领域新建），条目格式：problem → root cause → fix，并带 provenance。"
    };
    return { id: t.id, status: "completed", archiveSuggest };
  }
});

const deleteTask = defineTool({
  name: "delete_task",
  description: "删除一个长期任务（连同任务库文件夹与产出工作区，不可恢复）。删除前请向用户确认。",
  parameters: { name: NAME_PARAM },
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
  freezeTask,
  unfreezeTask,
  addRefs,
  listRefs,
  pauseTask,
  resumeTask,
  completeTask,
  deleteTask
];

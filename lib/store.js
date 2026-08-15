import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile, cp, rm, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { markReadonly } from "./readonly.js";

const execFileAsync = promisify(execFile);

/** 11 个业务文档 + meta（机器元数据）。 */
const DOCS = ["handoff", "goal", "frozen", "tasklist", "next", "progress", "refs", "index", "errors", "blockers", "review"];
const STATUS = new Set(["planning", "active", "paused", "blocked", "review", "completed"]);

const DOC_TEMPLATES = {
  handoff: "# 对接文档\n\n",
  goal: "# 目标\n\n",
  frozen: "# 已确认不可修改列表\n\n",
  tasklist: "# 推进任务清单\n\n",
  next: "# 下次推进主要内容\n\n",
  progress: "# 每次推进总结\n\n",
  refs: "# 参考资料位置及目录\n\n",
  index: "# 完整工作流目录\n\n",
  errors: "# 每次推进错误汇总\n\n",
  blockers: "# 阻塞项\n\n- [ （暂无阻塞） ]\n",
  review: "# 审查记录\n\n## 审查流程\n（待记录：审查人 / 审查内容 / 结论）\n\n## 发现的问题\n- [ （暂无） ]\n"
};

/** 任务库根目录：DSH_LT_TASKS_ROOT 优先，否则 ~/.dsh/lt-tasks。 */
export function resolveTasksRoot() {
  return process.env.DSH_LT_TASKS_ROOT || join(homedir(), ".dsh", "lt-tasks");
}

/** 任务名 → 目录 id：保留 Unicode 字母数字（含中文），其余转 -，小写。 */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "task";
}

/** 解析 meta.md 的 YAML frontmatter（仅 key: value 单行）。 */
function parseMeta(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 渲染 meta.md 的 frontmatter。 */
function renderMeta(meta) {
  const keys = ["id", "name", "status", "version", "createdAt", "updatedAt", "workspacePath", "lastSessionId", "taskDone", "taskTotal"];
  const lines = keys
    .filter((k) => meta[k] !== undefined && meta[k] !== "")
    .map((k) => `${k}: ${meta[k]}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

const DOC_NAMES = new Set([...DOCS, "meta"]);

/** 列出所有任务（扫子目录，读各自 meta.md）。 */
export async function listTasks(root) {
  const out = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = parseMeta(await readFile(join(root, e.name, "meta.md"), "utf8"));
      out.push({
        id: meta.id || e.name,
        name: meta.name || e.name,
        status: meta.status || "planning",
        version: Number(meta.version) || 0,
        updatedAt: meta.updatedAt || "",
        taskDone: Number(meta.taskDone) || 0,
        taskTotal: Number(meta.taskTotal) || 0
      });
    } catch {
      // 跳过无 meta.md 的目录
    }
  }
  return out;
}

export async function readMeta(root, id) {
  return parseMeta(await readFile(join(root, id, "meta.md"), "utf8"));
}

/** 原子写：先写临时文件再 rename 覆盖，避免写入中途崩溃损坏文档。 */
async function atomicWrite(path, content) {
  const tmp = path + ".tmp";
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function writeMeta(root, id, patch) {
  const meta = { ...(await readMeta(root, id)), ...patch, updatedAt: new Date().toISOString() };
  await atomicWrite(join(root, id, "meta.md"), renderMeta(meta));
}

export async function readDoc(root, id, docName) {
  if (!DOC_NAMES.has(docName)) throw new Error(`unknown doc: ${docName}`);
  return readFile(join(root, id, docName + ".md"), "utf8");
}

export async function writeDoc(root, id, docName, content) {
  if (!DOC_NAMES.has(docName)) throw new Error(`unknown doc: ${docName}`);
  await atomicWrite(join(root, id, docName + ".md"), content);
}

/** 向 progress/errors 追加一段，带时间戳。 */
export async function appendDoc(root, id, docName, block) {
  const stamp = new Date().toISOString();
  const cur = await readDoc(root, id, docName).catch(() => "");
  await writeDoc(root, id, docName, cur + `\n## ${stamp}\n${block}\n`);
}

export async function setStatus(root, id, status) {
  if (!STATUS.has(status)) throw new Error(`invalid status: ${status}`);
  await writeMeta(root, id, { status });
}

export async function bumpVersion(root, id) {
  const meta = await readMeta(root, id);
  const v = (Number(meta.version) || 0) + 1;
  await writeMeta(root, id, { version: v });
  return v;
}

/** 递归列出目录下所有文件（绝对路径，排除 .lock）。 */
async function listFilesRecursive(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name !== ".lock") out.push(full);
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

/** 解析 Markdown 文件的标题（# ## ### ...），返回 [{level, title}]。 */
async function parseMdHeadings(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    const out = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        const title = m[2].replace(/#+\s*$/, "").trim();
        if (title) out.push({ level: m[1].length, title });
      }
    }
    return out;
  } catch { return []; }
}

/** 把一个文件的路径 + 内部目录（md 标题）追加到 lines。 */
async function appendFileWithHeadings(lines, filePath, indent) {
  lines.push(indent + "- " + filePath);
  if (filePath.toLowerCase().endsWith(".md")) {
    const headings = await parseMdHeadings(filePath);
    for (const h of headings) {
      lines.push(indent + "    " + "#".repeat(h.level) + " " + h.title);
    }
  }
}

/** 重建完整工作流目录 index.md：工作区根 + 各版本目录下文件路径 + 文档内部目录，最新版本标"当前"。 */
export async function rebuildIndex(root, id, currentVersion) {
  const works = join(root, id, "works");
  const lines = ["# 完整工作流目录", "", "工作区根：" + join(root, id), ""];
  let versions = [];
  try { versions = await readdir(works, { withFileTypes: true }); } catch {}
  for (const v of versions) {
    if (!v.isDirectory() || !v.name.startsWith("v")) continue;
    const vNum = parseInt(v.name.slice(1), 10) || 0;
    const isCurrent = vNum === currentVersion;
    lines.push("## " + v.name + (isCurrent ? "（当前，继续撰写）" : ""), "");
    const files = await listFilesRecursive(join(works, v.name));
    if (files.length === 0) lines.push("（空）");
    else for (const f of files) await appendFileWithHeadings(lines, f, "");
    lines.push("");
  }
  await writeDoc(root, id, "index", lines.join("\n"));
}

/** 重建参考资料目录 refs.md：refs/ 绝对路径 + 文档内部目录。 */
export async function rebuildRefs(root, id) {
  const refs = join(root, id, "refs");
  const lines = ["# 参考资料位置及目录", "", "位置：" + refs, ""];
  const files = await listFilesRecursive(refs);
  if (files.length === 0) lines.push("（无参考资料）");
  else for (const f of files) await appendFileWithHeadings(lines, f, "");
  await writeDoc(root, id, "refs", lines.join("\n"));
}

/** 建工作区：<root>/<id>/works/v1 + <root>/<id>/refs，复制参考资料并只读。 */
export async function setupWorkspace(root, id, refPath) {
  const base = join(root, id);
  const v1 = join(base, "works", "v1");
  const refs = join(base, "refs");
  await mkdir(v1, { recursive: true });
  await mkdir(refs, { recursive: true });
  if (refPath) {
    await cp(refPath, refs, { recursive: true });
    await markReadonly(refs);
  }
  await writeMeta(root, id, { workspacePath: base });
  await rebuildRefs(root, id);
  await rebuildIndex(root, id, 1);
  return base;
}

/** 建任务：文件夹 + 10 文档模板；refPath 给定则建工作区并复制参考资料。 */
export async function createTask(root, name, goal, refPath) {
  await mkdir(root, { recursive: true });
  let id = slugify(name);
  let created = false;
  for (let n = 1; n <= 100; n++) {
    const candidate = n === 1 ? id : slugify(name) + "-" + n;
    try {
      await mkdir(join(root, candidate));
      id = candidate;
      created = true;
      break;
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  if (!created) throw new Error("无法创建任务目录：名称冲突过多");
  const now = new Date().toISOString();
  const meta = { id, name, status: "planning", version: 1, createdAt: now, updatedAt: now, workspacePath: "" };
  await writeFile(join(root, id, "meta.md"), renderMeta(meta), "utf8");
  for (const d of DOCS) {
    await writeFile(join(root, id, d + ".md"), DOC_TEMPLATES[d], "utf8");
  }
  await writeDoc(root, id, "goal", "# 目标\n\n" + goal + "\n");
  let workspacePath = "";
  if (refPath) {
    workspacePath = await setupWorkspace(root, id, refPath);
  }
  return { id, workspacePath };
}

/** 删除任务：先去掉只读属性（refs 可能只读），再递归删除整个任务文件夹。 */
export async function deleteTask(root, id) {
  const dir = join(root, id);
  try {
    await execFileAsync("attrib", ["-R", dir, "/S", "/D"], { windowsHide: true });
  } catch {
    // 目录不存在或无法改属性，忽略
  }
  await rm(dir, { recursive: true, force: true });
}

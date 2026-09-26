import { homedir } from "node:os";
import { join, extname } from "node:path";
import { mkdir, readdir, readFile, writeFile, cp, rm, rename, copyFile, stat } from "node:fs/promises";
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

/** 任务库根目录（存档侧）：DSH_LT_TASKS_ROOT 优先，否则 ~/.dsh/lt-tasks。 */
export function resolveTasksRoot() {
  return process.env.DSH_LT_TASKS_ROOT || join(homedir(), ".dsh", "lt-tasks");
}

/** 产出工作区根目录（桌面侧）：DSH_LT_WS_ROOT 优先，否则 D:\Desktop\DSHlongtasks。 */
export function resolveWorkspaceRoot() {
  return process.env.DSH_LT_WS_ROOT || "D:\\Desktop\\DSHlongtasks";
}

/** 产出文件夹名 lt-task-NNN-<topic>：NNN 为工作区根下已有序号 + 1（与会话文件夹同规则，独立编号）。 */
export async function nextWsFolder(wsRoot, topic) {
  await mkdir(wsRoot, { recursive: true });
  let max = 0;
  let entries;
  try { entries = await readdir(wsRoot, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = /^lt-task-(\d+)-/.exec(e.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const n = String(max + 1).padStart(3, "0");
  return `lt-task-${n}-${topic}`;
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

// 2026-09-18 收束整定：index.md 曾达 2.8 MB / 27548 行（97% 来自 backups 自动快照与编译产物），
// 接手会话若读到它就等于烧掉几十万 token。以下忽略集把 index 压到「只看产出」的规模。
const INDEX_SKIP_DIRS = new Set([
  "backups", "node_modules", ".git", ".svn", "__pycache__", ".vscode", ".idea",
  "build", "build_o0", "build_o1", "build_o2", "build_o3", "Debug", "Release", "CPU1_RAM", "CPU1_FLASH"
]);
const INDEX_SKIP_EXT = new Set([
  ".obj", ".o", ".d", ".map", ".out", ".abs", ".pp", ".exe", ".dll", ".so", ".lib", ".a",
  ".pdb", ".ilk", ".bin", ".hex", ".zip", ".7z", ".rar", ".log", ".tmp", ".lock"
]);

/** 只统计文件数（用于折叠摘要，不列举）。 */
async function countFiles(dir) {
  let n = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else if (e.name !== ".lock") n += 1;
  }
  return n;
}

/** 递归列出目录下所有文件（绝对路径）：跳过 .lock、忽略目录（折叠成摘要）与编译产物后缀。 */
async function listFilesRecursive(dir) {
  const out = [];
  const skippedDirs = [];
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (INDEX_SKIP_DIRS.has(e.name)) {
          skippedDirs.push({ path: full, count: await countFiles(full) });
          continue;
        }
        await walk(full);
      } else if (e.name !== ".lock" && !INDEX_SKIP_EXT.has(extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  out.sort();
  skippedDirs.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, skippedDirs };
}

/** 大 .md（>200 KB）不展开标题，避免索引被单个长文档撑爆。 */
async function isSmallFile(filePath) {
  try { return (await stat(filePath)).size <= 200 * 1024; } catch { return false; }
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
  if (filePath.toLowerCase().endsWith(".md") && (await isSmallFile(filePath))) {
    const headings = await parseMdHeadings(filePath);
    for (const h of headings) {
      lines.push(indent + "    " + "#".repeat(h.level) + " " + h.title);
    }
  }
}

/** 重建参考资料目录 refs.md：产出工作区 refs/ 绝对路径 + 文档内部目录。 */
export async function rebuildRefs(root, id) {
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = meta.workspacePath || "";
  const refs = wsDir ? join(wsDir, "refs") : "";
  const lines = ["# 参考资料位置及目录", "", "位置：" + refs, ""];
  const { files } = refs ? await listFilesRecursive(refs) : { files: [] };
  if (files.length === 0) lines.push("（无参考资料）");
  else for (const f of files) await appendFileWithHeadings(lines, f, "");
  await writeDoc(root, id, "refs", lines.join("\n"));
}

/** 重建完整工作流目录 index.md：产出文件（忽略 backups/编译产物）+ 折叠摘要 + 文档内部目录。 */
export async function rebuildIndex(root, id) {
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = meta.workspacePath || join(root, id);
  const lines = ["# 完整工作流目录", "", "产出工作区：" + wsDir, ""];
  const { files, skippedDirs } = await listFilesRecursive(wsDir);
  if (files.length === 0) lines.push("（工作区暂无文件）");
  else for (const f of files) await appendFileWithHeadings(lines, f, "");
  if (skippedDirs.length > 0) {
    lines.push("", "## 已折叠（不逐个索引，仅记录位置与规模）", "");
    const total = skippedDirs.reduce((s, d) => s + d.count, 0);
    for (const d of skippedDirs) lines.push("- " + d.path + "  （" + d.count + " 个文件）");
    lines.push("", "> 折叠合计 " + total + " 个文件；需要时直接在左侧文件树查看，不要通读本索引。");
  }
  await writeDoc(root, id, "index", lines.join("\n"));
}

/** 建产出工作区：桌面侧 wsDir 已由 createTask 创建，此处补 refs 只读资料并重建索引。 */
export async function setupWorkspace(root, id, refPath) {
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = meta.workspacePath || join(root, id);
  await mkdir(wsDir, { recursive: true });
  if (refPath) {
    const refs = join(wsDir, "refs");
    await mkdir(refs, { recursive: true });
    await cp(refPath, refs, { recursive: true });
    await markReadonly(refs);
  }
  await rebuildRefs(root, id);
  await rebuildIndex(root, id);
  return wsDir;
}

/** 建任务：存档侧 <tasksRoot>/<id>/（11 文档 + meta）；产出侧桌面工作区 lt-task-NNN-<topic>，产出与 refs 均落此处。 */
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
  // 产出侧：桌面工作区 lt-task-NNN-<topic>（独立编号，与会话文件夹同规则）
  // 唯一性创建：非 recursive mkdir 探测，EEXIST 说明并发撞号 → 重扫重试（多窗口并发 create 安全）
  const wsRoot = resolveWorkspaceRoot();
  const topic = (slugify(name) || "task").slice(0, 24);
  let wsDir = "", wsFolder = "";
  for (let n = 1; n <= 100; n++) {
    wsFolder = await nextWsFolder(wsRoot, topic);
    const candidate = join(wsRoot, wsFolder);
    try {
      await mkdir(candidate);
      wsDir = candidate;
      break;
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  if (!wsDir) {
    await rm(join(root, id), { recursive: true, force: true });
    throw new Error("无法创建产出工作区：目录冲突过多");
  }
  await writeMeta(root, id, { workspacePath: wsDir });
  const createdWs = await setupWorkspace(root, id, refPath);
  await snapshotVersion(root, id, 1); // v1 基线快照
  return { id, workspacePath: createdWs, wsFolder };
}

/** 删除任务：先去只读属性，再删存档文件夹 + 桌面产出工作区（双端联动）。 */
export async function deleteTask(root, id) {
  const dir = join(root, id);
  const wsRoot = resolveWorkspaceRoot();
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = (meta.workspacePath || "").startsWith(wsRoot) ? meta.workspacePath : "";
  for (const target of [dir, wsDir]) {
    if (!target) continue;
    try {
      await execFileAsync("attrib", ["-R", target, "/S", "/D"], { windowsHide: true });
    } catch {
      // 目录不存在或无法改属性，忽略
    }
    await rm(target, { recursive: true, force: true });
  }
}

/** 递归复制目录，排除顶层 backups（快照不嵌套）与 .lock。 */
async function cpExcluding(srcRoot, destRoot) {
  await mkdir(destRoot, { recursive: true });
  async function walk(src, dest, isTop) {
    let entries;
    try { entries = await readdir(src, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".lock") continue;
      if (isTop && e.name === "backups") continue;
      const s = join(src, e.name);
      const d = join(dest, e.name);
      if (e.isDirectory()) {
        await mkdir(d, { recursive: true });
        await walk(s, d, false);
      } else {
        await copyFile(s, d);
      }
    }
  }
  await walk(srcRoot, destRoot, true);
}

/**
 * 版本快照（回退备份）：把任务库 11 文档 + meta 与工作区产出（排除 backups 自身）
 * 全量复制到 <工作区>/backups/v<N>/，与版本号一一对应，供随时回退。
 * 结构：backups/v<N>/task-docs/（任务库文档） + backups/v<N>/workspace/（产出快照）。
 * 快照失败不阻断存档，仅返回 { ok:false, reason }。
 */
export async function snapshotVersion(root, id, version) {
  try {
    const meta = await readMeta(root, id).catch(() => ({}));
    const wsDir = meta.workspacePath || "";
    if (!wsDir) return { ok: false, reason: "no workspacePath" };
    const verDir = join(wsDir, "backups", "v" + version);
    const docsDir = join(verDir, "task-docs");
    await mkdir(docsDir, { recursive: true });
    for (const f of [...DOCS, "meta"]) {
      await copyFile(join(root, id, f + ".md"), join(docsDir, f + ".md"));
    }
    await cpExcluding(wsDir, join(verDir, "workspace"));
    return { ok: true, backupPath: verDir, version };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}


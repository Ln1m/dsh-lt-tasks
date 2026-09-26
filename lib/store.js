import { homedir } from "node:os";
import { join, basename, extname } from "node:path";
import { mkdir, readdir, readFile, writeFile, cp, rm, rename, copyFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { markReadonly, unmarkReadonly } from "./readonly.js";

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

export const REFS_AUTO_BEGIN = "<!-- refs:auto:begin -->";
export const REFS_AUTO_END = "<!-- refs:auto:end -->";
export const REFS_MANUAL_HEAD = "<!-- 手写区：工具不覆盖，可自由补充说明 -->";
export const REFS_COPY_MAX_FILES = 200;
export const REFS_COPY_MAX_BYTES = 100 * 1024 * 1024;

/** 取 refs.md 手写区（自动区之外的全部内容）。 */
export function refsManualOf(text) {
  const m = String(text || "").match(/<!--\s*手写区[^>]*-->\s*([\s\S]*)$/);
  return m ? m[1].replace(/^\s*\n/, "").trim() : "";
}

/** 取 refs.md 自动区里保留的「仅登记（未复制）」清单。 */
export function refsRegisteredOf(text) {
  const m = String(text || "").match(/<!-- refs:auto:begin -->([\s\S]*?)<!-- refs:auto:end -->/);
  if (!m) return [];
  const seg = m[1].match(/###\s*仅登记[\s\S]*?(?=\n##|\s*$)/);
  if (!seg) return [];
  return seg[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

/** 把「仅登记」清单写回 refs.md（随后 rebuildRefs 重生成文件清单并保留本清单）。 */
async function writeRegistered(root, id, list) {
  const cur = await readDoc(root, id, "refs").catch(() => DOC_TEMPLATES.refs);
  const manual = refsManualOf(cur);
  const parts = [REFS_AUTO_BEGIN, "## 位置", "（重建中）", ""];
  if (list.length) {
    parts.push("### 仅登记（未复制，按绝对路径使用）");
    for (const r of list) parts.push("- " + r);
    parts.push("");
  }
  parts.push(REFS_AUTO_END, "", REFS_MANUAL_HEAD, manual);
  await writeDoc(root, id, "refs", "# 参考资料位置及目录\n\n" + parts.join("\n"));
}

/** 重建参考资料目录 refs.md：自动区（位置 + 已复制文件 + 仅登记清单）+ 手写区（不覆盖）。 */
export async function rebuildRefs(root, id) {
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = meta.workspacePath || "";
  const refs = wsDir ? join(wsDir, "refs") : "";
  const cur = await readDoc(root, id, "refs").catch(() => DOC_TEMPLATES.refs);
  const manual = refsManualOf(cur);
  const registered = refsRegisteredOf(cur);
  const { files } = refs ? await listFilesRecursive(refs) : { files: [] };
  const auto = [REFS_AUTO_BEGIN, "## 位置", refs || "（未建）", "", "## 已复制（只读）"];
  if (files.length === 0) auto.push("（无）");
  else
    for (const f of files) {
      const rel = refs ? f.slice(refs.length + 1) : f;
      let size = 0;
      try {
        size = (await stat(f)).size;
      } catch {
        // 读不到就只记路径
      }
      auto.push("- " + rel + "  （" + size + " B）");
    }
  if (registered.length) {
    auto.push("", "### 仅登记（未复制，按绝对路径使用）");
    for (const r of registered) auto.push("- " + r);
  }
  auto.push("", REFS_AUTO_END);
  await writeDoc(root, id, "refs", ["# 参考资料位置及目录", "", auto.join("\n"), "", REFS_MANUAL_HEAD, manual].join("\n"));
}

/**
 * 加参考资料：小文件/小目录复制进 refs/ 并置只读；超阈值（200 文件或 100 MB）只登记绝对路径。
 * 复制前先解除 refs/ 只读，复制后重新标记，解决「标记只读后无法再补资料」。
 */
export async function addRefs(root, id, paths, note = "") {
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = meta.workspacePath || join(root, id);
  await mkdir(wsDir, { recursive: true });
  const refs = join(wsDir, "refs");
  await mkdir(refs, { recursive: true });
  const copied = [],
    registered = [],
    failed = [],
    missing = [];
  for (const p of paths || []) {
    const src = String(p || "").trim();
    if (!src) continue;
    let s;
    try {
      s = await stat(src);
    } catch {
      missing.push(src);
      continue;
    }
    let tooBig = false,
      count = 0,
      bytes = 0;
    if (s.isDirectory()) {
      const { files } = await listFilesRecursive(src);
      count = files.length;
      for (const f of files) {
        try {
          bytes += (await stat(f)).size;
        } catch {
          // 跳过读不到的文件
        }
      }
      tooBig = count > REFS_COPY_MAX_FILES || bytes > REFS_COPY_MAX_BYTES;
    } else {
      tooBig = s.size > REFS_COPY_MAX_BYTES;
    }
    if (tooBig) {
      const sizeTxt = s.isDirectory() ? count + " 个文件 / " + Math.round(bytes / 1024) + " KB" : Math.round(s.size / 1024) + " KB";
      registered.push(src + "（" + sizeTxt + "）" + (note ? " —— " + note : ""));
      continue;
    }
    const dest = join(refs, basename(src));
    try {
      await unmarkReadonly(dest);
      await rm(dest, { recursive: true, force: true });
      await cp(src, dest, { recursive: true });
      copied.push(src);
    } catch (err) {
      failed.push(src + "：" + String((err && err.message) || err));
    }
  }
  if (registered.length) {
    const list = refsRegisteredOf(await readDoc(root, id, "refs").catch(() => ""));
    for (const r of registered) if (!list.includes(r)) list.push(r);
    await writeRegistered(root, id, list);
  }
  await markReadonly(refs);
  await rebuildRefs(root, id);
  return { refsPath: refs, copied, registered, failed, missing, limits: { maxFiles: REFS_COPY_MAX_FILES, maxBytes: REFS_COPY_MAX_BYTES } };
}

/** 列出 refs/ 实际文件与仅登记清单（只看清单，不吐正文）。 */
export async function listRefs(root, id) {
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = meta.workspacePath || join(root, id);
  const refs = join(wsDir, "refs");
  const files = [];
  async function walk(d, rel) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) await walk(full, r);
      else {
        let size = 0;
        try {
          size = (await stat(full)).size;
        } catch {
          // 只记路径
        }
        files.push({ path: r, size });
      }
    }
  }
  await walk(refs, "");
  const cur = await readDoc(root, id, "refs").catch(() => "");
  return { refsPath: refs, fileCount: files.length, files: files.slice(0, 200), registered: refsRegisteredOf(cur) };
}

/** 只改 refs.md 手写区（自动区原样保留），供 UI 编辑。 */
export async function writeRefsManual(root, id, content) {
  const cur = await readDoc(root, id, "refs").catch(() => DOC_TEMPLATES.refs);
  const head = cur.match(/^([\s\S]*?<!--\s*手写区[^>]*-->)/);
  const prefix = head ? head[1] : "# 参考资料位置及目录\n\n" + REFS_MANUAL_HEAD;
  await writeDoc(root, id, "refs", prefix + "\n" + String(content || "").trim() + "\n");
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

/** 建产出工作区：桌面侧 wsDir 已由 createTask 创建，此处补参考资料并重建索引。 */
export async function setupWorkspace(root, id, refPath) {
  const meta = await readMeta(root, id).catch(() => ({}));
  const wsDir = meta.workspacePath || join(root, id);
  await mkdir(wsDir, { recursive: true });
  const paths = refPath ? (Array.isArray(refPath) ? refPath : [refPath]) : [];
  if (paths.length) await addRefs(root, id, paths, "");
  else await rebuildRefs(root, id);
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
 * 版本快照（回退备份）：任务库 11 文档 + meta 全量复制；工作区默认只存清单
 * （backups/v<N>/manifest.json：相对路径 / 字节 / 修改时间），不再逐个复制内容。
 * 旧版全量复制导致 acac-hil 49 版占 208 MB。DSH_LT_SNAPSHOT=full 可强制全量。
 * 快照失败不阻断存档，仅返回 { ok:false, reason }。
 */
export async function snapshotVersion(root, id, version) {
  try {
    const meta = await readMeta(root, id).catch(() => ({}));
    const wsDir = meta.workspacePath || "";
    if (!wsDir) return { ok: false, reason: "no workspacePath" };
    const mode = String(process.env.DSH_LT_SNAPSHOT || "manifest").toLowerCase() === "full" ? "full" : "manifest";
    const verDir = join(wsDir, "backups", "v" + version);
    const docsDir = join(verDir, "task-docs");
    await mkdir(docsDir, { recursive: true });
    for (const f of [...DOCS, "meta"]) {
      await copyFile(join(root, id, f + ".md"), join(docsDir, f + ".md"));
    }
    if (mode === "full") {
      await cpExcluding(wsDir, join(verDir, "workspace"));
      return { ok: true, backupPath: verDir, version, mode };
    }
    const { files, skippedDirs } = await listFilesRecursive(wsDir);
    const entries = [];
    let bytes = 0;
    for (const f of files) {
      try {
        const s = await stat(f);
        entries.push({ p: f.slice(wsDir.length + 1), size: s.size, mtime: Math.round(s.mtimeMs) });
        bytes += s.size;
      } catch {
        // 读不到就跳过
      }
    }
    const manifest = {
      mode,
      version,
      at: new Date().toISOString(),
      workspacePath: wsDir,
      fileCount: entries.length,
      bytes,
      skippedDirs: skippedDirs.map((d) => ({ path: d.path, count: d.count })),
      files: entries
    };
    await writeFile(join(verDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    return { ok: true, backupPath: verDir, version, mode, fileCount: entries.length, bytes };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

/** 11 文档名（工具侧校验用）。 */
export function docNames() {
  return [...DOCS];
}

// ── 冻结清单（frozen.md）─────────────────────────────────────────
const FROZEN_BEGIN = "<!-- frozen:begin -->";
const FROZEN_END = "<!-- frozen:end -->";
const FROZEN_HEAD = "## 工具冻结项（freeze_task 维护；本区块勿手改）";

/**
 * 摘要 frozen.md：章节 + 列表条目 + 表格首列（触发词）。cap 按**字节**计（中文 3 字节/字）。
 * 供 advance_task 内联，让接手窗口不读全文也知道哪些已定/禁改，从而不再重复确认。
 */
export function summarizeFrozen(text, cap = 3000) {
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  const heads = [];
  const bullets = [];
  const cells = [];
  const prose = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^<!--/.test(line.trim())) continue;
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      heads.push(h[2].trim());
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const t = line.trim();
      if (/^[-*]\s*\[\s*\]\s*$/.test(t)) continue;
      bullets.push(t.length > 110 ? t.slice(0, 110) + "…" : t);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const t = line.trim();
      if (/^\|[\s:|-]+\|$/.test(t)) continue;
      const first = t.replace(/^\|/, "").split("|")[0].trim();
      if (first) cells.push(first);
      continue;
    }
    if (prose.length < 2 && bytes(line) <= 200) prose.push(line.trim());
  }
  const headLine = heads.length ? "章节：" + heads.join(" ／ ") : "";
  let body = "";
  let dropped = 0;
  for (const b of bullets) {
    if (bytes(headLine + "\n" + body + "\n" + b) > cap) {
      dropped++;
      continue;
    }
    body += (body ? "\n" : "") + b;
  }
  let cellLine = cells.length ? "表项触发词：" + cells.join("、") : "";
  if (bytes(headLine + body + cellLine) > cap) cellLine = "表项触发词：" + cells.length + " 项（未内联：改动前按章节定位 offset 读）";
  const out = [prose.join("\n"), headLine, body, cellLine].filter(Boolean).join("\n");
  return { text: out, bytes: bytes(out), bulletCount: bullets.length, tableCount: cells.length, dropped, truncated: dropped > 0 || /未内联/.test(cellLine) };
}

/** 从冻结摘要抽可校验触发词（反引号标识 / 数值+单位）。 */
export function frozenTokens(summaryText) {
  const src = String(summaryText || "");
  const tokens = new Set();
  for (const m of src.matchAll(/`([^`]{2,40})`/g)) tokens.add(m[1].trim());
  for (const m of src.matchAll(/\b\d+(?:\.\d+)?\s?(?:kHz|MHz|Hz|us|µs|ms|V|A|W|U|%)\b/g)) tokens.add(m[0].replace(/\s+/g, ""));
  return [...tokens].filter((t) => t.length >= 2);
}

/** 追加冻结/已定条目（同条目不重复追加）。追加式写入，绝不重写已有手写内容。 */
export async function appendFrozen(root, id, items) {
  const cur = await readDoc(root, id, "frozen").catch(() => DOC_TEMPLATES.frozen);
  const stamp = new Date().toISOString().slice(0, 10);
  const added = [];
  const dup = [];
  const lines = [];
  for (const it of items || []) {
    const text = String(it.text || "").trim();
    if (!text) continue;
    if (cur.includes(text)) {
      dup.push(text);
      continue;
    }
    const kind = it.kind === "spec" ? "已定" : "禁改";
    lines.push("- [" + kind + "] " + text + (it.reason ? " —— " + it.reason : "") + "（" + stamp + "）");
    added.push(text);
  }
  if (!lines.length) return { added, dup };
  if (cur.includes(FROZEN_BEGIN) && cur.includes(FROZEN_END)) {
    const idx = cur.lastIndexOf(FROZEN_END);
    await writeDoc(root, id, "frozen", cur.slice(0, idx).replace(/\s*$/, "") + "\n" + lines.join("\n") + "\n" + cur.slice(idx));
  } else {
    await writeDoc(root, id, "frozen", [cur.replace(/\s*$/, ""), "", FROZEN_BEGIN, FROZEN_HEAD, ...lines, FROZEN_END, ""].join("\n"));
  }
  return { added, dup };
}

/** 解除冻结：删除含 match 的列表行，返回删除条数。 */
export async function removeFrozen(root, id, match) {
  const needle = String(match || "").trim();
  if (!needle) return 0;
  const cur = await readDoc(root, id, "frozen").catch(() => "");
  const out = [];
  let removed = 0;
  for (const line of cur.split("\n")) {
    if (line.trim().startsWith("- ") && line.includes(needle)) {
      removed++;
      continue;
    }
    out.push(line);
  }
  if (removed) await writeDoc(root, id, "frozen", out.join("\n"));
  return removed;
}

// ── 对接文档（handoff.md：自动区 + 手写区）──────────────────────
export const HANDOFF_BEGIN = "<!-- auto:begin -->";
export const HANDOFF_END = "<!-- auto:end -->";
export const HANDOFF_MANUAL_HEAD = "## 人工补充（工具不覆盖）";
const LEGACY_GENERATED = [
  /^#\s*对接文档/,
  /^##\s*产出工作区/,
  /^##\s*接手先读/,
  /^##\s*其余档案/,
  /^-\s*下一步做什么/,
  /^-\s*任务清单/,
  /^-\s*冻结事项/,
  /^-\s*（读完这 3 个/,
  /^-\s*⛔/,
  /^\s{2}需要时先/,
  /^-\s*(目标|历史总结|错误汇总|阻塞项|审查记录|参考资料|工作流目录)/,
  /^[A-Za-z]:[\\/]/,
  /^<!--/
];
/** 取 handoff 手写区：新格式取 auto:end 之后；旧格式剔除模板行，保留人工补充行。 */
export function handoffManualOf(text) {
  const t = String(text || "");
  const m = t.match(/<!-- auto:end -->([\s\S]*)$/);
  if (m) return m[1].replace(/^\s*\n/, "").trim();
  return t
    .split("\n")
    .filter((l) => l.trim() !== "" && !LEGACY_GENERATED.some((re) => re.test(l)))
    .join("\n")
    .trim();
}
/** 取 handoff 自动区累积的决策行（跨次存档保留）。 */
export function handoffDecisionsOf(text) {
  const m = String(text || "").match(/<!-- auto:begin -->([\s\S]*?)<!-- auto:end -->/);
  if (!m) return [];
  const seg = m[1].match(/###\s*关键决策[\s\S]*?(?=\n#{2,3}\s|$)/);
  if (!seg) return [];
  return seg[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
}

// ── 文档读取（get_task 摘要 / 分段）─────────────────────────────
/** 11 文档 + meta 的规模与标题（供 get_task 摘要，不吐正文）。 */
export async function docStats(root, id) {
  const out = [];
  for (const d of [...DOCS, "meta"]) {
    try {
      const text = await readFile(join(root, id, d + ".md"), "utf8");
      const title = (text.split("\n").find((l) => /^#\s+/.test(l)) || "").replace(/^#\s+/, "").trim();
      out.push({ doc: d, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, title });
    } catch {
      out.push({ doc: d, bytes: 0, lines: 0, title: "" });
    }
  }
  return out;
}

/** 按行号区间读文档（1 基，含端点）。 */
export async function readDocSlice(root, id, docName, from, to) {
  const text = await readDoc(root, id, docName);
  const lines = text.split("\n");
  const a = Math.max(1, Number(from) || 1);
  const b = Math.min(lines.length, Number(to) || a);
  if (b < a) throw new Error(`行号区间无效：${from}-${to}（该文档共 ${lines.length} 行）`);
  return { doc: docName, from: a, to: b, totalLines: lines.length, text: lines.slice(a - 1, b).join("\n") };
}

/** 在文档内按正则检索，返回命中行（带行号）。 */
export async function grepDoc(root, id, docName, pattern, cap = 40) {
  const text = await readDoc(root, id, docName);
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    throw new Error("无效正则：" + pattern);
  }
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < cap; i++) {
    if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].slice(0, 300) });
  }
  return { doc: docName, pattern, hits, totalLines: lines.length, truncated: hits.length >= cap };
}


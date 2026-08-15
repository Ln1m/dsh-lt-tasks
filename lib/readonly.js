import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";

const execFileAsync = promisify(execFile);

/** 标记文件/目录只读（Windows attrib +R，目录递归）。 */
export async function markReadonly(path) {
  const s = await stat(path);
  const args = s.isDirectory() ? ["+R", path, "/S", "/D"] : ["+R", path];
  await execFileAsync("attrib", args, { windowsHide: true });
}

/** 检查是否只读（读属性字符串，判断含 R 标志）。 */
export async function isReadonly(path) {
  try {
    const { stdout } = await execFileAsync("attrib", [path], { windowsHide: true });
    return /^\s*.*\bR\b/.test(stdout);
  } catch {
    return false;
  }
}

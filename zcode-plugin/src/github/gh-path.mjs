// src/github/gh-path.mjs —— gh 可执行文件解析(票 02)。
//
// 顺序照规格:先看环境变量 ZCODE_GH_PATH(绝对路径且文件存在才算),再遍历进程 PATH
// 找 gh.exe(Windows)或 gh(其他平台)。**不探测**常见安装目录,与上游一致。
// 纯函数:只读盘,不起进程、不联网。
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const SCRIPT_EXT = /\.(mjs|js)$/i;
const BATCH_EXT = /\.(cmd|bat)$/i;

/** 按扩展名归档:脚本(.mjs/.js,用当前 node 起)/ Windows 批处理(.cmd/.bat,拒绝)/ 可执行文件。 */
export function kindOf(file) {
  if (SCRIPT_EXT.test(file)) return "script";
  if (BATCH_EXT.test(file)) return "batch";
  return "exe";
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** env 里的 PATH。Windows 上键名大小写不定(PATH/Path 可能并存),逐键找一遍。 */
function pathValue(env) {
  for (const key of Object.keys(env || {})) {
    if (key.toLowerCase() === "path") return env[key];
  }
  return "";
}

/** 解析 gh:{ path, kind } 或 null。kind = script | batch | exe。 */
export function resolveGhPath(env = process.env) {
  const configured = env && typeof env.ZCODE_GH_PATH === "string" ? env.ZCODE_GH_PATH.trim() : "";
  if (configured && isAbsolute(configured) && isFile(configured)) {
    return { path: configured, kind: kindOf(configured) };
  }
  const exe = process.platform === "win32" ? "gh.exe" : "gh";
  for (const entry of String(pathValue(env)).split(delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (isFile(candidate)) return { path: candidate, kind: kindOf(candidate) };
  }
  return null;
}

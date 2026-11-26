// src/github/repo.mjs —— 项目根 → GitHub 仓库短名(票 02)。
//
// 只读本地证据,不出站:tier1 跑 `git -C <root> remote get-url origin`,tier2 读
// <root>/.git/config。tier3(gh repo view)留给票 03 的房间。
//
// 关键口径:**必须锚在项目根自己的 .git 上** —— <root>/.git 不存在直接回 null,
// 绝不让 git 往上找父目录(否则仓库里的测试夹具、普通子目录都会继承父仓的 GitHub 远端,
// 提示位与切换预检全错)。结果按 `.git/config` 的 mtimeMs 缓存:面板每 5 秒问一次,
// 不必反复起 git。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const GIT_TIMEOUT_MS = 3000;

/** git 远程 URL → {owner, name, refId, url}。正则照上游 model/repo.ts;非 GitHub 回 null。 */
export function parseGithubRepo(url) {
  const s = String(url === undefined || url === null ? "" : url).trim();
  const m = s.match(/github\.com[\/:]([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\s*$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], refId: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}` };
}

/** <root>/.git:目录或 worktree 指针文件都算存在;不存在/读不动回 null。 */
function gitDirOf(root) {
  const dotGit = join(root, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return { dir: dotGit, pointer: false };
  if (!st.isFile()) return null;
  let text = "";
  try {
    text = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  return { dir: resolve(root, m[1].trim()), pointer: true };
}

/** 真实 config 路径:普通仓库在 .git/config;worktree 指针顺 gitdir → commondir 找公共 config。 */
function configPathOf(gitDir) {
  if (!gitDir.pointer) {
    const p = join(gitDir.dir, "config");
    return existsSync(p) ? p : null;
  }
  const commonFile = join(gitDir.dir, "commondir");
  if (existsSync(commonFile)) {
    try {
      const rel = readFileSync(commonFile, "utf8").trim();
      const p = resolve(gitDir.dir, rel, "config");
      if (existsSync(p)) return p;
    } catch {}
  }
  const p = join(gitDir.dir, "config");
  return existsSync(p) ? p : null;
}

/** tier1:git 从 PATH 解析,找不到/非零/超时都静默跳过。
 *  GIT_CEILING_DIRECTORIES 把 git 的向上发现挡在项目根的父目录,不继承父仓。 */
function fromGitRemote(root) {
  try {
    const out = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
    });
    return parseGithubRepo(out);
  } catch {
    return null;
  }
}

/** tier2:.git/config 里 [remote "origin"] 段的 url;没有再退任意一行 url =。 */
function fromGitConfig(configPath) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  const section = text.match(/\[remote\s+"origin"\][^[]*url\s*=\s*([^\r\n]+)/);
  const any = text.match(/url\s*=\s*([^\r\n]+)/);
  return parseGithubRepo(section ? section[1] : any ? any[1] : "");
}

const cache = new Map(); // `${root}\u0000${configMtimeMs}` → 结果(命中即不再起 git)

/** 项目根 → 仓库 {owner,name,refId,url} 或 null。只读本地 git 配置,不出站。 */
export function resolveRepoLocal(root) {
  const base = String(root || "");
  if (!base) return null;
  const gitDir = gitDirOf(base);
  if (!gitDir) return null;
  const configPath = configPathOf(gitDir);
  let mtime = 0;
  if (configPath) {
    try {
      mtime = statSync(configPath).mtimeMs;
    } catch {
      mtime = 0;
    }
  }
  const key = `${base}\u0000${mtime}`;
  if (cache.has(key)) return cache.get(key);
  const found = fromGitRemote(base) || (configPath ? fromGitConfig(configPath) : null);
  cache.set(key, found);
  return found;
}

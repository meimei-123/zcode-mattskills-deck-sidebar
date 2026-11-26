// src/github/room.mjs —— GitHub 房间装配(票 03):OpContext、gh 执行器、仓库身份三层兜底、按根缓存。
//
// 房间本身是构建期克隆的 bundle(dist/github-room.mjs,票 01),这里只把房间要的上下文拼出来:
//   platform.path / platform.fs / platform.env / resolveExecutable + exec + timers + logEvent +
//   isEnabled + outbound(五件直通)+ cwd(项目根)+ signal(永不上 Abort 的 controller)。
// 关键契约(design.md E):
//   - exec 非零退出**不抛**,回 {stdout, stderr, code};起不来/超时回 code -1(超时 stderr 带 timeout)。
//   - ZCODE_GH_PATH 解析到 .mjs/.js 时用当前 node 起(.cmd/.bat 拒绝,不走 shell)。
//   - fs.resolve 认第二个参数 {cwd}(房间按工作区根解析 .git/config 等相对路径)。
//   - 日志默认静默,ZCODE_GH_DEBUG=1 才输出;命令行只在房间自己的 gh.exec 里记命令族,这里不记整行。
//   - 仓库身份:先本地两层(repo.mjs),拿不到再让房间走第三层 getRepoKey(含 gh repo view)。
import { statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeFs, makeSubprocess } from "../node-shims.mjs";
import { kindOf, resolveGhPath } from "./gh-path.mjs";
import { resolveRepoLocal } from "./repo.mjs";

const PLUGIN_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOM_BUNDLE = join(PLUGIN_ROOT, "dist", "github-room.mjs");
const DEFAULT_TIMEOUT_MS = 30000;
const GRACE_MS = 2000;
const STDOUT_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_MAX_BYTES = 256 * 1024;

/** 房间 bundle 懒加载一次(进程内缓存)。 */
let roomPromise = null;
export function loadRoom() {
  if (!roomPromise) roomPromise = import(pathToFileURL(ROOM_BUNDLE).href);
  return roomPromise;
}

function debugOn() {
  return String(process.env.ZCODE_GH_DEBUG || "") === "1";
}

/** PATH 里的某个可执行文件(Windows 认 .exe;与 gh-path.mjs 同一口径,只多这一格给 git 用)。 */
function resolveOnPath(name) {
  let raw = "";
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === "path") raw = String(process.env[key] || "");
  }
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of raw.split(delimiter)) {
    const base = dir.trim();
    if (!base) continue;
    for (const file of names) {
      const candidate = join(base, file);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

/** 出站控制面直通五件(单会话单消费者;排队与冷却不搬,形状照契约)。 */
const OUTBOUND = {
  async acquire() {
    return () => {};
  },
  isCancelled() {
    return false;
  },
  noteWrite() {},
  reportTransportFailure() {},
  reportSuccess() {},
};

/** 命令名 → 真正的可执行路径与类别;解析不出来回 {error}。 */
function resolveCommand(cmd) {
  if (cmd === "gh") {
    const hit = resolveGhPath(process.env);
    return hit ? { path: hit.path, kind: hit.kind } : { error: "gh not found: 本机解析不到 gh 可执行文件(没装,或不在 PATH 里,也没设 ZCODE_GH_PATH)" };
  }
  if (cmd === "git") {
    const found = resolveOnPath("git");
    return found ? { path: found, kind: kindOf(found) } : { error: "git not found: PATH 里没有 git" };
  }
  return { path: String(cmd), kind: "exe" };
}

/** 起一条命令并等它结束:非零退出不抛;超时先 SIGTERM 再 SIGKILL(垫片的 terminate),stderr 带 timeout。 */
function runExec(subprocess, cmd, args, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const resolved = resolveCommand(String(cmd));
  if (resolved.error) return Promise.resolve({ stdout: "", stderr: resolved.error, code: -1 });
  if (resolved.kind === "batch") {
    return Promise.resolve({
      stdout: "",
      stderr: `不支持 .cmd/.bat 形式的 gh(${resolved.path}):只支持可直接启动的可执行文件,不走 shell。请指向 gh.exe,或用正版安装包提供的 gh.exe。`,
      code: -1,
    });
  }
  const list = Array.isArray(args) ? args.map(String) : [];
  const argv = resolved.kind === "script" ? [process.execPath, resolved.path, ...list] : [resolved.path, ...list];
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? Math.floor(options.timeout) : DEFAULT_TIMEOUT_MS;
  const cwd = typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : undefined;

  let proc;
  try {
    proc = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: GRACE_MS,
    });
  } catch (e) {
    return Promise.resolve({ stdout: "", stderr: String((e && e.message) || e), code: -1 });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let onAbort = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && options.signal && typeof options.signal.removeEventListener === "function") {
        try {
          options.signal.removeEventListener("abort", onAbort);
        } catch {}
      }
      resolve(result);
    };
    const snapshot = () => ({
      stdout: proc.collected.stdout.finalize().text,
      stderr: proc.collected.stderr.finalize().text,
    });
    proc.done.then(
      ({ exitCode }) => {
        const { stdout, stderr } = snapshot();
        finish({ stdout, stderr, code: typeof exitCode === "number" ? exitCode : -1 });
      },
      (error) => {
        const { stdout, stderr } = snapshot();
        finish({ stdout, stderr: stderr || String((error && error.message) || error), code: -1 });
      }
    );
    timer = setTimeout(() => {
      try {
        proc.terminate();
      } catch {}
      const { stdout, stderr } = snapshot();
      finish({ stdout, stderr: `${stderr}${stderr ? "\n" : ""}gh timeout: 命令在 ${timeout} 毫秒内没有结束,已终止`, code: -1 });
    }, timeout);
    if (timer && typeof timer.unref === "function") timer.unref();
    if (options.signal) {
      const abort = () => {
        try {
          proc.terminate();
        } catch {}
        const { stdout } = snapshot();
        finish({ stdout, stderr: "cancelled", code: -1 });
      };
      if (options.signal.aborted === true) abort();
      else if (typeof options.signal.addEventListener === "function") {
        onAbort = abort;
        try {
          options.signal.addEventListener("abort", abort);
        } catch {}
      }
    }
  });
}

/** 给房间的 OpContext(cwd 固定为项目根;signal 永不中止)。 */
export function makeCtx(root) {
  const cwd = String(root || "");
  const fs = makeFs(cwd);
  const subprocess = makeSubprocess(process.env);
  return {
    platform: {
      path: { join, sep, isAbsolute, dirname, resolve: pathResolve, basename },
      fs,
      resolveExecutable(name) {
        if (name === "gh") {
          const hit = resolveGhPath(process.env);
          return hit ? hit.path : null;
        }
        if (name === "git") return resolveOnPath("git");
        return null;
      },
      // 本仓只认 ZCODE_GH_PATH,不引入第二个旋钮:房间若问 DSH_GH_PATH,如实回「没有」。
      env: {
        get(name) {
          return name === "DSH_GH_PATH" ? undefined : process.env[String(name)];
        },
        has(name) {
          return name !== "DSH_GH_PATH" && process.env[String(name)] !== undefined;
        },
      },
    },
    fs,
    exec(cmd, args, opts) {
      return runExec(subprocess, cmd, args, opts);
    },
    timers: { setTimeout, clearTimeout },
    logEvent(level, event, fields) {
      if (!debugOn()) return;
      try {
        process.stderr.write(`${JSON.stringify({ level, event, ...(fields || {}) })}\n`);
      } catch {}
    },
    isEnabled() {
      return debugOn();
    },
    outbound: OUTBOUND,
    cwd,
    signal: new AbortController().signal,
  };
}

/**
 * 项目根 → {backend,refId,name,url},或 {error}。
 * 先本地两层(repo.mjs,不出站);拿不到再让房间走第三层 getRepoKey(gh repo view)。
 */
export async function repoRefFor(root, ctx) {
  const local = resolveRepoLocal(root);
  if (local) return { backend: "github", refId: local.refId, name: local.refId, url: local.url };
  let key = null;
  try {
    const room = await loadRoom();
    key = await room.getRepoKey(String(root || ""), ctx);
  } catch {
    key = null;
  }
  if (key && key.owner && key.name) {
    const refId = `${key.owner}/${key.name}`;
    return { backend: "github", refId, name: refId, url: `https://github.com/${refId}` };
  }
  return {
    error: {
      kind: "not-found",
      message: `项目根解析不出 GitHub 仓库:${root} 的 origin 没指向 github.com,gh repo view 也没给出仓库`,
      raw: "",
    },
  };
}

// 按项目根缓存房间实例与仓库身份(同一根复用;根变了各自一份)。仓库身份只缓存成功结果,
// 失败不缓存 —— 用户补上远端或登录后,下一次调用应当能自己好起来。
const entries = new Map();

/** 取/建某个项目根的房间实例:{ctx, backend}。 */
export async function backendFor(root) {
  const key = String(root || "");
  const hit = entries.get(key);
  if (hit) return hit;
  const room = await loadRoom();
  const ctx = makeCtx(key);
  const entry = { ctx, backend: room.createGithubBackend(ctx), repoRef: null };
  entries.set(key, entry);
  return entry;
}

/** 房间 + 仓库身份;仓库解析不出来时多带一个 error(读工具据此回人话错误)。 */
export async function roomFor(root) {
  const entry = await backendFor(root);
  if (!entry.repoRef) {
    const ref = await repoRefFor(root, entry.ctx);
    if (ref.error) return { ctx: entry.ctx, backend: entry.backend, repoRef: null, error: ref.error };
    entry.repoRef = ref;
  }
  return { ctx: entry.ctx, backend: entry.backend, repoRef: entry.repoRef, error: null };
}

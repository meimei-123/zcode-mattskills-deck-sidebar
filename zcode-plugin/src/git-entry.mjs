// src/git-entry.mjs —— 版本管理宿主底座:Node 服务垫片 + createGitBridge(工单 01)。
//
// 上游 src/host/versionControl.ts 的 createVersionControl(deps) 要九样宿主能力
// (subprocess / timer / fs / getPlatform / DEFAULT_CWD / TIMEOUT_MS / gate / logCtx / now)。
// 这里按上游调用面的最小形状实现:
//   - subprocess.spawn({argv,cwd,stdio,graceMs,env}) → {done, collected, stdin?, terminate};
//     Node child_process.spawn + shell:false,argv 数组直传(不做任何 shell 拼接);
//     env 里值为 undefined 的键从继承环境删除(上游的墓碑语义);terminate 先 SIGTERM,graceMs 后 SIGKILL。
//   - timer.timeout(ms) → Promise(到点 resolve) 与 clearTimeout(handle);定时器 unref,
//     成功命令留下的竞速定时器不拖住进程退出。
//   - fs.resolve/stat/lstat/exists/readText/writeText/listDir/mkdir/statfs(node:fs/promises;
//     resolve 把相对路径按工作区根归一,其余方法都吃 resolve 的产物或路径)。
//   - gate.noteOutbound() 空操作;logCtx.fire() 默认静默(ZCODE_GIT_DEBUG=1 时 console.debug)。
//   - getPlatform() → { resolveExecutable(name) → name };DEFAULT_CWD = 工作区根;
//     TIMEOUT_MS = VC_RUN_TIMEOUT_MS(生成器产物,值源 config/timeouts.yaml);now = Date.now。
//     另补一项可选依赖 getCacheDir(上游长任务记录要用):默认 os.tmpdir()/zcode-mattpocock-skills-deck/vc-tasks,
//     可用环境变量 ZCODE_VC_TASK_CACHE 指到别处;测试也可用 createGitBridge({cacheDir}) 注入隔离目录。
//     不给它会落进工作区根,测试与用户仓库都不该收这份文件。
//
// createGitBridge 只暴露 createVersionControl() 回包里 handleGit* 派生的方法(handleGitStatus → gitStatus),
// tickets 表与 runGitCommand 一律不暴露。路径边界(args.cwd 与真正的目标路径)必须落在工作区根内。
// 测试可注入 now(模拟票据过期)与 cacheDir(隔离任务记录)。
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVersionControl } from "../../src/host/versionControl.js";
import { VC_RUN_TIMEOUT_MS } from "../../src/shared/time-config/src/values.js";

/** 子进程环境:继承 base,再按上游墓碑语义覆盖(undefined = 删除该键)。 */
function mergeChildEnv(overrides, baseEnv) {
  const env = { ...(baseEnv || process.env) };
  const extra = overrides && typeof overrides === "object" ? overrides : {};
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/** 保留 text 的尾部,使 UTF-8 字节数不超过 maxBytes;截掉头部时返回的字节数只会更小。 */
function tailWithinBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const tail = text.slice(text.length - mid);
    if (Buffer.byteLength(tail, "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(text.length - lo) : "";
}

/**
 * 输出收集器:上游家族读两种形状 —— runGit 读 finalize()(text/truncated),
 * 长任务读 readFrom(offset)(text/nextOffset/lossy) 与 total/bytes(停滞看门狗)。
 * 超过 maxBytes 时保留尾部,置 lossy/truncated;offset 按「从流开头算的字符数」计。
 */
function makeCollector(maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 8 * 1024 * 1024;
  const decoder = new StringDecoder("utf8");
  let text = "";
  let totalChars = 0;
  let droppedChars = 0;
  let totalBytes = 0;

  function append(s) {
    if (!s) return;
    text += s;
    totalChars += s.length;
    if (Buffer.byteLength(text, "utf8") > limit) {
      const before = text.length;
      text = tailWithinBytes(text, limit);
      droppedChars += before - text.length;
    }
  }

  return {
    get total() { return totalBytes; },
    get bytes() { return Buffer.byteLength(text, "utf8"); },
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buf.length;
      append(decoder.write(buf));
    },
    end() {
      append(decoder.end());
    },
    readFrom(offset) {
      const from = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
      const start = Math.max(0, Math.min(text.length, from - droppedChars));
      return { text: text.slice(start), nextOffset: totalChars, lossy: droppedChars > 0 };
    },
    finalize() {
      return { text, truncated: droppedChars > 0 };
    },
  };
}

/** 上游 runGit 的唯一进程出口形状:Node spawn,不用 shell,stdin 默认 ignore。 */
function makeSubprocess(baseEnv) {
  return {
    spawn(request) {
      const req = request || {};
      const argv = Array.isArray(req.argv) ? req.argv.map(String) : [];
      if (argv.length === 0) throw new Error("subprocess.spawn:argv 不能为空");
      const [exe, ...args] = argv;
      const stdio = req.stdio && typeof req.stdio === "object" ? req.stdio : {};
      const stdinMode = stdio.stdin === "pipe" ? "pipe" : "ignore";
      const stdoutLimit = stdio.stdout && typeof stdio.stdout.maxBytes === "number" ? stdio.stdout.maxBytes : 8 * 1024 * 1024;
      const stderrLimit = stdio.stderr && typeof stdio.stderr.maxBytes === "number" ? stdio.stderr.maxBytes : 256 * 1024;
      const child = spawn(exe, args, {
        cwd: typeof req.cwd === "string" && req.cwd !== "" ? req.cwd : undefined,
        env: mergeChildEnv(req.env, baseEnv),
        shell: false,
        stdio: [stdinMode, "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = makeCollector(stdoutLimit);
      const stderr = makeCollector(stderrLimit);
      if (child.stdout) {
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stdout.on("end", () => stdout.end());
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.stderr.on("end", () => stderr.end());
      }
      let settled = false;
      let killed = false;
      const done = new Promise((resolve) => {
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          stdout.end();
          stderr.end();
          resolve({ exitCode: typeof code === "number" ? code : -1, signal: signal || undefined });
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode: -1, signal: "spawn-error", error });
        });
      });
      const graceMs = Number.isFinite(req.graceMs) && req.graceMs >= 0 ? req.graceMs : 10000;
      return {
        done,
        collected: { stdout, stderr },
        stdin: child.stdin || undefined,
        terminate() {
          if (killed) return;
          killed = true;
          try { child.kill("SIGTERM"); } catch {}
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
          }, graceMs);
          if (timer && typeof timer.unref === "function") timer.unref();
        },
      };
    },
  };
}

/** 计时服务:promise 到点 resolve;句柄上挂真实 timer id 供 clearTimeout 用。
 *  timer 一律 unref:它只是「命令超时看门狗」,不该把进程钉住(否则每条 git 命令都会留一个
 *  最长 VC_RUN_TIMEOUT_MS 的未清计时器,命令行跑完还要空等两分钟才退)。 */
function makeTimer() {
  return {
    timeout(ms) {
      const wait = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
      let id;
      const promise = new Promise((resolve) => {
        id = setTimeout(resolve, wait);
        if (id && typeof id.unref === "function") id.unref();
      });
      // 上游把这一条 promise 放进 Promise.race 后不 clearTimeout(成功路径也一样):
      // 不 unref 的话,每条成功命令都会留下一个到点才醒的定时器,把 Node 进程(含测试)无谓地拖住。
      if (id && typeof id.unref === "function") id.unref();
      promise.timer = id;
      return promise;
    },
    clearTimeout(handle) {
      if (handle && typeof handle === "object" && handle.timer !== undefined) clearTimeout(handle.timer);
      else if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/** 文件服务:resolve 归一为绝对路径;其余方法吃 resolve 的产物或普通路径,错误保留 Node 的 code(ENOENT 等)。 */
function makeFs(baseCwd) {
  const abs = (target) => {
    const raw = target && typeof target === "object" && typeof target.path === "string" ? target.path : String(target ?? "");
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseCwd, raw);
  };
  return {
    resolve(target) { return abs(target); },
    async stat(target) { return fsp.stat(abs(target)); },
    async lstat(target) { return fsp.lstat(abs(target)); },
    async exists(target) {
      try {
        await fsp.stat(abs(target));
        return true;
      } catch (e) {
        if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return false;
        throw e;
      }
    },
    async readText(target) { return fsp.readFile(abs(target), "utf8"); },
    async writeText(target, text) { await fsp.writeFile(abs(target), String(text), "utf8"); },
    async listDir(target) { return fsp.readdir(abs(target)); },
    async mkdir(target, opts) {
      return fsp.mkdir(abs(target), opts && typeof opts === "object" ? opts : { recursive: true });
    },
    async statfs(target) {
      if (typeof fsp.statfs !== "function") throw new Error("statfs 在当前 Node 上不可用");
      return fsp.statfs(abs(target));
    },
  };
}

function makeLogCtx(debugOn) {
  return {
    fire(level, event, fields) {
      if (debugOn) console.debug(`[git ${level}] ${event} ${JSON.stringify(fields || {})}`);
    },
  };
}

// 以工作区根为边界的路径判定(target 必须落在 root 内,root 本身算在内)。
function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function boundaryReply(field, value, root) {
  return {
    ok: false,
    error: {
      kind: "boundary",
      message: `路径边界:参数 ${field}(${String(value)})只能在工作区根内(${root})。`,
    },
  };
}

// 真正的目标路径字段(逐条按电话入参实查):克隆目标目录、迁移产物路径、工作树目标路径、平台输出目录、
// 补丁输出目录(gitPatchFiles 的 dir),以及长任务 fast-import 的输入文件(stdinFile.path,内容会进仓库对象)。
// 文件内相对路径类参数(改动页/冲突页的 path、配置 check-attr 的 path)由上游自己的仓库内路径守卫负责,
// 这里不重复拦截,避免误伤普通字符串。
const BOUNDARY_FIELDS = {
  gitCloneCheck: ["dir"],
  gitCloneWrite: ["dir"],
  gitMigrateCheck: ["path", "outputPath", "filePath", "targetPath"],
  gitMigrateWrite: ["path", "outputPath", "filePath", "targetPath"],
  gitWorktreeCheck: ["path", "dest", "dirs"],
  gitWorktreeRun: ["path", "dest", "dirs"],
  gitPlatformCheck: ["dir"],
  gitPlatformRun: ["dir"],
  gitPlatformRead: ["dir"],
  gitPatchFiles: ["dir"],
};

/**
 * 造 bridge:一次装配 versionControl,方法表从 handleGit* 派生。
 * call(method, args) 的失败一律是结构化 {ok:false,error:{kind,message}},不抛给 MCP 层。
 */
export function createGitBridge(opts) {
  const options = opts || {};
  const root = path.resolve(String(options.workspaceRoot || process.cwd()));
  const baseEnv = options.env || process.env;
  const debugOn = String(baseEnv.ZCODE_GIT_DEBUG || process.env.ZCODE_GIT_DEBUG || "") === "1";
  // 长任务记录只落缓存目录(上游 taskStore 按 getCacheDir 写盘);不给这个口时文件会落进工作区根。
  // 优先级:createGitBridge({cacheDir}) 显式注入 > 环境变量 ZCODE_VC_TASK_CACHE > 系统临时目录固定子目录。
  const cacheIn = String(baseEnv.ZCODE_VC_TASK_CACHE || process.env.ZCODE_VC_TASK_CACHE || "");
  const cacheDir = options.cacheDir
    ? path.resolve(String(options.cacheDir))
    : cacheIn
      ? path.resolve(root, cacheIn)
      : path.join(os.tmpdir(), "zcode-mattpocock-skills-deck", "vc-tasks");
  // 时钟与上游 deps.now 同口径:默认 Date.now;测试可注入可控时钟,以便按真实 120 秒票期验证过期拒绝。
  const now = typeof options.now === "function" ? options.now : Date.now;
  const deps = {
    subprocess: makeSubprocess(baseEnv),
    timer: makeTimer(),
    fs: makeFs(root),
    getPlatform: async () => ({ resolveExecutable: async (name) => name }),
    DEFAULT_CWD: root,
    TIMEOUT_MS: VC_RUN_TIMEOUT_MS,
    gate: { noteOutbound() {} },
    logCtx: makeLogCtx(debugOn),
    getCacheDir: () => cacheDir,
    now,
  };
  const vc = createVersionControl(deps);
  const methods = new Map();
  for (const key of Object.keys(vc)) {
    if (!key.startsWith("handleGit")) continue;
    const suffix = key.slice("handle".length); // handleGitStatus → GitStatus
    const method = suffix.charAt(0).toLowerCase() + suffix.slice(1); // → gitStatus
    if (typeof vc[key] === "function") methods.set(method, vc[key]);
  }

  function resolveTarget(field, value, baseCwd) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseCwd, value);
    return insideRoot(root, resolved) ? null : boundaryReply(field, value, root);
  }

  function checkTarget(fields, args, baseCwd) {
    for (const field of fields) {
      const value = args[field];
      const values = Array.isArray(value) ? value : [value];
      for (const one of values) {
        const bad = resolveTarget(field, one, baseCwd);
        if (bad) return bad;
      }
    }
    return null;
  }

  async function call(method, args) {
    const name = typeof method === "string" ? method.trim() : "";
    const fn = methods.get(name);
    if (!fn) {
      return { ok: false, error: { kind: "unknown-method", message: `未知 git 方法:${name || "(空)"}。` } };
    }
    const input = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
    if (input.cwd !== undefined && input.cwd !== null && input.cwd !== "" && typeof input.cwd !== "string") {
      return { ok: false, error: { kind: "bad-args", message: "参数 cwd 必须是工作区根内的路径字符串。" } };
    }
    let baseCwd = root;
    if (typeof input.cwd === "string" && input.cwd.trim() !== "") {
      const resolvedCwd = path.resolve(root, input.cwd);
      if (!insideRoot(root, resolvedCwd)) return boundaryReply("cwd", input.cwd, root);
      input.cwd = resolvedCwd;
      baseCwd = resolvedCwd;
    } else if (input.cwd === undefined || input.cwd === null || input.cwd === "") {
      // 缺省 cwd = 工作区根(与 DEFAULT_CWD 同口径;写电话要求显式 cwd,这里补齐以免同一条工具两种默认)。
      input.cwd = root;
    }
    const badTarget = checkTarget(BOUNDARY_FIELDS[name] || [], input, baseCwd);
    if (badTarget) return badTarget;
    // fast-import 的输入文件是真实路径(内容会进仓库对象):越过工作区根就是一条读盘通道,同样拦住。
    if (input.stdinFile && typeof input.stdinFile === "object") {
      const badStdin = resolveTarget("stdinFile.path", input.stdinFile.path, baseCwd);
      if (badStdin) return badStdin;
    }
    try {
      const result = await fn(input);
      if (result && typeof result === "object") return result;
      return { ok: true, result };
    } catch (e) {
      return {
        ok: false,
        error: { kind: "internal", message: `git 方法 ${name} 执行失败:${(e && e.message) || e}` },
      };
    }
  }

  return {
    workspaceRoot: root,
    methods: Array.from(methods.keys()),
    call,
  };
}

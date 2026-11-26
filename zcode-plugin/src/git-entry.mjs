// src/git-entry.mjs —— 版本管理宿主底座:Node 服务垫片 + createGitBridge(工单 01)。
//
// 上游 src/host/versionControl.ts 的 createVersionControl(deps) 要九样宿主能力
// (subprocess / timer / fs / getPlatform / DEFAULT_CWD / TIMEOUT_MS / gate / logCtx / now)。
// 这里按上游调用面的最小形状实现:
//   - subprocess / timer / fs 三件已提到 src/node-shims.mjs(票 01),口径与注释随函数一起搬了过去;
//     本文件只按上游 deps 的形状装配它们。
//   - gate.noteOutbound() 空操作;logCtx.fire() 默认静默(ZCODE_GIT_DEBUG=1 时 console.debug)。
//   - getPlatform() → { resolveExecutable(name) → name };DEFAULT_CWD = 工作区根;
//     TIMEOUT_MS = VC_RUN_TIMEOUT_MS(生成器产物,值源 config/timeouts.yaml);
//     now = Date.now(options.now 可注入可控时钟);getCacheDir() → 长任务记录目录。
//     getCacheDir 有三个覆盖口,优先级:createGitBridge({cacheDir}) > 环境变量 ZCODE_VC_TASK_CACHE
//     > 默认系统临时目录下按工作区根散列的一格(options.cacheDir 来自 03,环境变量来自 06,合并时都保留)。
//     不提供 getCacheDir 时上游会把任务记录写成相对路径,被 fs 垫片按工作区根归一后落进用户工作区。
//
// createGitBridge 只暴露 createVersionControl() 回包里 handleGit* 派生的方法(handleGitStatus → gitStatus),
// tickets 表与 runGitCommand 一律不暴露。路径边界(args.cwd 与真正的目标路径)必须落在工作区根内。
// 测试可注入 now(模拟票据过期)与 cacheDir(隔离任务记录)。
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVersionControl } from "../../src/host/versionControl.js";
import { VC_RUN_TIMEOUT_MS } from "../../src/shared/time-config/src/values.js";
import { makeFs, makeSubprocess, makeTimer } from "./node-shims.mjs";

function makeLogCtx(debugOn) {
  return {
    fire(level, event, fields) {
      if (debugOn) console.debug(`[git ${level}] ${event} ${JSON.stringify(fields || {})}`);
    },
  };
}

// 以工作区根为边界的路径判定(真实路径版):工作区内的 symlink/junction 可以把词法路径指到根外,
// 所以比对前先把两侧都换成真实路径。判定用精确的「父目录」写法,`..foo` 这种合法目录名不误伤。
function insideRoot(rootReal, targetReal) {
  const rel = path.relative(rootReal, targetReal);
  return rel === "" || !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

/** 存在就 realpath;不存在就向上找最近的已存在祖先做 realpath,再把剩余段拼回去。 */
function realPathOf(target) {
  const abs = path.resolve(target);
  const rest = [];
  let base = abs;
  for (;;) {
    try {
      const real = realpathSync.native(base);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
        const parent = path.dirname(base);
        if (parent === base) return abs;
        rest.push(path.basename(base));
        base = parent;
        continue;
      }
      return abs;
    }
  }
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
// 克隆的 `url` 有意不拦:它可以指工作区外的本地仓,宿主只从那里读对象、不往它写盘;与 stdinFile.path
// 的区别就在这里 —— stdinFile 的内容会写进当前仓库的对象库,所以那条按真实路径拦。
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
  // 根只取一次真实路径(缓存):下面的边界判定都用它,避免每次调用都打一次盘。
  let rootReal = root;
  try {
    rootReal = realpathSync.native(root);
  } catch {
    // 根不可解析(权限/空前缀等):退回词法根,后续目标按 realPathOf 的失败兜底走。
  }
  const baseEnv = options.env || process.env;
  const debugOn = String(baseEnv.ZCODE_GIT_DEBUG || process.env.ZCODE_GIT_DEBUG || "") === "1";
  // 长任务记录只落缓存目录(上游 taskStore 按 getCacheDir 写盘);不给这个口时文件会落进工作区根。
  // 三个覆盖口,优先级:createGitBridge({cacheDir}) 显式注入 > 环境变量 ZCODE_VC_TASK_CACHE
  // > 系统临时目录下按工作区根散列的一格;不同工作区互不串档。
  const cacheIn = String(baseEnv.ZCODE_VC_TASK_CACHE || process.env.ZCODE_VC_TASK_CACHE || "");
  const cacheDir = options.cacheDir
    ? path.resolve(String(options.cacheDir))
    : cacheIn
      ? path.resolve(root, cacheIn)
      : path.join(os.tmpdir(), "zcode-deck-git-cache", createHash("sha256").update(root, "utf8").digest("hex").slice(0, 12));
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
    return insideRoot(rootReal, realPathOf(resolved)) ? null : boundaryReply(field, value, root);
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
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      return { ok: false, error: { kind: "bad-args", message: "args 必须是对象。" } };
    }
    const input = args && typeof args === "object" ? { ...args } : {};
    if (input.cwd !== undefined && input.cwd !== null && input.cwd !== "" && typeof input.cwd !== "string") {
      return { ok: false, error: { kind: "bad-args", message: "参数 cwd 必须是工作区根内的路径字符串。" } };
    }
    let baseCwd = root;
    if (typeof input.cwd === "string" && input.cwd.trim() !== "") {
      const resolvedCwd = path.resolve(root, input.cwd);
      if (!insideRoot(rootReal, realPathOf(resolvedCwd))) return boundaryReply("cwd", input.cwd, root);
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

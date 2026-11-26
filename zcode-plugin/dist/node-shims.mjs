// src/node-shims.mjs —— Node 服务垫片(子进程、计时、文件),版本管理页签与 GitHub 房间共用。
//
// 这三件原先私有在 src/git-entry.mjs 里(工单 01 的实现);票 01 原样提出到本模块,一个字符的
// 行为都不改:两个后端要的是同一套壳,各自在自己入口里装配。注释与口径随函数一起搬了过来。
//   - subprocess.spawn({argv,cwd,stdio,graceMs,env}) → {done, collected, stdin?, terminate};
//     Node child_process.spawn + shell:false,argv 数组直传(不做任何 shell 拼接);
//     env 里值为 undefined 的键从继承环境删除(上游的墓碑语义);terminate 先 SIGTERM,graceMs 后 SIGKILL。
//     与上游 DSH Job 的差异:terminate 只杀直接子进程,不覆盖整棵进程树(git 拉起的钩子/传输助手
//     不会被连带结束);本仓没有 Job 层的进程组回收,这条边界记在 ADR-0002。
//   - timer.timeout(ms) → Promise(到点 resolve) 与 clearTimeout(handle);定时器 unref,
//     成功命令留下的竞速定时器不拖住进程退出。
//   - fs.resolve/stat/lstat/exists/readText/writeText/listDir/mkdir/statfs(node:fs/promises;
//     resolve 把相对路径按工作区根归一,其余方法都吃 resolve 的产物或路径)。
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promises as fsp } from "node:fs";
import path from "node:path";

/** 子进程环境:继承 base,再按上游墓碑语义覆盖(undefined = 删除该键)。 */
export const DEFAULT_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_STDERR_MAX_BYTES = 256 * 1024;

export function mergeChildEnv(overrides, baseEnv) {
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
export function tailWithinBytes(text, maxBytes) {
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
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_STDOUT_MAX_BYTES;
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
export function makeSubprocess(baseEnv) {
  return {
    spawn(request) {
      const req = request || {};
      const argv = Array.isArray(req.argv) ? req.argv.map(String) : [];
      if (argv.length === 0) throw new Error("subprocess.spawn:argv 不能为空");
      const [exe, ...args] = argv;
      const stdio = req.stdio && typeof req.stdio === "object" ? req.stdio : {};
      const stdinMode = stdio.stdin === "pipe" ? "pipe" : "ignore";
      const stdoutLimit = stdio.stdout && typeof stdio.stdout.maxBytes === "number" ? stdio.stdout.maxBytes : DEFAULT_STDOUT_MAX_BYTES;
      const stderrLimit = stdio.stderr && typeof stdio.stderr.maxBytes === "number" ? stdio.stderr.maxBytes : DEFAULT_STDERR_MAX_BYTES;
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
      const done = new Promise((resolve, reject) => {
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          stdout.end();
          stderr.end();
          resolve({ exitCode: typeof code === "number" ? code : -1, signal: signal || undefined });
        });
        // 起不了进程(ENOENT/EACCES 等)必须 reject:上游 runPinned 的 Promise.race catch 分支
        // 回 kind='spawn-failed',failureFromExec 再翻成 error.kind='spawn'(提示确认装了 git)。
        // 早先这里 resolve({exitCode:-1}) 会被上游当成一次普通非零退出,最后误报成 parse 失败。
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
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
export function makeTimer() {
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
      promise.timer = id;
      return promise;
    },
    clearTimeout(handle) {
      if (handle && typeof handle === "object" && handle.timer !== undefined) clearTimeout(handle.timer);
      else if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/** 文件服务:resolve 归一为绝对路径;其余方法吃 resolve 的产物或普通路径,错误保留 Node 的 code(ENOENT 等)。
 *  票 03:resolve 认可选的第二个参数 { cwd }(GitHub 房间按每个工作区根解析相对路径);不传时行为与原来逐字相同。 */
export function makeFs(baseCwd) {
  const abs = (target, opts) => {
    const raw = target && typeof target === "object" && typeof target.path === "string" ? target.path : String(target ?? "");
    const base = opts && typeof opts === "object" && typeof opts.cwd === "string" && opts.cwd ? opts.cwd : baseCwd;
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
  };
  return {
    resolve(target, opts) { return abs(target, opts); },
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

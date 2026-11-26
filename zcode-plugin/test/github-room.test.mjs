// 票 01 缝:GitHub 房间 bundle 的构建产物缝。
// 断言的都是对外可观察的东西:dist 文件在不在、node --check 能不能解析、动态 import 拿到的模块表面。
// 加载这一下必须不联网、不调 gh:本文件不设 ZCODE_GH_PATH、不摆假 gh,只 import 一次再检查表面 ——
// 模块加载期若起进程或发请求,在这道缝上就会暴露成超时/报错。node 直跑,无框架。
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const BUNDLE = join(ROOT, "dist", "github-room.mjs");
const SHIM = join(ROOT, "dist", "github-entry.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// --- 1. 产物存在 ---
check("dist/github-room.mjs 存在(build-github 产物)", existsSync(BUNDLE));
check("dist/github-entry.mjs 一行 shim 存在(与 dist/git-entry.mjs 同款)", existsSync(SHIM));
if (existsSync(SHIM)) {
  const shim = readFileSync(SHIM, "utf8");
  check("shim 标 AUTO-GENERATED", shim.includes("AUTO-GENERATED"), JSON.stringify(shim.slice(0, 80)));
  check('shim 转出 "./github-room.mjs"', shim.includes('export * from "./github-room.mjs"'), JSON.stringify(shim));
}

// --- 2. 产物本体:非空壳、头注释、语法 ---
if (!existsSync(BUNDLE)) {
  check("bundle 可读(供后续断言)", false, BUNDLE);
} else {
  const code = readFileSync(BUNDLE, "utf8");
  // 空壳(比如只打进入口本身)不会有十万字符;上游房间依赖闭包约 87 个文件。
  check("bundle 体积 > 100000 字符(不是空壳)", code.length > 100000, `${code.length} 字符`);
  check("bundle 头注释标 AUTO-GENERATED", code.startsWith("// AUTO-GENERATED"), JSON.stringify(code.slice(0, 80)));
  // 头注释要写清两条解析规则(相对 .js → 同名 .ts;时间参数 → 生成器产物),换人接手时查得到。
  check("头注释登记 .js → 同名 .ts 解析规则", code.slice(0, 2000).includes(".ts"), JSON.stringify(code.slice(0, 200)));
  check("头注释登记时间参数生成器产物", code.slice(0, 2000).includes("time-config"), JSON.stringify(code.slice(0, 200)));

  // 语法门禁:按 ESM 解析(node --check 对 .mjs 按模块解析),只解析不执行。
  const syntax = spawnSync(process.execPath, ["--check", BUNDLE], { encoding: "utf8" });
  check(
    "node --check 通过",
    syntax.status === 0,
    String((syntax.stderr || syntax.stdout || "").trim()).slice(0, 500)
  );

  // --- 3. 房间对外成员:动态 import 一次,只读表面 ---
  // 本进程里不指 gh:清掉外部可能带进来的 ZCODE_GH_PATH,也不摆假 gh —— 加载若起进程或联网,
  // 这道缝上就会暴露成超时/报错。
  delete process.env.ZCODE_GH_PATH;

  let mod = null;
  try {
    mod = await import(pathToFileURL(BUNDLE).href);
  } catch (e) {
    check("动态 import 成功(加载不联网、不调 gh)", false, (e && e.message) || String(e));
  }
  if (mod) {
    check("动态 import 成功(加载不联网、不调 gh)", true);

    // 工厂与判定:调用面是函数。
    for (const name of [
      "createGithubBackend",
      "githubMatches",
      "describe",
      "issueAddress",
      "repoSearchAddress",
      "parseGithubRepo",
      "getRepoKey",
      "initProject",
    ]) {
      check(`成员 ${name} 导出且是函数`, typeof mod[name] === "function", typeof mod[name]);
    }
    // 数据面:对象字面量。
    for (const name of ["githubModule", "links", "capabilities", "fixes", "prompts"]) {
      check(`成员 ${name} 导出且是对象`, !!mod[name] && typeof mod[name] === "object", typeof mod[name]);
    }
    check("issueRefPattern 是正则", mod.issueRefPattern instanceof RegExp, String(mod.issueRefPattern));
    check('openRepository 是 "url"(开仓交给浏览器)', mod.openRepository === "url", String(mod.openRepository));

    // 模块对象:注册表读的就是它。
    check('githubModule.id === "github"', mod.githubModule?.id === "github", String(mod.githubModule?.id));
    check('githubModule.label === "GitHub"', mod.githubModule?.label === "GitHub", String(mod.githubModule?.label));

    // 检查表:目录投影,非空数组。
    check(
      "GITHUB_CHECKS 是非空数组",
      Array.isArray(mod.GITHUB_CHECKS) && mod.GITHUB_CHECKS.length > 0,
      JSON.stringify(mod.GITHUB_CHECKS?.length)
    );
  }
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

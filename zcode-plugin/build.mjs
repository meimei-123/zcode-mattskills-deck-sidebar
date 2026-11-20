// 构建脚本:src/ → dist/。零依赖直拷;面板脚本只有上游 bundle 一份——
// src/ui 的 BUNDLE_PARTS 拼装随旧 ms-* UI 层退役(U06),产物是 dist/ui/bundle-1.txt
// (esbuild IIFE,机制见 build-upstream.mjs;资源通道只搬文本,.txt 后缀避开任何按
// 扩展名的脚本处理,ui-host.md)。用法:node build.mjs
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

if (!existsSync(SRC)) {
  console.error("src/ 不存在,无事可构建");
  process.exit(1);
}
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(SRC, DIST, { recursive: true });
console.log("built dist/ from src/");
// 工单 U01:上游面板壳 bundle(splice 拼接上游叶子 + Preact,机制见 build-upstream.mjs;
// esbuild/preact 是构建依赖,先 npm install)。构建依赖缺失时明确报因,不静默跳过。
try {
  await import("./build-upstream.mjs").then((m) => m.buildUpstreamBundle());
} catch (e) {
  console.error("[build] 上游 bundle 构建失败:" + ((e && e.message) || e) + "(先在 zcode-plugin/ 跑 npm install?)");
  throw e;
}
// 工单 01:版本管理宿主底座 bundle(上游 vc 家族 + Node 垫片;机制见 build-git.mjs)。
// 放在上游 bundle 之后:时间参数生成器镜像由 buildUpstreamBundle 先就位(缺失时 build-git 会自己补跑)。
try {
  await import("./build-git.mjs").then((m) => m.buildGitBundle());
} catch (e) {
  console.error("[build] git bundle 构建失败:" + ((e && e.message) || e));
  throw e;
}

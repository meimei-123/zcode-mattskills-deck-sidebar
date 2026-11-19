// 构建脚本:src/ → dist/。零依赖直拷 + 一处换名:src/ui/app.js 是 bundle 的源
// (纯脚本无 import),按资源白名单命名约定拷成 dist/ui/bundle-0.txt——资源通道只搬
// 文本,.txt 后缀避开任何按扩展名的脚本处理(ui-host.md)。后续工单引入上游 TS 视图层时,
// 在此换 esbuild 拼接(ADR-0002),dist 布局不变。用法:node build.mjs
import { cpSync, mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
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
renameSync(join(DIST, "ui", "app.js"), join(DIST, "ui", "bundle-0.txt"));
console.log("built dist/ from src/ (src/ui/app.js -> dist/ui/bundle-0.txt)");

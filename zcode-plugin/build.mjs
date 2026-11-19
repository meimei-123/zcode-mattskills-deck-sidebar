// 构建脚本:src/ → dist/。零依赖直拷 + bundle 拼接:src/ui/ 的 cards.mjs(像素卡纯函数,
// 纯脚本 IIFE 挂 globalThis)在前、app.js(面板应用)在后,拼成 dist/ui/bundle-0.txt——
// 资源通道只搬文本,.txt 后缀避开任何按扩展名的脚本处理(ui-host.md);dist 里不再
// 单独放 app.js。后续工单引入上游 TS 视图层时,在此换 esbuild 拼接(ADR-0002),dist
// 布局不变。用法:node build.mjs
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, rmSync as rmFile } from "node:fs";
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
const bundleParts = [readFileSync(join(SRC, "ui", "cards.mjs"), "utf8"), readFileSync(join(SRC, "ui", "app.js"), "utf8")];
writeFileSync(join(DIST, "ui", "bundle-0.txt"), bundleParts.join("\n"));
// app.js / cards.mjs 已拼进 bundle,dist 里不留单份(资源白名单也不含它们)
rmFile(join(DIST, "ui", "app.js"), { force: true });
rmFile(join(DIST, "ui", "cards.mjs"), { force: true });
console.log("built dist/ from src/ (cards.mjs + app.js -> dist/ui/bundle-0.txt)");

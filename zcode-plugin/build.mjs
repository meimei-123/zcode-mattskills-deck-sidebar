// 构建脚本:src/ → dist/。零依赖直拷 + 一处拼包:src/ui 的 BUNDLE_PARTS(纯脚本无 import)
// 按序拼成 dist/ui/bundle-0.txt——资源通道只搬文本,.txt 后缀避开任何按扩展名的脚本处理
// (ui-host.md)。后续工单引入上游 TS 视图层时,在此换 esbuild 拼接(ADR-0002),dist 布局不变。
// 用法:node build.mjs
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
// bundle 段序:app.js(应用入口/列表)在前,detail.mjs(工单 05 详情视图)在后;
// 段间只有运行时调用(window.MattSkillsDetail),无加载期引用,顺序仅作约定。
const BUNDLE_PARTS = ["app.js", "detail.mjs"];

if (!existsSync(SRC)) {
  console.error("src/ 不存在,无事可构建");
  process.exit(1);
}
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(SRC, DIST, { recursive: true });
const parts = BUNDLE_PARTS.map((f) => readFileSync(join(SRC, "ui", f), "utf8"));
writeFileSync(join(DIST, "ui", "bundle-0.txt"), parts.join("\n"));
for (const f of BUNDLE_PARTS) rmSync(join(DIST, "ui", f), { force: true }); // 段文件不散落 dist
console.log(`built dist/ from src/ (${BUNDLE_PARTS.join("+")} -> dist/ui/bundle-0.txt)`);

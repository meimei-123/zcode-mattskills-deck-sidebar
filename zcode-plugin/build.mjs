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
// bundle 段序:copy.mjs(工单 09 文案表,挂 globalThis.MattSkillsCopy)在最前——后续
// 段求值期都读它;cards.mjs(像素卡纯函数,挂 globalThis)随后——app.js 求值期读
// globalThis.MattSkillsCards;actions.mjs(工单 07 动作域纯函数,挂 globalThis)随后;
// app.js(应用入口/列表)居中;detail.mjs(工单 05 详情视图,工单 07 起含动作栏)在后。
// app.js 与 detail.mjs 段间只有运行时调用(window.MattSkillsDetail),无加载期引用;
// writer.mjs(工单 06 写入口)最后,detail.open 运行时才经 window.MattSkillsWriter 调它。
const BUNDLE_PARTS = ["copy.mjs", "cards.mjs", "actions.mjs", "app.js", "detail.mjs", "writer.mjs"];

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

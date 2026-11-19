// 构建脚本:src/ → dist/。骨架期零依赖直拷;后续工单引入上游 TS 视图层时,
// 在此换 esbuild 拼接(ADR-0002),dist 布局不变。用法:node build.mjs
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

// build-upstream.mjs —— 上游 client 骨架 tracer 的拼接构建(工单 U01,ADR-0002 修订)。
//
// 机制照上游 scripts/build.mts 的 splice 约定(上游只读,不改):
//   上游 src/client/index.ts 的 apply 骨架里留 `// ==== <kind>:<name> (spliced by build) ====`
//   标记(次序即声明次序);构建把叶子真源(.ts,可剥离 TypeScript)按全仓唯一转译口径
//   变成 JavaScript、改回行首 export、剥掉行首 export,拼进我们骨架的同名标记处 ——
//   单一函数作用域,裸名共享(与上游一致)。kernel:ctx 同上游 wireCtx:apply 头部注入,
//   不走标记。
//   我们的骨架(src/ui/upstream/entry.mjs)是 index.ts 的裁剪段:只保留本票需要的标记,
//   标记之间的装配段由本仓自己写(后续工单往 LEAVES 加叶子、往骨架加标记即可)。
//   标记序对着上游 index.ts 校验(骨架标记必须是上游标记序的保序子序列)——防手滑把
//   声明次序排错(const 暂时性死区:styles 求值时就要读 MOTION/CONTAINER_ACCENT)。
//
// 产物:dist/ui/bundle-1.txt(esbuild IIFE,Preact + preact/compat 一并打进 bundle;
// 资源通道只搬文本,产物不得含模块级 import/export)。用法:node build-upstream.mjs
// (node build.mjs 会在末尾自动调它)。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as esbuild from "esbuild";

const ROOT = dirname(fileURLToPath(import.meta.url)); // zcode-plugin/
// 上游真源:同仓 worktree 的仓库根(zcode-plugin 的上一级),只读。可用 UPSTREAM_ROOT 覆盖。
const UPSTREAM_ROOT = resolve(ROOT, process.env.UPSTREAM_ROOT || "..");
const UPSTREAM_INDEX = join(UPSTREAM_ROOT, "src", "client", "index.ts");

// 转译口径与上游 TRANSPILE_OPTIONS 一字不差(transpile-unit.mts:参数只有这一份,产物
// 字节形态全部由它决定,两处各写一份就会产出两种字节)。
export const TRANSPILE_OPTIONS = Object.freeze({
  loader: "ts",
  format: "esm",
  target: "es2020",
  charset: "utf8",
});

// ---------------------------------------------------------------------------
// 纯函数段(上游 scripts/lib/transpile-unit.mts 移植;测试直打这些函数)
// ---------------------------------------------------------------------------

/** 拼接标记:`// ==== leaf:hostShim (spliced by build) ====`(kind: leaf/kernel/shared)。 */
export const MARKER_RE = /\/\/ ==== (leaf|kernel|shared):([\w.$-]+) \(spliced by build\) ====/g;

/** 按出现序提出标记(id 形如 "leaf:hostShim";同行连写多个标记按字符位排序,天然正确)。 */
export function parseMarkers(text) {
  const out = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) out.push({ id: `${m[1]}:${m[2]}`, index: m.index });
  return out;
}

/** ordered 是否为 full 的保序子序列(可跳项,不可乱序)。 */
export function isSubsequenceOf(ordered, full) {
  let i = 0;
  for (const x of full) {
    if (i < ordered.length && ordered[i] === x) i++;
  }
  return i === ordered.length;
}

/** 把一段文本里「不是代码」的部分涂成等长空格(字符串/模板串/行注释/块注释)。
 *  逐行判据只看代码:注释里举例写的 `import x` 不算模块写法(上游 #1207)。 */
function maskNonCodeText(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < text.length) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out.push(" ");
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          out.push(" ", " ");
          i += 2;
          continue;
        }
        if (c === "\n") {
          if (quote !== "`") break; // 单双引号串里换行 = 本就不是合法 JS,涂到这里为止
          out.push("\n");
          i++;
          continue;
        }
        if (c === quote) {
          out.push(" ");
          i++;
          break;
        }
        out.push(" ");
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/** 找「改不动的模块写法」:export {…} / export * from / export default。 */
function findUnfixableModuleForm(code) {
  return /^[^\S\r\n]*export\s*(\{|\*|default\b)/m.exec(maskNonCodeText(code));
}

function lineAt(text, index) {
  const end = text.indexOf("\n", index);
  return text.slice(index, end < 0 ? text.length : end).trim();
}

/**
 * 把 esbuild 收在文件末尾的导出块改写成声明前的行首 export(上游 inlineExportDeclarations
 * 原样移植)。esbuild transform 的产物是「声明在前 + 末尾 export {…} 块」,剥行首 export
 * 的拼接规则吃不了末尾块;名字在文件里找不到声明时报错,绝不静默少导出。
 */
export function inlineExportDeclarations(code, prefix) {
  const clause = /(^|\n)export \{\n([\s\S]*?)\n\};\n?$/.exec(code);
  if (!clause) {
    if (/(^|\n)export \{/.test(code)) {
      throw new Error(`${prefix} 转译结果里出现了没有预料到的导出块写法,拒绝改写:\n` + code.slice(-300));
    }
    return code;
  }
  const names = clause[2]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  let body = code.slice(0, clause.index) + (clause[1] === "\n" ? "\n" : "");
  for (const name of names) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new Error(`${prefix} 导出块里有改不了名的条目「${name}」:本步骤只支持原样导出,不支持 as 改名`);
    }
    const decl = new RegExp(
      "^(?:async )?function " + name + "\\b|^(?:const|let|var) " + name + "\\b|^class " + name + "\\b",
      "m"
    );
    const hit = decl.exec(body);
    if (!hit) {
      throw new Error(`${prefix} 导出块里的名字「${name}」在这份文件里找不到声明,拒绝生成少一个导出的产物`);
    }
    body = body.slice(0, hit.index) + "export " + body.slice(hit.index);
  }
  return body;
}

/**
 * 把一段(已是 JavaScript 的)源码整成「可拼进闭包」的形态:剥行首 export、首尾空白去掉。
 * 两条防静默拼错判据与上游 toSpliceableFragment 同源:改不动的模块写法当场报、
 * 剥完仍留模块级 import/export 当场报(判据看涂掉字符串注释后的文本)。
 */
export function toSpliceableFragment(code, { source }) {
  const hit = findUnfixableModuleForm(code);
  if (hit) {
    throw new Error(
      `片段 ${source} 里是模块导出写法「${lineAt(code, hit.index)}」:拼进闭包的片段只能写 ` +
        "`export <声明>` 这种行首形式,`export {…}` / `export * from` / `export default` 去掉 export 之后不是合法语句。"
    );
  }
  const stripped = code
    .split("\n")
    .map((line) => line.replace(/^(\s*)export\s+/, "$1"))
    .join("\n")
    .trim();
  const leftover = /^[^\S\r\n]*(?:import|export)[\s.{"'*]/m.exec(maskNonCodeText(stripped));
  if (leftover) {
    throw new Error(
      `片段 ${source} 在拼接前还留着模块级写法「${lineAt(stripped, leftover.index)}」:` +
        "拼接点吃的是 JavaScript 文本,.ts 片段必须先按全仓唯一转译口径(TRANSPILE_OPTIONS 加 inlineExportDeclarations)转成 JavaScript 再拼。"
    );
  }
  return stripped;
}

/**
 * 一份 .ts 叶子真源 → 可拼进闭包的 JavaScript 文本(转译 + 改回行首 export + 剥 export +
 * 保证以换行收尾)。收尾换行与上游 spliceText 同因:标记有同行连写,片段末尾不带换行会把
 * 下一个片段的头一行吃进上一条的行尾注释里。
 */
export function stripTsToSpliceable(tsCode, { source }) {
  const transformed = esbuild.transformSync(tsCode, TRANSPILE_OPTIONS).code;
  const frag = toSpliceableFragment(inlineExportDeclarations(transformed, source), { source });
  return /\n$/.test(frag) ? frag : frag + "\n";
}

// ---------------------------------------------------------------------------
// 拼接管线:叶子清单(后续工单往这里加)+ 骨架标记序校验 + 拼接
// ---------------------------------------------------------------------------

/** 本票叶子清单:骨架必需(hostShim + ctx 骨架 + 样式注入点及其求值序前置)。
 *  id 即上游 index.ts 的标记名;file 相对上游仓库根。kernel:ctx 不在此列 ——
 *  它与上游 wireCtx 同位:apply 头部注入,不走标记。 */
export const LEAVES = [
  { id: "leaf:hostShim", file: "src/client/hostShim.ts" },
  { id: "kernel:containerView", file: "src/client/kernel/container-view.ts" },
  { id: "kernel:motion", file: "src/client/kernel/motion.ts" },
  { id: "kernel:styles", file: "src/client/kernel/styles.ts" },
];
const CTX_BLOCK_FILE = "src/client/kernel/ctx.ts";

const readUpstream = (rel) => readFileSync(join(UPSTREAM_ROOT, ...rel.split("/")), "utf8");

/** 上游 index.ts 的标记序(缓存;解析失败即构建错)。 */
let upstreamOrderCache = null;
export function upstreamMarkerOrder() {
  if (upstreamOrderCache) return upstreamOrderCache;
  const text = readFileSync(UPSTREAM_INDEX, "utf8");
  upstreamOrderCache = parseMarkers(text).map((m) => m.id);
  return upstreamOrderCache;
}

/**
 * 把骨架文本拼成完整 apply 闭包:标记换叶子、apply 头注入 kernel:ctx、版本占位符注入。
 * 三道对账(缺一即抛,与上游 wireModules 同语义):
 *   ① 骨架标记必须都在上游 index.ts 标记序里,且相对次序是上游的保序子序列;
 *   ② LEAVES 里每个叶子都必须在骨架留了标记;
 *   ③ 骨架里每个 leaf:/kernel: 标记都必须在 LEAVES 登记(shared: 标记本票未用,同规则留给后续)。
 */
export function spliceSkeleton(skeletonText) {
  const upstreamOrder = upstreamMarkerOrder();
  const skelMarkers = parseMarkers(skeletonText).map((m) => m.id);
  for (const id of skelMarkers) {
    if (!upstreamOrder.includes(id)) {
      throw new Error(`[build-upstream] 骨架标记 ${id} 不在上游 index.ts 的标记序里 —— 标记名与上游对齐,自定义段不许挂标记`);
    }
  }
  if (!isSubsequenceOf(skelMarkers, upstreamOrder)) {
    throw new Error(
      `[build-upstream] 骨架标记序 ${skelMarkers.join(" → ")} 不是上游 index.ts 标记序的保序子序列 —— ` +
        "声明次序错会撞 const 暂时性死区(styles 求值时就要读 MOTION/CONTAINER_ACCENT),按上游次序排"
    );
  }
  const leafIds = LEAVES.map((l) => l.id);
  const unregistered = skelMarkers.filter((id) => !leafIds.includes(id));
  if (unregistered.length) {
    throw new Error(`[build-upstream] 骨架标记 ${unregistered.join(",")} 未在 LEAVES 登记 — 新加叶子需在 LEAVES 加一项并在骨架留标记`);
  }
  const missingMarker = leafIds.filter((id) => !skelMarkers.includes(id));
  if (missingMarker.length) {
    throw new Error(`[build-upstream] LEAVES 登记了 ${missingMarker.join(",")} 但骨架没留标记 — 双向对账,两边一起改`);
  }

  let out = skeletonText;
  for (const leaf of LEAVES) {
    const marker = `// ==== ${leaf.id} (spliced by build) ====`;
    if (out.indexOf(marker) < 0) throw new Error(`[build-upstream] 缺 marker ${marker} 对应 ${leaf.file}`);
    out = out.replace(marker, () => stripTsToSpliceable(readUpstream(leaf.file), { source: leaf.file }));
  }
  // kernel:ctx 注入(上游 wireCtx 同位同法):apply(ctx…) { 之后
  const m = out.match(/apply\(ctx(?::[^)]*)?\) \{/);
  if (!m || m.index === undefined) {
    throw new Error("[build-upstream] 骨架找不到 apply(ctx) { 注入点(kernel:ctx 接线失败)");
  }
  const end = m.index + m[0].length;
  const ctxBlock = stripTsToSpliceable(readUpstream(CTX_BLOCK_FILE), { source: CTX_BLOCK_FILE });
  out = out.slice(0, end) + "\n" + ctxBlock + "\n" + out.slice(end);

  // 版本占位符(上游 injectVersion 同款):本票叶子没引用,机制就位,后续叶子接手即用
  const version = JSON.parse(readFileSync(join(ROOT, ".zcode-plugin", "plugin.json"), "utf8")).version;
  return out
    .split("__DSW_VERSION__")
    .join(`'v${version}-zcode'`)
    .split("__DSW_REPO_URL__")
    .join("'unknown'")
    .split("__DSW_BUILD_COMMIT__")
    .join("'unknown'");
}

// ---------------------------------------------------------------------------
// 产物:拼接骨架 → esbuild bundle(Preact + preact/compat 打进 IIFE)→ dist/ui/bundle-1.txt
// ---------------------------------------------------------------------------
const SKELETON = join(ROOT, "src", "ui", "upstream", "entry.mjs");
const OUT_BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");

export async function buildUpstreamBundle() {
  const spliced = spliceSkeleton(readFileSync(SKELETON, "utf8"));
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  const tmpEntry = join(ROOT, ".tmp", "upstream-entry.spliced.mjs");
  const tmpOut = join(ROOT, ".tmp", "bundle-1.js");
  writeFileSync(tmpEntry, spliced, "utf8");
  rmSync(tmpOut, { force: true });
  // 拼接产物落在 .tmp,骨架自己的相对 import(./seam.mjs)指回真源目录
  const srcDir = join(ROOT, "src", "ui", "upstream");
  const tmpDir = join(ROOT, ".tmp");
  await esbuild.build({
    entryPoints: [tmpEntry],
    plugins: [
      {
        name: "skeleton-relatives",
        setup(build) {
          build.onResolve({ filter: /^\.\/[^/]+\.mjs$/ }, (args) => {
            if (!args.resolveDir || !args.resolveDir.startsWith(tmpDir)) return null;
            return { path: join(srcDir, args.path.slice(2)) };
          });
        },
      },
    ],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    charset: "utf8",
    minify: false, // 产物给人读(上游同取舍:生成物不转义中文、保持可读)
    banner: {
      js:
        "// AUTO-GENERATED by node build-upstream.mjs — DO NOT EDIT.\n" +
        "// 上游叶子自本仓 ../src/client(只读)拼接;骨架与垫片真源:src/ui/upstream/。\n",
    },
    outfile: tmpOut,
    allowOverwrite: true,
  });
  const code = readFileSync(tmpOut, "utf8");
  // 门禁:语法过(等价 node --check,只解析不执行)+ 资源通道约束(无模块级 import/export)
  new vm.Script(code, { filename: "dist-ui-bundle-1.txt" });
  if (/\bimport\s*["']/.test(code) || /^[^\S\r\n]*export\s/m.test(code)) {
    throw new Error("[build-upstream] bundle-1 含模块级 import/export —— 资源通道只搬文本,产物必须是 IIFE");
  }
  mkdirSync(dirname(OUT_BUNDLE), { recursive: true });
  writeFileSync(OUT_BUNDLE, code, "utf8");
  // 源目录不散落 dist(与 bundle-0 对 BUNDLE_PARTS 的处理同款)
  rmSync(join(ROOT, "dist", "ui", "upstream"), { recursive: true, force: true });
  console.log(`[build-upstream] dist/ui/bundle-1.txt(${code.length} bytes;叶子:${LEAVES.map((l) => l.id).join(",")})`);
  return OUT_BUNDLE;
}

// CLI:node build-upstream.mjs(build.mjs 也会在末尾调 buildUpstreamBundle)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildUpstreamBundle().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

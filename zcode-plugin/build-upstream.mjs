// build-upstream.mjs —— 上游 client 骨架 tracer 的拼接构建(工单 U01 立,U02 扩 kernel 域)。
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
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, copyFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/** 删掉片段里「从中央时间参数引名字」的单行 import/export-from(上游 transpile-unit.mts
 *  stripTimeConfigRefs 同款)。leaf:tip 这类叶子真源里那一行 import 是宿主/门禁把它当模块
 *  跑时用的真引用;拼进闭包时该行删掉、名字由 shared:timeConfig 片段提供(值出
 *  config/intervals.yaml)。只认说明符带 time-config 的行首单行写法,注释与字符串里的举例
 *  不受影响(按涂掉非代码后的文本认行首,行号用原行对);被删的行整行变空,不挪行号。 */
export function stripTimeConfigRefs(code) {
  const masked = maskNonCodeText(code).split("\n");
  return code
    .split("\n")
    .map((line, i) => {
      const m = masked[i] || "";
      if (!/time-config/.test(line)) return line;
      if (/^[^\S\r\n]*import[\s{"'*]/.test(m)) return "";
      if (/^[^\S\r\n]*export[\s{"'*]/.test(m) && /\bfrom\b/.test(m)) return "";
      return line;
    })
    .join("\n");
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
  // 中央时间参数的引用行先删再查(上游 toSpliceableFragment 同序):它们拼进闭包时由
  // shared:timeConfig 片段提供名字,是片段里唯一被允许出现过的模块写法。
  const withoutCentral = stripTimeConfigRefs(code);
  const hit = findUnfixableModuleForm(withoutCentral);
  if (hit) {
    throw new Error(
      `片段 ${source} 里是模块导出写法「${lineAt(withoutCentral, hit.index)}」:拼进闭包的片段只能写 ` +
        "`export <声明>` 这种行首形式,`export {…}` / `export * from` / `export default` 去掉 export 之后不是合法语句。"
    );
  }
  const stripped = withoutCentral
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

/** 本票叶子清单(工单 U02 扩 kernel 域、U03 扩视觉层、U04 扩列表页全家):id 即上游 index.ts 的
 * 标记名;file 相对上游仓库根,own:true 表示 file 相对本仓 ROOT(.tmp 生成物)。kernel:ctx 不在
 * 此列 —— 它与上游 wireCtx 同位:apply 头部注入,不走标记。登记序即上游标记序(骨架与测试都按
 * 这个序对上游 index.ts 校验,见 spliceSkeleton 三道对账)。 */
export const LEAVES = [
  { id: "leaf:hostShim", file: "src/client/hostShim.ts" },
  // ---- 工单 U03:中央时间参数(上游 shared:timeConfig 的拼接输入,U04 起按上游同口径摘全量名,
  //      见 generateUpstreamLeaves)与挂顶底座(HoverTip 的 portalTop,ReactDOM 缺席时退化为
  //      原地渲染不抛)----
  { id: "shared:timeConfig", file: ".tmp/upstream-leaves/time-config.client.js", own: true },
  { id: "kernel:portal", file: "src/client/kernel/portal.ts" },
  { id: "kernel:containerView", file: "src/client/kernel/container-view.ts" },
  { id: "kernel:ticketLabel", file: "src/client/kernel/ticket-label.ts" },
  // ---- 工单 U04:kernel 依赖缺口(目标叶子的 declare 差集逐个追闭;上游标记序原位) ----
  { id: "kernel:backendList", file: "src/client/kernel/builtin-backends.ts" },
  { id: "kernel:link", file: "src/client/kernel/link.ts" },
  { id: "kernel:motion", file: "src/client/kernel/motion.ts" },
  { id: "kernel:styles", file: "src/client/kernel/styles.ts" },
  // ---- 工单 02:技能详情像素风皮肤(887 样式叶子;上游标记序在 styles 与 localeData 之间) ----
  { id: "leaf:pixelStyles", file: "src/client/views/skillDetail/PixelStyles.ts" },
  // localeData/promptData 是上游构建现场生成、不入库的生成物(config/ YAML → 生成器)。
  // 上游树只读,生成器写死输出在上游树内 —— 这里把生成器与其 config 镜像进本仓 .tmp
  // 再跑,产物落 .tmp(见 generateUpstreamLeaves);词表五份合段同上游 buildVocabularySpliceInput。
  { id: "kernel:localeData", file: ".tmp/upstream-leaves/locale-data.ts", own: true },
  { id: "kernel:locale", file: "src/client/kernel/locale.ts" },
  // ---- 工单 02:技能目录数据表(上游静态展示目录 SKILLS,无运行时 import;标记序在 locale
  //      之后、trackerConstants 之前。27 项是上游展示目录,不是扫本机盘) ----
  { id: "shared:mattSkills", file: "src/shared/matt-skills.ts" },
  { id: "shared:trackerConstants", file: ".tmp/upstream-leaves/vocabulary.client.js", own: true },
  // 会话命名(Tabs 的 + bug 预填标题 newSessionTitleNew;上游 shared: 片段直取)
  { id: "shared:namingTitles", file: "src/shared/naming-titles.ts" },
  // 通用图标集(工单 U03:chips 的 TypeChip 用 Ic)
  { id: "kernel:icons", file: "src/client/kernel/icons.ts" },
  // KPI 头右端的「体检」按钮三件(healthCheckVisible/CountOf/openHealthCheck)
  { id: "kernel:healthCheck", file: "src/client/kernel/health-check.ts" },
  { id: "kernel:promptData", file: ".tmp/upstream-leaves/prompt-data.ts", own: true },
  { id: "kernel:prompts", file: "src/client/kernel/prompts.ts" },
  // 行内主按钮的提示词族(promptTextFor/completePrompt/inspectPrompt;kernel:prompts 同位在后)
  { id: "kernel:promptsBackend", file: "src/client/kernel/prompts-backend.ts" },
  // 动作模板(renderTemplate:ListTabRow 主按钮文案真源)
  { id: "kernel:config", file: "src/client/kernel/config.ts" },
  // 日志内核(上游 #564 起为包派生物,生成物按注册表路径直取;isEnabled/declaredLangPick 等在)
  { id: "kernel:log", file: "scripts/generated/logKernel.derived.js" },
  // 刷新额度档位(freshnessLevel/lagPromiseFor/tierFor:truthLines 的真相行档位真源)
  { id: "shared:refreshBudget", file: "src/refresh/kernel/host-budget.ts" },
  // 列表筛选记忆 + 导航栈 + 行点击(setActiveIssue/setActiveMap;saveUiPrefs typeof 守卫缺席走 legacy)
  { id: "kernel:storePrefs", file: "src/client/kernel/store-prefs.ts" },
  { id: "kernel:deckState", file: "src/client/kernel/deck-state.ts" },
  // 会话 store 表(shared/stores/emit/flash/getCachedSnapshot:emit 从此取真源,U02 桩撤)
  { id: "kernel:storeSnapshot", file: "src/refresh/rooms/client/snapshot-cache-store.ts" },
  // 工作路线读数(workRouteTable 的 ownWorkRouteSlotOf)
  { id: "kernel:workRouteOwn", file: "src/client/kernel/work-route-own.ts" },
  { id: "kernel:storeDerived", file: "src/client/kernel/store-derived.ts" },
  // 行动作(mkRowAction/actionColorOf/rowActionText)
  { id: "kernel:rowActions", file: "src/client/kernel/row-actions.ts" },
  // 顶栏门禁(上游标记序在 rowActions 与 probeChain 之间;closed/blocked 置灰的唯一真源)
  { id: "kernel:detailTopGate", file: "src/client/kernel/detail-top-gate.ts" },
  // 链快照纯读(chainSteps = ListTab 主渲染路径的环境坏项计数;loadChain 等宿主通路走桩/缺席)
  { id: "kernel:probeChain", file: "src/refresh/rooms/client/probe-chain-subscription.ts" },
  // 颜色小件(hexA/darken:Pop/筛选行/行内标签)
  { id: "kernel:probeSnapshotHelpers", file: "src/refresh/rooms/client/snapshot-sync-helpers.ts" },
  // 页签时钟与文本(panelClock/panelNow/startText/newBugWayfinderText;DetailsDock 走桩)
  { id: "kernel:router", file: "src/client/kernel/router.ts" },
  // 入口浮层(EntryChooser 渲在页签行里;buildEntryCard 在前,上游 #1297 次序)
  { id: "kernel:entryCard", file: "src/client/kernel/entry-card.ts" },
  { id: "kernel:entryChoice", file: "src/client/kernel/entry-choice.ts" },
  // 新会话动作(openTextInNewSession:页签 +bug 与行内「新会话」;apiNaming 等三件 typeof 守卫缺席)
  { id: "kernel:apiNewSession", file: "src/client/kernel/api-new-session.ts" },
  // IO 动作(inject/copyText/openInNewSession/fetchIssuesPage 上游真源;宿主电话走本仓 host 适配)
  { id: "kernel:apiIo", file: "src/client/kernel/api-io.ts" },
  { id: "kernel:issuePages", file: "src/client/kernel/issue-pages.ts" },
  // 动作分发器(NoRepoCard/行动作点击;契约常量已内联,零 declare)
  { id: "kernel:actions", file: "src/client/kernel/actions.ts" },
  // ---- 工单 U03:视觉小件家族(上游 build.mts LEAF_MODULES 同名同序) ----
  { id: "leaf:chips", file: "src/client/views/shared/chips.ts" },
  { id: "leaf:tipPlace", file: "src/client/views/primitives/tipPlace.ts" },
  { id: "leaf:hoverTip", file: "src/client/views/primitives/HoverTip.ts" },
  { id: "leaf:tip", file: "src/client/views/primitives/Tip.ts" },
  { id: "leaf:ticketBadge", file: "src/client/views/shared/ticketBadge.ts" },
  { id: "leaf:openFolder", file: "src/client/views/shared/openFolder.ts" },
  { id: "leaf:liquidInk", file: "src/client/views/shared/liquidInk.ts" },
  { id: "leaf:pixelBtn", file: "src/client/views/pixel/PixelBtn.ts" },
  { id: "leaf:pixelDot", file: "src/client/views/pixel/PixelDot.ts" },
  { id: "leaf:pixelNum", file: "src/client/views/pixel/PixelNum.ts" },
  { id: "leaf:pixelStateIcon", file: "src/client/views/pixel/PixelStateIcon.ts" },
  { id: "leaf:pixelSeal", file: "src/client/views/pixel/PixelSeal.ts" },
  { id: "leaf:pixelSkeleton", file: "src/client/views/pixel/PixelSkeleton.ts" },
  { id: "leaf:pixelBanner", file: "src/client/views/pixel/PixelBanner.ts" },
  { id: "leaf:pixelStatusLine", file: "src/client/views/pixel/PixelStatusLine.ts" },
  // cards 家族 16 件(S1/S6/S7 三张卡:先主题与皮肤,再共享小件,最后大卡,次序即依赖次序)
  { id: "leaf:cardsTheme", file: "src/client/views/cards/PixelCardTheme.ts" },
  { id: "leaf:cardsStyles", file: "src/client/views/cards/PixelCardsStyles.ts" },
  { id: "leaf:cardPin", file: "src/client/views/cards/PixelCardPin.ts" },
  { id: "leaf:cardTitle", file: "src/client/views/cards/PixelCardTitle.ts" },
  { id: "leaf:cardNo", file: "src/client/views/cards/PixelCardNo.ts" },
  { id: "leaf:cardTags", file: "src/client/views/cards/PixelCardTags.ts" },
  { id: "leaf:cardNote", file: "src/client/views/cards/PixelCardNote.ts" },
  { id: "leaf:cardFoot", file: "src/client/views/cards/PixelCardFoot.ts" },
  { id: "leaf:cardStamp", file: "src/client/views/cards/PixelCardStamp.ts" },
  { id: "leaf:blockedChrome", file: "src/client/views/cards/PixelBlockedChrome.ts" },
  { id: "leaf:cardBtns", file: "src/client/views/cards/PixelCardBtns.ts" },
  { id: "leaf:mapDots", file: "src/client/views/cards/PixelMapDots.ts" },
  { id: "leaf:cardHead", file: "src/client/views/cards/PixelCardHead.ts" },
  { id: "leaf:issueCard", file: "src/client/views/cards/PixelIssueCard.ts" },
  { id: "leaf:issueMapCard", file: "src/client/views/cards/PixelIssueMapCard.ts" },
  { id: "leaf:mapCard", file: "src/client/views/cards/PixelMapCard.ts" },
  // ---- 工单 U04:列表页全家 + 页签壳(上游 index.ts 标记序原位,次序即依赖次序) ----
  // 页签壳:共享 tabs 行(wayfinder/bug 入口 + EntryChooser + 液态墨块)
  { id: "leaf:tabs", file: "src/client/views/shared/Tabs.ts" },
  // 真相行(刷新事实的三档文案与 FallbackMark 的降级说明)
  { id: "leaf:truthLines", file: "src/client/views/shared/truthLines.ts" },
  { id: "leaf:fallbackMark", file: "src/client/views/shared/fallbackMark.ts" },
  // 工作路线表(md 渲染的剥表视图;上游标记序在 truthLines 后)
  { id: "leaf:workRouteTable", file: "src/client/views/shared/workRouteTable.ts" },
  // 极简 md 渲染(MD_LINK_RE 等;列表页正文侧共用)
  { id: "leaf:md", file: "src/client/views/shared/md.ts" },
  // 票务小件(tProgressBar/tStatusBadge:TicketRow 的状态徽章与进度条)
  { id: "leaf:ticket", file: "src/client/views/shared/ticket.ts" },
  { id: "leaf:stateKind", file: "src/client/views/shared/stateKind.ts" },
  // 地图详情内的票务行(U05+ 详情视图用;先按工单点名搬入,渲染路径休眠)
  { id: "leaf:ticketRow", file: "src/client/views/TicketRow.ts" },
  // ---- 工单 U05:详情页全家 + 动作栏(上游 index.ts 标记序原位,次序即依赖次序) ----
  // 容器详情底部动作条(三态主按钮;上游标记序在 mapDetail 与 mapDetailSpecBody 之间,
  // 本仓跳过 mapDetail 家族后仍保序)
  { id: "leaf:detailActionBar", file: "src/client/views/DetailActionBar.ts" },
  // 详情投影(#1694:上次数据先画、失败不清空;knownBlockedNodes/detailViewFor 真源)
  { id: "leaf:detailProjection", file: "src/client/views/shared/detailProjection.ts" },
  // 详情错误视图(issueErrorViewOf:错误横幅一句话)
  { id: "leaf:issueDetailErrorView", file: "src/client/views/issueDetailErrorView.ts" },
  // 子票路由(enterSubDetail:子票/被阻塞行点击进下一层详情)
  { id: "leaf:subIssueRouting", file: "src/client/views/subIssueRouting.ts" },
  // 评论区(50 页分页/只读门/提交纪律;COMMENT_RESULT_FLASH_MS 等三常量自持)
  { id: "leaf:IssueDetailComments", file: "src/client/views/IssueDetailComments.ts" },
  // 折叠判据层(阶梯五元素按字数逐级裁;零 declare)
  { id: "leaf:issueDetailFold", file: "src/client/views/issueDetailFold.ts" },
  // 折叠机(测量+逐档试裁;依赖 issueDetailFold 的两函数)
  { id: "leaf:useIssueDetailFold", file: "src/client/views/useIssueDetailFold.ts" },
  // 详情页本体(粘性顶栏/元行/正文/子票/被阻塞/评论区挂载)
  { id: "leaf:IssueDetail", file: "src/client/views/IssueDetail.ts" },
  // 标签/行宽折叠(fitAllTags/fitMapRows 的四相测量)
  { id: "leaf:tagsFit", file: "src/client/views/shared/tagsFit.ts" },
  // 浮层底座(showPop:行内 +N 标签弹层)
  { id: "leaf:pop", file: "src/client/floating/Pop.ts" },
  // 无仓库卡/设置卡(上游引导态;本仓装配不挂载,搬入保序)
  { id: "leaf:noRepoCard", file: "src/client/views/NoRepoCard.ts" },
  { id: "leaf:setupCard", file: "src/client/views/SetupCard.ts" },
  // 列表页本体一家:翻页行 → 行渲染 → 筛选行 → md 目录签 → ListTab(上游同一行标记序)
  { id: "leaf:ListTabClosed", file: "src/client/views/ListTabClosed.ts" },
  { id: "leaf:ListTabRow", file: "src/client/views/ListTabRow.ts" },
  { id: "leaf:listFilterRow", file: "src/client/views/listFilterRow.ts" },
  { id: "leaf:mdEffortRow", file: "src/client/views/mdEffortRow.ts" },
  { id: "leaf:listTab", file: "src/client/views/ListTab.ts" },
  // ---- 工单 02:技能页签 + 文档详情像素风家族(上游 index.ts 标记序原位;leaf:prTab 本批跳过) ----
  { id: "leaf:skillsTab", file: "src/client/views/SkillsTab.ts" },
  { id: "leaf:pixelContents", file: "src/client/views/skillDetail/PixelContents.ts" },
  { id: "leaf:pixelMarkdown", file: "src/client/views/skillDetail/PixelMarkdown.ts" },
  { id: "leaf:pixelSkillRow", file: "src/client/views/skillDetail/PixelSkillRow.ts" },
  { id: "leaf:pixelSkillList", file: "src/client/views/skillDetail/PixelSkillList.ts" },
  { id: "leaf:pixelSkillDetailModal", file: "src/client/views/skillDetail/PixelSkillDetailModal.ts" },
  { id: "leaf:pixelSkillOps", file: "src/client/views/skillDetail/PixelSkillOps.ts" },
];
const CTX_BLOCK_FILE = "src/client/kernel/ctx.ts";

// 上游没有标记、但工单点名搬入的 tracker 侧真源(上游客户端闭包不含它们 —— 上游由宿主
// 在服务侧消费;本仓把数据面接进同一闭包,经骨架自有锚点注入,不冒充上游标记名):
//   progress.ts(deck-derive 的进度真源)+ deck-counts.ts + deck-derive.ts + tabsfold.ts
// (tabsfold 上游 index.ts 内联同款逻辑、无标记;这里搬独立叶子文件,逻辑一字不改)。
const TRACKER_ANCHOR = "trackerDeck";
const TRACKER_PARTS = [
  {
    file: "src/shared/issue-file/src/progress.ts",
    strip: [],
    why: "进度解析唯一真源,deck-derive 复出它",
  },
  {
    file: "src/tracker/deck-counts.ts",
    strip: [
      "import { effortOf } from './kernel/identity-keys.js'",
      "export default { DECK_COUNT_SOURCES, planDeckCounts, rowCountsOf }",
    ],
    why: "effortOf 与词表五份同闭包已有;default 导出拼接吃不了",
  },
  {
    file: "src/client/kernel/tabsfold.ts",
    strip: [],
    why: "页签折叠机纯函数(上游 index.ts 内联同款,无标记)",
  },
  {
    file: "src/tracker/deck-derive.ts",
    strip: [
      "import { STATE } from './contract/vocabulary.js'",
      "import { effortOf, idOfParts } from './kernel/identity-keys.js'",
      "import { parseProgress } from '../shared/issue-file/src/progress.js'",
      "export { parseProgress }",
    ],
    why: "STATE/effortOf/idOfParts 与词表五份同闭包已有;parseProgress 由本段 progress.ts 提供,重导出行去掉",
  },
];

// 词表五份(上游 shared:trackerConstants 的拼接输入,buildVocabularySpliceInput 同款):
// 次序即依赖次序(名单派生读数组常量,数组常量在前;其余互相零依赖)。
const VOCABULARY_PARTS = [
  { file: "src/tracker/contract/canonical-labels.ts", strip: [] },
  { file: "src/tracker/contract/vocabulary.ts", strip: [] },
  { file: "src/tracker/kernel/identity-keys.ts", strip: [] },
  {
    file: "src/tracker/label-names.ts",
    strip: ["import { CANONICAL_LABELS } from './contract/canonical-labels.js'"],
    why: "CANONICAL_LABELS 与本段同作用域,引用句去掉(上游同款处理)",
  },
  { file: "src/tracker/fix-contract.ts", strip: [] },
];

const readUpstream = (rel) => readFileSync(join(UPSTREAM_ROOT, ...rel.split("/")), "utf8");

/**
 * 把若干上游 .ts 真源合成一段可拼进闭包的 JavaScript(上游 buildVocabularySpliceInput 的
 * 一般化):逐份读原文 → 逐字匹配剥掉 strip 里的引用句(找不到当场抛,不许静默拼错)→
//  拼段头注释 → 按全仓唯一口径转译 → 末尾导出块改回行首 export。产物已转译为 JS。
 */
export function buildCombinedFragment(parts, { source }) {
  const combined = parts
    .map((p) => {
      let text = readUpstream(p.file);
      for (const stripLine of p.strip || []) {
        if (!text.includes(stripLine)) {
          throw new Error(`${source}: ${p.file} 里找不到预期的引用句,拼接输入拒绝生成:${stripLine}`);
        }
        text = text.replace(stripLine, `// （拼接输入:${p.why || "与本段同作用域,引用句已去掉"}）`);
      }
      return `// ---- splice part: ${p.file} ----\n` + text;
    })
    .join("\n");
  const transformed = esbuild.transformSync(combined, TRANSPILE_OPTIONS).code;
  const normalized = transformed.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
  return inlineExportDeclarations(normalized, source);
}

// 上游生成器镜像:config/ + 三个生成器 + 它们的 lib 复制进本仓 .tmp/upstream-gen,再以镜像
// 为 cwd 跑(生成器 ROOT 由 __dirname 推出 → 产物全部落在镜像内,上游树一字不动)。
// node_modules 用 junction 指回本仓(esbuild/yaml 都在本仓 devDependencies 里)。
const GEN_MIRROR = join(ROOT, ".tmp", "upstream-gen");
const GEN_SCRIPTS = [
  "scripts/generate-time-config.mts",
  "scripts/generate-locale-config.mts",
  "scripts/generate-prompt-config.mts",
];
const GEN_LIBS = [
  "scripts/lib/copy-config.mts",
  "scripts/lib/prompt-config.mts",
  "scripts/lib/time-config-expr.mts",
];

function runInMirror(scriptRel, label) {
  const r = spawnSync(process.execPath, [join(GEN_MIRROR, ...scriptRel.split("/"))], {
    encoding: "utf8",
    cwd: GEN_MIRROR,
  });
  if (r.status !== 0) {
    throw new Error(
      `[build-upstream] 上游生成器镜像执行失败(${label}):` + String((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(0, 5).join(" ／ ")
    );
  }
}

// 中央时间参数的客户端片段(上游 shared:timeConfig 同位):locale 生成器先跑时间参数生成器
// (上游同链路,镜子里落 src/shared/time-config/src/values.ts);上游 buildTimeConfigClientFragment
// 按 CLIENT_TIME_NAMES 清单逐名摘「恰好一行 export const」(多行字面量如 TIME_YAML 不进闭包)。
// U03 按叶子集摘 2 名;U04 起换成上游同一份 65 名清单(truthLines/ListTabRow/store-prefs/
// probeChain 等叶子剥掉 time-config import 行后,名字都由这一片提供),值源 config/ YAML 不变。
const CLIENT_TIME_NAMES = [
  "MAP_TICKETS_TTL_MS", "SETTINGS_DEBUG_PUSH_WAIT_MS", "CLIENT_SESSION_TICK_MS", "CLIENT_HANDOFF_DELAY_MS",
  "PROBE_AUTO_WAIT_MS", "SLOT_QUEUE_STEP_MS", "SLOT_MODAL_OPEN_DELAY_MS", "STORE_SWITCH_CONFIRM_MS",
  "STATUS_MENU_DISMISS_DELAY_MS", "STATUS_MENU_HOVER_OPEN_DELAY_MS", "STATUS_MENU_FALLBACK_DELAY_MS",
  "SNAPSHOT_PROBE_MS", "STORE_NOTICE_DISMISS_MS", "SNAPSHOT_PICKED_GUARD_MS", "ISSUE_DETAIL_CONFIRM_MS",
  "COMMENT_RESULT_FLASH_MS", "COMMENTS_MORE_LOADING_MIN_MS", "COPY_FLASH_MS",
  "SYNC_FALLBACK_PROBE_MS", "SYNC_FOCUS_PROBE_MIN_MS", "SYNC_SNAP_FRESH_MS", "SYNC_ISSUE_CACHE_TTL_MS",
  "SYNC_EVAL_GAP_MS", "SYNC_DIRTY_PROBE_DEBOUNCE_MS", "SYNC_OVERLAP_SKEW_MS", "SYNC_FAILURE_BACKOFF_MS",
  "SYNC_DIRTY_ECHO_TTL_MS", "SYNC_POLL_GRID_MS", "SYNC_ACTION_PROBE_WINDOW_MS",
  "VC_TASK_POLL_INTERVAL_MS", "SNAP_WAIT_MS", "VIEW_FLAG_WRITE_DEBOUNCE_MS", "REST_FALLBACK_STALE_MS",
  "TIP_SHOW_DELAY_MS", "TIP_HIDE_DELAY_MS", "VC_RELATIVE_WINDOW_MS", "DRAFT_REFOCUS_RETRY_MS",
  "NAMING_RETRY_COOLDOWN_MS",
  "PROBE_INTERVAL_MS", "PROBE_INTERVAL_YELLOW_MS", "PROBE_INTERVAL_LINGER_MS", "REBUILD_MIN_INTERVAL_YELLOW_MS",
  "RECONCILE_INTERVAL_MS", "PREFLIGHT_TTL_MS", "CHAIN_BACKOFF_MS", "STEP_WAIT_MS", "FAILURE_HALF_OPEN_DELAY_MS",
  "CHAIN_ALL_GREEN_TTL_MS", "PATCH_MERGE_WINDOW_MS", "DEFER_EXPIRY_MS", "ACTIVE_LINGER_MS",
  "ATTENTION_HEARTBEAT_MS", "ATTENTION_EXPIRY_MS", "QUOTA_SYNC_INTERVAL_MS", "FRESHNESS_YELLOW_MS",
  "FRESHNESS_RED_MS", "FALLBACK_PROBE_INTERVAL_MS", "FALLBACK_CALIBRATION_INTERVAL_MS",
  "SKILL_FLOAT_CLOSE_DELAY_MS", "LABEL_COPY_FLASH_MS", "SKILL_DETAIL_COPIED_FLASH_MS",
  "NATIVE_TAB_RETRY_INTERVAL_MS", "SKILL_SKELETON_DELAY_MS", "OWN_ROUTE_RETRY_MS",
];

/** 生成三类拼接输入到 .tmp/upstream-leaves:locale-data / prompt-data(生成器直出)+
 *  vocabulary.client.js(词表五份合段)+ time-config.client.js(中央时间参数按需摘名)。
 *  幂等:每次构建重算。 */
export function generateUpstreamLeaves() {
  const outDir = join(ROOT, ".tmp", "upstream-leaves");
  mkdirSync(outDir, { recursive: true });
  rmSync(GEN_MIRROR, { recursive: true, force: true });
  mkdirSync(join(GEN_MIRROR, "scripts", "lib"), { recursive: true });
  // config/ 整树 + 生成器 + lib(生成器之间按相对路径互调、lib 按相对路径被引)
  cpSync(join(UPSTREAM_ROOT, "config"), join(GEN_MIRROR, "config"), { recursive: true });
  for (const rel of GEN_SCRIPTS.concat(GEN_LIBS)) {
    const from = join(UPSTREAM_ROOT, ...rel.split("/"));
    const to = join(GEN_MIRROR, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  // node_modules junction(Windows 目录联接不需要管理员权限);已存在先清
  const nmLink = join(GEN_MIRROR, "node_modules");
  try {
    rmSync(nmLink, { recursive: true, force: true });
  } catch (e) { /* junction 删除失败不影响:覆盖前先生成会抛,再补一次 */ }
  symlinkSync(join(ROOT, "node_modules"), nmLink, "junction");
  // 词表里的 {{时间参数}} 由 locale 生成器自己先跑时间参数生成器(上游同链路)
  runInMirror("scripts/generate-locale-config.mts", "locale-data");
  runInMirror("scripts/generate-prompt-config.mts", "prompt-data");
  for (const name of ["locale-data.ts", "prompt-data.ts"]) {
    copyFileSync(join(GEN_MIRROR, "src", "client", "kernel", name), join(outDir, name));
  }
  writeFileSync(
    join(outDir, "vocabulary.client.js"),
    "// AUTO-GENERATED(词表五份合段,上游 buildVocabularySpliceInput 同款)。\n" +
      buildCombinedFragment(VOCABULARY_PARTS, { source: "vocabulary.client.js" }),
    "utf8"
  );
  // 中央时间参数:镜像里的 values.ts(时间参数生成器直出)按全仓唯一口径转译后逐名摘行 ——
  // 与上游「读域构建产物摘 export const 行」同一判定(多行字面量不进闭包),值同源(config/ YAML)。
  const timeValues = readFileSync(join(GEN_MIRROR, "src", "shared", "time-config", "src", "values.ts"), "utf8");
  const timeJs = inlineExportDeclarations(
    esbuild.transformSync(timeValues, TRANSPILE_OPTIONS).code.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n",
    "time-config values"
  );
  const timeLines = [];
  for (const name of CLIENT_TIME_NAMES) {
    const hit = timeJs.split("\n").filter((l) => l.startsWith(`export const ${name} = `));
    if (hit.length !== 1) throw new Error(`[build-upstream] 中央时间参数摘不到 ${name}(期望恰好一行 export const,实得 ${hit.length} 行)`);
    timeLines.push(hit[0]);
  }
  writeFileSync(
    join(outDir, "time-config.client.js"),
    `// AUTO-GENERATED(中央时间参数客户端片段,上游 shared:timeConfig 同位;全量摘 ${timeLines.length} 名,值源 config/ YAML)。\n` +
      timeLines.join("\n") +
      "\n",
    "utf8"
  );
  writeFileSync(
    join(outDir, "tracker-deck.client.js"),
    "// AUTO-GENERATED(tracker 侧真源合段:progress + deck-counts + tabsfold + deck-derive)。\n" +
      buildCombinedFragment(TRACKER_PARTS, { source: "tracker-deck.client.js" }),
    "utf8"
  );
  return outDir;
}

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
    const content = leaf.own ? readFileSync(join(ROOT, ...leaf.file.split("/")), "utf8") : readUpstream(leaf.file);
    out = out.replace(marker, () => stripTsToSpliceable(content, { source: leaf.file }));
  }
  // tracker 锚点注入(上游无此标记:tracker 侧真源,骨架自有段注入;次序在词表五份之后,
  // 锚点片段里的 STATE/effortOf/idOfParts 由 shared:trackerConstants 提供)。
  // 只认独占一行的锚点(注释里举例写的锚点名不算),防把片段拼进注释。
  const anchorRe = new RegExp(`^[ \\t]*\\/\\* @splice-anchor: ${TRACKER_ANCHOR} \\*\\/[ \\t]*$`, "m");
  if (!anchorRe.test(out)) {
    throw new Error(`[build-upstream] 骨架缺独占一行的锚点 /* @splice-anchor: ${TRACKER_ANCHOR} */ — tracker 侧真源(deck-counts/deck-derive/progress/tabsfold)经它注入`);
  }
  const trackerFrag = readFileSync(join(ROOT, ".tmp", "upstream-leaves", "tracker-deck.client.js"), "utf8");
  out = out.replace(anchorRe, () => stripTsToSpliceable(trackerFrag, { source: "tracker-deck.client.js" }));
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
  generateUpstreamLeaves(); // 生成物叶子(localeData/promptData/词表五份/tracker 合段)先就位
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
  // 源目录不散落 dist
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

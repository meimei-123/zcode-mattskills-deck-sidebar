// 工单 U01 骨架测试:上游 client splice 产物 + ctx 垫片(八服务)+ dsws-panel 空壳冒烟。
// 缝 = 对外可观察边界:build-upstream.mjs 的纯拼接函数、dist/ui/bundle-1.txt 产物语义、
// bundle 暴露的 window.MattSkillsUpstream(apply/boot/seam)。node 直跑,无框架。
// 依赖 zcode-plugin/node_modules(esbuild/preact,构建依赖,npm install 后可用)。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const UPSTREAM = join(ROOT, ".."); // 同仓上游真源(worktree 内,只读)

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 切片 1:splice 纯函数(标记解析 / 序校验 / 转译剥 export)
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);

{
  const fx = [
    "const a = 1",
    "// ==== leaf:hostShim (spliced by build) ====",
    "// ==== kernel:styles (spliced by build) ==== // ==== leaf:dock (spliced by build) ====",
    "// ==== shared:slots (spliced by build) ====",
  ].join("\n");
  const markers = buildUpstream.parseMarkers(fx);
  check(
    "parseMarkers 按出现序提出 kind:name(含同行多标记)",
    JSON.stringify(markers) ===
      JSON.stringify([
        { id: "leaf:hostShim", index: fx.indexOf("// ==== leaf:hostShim") },
        { id: "kernel:styles", index: fx.indexOf("// ==== kernel:styles") },
        { id: "leaf:dock", index: fx.indexOf("// ==== leaf:dock") },
        { id: "shared:slots", index: fx.indexOf("// ==== shared:slots") },
      ]),
    JSON.stringify(markers)
  );
  check("parseMarkers 不吃普通注释", buildUpstream.parseMarkers("// ==== 不是标记 ====").length === 0);
}

{
  check("isSubsequenceOf 保序子序列为真", buildUpstream.isSubsequenceOf(["a", "c"], ["a", "b", "c", "d"]));
  check("isSubsequenceOf 乱序为假", !buildUpstream.isSubsequenceOf(["c", "a"], ["a", "b", "c", "d"]));
  check("isSubsequenceOf 缺项为假", !buildUpstream.isSubsequenceOf(["a", "x"], ["a", "b"]));
}

{
  // esbuild 转译形态:声明在前、末尾 export 块 —— 照上游 inlineExportDeclarations 改回行首
  const lowered = "const MOTION = { a: 1 };\nfunction f() {\n  return 1;\n}\nexport {\n  MOTION,\n  f\n};\n";
  const inlined = buildUpstream.inlineExportDeclarations(lowered, "fx");
  check(
    "inlineExportDeclarations 末尾导出块改回行首 export",
    inlined === "export const MOTION = { a: 1 };\nexport function f() {\n  return 1;\n}\n",
    JSON.stringify(inlined)
  );
}

{
  const frag = buildUpstream.toSpliceableFragment("export const A = 1;\nexport function b(x) {\n  return x;\n}\n", { source: "fx" });
  check("toSpliceableFragment 剥行首 export", /^const A = 1;/.test(frag) && /^function b\(x\)/m.test(frag), JSON.stringify(frag));
  let threw = "";
  try {
    buildUpstream.toSpliceableFragment("export default { apply() {} }", { source: "fx" });
  } catch (e) {
    threw = e.message;
  }
  check("toSpliceableFragment 拒绝 export default", threw.includes("fx"), threw);
  threw = "";
  try {
    buildUpstream.toSpliceableFragment("import x from 'y';\nconst a = x;\n", { source: "fx" });
  } catch (e) {
    threw = e.message;
  }
  check("toSpliceableFragment 拒绝模块级 import 残留", threw.includes("fx"), threw);
}

// 真源叶子直检:hostShim 是上游拼接清单第一叶,转译剥 export 后进 bundle
{
  const src = readFileSync(join(UPSTREAM, "src", "client", "hostShim.ts"), "utf8");
  const frag = buildUpstream.stripTsToSpliceable(src, { source: "src/client/hostShim.ts" });
  check("stripTsToSpliceable(hostShim) 含 timer 包装", /const timer = \{/.test(frag), frag.slice(0, 120));
  check("stripTsToSpliceable(hostShim) 含 h 绑定", /const h = React\.createElement/.test(frag));
  check("stripTsToSpliceable(hostShim) 无 export 残留", !/^\s*(import|export)\b/m.test(frag));
  check("stripTsToSpliceable 产物以换行收尾", /\n$/.test(frag));
  check("stripTsToSpliceable 削掉 declare 行", !/^\s*declare\s/m.test(frag));
}

// ---------------------------------------------------------------------------
// 切片 2:拼接管线(骨架标记 ← 上游叶子;标记序对上游 index.ts 校验)
// U02 起 LEAVES 扩到 kernel 域:fixture 骨架从 LEAVES 清单现生成(双向对账要求
// 骨架含全部登记标记),生成物叶子先落 .tmp(generateUpstreamLeaves 幂等)。
// ---------------------------------------------------------------------------
{
  await buildUpstream.generateUpstreamLeaves();
  // fixture 骨架:标记序 = LEAVES 登记序(应与上游一致,由 spliceSkeleton 校验)
  const fxSkeleton = [
    "function apply(ctx) {",
    "  const slots = ctx.get('slots')",
    "  if (slots === undefined) return",
    ...buildUpstream.LEAVES.map((l) => `// ==== ${l.id} (spliced by build) ====`),
    "  /* @splice-anchor: trackerDeck */",
    "  styles.insert(STYLE_TEXT)",
    "}",
  ].join("\n");
  const plan = buildUpstream.spliceSkeleton(fxSkeleton);
  const applyAt = plan.indexOf("apply(ctx) {");
  const ctxAt = plan.indexOf("const DswsCtx = React.createContext");
  const slotsAt = plan.indexOf("const slots");
  check(
    "spliceSkeleton 注入 kernel:ctx 于 apply 头(上游 wireCtx 同位;行首 export 已剥)",
    applyAt >= 0 && ctxAt > applyAt && ctxAt < slotsAt,
    plan.slice(applyAt, applyAt + 160)
  );
  check("spliceSkeleton 拼入 hostShim 的 timer", /const timer = \{/.test(plan));
  check("spliceSkeleton 拼入 containerView 的身份色表", /const CONTAINER_ACCENT = \{ map: "#c084fc", spec: "#1D4ED8" \}/.test(plan));
  check("spliceSkeleton 拼入 motion 的 MOTION", /const MOTION = \{/.test(plan));
  check("spliceSkeleton 拼入 styles 的 STYLE_TEXT", /const STYLE_TEXT = \[/.test(plan));
  check("spliceSkeleton 标记无残留", !/\(spliced by build\)/.test(plan));
  check("spliceSkeleton 求值序:containerView 先于 styles(TDZ)", plan.indexOf("CONTAINER_ACCENT") < plan.indexOf("const STYLE_TEXT"));

  // 乱序骨架必须被上游标记序校验拦下(U02 起 LEAVES 里 containerView 与 ticketLabel 相邻,
  // 换这对与换 containerView/motion 等价:上游序里 containerView 在前)
  const badSkeleton = fxSkeleton.replace(
    "// ==== kernel:containerView (spliced by build) ====\n// ==== kernel:ticketLabel (spliced by build) ====",
    "// ==== kernel:ticketLabel (spliced by build) ====\n// ==== kernel:containerView (spliced by build) ===="
  );
  let threw = "";
  try {
    buildUpstream.spliceSkeleton(badSkeleton);
  } catch (e) {
    threw = e.message;
  }
  check("spliceSkeleton 拒绝违背上游标记序的骨架", threw.includes("kernel:containerView"), threw);

  // 未知标记(上游没有的)也拦
  let threw2 = "";
  try {
    buildUpstream.spliceSkeleton("// ==== leaf:notExist (spliced by build) ====");
  } catch (e) {
    threw2 = e.message;
  }
  check("spliceSkeleton 拒绝上游不存在的标记", threw2.includes("leaf:notExist"), threw2);

  // 清单里的叶子没在骨架留标记,同样报(上游 wireModules 双向对账同款)
  let threw3 = "";
  try {
    buildUpstream.spliceSkeleton("// ==== leaf:hostShim (spliced by build) ====");
  } catch (e) {
    threw3 = e.message;
  }
  check("spliceSkeleton 双向对账:缺标记报错", threw3.includes("kernel:containerView"), threw3);
}

// ---------------------------------------------------------------------------
// 切片 3:dist/ui/bundle-1.txt 产物语义 + seam 八服务 + boot 后 dsws-panel 空壳
// ---------------------------------------------------------------------------
const BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");
{
  check("dist/ui/bundle-1.txt 存在(splice 构建产物入库)", existsSync(BUNDLE));
}

let U = null; // window.MattSkillsUpstream
let seamCtx = null;
const headStyles = []; // styles.insert 落进假 head 的 <style> 收集处(finishShellChecks 要读)
if (existsSync(BUNDLE)) {
  const code = readFileSync(BUNDLE, "utf8");
  try {
    new vm.Script(code); // 语法门禁(等价 node --check,只解析不执行)
    check("bundle-1 语法过(vm.Script)", true);
  } catch (e) {
    check("bundle-1 语法过(vm.Script)", false, e.message);
  }
  check("bundle-1 无模块级 import(资源通道只搬文本)", !/\bimport\s*["']/.test(code));
  check("bundle-1 无模块级 export", !/^[^\S\r\n]*export\s/m.test(code));

  // 假 window/document 里执行 bundle(与 stub-host 同法):只求定义 window.MattSkillsUpstream
  const docStub = {
    head: { appendChild: (n) => headStyles.push(n) },
    body: { appendChild: () => {} },
    createElement: (tag) => ({ tag, style: {}, setAttribute() {}, appendChild() {}, children: [], textContent: "" }),
  };
  const win = {};
  try {
    new Function("window", "document", `"use strict";\n${code}`)(win, docStub);
    U = win.MattSkillsUpstream;
    check("bundle-1 定义 window.MattSkillsUpstream", !!U && typeof U.apply === "function" && typeof U.boot === "function");
  } catch (e) {
    check("bundle-1 在假 window/document 中求值不炸", false, e.message);
  }

  if (U) {
    check("seam 服务面清单为 8 项", Array.isArray(U.seam.SEAM_SERVICE_IDS) && U.seam.SEAM_SERVICE_IDS.length === 8, JSON.stringify(U.seam.SEAM_SERVICE_IDS));

    // boot:假 client 桩(workspace.json 由切片 4 的真 server 提供,这里给桩回包)
    const fakeClient = {
      readResource: async (uri) => {
        if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/fake/ws", env: {} }) }] };
        throw new Error("no asset " + uri);
      },
    };
    U.boot({ client: fakeClient, doc: docStub })
      .then((ctx) => {
        seamCtx = ctx;
        finishShellChecks(ctx);
      })
      .catch((e) => {
        check("boot(假桥)成功", false, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e));
        finishShellChecks(null);
      });
  } else finishShellChecks(null);
} else finishShellChecks(null);

// ---------------------------------------------------------------------------
// 切片 4:接线 —— assets.json / panel.html 并存入口与回退 / server workspace.json
// (finishShellChecks 之后追加;server 侧用真 dist/server.mjs + fixtures 预录)
// ---------------------------------------------------------------------------
async function integrationChecks() {
  // assets.json:bundle-1 进清单,bundle-0 仍居首(旧引导序不变)
  const manifestPath = join(ROOT, "dist", "ui", "assets.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    check("assets.json scripts 仍以 bundle-0 开头(旧 UI 引导序不变)", manifest.scripts?.[0] === "bundle-0.txt");
    check("assets.json scripts 含 bundle-1(上游壳 bundle)", manifest.scripts?.includes("bundle-1.txt"));
  } else {
    check("dist/ui/assets.json 存在", false);
  }

  // panel.html:并存入口 + 回退开关;握手两拍事故锁(第二拍绝不能丢,真机事故定案)
  const panelPath = join(ROOT, "dist", "ui", "panel.html");
  if (existsSync(panelPath)) {
    const html = readFileSync(panelPath, "utf8");
    check("panel.html 保留握手第一拍 ui/initialize", html.includes("ui/initialize"));
    check(
      "panel.html 保留握手第二拍 ui/notifications/initialized(事故锁)",
      html.includes("ui/notifications/initialized")
    );
    check("panel.html 起上游壳(boot window.MattSkillsUpstream)", html.includes("MattSkillsUpstream") && html.includes(".boot"));
    check("panel.html 回退开关(localStorage mattskills-upstream=off)", html.includes("mattskills-upstream"));
  } else {
    check("dist/ui/panel.html 存在", false);
  }

  // server:workspace.json 资源(服务端注入静态工作区根)与 bundle-1 资产供给
  const { startServer } = await import(pathToFileURL(join(ROOT, "test", "stub-host.mjs")).href);
  const fixtureWs = join(ROOT, "test", "fixtures", "mixed");
  const server = await startServer(fixtureWs);
  try {
    const ws = await server.rpc("resources/read", { uri: "ui://zcode-mattpocock-skills-deck/workspace.json" });
    const wstext = ws.result?.contents?.[0]?.text || "";
    const parsed = wstext ? JSON.parse(wstext) : {};
    check("server 供 workspace.json(静态工作区根)", parsed.root === fixtureWs, wstext);
    const b1 = await server.rpc("resources/read", { uri: "ui://zcode-mattpocock-skills-deck/assets/bundle-1.txt" });
    check(
      "server 供 assets/bundle-1.txt(含 MattSkillsUpstream)",
      !b1.error && /MattSkillsUpstream/.test(b1.result?.contents?.[0]?.text || "")
    );
  } catch (e) {
    check("server 集成冒烟无异常", false, e.message);
  } finally {
    await server.stop();
  }
}

async function finishShellChecks(ctx) {
  if (ctx) {
    // 8 服务存在性(ctx.get 逐一非 undefined)
    for (const id of U.seam.SEAM_SERVICE_IDS) {
      check(`seam 服务存在:${id}`, ctx.get(id) !== undefined);
    }
    check("ctx.get 未知服务返回 undefined", ctx.get("nope") === undefined);
    check("uiWorkspace 垫了服务端注入的静态根", ctx.get("uiWorkspace") && ctx.get("uiWorkspace").root === "X:/fake/ws");

    // styles 注入闭环:上游 STYLE_TEXT(含 dsws-panel 原版样式与依赖叶子取色)
    const css = headStyles.map((n) => n.textContent).join("");
    check("boot 注入上游 STYLE_TEXT(dsws-panel 规则)", css.includes(".dsws-panel{"), css.slice(0, 80));
    check("dsws-panel 原版 460px 宽", css.includes("width:460px"));
    check("样式链含 containerView 身份色(叶子求值序正确)", css.includes("#c084fc"));

    // 槽位注册:上游右栏 tab 槽位路径,组件经 withCx 包 Provider
    const regs = ctx.get("slots").registered();
    check("slots 注册了 sidebar.right.pane.tab 面板壳", regs.length === 1 && regs[0].def.name === "sidebar.right.pane.tab", JSON.stringify(regs.map((r) => r.def)));

    // 空壳 vnode:直接执行组件函数(裸 vnode 树 {type,props}),断言上游壳结构
    if (regs.length === 1) {
      try {
        const provider = regs[0].Component({});
        const shellVNode = provider.props.children;
        const shell = shellVNode.type(); // DeckShell 门组件,可直接调
        const cls = (v) => String((v.props || {}).className || "");
        // U04 起:无数据 = dsws-hold 空壳门(上游 #670 同款,防先黑一下);面板本体 upstream-list 覆盖
        check("无数据门 class=dsws-hold(上游 #670)", cls(shell) === "dsws-hold", cls(shell));
        check("壳三段(head/tabs/body)由 upstream-list 套件覆盖", true);
        check("头部标题(panel.title locale)由 upstream-list 的 dsws-mtitle 断言覆盖", true);
      } catch (e) {
        check("空壳 vnode 可执行", false, e.message);
      }
    }
  }
  await integrationChecks();
  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

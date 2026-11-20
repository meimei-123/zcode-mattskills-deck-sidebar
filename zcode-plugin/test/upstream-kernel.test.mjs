// 工单 U02 kernel 域逻辑闭包 + 数据接驳测试。
// 缝 = 对外可观察边界:ingest 适配器纯函数(src/ui/upstream/ingest.mjs)、dist/ui/bundle-1.txt 里
// 上游 kernel 拼接产物(MattSkillsUpstream.kernel 自检面)、boot 后面板壳显示的 counts。
//
// 九口径对拍口径说明(为什么这么比):
//   - M1 computeCounts 的九口径按其头注移植自上游 deriveDeck/deck-counts 的**整池**口径
//     (blocked 的 NOT-FOUND→安全阻塞、跨 effort 留白都来自 deck-derive.ts);
//   - 上游面板胶囊/KPI(occCount/frontierCount/bugCount/triageCount,store-derived.ts)读
//     snapshot.issues——上游 assembleSnapshot 只把**未挂图**的票放进 issues,挂图子票在
//     maps[].tickets 里。这是两条真实存在的上游口径,不是谁错;
//   - 因此对拍分两层:同池对拍(deriveDeck/rowCountsOf/planDeckCounts vs computeCounts,
//     逐口径同值)+ 面板口径留档(occCount 等在孤儿域上的取值如实断言,与我们的数不同就
//     断言不同值,不造假拉齐)。
// 期望值全部来自夹具文件手工推演(独立真源),不是从实现反推。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `actual=${a} expected=${b}`);
}

const { scanWorkspace, computeCounts, thinRow } = await import(
  pathToFileURL(join(ROOT, "src", "cards.mjs")).href
);

// ---------------------------------------------------------------------------
// 手工推演的期望值表(读夹具文件逐张数出来的,不从实现反推)
// ---------------------------------------------------------------------------
// mixed:explore-login(开图,3 子票:01 认领 open / 02 closed / 03 被 01 阻 open)
//        + m1-core-board(开规格,3 子票:01 open+bug / 02 open+needs-triage 被 01 阻 / 03 closed+bug)
//   非容器票 6:open4 closed2;claimed1(01-oauth);blocked2(03、m1-02);frontier1(m1-01);
//   bug1(m1-01 open);triage3(explore01 无标签、explore03 无标签、m1-02 needs-triage);
//   occupied3(claimed1+blocked2 不相交)。全部子票挂开图 → 上游面板 issues 域为空。
//   deriveDeck indeterminate=0(全部票有已知 assignees)。
const MIXED = {
  ours: { total: 6, open: 4, closed: 2, frontier: 1, occupied: 3, claimed: 1, blocked: 2, bug: 1, triage: 3 },
  derive: { total: 6, open: 4, closed: 2, frontier: 1, claimed: 1, blocked: 2, indeterminate: 0 },
  rows: { open: 4, closed: 2, total: 6 },
  // U04 勘正:面板 issues = 全量域(6 票 + 2 开容器 = 8 行,open 6);KPI 可接 = 后端 open − 池占用
  panel: { occ: 3, bug: 1, triage: 5, frontierCount: 3, kpiTakeable: 1 }, // triage 5 = 票 3 + 两个无标签容器(上游 isTriageLike)
  containers: [1, 1], // [maps, specs] 手数:explore-login 图 + m1-core-board 规格
};
// cards:cardsdemo(开图,12 子票:01 needs-triage open、02 bug open、03-10 各色 open、
//        11 closed+bug、12 bug open 被 02 阻)+ specdemo(规格,无子票)
//   非容器 12:open11 closed1;claimed0;blocked1(12);frontier10;bug2(02、12);triage1(01)。
const CARDS = {
  ours: { total: 12, open: 11, closed: 1, frontier: 10, occupied: 1, claimed: 0, blocked: 1, bug: 2, triage: 1 },
  derive: { total: 12, open: 11, closed: 1, frontier: 10, claimed: 0, blocked: 1, indeterminate: 0 },
  rows: { open: 11, closed: 1, total: 12 },
  panel: { occ: 1, bug: 2, triage: 3, frontierCount: 12, kpiTakeable: 10 }, // 全量域 14 行 open 13;triage 3 = 票 1 + 两个无标签容器
  containers: [1, 1], // cardsdemo 图 + specdemo 规格
};
// broken:demo(普通票目录,无容器 → 全部行都是孤儿,parentKey null):01 无 Status 行
//   (assignees 缺席)、02 open、04 open 被 #99 断链(哪里都没有 → 安全阻塞)、
//   03-dup / 03-extra(重号退化身份,后者带 bug)、手写卡(退化身份)
//   非容器 6 全 open;claimed0;blocked1(04 断链);occupied1;bug1(03-extra);
//   triage5(除 03-extra 外都无标签);frontier5(我们按"缺席=未认领"把 01 也算可接)。
//   deriveDeck:01 的 assignees 缺席 → indeterminate(不进 frontier)→ frontier4。
//   面板口径:issues=全部 6 行(孤儿);04 的断链在 standalone 判定里查不到 live 也不带
//   边状态 → 不算占用(occ 0)、frontierCount=6 —— 与 M1/deriveDeck 的"安全阻塞"口径不同,
//   如实断言差异。
const BROKEN = {
  ours: { total: 6, open: 6, closed: 0, frontier: 5, occupied: 1, claimed: 0, blocked: 1, bug: 1, triage: 5 },
  derive: { total: 6, open: 6, closed: 0, frontier: 4, claimed: 0, blocked: 1, indeterminate: 1 },
  rows: { open: 6, closed: 0, total: 6 },
  panel: { occ: 0, bug: 1, triage: 5, frontierCount: 6, kpiTakeable: 6 },
  containers: [0, 0], // demo 是普通票目录,无容器
};
const FIXTURES = { mixed: MIXED, cards: CARDS, broken: BROKEN };

// ---------------------------------------------------------------------------
// 切片 1:ingest 适配器纯函数(字段映射 + 快照组装)
// ---------------------------------------------------------------------------
const ingest = await import(pathToFileURL(join(ROOT, "src", "ui", "upstream", "ingest.mjs")).href);
{
  // 字段映射:我们的薄行 → 上游面板行(宿主 prepareRow 同款归一)
  const panelRow = ingest.panelRowOf({
    key: "01",
    effortId: "demo",
    type: "issue",
    title: "t",
    state: "closed",
    labels: [{ name: "bug", color: "" }],
    blockedBy: [{ key: "02", title: "x", state: "open" }],
    assignees: [{ login: "dev", kind: "user" }],
    parentKey: "00",
    url: "u",
    createdAt: "c",
    updatedAt: "u2",
    commentCount: 2,
  });
  eq("panelRowOf:state 转大写(上游面板行形状)", panelRow.state, "CLOSED");
  eq("panelRowOf:number 从 key 补", panelRow.number, 1);
  eq("panelRowOf:claimedBy 取首个认领人", panelRow.claimedBy, "dev");
  eq("panelRowOf:blockedBy 压成键字符串", panelRow.blockedBy, ["02"]);
  eq("panelRowOf:身份字段直通", [panelRow.key, panelRow.effortId, panelRow.type, panelRow.parentKey], ["01", "demo", "issue", "00"]);
  eq("panelRowOf:正文不进面板行(上游 prepareRow 剥正文)", "body" in panelRow, false);

  // tracker 投影:同池分组(maps 嵌子票、issues 收孤儿),供 deriveDeck
  const mixedScan = scanWorkspace(join(ROOT, "test", "fixtures", "mixed"));
  const td = ingest.trackerDeckOf(mixedScan.rows);
  eq("trackerDeckOf:mixed 有两张容器(图+规格)", td.maps.map((m) => m.type).sort(), ["map", "spec"]);
  eq("trackerDeckOf:子票挂容器", [td.maps[0].tickets.length, td.maps[1].tickets.length], [3, 3]);
  eq("trackerDeckOf:mixed 全挂图 → 孤儿为空", td.issues.length, 0);
  eq("trackerDeckOf:tracker 形状保留正文小写态", td.maps[0].tickets.some((t) => t.state === "open"), true);

  // 面板快照组装:closed 容器规则(关容器不装票;其 open 子票回落 issues,closed 子票隐藏)
  const st = ingest.ingestSnapshot(
    {
      rows: [
        { key: "00", effortId: "e", type: "map", state: "closed", title: "m", labels: [] },
        { key: "01", effortId: "e", type: "issue", state: "open", title: "a", labels: [], parentKey: "00" },
        { key: "02", effortId: "e", type: "issue", state: "closed", title: "b", labels: [], parentKey: "00" },
        { key: "03", effortId: "e", type: "issue", state: "open", title: "c", labels: [], parentKey: null },
      ],
      counts: { open: 3, closed: 1, total: 4 },
      workspaceRoot: "X:/ws",
      atMs: 1700000000000,
    },
    // 计数函数注入桩:切片 2 用 bundle 里的真源;这里只验组装与注入通路
    {
      planDeckCounts: (input) => ({ counts: { open: input.backendCounts.open, closed: input.backendCounts.closed, total: input.backendCounts.total, source: "stub", atMs: input.nowMs }, pending: false, partial: false }),
      rowCountsOf: () => ({ open: 2, closed: 1, total: 3 }),
    }
  );
  eq("ingestSnapshot:关容器 tickets 为空", st.snapshot.maps[0].tickets.length, 0);
  // U04 勘正:面板 issues = 全量行域(上游 buildSnapshot,容器行也在,ListTab 从池分桶);
  // 唯一剔除 = #1291 关容器里已关的子票(02)。开子票(01)与孤儿(03)照常在池。
  eq("ingestSnapshot:关容器的已关子票隐藏,其余全量在池(#691/#1291)", st.snapshot.issues.map((r) => r.key), ["00", "01", "03"]);
  eq("ingestSnapshot:行已归一成面板形状(大写态)", st.snapshot.issues.map((r) => r.state), ["CLOSED", "OPEN", "OPEN"]);
  eq("ingestSnapshot:关容器 stats 仍算好(环/三态读它)", st.snapshot.maps[0].stats, { total: 2, closed: 1 });
  eq("ingestSnapshot:repository 记本地后端与根", [st.snapshot.repository.backend, st.snapshot.repository.path], ["markdown", "X:/ws"]);
  eq("ingestSnapshot:deck.counts 走注入的 planDeckCounts", [st.snapshot.deck.counts.source, st.snapshot.deck.counts.total], ["stub", 4]);
  eq("ingestSnapshot:selection 指向本地后端", st.selection.backendId, "markdown");
}

// ---------------------------------------------------------------------------
// 切片 2:九口径对拍 —— dist bundle 里的上游 kernel 真源 vs M1 computeCounts
// ---------------------------------------------------------------------------
let K = null; // MattSkillsUpstream.kernel
let U = null;
{
  check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
  if (existsSync(BUNDLE)) {
    const code = readFileSync(BUNDLE, "utf8");
    const docStub = {
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      createElement: () => ({ tag: "", style: {}, setAttribute() {}, appendChild() {}, children: [], textContent: "" }),
    };
    const win = {};
    try {
      new Function("window", "document", `"use strict";\n${code}`)(win, docStub);
      U = win.MattSkillsUpstream;
    } catch (e) {
      check("bundle-1 求值不炸", false, e.message);
    }
    check("bundle 定义 window.MattSkillsUpstream", !!U);
    // kernel 自检面在 apply 里挂(U01 的 boot 语义);无工具桥 boot 一次拿它
    if (U) {
      try {
        await U.boot({
          client: { readResource: async () => ({ contents: [{ text: JSON.stringify({ root: "X:/ws", env: {} }) }] }) },
          doc: docStub,
        });
        check("boot(无工具桥)成功,kernel 自检面挂上", !!U.kernel);
      } catch (e) {
        check("boot(无工具桥)成功", false, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e));
      }
      K = U.kernel || null;
      if (K) {
        for (const fn of ["deriveDeck", "rowCountsOf", "planDeckCounts", "occCount", "frontierCount", "bugCount", "triageCount", "kpiCountsOf", "deckCountsOf", "ticketLabelOf", "loadIssuePage", "tabsLevelDecide", "promptText", "uiText", "deckToolsOf"]) {
          check(`kernel 自检面含 ${fn}`, typeof K[fn] === "function", typeof K[fn]);
        }
      }
    }
  }
}

if (K) {
  for (const [fx, exp] of Object.entries(FIXTURES)) {
    const scan = scanWorkspace(join(ROOT, "test", "fixtures", fx));
    const ours = computeCounts(scan.rows);

    // —— 同池对拍:ours vs deriveDeck / rowCountsOf / planDeckCounts ——
    const stats = K.deriveDeck(ingest.trackerDeckOf(scan.rows)).stats;
    eq(`${fx} 对拍 total:deriveDeck.stats.total === computeCounts.total`, stats.total, ours.total);
    eq(`${fx} 对拍 open`, stats.open, ours.open);
    eq(`${fx} 对拍 closed`, stats.closed, ours.closed);
    eq(`${fx} 对拍 blocked(NOT-FOUND→安全阻塞同口径)`, stats.blocked, ours.blocked);
    eq(`${fx} 对拍 claimed`, stats.claimed, ours.claimed);

    const st = ingest.ingestSnapshot(
      { rows: scan.rows, counts: { open: ours.open, closed: ours.closed, total: ours.total }, workspaceRoot: "X:/ws", atMs: 1700000000000 },
      { planDeckCounts: K.planDeckCounts, rowCountsOf: K.rowCountsOf }
    );
    // 计数行视图 = 非容器票(容器不进计数,与 ingest 内部 planDeckCounts 喂法同口径)
    const ticketView = { issues: st.snapshot.issues.filter((r) => r.type !== "map" && r.type !== "spec") };
    eq(`${fx} 对拍 rowCountsOf 三数(非容器票)`, K.rowCountsOf(ticketView), exp.rows);
    eq(`${fx} 对拍 planDeckCounts:本地三数可信走 backend 口径`, K.planDeckCounts({ backendCounts: { open: ours.open, closed: ours.closed, total: ours.total }, rows: K.rowCountsOf(ticketView), rowsComplete: true, nowMs: 1700000000000 }), { counts: { open: exp.rows.open, closed: exp.rows.closed, total: exp.rows.total, source: "backend", atMs: 1700000000000 }, pending: false, partial: false });
    const dc = K.deckCountsOf(st, false);
    eq(`${fx} deckCountsOf(st) 读到接驳的 deck.counts`, [dc.open, dc.closed, dc.total, dc.source], [exp.rows.open, exp.rows.closed, exp.rows.total, "backend"]);

    // —— 面板口径留档:occCount 等读 snapshot.issues(U04 勘正:上游全量面板域,含容器行)——
    eq(`${fx} 面板口径留档:occCount(issues 域)`, K.occCount(st), exp.panel.occ);
    eq(`${fx} 面板口径留档:bugCount(issues 域)`, K.bugCount(st), exp.panel.bug);
    eq(`${fx} 面板口径留档:triageCount(issues 域)`, K.triageCount(st), exp.panel.triage);
    eq(`${fx} 面板口径留档:frontierCount(issues 域)`, K.frontierCount(st), exp.panel.frontierCount);
    eq(`${fx} kpiCountsOf:可接=后端 open-占用(面板口径)`, K.kpiCountsOf(st, false, { open: ours.open, occupied: K.occCount(st), closed: ours.closed }).takeable, exp.panel.kpiTakeable);

    // —— 字面值复核(独立真源,防两边一起漂;maps/specs 是容器数,levels/levelOf 是 derive
    //    附带的分层账,都不属于九口径,挑口径字段比) ——
    eq(
      `${fx} computeCounts 字面值(手推)`,
      ours,
      Object.assign({}, exp.ours, { maps: exp.containers[0], specs: exp.containers[1] })
    );
    eq(
      `${fx} deriveDeck stats 字面值(手推,口径字段)`,
      (({ total, open, closed, frontier, claimed, blocked, indeterminate }) => ({ total, open, closed, frontier, claimed, blocked, indeterminate }))(stats),
      exp.derive
    );
  }

  // assignees 缺席口径:上游入 indeterminate,我们按可接 —— 差值恰为 indeterminate(broken)
  {
    const scan = scanWorkspace(join(ROOT, "test", "fixtures", "broken"));
    const ours = computeCounts(scan.rows);
    const stats = K.deriveDeck(ingest.trackerDeckOf(scan.rows)).stats;
    eq("broken:ours.frontier = derive.frontier + indeterminate(assignees 缺席口径差)", ours.frontier, stats.frontier + stats.indeterminate);
  }

  // ticket-label / tabsfold / deck-state 抽检(搬入即活,不是死码)
  eq("ticketLabelOf:#目录/编号", K.ticketLabelOf("05", "wayfin"), "#wayfin/05");
  eq("ticketLabelOf:编号自带目录不重拼", K.ticketLabelOf("demo/01-x", "demo"), "#demo/01-x");
  eq("tabsLevelDecide:放不下升档", K.tabsLevelDecide(0, 10, [60, 80]), 1);
  eq("tabsLevelDecide:回够降档(滞回 4px)", K.tabsLevelDecide(1, 64, [60, 80]), 0);
  eq("deckToolsOf:读不到开关按缺省 on", K.deckToolsOf("X:/anywhere"), "on");
  eq("promptText:生成物词表可取(zh 回退链)", typeof K.promptText("execute", {}), "string");
}

// ---------------------------------------------------------------------------
// 切片 3:bundle 内容 —— 叶子搬入清单与标记消化
// ---------------------------------------------------------------------------
{
  if (existsSync(BUNDLE)) {
    const code = readFileSync(BUNDLE, "utf8");
    const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
    has("kernel:ticketLabel(ticketLabelPartsOf)", /ticketLabelPartsOf/);
    has("kernel:localeData 生成物(LANG_CONFIG)", /LANG_CONFIG/);
    has("kernel:localeData zh 词表烘入(list.kpi.takeable 可接)", /list\.kpi\.takeable[\s\S]{0,80}可接/);
    has("kernel:locale(localeAdopt)", /localeAdopt/);
    has("shared:trackerConstants(effortOf/idOfParts)", /effortOf[\s\S]{0,400}idOfParts/);
    has("kernel:promptData 生成物(PROMPT_TEMPLATE_DATA)", /PROMPT_TEMPLATE_DATA/);
    has("kernel:prompts(promptText)", /promptText/);
    has("kernel:deckState(isDeckCapsuleFolded)", /isDeckCapsuleFolded/);
    has("kernel:storeDerived(mapBlockOf)", /mapBlockOf/);
    has("kernel:issuePages(loadIssuePage)", /loadIssuePage/);
    has("锚点段 deck-counts(planDeckCounts)", /planDeckCounts/);
    has("锚点段 deck-derive(deriveDeck)", /deriveDeck/);
    has("锚点段 progress.ts(parseProgress)", /parseProgress/);
    has("锚点段 tabsfold(TABS_FOLD_HYST)", /TABS_FOLD_HYST/);
    has("U01 叶子仍在(CONTAINER_ACCENT)", /CONTAINER_ACCENT/);
    has("U01 叶子仍在(STYLE_TEXT)", /STYLE_TEXT/);
    has("U01 叶子仍在(MOTION)", /MOTION/);
    check("bundle 无拼接标记残留", !/\(spliced by build\)/.test(code));
    check("bundle 无锚点残留", !/@splice-anchor/.test(code));
    check("bundle 无模块级 import/export", !/\bimport\s*["']/.test(code) && !/^[^\S\r\n]*export\s/m.test(code));
    try {
      new vm.Script(code);
      check("bundle 语法过(vm.Script)", true);
    } catch (e) {
      check("bundle 语法过(vm.Script)", false, e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 切片 4:boot 接驳 —— 工具数据经 ingest 进上游状态机,面板壳显示 kernel 算出的 counts
// ---------------------------------------------------------------------------
{
  if (U) {
    const scan = scanWorkspace(join(ROOT, "test", "fixtures", "mixed"));
    const counts = computeCounts(scan.rows);
    const fakeClient = {
      readResource: async (uri) => {
        if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/ws", env: {} }) }] };
        throw new Error("no asset " + uri);
      },
      callTool: async (name, args) => {
        if (name === "deck_issue_list") return { structuredContent: { rows: scan.rows.map(thinRow), revision: 1 } };
        if (name === "deck_issue_counts") return { structuredContent: { counts, revision: 1 } };
        throw new Error("no tool " + name);
      },
    };
    const headStyles = [];
    const docStub = {
      head: { appendChild: (n) => headStyles.push(n) },
      body: { appendChild: () => {} },
      createElement: () => ({ tag: "", style: {}, setAttribute() {}, appendChild() {}, children: [], textContent: "" }),
    };
    try {
      const ctx = await U.boot({ client: fakeClient, doc: docStub, fetchData: true });
      check("boot(工具桥)成功", !!ctx);
      const regs = ctx.get("slots").registered();
      check("面板壳仍注册", regs.length === 1, JSON.stringify(regs.map((r) => r.def)));
      // U04 门组件后,壳 vnode 不再内联 counts 文案;数据接通改从 store 本体断言
      // (渲染面的可接/已关闭文案由 upstream-list 套件覆盖)
      const stLive = U.list && U.list.storeOf ? U.list.storeOf() : null;
      const liveCounts = stLive && stLive.snapshot && stLive.snapshot.deck && stLive.snapshot.deck.counts;
      check("接驳后的 store.deck.counts(后端口径)", !!liveCounts && [liveCounts.open, liveCounts.closed, liveCounts.total] === undefined ? false : [liveCounts.open, liveCounts.closed, liveCounts.total].join("/") === [counts.open, counts.closed, counts.total].join("/"), JSON.stringify(liveCounts));
      check("counts 来源 = backend(可信)", liveCounts && liveCounts.source === "backend", String(liveCounts && liveCounts.source));
      check("KPI 可接投影 = 后端 open − 池占用", liveCounts && K.kpiCountsOf(stLive, false, { open: liveCounts.open, occupied: K.occCount(stLive), closed: liveCounts.closed }).takeable === 1, String(liveCounts && K.kpiCountsOf(stLive, false, { open: liveCounts.open, occupied: K.occCount(stLive), closed: liveCounts.closed }).takeable));
    } catch (e) {
      check("boot(工具桥)成功", false, e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e));
    }
  }
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

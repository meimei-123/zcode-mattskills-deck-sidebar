// entry.mjs —— 上游 src/client/index.ts 的骨架裁剪段(U01 立;U02 扩 kernel 域与数据接驳)。
//
// 本文件由 build-upstream.mjs 拼接后进 bundle:
//   - `// ==== <kind>:<name> (spliced by build) ====` 标记处换上游叶子真源
//     (标记名与次序对上游 index.ts 校验,是上游标记序的保序子序列);
//   - apply 头部注入 kernel:ctx(上游 wireCtx 同位);
//   - 「@splice-anchor: trackerDeck」行是本仓自有锚点(上游无此标记):tracker 侧真源
//     (progress/deck-counts/tabsfold/deck-derive)经它注入同一闭包 —— 上游客户端闭包不含
//     这几份(宿主在服务侧消费),本仓把数据面接进闭包,不冒充上游标记名;
//   - 标记之间的装配段:上游 index.ts 已有装配段(locale/tr 回退)按原文搬;其余是本仓自有段
//     (后续工单继续换 leaf:panelAssembly 等上游叶子)。
//
// 方言(上游动态版方言同款):apply 闭包里的 React/styles/timer/h 等自由变量解析到
// 模块作用域 —— 上游由 DSH 宿主提供;本 bundle 用 preact/compat 充当 React(ADR-0002
// 修订),styles 走上游 pkg 产物同款 B2 接缝 shim。
import * as PreactCompat from "preact/compat";
import { h, render } from "preact";
import { createSeamCtx, SEAM_SERVICE_IDS } from "./seam.mjs";
import { ingestSnapshot, trackerDeckOf } from "./ingest.mjs";

const React = PreactCompat;
const styles = {
  // 上游 B2 style 接缝(pkg 方言 shim 同款):插 <style> 进 head,返回撤销器
  insert(css) {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-plugin", "zcode-mattpocock-skills-deck");
    styleEl.textContent = typeof css === "string" ? css : Array.isArray(css) ? css.join("") : String(css);
    document.head.appendChild(styleEl);
    return function () {
      try {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      } catch (e) {
        /* 忽略 */
      }
    };
  },
};

// 面板壳数据位(U02):boot 拉回工具数据后经 ingest 填入,壳渲染时读它。
const deckPanelState = { st: null };
// apply 内装配段设置的接线口(闭包内的上游 kernel 名字只有 apply 里看得见,boot 经它回调)
let showDeckDataRef = null;

function apply(ctx) {
  const slots = ctx.get("slots");
  if (slots === undefined) return;
  // ==== leaf:hostShim (spliced by build) ====
  // ==== kernel:containerView (spliced by build) ====
  // ==== kernel:ticketLabel (spliced by build) ====
  // ==== kernel:motion (spliced by build) ====
  // ==== kernel:styles (spliced by build) ====
  styles.insert(STYLE_TEXT);

  // ---- locale 段(上游 index.ts §0.5 装配段原文照搬,仅去类型标注) ----
  // ==== kernel:localeData (spliced by build) ====
  // ==== kernel:locale (spliced by build) ====
  const localeSvc = ctx.get("locale");
  if (localeSvc && typeof localeSvc.register === "function") {
    ctx.effect(function () {
      return localeAdopt(localeSvc);
    }, "dsws: locale");
  }
  const tr =
    localeSvc && typeof localeSvc.bind === "function"
      ? localeSvc.bind("dsws")
      : function (key, params) {
          // 退化用缺省语言的词表:缺省语言 id 来自生成物 LANG_CONFIG,这里不写死任何语言代码。
          const fallbackDoc = L[LANG_CONFIG.default];
          let s = fallbackDoc[key] !== undefined ? fallbackDoc[key] : key;
          if (params) s = s.replace(/\{(\w+)\}/g, function (m, name) { return name in params ? String(params[name]) : m; });
          return s;
        };

  // ---- 词表五份(票身份算法:effortOf/idOf/idOfParts/refKeyOf + 常量) ----
  // ==== shared:trackerConstants (spliced by build) ====
  // ==== kernel:promptData (spliced by build) ====
  // ==== kernel:prompts (spliced by build) ====
  // ==== kernel:deckState (spliced by build) ====
  // ==== kernel:storeDerived (spliced by build) ====
  // ==== kernel:issuePages (spliced by build) ====
  /* @splice-anchor: trackerDeck */

  // ---- U02 装配段(本仓自有) ----
  // 宿主专属名字的最小桩(上游由 DSH 宿主在闭包外提供;此处记录缺口,不删上游代码):
  //   emit/stores/shared/keyOf —— 上游宿主广播与按会话 store 表;ZCode 页签没有对应物,
  //     emit 给空广播(deck-state 写开关后的重画、issuePages 的加载通知静默),其余三名字
  //     上游叶子全部 typeof 守卫,缺席即按缺省分支走,无需占位。
  //   fetchIssuesPage —— 上游住在 kernel:apiIo(listPage 分页通路);ZCode 数据面暂无分页,
  //     回 unsupported(loadIssuePage 按上游口径记 notice='noweb',不撞)。
  const emit = function (st) {
    void st; // U02 桩:无宿主广播;数据刷新由本段 rerenderPanels 承担
  };
  const fetchIssuesPage = function (st, args) {
    void st;
    void args;
    return Promise.resolve({ ok: false, error: { kind: "unsupported", message: "ZCode 数据面暂无 listPage 分页通路(U02 桩)" } });
  };

  // Ctx 接线(上游 panelAssembly §5.11 同款,八字段冻结清单)
  const cx = createCx({
    ctx: ctx,
    h: h,
    rdom: null,
    storeSvc: null,
    localeSvc: localeSvc,
    timer: timer,
    api: null,
    router: null,
  });
  const withCx = function (Comp) {
    return function (props) {
      return h(DswsCtx.Provider, { value: cx }, h(Comp, props));
    };
  };

  // 面板壳:上游 dsws-panel 浮卡(460px、深色 --dsw-* 令牌回退值),结构对应上游 Dock 的
  // 头/页签/正文三段;U02 起正文头部显示上游 kernel 算出的 counts(checksumsOf/ListTab 的
  // 面板口径:可接 = 后端 open - 占用;占用/故障/诊断读 issues 域,见 ingest 头注与对拍测试)。
  const kpiSpan = function (num, label, color) {
    return h("span", { style: { fontSize: 11, color: color || "var(--dsw-alias-label-secondary,#a1a1aa)" } }, [
      h("b", { style: { fontWeight: 700 } }, [String(num == null ? tr("list.countsUnknown") : num)]),
      " " + label,
    ]);
  };
  const DeckShell = function () {
    const st = deckPanelState.st;
    const countsRow = st
      ? (function () {
          const dc = deckCountsOf(st, false);
          const occ = occCount(st);
          const takeable = dc ? Math.max(0, dc.open - occ) : frontierCount(st);
          return h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } }, [
            kpiSpan(takeable, tr("list.kpi.takeable"), "#4ade80"),
            kpiSpan(occ, tr("list.kpi.occupied"), "#f0883e"),
            kpiSpan(dc ? dc.closed : null, tr("list.kpi.closed"), "#52525b"),
            kpiSpan(bugCount(st), tr("nav.bug"), "#f85149"),
            kpiSpan(triageCount(st), tr("nav.triage"), "#d29922"),
          ]);
        })()
      : h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-caption,#8b8b95)" } }, [
          "U02:等待工具数据(deck_issue_list / deck_issue_counts)…",
        ]);
    return h("div", { className: "dsws-panel" }, [
      h("div", { className: "dsws-head" }, [h("span", { className: "dsws-mtitle" }, [tr("panel.title")])]),
      h("div", { className: "dsws-tabs" }),
      h("div", { className: "dsws-body" }, [
        h("div", { className: "dsws-cgroup" }, [countsRow]),
        h("div", { className: "dsws-cgroup" }, ["列表与地图由后续工单搬入"]),
      ]),
    ]);
  };
  // 挂载:上游右栏 tab 槽位路径;seam 把它渲到 surface 根
  slots.inject("sidebar.right.pane.tab", function () {
    return slots.register({ name: "sidebar.right.pane.tab", key: "zcode-mattpocock-skills-deck/deck:map" }, withCx(DeckShell));
  });

  // 数据接驳:boot 拉回工具数据后回调 —— ingest 进上游状态机,重画面板,控制台留档
  const rerenderPanels = function () {
    try {
      for (const rec of slots.registered()) {
        if (rec.container) render(h(rec.Component), rec.container);
      }
    } catch (e) {
      if (typeof console !== "undefined" && console.warn) console.warn("[upstream] 面板重画失败:", e);
    }
  };
  showDeckDataRef = function (data) {
    const st = ingestSnapshot(
      { rows: data.rows, counts: data.counts, workspaceRoot: data.workspaceRoot },
      { planDeckCounts: planDeckCounts, rowCountsOf: rowCountsOf }
    );
    deckPanelState.st = st;
    // 控制台留档(工单验收:数据接通可见) —— 同池九口径 + 面板口径一起打出
    try {
      const stats = deriveDeck(trackerDeckOf(data.rows)).stats;
      const dc = deckCountsOf(st, false);
      console.log("[upstream] kernel counts(整池 deriveDeck):", JSON.stringify(stats));
      console.log("[upstream] kernel counts(面板口径):", JSON.stringify({ takeable: dc ? Math.max(0, dc.open - occCount(st)) : null, occupied: occCount(st), closed: dc ? dc.closed : null, bug: bugCount(st), triage: triageCount(st), source: dc ? dc.source : null }));
    } catch (e) {
      if (typeof console !== "undefined" && console.warn) console.warn("[upstream] counts 留档失败:", e);
    }
    rerenderPanels();
    return st;
  };

  // kernel 自检面(工单验收:上游 kernel 算子可从外部驱动;测试与后续工单的接线口)
  window.MattSkillsUpstream.kernel = {
    // store-derived(面板派生统计)
    isTicketRow: isTicketRow, ticketRowsOf: ticketRowsOf, openIssuesOf: openIssuesOf,
    isOccupied: isOccupied, occCount: occCount, frontierCount: frontierCount,
    hasLabelOf: hasLabelOf, isTriageLike: isTriageLike, bugCount: bugCount, triageCount: triageCount,
    compute: compute, frontierAll: frontierAll, findMapByIdentity: findMapByIdentity,
    findGroupByIdentity: findGroupByIdentity, effortNamesOf: effortNamesOf, effortOptionNamesOf: effortOptionNamesOf,
    mapBlockOf: mapBlockOf, applyStandaloneBlocks: applyStandaloneBlocks, buildColorOf: buildColorOf,
    isLightHex: isLightHex, kpiCountsOf: kpiCountsOf, deckCountsOf: deckCountsOf, deckCountsPendingOf: deckCountsPendingOf,
    // deck-state(按工作区开关)
    deckToolsOf: deckToolsOf, deckStatusBarOf: deckStatusBarOf, isDeckClosed: isDeckClosed,
    isWorkspaceUnopened: isWorkspaceUnopened, isDeckCapsuleFolded: isDeckCapsuleFolded,
    setDeckTools: setDeckTools, setDeckStatusBar: setDeckStatusBar,
    // ticket-label(#目录/编号 显示)
    ticketLabelOf: ticketLabelOf, ticketLabelPartsOf: ticketLabelPartsOf,
    TICKET_LABEL_MAX_WIDTH_PX: TICKET_LABEL_MAX_WIDTH_PX, workRouteCellsFor: workRouteCellsFor,
    // issue-pages(历史票翻页)
    ISSUE_PAGE_MAX: ISSUE_PAGE_MAX, ISSUE_PAGE_LIMIT: ISSUE_PAGE_LIMIT,
    issuePageKeyOf: issuePageKeyOf, issuePageRowsOf: issuePageRowsOf, issuePageStatOf: issuePageStatOf, loadIssuePage: loadIssuePage,
    // tabsfold(页签折叠机)
    tabsLevelDecide: tabsLevelDecide, TABS_FOLD_HYST: TABS_FOLD_HYST, TABS_LEVELS: TABS_LEVELS,
    // tracker 锚点段(deck 计数与投影)
    planDeckCounts: planDeckCounts, rowCountsOf: rowCountsOf, DECK_COUNT_SOURCES: DECK_COUNT_SOURCES,
    deriveDeck: deriveDeck, parseProgress: parseProgress, DECK_DERIVE: DECK_DERIVE,
    // locale / prompts 抽检口
    uiText: uiText, langChainOf: langChainOf, promptText: promptText, promptLanguages: promptLanguages,
  };
}

// ---------------------------------------------------------------------------
// 引导(本仓自有段):panel.html 内联脚本注入本 bundle 后调 boot —— 复用同一条桥,
// 握手两拍(panel.html 侧已定);U02 起再把工具数据(deck_issue_list/counts)拉回、
// 经 ingest 喂给上游 kernel,面板壳显示 kernel 算出的 counts。
// ---------------------------------------------------------------------------
const WORKSPACE_URI = "ui://zcode-mattpocock-skills-deck/workspace.json";

async function fetchWorkspace(client) {
  if (!client || typeof client.readResource !== "function") return null;
  try {
    const r = await client.readResource(WORKSPACE_URI);
    const t = r && r.contents && r.contents[0] && r.contents[0].text;
    return t ? JSON.parse(t) : null;
  } catch (e) {
    return null; // 拿不到就垫空根
  }
}

async function fetchDeckData(client) {
  if (!client || typeof client.callTool !== "function") return null;
  try {
    const [listRes, countsRes] = await Promise.all([
      client.callTool("deck_issue_list", {}),
      client.callTool("deck_issue_counts", {}),
    ]);
    const rows = (listRes && listRes.structuredContent && listRes.structuredContent.rows) || [];
    const counts = (countsRes && countsRes.structuredContent && countsRes.structuredContent.counts) || null;
    return { rows: rows, counts: counts };
  } catch (e) {
    if (typeof console !== "undefined" && console.warn) console.warn("[upstream] 工具数据拉取失败:", e);
    return null;
  }
}

async function boot(deps) {
  const d = deps || {};
  const client = d.client || null;
  const doc = d.doc || (typeof document !== "undefined" ? document : null);
  const workspace = d.workspace || (await fetchWorkspace(client));
  // surface 根:上游面板挂宿主右栏;这里自建根元素承载(seam 把槽位组件渲进去)
  let root = d.root || null;
  if (!root && doc && doc.createElement && doc.body) {
    root = doc.createElement("div");
    root.setAttribute("id", "dsws-surface");
    doc.body.appendChild(root);
  }
  const ctx = createSeamCtx({ client: client, doc: doc, root: root, workspace: workspace });
  apply(ctx);
  // 共存纪律(panel.html 同款约定):默认只起壳不拉数据 —— 旧 UI 的桥流量(如 deck_issue_list
  // 的调用次数)是它自己的测试契约,上游壳不偷跑;fetchData:true(配置翻 on)或显式 deckData 才接数据。
  const data = d.deckData || (d.fetchData === true ? await fetchDeckData(client) : null);
  if (data && showDeckDataRef) {
    try {
      showDeckDataRef({ rows: data.rows, counts: data.counts, workspaceRoot: (workspace && workspace.root) || "" });
    } catch (e) {
      if (typeof console !== "undefined" && console.warn) console.warn("[upstream] ingest 接驳失败:", e);
    }
  }
  return ctx;
}

window.MattSkillsUpstream = {
  apply: apply,
  boot: boot,
  seam: { createSeamCtx: createSeamCtx, SEAM_SERVICE_IDS: SEAM_SERVICE_IDS },
  ingest: { ingestSnapshot: ingestSnapshot },
};

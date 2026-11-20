// entry.mjs —— 上游 src/client/index.ts 的骨架裁剪段(U01 立;U02 扩 kernel 域与数据接驳;
// U03 扩视觉层;U04 撤卡面临时挂点,列表页全家 + 页签壳上线为主视图)。
//
// 本文件由 build-upstream.mjs 拼接后进 bundle:
//   - `// ==== <kind>:<name> (spliced by build) ====` 标记处换上游叶子真源
//     (标记名与次序对上游 index.ts 校验,是上游标记序的保序子序列);
//   - apply 头部注入 kernel:ctx(上游 wireCtx 同位);
//   - 「@splice-anchor: trackerDeck」行是本仓自有锚点(上游无此标记):tracker 侧真源
//     (progress/deck-counts/tabsfold/deck-derive)经它注入同一闭包;
//   - 标记之间的装配段:上游 index.ts 已有装配段(locale/tr 回退、TYPE_ICON、
//     styles.insert(PIXEL_CARDS_STYLE_TEXT))按原文搬;其余是本仓自有段。
//
// 方言(上游动态版方言同款):apply 闭包里的 React/styles/timer/h 等自由变量解析到
// 模块作用域 —— 上游由 DSH 宿主提供;本 bundle 用 preact/compat 充当 React(ADR-0002
// 修订),styles 走上游 pkg 产物同款 B2 接缝 shim。
//
// 工单 U04 的宿主面口径(装配段里有对应注释,报告里列明):
//   - host:上游叶子对 DSH 宿主电话的出口统一是 host.call('wf.*');ZCode 这边唯一接通的是
//     wf.issuesPage(历史票翻页 → deck_issue_list 客户端分页),其余电话回 unsupported 形状;
//   - snapFresh/loadSnapshot/scheduleActionProbe/DetailsDock 四个名字是最小桩(refresh rooms
//     家族与 Dock 不搬:数据面是 boot/ingest,详情视图是 U05+)。
import * as PreactCompat from "preact/compat";
import { h, render, options as PreactOptions } from "preact";
// effect 冲刷调度兜底(U05):Preact 把 passive effect 排给 options.requestAnimationFrame,
// 环境没有 rAF 时退到内部 w2(setTimeout 档),但有「diffed 只推一次队列」的竞态——无 rAF 环境
// 里最后一轮 effect 会挂起到「下一次渲染」,而那次渲染可能永远不来(详情页改号后 fetch 不发车,
// 2026-11-20 真渲染踩到)。给 options 挂 setTimeout 兜底,真实 webview 有 rAF 时本行不生效。
try {
  if (typeof PreactOptions === "object" && PreactOptions !== null && !PreactOptions.requestAnimationFrame) {
    PreactOptions.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
  }
} catch (eOpts) { /* options 不可写时按上游原生调度走,不挡 boot */ }
import { createSeamCtx, SEAM_SERVICE_IDS } from "./seam.mjs";
import { ingestSnapshot, trackerDeckOf, panelRowOf, detailIssueOf, commentsPageOf } from "./ingest.mjs";

const React = PreactCompat;
// ReactDOM 名字给 kernel:portal 的挂顶底座(上游由宿主注入 react-dom;preact/compat 的
// createPortal 与本 bundle 的 Preact 同源,取不到时 portal 自己退化原地渲染,不抛)。
const ReactDOM = PreactCompat;
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
// 工具桥位(U04):host 适配的 wf.issuesPage 要打 deck_issue_list,boot 握到 client 后存这儿。
let clientRef = null;

function apply(ctx) {
  const slots = ctx.get("slots");
  if (slots === undefined) return;
  // localStorage 兜底(kernel:log 求值期直取;真实沙箱 allow-same-origin 下存在,Node 测试环境给内存桩)
  const localStorage = (typeof globalThis.localStorage === "object" && globalThis.localStorage) || {
    _m: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
  };
  // ---- U05 缝:详情读投影走 legacy 回滚路径(上游 #1694 自带的开关,同等支持) ----
  // 上游 snapshot 投影依赖宿主合并服务(#1690:详情取回后合并进快照行,回看走投影);ZCode
  // 数据面是 boot→ingest 的薄行,没有合并服务,快照行永远不带正文/评论(rowHasDetail 恒假,
  // 投影永不命中)。拨 legacy 后:详情缓存走 st.issueCache(命中即回指 st.issueDetail),
  // TTL 内回看不再留上一张票的 live——这正是 #1694 设计 legacy 路径要保住的行为。
  try {
    localStorage.setItem("dsws.readProjection", "legacy");
  } catch (eProj) { /* 存不进按上游默认 snapshot 走,详情仍可用(取数每次真发) */ }

  // ---- U04 宿主适配与桩(提前到首标记之前:kernel:log 等叶子在求值期就抓 host,TDZ 防护) ----
  // ---- U05 装配段(本仓自有) ----
  // 宿主适配(U04→U05):上游叶子对 DSH 宿主的电话出口统一是 host.call('wf.*')。ZCode 这边
  // 接通的有四路 —— wf.issuesPage(历史票翻页 → deck_issue_list 客户端分页,上游契约见
  // api-io.ts 的 fetchIssuesPage)、wf.issueDetail/wf.issueComments(详情正文与评论,上游
  // 契约见 api-io.ts 的 fetchIssueDetail/fetchIssueComments;#693 口径「正文与评论只认 get
  // 那次」在我们这落成「都打 deck_issue_get,评论按 after 偏移切页」)、wf.commentIssue
  // (评论提交 → deck_issue_comment 落 `### 谁 — ISO时间` 块)。其余 wf.* 电话(ZCode 数据面
  // 没有对应物)回八档里的 unsupported 形状,上游消费方按各自兜底分支走,不抛。
  const issuesPageOverList = function (args) {
    const o = args || {};
    const client = clientRef;
    if (!client || typeof client.callTool !== "function") {
      return Promise.resolve({ ok: false, error: { kind: "unsupported", message: "ZCode 宿主适配:无工具桥", raw: "" } });
    }
    const state = o.state === "open" || o.state === "closed" ? String(o.state) : "all";
    return client
      .callTool("deck_issue_list", { state: state })
      .then(function (res) {
        const rows = (res && res.structuredContent && res.structuredContent.rows) || [];
        let pool = rows.slice();
        if (o.effortId) pool = pool.filter(function (r) { return String((r && r.effortId) || "") === String(o.effortId); });
        // 页内顺序与上游「后端给什么用什么」同理:全量枚举按编号升序,稳定可复现
        pool.sort(function (a, b) { return (a && a.key ? String(a.key) : "").localeCompare(b && b.key ? String(b.key) : ""); });
        const limit = typeof o.limit === "number" && o.limit > 0 ? o.limit : 50;
        const offset = parseInt(o.cursor, 10) || 0;
        const items = pool.slice(offset, offset + limit).map(panelRowOf);
        const total = pool.length;
        const nextCursor = offset + items.length < total ? String(offset + items.length) : null;
        return { ok: true, items: items, nextCursor: nextCursor, total: total };
      })
      .catch(function (e) {
        return { ok: false, error: { kind: "network", message: String((e && e.message) || e), raw: "" } };
      });
  };
  // 详情取数(U05):wf.issueDetail → deck_issue_get + deck_issue_list 并取 —— get 给全量卡
  // (正文/评论/标签/认领),list 薄行池给子票与被阻塞邻居补边(ingest.detailIssueOf 投影,
  // number/连接形状守卫都在上游 fetchIssueDetail 消费面那头)。
  const issueDetailOverGet = function (args) {
    const o = args || {};
    const client = clientRef;
    if (!client || typeof client.callTool !== "function") {
      return Promise.resolve({ ok: false, error: { kind: "unsupported", message: "ZCode 宿主适配:无工具桥", raw: "" } });
    }
    const num = Number(o.number);
    if (isNaN(num) || num < 0) {
      return Promise.resolve({ ok: false, error: { kind: "parse", message: "invalid number", raw: "" } });
    }
    const nn = String(num).padStart(2, "0");
    const key = o.effortId ? String(o.effortId) + "/" + nn : nn;
    return Promise.all([
      client.callTool("deck_issue_get", { key: key }),
      client.callTool("deck_issue_list", { state: "all" }).catch(function () { return { structuredContent: { rows: [] } }; }),
    ])
      .then(function (pair) {
        const sc = pair[0] && pair[0].structuredContent;
        const card = sc && sc.card;
        if (!card) {
          return { ok: false, error: { kind: "parse", message: "issue missing", raw: "" } };
        }
        const rows = (pair[1] && pair[1].structuredContent && pair[1].structuredContent.rows) || [];
        return { ok: true, issue: detailIssueOf(card, rows) };
      })
      .catch(function (e) {
        return { ok: false, error: { kind: "network", message: String((e && e.message) || e), raw: "" } };
      });
  };
  // 评论分页(U05):同一张卡按 after 偏移切页(ingest.commentsPageOf;上游 wf.issueComments
  // 契约:{ok, nodes, pageInfo{hasNextPage, endCursor}})。
  const issueCommentsOverGet = function (args) {
    const o = args || {};
    const client = clientRef;
    if (!client || typeof client.callTool !== "function") {
      return Promise.resolve({ ok: false, error: { kind: "unsupported", message: "ZCode 宿主适配:无工具桥", raw: "" } });
    }
    const num = Number(o.number);
    if (isNaN(num) || num < 0) {
      return Promise.resolve({ ok: false, error: { kind: "parse", message: "invalid number", raw: "" } });
    }
    const nn = String(num).padStart(2, "0");
    const key = o.effortId ? String(o.effortId) + "/" + nn : nn;
    return client
      .callTool("deck_issue_get", { key: key })
      .then(function (res) {
        const sc = res && res.structuredContent;
        const card = sc && sc.card;
        if (!card) return { ok: false, error: { kind: "parse", message: "issue missing", raw: "" } };
        const page = commentsPageOf(card, o.after);
        return { ok: true, nodes: page.nodes, pageInfo: page.pageInfo };
      })
      .catch(function (e) {
        return { ok: false, error: { kind: "network", message: String((e && e.message) || e), raw: "" } };
      });
  };
  // 评论提交(U05):wf.commentIssue → deck_issue_comment(落 `### 谁 — ISO时间` 块,作者记
  // panel);上游契约 {ok:true, data:comment}。expectedUpdatedAt 乐观并发这层不带(面板没有
  // 并发写手时不需要;带错值反而会被拒)。
  const commentIssueOverWrite = function (args) {
    const o = args || {};
    const client = clientRef;
    if (!client || typeof client.callTool !== "function") {
      return Promise.resolve({ ok: false, error: { kind: "unsupported", message: "ZCode 宿主适配:无工具桥", raw: "" } });
    }
    const num = Number(o.number);
    if (isNaN(num) || num < 0) {
      return Promise.resolve({ ok: false, error: { kind: "parse", message: "invalid number", raw: "" } });
    }
    const nn = String(num).padStart(2, "0");
    const key = o.effortId ? String(o.effortId) + "/" + nn : nn;
    return client
      .callTool("deck_issue_comment", { key: key, body: String(o.body || ""), actor: "panel" })
      .then(function (res) {
        if (res && res.isError) {
          const text = (res.content && res.content[0] && res.content[0].text) || "comment failed";
          return { ok: false, error: { kind: "network", message: text, raw: text } };
        }
        return { ok: true, data: (res && res.structuredContent) || null };
      })
      .catch(function (e) {
        return { ok: false, error: { kind: "network", message: String((e && e.message) || e), raw: "" } };
      });
  };
  const host = {
    // ZCode 宿主适配(wf.* → 工具桥;未接的电话一律 unsupported,不抛)
    call: function (method, args) {
      if (method === "wf.issuesPage") return issuesPageOverList(args);
      if (method === "wf.issueDetail") return issueDetailOverGet(args);
      if (method === "wf.issueComments") return issueCommentsOverGet(args);
      if (method === "wf.commentIssue") return commentIssueOverWrite(args);
      if (method === "wf.chain") return envCheckOverTool(args);
      if (method === "wf.detect") return envCheckOverTool({ force: true });
      return Promise.resolve({ ok: false, error: { kind: "unsupported", message: "ZCode 宿主适配:电话 " + method + " 未接(U05)", raw: "" } });
    },
  };

  // 环境检查(工单 03):wf.chain / wf.detect → 工具桥 deck_env_check。
  //   上游 wf.chain 的回包契约是 {ok, snapshot}(probe-chain-subscription.loadChain 的消费面),
  //   形如 {steps:[{id,status,show,actions,blockedBy}], currentIndex/doneCount/...};
  //   上游 wf.detect 是「探测后端」电话,ChecksTab 的 refresh 路只用它催一次真重扫 ——
  //   两路都落同一个工具:工具每次调用都按本地事实重扫,force 语义天然成立。
  const envCheckOverTool = function (args) {
    const o = args || {};
    const client = clientRef;
    if (!client || typeof client.callTool !== "function") {
      return Promise.resolve({ ok: false, error: { kind: "unsupported", message: "ZCode 宿主适配:无工具桥", raw: "" } });
    }
    // force 只传布尔真值(工具声明 {force?: boolean});缺省不传 = 打开页签那一次的缓存优先语义,
    // 由 loadChain 在本地缓存/在途表那一段自行消化。
    const toolArgs = o.force === true ? { force: true } : {};
    return client
      .callTool("deck_env_check", toolArgs)
      .then(function (res) {
        if (res && res.isError) {
          const text = (res.content && res.content[0] && res.content[0].text) || "env check failed";
          return { ok: false, error: { kind: "internal", message: text, raw: text } };
        }
        const sc = res && res.structuredContent;
        if (!sc || sc.ok !== true || !sc.snapshot || !Array.isArray(sc.snapshot.steps)) {
          return { ok: false, error: { kind: "parse", message: "env check snapshot missing", raw: "" } };
        }
        return { ok: true, snapshot: sc.snapshot, checkedAt: sc.checkedAt };
      })
      .catch(function (e) {
        return { ok: false, error: { kind: "network", message: String((e && e.message) || e), raw: "" } };
      });
  };

  // ---- 工单 03:refresh rooms 家族不搬,装配段补两个上游名字(检查页依赖) ----
  // nowStr:上游真源在 src/refresh/rooms/client/snapshot-sync.ts:85(逐字同源)。该文件属于本轮
  //   不搬的 refresh rooms 家族;而 loadChain 成功路径里 `st.chainLoadedAt = nowStr()` 是无守卫
  //   调用(kernel:probeChain 整叶搬入),缺它 -> 抛错被 loadChain 的 catch 吞掉 -> 链快照永远
  //   落不了地(面板只剩占位)。这里只补这一个纯函数,不搬快照同步那一套。
  const nowStr = () => {
    try { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); } catch (e) { return ''; }
  };
  // refreshAll:上游真源在 src/refresh/rooms/client/refresh-timer.ts:408(不搬)。本仓最小实现,
  //   与上游的差异写在明处:只做「st.refreshing=true -> emit -> chainEventRefresh(st,'user-recheck')
  //   -> 收尾 st.refreshing=false -> emit」。上游那一段还并发 loadSnapshot、扇出同工作区组、
  //   合并快照差异 —— 本仓数据面是 boot/ingest(没有 refresh 回合、没有多会话 store 表),这些都不搬;
  //   按钮转圈由 st.refreshing 驱动(ChecksTab 里加 dsws-spin 类)。
  const refreshAll = function (st) {
    if (!st) return;
    st.refreshing = true; // #195:重查按钮必须有反应(不因上一次还挂着就锁死)
    try { emit(st); } catch (eR1) { /* 无订阅者不挡后续 */ }
    const p = typeof chainEventRefresh === "function"
      ? chainEventRefresh(st, "user-recheck")
      : loadChain(st, true, "user-recheck");
    Promise.resolve(p)
      .catch(function () { /* 失败由 loadChain 自己记录;这里只负责收圈 */ })
      .then(function () {
        st.refreshing = false;
        try { emit(st); } catch (eR2) { /* 忽略 */ }
      });
  };

  // 宿主专属名最小桩(U02 惯例;与被搬叶子的关系逐条列明,缺一即崩的点都有对应上游真源):
  //   snapFresh / loadSnapshot —— 上游住在 refresh rooms 家族(refresh-timer/snapshot-sync),
  //     服务 DSH 宿主的快照刷新;ZCode 数据面是 boot({fetchData}) → ingest,不存在「过期重拉」
  //     这条通路。页签点击时上游逻辑是 `if (!snapFresh(s)) loadSnapshot(s, false)`,桩给
  //     snapFresh=true(永远新鲜 → loadSnapshot 不被调),loadSnapshot 给无操作兜底。
  //   scheduleActionProbe —— 上游 api-io 的 inject 后排一次探测刷新(refresh-timer);ZCode 无
  //     刷新回合,给空函数(调用点 api-io inject 与 348 行的 typeof 守卫各得其所)。
  //   DetailsDock —— 上游 router 的 DeckSidebarTab 渲的是整套 Dock(U05+ 的详情/页签内容分发);
  //     本票给 null 组件占位,U05 详情视图接手后撤。
  const snapFresh = function (st) {
    void st; // U04 桩:数据面是 boot/ingest,页签点击不触发快照重拉
    return true;
  };
  const loadSnapshot = function (st, force) {
    void st;
    void force; // U04 桩:snapFresh 恒真,此函数不会被调到;留兜底防其它路径
    return Promise.resolve(null);
  };
  const scheduleActionProbe = function () {}; // U04 桩:无刷新回合
  const DetailsDock = function () {
    return null; // U04 桩:U05 详情视图挂点(行点击 setActive* 后的路由目标)
  };

  // ==== leaf:hostShim (spliced by build) ====
  // ==== shared:timeConfig (spliced by build) ====
  // ==== kernel:portal (spliced by build) ====
  // ==== kernel:containerView (spliced by build) ====
  // ==== kernel:ticketLabel (spliced by build) ====
  // ---- 工单 U04:kernel 依赖缺口(declare 差集追闭;次序 = 上游 index.ts 标记序) ----
  // ==== kernel:backendList (spliced by build) ====
  // ==== kernel:link (spliced by build) ====
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
  // ---- 会话命名(Tabs 的 + bug 预填标题;上游 shared: 片段,标记序在 icons 之前) ----
  // ==== shared:namingTitles (spliced by build) ====
  // ---- TYPE_ICON 装配行(上游 index.ts §1 段原文照搬:chips 的 TypeChip 读它) ----
  // 图标按类型分发。issue(普通票:没有 wayfinder 类型标签的票)故意没有图标 —— 徽章只出文字、灰底,
  // 前面挂一个圆点像多出来的项目符号,去掉后文字才左右对称;齿轮必须留给任务票,不让普通票兜底落进去(#626)
  const TYPE_ICON = { research: 'search', prototype: 'hammer', grilling: 'chat', task: 'gear', map: 'map' }
  // ==== kernel:icons (spliced by build) ====
  // ==== kernel:healthCheck (spliced by build) ====
  // ==== kernel:promptData (spliced by build) ====
  // ==== kernel:prompts (spliced by build) ====
  // ==== kernel:promptsBackend (spliced by build) ====
  // ==== kernel:config (spliced by build) ====
  // ==== kernel:log (spliced by build) ====
  // ==== shared:refreshBudget (spliced by build) ====
  // ==== kernel:storePrefs (spliced by build) ====
  // ==== kernel:deckState (spliced by build) ====
  // ==== kernel:storeSnapshot (spliced by build) ====
  // ==== kernel:workRouteOwn (spliced by build) ====
  // ==== kernel:storeDerived (spliced by build) ====
  // ==== kernel:rowActions (spliced by build) ====
  // ==== kernel:detailTopGate (spliced by build) ====
  // ==== kernel:probeChain (spliced by build) ====
  // ==== kernel:probeSnapshotHelpers (spliced by build) ====
  // ==== kernel:router (spliced by build) ====
  // ==== kernel:entryCard (spliced by build) ====
  // ==== kernel:entryChoice (spliced by build) ====
  // ==== kernel:apiNewSession (spliced by build) ====
  // ==== kernel:apiIo (spliced by build) ====
  // ==== kernel:issuePages (spliced by build) ====
  // ==== kernel:actions (spliced by build) ====
  /* @splice-anchor: trackerDeck */

  // ---- 视觉小件 + cards 家族(工单 U03;上游 index.ts 标记序原位) ----
  // ==== leaf:chips (spliced by build) ====
  // ==== leaf:tipPlace (spliced by build) ====
  // ==== leaf:hoverTip (spliced by build) ====
  // ==== leaf:tip (spliced by build) ====
  // ==== leaf:ticketBadge (spliced by build) ====
  // ==== leaf:openFolder (spliced by build) ====
  // ==== leaf:liquidInk (spliced by build) ====
  // ==== leaf:pixelBtn (spliced by build) ====
  // ==== leaf:pixelDot (spliced by build) ====
  // ==== leaf:pixelNum (spliced by build) ====
  // ==== leaf:pixelStateIcon (spliced by build) ====
  // ==== leaf:pixelSeal (spliced by build) ====
  // ==== leaf:pixelSkeleton (spliced by build) ====
  // ==== leaf:pixelBanner (spliced by build) ====
  // ==== leaf:pixelStatusLine (spliced by build) ====
  // ==== leaf:cardsTheme (spliced by build) ====
  // ==== leaf:cardsStyles (spliced by build) ====
  // ==== leaf:cardPin (spliced by build) ====
  // ==== leaf:cardTitle (spliced by build) ====
  // ==== leaf:cardNo (spliced by build) ====
  // ==== leaf:cardTags (spliced by build) ====
  // ==== leaf:cardNote (spliced by build) ====
  // ==== leaf:cardFoot (spliced by build) ====
  // ==== leaf:cardStamp (spliced by build) ====
  // ==== leaf:blockedChrome (spliced by build) ====
  // ==== leaf:cardBtns (spliced by build) ====
  // ==== leaf:mapDots (spliced by build) ====
  // ==== leaf:cardHead (spliced by build) ====
  // ==== leaf:issueCard (spliced by build) ====
  // ==== leaf:issueMapCard (spliced by build) ====
  // ==== leaf:mapCard (spliced by build) ====
  styles.insert(PIXEL_CARDS_STYLE_TEXT);

  // ---- 列表页全家 + 页签壳(工单 U04;上游 index.ts 标记序原位) ----
  // 链渲染器通用件(工单 03;上游标记序在 tabs 之前、checksums 之后 —— 本仓跳过 checksums 保序)
  // ==== leaf:chainRenderer (spliced by build) ====
  // ==== leaf:tabs (spliced by build) ====
  // ==== leaf:truthLines (spliced by build) ====
  // ==== leaf:fallbackMark (spliced by build) ====
  // ==== leaf:workRouteTable (spliced by build) ====
  // ==== leaf:md (spliced by build) ====
  // ==== leaf:ticket (spliced by build) ====
  // ==== leaf:stateKind (spliced by build) ====
  // ==== leaf:ticketRow (spliced by build) ====
  // ==== leaf:detailActionBar (spliced by build) ====
  // ==== leaf:detailProjection (spliced by build) ====
  // ==== leaf:issueDetailErrorView (spliced by build) ====
  // ==== leaf:subIssueRouting (spliced by build) ====
  // ==== leaf:IssueDetailComments (spliced by build) ====
  // ==== leaf:issueDetailFold (spliced by build) ====
  // ==== leaf:useIssueDetailFold (spliced by build) ====
  // ==== leaf:IssueDetail (spliced by build) ====
  // ==== leaf:tagsFit (spliced by build) ====
  // ==== leaf:pop (spliced by build) ====
  // ==== leaf:noRepoCard (spliced by build) ====
  // ==== leaf:setupCard (spliced by build) ====
  // ==== leaf:ListTabClosed (spliced by build) ====
  // ==== leaf:ListTabRow (spliced by build) ====
  // ==== leaf:listFilterRow (spliced by build) ====
  // ==== leaf:mdEffortRow (spliced by build) ====
  // ==== leaf:listTab (spliced by build) ====
  // 环境检查页本体(工单 03;上游标记序在 listTab 之后:#284 起链快照唯一渲染)
  // ==== leaf:checksTab (spliced by build) ====

  // Ctx 接线(上游 panelAssembly §5.11 同款,八字段冻结清单;router 接真源 store-prefs)
  const cx = createCx({
    ctx: ctx,
    h: h,
    rdom: null,
    storeSvc: null,
    localeSvc: localeSvc,
    timer: timer,
    api: null,
    router: { setActiveIssue: setActiveIssue, setActiveMap: setActiveMap, pushNav: pushNav, panelClock: panelClock },
  });
  const withCx = function (Comp) {
    return function (props) {
      return h(DswsCtx.Provider, { value: cx }, h(Comp, props));
    };
  };

  // ---- 主视图(工单 U04:页签壳 + KPI 头 + 筛选 + 三段列表 + 关闭票折叠,全部来自上游叶子;
  //      U03 的卡面临时挂点在此撤销,卡面组件仍经 cards 自检面供给;工单 03 起「环境检查」
  //      页签也接真视图:ChecksTab 的链快照唯一渲染;#284 起九格 wf.status 视图已退役,不恢复) ----
  // 结构对上游 panel/Dock.ts 的头部三段:dsws-head(标题)/dsws-tabs(useTabsRow 的墨块 + 页签
  // 与 wayfinder、bug 入口、EntryChooser)/dsws-body(按 st.tab 分发;本票只有 list 是真视图,
  // 其余页签占位待后续工单搬入)。
  // 门组件(上游 #670 同款):无数据先画 dsws-hold 空壳,有数据才挂 DeckBody ——
  // hooks(useTabsRow 等)只在 DeckBody 里调,渲染次数变化不破坏 hook 次序。
  const DeckShell = function () {
    if (!deckPanelState.st) return h("div", { className: "dsws-hold" });
    return h(DeckBody, null);
  };
  const DeckBody = function () {
    const st = deckPanelState.st;
    const [, setTick] = React.useState(0);
    React.useEffect(function () {
      // emit→重画已由骨架层 sub(st, rerenderPanels) 承担(U04);组件内再订阅会双渲染竞态
      return undefined;
    }, [st]);
    const tabsRef = React.useRef(null);
    const tabs = st ? useTabsRow(st, tabsRef) : { items: [] };
    const narrow = false;
    return h("div", { className: "dsws-panel" }, [
      h("div", { className: "dsws-head" }, [h("span", { className: "dsws-mtitle" }, [tr("panel.title")])]),
      h(
        "div",
        { className: "dsws-tabs dsws-ink-host", ref: function (el) { tabsRef.current = el; tabs.inkHostRef.current = el; }, style: { padding: "0 12px 7px", borderBottom: "1px solid var(--dsw-alias-border-l1,#2a2d35)", flex: "none", display: "flex", alignItems: "center", gap: 4 } },
        [tabs.inkEl].concat(tabs.items)
      ),
      h("div", { className: "dsws-body" }, [
        !st
          ? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-caption,#8b8b95)" } }, ["U04:等待工具数据(deck_issue_list / deck_issue_counts)…"])
          : st.tab === "list"
            ? (function () {
                // 上游 Dock 的内容分发(#552 渲染优先级读导航栈顶):issue 层挂 IssueDetail,
                // map 层是 mapV2 家族(本仓未搬,U06+ 候选),栈空回 ListTab。
                const navTop = typeof peekNav === "function" ? peekNav(st) : null;
                const topIssue = navTop && navTop.kind === "issue" ? navTop.n : st.activeIssue;
                const topMap = navTop && navTop.kind === "map" ? navTop.n : st.activeMap;
                if (topIssue !== null && topIssue !== undefined) return h(IssueDetail, { st: st });
                if (topMap !== null && topMap !== undefined)
                  return h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-caption,#8b8b95)", padding: "14px 0", textAlign: "center" } }, ["地图详情页:mapV2 家族未搬(U06+ 候选)"]);
                return h(ListTab, { st: st, narrow: narrow });
              })()
            : st.tab === "checks"
              ? h(ChecksTab, { st: st })
              : h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-caption,#8b8b95)", padding: "14px 0", textAlign: "center" } }, [tr("panel.tab" + (st.tab === "skills" ? "Skills" : "Pr")) + " 页:U06+ 搬入"]),
      ]),
    ]);
  };
  // 挂载:上游右栏 tab 槽位路径;seam 把它渲到 surface 根
  slots.inject("sidebar.right.pane.tab", function () {
    return slots.register({ name: "sidebar.right.pane.tab", key: "zcode-mattpocock-skills-deck/deck:map" }, withCx(DeckShell));
  });

  // 数据接驳:boot 拉回工具数据后回调 —— ingest 进上游状态机(makeStore 的上游初值 + 面板快照,
  // snapMode 拨 real),重画面板,控制台留档。
  // U05:重画按微任务合批(defer + 脏位)。上游真机 emit→React setState 天然异步;本仓若同步
  // 直渲,fetchIssueDetail 缓存命中路径的同步 emit(issueMode='real')会与 effect 冲刷互相
  // 嵌套(fetch→emit→render→effect→fetch…)直至栈溢出。合批后 emit 风暴只触发一帧重画,
  // 语义与上游一致(测试侧 tick/settle 等待覆盖微任务时序)。
  let rerenderQueued = false;
  const rerenderPanels = function () {
    if (rerenderQueued) return;
    rerenderQueued = true;
    Promise.resolve().then(function () {
      rerenderQueued = false;
      try {
        for (const rec of slots.registered()) {
          if (rec.container) render(h(rec.Component), rec.container);
        }
      } catch (e) {
        if (typeof console !== "undefined" && console.warn) console.warn("[upstream] 面板重画失败:", e);
      }
    });
  };
  showDeckDataRef = function (data) {
    const st = Object.assign(makeStore(), ingestSnapshot(
      { rows: data.rows, counts: data.counts, labels: data.labels, workspaceRoot: data.workspaceRoot },
      { planDeckCounts: planDeckCounts, rowCountsOf: rowCountsOf }
    ));
    st.snapMode = "real"; // 快照已到手(上游 hydrateFromCache 同款拨位)
    st.workspaceRoot = data.workspaceRoot || st.cwd;
    // U05:注入通道 —— 上游 inject(st, text) 读 st.injector(缺席时降级复制到剪贴板);
    // ZCode 等价物 = ui/message 桥发进当前对话(与旧 UI 动作栏同一条桥)。
    try {
      if (clientRef && typeof clientRef.sendMessage === "function") {
        st.injector = function (text) { clientRef.sendMessage(text); };
      }
    } catch (eInj) { /* 桥缺席时上游自己降级 copyText,不挡 boot */ }
    deckPanelState.st = st;
    // emit→重画订阅挂在骨架层(不等组件 useEffect:上游面板在组件里订阅,本骨架单壳等价、更稳)
    try { sub(st, rerenderPanels); } catch (eSub) { /* 订阅失败不挡首渲 */ }
    // 控制台留档(工单验收:数据接通可见) —— 同池九口径 + 面板口径一起打出
    try {
      const stats = deriveDeck(trackerDeckOf(data.rows)).stats;
      const dc = deckCountsOf(st, false);
      const occ = occCount(st);
      console.log("[upstream] kernel counts(整池 deriveDeck):", JSON.stringify(stats));
      console.log("[upstream] kernel counts(面板口径):", JSON.stringify({ takeable: dc ? Math.max(0, dc.open - occ) : null, occupied: occ, closed: dc ? dc.closed : null, bug: bugCount(st), triage: triageCount(st), source: dc ? dc.source : null }));
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

  // 视觉层自检面(工单 U03;视图层的接口约定):
  //   cards.PixelIssueCard / PixelIssueMapCard / PixelMapCard —— 三张大卡组件(props 契约见
  //     上游 views/cards/cardProps.d.ts,全字段可选);
  //   cards.atoms —— 共享小件(Pin/Title/No/Tags/Note/Foot/角标与封条/按钮组/点墙/卡头);
  //   cards.theme —— 主题纯函数(CARD_ACTION_COLORS/CARD_ACTION_STYLE/cardColorOf/cardLum/
  //     cardInkOn/cardBoostOn);
  //   cards.widgets —— 其余视觉小件(pixel* 八件、chips 的 Dot/TypeChip、HoverTip/Tip、
  //     ticketBadgeOf、liquidInk 常量、kernel:icons 的 Ic/Icon);
  //   cards.renderInto(Component, container, props) —— 挂载助手:闭包内 Preact 的 h/render
  //     加 DswsCtx 接线一并带上,视图层拿卡往任意容器挂列表即可,不必再碰 Preact 实例。
  window.MattSkillsUpstream.cards = {
    PixelIssueCard: PixelIssueCard,
    PixelIssueMapCard: PixelIssueMapCard,
    PixelMapCard: PixelMapCard,
    atoms: {
      PixelCardHead: PixelCardHead, PixelCardPin: PixelCardPin, PixelCardTitle: PixelCardTitle,
      PixelCardNo: PixelCardNo, PixelCardTags: PixelCardTags, PixelCardNote: PixelCardNote,
      PixelCardFoot: PixelCardFoot, PixelCornerMark: PixelCornerMark, PixelInlineSign: PixelInlineSign,
      PixelClosedSeal: PixelClosedSeal, PixelBlockedSeal: PixelBlockedSeal, PixelBlockerChip: PixelBlockerChip,
      PixelDimVeil: PixelDimVeil, PixelCardIcon: PixelCardIcon, PixelCardBtns: PixelCardBtns,
      PixelMapDots: PixelMapDots, PixelMapStats: PixelMapStats, PixelMapCorner: PixelMapCorner,
    },
    theme: {
      CARD_ACTION_COLORS: CARD_ACTION_COLORS, CARD_ACTION_STYLE: CARD_ACTION_STYLE,
      cardColorOf: cardColorOf, cardLum: cardLum, cardInkOn: cardInkOn, cardBoostOn: cardBoostOn,
    },
    widgets: {
      PixelBtn: PixelBtn, PixelDot: PixelDot, PixelNum: PixelNum, PixelStateIcon: PixelStateIcon,
      PixelSeal: PixelSeal, PixelSkeleton: PixelSkeleton, PixelBanner: PixelBanner, PixelStatusLine: PixelStatusLine,
      Dot: Dot, TypeChip: TypeChip, chipProps: chipProps, chipKeyDown: chipKeyDown,
      HoverTip: HoverTip, Tip: Tip, ticketBadgeOf: ticketBadgeOf,
      LIQUID_INK_CLASS: LIQUID_INK_CLASS, liquidInkPlace: liquidInkPlace, useLiquidInk: useLiquidInk,
      Ic: Ic, Icon: Icon, TYPE_ICON: TYPE_ICON, computeTipPlace: computeTipPlace,
    },
    renderInto: function (Component, container, props) {
      render(h(withCx(Component), props || {}), container);
    },
  };

  // 列表层自检面(工单 U04;U05 详情视图的接口约定):
  //   list.ListTab —— 主列表组件(props {st, narrow});list.useTabsRow —— 页签行 hook;
  //   list.rowHelpers —— 行渲染三件(listIssueRow/TicketRow/listFilterRowNode/closedPagesNode/
  //     mdEffortRowNode/truthNoticeLines)供 U05+ 详情页复用;
  //   list.storeOf() —— 面板 store(deckPanelState.st;boot 接驳后非空);
  //   list.renderInto —— 与 cards.renderInto 同款挂载助手。
  window.MattSkillsUpstream.list = {
    ListTab: ListTab,
    useTabsRow: useTabsRow,
    rowHelpers: {
      listIssueRow: listIssueRow, TicketRow: TicketRow, listFilterRowNode: listFilterRowNode,
      closedPagesNode: closedPagesNode, mdEffortRowNode: mdEffortRowNode, truthNoticeLines: truthNoticeLines,
      setActiveIssue: setActiveIssue, setActiveMap: setActiveMap, pushNav: pushNav,
    },
    storeOf: function () {
      return deckPanelState.st;
    },
    // 上游点击记忆是闭包级内存表(store-prefs 的 labelClicks,非 st 字段);经此读给缝 2 断言
    labelClicksOf: function () {
      return labelClicks;
    },
    renderInto: function (Component, container, props) {
      render(h(withCx(Component), props || {}), container);
    },
  };
  //   detail —— 工单 U05 详情页接口:视图组件、投影/门禁/折叠纯函数与路由动作
  //     (缝 2 断言与 U06 对照走它,不经内部名)。
  window.MattSkillsUpstream.detail = {
    IssueDetail: IssueDetail,
    DetailActionBar: DetailActionBar,
    detailTopGate: detailTopGate,
    detailViewFor: detailViewFor,
    knownBlockedNodes: knownBlockedNodes,
    issueDetailFoldLadderOf: issueDetailFoldLadderOf,
    issueDetailFoldStateAt: issueDetailFoldStateAt,
    enterSubDetail: enterSubDetail,
    renderIssueDetailComments: renderIssueDetailComments,
  };
}

// ---------------------------------------------------------------------------
// 引导(本仓自有段):panel.html 内联脚本注入本 bundle 后调 boot —— 复用同一条桥,
// 握手两拍(panel.html 侧已定);fetchData:true(配置翻 on)或显式 deckData 才接数据
// (共存纪律:默认只起壳,旧 UI 的桥流量是它自己的测试契约,上游壳不偷跑)。
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
    // 标签色板(deck_issue_list_labels)单独容忍缺席:拿不到时 ingest 回落行面聚合,
    // 卡面标签墨块退缺省紫,不算失败。
    let labels = null;
    try {
      const lr = await client.callTool("deck_issue_list_labels", {});
      const sc = lr && lr.structuredContent;
      // 色板 = colors 表全体键(规范标签 + 内置 wayfinder/bug 色;bug 这类只进 colors 不进 labels 名单)
      if (sc && sc.colors && typeof sc.colors === "object") {
        labels = Object.keys(sc.colors)
          .map(function (n) { return { name: String(n), color: String(sc.colors[n] || "").replace(/^#/, "") }; })
          .filter(function (l) { return l.color !== ""; });
      }
    } catch (e2) {
      void e2; // 色板缺席走聚合兜底
    }
    return { rows: rows, counts: counts, labels: labels };
  } catch (e) {
    if (typeof console !== "undefined" && console.warn) console.warn("[upstream] 工具数据拉取失败:", e);
    return null;
  }
}

async function boot(deps) {
  const d = deps || {};
  const client = d.client || null;
  clientRef = client; // host 适配(wf.issuesPage → deck_issue_list)经它打电话
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
  const data = d.deckData || (d.fetchData === true ? await fetchDeckData(client) : null);
  if (data && showDeckDataRef) {
    try {
      showDeckDataRef({ rows: data.rows, counts: data.counts, labels: data.labels, workspaceRoot: (workspace && workspace.root) || "" });
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

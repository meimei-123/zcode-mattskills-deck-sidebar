// MattSkills 面板应用(bundle-0.txt 的源):列表 tracer 的渲染与桥调用。
// 纯脚本无 import(资源通道只搬文本,拼接后以 <script> 注入执行),经 window.MattSkillsPanel.boot
// 交给引导页/测试架驱动。对宿主只有两个依赖:client(ext-apps 桥)与 doc(DOM)。
// 类名命名空间 ms-(M1 基础卡面;完整 PixelCards 色卡体系是工单 04,届时换 cd- 体系)。
"use strict";
(function () {
  // ---- 文案(工单 09 收拢):全部界面中文单处集中在 copy.mjs(bundle 段序第一),
  // 键名按上游 copy 词表组织,为 M3 i18n 配置化留缝;本段只按键取值。 ----
  var COPY = globalThis.MattSkillsCopy;

  // 九条计数口径:顺序即胶囊条从左到右;前三枚带 KPI 色值(list-page.md KPI 行:
  // 可接 #4ade80 / 占用 #f0883e / 已关闭 #52525b)。label 是 copy 键(nav.* 家族)。
  var PILLS = [
    { key: "frontier", label: "nav.takeable", color: "#4ade80" },
    { key: "open", label: "nav.open" },
    { key: "occupied", label: "nav.occupied", color: "#f0883e" },
    { key: "claimed", label: "nav.claimed" },
    { key: "blocked", label: "nav.blocked" },
    { key: "bug", label: "nav.bug" },
    { key: "triage", label: "nav.triage" },
    { key: "closed", label: "nav.closed", color: "#52525b" },
    { key: "total", label: "nav.total" },
  ];

  // 内置默认标签色表(上游 src/tracker/rooms/markdown/index.ts defaultLabelPalette 的直拷,
  // 全仓唯一出处;票面既不在色表也没有自带色时回灰 cccccc)。
  var LABEL_COLORS = {
    "bug": "d73a4a",
    "needs-triage": "fbca04",
    "needs-info": "5319e7",
    "ready-for-agent": "0e8a16",
    "ready-for-human": "b60205",
    "wontfix": "ffffff",
    "wayfinder:map": "8b5cf6",
    "wayfinder:research": "0ea5e9",
    "wayfinder:prototype": "f59e0b",
    "wayfinder:grilling": "9d7cd8",
    "wayfinder:task": "10b981",
  };
  function labelColorOf(name) {
    return LABEL_COLORS[name] || "cccccc";
  }

  // PixelCards 域(工单 04,src/ui/cards.mjs;拼接进 bundle 后挂 globalThis)。
  var Cards = globalThis.MattSkillsCards || {};
  // 页面 colorOf 表:标签配置色 + implement 档塞规格身份色(pixel-cards.md §1)。
  var COLOR_OF = Object.assign({}, LABEL_COLORS, { implement: Cards.CONTAINER_ACCENT ? Cards.CONTAINER_ACCENT.spec.slice(1) : "1D4ED8" });

  // ---- 小工具 ----
  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function textOf(res) {
    if (res && Array.isArray(res.content)) {
      for (var c of res.content) if (c && c.type === "text" && c.text) return c.text;
    }
    return "";
  }
  /** 卡的显示编号:#effort/编号(根级无目录前缀);退化身份的 key 已带目录前缀,不重复拼。 */
  function numberText(row) {
    var key = String(row.key || "");
    if (key.includes("/")) return "#" + key;
    return "#" + (row.effortId ? row.effortId + "/" : "") + key;
  }
  /** 组内排序主键:编号尾数字(退化身份取文件名段里的数字,取不到按 0)。 */
  function numOf(row) {
    var m = /(\d+)\s*$/.exec(String(row.key || ""));
    return m ? parseInt(m[1], 10) : 0;
  }
  /** 三段排序(list-page.md):探索地图 → 规格 → 普通票;组内编号升序,标题/目录兜底。 */
  function sortRows(rows) {
    var rank = { map: 0, spec: 1 };
    return rows.slice().sort(function (a, b) {
      var ka = rank[a.type] ?? 2;
      var kb = rank[b.type] ?? 2;
      if (ka !== kb) return ka - kb;
      var d = numOf(a) - numOf(b);
      if (d) return d;
      d = String(a.title || "").localeCompare(String(b.title || ""));
      if (d) return d;
      return String(a.effortId || "").localeCompare(String(b.effortId || ""));
    });
  }
  /** 占用口径(与 computeCounts 同义):被 open 阻塞(断链按安全阻塞)。 */
  function isBlocked(row) {
    return Array.isArray(row.blockedBy) && row.blockedBy.some(function (r) {
      return !r || r.state !== "closed";
    });
  }
  function isClaimed(row) {
    return Array.isArray(row.assignees) && row.assignees.length > 0;
  }

  // ---- 状态视图 ----
  function renderLoading(doc, root) {
    var app = el(doc, "div", "ms-app");
    app.append(el(doc, "div", "ms-state ms-loading", COPY["panel.loading"]));
    root.replaceChildren(app);
  }
  function renderError(doc, root, err) {
    var app = el(doc, "div", "ms-app");
    var box = el(doc, "div", "ms-state ms-error");
    box.append(el(doc, "div", "ms-error-title", COPY["panel.loadFail"]));
    box.append(el(doc, "div", "ms-error-detail", (err && err.message) || String(err)));
    app.append(box);
    root.replaceChildren(app);
  }
  /** 空工作区引导态(延续骨架期文案,指向建卡技能,绝不回演示数据)。 */
  function renderGuide(doc, root) {
    var app = el(doc, "div", "ms-app");
    var box = el(doc, "div", "ms-state ms-empty");
    box.append(el(doc, "h1", "ms-empty-title", COPY["panel.empty.title"]));
    var p = el(doc, "p", "ms-empty-body");
    p.append(COPY["panel.empty.body0"]);
    p.append(el(doc, "code", null, COPY["panel.empty.setup"]));
    p.append(COPY["panel.empty.mid"]);
    p.append(el(doc, "code", null, COPY["panel.empty.tickets"]));
    p.append(COPY["panel.empty.end"]);
    box.append(p);
    box.append(el(doc, "p", "ms-empty-hint", COPY["panel.empty.hint"]));
    app.append(box);
    root.replaceChildren(app);
  }

  // ---- 计数胶囊条 + 卡片行 ----
  function renderCountsBar(doc, counts) {
    var bar = el(doc, "div", "ms-counts");
    for (var p of PILLS) {
      var pill = el(doc, "span", "ms-pill" + (p.color ? " ms-kpi" : ""), COPY[p.label] + " " + (counts[p.key] ?? 0));
      pill.setAttribute("data-key", p.key);
      if (p.color) {
        pill.setAttribute("data-color", p.color);
        pill.style.color = p.color;
        pill.style.borderColor = p.color;
      }
      bar.append(pill);
    }
    return bar;
  }
  /** open 阻塞者数(断链按安全阻塞计,与 isBlocked 同口径)。 */
  function openBlockerCount(row) {
    if (!Array.isArray(row.blockedBy)) return 0;
    return row.blockedBy.filter(function (r) {
      return !r || r.state !== "closed";
    }).length;
  }
  /** 容器子票统计:同工作单元的票行 → {total, closed}(container-view 三态的输入)。 */
  function containerStatsOf(rows) {
    var stats = {};
    for (var row of rows) {
      if (row.type !== "map" && row.type !== "spec") continue;
      var s = stats[row.effortId] || (stats[row.effortId] = { total: 0, closed: 0 });
      for (var t of rows) {
        if (t.effortId === row.effortId && t.type !== "map" && t.type !== "spec") {
          s.total++;
          if (t.state === "closed") s.closed++;
        }
      }
    }
    return stats;
  }

  /** 票行动作主色:档位 → colorOf 表 → 档位兜底色。 */
  function actionHexOf(row) {
    var action = Cards.rowActionKind ? Cards.rowActionKind(row) : "execute";
    var style = (Cards.CARD_ACTION_STYLE || {})[action] || {};
    return Cards.cardColorOf ? Cards.cardColorOf(style.colorKey, COLOR_OF, action) : "8b5cf6";
  }

  /** 编号徽章(PixelCardNo):实心档底=主色、字=cardInkOn、罩纱带挂标记;描线档边=主色。 */
  function appendBadge(doc, host, row, hex) {
    var style = (Cards.CARD_ACTION_STYLE || {})[Cards.rowActionKind ? Cards.rowActionKind(row) : ""] || {};
    var badge = el(doc, "span", "ms-num cd-no");
    badge.textContent = numberText(row);
    badge.setAttribute("title", numberText(row));
    if (style.hollow) {
      badge.className += " cd-nonum line";
      badge.style.borderColor = "#" + hex;
    } else {
      badge.style.background = "#" + hex;
      badge.style.color = Cards.cardInkOn ? Cards.cardInkOn(hex) : "#1c1004";
      if (Cards.cardBoostOn && Cards.cardBoostOn(hex)) badge.setAttribute("data-cd-boost", "1");
    }
    host.append(badge);
    return badge;
  }

  /** 容器角标:身份色 chip(地图/规格);票行状态角标:BUG 三角 / 在办 / 可接。 */
  function appendCornerMark(doc, host, row, occupied) {
    if (row.type === "map" || row.type === "spec") {
      var chip = el(doc, "span", "dsws-chip dsws-chip-container " + ((Cards.CONTAINER_CHIP_CLASS || {})[row.type] || ""));
      chip.textContent = (Cards.CONTAINER_CHIP_LABEL || {})[row.type] || "";
      chip.style.color = (Cards.CONTAINER_ACCENT || {})[row.type] || "";
      host.append(chip);
      return;
    }
    var hasBug = (row.labels || []).some(function (l) {
      return l && l.name === "bug";
    });
    if (row.state === "closed") {
      // closed 票无状态角标(bug 除外)
      if (hasBug) {
        var bugC = el(doc, "span", "cd-corner", COPY["card.bug"]);
        bugC.style.color = "#d73a4a"; // --cd-mark-bug
        host.append(bugC);
      }
      return;
    }
    if (occupied) {
      var doing = el(doc, "span", "cd-ckb", COPY["card.doing"]);
      doing.style.color = "#2b62b0"; // --cd-mark-doing
      host.append(doing);
      return;
    }
    if (hasBug) {
      var bug = el(doc, "span", "cd-corner", COPY["card.bug"]);
      bug.style.color = "#d73a4a"; // --cd-mark-bug
      host.append(bug);
      return;
    }
    var ready = el(doc, "span", "cd-ckj", COPY["card.pickReady"]);
    ready.style.color = "#10b981"; // --cd-mark-ready
    host.append(ready);
  }

  function renderRow(doc, row, ctx) {
    var closed = row.state === "closed";
    var occupied = !closed && (isClaimed(row) || isBlocked(row));
    var cls = "ms-row ms-kind-" + (row.type || "issue") + " " + (closed ? "ms-closed" : "ms-open");
    if (isClaimed(row)) cls += " ms-claimed";
    if (isBlocked(row)) cls += " ms-blocked";
    var r = el(doc, "div", cls);
    r.setAttribute("data-num", numberText(row));

    // 图钉(PixelCardPin):closed 票胶带,open 票圆图钉 #c0392b
    if (closed) {
      r.append(el(doc, "span", "cd-pin-tape"));
    } else {
      var pin = el(doc, "span", "cd-pin");
      pin.style.background = "#c0392b";
      r.append(pin);
    }

    var isContainer = row.type === "map" || row.type === "spec";
    var hex = isContainer
      ? ((Cards.containerNumberColor || function () { return "#8b5cf6"; })(
          row.type,
          (Cards.containerStateOf || function () { return "open"; })((ctx.containerStats || {})[row.effortId])
        )).slice(1)
      : actionHexOf(row);
    r.setAttribute("data-cd-act", "#" + hex);
    if (isContainer) {
      // 容器行身份色:左边框 accent + 底色 tint(container-view)
      r.style.borderLeft = "3px solid " + ((Cards.CONTAINER_ACCENT || {})[row.type] || "");
      r.style.background = (Cards.CONTAINER_TINT || {})[row.type] || "";
    }

    var head = el(doc, "div", "ms-row-head");
    appendCornerMark(doc, head, row, occupied);
    appendBadge(doc, head, row, hex);
    if (closed) {
      // 结案章(PixelClosedSeal):#a3231a 底 #fff9ec 字
      var seal = el(doc, "span", "cd-sealcn", COPY["card.closedSeal"]);
      seal.style.background = "#a3231a";
      seal.style.color = "#fff9ec";
      head.append(seal);
    }
    var title = el(doc, "span", "ms-title", row.title || "");
    title.setAttribute("title", row.title || "");
    head.append(title);
    head.append(el(doc, "span", "ms-state-chip", closed ? COPY["list.state.closed"] : COPY["card.openState"]));
    r.append(head);

    // 红色脚注(PixelCardNote):被 open 阻塞时「被 {n} 挡住」
    var blockers = openBlockerCount(row);
    if (blockers > 0 && !closed) {
      r.append(el(doc, "div", "cd-note", COPY["card.blockedBy"].replace("{n}", String(blockers))));
    }

    var foot = el(doc, "div", "ms-row-foot");
    var tags = el(doc, "div", "ms-tags");
    var labels = Array.isArray(row.labels) ? row.labels : [];
    for (var lab of labels) {
      if (!lab || !lab.name) continue;
      var lhex = labelColorOf(lab.name);
      var chip = el(doc, "span", "ms-label cd-lb");
      var dot = el(doc, "span", "ms-label-dot");
      dot.setAttribute("data-color", "#" + lhex);
      dot.style.background = "#" + lhex;
      chip.append(dot);
      chip.append(lab.name);
      // 标签墨块(PixelCardTags):真实标签色实心底 + cardInkOn 字色 + 罩纱标记;边 = darken(色,.16)
      chip.style.background = "#" + lhex;
      chip.style.color = Cards.cardInkOn ? Cards.cardInkOn(lhex) : "#1c1004";
      chip.style.borderColor = Cards.darkenHex ? Cards.darkenHex(lhex, 0.16) : "";
      if (Cards.cardBoostOn && Cards.cardBoostOn(lhex)) chip.setAttribute("data-cd-boost", "1");
      tags.append(chip);
    }
    foot.append(tags);
    var marks = el(doc, "div", "ms-marks");
    if (isClaimed(row)) marks.append(el(doc, "span", "ms-mark ms-mark-claimed", COPY["card.legendClaimed"]));
    if (isBlocked(row)) marks.append(el(doc, "span", "ms-mark ms-mark-blocked", COPY["list.blocked"]));
    foot.append(marks);
    r.append(foot);
    r.addEventListener("click", function () {
      openDetail(row);
    });
    return r;
  }
  // ---- 看板视图状态(工单 04):筛选/排序/标签点击记忆/关闭票折叠,内存态 ----
  var view = {
    state: "all", // all | open | closed | blocked | frontier(list-page.md 状态组)
    sortKey: "number", // updatedAt | createdAt | number | title;默认档「编号升序」
    sortDir: 1,
    labels: [], // 标签多选 OR
    clicks: {}, // 标签点击记忆 {name:{n,ts}}
    labelsOpen: false, // 标签组展开
    closedOpen: false, // 关闭票折叠区展开
  };
  var boardData = null; // 最近一次成功加载的 {rows, counts},筛选变化时原地重渲染

  function rerender(doc, root) {
    if (!boardData) return;
    renderBoard(doc, root, boardData.rows, boardData.counts, view);
  }

  /** 筛选行(listFilterRow.md:list-page.md §2):状态紫/排序蓝/标签真实色三组墨块。 */
  function renderFilterRow(doc, rows, view) {
    var bar = el(doc, "div", "ms-filter");
    var STATE_KEYS = [
      ["all", COPY["list.state.all"]], ["open", COPY["list.state.open"]], ["closed", COPY["list.state.closed"]],
      ["blocked", COPY["list.state.blocked"]], ["frontier", COPY["list.state.frontier"]],
    ];
    var SORT_KEYS = [
      ["updatedAt", COPY["list.sort.updatedAt"]], ["createdAt", COPY["list.sort.createdAt"]],
      ["number", COPY["list.sort.number"]], ["title", COPY["list.sort.title"]],
    ];
    var sep = function () {
      return el(doc, "i", "ms-filter-sep");
    };

    // 状态组(单选):选中墨块紫(rgba(188,140,255,.18)/.6 边,#c084fc 字 = CONTAINER_ACCENT.map)
    STATE_KEYS.forEach(function (pair, i) {
      var chip = el(doc, "span", "ms-chip ms-chip-state" + (view.state === pair[0] ? " is-on" : ""), pair[1]);
      chip.setAttribute("data-state", pair[0]);
      if (view.state === pair[0]) {
        chip.style.color = (Cards.CONTAINER_ACCENT || {}).map || "#c084fc";
        chip.style.background = "rgba(188,140,255,.18)";
        chip.style.borderColor = "rgba(188,140,255,.6)";
      }
      chip.addEventListener("click", function () {
        view.state = pair[0];
        rerender(doc, doc.getElementById("root"));
      });
      bar.append(chip);
      if (i === STATE_KEYS.length - 1) bar.append(sep());
    });

    // 排序组(单选+翻转):点同键翻转 asc/desc;换键时 title 默认 asc、其余 desc
    SORT_KEYS.forEach(function (pair, i) {
      var on = view.sortKey === pair[0];
      var chip = el(doc, "span", "ms-chip ms-chip-sort" + (on ? " is-on" : ""),
        pair[1] + (on ? (view.sortDir === 1 ? " ↑" : " ↓") : ""));
      chip.setAttribute("data-sort", pair[0]);
      if (on) {
        chip.style.color = "#58a6ff";
        chip.style.background = "rgba(88,166,255,.16)";
        chip.style.borderColor = "rgba(88,166,255,.55)";
      }
      chip.addEventListener("click", function () {
        if (view.sortKey === pair[0]) view.sortDir = -view.sortDir;
        else {
          view.sortKey = pair[0];
          view.sortDir = pair[0] === "title" ? 1 : -1;
        }
        rerender(doc, doc.getElementById("root"));
      });
      bar.append(chip);
      if (i === SORT_KEYS.length - 1) bar.append(sep());
    });

    // 标签组(多选 OR):全部恒清空;普通标签真实色;默认 4 颗,+N 展开/收起
    var allChip = el(doc, "span", "ms-chip ms-chip-label ms-chip-all" + (view.labels.length === 0 ? " is-on" : ""), COPY["list.all"]);
    allChip.setAttribute("data-label", "");
    if (view.labels.length === 0) {
      allChip.style.background = "rgba(255,255,255,.08)";
      allChip.style.borderColor = "rgba(255,255,255,.65)";
    }
    allChip.addEventListener("click", function () {
      view.labels = [];
      rerender(doc, doc.getElementById("root"));
    });
    bar.append(allChip);

    var catalog = Cards.labelCatalog ? Cards.labelCatalog(rows) : new Map();
    var sortedLabels = Cards.sortLabelChips ? Cards.sortLabelChips(catalog, view.clicks) : [];
    var shown = view.labelsOpen ? sortedLabels : sortedLabels.slice(0, 4);
    shown.forEach(function (item) {
      var hex = labelColorOf(item.name);
      var known = !!LABEL_COLORS[item.name];
      var on = view.labels.indexOf(item.name) >= 0;
      var chip = el(doc, "span", "ms-chip ms-chip-label" + (on ? " is-on" : ""), item.name);
      chip.setAttribute("data-label", item.name);
      chip.style.color = known ? "#" + hex : "#bc8cff";
      chip.style.background = Cards.hexA ? Cards.hexA(hex, 0.18) : "";
      chip.style.borderColor = Cards.darkenHex ? Cards.darkenHex(hex, 0.16) : "";
      chip.addEventListener("click", function () {
        var at = view.labels.indexOf(item.name);
        if (at >= 0) view.labels.splice(at, 1);
        else view.labels.push(item.name);
        var mem = view.clicks[item.name] || (view.clicks[item.name] = { n: 0, ts: 0 });
        mem.n += 1;
        mem.ts = Date.now();
        rerender(doc, doc.getElementById("root"));
      });
      bar.append(chip);
    });
    if (sortedLabels.length > 4) {
      var more = el(doc, "span", "ms-chip ms-chip-more", view.labelsOpen ? COPY["list.collapse"] : "+" + (sortedLabels.length - 4));
      more.addEventListener("click", function () {
        view.labelsOpen = !view.labelsOpen;
        rerender(doc, doc.getElementById("root"));
      });
      bar.append(more);
    }
    return bar;
  }

  function renderBoard(doc, root, rows, counts, view) {
    var app = el(doc, "div", "ms-app ms-board");
    var head = el(doc, "div", "ms-head");
    head.append(el(doc, "span", "ms-head-title", COPY["panel.boardTitle"]));
    app.append(head);
    app.append(renderCountsBar(doc, counts));
    app.append(renderFilterRow(doc, rows, view));

    var v = Cards.applyView ? Cards.applyView(rows, view) : { openRows: rows, closedRows: [] };
    var openRows = Cards.sortViewRows ? Cards.sortViewRows(v.openRows, view.sortKey, view.sortDir) : sortRows(v.openRows);
    var closedRows = Cards.sortViewRows ? Cards.sortViewRows(v.closedRows, view.sortKey, view.sortDir) : sortRows(v.closedRows);
    var visible = view.state === "closed" ? closedRows : openRows.concat(view.closedOpen ? closedRows : []);

    var list = el(doc, "div", "ms-rows");
    var ctx = { containerStats: containerStatsOf(rows) };
    for (var row of visible) list.append(renderRow(doc, row, ctx));
    app.append(list);
    if (visible.length === 0) app.append(el(doc, "div", "ms-none", COPY["list.none"]));
    if (view.state === "all" && closedRows.length > 0) {
      var fold = el(doc, "div", "ms-closed-fold" + (view.closedOpen ? " open" : ""),
        COPY["list.closedN"].replace("{n}", String(closedRows.length)));
      if (view.closedOpen) fold.append(el(doc, "span", "ms-fold-arrow", "▾"));
      else fold.append(el(doc, "span", "ms-fold-arrow", "▸"));
      fold.addEventListener("click", function () {
        view.closedOpen = !view.closedOpen;
        rerender(doc, root);
      });
      app.append(fold);
    }
    root.replaceChildren(app);
  }

  // ---- 视图状态(工单 05):进详情后列表数据留在缓存,返回时按工单 04 的 view 状态机
  // 原样重渲染(筛选/排序/折叠状态都保留)。详情态期间轮询照跑,新数据只进缓存
  // 不打扰画面;返回列表即用上新的一批。
  var st = { client: null, doc: null, root: null, rows: [], counts: {} };
  var inDetail = false;
  function openDetail(row) {
    if (!window.MattSkillsDetail) return;
    inDetail = true;
    window.MattSkillsDetail.open({
      client: st.client,
      doc: st.doc,
      root: st.root,
      row: row,
      onBack: function () {
        inDetail = false;
        renderBoard(st.doc, st.root, st.rows, st.counts, view);
      },
    });
  }

  // ---- 实时刷新(工单 08) ----
  // 可见时按 probeIntervalMs(5s,上游活跃探测口径)轮询 counts 的 revision,变化才重拉列表;
  // document 不可见即暂停(上游黄档 120s 依赖注意力信号,M1 无此信号,不引入)。
  var POLL_MS = 5000;
  var ctx = null; // 当前引导会话 {client, doc, root}
  var pollTimer = null;
  var lastRevision; // undefined = 未知(服务端没给 revision 就不自动刷新)
  var everLoaded = false; // 初始加载失败时轮询负责静默重试,成功过就只认 revision 信号
  var loading = false;
  var queued = false; // 载入途中又触发:结束后补一轮
  var visBound = false;

  /** 拉全套数据并渲染;silent 为真时不铺加载态、失败保留已渲染内容(轮询路径)。 */
  async function reload(opts) {
    var silent = opts && opts.silent;
    var c = ctx;
    if (!c) return;
    if (!silent) renderLoading(c.doc, c.root);
    if (loading) {
      queued = true;
      return;
    }
    loading = true;
    try {
      var results = await Promise.all([
        c.client.callTool("deck_issue_list", {}),
        c.client.callTool("deck_issue_counts", {}),
      ]);
      var list = results[0];
      var counts = results[1];
      if (list && list.isError) throw Error(textOf(list) || "deck_issue_list 失败");
      if (counts && counts.isError) throw Error(textOf(counts) || "deck_issue_counts 失败");
      var listSc = (list && list.structuredContent) || {};
      var countsSc = (counts && counts.structuredContent) || {};
      everLoaded = true;
      if (countsSc.revision !== undefined) lastRevision = countsSc.revision;
      if (countsSc.empty || listSc.empty) {
        renderGuide(c.doc, c.root);
        return;
      }
      // 缓存最新一批(空态不清缓存:详情里的返回还靠它,空态由列表视图的下一拍纠正)
      st.client = c.client;
      st.doc = c.doc;
      st.root = c.root;
      st.rows = Array.isArray(listSc.rows) ? listSc.rows : [];
      st.counts = countsSc.counts || {};
      boardData = { rows: st.rows, counts: st.counts }; // 工单 04:筛选态原地重渲染与详情返回共用这一批
      if (inDetail) return; // 详情态:数据只进缓存,不动画面(筛选/视图状态也原样保留)
      renderBoard(c.doc, c.root, st.rows, st.counts, view);
    } catch (e) {
      if (!silent) renderError(c.doc, c.root, e);
    } finally {
      loading = false;
      if (queued) {
        queued = false;
        reload({ silent: true });
      }
    }
  }

  /** 轮询一格:只打 counts,revision 变了才重拉列表。 */
  function tick() {
    var c = ctx;
    if (!c || loading) return;
    if (c.doc.hidden) return; // 不可见暂停,不空耗
    c.client
      .callTool("deck_issue_counts", {})
      .then(function (r) {
        if (!r || r.isError) return; // 失败静默,下轮再试
        var sc = (r && r.structuredContent) || {};
        if (lastRevision === undefined) {
          if (!everLoaded) reload({ silent: true }); // 初始加载失败过:轮询里静默重试
          return;
        }
        if (sc.revision !== undefined && sc.revision !== lastRevision) reload({ silent: true });
      })
      .catch(function () {});
  }

  // ---- 入口 ----
  async function boot(opts) {
    var client = opts.client;
    var doc = opts.doc;
    var root = opts.root;
    var pollMs = opts.pollMs === undefined ? POLL_MS : opts.pollMs;
    stopPolling(); // 重复引导(测试/宿主重挂)先撤旧节拍
    ctx = { client: client, doc: doc, root: root };
    lastRevision = undefined;
    everLoaded = false;
    if (!visBound && typeof doc.addEventListener === "function") {
      visBound = true;
      doc.addEventListener("visibilitychange", function () {
        if (!doc.hidden) tick(); // 转回可见立即补一格,不等下一拍
      });
    }
    if (pollMs > 0) pollTimer = setInterval(tick, pollMs);
    await reload({});
  }

  /** 强刷钩子:写操作/动作后立即重拉(revision 未变也拉;T06/T07 调)。 */
  function refresh() {
    return reload({ silent: true });
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  window.MattSkillsPanel = { boot: boot, refresh: refresh, stopPolling: stopPolling };
})();

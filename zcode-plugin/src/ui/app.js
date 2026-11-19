// MattSkills 面板应用(bundle-0.txt 的源):列表 tracer 的渲染与桥调用。
// 纯脚本无 import(资源通道只搬文本,拼接后以 <script> 注入执行),经 window.MattSkillsPanel.boot
// 交给引导页/测试架驱动。对宿主只有两个依赖:client(ext-apps 桥)与 doc(DOM)。
// 类名命名空间 ms-(M1 基础卡面;完整 PixelCards 色卡体系是工单 04,届时换 cd- 体系)。
"use strict";
(function () {
  // ---- 文案(M1 中文内联,键名按上游 copy 词表组织,为 M3 配置化留缝) ----
  var COPY = {
    loading: "正在加载看板…",
    loadFail: "看板加载失败",
    emptyTitle: "还没有工单",
    emptyBody0: "此工作区还没有 .scratch/ 工单目录。运行 ",
    emptySetup: "/setup-matt-pocock-skills",
    emptyMid: " 初始化,或让 agent 用 ",
    emptyTickets: "/to-tickets",
    emptyEnd: " 拆解规格。",
    emptyHint: "生成工单后,本页签会展示任务看板。",
    boardTitle: "任务看板",
    stateOpen: "在办",
    stateClosed: "已关闭",
    markClaimed: "已认领",
    markBlocked: "被阻塞",
  };

  // 九条计数口径:顺序即胶囊条从左到右;前三枚带 KPI 色值(list-page.md KPI 行:
  // 可接 #4ade80 / 占用 #f0883e / 已关闭 #52525b)。
  var PILLS = [
    { key: "frontier", label: "可接", color: "#4ade80" },
    { key: "open", label: "进行中" },
    { key: "occupied", label: "占用", color: "#f0883e" },
    { key: "claimed", label: "已认领" },
    { key: "blocked", label: "被阻塞" },
    { key: "bug", label: "故障" },
    { key: "triage", label: "诊断" },
    { key: "closed", label: "已关闭", color: "#52525b" },
    { key: "total", label: "全部" },
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
    app.append(el(doc, "div", "ms-state ms-loading", COPY.loading));
    root.replaceChildren(app);
  }
  function renderError(doc, root, err) {
    var app = el(doc, "div", "ms-app");
    var box = el(doc, "div", "ms-state ms-error");
    box.append(el(doc, "div", "ms-error-title", COPY.loadFail));
    box.append(el(doc, "div", "ms-error-detail", (err && err.message) || String(err)));
    app.append(box);
    root.replaceChildren(app);
  }
  /** 空工作区引导态(延续骨架期文案,指向建卡技能,绝不回演示数据)。 */
  function renderGuide(doc, root) {
    var app = el(doc, "div", "ms-app");
    var box = el(doc, "div", "ms-state ms-empty");
    box.append(el(doc, "h1", "ms-empty-title", COPY.emptyTitle));
    var p = el(doc, "p", "ms-empty-body");
    p.append(COPY.emptyBody0);
    p.append(el(doc, "code", null, COPY.emptySetup));
    p.append(COPY.emptyMid);
    p.append(el(doc, "code", null, COPY.emptyTickets));
    p.append(COPY.emptyEnd);
    box.append(p);
    box.append(el(doc, "p", "ms-empty-hint", COPY.emptyHint));
    app.append(box);
    root.replaceChildren(app);
  }

  // ---- 计数胶囊条 + 卡片行 ----
  function renderCountsBar(doc, counts) {
    var bar = el(doc, "div", "ms-counts");
    for (var p of PILLS) {
      var pill = el(doc, "span", "ms-pill" + (p.color ? " ms-kpi" : ""), p.label + " " + (counts[p.key] ?? 0));
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
  function renderRow(doc, row) {
    var cls = "ms-row ms-kind-" + (row.type || "issue") + " " + (row.state === "closed" ? "ms-closed" : "ms-open");
    if (isClaimed(row)) cls += " ms-claimed";
    if (isBlocked(row)) cls += " ms-blocked";
    var r = el(doc, "div", cls);
    r.setAttribute("data-num", numberText(row));

    var head = el(doc, "div", "ms-row-head");
    var num = el(doc, "span", "ms-num", numberText(row));
    num.setAttribute("title", numberText(row));
    head.append(num);
    var title = el(doc, "span", "ms-title", row.title || "");
    title.setAttribute("title", row.title || "");
    head.append(title);
    head.append(el(doc, "span", "ms-state-chip", row.state === "closed" ? COPY.stateClosed : COPY.stateOpen));
    r.append(head);

    var foot = el(doc, "div", "ms-row-foot");
    var tags = el(doc, "div", "ms-tags");
    var labels = Array.isArray(row.labels) ? row.labels : [];
    for (var lab of labels) {
      if (!lab || !lab.name) continue;
      var hex = "#" + labelColorOf(lab.name);
      var chip = el(doc, "span", "ms-label");
      var dot = el(doc, "span", "ms-label-dot");
      dot.setAttribute("data-color", hex);
      dot.style.background = hex;
      chip.append(dot);
      chip.append(lab.name);
      tags.append(chip);
    }
    foot.append(tags);
    var marks = el(doc, "div", "ms-marks");
    if (isClaimed(row)) marks.append(el(doc, "span", "ms-mark ms-mark-claimed", COPY.markClaimed));
    if (isBlocked(row)) marks.append(el(doc, "span", "ms-mark ms-mark-blocked", COPY.markBlocked));
    foot.append(marks);
    r.append(foot);
    r.addEventListener("click", function () {
      openDetail(row);
    });
    return r;
  }
  function renderBoard(doc, root, rows, counts) {
    var app = el(doc, "div", "ms-app ms-board");
    var head = el(doc, "div", "ms-head");
    head.append(el(doc, "span", "ms-head-title", COPY.boardTitle));
    app.append(head);
    app.append(renderCountsBar(doc, counts));
    var list = el(doc, "div", "ms-rows");
    for (var row of sortRows(rows)) list.append(renderRow(doc, row));
    app.append(list);
    root.replaceChildren(app);
  }

  // ---- 视图状态:进详情后列表数据留在缓存,返回时原样重渲染(筛选状态落位在此) ----
  var st = { client: null, doc: null, root: null, rows: [], counts: {} };
  function openDetail(row) {
    if (!window.MattSkillsDetail) return;
    window.MattSkillsDetail.open({
      client: st.client,
      doc: st.doc,
      root: st.root,
      row: row,
      onBack: function () {
        renderBoard(st.doc, st.root, st.rows, st.counts);
      },
    });
  }

  // ---- 入口 ----
  async function boot(opts) {
    var client = opts.client;
    var doc = opts.doc;
    var root = opts.root;
    renderLoading(doc, root);
    try {
      var results = await Promise.all([
        client.callTool("deck_issue_list", {}),
        client.callTool("deck_issue_counts", {}),
      ]);
      var list = results[0];
      var counts = results[1];
      if (list && list.isError) throw Error(textOf(list) || "deck_issue_list 失败");
      if (counts && counts.isError) throw Error(textOf(counts) || "deck_issue_counts 失败");
      var listSc = (list && list.structuredContent) || {};
      var countsSc = (counts && counts.structuredContent) || {};
      if (countsSc.empty || listSc.empty) {
        renderGuide(doc, root);
        return;
      }
      st.client = client;
      st.doc = doc;
      st.root = root;
      st.rows = Array.isArray(listSc.rows) ? listSc.rows : [];
      st.counts = countsSc.counts || {};
      renderBoard(doc, root, st.rows, st.counts);
    } catch (e) {
      renderError(doc, root, e);
    }
  }

  window.MattSkillsPanel = { boot: boot };
})();

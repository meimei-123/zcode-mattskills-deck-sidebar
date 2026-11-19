// MattSkills 像素卡域(工单 04):PixelCards 色表/档位/对比度罩纱与容器三态的移植,纯函数。
// 真源:port-notes/pixel-cards.md(上游 PixelCardTheme.ts / PixelCardBtns.ts)与
// port-notes/kernel-domain.md(上游 container-view.ts)、action-prompts.md(上游 row-actions.ts)。
// 双态加载:build 时原样拼进 bundle-0.txt(纯脚本,IIFE 挂 globalThis);Node 测试直接 import
// 执行同一 IIFE。无 DOM 依赖——渲染在 app.js,这里只出数据与判定。
"use strict";
(function (global) {
  // 动作色表(pixel-cards.md §1):hex 一律无 # 前缀;map 是 cardColorOf 的兜底色。
  var CARD_ACTION_COLORS = {
    diagnose: "fbca04",
    fix: "d73a4a",
    execute: "10b981",
    claim: "b60205",
    supplement: "5319e7",
    research: "0ea5e9",
    grill: "9d7cd8",
    proto: "f59e0b",
    map: "8b5cf6",
    block: "a3231a",
  };

  // 档位样式(pixel-cards.md §2):colorKey 先查页面标签色表;colorKey 都 miss 才落动作色表。
  // hollow=false 实心编号徽章(底=主色,字=cardInkOn);true 描线款(边=主色,墨字)。
  // icon 是 PixelCardBtns 的 ICB 内联 SVG 名(chat/play/search/hammer/proto),M1 行内不画按钮,留档对齐。
  var CARD_ACTION_STYLE = {
    diagnose: { colorKey: "needs-triage", icon: "chat", hollow: false },
    fix: { colorKey: "bug", icon: "hammer", hollow: false },
    execute: { colorKey: "wayfinder:task", icon: "play", hollow: false },
    claim: { colorKey: "ready-for-human", icon: "play", hollow: false },
    supplement: { colorKey: "needs-info", icon: "play", hollow: false },
    research: { colorKey: "wayfinder:research", icon: "search", hollow: true },
    grill: { colorKey: "wayfinder:grilling", icon: "chat", hollow: true },
    proto: { colorKey: "wayfinder:prototype", icon: "proto", hollow: true },
    implement: { colorKey: "implement", icon: "hammer", hollow: false },
  };

  // 容器身份色(kernel-domain.md §6,上游 container-view.ts 唯一真源)。
  var CONTAINER_ACCENT = { map: "#c084fc", spec: "#1D4ED8" };
  var CONTAINER_TINT = { map: "rgba(188,140,255,.07)", spec: "rgba(29,78,216,.10)" };
  var CONTAINER_CHIP_CLASS = { map: "dsws-chip-m", spec: "dsws-chip-s" };
  var CONTAINER_CHIP_LABEL = { map: "地图", spec: "规格" }; // 上游 list.mapChip / list.specChip
  var CONTAINER_EMPTY_COLOR = "#f59e0b";
  var CONTAINER_DONE_COLOR = "#3fb950";

  // ---- 对比度罩纱(PixelCardTheme.ts):#1c1004 深墨与 #fff9ec 米白二选一,双阈值标记浅色罩纱带 ----
  function lumChan(x) {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }
  function cardLum(hex) {
    var h = String(hex === null || hex === undefined ? "" : hex).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return 0;
    return (
      0.2126 * lumChan(parseInt(h.slice(0, 2), 16)) +
      0.7152 * lumChan(parseInt(h.slice(2, 4), 16)) +
      0.0722 * lumChan(parseInt(h.slice(4, 6), 16))
    );
  }
  function cardInkOn(hex) {
    var l = cardLum(hex);
    return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#1c1004" : "#fff9ec";
  }
  function cardBoostOn(hex) {
    var l = cardLum(hex);
    var wOk = 1.05 / (l + 0.05) >= 4.6; // 白字达标(留 4.6 余量而非 4.5)
    var dOk = (l + 0.05) / (cardLum("1c1004") + 0.05) >= 4.5; // 深字达标
    return !wOk && !dOk; // 两种字都不达标 → 浅色主题加深墨罩纱(元素标 data-cd-boost="1")
  }

  /** 主色:先查页面标签色表(colorOf),miss 落档位兜底色,再 miss 回地图紫;去 # 转小写。 */
  function cardColorOf(colorKey, colorOf, actionKey) {
    var c = colorOf && colorOf[colorKey];
    if (!c && actionKey) c = CARD_ACTION_COLORS[actionKey];
    return String(c === null || c === undefined ? "" : c).replace(/^#/, "").toLowerCase() || "8b5cf6";
  }

  // ---- 档位判定(action-prompts.md rowActionKind 十档阶梯:状态优先于类型,标签按 name) ----
  function labelSet(row) {
    var out = {};
    var ls = row && Array.isArray(row.labels) ? row.labels : [];
    for (var i = 0; i < ls.length; i++) {
      if (ls[i] && ls[i].name) out[String(ls[i].name)] = true;
    }
    return out;
  }
  function rowActionKind(row) {
    var has = labelSet(row);
    var n = 0;
    for (var k in has) n++;
    if (n === 0 || has["needs-triage"]) return "diagnose"; // 无标签或 needs-triage → 诊断
    if (has["ready-for-human"]) return "claim"; // 接手优先于修复(两枚同现取接手)
    if (has["needs-info"]) return "supplement";
    if (has.bug) return "fix";
    if (has["wayfinder:grilling"]) return "grill";
    if (has["wayfinder:research"]) return "research";
    if (has["wayfinder:prototype"]) return "proto";
    if (has["wayfinder:task"]) return "execute";
    if (has["ready-for-agent"]) return "implement";
    return "execute"; // 兜底执行
  }

  // ---- 容器三态(kernel-domain.md §6):stats 缺失或 total=0 → empty;closed===total → done ----
  function containerStateOf(stats) {
    var total = stats && typeof stats.total === "number" ? stats.total : 0;
    var closed = stats && typeof stats.closed === "number" ? stats.closed : 0;
    if (total <= 0) return "empty";
    if (closed >= total) return "done";
    return "open";
  }
  /** 容器编号徽章色:done→绿 / empty→橙 / open:spec 贵族蓝、map 走 map 紫。 */
  function containerNumberColor(kind, state) {
    if (state === "done") return CONTAINER_DONE_COLOR;
    if (state === "empty") return CONTAINER_EMPTY_COLOR;
    return kind === "spec" ? CONTAINER_ACCENT.spec : "#" + CARD_ACTION_COLORS.map;
  }

  // ---- 视图投影(工单 04):状态分桶/占用口径/标签 OR/三段排序/标签目录与点击记忆 ----
  function openBlockerCountOf(row) {
    if (!Array.isArray(row.blockedBy)) return 0;
    var n = 0;
    for (var i = 0; i < row.blockedBy.length; i++) {
      var r = row.blockedBy[i];
      if (!r || r.state !== "closed") n++; // 断链(无目标)按安全阻塞计
    }
    return n;
  }
  /** 占用口径(list-page.md:blocked 筛选 = isOccupied):open 且(有认领人 或 被 open 阻塞)。 */
  function isOccupiedRow(row) {
    if (row.state === "closed") return false;
    if (Array.isArray(row.assignees) && row.assignees.length > 0) return true;
    return openBlockerCountOf(row) > 0;
  }
  /** 标签 OR 过滤:命中任一选中标签即显示;无标签行只在选了 needs-triage 时显示。容器行由调用方豁免。 */
  function labelMatches(row, labels) {
    if (!labels || labels.length === 0) return true;
    var names = [];
    var ls = Array.isArray(row.labels) ? row.labels : [];
    for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].name) names.push(String(ls[i].name));
    for (var j = 0; j < labels.length; j++) {
      if (names.indexOf(labels[j]) >= 0) return true;
      if (labels[j] === "needs-triage" && names.length === 0) return true;
    }
    return false;
  }
  /**
   * 状态视图投影:list-page.md 口径。
   *   all/open → openRows(容器行 + open 票,容器不受标签筛),closed 票进 closedRows;
   *   blocked  → openRows = 占用票(容器不进);frontier → 非占用票;
   *   closed   → 只给 closedRows,openRows 恒空。
   */
  function applyView(rows, sel) {
    var labels = (sel && sel.labels) || [];
    var state = (sel && sel.state) || "all";
    var openRows = [];
    var closedRows = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var isContainer = row.type === "map" || row.type === "spec";
      if (state === "closed") {
        if (!isContainer && row.state === "closed" && labelMatches(row, labels)) closedRows.push(row);
        continue;
      }
      if (isContainer) {
        if (state === "all" || state === "open") openRows.push(row); // 容器行不受标签筛
        continue;
      }
      if (row.state === "closed") {
        if (labelMatches(row, labels)) closedRows.push(row);
        continue;
      }
      if (state === "blocked" && !isOccupiedRow(row)) continue;
      if (state === "frontier" && isOccupiedRow(row)) continue;
      if (!labelMatches(row, labels)) continue;
      openRows.push(row);
    }
    return { openRows: openRows, closedRows: closedRows };
  }

  function rowKeyNumOf(row) {
    var m = /(\d+)\s*$/.exec(String(row.key || ""));
    return m ? parseInt(m[1], 10) : 0;
  }
  /** 三段排序:容器段序固定(map→spec,组间不比较键),组内按 sortKey × dir;同键兜底 effort → 编号升序。 */
  function sortViewRows(rows, sortKey, dir) {
    var d = dir === -1 ? -1 : 1;
    var rank = { map: 0, spec: 1 };
    var cmp = function (a, b) {
      var va;
      var vb;
      if (sortKey === "title") {
        va = String(a.title || "").toLowerCase();
        vb = String(b.title || "").toLowerCase();
        if (va !== vb) return va.localeCompare(vb) * d;
      } else if (sortKey === "updatedAt" || sortKey === "createdAt") {
        va = String(a[sortKey] || "");
        vb = String(b[sortKey] || "");
        if (va !== vb) return (va < vb ? -1 : 1) * d; // ISO 串字典序即时间序
      } else {
        va = rowKeyNumOf(a);
        vb = rowKeyNumOf(b);
        if (va !== vb) return (va - vb) * d;
      }
      var e = String(a.effortId || "").localeCompare(String(b.effortId || ""));
      if (e) return e;
      return rowKeyNumOf(a) - rowKeyNumOf(b);
    };
    return rows.slice().sort(function (a, b) {
      var ka = rank[a.type] ?? 2;
      var kb = rank[b.type] ?? 2;
      if (ka !== kb) return ka - kb;
      return cmp(a, b);
    });
  }

  /** 标签目录:全量行(含 closed)的标签频次表(Map name→count)。 */
  function labelCatalog(rows) {
    var cat = new Map();
    for (var i = 0; i < rows.length; i++) {
      var ls = Array.isArray(rows[i].labels) ? rows[i].labels : [];
      for (var j = 0; j < ls.length; j++) {
        if (!ls[j] || !ls[j].name) continue;
        var n = String(ls[j].name);
        cat.set(n, (cat.get(n) || 0) + 1);
      }
    }
    return cat;
  }
  /** 标签 chips 排序(list-page.md 点击记忆四键):次数降序 → 最近点击降序 → 频次降序 → 名称序。 */
  function sortLabelChips(cat, clicks) {
    var entries = [];
    cat.forEach(function (count, name) {
      entries.push({ name: name, count: count });
    });
    var c = clicks || {};
    return entries.sort(function (a, b) {
      var an = (c[a.name] && c[a.name].n) || 0;
      var bn = (c[b.name] && c[b.name].n) || 0;
      if (an !== bn) return bn - an;
      var at = (c[a.name] && c[a.name].ts) || 0;
      var bt = (c[b.name] && c[b.name].ts) || 0;
      if (at !== bt) return bt - at;
      if (a.count !== b.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
  }

  // ---- 墨块色值小工具(list-page.md chips):hex → alpha 底 / darken 边 ----
  function hexA(hex, a) {
    var h = String(hex === null || hex === undefined ? "" : hex).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "rgba(188,140,255," + a + ")";
    return (
      "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," +
      parseInt(h.slice(4, 6), 16) + "," + a + ")"
    );
  }
  function darkenHex(hex, amt) {
    var h = String(hex === null || hex === undefined ? "" : hex).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "#bc8cff";
    var out = "#";
    for (var i = 0; i < 3; i++) {
      var v = Math.round(parseInt(h.slice(i * 2, i * 2 + 2), 16) * (1 - amt));
      out += (v < 16 ? "0" : "") + v.toString(16);
    }
    return out;
  }

  global.MattSkillsCards = Object.freeze({
    CARD_ACTION_COLORS: CARD_ACTION_COLORS,
    CARD_ACTION_STYLE: CARD_ACTION_STYLE,
    CONTAINER_ACCENT: CONTAINER_ACCENT,
    CONTAINER_TINT: CONTAINER_TINT,
    CONTAINER_CHIP_CLASS: CONTAINER_CHIP_CLASS,
    CONTAINER_CHIP_LABEL: CONTAINER_CHIP_LABEL,
    CONTAINER_EMPTY_COLOR: CONTAINER_EMPTY_COLOR,
    CONTAINER_DONE_COLOR: CONTAINER_DONE_COLOR,
    cardLum: cardLum,
    cardInkOn: cardInkOn,
    cardBoostOn: cardBoostOn,
    cardColorOf: cardColorOf,
    rowActionKind: rowActionKind,
    containerStateOf: containerStateOf,
    containerNumberColor: containerNumberColor,
    applyView: applyView,
    sortViewRows: sortViewRows,
    labelCatalog: labelCatalog,
    sortLabelChips: sortLabelChips,
    isOccupiedRow: isOccupiedRow,
    openBlockerCountOf: openBlockerCountOf,
    hexA: hexA,
    darkenHex: darkenHex,
  });
})(typeof globalThis !== "undefined" ? globalThis : undefined);

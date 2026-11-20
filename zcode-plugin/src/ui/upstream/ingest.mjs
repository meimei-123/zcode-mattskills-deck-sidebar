// ingest.mjs —— 数据接驳适配器(工单 U02):我们的工具响应 → 上游 kernel 的 DeckState。
//
// 上游客户端不自己扫盘:它消费宿主拼好的面板快照(store 的 st.snapshot),形状与装配规则
// 真源在上游 src/host/tracker/snapshotAssemble.ts(assembleSnapshot)+ src/host/mapTickets.ts
// (prepareRow);计数的"从哪来、能不能信"真源在 src/tracker/deck-counts.ts(planDeckCounts /
// rowCountsOf)。本模块把 M1 的 scanWorkspace 行(deck_issue_list 的薄行同形)按同一套规则
// 组装成上游形状,让搬入的上游 kernel 函数(store-derived / deck-counts / deck-derive)直接
// 在我们的数据上运算。
//
// ── 字段映射表(我们的行 → 上游行)──────────────────────────────────────────
// 我们的行(src/cards.mjs parseCard / thinRow)     上游行(面板快照行,prepareRow 同款归一)
//   key: "01" | "demo/01-x"(退化身份)        →     key: String(key) 原样(退化身份自带目录)
//   effortId: ".scratch/ 目录名" | ""          →     effortId 原样(单工作单元后端为 '')
//   type: 'map' | 'spec' | 'issue'            →     type 原样(上游 ISSUE_TYPE 同词汇)
//   title / labels[{name,color}] / url        →     原样直通
//   createdAt / updatedAt / closedAt          →     原样直通
//   customFields                              →     原样直通
//   state: 'open' | 'closed'(小写,本地契约)   →     state: 大写 'OPEN'/'CLOSED'(面板快照口径,
//                                                   宿主 mapTickets.prepareRow 同款 toUpperCase)
//   (无 number 字段)                          →     number: parseInt(key,10)||0(宿主同款补号)
//   assignees: [{login,kind}] | 缺席          →     claimedBy: 首个认领人 login | ''(MISSING 同 '')
//   blockedBy: [{key,title,state?}]           →     blockedBy: [String(ref.key)](宿主把引用压成键串)
//   parentKey: '00' | null                    →     parentKey 原样(挂图子票 / 孤儿语义同上游)
//   body / comments                           →     不进面板行(上游 prepareRow 剥正文;正文只有
//                                                   tracker 投影(trackerDeckOf)保留给 deriveDeck)
//   commentCount                              →     不映射(上游面板行无此格,详情页另走 get)
//   isPullRequest: 我们不产生                 →     缺席 = 上游 MISSING(裸键身份,非拉取请求)
//
// ── 两个投影 ──────────────────────────────────────────────────────────────
//   panelRowOf / ingestSnapshot → 面板快照(大写态、claimedBy、deck.counts):
//     上游面板线(refresh/rooms/host/snapshot-build.ts)的口径:issues = 原始列表全量行
//     (容器行也在内 —— ListTab 三段列表从这个池分桶,容器行不进池就画不出地图/规格行);
//     maps = 容器装配(开容器 tickets=子票 copies、关容器 tickets=[] 留空壳,环/三态从这读)。
//   trackerDeckOf → tracker 形状({maps, issues},小写态、保留 body):
//     上游 deck-derive.ts 的输入口径(assembleSnapshot 的父子/孤儿规则;宿主/工具共用的
//     整池投影),deriveDeck/rowCountsOf 吃它。与面板快照是两个口径,别混。
//
// ── 如实缺口(不造假数据)─────────────────────────────────────────────────
//   · 上游 assembleSnapshot 会解析容器正文(map 五区块 destination/notes/decisions/fog/
//     outOfScope、spec 七段 sections);本适配器只随 list 薄行带 destination(M4 地图详情
//     档案区要它),其余区块不解析 —— 正文全文由点标题进 IssueDetail 看(上游 2026-10-23 定)。
//   · 上游快照还带 thinTickets(关容器里已关子票的瘦身行,工作路线查标题用)与 labels 色板
//     (deck_issue_list_labels 工具的数据);本票面板壳只消费 maps/issues/deck,labels 可由
//     调用方选择性传入,thinTickets 留空数组。
//   · assignees 缺席(票面无 Status 行)在上游 deriveDeck 里是 indeterminate(不进 frontier);
//     M1 computeCounts 按"未认领"计入可接 —— 两条口径都在,对拍测试里如实分列。

/** 我们的行 → 上游面板行(宿主 mapTickets.prepareRow 同款归一:大写态/补号/claimedBy/压阻塞键)。 */
export function panelRowOf(row) {
  const t = Object.assign({}, row);
  if (t.key != null && t.number == null) {
    const nn = parseInt(t.key, 10);
    t.number = isNaN(nn) ? 0 : nn;
  }
  if (t.key != null) t.key = String(t.key);
  t.state = String(t.state || "").toUpperCase();
  if (t.claimedBy == null) {
    const owners = t.assignees;
    t.claimedBy = Array.isArray(owners) && owners.length ? (owners[0] && owners[0].login) || "" : "";
  }
  // 上游行组件(ListTabRow)读 x.author.login 画认领人头像环;本地后端无独立作者 → 认领人即作者
  if (t.author == null && t.claimedBy) {
    t.author = { login: t.claimedBy, name: null, avatarUrl: null };
  }
  if (Array.isArray(t.blockedBy)) {
    t.blockedBy = t.blockedBy.map((ref) => {
      if (typeof ref === "number" || typeof ref === "string") return ref;
      if (ref && typeof ref === "object" && ref.key != null) return String(ref.key);
      return ref;
    });
  } else t.blockedBy = [];
  // 面板行不带正文与评论计数(上游 prepareRow 剥正文;详情页另走 get)
  delete t.body;
  delete t.commentCount;
  return t;
}

/** 同池分组(上游 assembleSnapshot 的父子规则,不转大小写、不剥正文):容器嵌子票、issues 收孤儿。
 *  仅 tracker 投影(trackerDeckOf)用;面板快照(ingestSnapshot)自 U04 起改走 panelSnapshotOf
 *  —— 上游面板那条线(refresh/rooms/host/snapshot-build.ts 的 buildSnapshot)的 issues 域是
 *  「原始列表全量行」(容器行也在内:ListTab 的三段列表从 issues 池分桶,地图/规格行不进池就
 *  一行都画不出来),与 assembleSnapshot 的孤儿域是两个口径,别混。 */
function groupDeck(rows, wrapRow) {
  const list = Array.isArray(rows) ? rows : [];
  const containers = list.filter((r) => r && (r.type === "map" || r.type === "spec"));
  const nonContainers = list.filter((r) => r && r.type !== "map" && r.type !== "spec");
  // 父子只在同一 effort 内成立(上游 byParent 按 idOfParts(effort, parentKey) 键入)
  const childrenByEffortParent = new Map(); // `${effortId}\u0000${parentKey}` → rows
  for (const r of nonContainers) {
    if (r.parentKey == null) continue;
    const k = `${String(r.effortId || "")}\u0000${String(r.parentKey)}`;
    const arr = childrenByEffortParent.get(k) || [];
    arr.push(r);
    childrenByEffortParent.set(k, arr);
  }
  const isClosed = (x) => String((x && x.state) || "").toUpperCase() === "CLOSED";
  const attached = new Set();
  const hidden = new Set(); // 关容器里自己已关闭的子票(#1291:只藏已关的)
  const maps = containers.map((m) => {
    const key = `${String(m.effortId || "")}\u0000${String(m.key)}`;
    const own = childrenByEffortParent.get(key) || [];
    const tickets = isClosed(m) ? [] : own.map((t) => Object.assign({}, wrapRow(t)));
    for (const t of tickets) attached.add(`${String(t.effortId || "")}\u0000${String(t.key)}`);
    if (isClosed(m)) {
      for (const t of own) {
        if (!isClosed(t)) continue;
        hidden.add(`${String(t.effortId || "")}\u0000${String(t.key)}`);
      }
    }
    // stats 与 tickets 同源算好(上游宿主 session-snapshot-cache 只在 GitHub 通路补 stats;
    // 本地通路由我们补:containerStateOf 判据 stats.total 缺席即 empty,环也读它)
    const stats = { total: own.length, closed: own.filter((t) => isClosed(t)).length };
    return Object.assign({}, wrapRow(m), { tickets, stats });
  });
  const issues = nonContainers
    .filter((r) => !attached.has(`${String(r.effortId || "")}\u0000${String(r.key)}`) && !hidden.has(`${String(r.effortId || "")}\u0000${String(r.key)}`))
    .map((r) => Object.assign({}, wrapRow(r)));
  return { maps, issues };
}

/** 面板快照分组(上游 buildSnapshot 口径,U04 立):issues = 原始列表全量行(容器行也在内,
 *  ListTab 从这个池分出 探索地图→规格→普通票 三段);maps = 容器装配(开容器嵌子票、
 *  关容器不装 —— 容器行的环与三态从 maps 读,见 mapBlockOf/containerTriState)。 */
function panelSnapshotOf(rows) {
  // maps 的容器与子票也走 panelRowOf 归一(大写态/补号/认领人→作者):
  // isOccupied 的阻塞判定按 state === 'OPEN' 查 maps.tickets,原始小写行永远判不中(真机症状:占用少 1)
  const { maps } = groupDeck(rows, panelRowOf);
  // #1291:关容器里自己已关闭的子票在列表隐藏(开容器子票仍进 issues 行池,上游 buildSnapshot 全量域)
  const closedContainers = maps.filter((m) => String(m.state || "") === "CLOSED");
  const hiddenKeys = new Set();
  for (const m of closedContainers) {
    const own = (Array.isArray(rows) ? rows : []).filter((r) => r && r.type !== "map" && r.type !== "spec" && r.parentKey != null && String(r.effortId || "") === String(m.effortId || "") && String(r.parentKey) === String(m.key) && String(r.state || "").toUpperCase() === "CLOSED");
    for (const r of own) hiddenKeys.add(`${String(r.effortId || "")}\u0000${String(r.key)}`);
  }
  const issues = (Array.isArray(rows) ? rows : [])
    .filter((r) => !hiddenKeys.has(`${String((r && r.effortId) || "")}\u0000${String((r && r.key) || "")}`))
    .map(panelRowOf);
  return { maps, issues };
}

/** tracker 投影:deck-derive.ts 的输入口径(小写态原样、保留 body、容器不解析正文区块)。 */
export function trackerDeckOf(rows) {
  return groupDeck(rows, (r) => r);
}

/**
 * 组装上游面板快照(store 的 st)。deps:
 *   rows          我们的行(scanWorkspace().rows,或 deck_issue_list 的薄行 —— 计数只读映射表里的格子)
 *   counts        {open,closed,total}(deck_issue_counts 三数;上游本地后端 counts 契约的等价物)
 *   workspaceRoot 工作区根(workspace.json 资源给的那个)
 *   labels        可选,标签色板([{name,color}],deck_issue_list_labels 的数据;不给则从行面聚合名)
 *   atMs          可选,计数时刻(缺省 Date.now())
 * k = { planDeckCounts, rowCountsOf }:上游计数函数注入(闭包真源;与上游宿主 snapshot.ts
 * 同一套判定:后端可信走 backend 口径,行并集重算,拿不到不猜)。
 */
export function ingestSnapshot({ rows, counts, workspaceRoot, labels, atMs }, k) {
  const { maps, issues } = panelSnapshotOf(rows);
  const snapshot = {
    repository: {
      backend: "markdown",
      name: String(workspaceRoot || "").split(/[\\/]/).filter(Boolean).pop() || "",
      refId: "",
      path: workspaceRoot || "",
    },
    maps,
    issues,
    thinTickets: [], // 关容器里已关子票的瘦身行:U05 详情/工作路线需要时补
    labels: Array.isArray(labels) && labels.length
      ? labels.map((l) => ({ name: String(l.name || ""), color: String(l.color || "").replace(/^#/, "") }))
      : aggregateRowLabels(rows),
    deck: null,
  };
  const tripleOf = (v) =>
    v && typeof v === "object" && Number.isFinite(v.open) && Number.isFinite(v.closed) && Number.isFinite(v.total)
      ? { open: v.open, closed: v.closed, total: v.total }
      : null;
  const deck = {};
  const plan = k.planDeckCounts({
    backendCounts: tripleOf(counts),
    // 计数行 = 非容器票(容器是看板容器不是工单;上游 GitHub 通路里地图是带标签 issue 才进后端计数,
    // 本地后端的 counts 契约本就不含容器 —— 两边对齐,别让 rowCountsOf 把容器当开放行掺进去)
    rows: k.rowCountsOf({ issues: (Array.isArray(rows) ? rows : []).filter((r) => r && r.type !== "map" && r.type !== "spec").map(panelRowOf) }),
    rowsComplete: true, // 本地枚举:scanWorkspace 全量清点,无分页截断
    previousCounts: null,
    previousAtMs: 0,
    nowMs: typeof atMs === "number" && atMs > 0 ? atMs : Date.now(),
  });
  if (plan.counts) deck.counts = plan.counts;
  deck.countsPending = plan.pending;
  deck.partial = plan.partial;
  snapshot.deck = deck;
  const root = String(workspaceRoot || "");
  return {
    cwd: root,
    workspaceRoot: root,
    selection: { backendId: "markdown" },
    backendModules: [{ id: "markdown", capabilities: { pullRequests: false } }],
    snapshot,
  };
}

/** 行面标签聚合(上游 buildColorOf 的输入口径:快照 labels + 各行 labels 并集,色不带 #)。 */
function aggregateRowLabels(rows) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const l of (r && Array.isArray(r.labels) ? r.labels : [])) {
      const name = l && l.name ? String(l.name) : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, color: String((l && l.color) || "").replace(/^#/, "") });
    }
  }
  return out;
}

// ── 工单 U05:详情投影 ─────────────────────────────────────────────────────
// wf.issueDetail 的回包按上游 api-io.ts fetchIssueDetail 的消费面拼:issue.number 必须是
// 数字(守卫 `typeof issue.number !== 'number'`);评论区只认 GraphQL 连接 {nodes, pageInfo}
// (#1519 不再兼容数组);#693 口径「正文与评论只认 get 那一次」在本地落成 deck_issue_get
// 的 structuredContent.card 直接投影 —— 卡模型(cards.mjs parseCard)的 comments 本来就是
// {author:{login}, authorAssociation, body, createdAt, updatedAt} 节点形,零改形。
// 子票与被阻塞邻居从 list 薄行池派生(同 effort 的 parentKey/blockedBy 边),行面走
// panelRowOf(大写态:IssueDetail 子票区/被阻塞区与 detailProjection 都按面板快照口径读)。

/** 卡正文段:剥文件头注释块、H1 票题行与顶部元行块(Status/Labels/Assignees/Blocked by/
 *  Type/Close reason),掐掉 ## Comments 段。首条内容行之前只剥这几样,之后原样保留。 */
export function bodySectionOf(card) {
  let raw = String((card && card.body) || "");
  const cm = /^\s*##\s*Comments\s*$/im.exec(raw);
  if (cm) raw = raw.slice(0, cm.index);
  const metaLine = /^\s*(?:\*\*)?(?:Status|Labels?|Assignees|Blocked\s+by|Type|Close\s+reason)(?:\*\*)?\s*[:\uFF1A]/i;
  const out = [];
  let started = false;
  for (const line of raw.split("\n")) {
    if (!started) {
      if (!line.trim()) continue;
      if (/^\s*<!--/.test(line)) continue;
      if (/^#\s/.test(line)) continue;
      if (metaLine.test(line)) continue;
      started = true;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** 详情 issue 投影:card(全量卡) + pool(list 薄行池,给子票/被阻塞邻居补边)。 */
export function detailIssueOf(card, pool) {
  const c = card || {};
  const rows = Array.isArray(pool) ? pool : [];
  const effortId = String(c.effortId || "");
  const key = String(c.key || "");
  const rowOf = (k) =>
    rows.find(
      (r) => r && String(r.effortId || "") === effortId && (String(r.key || "") === k || String(r.key || "") === `${effortId}/${k}`)
    ) || null;
  const children = rows.filter(
    (r) => r && r.type !== "map" && r.type !== "spec" && String(r.effortId || "") === effortId && r.parentKey != null && String(r.parentKey) === key
  );
  const blockers = (Array.isArray(c.blockedBy) ? c.blockedBy : [])
    .map((ref) => (ref && ref.key != null ? rowOf(String(ref.key)) : null))
    .filter(Boolean);
  const comments = Array.isArray(c.comments) ? c.comments : [];
  const claimed = Array.isArray(c.assignees) && c.assignees.length ? c.assignees[0] : null;
  return {
    number: parseInt(key, 10) || 0,
    key,
    effortId,
    type: c.type || "issue",
    title: c.title || "",
    state: c.state === "closed" ? "closed" : "open",
    labels: Array.isArray(c.labels) ? c.labels : [],
    assignees: Array.isArray(c.assignees) ? c.assignees : [],
    author: claimed && claimed.login ? { login: claimed.login } : { login: "local" },
    body: bodySectionOf(c),
    url: typeof c.url === "string" ? c.url : key,
    createdAt: c.createdAt || "",
    updatedAt: c.updatedAt || c.createdAt || "",
    closedAt: c.closedAt || null,
    subIssues: { nodes: children.map(panelRowOf), totalCount: children.length },
    blockedBy: blockers.map(panelRowOf),
    comments: { nodes: comments, pageInfo: { hasNextPage: false, endCursor: String(comments.length) } },
  };
}

/** 评论分页投影:上游 fetchIssueComments 的 after 是十进制偏移串(客户端分页,endCursor 同义),
 *  页大小 50 与上游 COMMENTS_PAGE_SIZE 同数(卡片评论量小,一页通常全量)。 */
export function commentsPageOf(card, after) {
  const all = Array.isArray(card && card.comments) ? card.comments : [];
  const PAGE = 50;
  const off = Math.max(0, parseInt(after, 10) || 0);
  const nodes = all.slice(off, off + PAGE);
  return { nodes, pageInfo: { hasNextPage: off + nodes.length < all.length, endCursor: String(off + nodes.length) } };
}

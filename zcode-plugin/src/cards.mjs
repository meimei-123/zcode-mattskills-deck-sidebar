// MattSkills 数据面(工单 02):`.scratch/` 本地 Markdown 卡片的解析、扫描与计数。
// 口径逐条对照上游 1.9.0-beta.33 本地 Markdown 后端子集(见 port-notes/markdown-backend.md):
//   - 目录约定:`.scratch/<工作单元>/{spec.md|map.md|issues/NN-slug.md}`;根级扁平 map.md+issues/ 只读兼容。
//   - 票文件名:`^\d+-` 编号唯一 → 两位编号身份;重复或无编号 → 文件名退化身份(目录/文件名)。
//   - 字段行:Status/Type/Blocked by/Labels(可加粗),冒号后只吃同行空白;围栏代码块内不算。
//   - 关闭词集:resolved/completed/closed/done;其余 open。
//   - 评论:`## Comments` 段按 `### ` 切块,块头 `谁 — ISO时间`。
// 零依赖,同步 fs(数据面只读,量级是一个工作区几十张卡)。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const CLOSED_STATUS_WORDS = new Set(["resolved", "completed", "closed", "done"]);

/** 把正文里的围栏代码块整段抹成空行(保行号):字段行按文本找,围栏里的举例不算。 */
export function stripFencedCode(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text || "").split("\n")) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push("");
      continue;
    }
    out.push(fenced ? "" : line);
  }
  return out.join("\n");
}

/** 文件头(第一个可见标题之前)某条隐藏注释的值;没有这一行回空串。 */
export function hiddenHeaderValue(text, name) {
  const raw = String(text || "");
  const h1 = /^#+\s+/m.exec(raw);
  const head = h1 ? raw.slice(0, h1.index) : raw.split("\n").slice(0, 16).join("\n");
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^[ \\t]*<!--[ \\t]*${escaped}[ \\t]*:[ \\t]*(.*?)-->`, "im").exec(head);
  return m ? String(m[1] || "").trim() : "";
}

/** 隐藏注释名单分段:逗号、全角逗号、顿号都算分隔。 */
function splitHiddenList(value) {
  return String(value || "")
    .split(/[,\uFF0C\u3001]+/)
    .map((one) => one.trim())
    .filter(Boolean);
}

/** 剥掉标签名外层成对的反引号/引号(照抄文档代码写法带进来的那层),一层一层剥。 */
export function stripLabelDecoration(name) {
  let s = String(name === null || name === undefined ? "" : name).trim();
  for (;;) {
    if (s.length < 2) break;
    const head = s[0];
    if (head !== s[s.length - 1]) break;
    if (head !== "`" && head !== "'" && head !== '"') break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** 从路径取文件名去 .md:标题降级用,不去猜目录名。 */
function fileBaseTitle(url) {
  const base = String(url || "").split(/[\\/]/).pop() || "";
  return base.replace(/\.[Mm][Dd]$/, "").trim();
}

/** 文件头隐藏注释里的对象类型标记(上游 marker.ts 的子集):只认 map/spec/ticket。 */
function markerKindInHeader(text) {
  const v = hiddenHeaderValue(text, "DSH-ISSUE-KIND").trim().toLowerCase();
  return ["map", "spec", "ticket"].includes(v) ? v : "";
}

/**
 * 解析一份卡文件(上游 parseMd 子集)。
 * meta 是调用方已知的身份:{key, parentKey, isMap, effortId, kind, createdAt, updatedAt, url};
 * 正文里读不出的东西(缺字段、无标题)一律降级,绝不抛错。
 */
export function parseCard(text, meta = {}) {
  const raw = String(text || "");
  const field = stripFencedCode(raw);

  // 状态:可见行(可加粗)优先,其次 DSH-STATUS 注释;值只吃同行。
  const statusRaw =
    (/^\s*(?:\*\*)?Status(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*([^\n]+)/im.exec(field)?.[1]?.trim() || "") ||
    hiddenHeaderValue(raw, "DSH-STATUS");
  const statusNorm = statusRaw.toLowerCase().replace(/\s+/g, "-");
  const state = CLOSED_STATUS_WORDS.has(statusNorm) ? "closed" : "open";

  // 标题:① H1(剥编号前缀) ② DSH-TITLE ③ 降级:容器用目录名再文件名;普通票先文件名再首个非空非注释行。
  const title = (() => {
    const h1 = /^#[ \t]+(.+)$/m.exec(raw);
    if (h1) return h1[1].trim().replace(/^\d{1,3}:[ \t]*/, "");
    const hiddenTitle = hiddenHeaderValue(raw, "DSH-TITLE");
    if (hiddenTitle) return hiddenTitle;
    const fileBase = fileBaseTitle(meta.url);
    if (meta.kind === "spec" || meta.isMap) return String(meta.effortId || "").trim() || fileBase || "untitled";
    if (fileBase) return fileBase;
    const first =
      raw
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !/^<!--/.test(l)) || "";
    return first.replace(/^#+\s*/, "").trim() || "untitled";
  })();

  // Type 行(裸写法或加粗):值集上游是 research/prototype/grilling/task,这里原样进自定义字段不判集。
  const typeRaw =
    (/^\s*(?:\*\*)?Type(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*([^\n]+)/im.exec(field)?.[1]?.trim().toLowerCase() || "");
  const customFields = typeRaw
    ? [{ name: "Type", value: typeRaw, type: "single", options: ["research", "prototype", "grilling", "task"] }]
    : undefined;

  // 阻塞边:可见行优先,其次 DSH-BLOCKED-BY;每段取 #?数字 补两位,只存 key。
  const blockedRaw =
    (/^\s*(?:\*\*)?Blocked\s+by(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*(.+)$/im.exec(field)?.[1]?.trim() || "") ||
    splitHiddenList(hiddenHeaderValue(raw, "DSH-BLOCKED-BY")).join(", ");
  const blockedBy = [];
  if (blockedRaw) {
    for (const p of blockedRaw.split(/[,\uFF0C\s]+/).map((s) => s.trim()).filter(Boolean)) {
      const m = /#?(\d+)/.exec(p);
      if (m) blockedBy.push({ key: String(m[1]).padStart(2, "0"), title: "" });
    }
  }

  // 标签:可见 Labels/Label 行优先(剥装饰),其次 DSH-LABELS;只写名,色归配色层。
  const labels = [];
  const labelsMatch = /^\s*(?:\*\*)?Labels?(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*([^\n]*)/im.exec(field);
  if (labelsMatch) {
    for (const part of (labelsMatch[1] || "").split(/[,\uFF0C]+/)) {
      const name = stripLabelDecoration(part);
      if (name) labels.push({ name, color: "", description: "" });
    }
  } else {
    for (const name of splitHiddenList(hiddenHeaderValue(raw, "DSH-LABELS"))) {
      const clean = stripLabelDecoration(name);
      if (clean) labels.push({ name: clean, color: "", description: "" });
    }
  }

  // 评论:## Comments 段按 ### 切块;块头 `谁 — ISO`(em dash 优先,普通 - 兜底);正文到 --- 分隔线为止。
  const comments = [];
  const cmExec = /^\s*##\s*Comments\s*$/im.exec(raw);
  if (cmExec) {
    const after = raw.slice(cmExec.index + cmExec[0].length);
    const nextH2 = /^\s*##\s+/m.exec(after);
    const segment = nextH2 ? after.slice(0, nextH2.index) : after;
    for (const b of segment.split(/^###\s+/m).map((s) => s.trim()).filter(Boolean)) {
      const lines = b.split("\n");
      const header = lines[0]?.trim() || "";
      let login = "local";
      let createdAt = "";
      const emIdx = header.indexOf("\u2014");
      const hyphenIdx = header.indexOf("-");
      const sep = emIdx >= 0 ? emIdx : hyphenIdx;
      if (sep >= 0) {
        login = header.slice(0, sep).trim() || "local";
        const datePart = header.slice(sep + 1).trim();
        const iso = /\d{4}-\d{2}-\d{2}T/.exec(datePart) ? datePart.match(/\d{4}-\d{2}-\d{2}T[^ \n]+/)?.[0] : "";
        if (iso) createdAt = iso;
      } else if (header) {
        login = header.split(/\s+/)[0] || "local";
      }
      const bodyPart = lines.slice(1).join("\n").trim();
      const body = bodyPart.split(/^---\s*$/m)[0]?.trim() || bodyPart;
      if (!body && !header) continue;
      comments.push({
        author: { login },
        authorAssociation: "",
        body,
        createdAt: createdAt || meta.createdAt || "",
        updatedAt: createdAt || meta.updatedAt || "",
      });
    }
  }

  // 对象类型:meta.kind(文件名已知)→ DSH-ISSUE-KIND 标记 → wayfinder:map 标签 → 正文形状(isMap / Type: map)。
  const markedKind = markerKindInHeader(raw);
  const metaKind = String(meta.kind || "").trim().toLowerCase();
  const hasMapLabel = labels.some((one) => String(one.name || "").trim().toLowerCase() === "wayfinder:map");
  let type = "issue";
  if (metaKind === "spec") type = "spec";
  else if (metaKind === "map") type = "map";
  else if (markedKind === "spec") type = "spec";
  else if (markedKind === "ticket") type = "issue";
  else if (meta.isMap || hasMapLabel || typeRaw === "map") type = "map";

  // 父子:地图/规格无父;带 wayfinder:map 标签的地图票无父;其余读文件头 DSH-PARENT/parentKey 注释,没有回落调用方。
  let parentKey = null;
  const fileParent = (() => {
    const raw0 = String(text || "");
    const h1 = /^#+\s+/m.exec(raw0);
    const head = h1 ? raw0.slice(0, h1.index) : raw0.split("\n").slice(0, 10).join("\n");
    const m = /^[ \t]*<!--[ \t]*(?:parentKey|DSH-PARENT)[ \t]*:[ \t]*(.*?)-->/im.exec(head);
    if (!m) return { found: false, value: null };
    const v = String(m[1] || "").trim();
    if (!v) return { found: true, value: null };
    if (/^null$/i.test(v) || /^none$/i.test(v) || v === "-") return { found: true, value: null };
    if (/^\d+$/.test(v)) return { found: true, value: v.padStart(2, "0") };
    return { found: true, value: v };
  })();
  if (meta.isMap || metaKind === "spec" || metaKind === "map") parentKey = null;
  else if (fileParent.found) parentKey = fileParent.value;
  else if (hasMapLabel || typeRaw === "map") parentKey = null;
  else if (type === "spec") parentKey = null;
  else parentKey = meta.parentKey !== undefined ? meta.parentKey : null;
  if (typeof parentKey === "string") {
    const t = parentKey.trim();
    parentKey = !t ? null : /^\d+$/.test(t) ? t.padStart(2, "0") : t;
  }
  if (parentKey === "") parentKey = null;

  // 创建时刻:文件里写下的那行优先(写下就不动),没有回落调用方给的时间(本地是 mtime)。
  const fileCreated = (() => {
    const v = hiddenHeaderValue(raw, "created") || hiddenHeaderValue(raw, "DSH-CREATED");
    return v ? v : "";
  })();
  const createdAt = fileCreated || (typeof meta.createdAt === "string" ? meta.createdAt : "") || "";
  const updatedAt = (typeof meta.updatedAt === "string" ? meta.updatedAt : "") || "";
  const closedAt = state === "closed" ? updatedAt || createdAt || "" : null;

  const card = {
    key: String(meta.key || "00"),
    effortId: String(meta.effortId || ""),
    type,
    title,
    state,
    body: raw,
    url: typeof meta.url === "string" ? meta.url : "",
    createdAt,
    updatedAt,
    closedAt,
    parentKey,
    blockedBy,
    comments,
    labels,
    reason: state === "closed" ? (/^[ \t]*Close[ \t]+reason[ \t]*[:\uFF1A][ \t]*(.*)$/im.exec(field)?.[1]?.trim() || "completed") : "",
  };
  if (customFields) card.customFields = customFields;
  // 认领:Status 行在时给明确名单(Assignees 行 / DSH-ASSIGNEES);claimed 但没记名字 → 空名占位。
  if (statusRaw) {
    const assignees = (() => {
      // 字段名两侧 ** 当装饰剥掉,与 Status/Labels 同纪律(markdown-backend.md §4);
      // 冒号后的收尾 ** 也要剥(`**Assignees:** dev` 不能吃成 login=`** dev`)
      const m = /^\s*(?:\*\*)?Assignees(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*(.*)$/im.exec(field);
      if (m) {
        const names = String(m[1] || "").split(/[,\uFF0C]+/).map((s) => s.trim()).filter(Boolean);
        return { found: true, value: names.map((login) => ({ login, kind: "user" })) };
      }
      const hidden = hiddenHeaderValue(raw, "DSH-ASSIGNEES");
      const names = splitHiddenList(hidden);
      return { found: names.length > 0 || hidden !== "", value: names.map((login) => ({ login, kind: "user" })) };
    })();
    if (assignees.found) card.assignees = assignees.value;
    else if (statusNorm === "claimed") card.assignees = [{ login: "", kind: "user" }];
    else card.assignees = [];
  }
  return card;
}

/** .md 里哪些文件名不算票:map/spec/notes(大小写不敏感)。 */
function isNonTicketFileName(name) {
  const n = String(name || "").toLowerCase();
  return n === "map.md" || n === "spec.md" || n === "notes.md";
}

/** 一个 issues/ 目录里的票文件清单与目录内身份:
 *  编号(`NN-` 前缀)唯一 → 两位编号;重复或无编号 → 文件名去 .md 退化身份。 */
export function ticketEntriesOf(names) {
  const md = names.filter((f) => !!f && !f.startsWith(".") && f.toLowerCase().endsWith(".md") && !isNonTicketFileName(f));
  const counts = {};
  for (const f of md) {
    const m = /^(\d+)-/.exec(f);
    if (!m) continue;
    const n = m[1].padStart(2, "0");
    counts[n] = (counts[n] || 0) + 1;
  }
  const used = {};
  const out = [];
  for (const f of md.sort()) {
    const m = /^(\d+)-/.exec(f);
    const n = m ? m[1].padStart(2, "0") : "";
    let inner = "";
    let degenerate = false;
    if (n && counts[n] === 1) inner = n;
    else {
      inner = f.replace(/\.md$/i, "");
      degenerate = true;
    }
    let unique = inner;
    let seq = 1;
    while (used[unique]) {
      seq++;
      unique = `${inner}-${seq}`;
    }
    used[unique] = true;
    out.push({ file: f, inner: unique, degenerate });
  }
  return out;
}

/** 工作单元发现:目录含 map.md → 'map';含 spec.md → 'spec';含 issues/ → 'plain';都没有不算。 */
export function workUnitKindOf(dir) {
  if (existsSync(join(dir, "map.md"))) return "map";
  if (existsSync(join(dir, "spec.md"))) return "spec";
  try {
    if (readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && e.name === "issues")) return "plain";
  } catch {}
  return "";
}

/** 读文件 mtime 的 ISO 串;读不到回空串。 */
function mtimeIso(path) {
  try {
    return new Date(statSync(path).mtime).toISOString();
  } catch {
    return "";
  }
}

/** 目录名 → 工作单元(按名排序,与上游列举顺序一致);根级扁平布局只读兼容。 */
function listUnits(scratch) {
  const units = [];
  let entries = [];
  try {
    entries = readdirSync(scratch, { withFileTypes: true });
  } catch {
    return units;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const kind = workUnitKindOf(join(scratch, e.name));
    if (!kind) continue;
    units.push({ effortId: e.name, dir: join(scratch, e.name), kind, legacy: false });
  }
  // 根级扁平布局(.scratch/map.md + .scratch/issues/)只读兼容:当 effortId='' 的单元。
  const rootKind = existsSync(join(scratch, "map.md")) ? "map" : existsSync(join(scratch, "issues")) ? "plain" : "";
  if (rootKind) units.push({ effortId: "", dir: scratch, kind: rootKind, legacy: true });
  return units;
}

/** 对外 key:正常=两位编号;退化=目录/文件名(根级退化不带前缀)。 */
export function ticketKey(effortId, tf) {
  if (!tf.degenerate) return tf.inner;
  return effortId ? `${effortId}/${tf.inner}` : tf.inner;
}

/**
 * 扫描工作区 `.scratch/`:返回全部卡行(容器行 + 票行,排序 effortId → key)。
 * 空态语义:根目录不存在 → { exists:false, rows:[] },由调用方转成明确空态结果,不是错误。
 * 读不动的票文件静默跳过并记入 unreadable(list 语义永远跳过;counts 语义由调用方按
 * 监听状态分派——工单 08)。目录读不出来抛错如实失败。
 */
export function scanWorkspace(root) {
  const scratch = join(String(root || "."), ".scratch");
  if (!existsSync(scratch)) return { exists: false, scratch, units: [], rows: [], unreadable: [], empty: true };
  const units = listUnits(scratch);
  const rows = [];
  const unreadable = [];
  const readCard = (path, meta, fallback) => {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      if (fallback === "ticket") unreadable.push(path); // 票读不动:记给 counts 分派;行照旧跳过
      return null;
    }
    return parseCard(text, meta);
  };
  for (const u of units) {
    if (u.kind === "map") {
      const p = join(u.dir, "map.md");
      const t = readCard(p, { key: "00", parentKey: null, isMap: true, effortId: u.effortId, url: p, createdAt: mtimeIso(p), updatedAt: mtimeIso(p) }, "skip");
      if (t) rows.push(t);
    } else if (u.kind === "spec") {
      const p = join(u.dir, "spec.md");
      const t = readCard(p, { key: "00", parentKey: null, isMap: false, kind: "spec", effortId: u.effortId, url: p, createdAt: mtimeIso(p), updatedAt: mtimeIso(p) }, "skip");
      if (t) rows.push(t);
    }
    const parentKey = u.kind === "plain" || u.legacy ? null : "00";
    const idir = join(u.dir, "issues");
    let names;
    try {
      names = readdirSync(idir);
    } catch {
      continue; // issues/ 不存在 = 该工作单元还没建票,正常空
    }
    for (const tf of ticketEntriesOf(names)) {
      const p = join(idir, tf.file);
      const t = readCard(p, { key: ticketKey(u.effortId, tf), parentKey, isMap: false, effortId: u.effortId, url: p, createdAt: mtimeIso(p), updatedAt: mtimeIso(p) }, "ticket");
      if (t) rows.push(t);
    }
  }
  rows.sort((a, b) => String(a.effortId || "").localeCompare(String(b.effortId || "")) || String(a.key).localeCompare(String(b.key)));
  // 阻塞引用回填:引用只在引用方 effort 内解析;命中回填标题与明确读到的状态。
  const byId = new Map(rows.map((r) => [`${r.effortId}\u0000${String(r.key).padStart(2, "0")}`, r]));
  for (const it of rows) {
    if (!Array.isArray(it.blockedBy)) continue;
    for (const ref of it.blockedBy) {
      const k = ref.key ? String(ref.key).padStart(2, "0") : "";
      const target = k ? byId.get(`${it.effortId}\u0000${k}`) : null;
      if (target) {
        if (!ref.title) ref.title = target.title || "";
        if (target.state) ref.state = target.state;
      }
    }
  }
  // 空态:根目录不存在,或存在但一个工作单元都没有(空 .scratch)——都给面板明确的引导态。
  return { exists: true, scratch, units, rows, unreadable, empty: units.length === 0 };
}

/** key 拆「工作单元前缀 + 目录内身份」:退化身份带 `目录/` 前缀。 */
export function splitTicketKey(key) {
  const s = String(key);
  const i = s.indexOf("/");
  return i >= 0 ? { effortFromKey: s.slice(0, i), inner: s.slice(i + 1) } : { effortFromKey: "", inner: s };
}

/** 薄行:列表用,不含正文与评论全文(详情页另有 get)。 */
export function thinRow(card) {
  const row = {
    key: card.key,
    effortId: card.effortId,
    type: card.type,
    title: card.title,
    state: card.state,
    labels: card.labels,
    url: card.url,
    parentKey: card.parentKey,
    blockedBy: card.blockedBy,
    commentCount: Array.isArray(card.comments) ? card.comments.length : 0,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
  if (card.assignees) row.assignees = card.assignees;
  if (card.customFields) row.customFields = card.customFields;
  return row;
}

/**
 * 计数口径(上游 deck-counts / store-derived / deriveDeck 的面板胶囊子集,纯函数,面板复用):
 *   open        = 非容器、state!=='closed'
 *   occupied    = open 且(有认领人 或 被 open 阻塞)
 *   frontier    = open - occupied        ——「可接」
 *   blocked     = open 且 blockedBy 有未关闭的(引用方 effort 内解析;
 *                 哪里都找不到 → 安全 blocked;同号只在别的 effort 存在 → 跨 effort 留白不算阻塞)
 *   claimed     = open 且有认领人
 *   bug         = open 且带 bug 标签     ——「故障」
 *   triage      = open 且(无标签 或 带 needs-triage) ——「诊断」
 *   closed/total 不含容器行;maps/specs 是容器数。
 */
export function computeCounts(rows) {
  const byEffortKey = new Map();
  const byKeyEfforts = new Map();
  for (const r of rows) {
    byEffortKey.set(`${r.effortId}\u0000${String(r.key).padStart(2, "0")}`, r);
    const k = String(r.key).padStart(2, "0");
    if (!byKeyEfforts.has(k)) byKeyEfforts.set(k, new Set());
    byKeyEfforts.get(k).add(r.effortId);
  }
  const hasOpenBlocker = (card) => {
    if (!Array.isArray(card.blockedBy)) return false;
    for (const ref of card.blockedBy) {
      const k = ref.key ? String(ref.key).padStart(2, "0") : "";
      if (!k) continue;
      const target = byEffortKey.get(`${card.effortId}\u0000${k}`);
      if (target) {
        if (target.state !== "closed") return true;
      } else {
        const efforts = byKeyEfforts.get(k);
        if (!efforts || efforts.size === 0) return true; // NOT-FOUND → 安全 blocked
        // 同号只在别的 effort 存在 → 跨 effort 留白,不算阻塞
      }
    }
    return false;
  };
  let open = 0;
  let closed = 0;
  let occupied = 0;
  let blocked = 0;
  let claimed = 0;
  let bug = 0;
  let triage = 0;
  let maps = 0;
  let specs = 0;
  for (const row of rows) {
    if (row.type === "map") {
      maps++;
      continue;
    }
    if (row.type === "spec") {
      specs++;
      continue;
    }
    if (row.state === "closed") {
      closed++;
      continue;
    }
    open++;
    const isBlocked = hasOpenBlocker(row);
    const isClaimed = Array.isArray(row.assignees) ? row.assignees.length > 0 : false;
    if (isBlocked) blocked++;
    if (isClaimed) claimed++;
    if (isBlocked || isClaimed) occupied++;
    const names = Array.isArray(row.labels) ? row.labels.map((l) => String(l.name || "")) : [];
    if (names.includes("bug")) bug++;
    if (names.length === 0 || names.includes("needs-triage")) triage++;
  }
  return {
    total: open + closed,
    open,
    closed,
    frontier: Math.max(0, open - occupied),
    occupied,
    claimed,
    blocked,
    bug,
    triage,
    maps,
    specs,
  };
}

/** 按调用方 key 找一张卡(读语义:多命中按列举顺序取第一个;退化身份自带目录前缀)。 */
export function findCardByScan(scan, key) {
  if (!key || !String(key).trim()) return null;
  const { effortFromKey, inner } = splitTicketKey(String(key).trim());
  const norm = /^\d+$/.test(inner) ? inner.padStart(2, "0") : inner;
  const rows = scan.rows;
  if (effortFromKey) {
    // 退化行的 key 自带 `目录/` 前缀,两种写法都比对。
    return (
      rows.find((r) => r.effortId === effortFromKey && (r.key === inner || r.key === `${effortFromKey}/${inner}`)) || null
    );
  }
  return rows.find((r) => r.key === norm || r.key === inner) || null;
}

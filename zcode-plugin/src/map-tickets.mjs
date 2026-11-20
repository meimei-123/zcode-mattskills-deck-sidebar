// map-tickets.mjs —— 地图子票按需取数(对齐上游宿主电话 wf.mapTickets / src/host/mapTickets.ts 的契约)。
//
// 为什么单独一份:地图详情页(MapDetailV2)进页就问一次「这张图的全部子票」,快照只带开容器的
// 未关闭子票(上游 groupDeck 口径),已关闭的与关地图的子票只能现取。回包形状由 api-io.ts 的
// fetchMapTickets 消费:{ok,key,items,stats,total,fetched,capped,missing};items 每行按上游
// prepareRow 归一大写 state、压 blockedBy 为键串、认领人从 assignees 取第一个。

// ── 进度读侧:上游 src/shared/issue-file/src/progress.ts 的读路径移植(只取当前百分比) ──
//   为什么要整段搬:上游的读侧先屏蔽代码块/引用块/HTML 注释,并认 `进度`/`Progress`、
//   `## 进度：70%` 老标题与 `##进度` 紧贴写法;只抄一条正则会读出正文示例里的假进度。
const ENTRY_BULLET_RE = /^\s*[-*+]\s+(?:进度|Progress)\s*[：:]\s*(\d{1,3})\s*%([\s\S]*)$/;
const ENTRY_LINE_RE = /^\s*(?:进度|Progress)\s*[：:]\s*(\d{1,3})\s*%([\s\S]*)$/;
const ENTRY_BARE_RE = /^\s*(\d{1,3})\s*%\s*$/;

function clampPercent(raw) {
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : Math.max(0, Math.min(100, n));
}

/** 标题行:最多三个前导空格、1-6 个 `#`,后面是标题文字(允许 `##进度` 这种不带空格的写法)。 */
function parseHeading(text) {
  const m = /^ {0,3}(#{1,6})([\s\S]*)$/.exec(text);
  if (!m) return null;
  return { level: m[1].length, title: m[2].replace(/^[ \t]+/, "").trim() };
}

/** 进度标题:`进度` / `Progress`,可带「：90%」这种老写法;`## 进度计划` 不算。 */
function parseProgressTitle(title) {
  const m = /^(?:进度|Progress)(?:\s*[：:]\s*(\d{1,3})\s*%?)?$/.exec(title);
  if (!m) return null;
  return { percent: m[1] === undefined ? null : clampPercent(m[1]) };
}

function isFieldLine(text) {
  return /^\s*(?:Status|Type|Blocked\s+by|Labels)\s*[:：]/.test(text);
}

/** 逐行标出「在不在代码块/注释里」,以及能不能当顶层标题看。 */
function analyzeLines(lines) {
  const marks = [];
  let fenceChar = "";
  let fenceLen = 0;
  let inComment = false;
  for (const line of lines) {
    const fenced = fenceLen > 0;
    const heading = !fenced && !inComment ? parseHeading(line.text) : null;
    marks.push({ fenced: fenced, inComment: inComment, heading: heading });
    if (fenced) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line.text);
      if (close && close[1].charAt(0) === fenceChar && close[1].length >= fenceLen) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (inComment) {
      if (line.text.indexOf("-->") >= 0) inComment = false;
      continue;
    }
    const openComment = line.text.indexOf("<!--");
    if (openComment >= 0) {
      if (line.text.indexOf("-->", openComment + 4) < 0) inComment = true;
      continue;
    }
    const openFence = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
    if (openFence) {
      fenceChar = openFence[1].charAt(0);
      fenceLen = openFence[1].length;
    }
  }
  return marks;
}

/** 找顶层二级进度区;到下一个二级标题或字段行为止。 */
function findProgressSections(lines, marks) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = marks[i].heading;
    if (!head || head.level !== 2) continue;
    const title = parseProgressTitle(head.title);
    if (!title) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (marks[j].fenced || marks[j].inComment) continue;
      const h = marks[j].heading;
      if (h && h.level === 2) { end = j; break; }
      if (isFieldLine(lines[j].text)) { end = j; break; }
    }
    out.push({ contentStart: i + 1, end: end, headingPercent: title.percent });
    i = end - 1;
  }
  return out;
}

/** 扫一个进度区里认得的记录行(顺序即原序,第一条就是当前值)。 */
function scanProgressEntries(lines, marks, section) {
  const entries = [];
  for (let i = section.contentStart; i < section.end; i++) {
    const text = lines[i].text;
    const mark = marks[i];
    if (mark.fenced || mark.inComment || /^\s*>/.test(text)) continue;
    const bullet = ENTRY_BULLET_RE.exec(text) || ENTRY_LINE_RE.exec(text);
    if (bullet) {
      const percent = clampPercent(bullet[1]);
      if (percent !== null) { entries.push(percent); continue; }
    }
    const bare = ENTRY_BARE_RE.exec(text);
    if (bare) {
      const percent = clampPercent(bare[1]);
      if (percent !== null) entries.push(percent);
    }
  }
  return entries;
}

/** 正文里写的当前进度(0..100 的整数);没写回 null(不是 0)。 */
export function progressOf(body) {
  const text = body == null ? "" : String(body);
  const lines = text.split("\n").map(function (l) { return { text: l.replace(/\r$/, "") }; });
  const marks = analyzeLines(lines);
  const sections = findProgressSections(lines, marks);
  if (sections.length) {
    const entries = scanProgressEntries(lines, marks, sections[0]);
    if (sections[0].headingPercent !== null && entries.indexOf(sections[0].headingPercent) < 0) entries.push(sections[0].headingPercent);
    return entries.length ? entries[0] : null;
  }
  // 老票两种写法:任意级别标题带百分比 → 行首 `进度：N%`
  for (let i = 0; i < lines.length; i++) {
    const mark = marks[i];
    if (mark.fenced || mark.inComment || !mark.heading) continue;
    const title = parseProgressTitle(mark.heading.title);
    if (title && title.percent !== null) return title.percent;
  }
  for (let i = 0; i < lines.length; i++) {
    if (marks[i].fenced || marks[i].inComment) continue;
    const m = ENTRY_LINE_RE.exec(lines[i].text);
    if (m) {
      const percent = clampPercent(m[1]);
      if (percent !== null) return percent;
    }
  }
  return null;
}

function errorOf(kind, message) {
  return { ok: false, error: { kind: kind, message: message, raw: "" } };
}

/** 一行卡 → 上游 prepareRow 口径的子票行。 */
function ticketItemOf(card) {
  const blockers = Array.isArray(card.blockedBy) ? card.blockedBy : [];
  const out = {
    key: String(card.key),
    effortId: card.effortId,
    type: card.type,
    title: card.title,
    state: String(card.state || "").toUpperCase(),
    labels: Array.isArray(card.labels) ? card.labels : [],
    url: card.url,
    parentKey: card.parentKey,
    blockedBy: blockers.map((ref) => (ref && typeof ref === "object" && ref.key != null ? String(ref.key) : String(ref))),
    // 引用态旁表(上游 prepareRow 的 blockedByRefs):图外阻塞者的标题与状态只有这里带着;
    // 缺了它,客户端对「图外且已关闭」的阻塞者会按安全侧一直画成被挡。
    blockedByRefs: blockers
      .map((ref) => {
        if (!ref || typeof ref !== "object" || ref.key == null) return { key: String(ref) };
        const one = { key: String(ref.key) };
        if (ref.title != null && String(ref.title) !== "") one.title = String(ref.title);
        if (ref.state != null && String(ref.state) !== "") one.state = String(ref.state);
        return one;
      })
      .filter((ref) => ref.key !== "" && ref.key !== "undefined" && ref.key !== "null"),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    closedAt: card.closedAt,
    progress: progressOf(card.body),
  };
  const number = Number.parseInt(String(card.key), 10);
  if (Number.isFinite(number)) out.number = number;
  const assignees = Array.isArray(card.assignees) ? card.assignees : [];
  out.claimedBy = assignees.length ? String((assignees[0] && assignees[0].login) || "") : "";
  if (assignees.length) out.assignees = assignees;
  return out;
}

/**
 * 一张地图/规格的全部子票(含已关闭)。scan 是 scanWorkspace 的结果。
 * args:{key, effortId?};同号容器在不同工作单元里是两张,给了 effortId 就按它查。
 */
export function mapTicketsFor(scan, args) {
  const a = args && typeof args === "object" ? args : {};
  const key = String(a.key === undefined || a.key === null ? "" : a.key).trim();
  if (!key) return errorOf("parse", "缺少地图编号(key)");
  const effortId = a.effortId === undefined || a.effortId === null ? "" : String(a.effortId);
  const rows = Array.isArray(scan && scan.rows) ? scan.rows : [];
  const norm = /^\d+$/.test(key) ? key.padStart(2, "0") : key;
  const effortOf = (r) => String((r && r.effortId) || "");
  const isContainer = (r) => !!r && (r.type === "map" || r.type === "spec");

  // 容器优先:00 是地图/规格的保留编号,但脏工作区里也可能有同名普通票 —— 只认容器。
  const pool = rows.filter((r) => r && String(r.key) === norm && (!effortId || effortOf(r) === effortId));
  const containers = pool.filter(isContainer);
  if (!containers.length) {
    if (!pool.length) return errorOf("parse", "找不到地图 " + (effortId ? effortId + "/" : "") + key);
    return errorOf("parse", String(pool[0].key) + " 不是地图/规格(它是 " + String(pool[0].type) + ")");
  }
  if (containers.length > 1) {
    return errorOf("parse", "同号地图有多张:请带 effortId(如 " + effortOf(containers[0]) + "/" + norm + ")");
  }
  const card = containers[0];

  const items = rows
    .filter((r) => {
      if (!r || r === card) return false;
      if (isContainer(r)) return false;
      if (effortOf(r) !== effortOf(card)) return false;
      return r.parentKey != null && String(r.parentKey) === String(card.key);
    })
    .map(ticketItemOf);
  const closed = items.filter((t) => t.state === "CLOSED").length;
  const stats = { total: items.length, open: items.length - closed, closed: closed };
  return {
    ok: true,
    key: String(card.key),
    items: items,
    stats: stats,
    total: items.length,
    fetched: items.length,
    capped: false,
    missing: 0,
  };
}

// MattSkills 写面(工单 06):`.scratch/` 卡片的受限写——状态行 / 标签行 / 评论追加,
// 正文永不重排。纪律逐条对照 port-notes/markdown-backend.md §6 写回纪律:
//   1. 读整份 → 内存 apply → 有变化才写回(noop 不写盘,不换 mtime);
//   2. 单写者队列 withFileWriter(同一卡片文件的读-改-写排队);建票取号走 withWorkspaceWriter;
//   3. 原子发布 publishTextFile(同目录临时文件 + rename,失败退回整份直写);
//   4. 写前校验:key 存在性、同号多卡 conflict 不猜文件、旧布局只读、expectedUpdatedAt 队内核;
//   5. 写回读回校验:发布前先 parseCard 验证所写能被读回还原,验不过一个字不落盘;
//   6. 环检:六件工具不写父子/阻塞类字段,M1 无环检对象(见工单报告)。
// 评论块格式沿用上游 1.9:`### 谁 — ISO时间`,追加到 ## Comments 段尾;无段文末新建。
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { scanWorkspace, parseCard, splitTicketKey, CLOSED_STATUS_WORDS } from "./cards.mjs";

// ---- 单写者队列:同一卡片文件的读-改-写排队(并发「发评论+关门」不互相抹) ----
const fileLocks = new Map(); // path -> Promise(已排队的上一步)
export function withFileWriter(path, fn) {
  const prev = fileLocks.get(path) || Promise.resolve();
  const run = prev.then(fn);
  fileLocks.set(path, run.then(
    () => {},
    () => {}
  )); // 锁只管顺序,错误由调用方收
  return run;
}
const wsLocks = new Map(); // 工作区根 -> Promise(建票取号排队:回查+列目录+写文件同一把锁)
export function withWorkspaceWriter(root, fn) {
  const prev = wsLocks.get(root) || Promise.resolve();
  const run = prev.then(fn);
  wsLocks.set(root, run.then(
    () => {},
    () => {}
  ));
  return run;
}

// ---- 原子发布:同目录临时文件再改名;rename 不可用退回整份直写(同为大后方,不留半截) ----
function publishTextFile(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    writeFileSync(path, text, "utf8");
  }
}

function mtimeIso(path) {
  try {
    return new Date(statSync(path).mtime).toISOString();
  } catch {
    return "";
  }
}

/** 卡的显示编号:#effort/编号;退化身份的 key 已带目录前缀,不重复拼。 */
function displayKeyOf(card) {
  const key = String(card.key || "");
  if (key.includes("/")) return `#${key}`;
  return `#${card.effortId ? `${card.effortId}/` : ""}${key}`;
}

// ---- 写前校验:按 key 定位唯一卡片文件(write 口径,与 get 的读口径只差一条:多命中拒绝猜) ----
function resolveWriteTarget(root, key) {
  const k = String(key === undefined || key === null ? "" : key).trim();
  if (!k) return { ok: false, kind: "parse", message: "缺少 key:请给卡编号(如 01)或带目录前缀(如 m1-core-board/01)。" };
  const scan = scanWorkspace(root);
  const { effortFromKey, inner } = splitTicketKey(k);
  const norm = /^\d+$/.test(inner) ? inner.padStart(2, "0") : inner;
  const matches = scan.rows.filter((r) =>
    effortFromKey
      ? r.effortId === effortFromKey && (r.key === inner || r.key === `${effortFromKey}/${inner}`)
      : r.key === norm || r.key === inner
  );
  if (!matches.length) {
    return { ok: false, kind: "not-found", message: `找不到卡 ${k}:这个工作区没有这张卡(现有 ${scan.rows.length} 张),一个字都没写。可先 deck_issue_list 看全量。` };
  }
  if (matches.length > 1) {
    const at = matches.map((r) => `${r.effortId}/${r.key}`).join("、");
    return { ok: false, kind: "conflict", message: `卡 ${k} 同号多张(${at}),写操作不猜文件:请带目录前缀重试(如 ${matches[0].effortId}/${matches[0].key})。本次一个字都没写。` };
  }
  const card = matches[0];
  if (card.type === "map" || card.type === "spec") {
    return { ok: false, kind: "unsupported", message: `${displayKeyOf(card)}「${card.title}」是容器(规格/地图),M1 写操作只针对工单票,本次一个字都没写。` };
  }
  const unit = scan.units.find((u) => u.effortId === card.effortId);
  if (unit && unit.legacy) {
    return { ok: false, kind: "unsupported", message: `${displayKeyOf(card)} 在旧布局(根级扁平 issues/)里,旧布局的票只读:本次一个字都没写。请挪进 .scratch/<工作单元>/issues/ 再写。` };
  }
  return { ok: true, card, scan };
}

/** 读整份 → 队内重读+版本核 → apply → noop 不写盘 → 读回校验 → 原子发布。 */
function mutateCardFile(root, key, opts, apply) {
  const target = resolveWriteTarget(root, key);
  if (!target.ok) return Promise.resolve(target);
  const card = target.card;
  const path = card.url;
  return withFileWriter(path, () => {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return { ok: false, kind: "not-found", message: `找不到卡 ${key}:卡片文件读不到(可能刚被移动或删除),本次一个字都没写。` };
    }
    if (opts.expectedUpdatedAt !== undefined && opts.expectedUpdatedAt !== null && String(opts.expectedUpdatedAt)) {
      const cur = mtimeIso(path);
      if (cur && cur !== String(opts.expectedUpdatedAt)) {
        return { ok: false, kind: "conflict", message: `版本冲突:${displayKeyOf(card)} 在你上次读取后被改过(expectedUpdatedAt 对不上),本次一个字都没写。请重读后再写。` };
      }
    }
    const meta = { key: card.key, parentKey: card.parentKey, isMap: false, effortId: card.effortId, url: path, createdAt: card.createdAt, updatedAt: mtimeIso(path) };
    const applied = apply(raw, card, meta);
    if (applied.text === raw) return { ok: true, changed: false, card, message: applied.noopMessage }; // noop:不写盘不换 mtime
    const problem = applied.verify ? applied.verify(parseCard(applied.text, { ...meta, updatedAt: mtimeIso(path) })) : null;
    if (problem) return { ok: false, kind: "roundtrip", message: `写回校验失败(${problem}),本次一个字都没写。` };
    publishTextFile(path, applied.text);
    return { ok: true, changed: true, card: parseCard(applied.text, { ...meta, updatedAt: mtimeIso(path) }), message: applied.message };
  });
}

// ---- 文本原语(全部按行操作,围栏代码块内的示例不算数) ----

/** 逐行扫非围栏区:返回满足谓词的全部行号(写侧的 stripFencedCode 等价物,保行号)。 */
function unfencedAll(lines, pred) {
  const out = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[ \t]*(```|~~~)/.test(l)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && pred(l, i)) out.push(i);
  }
  return out;
}
const unfencedFind = (lines, pred) => {
  const all = unfencedAll(lines, pred);
  return all.length ? all[0] : -1;
};

const H2_RE = /^\s*##\s+\S/;
const COMMENTS_H2_RE = /^\s*##\s*Comments\s*$/;

/** 评论块:`### 谁 — ISO` + 正文,块间空一行(上游 comments.ts 的 commentBlockOf)。 */
function commentBlock(actor, iso, body) {
  return [`### ${actor} — ${iso}`, ...String(body).split("\n")];
}

/** 追加评论:有 ## Comments 段 → 段尾(下一个 H2 之前,吞掉段尾空行再隔行);无段 → 文末新建。 */
export function appendCommentBlock(raw, actor, iso, body) {
  const lines = String(raw).split("\n");
  const head = unfencedFind(lines, (l) => COMMENTS_H2_RE.test(l));
  if (head === -1) {
    let out = raw === "" || raw.endsWith("\n") ? raw : `${raw}\n`;
    out += `\n## Comments\n\n`;
    out += commentBlock(actor, iso, body).join("\n") + "\n";
    return out;
  }
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (H2_RE.test(lines[i]) && !COMMENTS_H2_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  let insert = end;
  while (insert > head + 1 && lines[insert - 1].trim() === "") insert--; // 段尾空行上收,块间统一隔一空行
  lines.splice(insert, 0, "", ...commentBlock(actor, iso, body));
  return lines.join("\n");
}

// ---- 工具实现:评论追加 ----
export function commentIssue(root, key, { body, actor, expectedUpdatedAt } = {}) {
  const text = String(body === undefined || body === null ? "" : body).trim();
  if (!text) {
    return Promise.resolve({ ok: false, kind: "parse", message: "评论正文不能为空:请给 body 传要追加的评论内容。" });
  }
  const who = String(actor === undefined || actor === null ? "" : actor).trim() || "local";
  return mutateCardFile(root, key, { expectedUpdatedAt }, (raw, card, meta) => {
    const before = parseCard(raw, meta).comments.length;
    const iso = new Date().toISOString();
    const next = appendCommentBlock(raw, who, iso, text);
    return {
      text: next,
      message: `已在 ${displayKeyOf(card)}「${card.title}」追加评论(${who} · ${iso}),落盘到 ${relativeName(root, card.url)}。`,
      verify: (re) => (re.comments.length === before + 1 ? null : `评论数 ${re.comments.length} ≠ 期望 ${before + 1}`),
    };
  });
}

/** 消息里用的仓库相对路径(去工作区根前缀)。 */
function relativeName(root, path) {
  const r = String(root).replace(/\\/g, "/");
  let p = String(path).replace(/\\/g, "/");
  if (p.startsWith(r + "/")) p = p.slice(r.length + 1);
  return p;
}

// ---- 状态行原语:只动 Status 那一行 ----
const STATUS_LINE_RE = /^\s*(?:\*\*)?Status(?:\*\*)?\s*[:\uFF1A]/i;
const FIELD_LINE_RE = /^\s*(?:\*\*)?(?:status|labels?|label|type|blocked\s+by|assignees|close\s+reason)(?:\*\*)?\s*[:\uFF1A]/i;
const H1_RE = /^\s*#\s+\S/;

/**
 * 替换或插入状态行(上游 issues-status.ts 的 impl 分支 + replaceOrInsertField 纪律):
 * 有 Status 行 → 原地换值,加粗/裸写法随原行;没有 → 插在最后一条字段行之后
 * (没有字段行则 H1 之后,插在标题下等于插进正文区会丢行);全都没有 → 文件头注释块之后。
 * 插入的新行用 impl 票形状(加粗),与 create 的产物一致。
 */
export function replaceStatusLine(raw, value) {
  const lines = String(raw).split("\n");
  const idx = unfencedFind(lines, (l) => STATUS_LINE_RE.test(l));
  if (idx >= 0) {
    const m = /^(\s*)(\*\*)?Status(\*\*)?\s*[:\uFF1A]/i.exec(lines[idx]);
    const bold = !!(m && (m[2] || m[3]));
    lines[idx] = `${(m && m[1]) || ""}${bold ? "**Status:**" : "Status:"} ${value}`;
    return lines.join("\n");
  }
  const fieldIdxs = unfencedAll(lines, (l) => FIELD_LINE_RE.test(l));
  let insert;
  if (fieldIdxs.length) {
    insert = fieldIdxs[fieldIdxs.length - 1] + 1; // 新行插在最后一条字段行后
  } else {
    const h1 = unfencedFind(lines, (l) => H1_RE.test(l));
    if (h1 >= 0) {
      insert = h1 + 1;
      if (lines[insert] !== undefined && lines[insert].trim() === "") insert += 1; // 跳过标题后的空行
    } else {
      insert = 0;
      while (insert < lines.length && (lines[insert].trim() === "" || /^<!--.*-->$/.test(lines[insert].trim()))) insert++;
    }
  }
  lines.splice(insert, 0, `**Status:** ${value}`);
  return lines.join("\n");
}

/** 值归一成读侧口径(resolved/completed/closed/done → closed)。 */
function stateOfValue(value) {
  return CLOSED_STATUS_WORDS.has(String(value).toLowerCase().replace(/\s+/g, "-")) ? "closed" : "open";
}

// ---- 工具实现:状态三件(update / close / reopen) ----
export function updateStatusIssue(root, key, { status, expectedUpdatedAt } = {}) {
  const value = String(status === undefined || status === null ? "" : status).trim();
  if (!value) {
    return Promise.resolve({ ok: false, kind: "parse", message: "状态值不能为空:请给 status 传新值(如 ready-for-agent / claimed)。" });
  }
  return mutateCardFile(root, key, { expectedUpdatedAt }, (raw, card) => ({
    text: replaceStatusLine(raw, value),
    message: `已把 ${displayKeyOf(card)}「${card.title}」状态行改为「${value}」。`,
    noopMessage: `状态行已是「${value}」,没写盘。`,
    verify: (re) => (re.state === stateOfValue(value) ? null : `读回状态 ${re.state} ≠ 期望 ${stateOfValue(value)}`),
  }));
}

export function closeIssue(root, key, { reason, actor, expectedUpdatedAt } = {}) {
  const why = String(reason === undefined || reason === null ? "" : reason).trim();
  const who = String(actor === undefined || actor === null ? "" : actor).trim() || "local";
  return mutateCardFile(root, key, { expectedUpdatedAt }, (raw, card, meta) => {
    const before = parseCard(raw, meta);
    let next = replaceStatusLine(raw, "closed");
    let reasonAdded = false;
    if (why) {
      const last = before.comments.length ? before.comments[before.comments.length - 1] : null;
      if (!last || last.body !== why) {
        // 关票原因追加为一条评论(末条同文不重复),不写 Close reason 行
        next = appendCommentBlock(next, who, new Date().toISOString(), why);
        reasonAdded = true;
      }
    }
    return {
      text: next,
      message: `已关闭 ${displayKeyOf(card)}「${card.title}」(状态行 → closed${reasonAdded ? `,原因已记为一条评论(${who})` : ""})。`,
      noopMessage: `已是关闭状态${why ? "且末条评论就是这条原因" : ""},没写盘。`,
      verify: (re) => {
        if (re.state !== "closed") return `读回状态 ${re.state} ≠ 期望 closed`;
        if (reasonAdded && re.comments.length !== before.comments.length + 1) return "关票原因评论没读回";
        return null;
      },
    };
  });
}

export function reopenIssue(root, key, { expectedUpdatedAt } = {}) {
  return mutateCardFile(root, key, { expectedUpdatedAt }, (raw, card) => ({
    text: replaceStatusLine(raw, "ready-for-agent"),
    message: `已重开 ${displayKeyOf(card)}「${card.title}」(状态行 → ready-for-agent)。`,
    noopMessage: "状态行已是「ready-for-agent」,没写盘。",
    verify: (re) => (re.state === "open" ? null : `读回状态 ${re.state} ≠ 期望 open`),
  }));
}

// ---- 标签行原语:可见 Labels 行优先(原地换值);无可见行写 DSH-LABELS 注释;两处都有一起改 ----
const LABELS_LINE_RE = /^\s*(?:\*\*)?Labels?(?:\*\*)?\s*[:\uFF1A]/i;
const DSH_LABELS_RE = /^[ \t]*<!--[ \t]*DSH-LABELS[ \t]*:/i;

/** 替换/插入/删除标签(上游 setLabelsIssue:可见行换值、空名单裸行;注释空名单删行)。 */
export function replaceLabelsLine(raw, names) {
  const lines = String(raw).split("\n");
  const value = names.join(", ");
  const visIdx = unfencedFind(lines, (l) => LABELS_LINE_RE.test(l));
  const hiddenIdx = lines.findIndex((l) => DSH_LABELS_RE.test(l));
  if (visIdx >= 0) {
    const m = /^(\s*)(\*\*)?Labels?(?:\*\*)?\s*[:\uFF1A]/i.exec(lines[visIdx]);
    const bold = !!(m && (m[2] || m[3]));
    lines[visIdx] = `${(m && m[1]) || ""}${bold ? "**Labels:**" : "Labels:"}${value ? ` ${value}` : ""}`;
  } else if (names.length) {
    if (hiddenIdx >= 0) lines[hiddenIdx] = `<!-- DSH-LABELS: ${value} -->`;
    else lines.unshift(`<!-- DSH-LABELS: ${value} -->`);
  } else if (hiddenIdx >= 0) {
    lines.splice(hiddenIdx, 1); // 空名单删注释行
  }
  // 手写文件两处都有时一起改(解析以可见行为准,注释不许留旧值)
  if (visIdx >= 0) {
    const h = lines.findIndex((l) => DSH_LABELS_RE.test(l));
    if (names.length) {
      if (h >= 0) lines[h] = `<!-- DSH-LABELS: ${value} -->`;
    } else if (h >= 0) {
      lines.splice(h, 1);
    }
  }
  return lines.join("\n");
}

/** 标签入参归一:裸串或 {name} 都收,去空去重保序。 */
function normalizeLabelInput(labels) {
  const raw = Array.isArray(labels) ? labels : labels === undefined || labels === null ? [] : [labels];
  const out = [];
  for (const one of raw) {
    const name = String(one && typeof one === "object" ? one.name ?? "" : one ?? "").trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// ---- 工具实现:标签整份替换 ----
export function setLabelsIssue(root, key, { labels, expectedUpdatedAt } = {}) {
  const names = normalizeLabelInput(labels);
  return mutateCardFile(root, key, { expectedUpdatedAt }, (raw, card) => ({
    text: replaceLabelsLine(raw, names),
    message: `已把 ${displayKeyOf(card)}「${card.title}」标签改为 [${names.join(", ")}]。`,
    noopMessage: `标签已是 [${names.join(", ")}],没写盘。`,
    verify: (re) => {
      const got = (re.labels || []).map((l) => String(l.name || ""));
      return got.join("\u0001") === names.join("\u0001") ? null : `读回标签 [${got}] ≠ 期望 [${names}]`;
    },
  }));
}

// ---- 工具实现:建卡(取号/建目录都在工作区写锁里:并发不丢号不重号) ----

/** 标题 slug:小写、空白/标点折连字符、保留 Unicode 字母数字、截 40、空串回 untitled。 */
export function slugOf(title) {
  let s = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, "");
  return s || "untitled";
}

export function createIssue(root, { effort, title, body, labels } = {}) {
  const dirName = String(effort === undefined || effort === null ? "" : effort).trim();
  const theTitle = String(title === undefined || title === null ? "" : title).trim();
  if (!dirName || /^[\\/]/.test(dirName) || dirName.includes("/") || dirName.includes("\\") || dirName === "." || dirName === ".." || dirName.startsWith(".")) {
    return Promise.resolve({ ok: false, kind: "parse", message: `effort 不合规(${dirName || "空"}):请给 .scratch/ 下的工作单元目录名,不带路径分隔符。` });
  }
  if (!theTitle) {
    return Promise.resolve({ ok: false, kind: "parse", message: "标题不能为空:请给 title 传卡标题(进 H1 与文件名 slug)。" });
  }
  const names = normalizeLabelInput(labels);
  const theBody = String(body === undefined || body === null ? "" : body).trim();
  return withWorkspaceWriter(String(root), () => {
    const dir = join(String(root), ".scratch", dirName, "issues");
    mkdirSync(dir, { recursive: true });
    let max = 0;
    try {
      for (const f of readdirSync(dir)) {
        const m = /^(\d+)-/.exec(f);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch {}
    const nn = String(max + 1).padStart(2, "0");
    const path = join(dir, `${nn}-${slugOf(theTitle)}.md`);
    const iso = new Date().toISOString();
    const parts = [
      `<!-- DSH-CREATED: ${iso} -->`,
      `<!-- DSH-ISSUE-KIND: ticket -->`,
      "",
      `# ${nn}: ${theTitle}`,
      "",
      "**Status:** open",
    ];
    if (names.length) parts.push(`**Labels:** ${names.join(", ")}`);
    parts.push("");
    if (theBody) {
      parts.push(theBody, "");
    }
    const text = parts.join("\n");
    const meta = { key: nn, parentKey: null, isMap: false, effortId: dirName, url: path, createdAt: iso, updatedAt: iso };
    const parsed = parseCard(text, meta);
    const problem =
      parsed.title !== theTitle ? `标题读回「${parsed.title}」≠「${theTitle}」` :
      parsed.state !== "open" ? `状态读回 ${parsed.state} ≠ open` :
      (parsed.labels || []).map((l) => l.name).join("\u0001") !== names.join("\u0001") ? "标签读回不一致" :
      null;
    if (problem) return { ok: false, kind: "roundtrip", message: `建卡预检失败(${problem}),本次一个字都没写。` };
    if (existsSync(path)) {
      return { ok: false, kind: "conflict", message: `目标文件 ${relativeName(String(root), path)} 已存在,本次一个字都没写。` };
    }
    publishTextFile(path, text);
    return {
      ok: true,
      changed: true,
      card: parseCard(readFileSync(path, "utf8"), meta),
      message: `已建卡 #${dirName}/${nn}「${theTitle}」,写入 ${relativeName(String(root), path)}。`,
    };
  });
}

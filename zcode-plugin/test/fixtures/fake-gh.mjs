#!/usr/bin/env node
// test/fixtures/fake-gh.mjs —— 假 gh(票 03 建的 gh 可执行边界夹具;04/05/06 续用,只加命令族与状态字段)。
//
// 服务端经 ZCODE_GH_PATH 指到本脚本(垫片对 .mjs 用当前 node 起),真实子进程垫片一并走到。
// 每次调用先把 {argv, cwd} append 进 ZCODE_FAKE_GH_LOG(NDJSON),再按命令族回放 ZCODE_FAKE_GH_STATE
// 里的状态。读命令按命令族造回包(选择集照上游 channels/graphql/queries.ts);写命令本票不实现
// (票 04 续),未脚本化的命令 stderr 点名 argv 并 exit 1,绝不静默成功。
//
// 状态形状(design.md F,票 03 落地):
//   {
//     auth: "ok" | "missing",
//     user: { login },
//     repos: { "owner/name": {
//       permissions: { push, triage } | null,
//       issues: [ { number, title, state:"OPEN"|"CLOSED", body, url, createdAt, updatedAt,
//                   closedAt, labels:[{name,color}], assignees:[{login}], author:{login},
//                   parentKey, blockedBy:[{key}|number] } ],
//       pulls: [ ... 同 issues,但可带 mergedAt ],
//       comments: { "12": [ { id, author:{login}, body, createdAt } ] },
//       labels: [ { name, color, description } ],
//       counts: { open, closed } | undefined,     // 覆盖计数查询(构造「与行面不一致」)
//       subIssuesTotal: { "1": 3 } | undefined    // 覆盖子票连接 totalCount(构造 missing)
//     } },
//     fail: null | "ratelimit" | "network" | "notfound" | "timeout" | "auth" | "graphql"
//   }
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);

try {
  const logPath = process.env.ZCODE_FAKE_GH_LOG;
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
} catch {}

function readState() {
  try {
    return JSON.parse(readFileSync(String(process.env.ZCODE_FAKE_GH_STATE || ""), "utf8"));
  } catch {
    return {};
  }
}
const state = readState();
const repos = state && typeof state.repos === "object" && state.repos ? state.repos : {};

const out = (text) => process.stdout.write(`${String(text)}\n`);
const failExit = (text, code = 1) => ({ stderr: text, code });

// ---- argv 读数(-f/-F key=value;列表变量 states[]/labels[] 收全量) ----
function varOf(name) {
  for (let i = 0; i + 1 < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "-f" && flag !== "-F") continue;
    const value = argv[i + 1];
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return null;
}
function listVarOf(name) {
  const outList = [];
  const direct = `${name}[]=`;
  for (let i = 0; i + 1 < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "-f" && flag !== "-F") continue;
    const value = argv[i + 1];
    if (value.startsWith(direct)) outList.push(value.slice(direct.length));
  }
  return outList;
}
function flagValue(name, fallback) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}
function queryOf() {
  return varOf("query") || "";
}

// ---- 实体构造(GraphQL / REST 两套形状) ----
function repoSpecOfGraphql() {
  return `${varOf("owner") || ""}/${varOf("name") || ""}`;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function stateUpper(s) {
  return String(s == null ? "OPEN" : s).toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN";
}
function blockedRefs(issue) {
  return (Array.isArray(issue.blockedBy) ? issue.blockedBy : []).map((ref) => {
    if (ref && typeof ref === "object") return { number: num(ref.key ?? ref.number), title: String(ref.title || ""), state: stateUpper(ref.state) };
    return { number: num(ref), title: "", state: "OPEN" };
  });
}
function parentNode(issue) {
  return issue.parentKey == null ? null : { number: num(issue.parentKey) };
}
function authorNode(issue) {
  const author = issue.author && typeof issue.author === "object" ? issue.author : { login: "octocat" };
  return { login: String(author.login || "octocat"), avatarUrl: "", __typename: "User" };
}
function assigneesNode(issue) {
  return { nodes: (Array.isArray(issue.assignees) ? issue.assignees : []).map((a) => ({ login: String((a && a.login) || a), name: "", avatarUrl: "", __typename: "User" })) };
}
function labelsNode(issue) {
  return {
    nodes: (Array.isArray(issue.labels) ? issue.labels : []).map((l) => ({
      name: String((l && l.name) || l || ""),
      color: String((l && l.color) || ""),
      description: String((l && l.description) || ""),
    })),
  };
}
function commentsOf(repo, issue) {
  const bag = repo.comments && repo.comments[String(issue.number)];
  return Array.isArray(bag) ? bag : [];
}
function commentNode(c, i) {
  const author = c && c.author && typeof c.author === "object" ? c.author : { login: "reviewer" };
  return {
    id: String((c && c.id) || `c${i + 1}`),
    author: { login: String(author.login || "reviewer"), avatarUrl: "", __typename: "User" },
    authorAssociation: String((c && c.authorAssociation) || "MEMBER"),
    body: String((c && c.body) || ""),
    createdAt: String((c && c.createdAt) || ""),
    updatedAt: String((c && c.updatedAt) || (c && c.createdAt) || ""),
    lastEditedAt: null,
  };
}

/** 整表查询/单票/子票共用的工单节点;可选裁剪字段以贴合各查询的选择集。 */
function issueNode(issue, repo, groups) {
  const node = { number: num(issue.number), title: String(issue.title || ""), state: stateUpper(issue.state), url: String(issue.url || "") };
  if (groups.body || groups.full) node.body = String(issue.body || "");
  node.createdAt = String(issue.createdAt || "");
  node.updatedAt = String(issue.updatedAt || "");
  if (groups.full || groups.list) node.closedAt = issue.closedAt == null ? null : String(issue.closedAt);
  if (groups.full || groups.list || groups.page || groups.sub) node.author = authorNode(issue);
  if (groups.full || groups.list || groups.page || groups.sub) node.assignees = assigneesNode(issue);
  if (groups.full || groups.list || groups.page || groups.sub) node.labels = labelsNode(issue);
  if (groups.full || groups.list || groups.sub) node.parent = parentNode(issue);
  if (groups.full || groups.list || groups.sub) node.blockedBy = { nodes: blockedRefs(issue) };
  if (groups.full) {
    const all = commentsOf(repo, issue);
    const first = Math.max(0, Number((/comments\(first:(\d+)/.exec(groups.queryText || "") || [])[1] || 0));
    const hasAfter = /comments\(first:\d+, after:\$after\)/.test(groups.queryText || "");
    const offset = hasAfter ? Math.max(0, num(varOf("after"))) : 0;
    const nodes = first > 0 ? all.slice(offset, offset + first).map(commentNode) : [];
    node.comments = {
      totalCount: all.length,
      nodes,
      pageInfo: { hasNextPage: offset + nodes.length < all.length, endCursor: String(offset + nodes.length) },
    };
  }
  return node;
}
function pageNode(issue) {
  return {
    number: num(issue.number),
    title: String(issue.title || ""),
    state: stateUpper(issue.state),
    url: String(issue.url || ""),
    createdAt: String(issue.createdAt || ""),
    updatedAt: String(issue.updatedAt || ""),
    author: authorNode(issue),
    assignees: { nodes: (Array.isArray(issue.assignees) ? issue.assignees : []).map((a) => ({ login: String((a && a.login) || a) })) },
    labels: { nodes: (Array.isArray(issue.labels) ? issue.labels : []).map((l) => ({ name: String((l && l.name) || l || ""), color: String((l && l.color) || "") })) },
  };
}
function prNode(pr) {
  return {
    number: num(pr.number),
    title: String(pr.title || ""),
    state: stateUpper(pr.state),
    body: String(pr.body || ""),
    url: String(pr.url || ""),
    createdAt: String(pr.createdAt || ""),
    updatedAt: String(pr.updatedAt || ""),
    closedAt: pr.closedAt == null ? null : String(pr.closedAt),
    mergedAt: pr.mergedAt == null ? null : String(pr.mergedAt),
    author: authorNode(pr),
    assignees: assigneesNode(pr),
    labels: labelsNode(pr),
    milestone: null,
    comments: { totalCount: 0, nodes: [] },
    reviews: { nodes: [] },
  };
}
function restRow(repoSpec, issue, isPull) {
  const row = {
    number: num(issue.number),
    title: String(issue.title || ""),
    state: stateUpper(issue.state).toLowerCase(),
    body: String(issue.body || ""),
    url: String(issue.url || `https://api.github.com/repos/${repoSpec}/issues/${issue.number}`),
    html_url: String(issue.url || `https://github.com/${repoSpec}/issues/${issue.number}`),
    created_at: String(issue.createdAt || ""),
    updated_at: String(issue.updatedAt || ""),
    closed_at: issue.closedAt == null ? null : String(issue.closedAt),
    labels: (Array.isArray(issue.labels) ? issue.labels : []).map((l) => ({ name: String((l && l.name) || l || ""), color: String((l && l.color) || ""), description: "" })),
    assignees: (Array.isArray(issue.assignees) ? issue.assignees : []).map((a) => ({ login: String((a && a.login) || a) })),
    user: { login: String((issue.author && issue.author.login) || "octocat") },
    // 关系元数据:键在、值为 null / 零,表示「接口表达了、这张是顶层票/没有依赖」。
    parent_issue_url: issue.parentKey == null ? null : `https://api.github.com/repos/${repoSpec}/issues/${issue.parentKey}`,
    issue_dependencies_summary: { blocked_by: Array.isArray(issue.blockedBy) ? issue.blockedBy.length : 0, blocking: 0, total_blocked_by: 0, total_blocking: 0 },
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
  };
  if (isPull) row.pull_request = { merged_at: issue.mergedAt == null ? null : String(issue.mergedAt) };
  return row;
}

// ---- GraphQL 各查询 ----
function gqlRepoOrNull(spec) {
  return repos[spec] && typeof repos[spec] === "object" ? repos[spec] : null;
}
function gqlList(repo, queryText) {
  const all = Array.isArray(repo.issues) ? repo.issues : [];
  const first = Math.max(1, num(varOf("first")) || 50);
  const offset = Math.max(0, num(varOf("after")));
  const page = all.slice(offset, offset + first);
  const hasNext = offset + page.length < all.length;
  return { data: { repository: { issues: { nodes: page.map((i) => issueNode(i, repo, { list: true })), pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(offset + page.length) : null } } } } };
}
function gqlListPulls(repo) {
  const all = Array.isArray(repo.pulls) ? repo.pulls : [];
  const first = Math.max(1, num(varOf("first")) || 50);
  const offset = Math.max(0, num(varOf("after")));
  const page = all.slice(offset, offset + first);
  const hasNext = offset + page.length < all.length;
  return { data: { repository: { pullRequests: { nodes: page.map(prNode), pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(offset + page.length) : null } } } } };
}
function gqlListPage(repo) {
  const afterRaw = varOf("after") || "";
  // 游标不透明:本假 gh 只认自己发出去的十进制偏移;别的一律按 GitHub 的「游标失效」回。
  if (afterRaw && !/^\d+$/.test(afterRaw)) return { errors: [{ type: "INVALID_CURSOR", message: "Something went wrong while executing your query. Invalid cursor." }] };
  const states = listVarOf("states").map((s) => stateUpper(s));
  const labels = listVarOf("labels");
  const since = varOf("since") || "";
  const rows = (Array.isArray(repo.issues) ? repo.issues : [])
    .filter((i) => (states.length ? states.includes(stateUpper(i.state)) : true))
    .filter((i) => labels.every((want) => (Array.isArray(i.labels) ? i.labels : []).some((l) => String((l && l.name) || l) === want)))
    .filter((i) => !since || String(i.updatedAt || "") >= since)
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => {
      const av = String(a.i.createdAt || "");
      const bv = String(b.i.createdAt || "");
      if (av === bv) return a.idx - b.idx;
      return av < bv ? 1 : -1; // 创建时间倒序
    })
    .map((x) => x.i);
  const first = Math.max(1, num(varOf("first")) || 50);
  const offset = Math.max(0, num(varOf("after")));
  const page = rows.slice(offset, offset + first);
  const hasNext = offset + page.length < rows.length;
  return { data: { repository: { issues: { totalCount: rows.length, nodes: page.map(pageNode), pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(offset + page.length) : null } } } } };
}
function gqlCounts(repo) {
  const labels = listVarOf("labels");
  const rows = (Array.isArray(repo.issues) ? repo.issues : []).filter((i) => labels.every((want) => (Array.isArray(i.labels) ? i.labels : []).some((l) => String((l && l.name) || l) === want)));
  const open = repo.counts && typeof repo.counts.open === "number" ? repo.counts.open : rows.filter((i) => stateUpper(i.state) === "OPEN").length;
  const closed = repo.counts && typeof repo.counts.closed === "number" ? repo.counts.closed : rows.filter((i) => stateUpper(i.state) === "CLOSED").length;
  return { data: { repository: { openIssues: { totalCount: open }, closedIssues: { totalCount: closed } } } };
}
function gqlDetail(repo, queryText) {
  const n = num(varOf("number"));
  const issue = (Array.isArray(repo.issues) ? repo.issues : []).find((i) => num(i.number) === n) || null;
  return { data: { repository: { issue: issue ? issueNode(issue, repo, { full: true, queryText }) : null } } };
}
function gqlPullDetail(repo) {
  const n = num(varOf("number"));
  const pr = (Array.isArray(repo.pulls) ? repo.pulls : []).find((i) => num(i.number) === n) || null;
  return { data: { repository: { pullRequest: pr ? prNode(pr) : null } } };
}
function gqlSubIssues(repo) {
  const n = num(varOf("number"));
  const all = (Array.isArray(repo.issues) ? repo.issues : []).filter((i) => i.parentKey != null && num(i.parentKey) === n);
  const first = Math.max(1, num(varOf("first")) || 100);
  const offset = Math.max(0, num(varOf("after")));
  const page = all.slice(offset, offset + first);
  const hasNext = offset + page.length < all.length;
  const claimed = repo.subIssuesTotal && typeof repo.subIssuesTotal[String(n)] === "number" ? repo.subIssuesTotal[String(n)] : all.length;
  return { data: { repository: { issue: { number: n, subIssues: { totalCount: claimed, nodes: page.map((i) => issueNode(i, repo, { sub: true })), pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(offset + page.length) : null } } } } } };
}
function gqlDeps(repo) {
  const n = num(varOf("number"));
  const issue = (Array.isArray(repo.issues) ? repo.issues : []).find((i) => num(i.number) === n);
  const blocked = issue ? blockedRefs(issue) : [];
  return {
    data: {
      repository: {
        issue: {
          number: n,
          blockedBy: { pageInfo: { hasNextPage: false }, nodes: blocked.map((b) => ({ number: b.number, title: b.title, state: b.state, labels: { nodes: [] } })) },
          blocking: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  };
}

// ---- REST 各端点 ----
function restRepo(owner, name) {
  return gqlRepoOrNull(`${owner}/${name}`);
}
function restRows(list, spec, isPull) {
  return (Array.isArray(list) ? list : []).map((i) => restRow(spec, i, isPull));
}
function notFound() {
  return failExit(JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }), 1);
}

async function run() {
  const fail = String((state && state.fail) || "");
  const isGql = argv[0] === "api" && argv[1] === "graphql";
  if (fail === "graphql" ? isGql : fail && fail !== "graphql") {
    if (fail === "ratelimit") return failExit("gh: API rate limit exceeded for user ID 12345. (HTTP 403)", 1);
    if (fail === "network") return failExit("gh: Could not resolve host: api.github.com (getaddrinfo ENOTFOUND)", 1);
    if (fail === "notfound") return failExit("HTTP 404: Not Found (https://api.github.com/repos/owner/name) ", 1);
    if (fail === "auth") return failExit("gh: To get started with GitHub CLI, please run: gh auth login", 4);
    if (fail === "timeout") {
      await sleep(90000);
      return -1;
    }
    if (fail === "graphql") return failExit("post https://api.github.com/graphql: unexpected EOF", 1);
    return failExit(`fake-gh: 不认识的状态 fail=${fail}`, 1);
  }
  if (String(state.auth || "ok") !== "ok") {
    return failExit("gh: To get started with GitHub CLI, please run: gh auth login", 4);
  }

  const [cmd, sub] = argv;
  if (cmd === "auth" && sub === "status") {
    out(`github.com\n  ✓ Logged in to github.com account ${String((state.user && state.user.login) || "octocat")}`);
    return 0;
  }
  if (cmd === "api" && sub === "user") {
    out(JSON.stringify(state.user || { login: "octocat", name: "The Octocat", avatarUrl: "https://avatars.example/octocat.png" }));
    return 0;
  }
  if (cmd === "api" && sub === "graphql") {
    const spec = repoSpecOfGraphql();
    const repo = gqlRepoOrNull(spec);
    if (!repo) return notFound();
    const queryText = queryOf();
    let body;
    if (/subIssues\(first:/.test(queryText)) body = gqlSubIssues(repo);
    else if (/pullRequest\(number:/.test(queryText)) body = gqlPullDetail(repo);
    else if (/pullRequests\(first:/.test(queryText)) body = gqlListPulls(repo);
    else if (/openIssues:/.test(queryText)) body = gqlCounts(repo);
    else if (/blocking\(first:/.test(queryText)) body = gqlDeps(repo);
    else if (/issue\(number:\$number\)/.test(queryText)) body = gqlDetail(repo, queryText);
    else if (/orderBy:\{field:CREATED_AT/.test(queryText)) body = gqlListPage(repo);
    else if (/issues\(first:\$first, after:\$after, states:\[OPEN,CLOSED\]/.test(queryText)) body = gqlList(repo, queryText);
    else return failExit(`fake-gh: 未脚本化的 graphql 查询: ${queryText.slice(0, 120).replace(/\s+/g, " ")}`, 1);
    out(JSON.stringify(body));
    return 0;
  }
  if (cmd === "api" && sub === "meta") {
    out(JSON.stringify({}));
    return 0;
  }
  if (cmd === "api" && sub === "rate_limit") {
    out(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4999, reset: 0 }, graphql: { limit: 5000, remaining: 4999, reset: 0 } } }));
    return 0;
  }
  if (cmd === "api" && typeof sub === "string" && sub.startsWith("repos/")) {
    const [pathPart] = sub.split("?");
    const queryPart = sub.includes("?") ? sub.slice(sub.indexOf("?") + 1) : "";
    const parts = pathPart.split("/");
    const spec = `${parts[1]}/${parts[2]}`;
    const repo = restRepo(parts[1], parts[2]);
    if (!repo) return notFound();
    const tail = parts.slice(3);
    const params = new URLSearchParams(queryPart);
    if (tail.length === 0) {
      out(JSON.stringify(repo.permissions ?? null));
      return 0;
    }
    if (tail[0] === "issues" && tail.length === 1) {
      const want = params.get("state") || "all";
      const list = (Array.isArray(repo.issues) ? repo.issues : []).filter((i) => (want === "all" ? true : stateUpper(i.state).toLowerCase() === want));
      const perPage = Math.max(1, num(params.get("per_page")) || 30);
      const page = Math.max(1, num(params.get("page")) || 1);
      out(JSON.stringify(restRows(list.slice((page - 1) * perPage, page * perPage), spec, false)));
      return 0;
    }
    if (tail[0] === "issues" && tail.length >= 2) {
      const n = num(tail[1]);
      const issue = (Array.isArray(repo.issues) ? repo.issues : []).find((i) => num(i.number) === n);
      if (tail[2] === "comments") {
        const all = issue ? commentsOf(repo, issue) : [];
        out(JSON.stringify(all.map((c, idx) => ({ id: Number((c && c.id) || idx + 1) || idx + 1, user: { login: String((c && c.author && c.author.login) || "reviewer") }, body: String((c && c.body) || ""), created_at: String((c && c.createdAt) || ""), updated_at: String((c && c.updatedAt) || (c && c.createdAt) || ""), author_association: "MEMBER" }))));
        return 0;
      }
      if (tail[2] === "dependencies" && tail[3] === "blocked_by") {
        const refs = issue ? blockedRefs(issue) : [];
        const rows = refs.map((b) => restRow(spec, (Array.isArray(repo.issues) ? repo.issues : []).find((i) => num(i.number) === b.number) || { number: b.number, title: b.title, state: b.state }, false));
        out(JSON.stringify(rows));
        return 0;
      }
      if (tail[2] === "sub_issues") {
        const kids = (Array.isArray(repo.issues) ? repo.issues : []).filter((i) => i.parentKey != null && num(i.parentKey) === n);
        out(JSON.stringify(restRows(kids, spec, false)));
        return 0;
      }
      if (tail.length === 2) {
        if (!issue) return notFound();
        out(JSON.stringify(restRow(spec, issue, false)));
        return 0;
      }
      return failExit(`fake-gh: 未脚本化的 REST 路径: ${sub}`, 1);
    }
    if (tail[0] === "pulls") {
      if (tail.length === 1) {
        const perPage = Math.max(1, num(params.get("per_page")) || 30);
        const page = Math.max(1, num(params.get("page")) || 1);
        const list = Array.isArray(repo.pulls) ? repo.pulls : [];
        out(JSON.stringify(restRows(list.slice((page - 1) * perPage, page * perPage), spec, true)));
        return 0;
      }
      const n = num(tail[1]);
      const pr = (Array.isArray(repo.pulls) ? repo.pulls : []).find((i) => num(i.number) === n);
      if (tail[2] === "reviews") {
        out(JSON.stringify([]));
        return 0;
      }
      if (!pr) return notFound();
      out(JSON.stringify(restRow(spec, pr, true)));
      return 0;
    }
    return failExit(`fake-gh: 未脚本化的 REST 路径: ${sub}`, 1);
  }
  if (cmd === "repo" && sub === "view") {
    const spec = flagValue("--repo", "") || Object.keys(repos)[0] || "";
    if (!spec || !repos[spec]) return notFound();
    out(spec);
    return 0;
  }
  if (cmd === "label" && sub === "list") {
    const spec = flagValue("--repo", "");
    const repo = gqlRepoOrNull(spec);
    if (!repo) return notFound();
    out(JSON.stringify(Array.isArray(repo.labels) ? repo.labels : []));
    return 0;
  }
  if (cmd === "issue" && sub === "view") {
    const spec = flagValue("--repo", "");
    const repo = gqlRepoOrNull(spec);
    if (!repo) return notFound();
    const n = num(argv[2]);
    const issue = (Array.isArray(repo.issues) ? repo.issues : []).find((i) => num(i.number) === n);
    if (!issue) return notFound();
    out(JSON.stringify({
      number: num(issue.number),
      title: String(issue.title || ""),
      state: stateUpper(issue.state),
      body: String(issue.body || ""),
      url: String(issue.url || ""),
      createdAt: String(issue.createdAt || ""),
      updatedAt: String(issue.updatedAt || ""),
      closedAt: issue.closedAt == null ? null : String(issue.closedAt),
      labels: (Array.isArray(issue.labels) ? issue.labels : []).map((l) => ({ name: String((l && l.name) || l), color: String((l && l.color) || "") })),
      assignees: (Array.isArray(issue.assignees) ? issue.assignees : []).map((a) => ({ login: String((a && a.login) || a) })),
      author: authorNode(issue),
    }));
    return 0;
  }
  if (cmd === "issue" && sub === "list") {
    const spec = flagValue("--repo", "");
    const repo = gqlRepoOrNull(spec);
    if (!repo) return notFound();
    const want = flagValue("--state", "open");
    const list = (Array.isArray(repo.issues) ? repo.issues : []).filter((i) => stateUpper(i.state).toLowerCase() === want);
    out(JSON.stringify(list.map((i) => ({ number: num(i.number), title: String(i.title || ""), state: stateUpper(i.state), body: String(i.body || ""), url: String(i.url || "") }))));
    return 0;
  }
  if (cmd === "search" && sub === "issues") {
    out(JSON.stringify([]));
    return 0;
  }
  return failExit(`fake-gh: 未脚本化的命令: ${argv.join(" ")}`, 1);
}

const result = await run();
if (typeof result === "number") process.exitCode = result;
else if (result && typeof result === "object") {
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = typeof result.code === "number" ? result.code : 1;
}

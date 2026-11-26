// test/gh-harness.mjs —— GitHub 后端测试脚手架(票 03 建;04/05/06 续用)。
//
// 两件东西:
//   makeFakeGh({state})  → 写临时状态/日志文件,交回 env(ZCODE_GH_PATH 指 fixtures/fake-gh.mjs)、
//                          calls()/state()/patch(fn)/clearCalls()/cleanup()。
//   makeWorkspace({repo, anchor, cards}) → 临时工作区(带 .git/config 远端;可选锚文件与 .scratch 卡片),
//                          交回 root/cleanup/write()。
// 与 server 套件同一缝:真服务进程 + 假 gh,断言只打工具回包与假 gh 调用日志。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");

/** 假 gh:状态文件 + NDJSON 调用日志。state 里多留字段不要紧(见 fixtures/fake-gh.mjs 的文件头)。 */
export function makeFakeGh({ state } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "m7-gh-"));
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.ndjson");
  writeFileSync(statePath, JSON.stringify(state || {}, null, 2), "utf8");
  writeFileSync(logPath, "", "utf8");
  const calls = () =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line))
      : [];
  const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (fn) => {
    const next = readState();
    fn(next);
    writeFileSync(statePath, JSON.stringify(next, null, 2), "utf8");
  };
  const clearCalls = () => writeFileSync(logPath, "", "utf8");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return {
    env: { ZCODE_GH_PATH: FAKE_GH, ZCODE_FAKE_GH_STATE: statePath, ZCODE_FAKE_GH_LOG: logPath },
    calls,
    state: readState,
    patch,
    clearCalls,
    cleanup,
    dir,
  };
}

/** 临时工作区:带 .git/config 的 origin;可选锚文件与 .scratch 卡片(给 markdown 回归用)。 */
export function makeWorkspace({ repo = "owner/name", anchor = null, cards = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "m7-ws-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/${repo}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    "utf8"
  );
  if (anchor) {
    mkdirSync(join(root, "docs", "agents"), { recursive: true });
    writeFileSync(join(root, "docs", "agents", "issue-tracker.md"), anchor, "utf8");
  }
  for (const card of cards) {
    const dir = join(root, ".scratch", card.effort || "demo", "issues");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${card.n || "01"}-${card.slug || "card"}.md`), card.text || `# ${card.n || "01"}: ${card.title || "卡"}\n\n**Status:** ${card.status || "open"}\n\n正文。\n`, "utf8");
  }
  return {
    root,
    write(rel, text) {
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, "utf8");
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 一个最小仓库状态:两张开放票、一张已关闭、一张地图 + 子票、一张拉取请求、三条评论、标签色。 */
export function baseState({ repo = "owner/name" } = {}) {
  return {
    auth: "ok",
    user: { login: "octocat" },
    repos: {
      [repo]: {
        permissions: { push: true, triage: true },
        issues: [
          {
            number: 1,
            title: "地图:探索",
            state: "OPEN",
            body: "地图正文",
            url: `https://github.com/${repo}/issues/1`,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-05T00:00:00Z",
            closedAt: null,
            labels: [{ name: "wayfinder:map", color: "8b5cf6" }],
            assignees: [],
            author: { login: "octocat" },
            parentKey: null,
            blockedBy: [],
          },
          {
            number: 4,
            title: "把读通路接上",
            state: "OPEN",
            body: "正文 4",
            url: `https://github.com/${repo}/issues/4`,
            createdAt: "2026-01-02T00:00:00Z",
            updatedAt: "2026-01-06T00:00:00Z",
            closedAt: null,
            labels: [
              { name: "ready-for-agent", color: "0e8a16" },
              { name: "bug", color: "d73a4a" },
            ],
            assignees: [{ login: "octocat" }],
            author: { login: "alice" },
            parentKey: "1",
            blockedBy: [],
          },
          {
            number: 5,
            title: "被 4 挡住的票",
            state: "OPEN",
            body: "正文 5",
            url: `https://github.com/${repo}/issues/5`,
            createdAt: "2026-01-03T00:00:00Z",
            updatedAt: "2026-01-07T00:00:00Z",
            closedAt: null,
            labels: [],
            assignees: [],
            author: { login: "bob" },
            parentKey: "1",
            blockedBy: [{ key: "4" }],
          },
          {
            number: 6,
            title: "已经关掉",
            state: "CLOSED",
            body: "正文 6",
            url: `https://github.com/${repo}/issues/6`,
            createdAt: "2026-01-04T00:00:00Z",
            updatedAt: "2026-01-08T00:00:00Z",
            closedAt: "2026-01-09T00:00:00Z",
            labels: [{ name: "wontfix", color: "ffffff" }],
            assignees: [],
            author: { login: "carol" },
            parentKey: null,
            blockedBy: [],
          },
        ],
        pulls: [
          {
            number: 9,
            title: "这是一张拉取请求",
            state: "OPEN",
            body: "pr",
            url: `https://github.com/${repo}/pull/9`,
            createdAt: "2026-01-05T00:00:00Z",
            updatedAt: "2026-01-09T00:00:00Z",
            closedAt: null,
            mergedAt: null,
            labels: [],
            assignees: [],
            author: { login: "dave" },
          },
        ],
        comments: {
          4: [
            { id: "c1", author: { login: "alice" }, body: "第一条", createdAt: "2026-01-02T01:00:00Z" },
            { id: "c2", author: { login: "bob" }, body: "第二条", createdAt: "2026-01-02T02:00:00Z" },
            { id: "c3", author: { login: "carol" }, body: "第三条", createdAt: "2026-01-02T03:00:00Z" },
          ],
        },
        labels: [
          { name: "bug", color: "ff0000", description: "仓库真色覆盖内置色" },
          { name: "needs-triage", color: "fbca04", description: "" },
          { name: "area/ui", color: "112233", description: "" },
        ],
      },
    },
    fail: null,
  };
}

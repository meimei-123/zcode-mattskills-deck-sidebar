// src/github/backend.mjs —— 每个项目根的后端结论(票 02)。
//
// 顺序:本会话手选 > 锚文件声明 > 默认本地 Markdown。锚文件是项目根的
// docs/agents/issue-tracker.md,**每次调用现读**(改了即生效);只认一级标题,
// 不看正文关键词。三条正则照上游 kernel/issue-tracker-declaration.ts,优先级
// gitlab > markdown|local > github。
//
// 有意偏离上游:不做按远端地址的自动识别(规格「后端判定」)。远端指向 github.com
// 只产一条提示位,判断只读本地 git 配置,不出站。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoLocal } from "./repo.mjs";
import { choiceOf } from "./state.mjs";

const ANCHOR_REL = ["docs", "agents", "issue-tracker.md"];
const GITLAB_HINT = "锚文件声明的是 GitLab 后端,本版不支持,按本地 Markdown 显示";
const SWITCH_HINT = "项目远端是 GitHub,可以切到 GitHub 议题";

/** 锚文件声明的后端:"github" | "markdown" | "gitlab" | null。
 *  文件缺失/读不动/没有一级标题都回 null;正文关键词不兜底。 */
export function readAnchor(root) {
  let text = "";
  try {
    text = readFileSync(join(String(root || ""), ...ANCHOR_REL), "utf8");
  } catch {
    return null;
  }
  text = String(text).replace(/^\uFEFF/, "");
  if (/^#\s*issue\s*tracker\s*:\s*gitlab/im.test(text)) return "gitlab";
  if (/^#\s*issue\s*tracker\s*:\s*(markdown|local)/im.test(text)) return "markdown";
  if (/^#\s*issue\s*tracker\s*:\s*github/im.test(text)) return "github";
  return null;
}

/** 按 id 组装 backend 块:github 带仓库短名与地址;markdown 只带「可切换」提示。 */
function blockFor(root, id, source) {
  if (id === "github") {
    const repo = resolveRepoLocal(root);
    return {
      id,
      source,
      repo: repo ? { name: repo.refId, url: repo.url } : null,
      writable: null, // 票 02 没有权限缓存;票 04/05 补
      hint: null,
    };
  }
  return {
    id: "markdown",
    source,
    repo: null,
    writable: null,
    hint: resolveRepoLocal(root) ? SWITCH_HINT : null,
  };
}

/** 项目根 → { id, source, repo, writable, hint }。每次调用都重算(锚文件现读、手选读状态)。 */
export function backendStateOf(root) {
  const choice = choiceOf(root);
  if (choice) return blockFor(root, choice, "session");
  const anchor = readAnchor(root);
  if (anchor === "gitlab") {
    return { id: "markdown", source: "anchor", repo: null, writable: null, hint: GITLAB_HINT };
  }
  if (anchor === "github") return blockFor(root, "github", "anchor");
  if (anchor === "markdown") return blockFor(root, "markdown", "anchor");
  return blockFor(root, "markdown", "default");
}

/** 一行中文摘要(工具人话用)。 */
export function backendSummary(root, backend) {
  const b = backend || backendStateOf(root);
  if (b.id === "github") {
    return b.repo && b.repo.name ? `后端:GitHub(仓库 ${b.repo.name})` : "后端:GitHub(仓库未解析出)";
  }
  const source = b.source === "session" ? "本会话手选" : b.source === "anchor" ? "锚文件声明" : "默认";
  return `后端:本地 Markdown(${source})`;
}

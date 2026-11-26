// src/github/dispatch.mjs —— GitHub 后端的工具分派表(票 03 建;04/05/06 续)。
//
// 活动项目的后端是 GitHub 时,handleCall 在 deck_project_list/use/backend_use 之后、.scratch 扫描
// 之前把本插件负责的工具名交到这里:GitHub 项目不扫 .scratch、不挂监听。
// 本票只接五个读工具;六个写工具与 deck_map_link 一律回「写通路尚未接(票 04)」,
// deck_env_check 在票 06 之前同样回尚未接 —— 都不产生任何本地副作用。
import { issueCounts, issueGet, issueList, issueListLabels, mapTickets } from "./tools-read.mjs";

const READ_TOOLS = {
  deck_issue_list: issueList,
  deck_issue_get: issueGet,
  deck_issue_counts: issueCounts,
  deck_issue_list_labels: issueListLabels,
  deck_map_tickets: mapTickets,
};

const WRITE_TOOLS = new Set([
  "deck_issue_create",
  "deck_issue_update",
  "deck_issue_set_labels",
  "deck_issue_comment",
  "deck_issue_close",
  "deck_issue_reopen",
  "deck_map_link",
]);

function failWithText(text, kind, raw) {
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { ok: false, error: { kind, message: text, raw: raw === undefined ? "" : raw } },
  };
}

/** 本票的写工具:明确回「尚未接」,一个字节都不落到本地卡片。 */
function writeNotWired(name) {
  return failWithText(
    `${name}:GitHub 后端的写通路尚未接(票 04)。这次调用没有向 GitHub 发任何写请求,也没有改动本地卡片。读取与计数仍可照常使用。`,
    "unsupported"
  );
}

/**
 * GitHub 后端的工具入口。ctx:{root, backend(票 02 的 backend 块), active, palette{canonical,colors}}。
 * 返回与 markdown 分支同形状的 {content, structuredContent} / {content, isError, structuredContent}。
 */
export async function dispatchGithub(name, args, ctx) {
  const read = READ_TOOLS[name];
  if (read) return read(args, ctx);
  if (WRITE_TOOLS.has(name)) return writeNotWired(name);
  if (name === "deck_env_check") {
    return failWithText(
      "环境检查的 GitHub 七步链尚未接(票 06)。当前可以先用 deck_issue_list 试读一次:能读到议题就说明 gh、登录与仓库访问都通。",
      "unsupported"
    );
  }
  return failWithText(`未知工具 ${name}`, "unsupported");
}

// src/github/dispatch.mjs —— GitHub 后端的工具分派表(票 03 建;04/05/06 续)。
//
// 活动项目的后端是 GitHub 时,handleCall 在 deck_project_list/use/backend_use 之后、.scratch 扫描
// 之前把本插件负责的工具名交到这里:GitHub 项目不扫 .scratch、不挂监听。
// 票 04 起接上六个写工具与 deck_map_link(写前权限门、写后推进修订号都在 tools-write.mjs 里);
// deck_env_check 在票 06 之前仍回尚未接 —— 不产生任何本地副作用。
import { issueCounts, issueGet, issueList, issueListLabels, mapTickets } from "./tools-read.mjs";
import { issueClose, issueComment, issueCreate, issueReopen, issueSetLabels, issueUpdate, mapLink } from "./tools-write.mjs";

const READ_TOOLS = {
  deck_issue_list: issueList,
  deck_issue_get: issueGet,
  deck_issue_counts: issueCounts,
  deck_issue_list_labels: issueListLabels,
  deck_map_tickets: mapTickets,
};

const WRITE_TOOLS = {
  deck_issue_create: issueCreate,
  deck_issue_update: issueUpdate,
  deck_issue_set_labels: issueSetLabels,
  deck_issue_comment: issueComment,
  deck_issue_close: issueClose,
  deck_issue_reopen: issueReopen,
  deck_map_link: mapLink,
};

function failWithText(text, kind, raw) {
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { ok: false, error: { kind, message: text, raw: raw === undefined ? "" : raw } },
  };
}

/**
 * GitHub 后端的工具入口。ctx:{root, backend(票 02 的 backend 块), active, palette{canonical,colors}}。
 * 返回与 markdown 分支同形状的 {content, structuredContent} / {content, isError, structuredContent}。
 */
export async function dispatchGithub(name, args, ctx) {
  const read = READ_TOOLS[name];
  if (read) return read(args, ctx);
  const write = WRITE_TOOLS[name];
  if (write) return write(args, ctx);
  if (name === "deck_env_check") {
    return failWithText(
      "环境检查的 GitHub 七步链尚未接(票 06)。当前可以先用 deck_issue_list 试读一次:能读到议题就说明 gh、登录与仓库访问都通。",
      "unsupported"
    );
  }
  return failWithText(`未知工具 ${name}`, "unsupported");
}

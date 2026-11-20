// src/skill-doc.mjs —— 技能原文直读(工单 02):按技能根顺序找 <name>/SKILL.md,只读、不写盘。
// 上游对应物是宿主电话 skill.readDoc(src/host/skillDoc.ts);本仓没有宿主进程,面板经工具桥
// 调 deck_skill_doc,服务端落在这里。根顺序(同名先命中,工单 02 裁定):
//   工作区 .zcode/skills → ~/.zcode/skills → ~/.agents/skills → 插件内置 skills
//   (插件根取 ZCODE_PLUGIN_ROOT 环境变量,缺席就跳过)。
// 技能名只认目录名:斜杠、反斜杠、..、绝对路径一律拒绝(防穿越,回 reason=invalid);
// 读盘异常(权限等)照实抛,由 server 回 isError(上游 pixelFetch 的「读失败」重试语义)。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 名字不合法时回人话原因;合法回空串。 */
export function skillNameProblem(name) {
  if (typeof name !== "string" || !name.trim()) return "缺少技能名";
  if (name.includes("/") || name.includes("\\")) return "技能名不能带路径分隔符";
  if (name.includes("..")) return "技能名不能带 ..";
  if (isAbsolute(name)) return "技能名不能是绝对路径";
  if (name.includes("\0")) return "技能名带非法字符";
  return "";
}

/** 技能根候选(标签给回包 source;数组顺序即优先级)。 */
export function skillRoots(workspaceRoot, env) {
  const roots = [];
  if (workspaceRoot) roots.push({ label: "workspace", dir: join(String(workspaceRoot), ".zcode", "skills") });
  let home = "";
  try {
    home = homedir() || "";
  } catch (e) {
    home = ""; // 取不到家目录只少两档根,不挡工作区/插件根
  }
  if (home) {
    roots.push({ label: "user-zcode", dir: join(home, ".zcode", "skills") });
    roots.push({ label: "user-agents", dir: join(home, ".agents", "skills") });
  }
  const pluginRoot = env && env.ZCODE_PLUGIN_ROOT ? String(env.ZCODE_PLUGIN_ROOT) : "";
  if (pluginRoot) roots.push({ label: "plugin", dir: join(pluginRoot, "skills") });
  return roots;
}

/** 剥文件头 YAML frontmatter(上游 skillDoc.stripFrontmatter 同口径:只剥第一段 --- 块)。 */
function stripFrontmatter(raw) {
  const s = String(raw || "").replace(/^\uFEFF/, "");
  const m = s.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  return m ? s.slice(m[0].length) : s;
}

/**
 * 读一份技能原文。返回:
 *   {ok:true, name, path(绝对), md, source(命中根标签)}
 *   {ok:false, name, reason:'missing'}            找不到 / 空文件(不是错误,上游画缺文说明)
 *   {ok:false, name, reason:'invalid', message}   名字不合法(server 回 isError)
 * 读盘异常直接抛(server 回 isError,对应上游「读失败」重试)。
 */
export function readSkillDoc(params, opts) {
  const p = params || {};
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const problem = skillNameProblem(name);
  if (problem) return { ok: false, name: name, reason: "invalid", message: problem };
  for (const root of skillRoots(opts && opts.workspaceRoot, opts && opts.env)) {
    const file = join(root.dir, name, "SKILL.md");
    let st;
    try {
      st = statSync(file);
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) continue; // 这一档根没有这个技能
      throw e; // 读得动但读失败:权限等,按读失败上抛
    }
    if (!st || !st.isFile()) continue;
    const md = stripFrontmatter(readFileSync(file, "utf8"));
    if (!md.trim()) return { ok: false, name: name, reason: "missing" }; // 空文件按「没有这一篇」(上游同款)
    return { ok: true, name: name, path: file, md: md, source: root.label };
  }
  return { ok: false, name: name, reason: "missing" };
}

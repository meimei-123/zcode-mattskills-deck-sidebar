// src/skill-roots.mjs —— 技能根单一真源(0.3.1 review 收口)。
// deck_skill_doc(读 SKILL.md 原文)与 deck_env_check 的 env:skills 判据共用这一份顺序,
// 不再两处各写一份(旧写法 env-check 还漏了插件根,两处顺序对不上)。
//
// 顺序(同名先命中):工作区 .zcode/skills → ~/.zcode/skills → ~/.agents/skills →
// ${ZCODE_PLUGIN_ROOT}/skills(插件根;环境变量缺席时跳过)。
// 返回项:{ label(机器名,回包 source), title(人话,检查页 desc 用), dir(路径) }。
import { homedir } from "node:os";
import { join } from "node:path";

export function skillRootsFor(workspaceRoot, env) {
  const roots = [];
  if (workspaceRoot) roots.push({ label: "workspace", title: "工作区 .zcode/skills", dir: join(String(workspaceRoot), ".zcode", "skills") });
  let home = "";
  try {
    home = homedir() || "";
  } catch (e) {
    home = ""; // 取不到家目录只少两档用户根,不挡工作区/插件根
  }
  if (home) {
    roots.push({ label: "user-zcode", title: "~/.zcode/skills", dir: join(home, ".zcode", "skills") });
    roots.push({ label: "user-agents", title: "~/.agents/skills", dir: join(home, ".agents", "skills") });
  }
  const pluginRoot = env && env.ZCODE_PLUGIN_ROOT ? String(env.ZCODE_PLUGIN_ROOT) : "";
  if (pluginRoot) roots.push({ label: "plugin", title: "插件内置 skills", dir: join(pluginRoot, "skills") });
  return roots;
}

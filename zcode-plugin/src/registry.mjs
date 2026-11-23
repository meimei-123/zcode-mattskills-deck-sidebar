// 票 01:项目清单(home-repo 根 .deck/projects.json)读取校验 + 活动项目解析。
// 纯函数、现读现算:每次 readRegistry 都重新读盘,不缓存、不监听 .deck/。
// 清单是唯一信任来源:条目坏了只跳过那一条(warnings 带人话原因,其余条目照常可用);
// 整份 JSON 坏掉退回单根并带解析错误;文件缺失静默退回单根。
// home-repo 隐式存在、永远第一项、不可删除,名字默认取目录名;清单里再写 "." 或
// home-repo 的真实路径会被忽略并给 warning。
// 路径口径:path 必填,绝对或相对;相对路径按 home-repo 根解析(不按 .deck/);
// 不展开 ~ 与环境变量,无 glob;按 realpathSync.native 去重(junction/符号链接
// 指向同一目录只算一项)。名字非空、不含 / 或 \,不区分大小写唯一,home-repo 的名字保留。
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

/** 名字合法:非空(去首尾空白)且不含 / 或 \。 */
function isValidName(name) {
  const s = String(name === undefined || name === null ? "" : name).trim();
  return s.length > 0 && !s.includes("/") && !s.includes("\\");
}

function realpathOf(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/** 读 + 校验项目清单。返回 {status, file, error, home, projects, warnings}:
 *  status  missing(文件缺失,静默单根)/ ok / broken(整份坏,退回单根 + error);
 *  home    {name, path(realpath), isHome:true, valid:true};
 *  projects 按清单顺序的全部条目,每项 {name, path, isHome:false, valid, reason?}
 *          (valid=false 的条目不可切换,原因在 reason 与 warnings);
 *  warnings 中文条目级警告(含 broken 时整份错误在 error,不进 warnings)。 */
export function readRegistry(homeRoot) {
  const file = join(homeRoot, ".deck", "projects.json");
  const homeReal = realpathOf(homeRoot) || homeRoot;
  const home = { name: basename(homeReal), path: homeReal, isHome: true, valid: true };
  if (!existsSync(file)) {
    return { status: "missing", file, error: null, home, projects: [], warnings: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { status: "broken", file, error: `JSON 解析失败:${e && e.message ? e.message : String(e)}`, home, projects: [], warnings: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.projects)) {
    return { status: "broken", file, error: "清单结构不对:顶层要是对象,且带 projects 数组", home, projects: [], warnings: [] };
  }

  const projects = [];
  const warnings = [];
  const seenNames = new Set([home.name.toLowerCase()]);
  const seenReal = new Set([homeReal]);

  parsed.projects.forEach((raw, i) => {
    const at = `第 ${i + 1} 条`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`${at}不是对象,已跳过`);
      return;
    }
    const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
    const rawPath = typeof raw.path === "string" ? raw.path.trim() : "";
    const shown = rawName || (rawPath ? basename(rawPath) : "(未命名)");
    const absPath = rawPath ? (isAbsolute(rawPath) ? rawPath : resolve(homeRoot, rawPath)) : "";
    const skip = (reason) => {
      projects.push({ name: rawName || shown, path: absPath, isHome: false, valid: false, reason });
      warnings.push(`${at}(${shown})${reason},已跳过`);
    };
    if (!rawPath) return skip("缺 path");
    if (rawName && !isValidName(rawName)) return skip("名字非法(为空或含 / \\)");
    let st;
    try {
      st = statSync(absPath);
    } catch {
      return skip("路径不存在");
    }
    if (!st.isDirectory()) return skip("不是目录");
    const real = realpathOf(absPath);
    if (!real) return skip("路径解析不了(realpath 失败)");
    if (real === homeReal) return skip(`写的是 home-repo 本身("."或其真实路径)`);
    if (seenReal.has(real)) return skip("与已有条目指向同一个目录(realpath 重复)");
    const name = rawName || basename(real);
    if (seenNames.has(name.toLowerCase())) return skip(`名字「${name}」与已有项目重名`);
    seenReal.add(real);
    seenNames.add(name.toLowerCase());
    projects.push({ name, path: absPath, isHome: false, valid: true });
  });

  return { status: "ok", file, error: null, home, projects, warnings };
}

/** 按现读清单解析活动项目。activeName 为空(null/未设)= home-repo。
 *  名字命中有效条目(不区分大小写)→ 该项目(同名项改路径自然指向新路径);
 *  名字已不在清单里(被移出/改名)或清单整份坏 → 回退 home-repo,note 带人话说明。 */
export function resolveActive(state, activeName) {
  const home = state.home;
  const atHome = { root: home.path, name: home.name, isHome: true, note: null };
  const wanted = String(activeName === undefined || activeName === null ? "" : activeName).trim();
  if (!wanted) return atHome;
  if (state.status === "broken") {
    return { ...atHome, note: `项目清单读不出来(${state.error}),活动项目「${wanted}」暂时回退到 home-repo。` };
  }
  const hit = state.projects.find((p) => p.valid && p.name.toLowerCase() === wanted.toLowerCase());
  if (hit) return { root: hit.path, name: hit.name, isHome: false, note: null };
  return { ...atHome, note: `活动项目「${wanted}」已不在项目清单里(被移出或改名),回退到 home-repo。` };
}

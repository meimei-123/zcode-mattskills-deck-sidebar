// src/env-check-github.mjs —— 活动项目是 GitHub 时的七步检查链(票 06)。
//
// 回包形状与 src/env-check.mjs 的六步链完全一致(stepOf/snapshotOf 按同一口径复刻,
// 不改那边的现有行为)。七步顺序固定:
//   git:repo → gh:remote → gh:installed → gh:authed → gh:repoAccess → env:bridge → env:skills
//
// 事实来源(每个 step 一条,能摸到真实状态才写):
//   git:repo      工作区根有 .git(目录或 worktree 指针文件)。GitHub 后端不靠本地 git 立身
//                 —— 仓库身份由锚文件声明与远端解析决定 —— 所以这一步只如实报告、不挡链:
//                 没有 .git 时由 gh:remote 停住并给原因,免得同一件事在两步里各报一次。
//   gh:remote     resolveRepoLocal(root) 解析出 GitHub 仓库(只读本地 git,不出站)。
//   gh:installed  resolveGhPath(process.env) 找得到 gh(不探测常见安装目录)。
//   gh:authed /   一次 room.backend.preflight(gh 可执行 → 登录 → 仓库可达)按 error.kind 归位:
//   gh:repoAccess env → installed;auth → authed;not-found/network/rate-limit/其它 → repoAccess;
//                 成功 → 两步都 done。失败即停在该步,之后的步骤一律 pending(不叠下游失败)。
//   gh:repoAccess 成功后问一次 getRepoPermissions,描述写「可写 / 只读 / 未知」;问成的结论
//                 写进 state 的权限缓存(票 04 的写权限门复用)。问不出来记未知,不许写成可写。
//   env:bridge    恒 done(能返回这份快照就说明工具桥在线)。
//   env:skills    skillRootsFor(homeRoot, env) 至少一处可读(与本地链同一真源;技能根不随项目)。
//
// 缓存:会出站的事实按项目根真实路径缓存(TTL = probeBaseMs(),与计数缓存同一档)。
// 非 force 且未过期 → 直接回缓存快照,零出站(检查页 5 秒一拍不能每拍问 GitHub);
// force(用户点「重新检查」)→ 清检查缓存与权限缓存,再 probeGithub({force:true}) 真重探一次
// (顺手刷新看板),然后重建链并写缓存。修复动作的文案由本仓自己写,不出现 DSH。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { summarizeEnvCheck } from "./env-check.mjs";
import { resolveGhPath } from "./github/gh-path.mjs";
import { probeBaseMs, probeGithub } from "./github/probe.mjs";
import { resolveRepoLocal } from "./github/repo.mjs";
import { roomFor } from "./github/room.mjs";
import { clearEnvCheckCache, clearPerm, envCheckCacheOf, setEnvCheckCache, setPerm } from "./github/state.mjs";
import { skillRootsFor } from "./skill-roots.mjs";

const TITLES = {
  "git:repo": "本地 git 仓库",
  "gh:remote": "已关联 GitHub 仓库",
  "gh:installed": "已安装 gh 命令行",
  "gh:authed": "已登录 GitHub",
  "gh:repoAccess": "仓库可访问",
  "env:bridge": "工具桥在线",
  "env:skills": "技能根可读",
};

/** 修复动作的统一形状(与本地链同一词汇表:inject-prompt 经 ChecksTab 落进对话)。 */
function injectAction(label, prompt) {
  return { type: "inject-prompt", label, prompt };
}

/** 目录可读 = 存在且 readdir 不抛(只读探测,不写盘)。 */
function dirReadable(path) {
  try {
    if (!existsSync(path)) return false;
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 链快照计数(与 src/env-check.mjs 的 snapshotOf 同口径;单段链不判 failedIndex 的差别)。 */
function snapshotOf(steps) {
  const firstNotDone = steps.findIndex((s) => s.status !== "done");
  const allDone = firstNotDone < 0;
  const snapshot = {
    steps,
    currentIndex: allDone ? null : firstNotDone,
    failedIndex: firstNotDone,
    doneCount: steps.filter((s) => s.status === "done").length,
    applicableCount: steps.length,
    totalCount: steps.length,
    chainState: allDone ? "allDone" : steps[firstNotDone].status === "pending" ? "pending" : "hasCurrent",
    version: "1",
  };
  if (allDone) snapshot.isComplete = true;
  else {
    snapshot.isComplete = false;
    snapshot.hasBlockingFailure = steps[firstNotDone].status !== "pending";
    snapshot.blockingCheck = steps[firstNotDone].id;
  }
  return snapshot;
}

/** 一颗 step(与本地链同形;pending 行不带动作)。 */
function stepOf(id, status, show, actions) {
  return { id, status, show, actions: Array.isArray(actions) ? actions : [], blockedBy: null };
}

const PENDING_DESC = "前面的检查项没通过,这一步还没检查";

/** 未通过时的常见说法:原因进 desc,下一步进 hint,不给动作(票面口径)。 */
function failStep(id, desc, hint) {
  return stepOf(id, "fail", { fallback: TITLES[id], desc, hint }, []);
}

/** 预检失败档位 → 人话原因(原文含 DSH 字样,不往 desc/hint 里搬)。 */
function accessReasonOf(kind) {
  switch (kind) {
    case "not-found":
      return "GitHub 上找不到这个仓库(地址不对,或当前账号没有访问权限)";
    case "network":
      return "连不上 GitHub(检查网络或代理)";
    case "rate-limit":
      return "被 GitHub 限流了(过一会儿再试)";
    default:
      return "仓库预检没通过";
  }
}

/** gh:repoAccess 的描述:权限已知就写可写/只读,问不出来写未知(不许写成可写)。 */
function accessDescOf(refId, perm) {
  const known = perm && perm.known === true;
  if (known && (perm.push === true || perm.triage === true)) {
    return `仓库 ${refId} 可访问,当前账号可写(push 或 triage 有其一)`;
  }
  if (known) return `仓库 ${refId} 可访问,当前账号只读(不能推也不能整理)`;
  return `仓库 ${refId} 可访问,写权限未知(这次没问出来,不代表只能读)`;
}

/**
 * 按真实事实组链。facts:
 *   { gitRepo:boolean, repo:{refId,url}|null, gh:{path,kind}|null,
 *     preflight:{ok:true}|{ok:false,kind,message}|null,
 *     perm:{known:true,push,triage}|{known:false}|null,
 *     skillRoot:string, env:{...} }
 */
export function buildGithubChain(root, facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const repo = f.repo || null;
  const gh = f.gh || null;
  const pre = f.preflight || null;
  const perm = f.perm || null;
  const steps = [];
  let blocked = false;
  const pending = (id) => steps.push(stepOf(id, "pending", { fallback: TITLES[id], desc: PENDING_DESC }, []));

  // 1) 本地 git:报告事实,不挡链(GitHub 后端不依赖本地 .git;无仓库由下一步说明)。
  steps.push(
    stepOf(
      "git:repo",
      "done",
      f.gitRepo === true
        ? { fallback: TITLES["git:repo"], desc: "工作区根有 .git" }
        : {
            fallback: TITLES["git:repo"],
            desc: "工作区根没有 .git(GitHub 后端不依赖本地 git 仓库;仓库身份由锚文件声明与远端解析决定)",
          },
      []
    )
  );

  // 2) 仓库关联:本地远端解析(不出站)。解析不出来就停在这里。
  if (repo && repo.refId) {
    steps.push(stepOf("gh:remote", "done", { fallback: TITLES["gh:remote"], desc: `origin 指向 ${repo.refId}` }, []));
  } else {
    steps.push(
      failStep(
        "gh:remote",
        "项目根没有关联 GitHub 仓库(origin 没指向 github.com)",
        "先把项目根的 origin 指到一个 GitHub 仓库,再点「重新检查」"
      )
    );
    blocked = true;
  }

  // 3) gh 可执行:preflight 的 env 档也归到这一步(例如只解析到 .cmd,起不来)。
  if (blocked) pending("gh:installed");
  else if (!gh || (pre && pre.ok !== true && pre.kind === "env")) {
    steps.push(
      stepOf(
        "gh:installed",
        "current",
        {
          fallback: TITLES["gh:installed"],
          desc: "本机解析不到 gh 命令行(没装,或不在 PATH 里,也没设 ZCODE_GH_PATH)",
        },
        [
          injectAction(
            "安装 gh",
            "本机还没解析到 gh 命令行。先在终端运行 `gh --version` 确认是否已经安装:已装就把 gh 所在目录加进 PATH(或把环境变量 ZCODE_GH_PATH 设为 gh 可执行文件的绝对路径),然后重启 ZCode;没装就去 https://cli.github.com/ 安装。装好后再点「重新检查」。"
          ),
        ]
      )
    );
    blocked = true;
  } else {
    steps.push(stepOf("gh:installed", "done", { fallback: TITLES["gh:installed"], desc: `已解析到 gh 命令行(${gh.path})` }, []));
  }

  // 4) 登录态:preflight 的 auth 档(auth status 失败且 gh api user 核对也没过)。
  if (blocked) pending("gh:authed");
  else if (pre && pre.ok !== true && pre.kind === "auth") {
    steps.push(
      stepOf(
        "gh:authed",
        "current",
        { fallback: TITLES["gh:authed"], desc: "gh 已安装,但还没有登录 GitHub" },
        [
          injectAction(
            "登录 GitHub",
            "本机的 gh 还没登录 GitHub。请在终端运行 `gh auth login`,按提示选择 GitHub.com 并完成浏览器授权;结束后运行 `gh auth status` 确认账号已登录,再回到检查页点「重新检查」。"
          ),
        ]
      )
    );
    blocked = true;
  } else {
    steps.push(stepOf("gh:authed", "done", { fallback: TITLES["gh:authed"], desc: "gh 登录态可用" }, []));
  }

  // 5) 仓库可达 + 权限:成功时描述写可写/只读/未知。其余档位(not-found/network/rate-limit 等)停在这里。
  if (blocked) pending("gh:repoAccess");
  else if (pre && pre.ok === true && repo) {
    steps.push(
      stepOf("gh:repoAccess", "done", { fallback: TITLES["gh:repoAccess"], desc: accessDescOf(repo.refId, perm) }, [])
    );
  } else {
    const kind = pre && pre.ok !== true ? pre.kind : "parse";
    const refId = repo && repo.refId ? repo.refId : "这个仓库";
    steps.push(
      failStep(
        "gh:repoAccess",
        `访问不到仓库 ${refId}:${accessReasonOf(kind)}`,
        "确认远端地址与账号权限,修好后点「重新检查」"
      )
    );
    blocked = true;
  }

  // 6) 工具桥:能返回这份快照就是证据。
  if (blocked) pending("env:bridge");
  else steps.push(stepOf("env:bridge", "done", { fallback: TITLES["env:bridge"], desc: "ZCode 工具桥在线(本检查由插件 MCP 服务返回)" }, []));

  // 7) 技能根:至少一处可读(锚 home-repo,不随项目)。
  if (blocked) pending("env:skills");
  else {
    const anchor = f.skillRoot === undefined ? root : f.skillRoot;
    const roots = skillRootsFor(anchor, f.env || process.env);
    const readable = roots.filter((r) => dirReadable(r.dir));
    steps.push(
      stepOf(
        "env:skills",
        readable.length ? "done" : "current",
        readable.length
          ? { fallback: TITLES["env:skills"], desc: `可读技能根 ${readable.length} 处:${readable.map((r) => r.title).join("、")}` }
          : { fallback: TITLES["env:skills"], desc: `${roots.map((r) => r.title).join("、")} 都读不到` },
        readable.length
          ? []
          : [injectAction("安装技能", `本机没找到可读的技能根(${roots.map((r) => r.title).join("、")})。请用 /setup-matt-pocock-skills 或 ZCode 技能市场安装 MattSkills 技能。`)]
      )
    );
  }

  return snapshotOf(steps);
}

/**
 * 采集出站事实:仓库(本地)→ gh → 一次 preflight → 权限(成功时)。
 * 前面两步没就位就不出站(链会停在对应那一步)。权限结论同时写进票 04 的权限缓存。
 */
export async function gatherGithubFacts(root, opts = {}) {
  const repoRoot = String(root || "");
  const homeRoot = opts && opts.homeRoot !== undefined && opts.homeRoot !== null ? String(opts.homeRoot) : repoRoot;
  const facts = {
    gitRepo: existsSync(join(repoRoot, ".git")),
    repo: resolveRepoLocal(repoRoot),
    gh: resolveGhPath(process.env),
    preflight: null,
    perm: null,
    skillRoot: homeRoot,
    env: process.env,
  };
  if (!facts.repo || !facts.gh) return facts;

  const room = await roomFor(repoRoot);
  if (room.error) {
    facts.preflight = { ok: false, kind: room.error.kind || "not-found", message: String(room.error.message || "") };
    return facts;
  }

  let pre = null;
  try {
    pre = await room.backend.preflight({ cwd: repoRoot, refId: room.repoRef.refId }, room.ctx);
  } catch (e) {
    facts.preflight = { ok: false, kind: "network", message: String((e && e.message) || e) };
    return facts;
  }
  if (!pre || pre.ok !== true) {
    const err = (pre && pre.error) || {};
    facts.preflight = {
      ok: false,
      kind: typeof err.kind === "string" && err.kind ? err.kind : "parse",
      message: String(err.message || ""),
    };
    return facts;
  }
  facts.preflight = { ok: true };

  // 三关过了才问权限;问不出来如实记未知(不冒充可写,也不留上一次的旧结论)。
  let permRes = null;
  try {
    permRes = await room.backend.getRepoPermissions(room.repoRef, room.ctx);
  } catch {}
  const data = permRes && permRes.ok === true ? permRes.data : null;
  if (data && typeof data.push === "boolean" && typeof data.triage === "boolean") {
    const push = data.push === true;
    const triage = data.triage === true;
    facts.perm = { known: true, push, triage };
    setPerm(repoRoot, { known: true, push, triage, atMs: Date.now() });
  } else {
    facts.perm = { known: false, push: null, triage: null };
    setPerm(repoRoot, { known: false, push: null, triage: null, atMs: Date.now() });
  }
  return facts;
}

function replyOf(snapshot, checkedAt, cached, force) {
  const summary = summarizeEnvCheck(snapshot);
  return {
    content: [{ type: "text", text: force ? `已按当前状态重扫。${summary}` : summary }],
    structuredContent: { ok: true, snapshot, checkedAt, cached },
  };
}

/**
 * deck_env_check 的 GitHub 分支:
 *   非 force 且缓存未过期(TTL = probeBaseMs)→ 回缓存快照,零出站;
 *   force → 清检查缓存与权限缓存,probeGithub({force:true}) 真重探一次(顺手刷新看板),
 *           再重建链并写缓存。
 */
export async function githubEnvCheck(root, opts = {}) {
  const force = opts && opts.force === true;
  const homeRoot = opts && opts.homeRoot !== undefined && opts.homeRoot !== null ? String(opts.homeRoot) : String(root || "");
  if (!force) {
    const hit = envCheckCacheOf(root);
    if (hit && Date.now() - hit.atMs < probeBaseMs()) return replyOf(hit.snapshot, hit.checkedAt, true, false);
  } else {
    clearEnvCheckCache(root);
    clearPerm(root);
    await probeGithub(root, { force: true });
  }
  const facts = await gatherGithubFacts(root, { homeRoot });
  const snapshot = buildGithubChain(root, facts);
  const checkedAt = new Date().toISOString();
  setEnvCheckCache(root, { atMs: Date.now(), snapshot, checkedAt });
  return replyOf(snapshot, checkedAt, false, force);
}

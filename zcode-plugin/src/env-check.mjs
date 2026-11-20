// src/env-check.mjs —— 环境检查链的组装真源(工单 03;deck_env_check 的工具实现面)。
//
// 上游 #284 起检查页 = 链快照唯一渲染(九格 wf.status 目录视图已退役,不恢复)。上游的链快照
// 由宿主侧 check-chain-evaluation 按谓词求值拼成,形状真源是 src/refresh/rooms/host/chain-step-rows.ts
// 的 stepEvalParallel:steps 元素 {id,status,show,actions,blockedBy},快照另带
// currentIndex/doneCount/totalCount/chainState/version。本仓没有那套谓词房间 —— 按工单要求
// 「按本地真实事实组链,不造假」:事实源全部是服务端摸得到的真实状态,判据逐条写在下面。
//
// 事实源(每个 step 一条):
//   1. tracker:initialized  工作区有没有 .scratch/(scanWorkspace().exists)
//   2. md:workspace         卡片可读性(scanWorkspace().unreadable 的坏卡计数;list 永远跳过坏卡)
//   3. env:watch            .scratch/ 的 fs.watch 是否在线(deckWatch.state().online)
//   4. env:bridge           本工具自身即桥 —— 能返回这份快照就证明工具桥在线(恒 done)
//   5. env:skills           工作区 .zcode/skills、~/.zcode/skills、~/.agents/skills 至少一个可读
//   6. git:repo             工作区根有没有 .git(目录或 worktree 的 .git 文件都算)
//
// 状态口径照 stepEvalParallel:通过 → done;未通过且带修复动作 → current(行上有下一步可点);
// 未通过无动作 → fail;诚实未知 → pending(本文件当前不产生 pending:六条判据都摸得到)。
// pending 行只保留标题三格、fail/current 才带修复动作 —— 与上游 chain-step-rows 的约定一致。
//
// 只读纪律:本文件只 readdir/exists(可读性探测),不写盘、不建目录、不跑命令。
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/** 修复动作的统一形状(上游动作词汇表 v1 的 inject-prompt;经 ChecksTab 的分发器落到 ui/message 桥)。 */
function injectAction(label, prompt) {
  return { type: "inject-prompt", label, prompt };
}

/** 目录可读 = 存在且 readdir 不抛(不写探测:环境检查只读)。 */
function dirReadable(path) {
  try {
    if (!existsSync(path)) return false;
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 技能根三处(顺序即判据顺序,与工单一致):工作区级 + 两处用户级。 */
export function skillRootsOf(root, home = homedir()) {
  return [
    { label: "工作区 .zcode/skills", path: join(String(root || ""), ".zcode", "skills") },
    { label: "~/.zcode/skills", path: join(String(home || ""), ".zcode", "skills") },
    { label: "~/.agents/skills", path: join(String(home || ""), ".agents", "skills") },
  ];
}

/** 链快照计数(stepEvalParallel 同口径;拼接视图不判 failedIndex 的差别在这里不存在 —— 单段链)。 */
export function snapshotOf(steps) {
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

/** 一颗 step(六格定形;pending 行不带动作,同上游)。 */
function stepOf(id, status, show, actions) {
  return { id, status, show, actions: Array.isArray(actions) ? actions : [], blockedBy: null };
}

/**
 * 按本地真实事实组链。
 * facts: { scan: scanWorkspace(root) 的返回, watchOnline: deckWatch.state().online }
 */
export function buildEnvChain(root, facts) {
  const scan = (facts && facts.scan) || { exists: false, rows: [], units: [], unreadable: [] };
  const watchOnline = !!(facts && facts.watchOnline);
  const scratchOn = !!scan.exists;
  const rows = Array.isArray(scan.rows) ? scan.rows : [];
  const units = Array.isArray(scan.units) ? scan.units : [];
  const unreadable = Array.isArray(scan.unreadable) ? scan.unreadable : [];
  const steps = [];

  // 1) 工作区已初始化:.scratch/ 存在即看板数据面就位。
  steps.push(
    stepOf(
      "tracker:initialized",
      scratchOn ? "done" : "current",
      scratchOn
        ? { fallback: "工作区已初始化", desc: `已找到 .scratch/ 工单目录(${units.length} 个工作单元)` }
        : { fallback: "工作区已初始化", desc: "缺 .scratch/ 工单目录,看板还没有数据可读", hint: "先初始化看板,后面的卡片检查才有东西可读" },
      scratchOn
        ? []
        : [injectAction("初始化看板", "这个工作区还没有 .scratch/ 工单目录。请运行 /setup-matt-pocock-skills 初始化看板,再用 /to-tickets 拆解规格建卡。")]
    )
  );

  // 2) 卡片可读:坏卡/读不动的卡片计数(list 工具永远静默跳过它们,这里如实摆出来)。
  const badList = unreadable.slice(0, 3).map((p) => relative(String(root || ""), p) || String(p));
  const badMore = unreadable.length > badList.length ? ` 等 ${unreadable.length} 张` : "";
  steps.push(
    stepOf(
      "md:workspace",
      unreadable.length === 0 ? "done" : "current",
      unreadable.length === 0
        ? {
            fallback: "卡片可读",
            desc: scratchOn ? `共 ${rows.length} 张卡全部可读` : "工作区还没有 .scratch/,没有卡片可检查",
          }
        : {
            fallback: "卡片可读",
            desc: `有 ${unreadable.length} 张卡片文件读不动(${badList.join("、")}${badMore})`,
            hint: "读不动的卡片会被列表与计数跳过,修好文件权限/编码后重新检查",
          },
      unreadable.length === 0
        ? []
        : [injectAction("修复读不动的卡片", `这些卡片文件读不动:${badList.join("、")}${badMore}。请帮我检查文件权限与编码并修复,修好后重新检查。`)]
    )
  );

  // 3) 监听在线:fs.watch 挂在 .scratch/ 上(没有目录时离线是后果,不是错误数据)。
  steps.push(
    stepOf(
      "env:watch",
      watchOnline ? "done" : "fail",
      watchOnline
        ? { fallback: "监听在线", desc: "fs.watch 已挂上 .scratch/,卡片文件变化会即时推进数据修订号" }
        : {
            fallback: "监听在线",
            desc: scratchOn ? "监听离线:.scratch/ 的 fs.watch 没挂上(按退避重试)" : "监听离线:没有 .scratch/ 目录可监听",
          }
    )
  );

  // 4) 工具桥通:能拿到这份快照本身就是证据(本工具由插件 MCP 服务返回)。
  steps.push(
    stepOf("env:bridge", "done", {
      fallback: "工具桥在线",
      desc: "ZCode 工具桥在线(本检查由插件 MCP 服务返回)",
    })
  );

  // 5) 技能根可读:三处至少一个可读;逐根探测,desc 如实列出可读的那几处。
  const roots = skillRootsOf(root);
  const readable = roots.filter((r) => dirReadable(r.path));
  steps.push(
    stepOf(
      "env:skills",
      readable.length ? "done" : "current",
      readable.length
        ? { fallback: "技能根可读", desc: `可读技能根 ${readable.length} 处:${readable.map((r) => r.label).join("、")}` }
        : { fallback: "技能根可读", desc: `${roots.map((r) => r.label).join("、")} 都读不到` },
      readable.length
        ? []
        : [injectAction("安装技能", "本机没找到可读的技能根(工作区 .zcode/skills、~/.zcode/skills、~/.agents/skills)。请用 /setup-matt-pocock-skills 或 ZCode 技能市场安装 MattSkills 技能。")]
    )
  );

  // 6) 是否 git 仓:工作区根有无 .git(worktree 的 .git 是文件,exists 同样算)。
  const gitOn = existsSync(join(String(root || ""), ".git"));
  steps.push(
    stepOf(
      "git:repo",
      gitOn ? "done" : "current",
      gitOn
        ? { fallback: "工作区是 git 仓库", desc: "工作区根有 .git" }
        : { fallback: "工作区是 git 仓库", desc: "工作区根没有 .git,不是 git 仓库", hint: "看板不依赖 git;需要版本追踪时再初始化" },
      gitOn ? [] : [injectAction("初始化 git", "这个工作区还不是 git 仓库。请在工作区根运行 git init(并按需补 .gitignore),完成后重新检查。")]
    )
  );

  return snapshotOf(steps);
}

/** 人话摘要:一行说清通过几项、还差哪几项(工具 content 用)。 */
export function summarizeEnvCheck(snapshot) {
  const steps = (snapshot && snapshot.steps) || [];
  const total = steps.length;
  const done = steps.filter((s) => s.status === "done").length;
  const titleOf = (s) => (s.show && s.show.fallback) || s.id;
  if (snapshot && snapshot.chainState === "allDone") return `环境检查 ${done}/${total} 全绿。`;
  const ok = steps.filter((s) => s.status === "done").map(titleOf);
  const todo = steps
    .filter((s) => s.status !== "done")
    .map((s) => `${titleOf(s)}${s.status === "pending" ? "(待确认)" : "(未通过)"}`);
  const okPart = ok.length ? `通过 ${ok.join("、")}` : "暂无通过项";
  return `环境检查 ${done}/${total}:${okPart};待处理 ${todo.join("、")}。`;
}

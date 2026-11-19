// 工单 07 直测(纯函数缝):prompt 生成与详情动作门控。
// 缝 = src/ui/actions.mjs(IIFE 挂 globalThis.MattSkillsActions)+ src/ui/cards.mjs 的
// rowActionKind(T04 已落,十档判定与档位→模板的链路一起测)。
// 期望值独立于实现,全部来自 port-notes/action-prompts.md(模板与公共小节 zh 全文、
// 十级判定表)与 detail-page.md §4(detailTopGate 口径:未知状态不置灰)。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/

await import(pathToFileURL(join(ROOT, "src", "ui", "cards.mjs"))); // 挂 globalThis.MattSkillsCards
await import(pathToFileURL(join(ROOT, "src", "ui", "actions.mjs"))); // 挂 globalThis.MattSkillsActions
const Cards = globalThis.MattSkillsCards;
const Actions = globalThis.MattSkillsActions;

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const rowOf = (labels, extra = {}) =>
  Object.assign({ key: "01", effortId: "demo", type: "issue", title: "票", state: "open", labels }, extra);

// ---------------------------------------------------------------------------
// 切片 A:十档判定(rowActionKind 判定表,action-prompts.md §1)
// ---------------------------------------------------------------------------
function sliceLadder() {
  const L = (name) => [{ name }];
  const cases = [
    ["无标签 → 诊断", rowOf([]), "diagnose"],
    ["needs-triage → 诊断", rowOf(L("needs-triage")), "diagnose"],
    ["ready-for-human → 接手", rowOf(L("ready-for-human")), "claim"],
    ["needs-info → 补充", rowOf(L("needs-info")), "supplement"],
    ["bug → 修复", rowOf(L("bug")), "fix"],
    ["wayfinder:grilling → 讨论", rowOf(L("wayfinder:grilling")), "grill"],
    ["wayfinder:research → 研究", rowOf(L("wayfinder:research")), "research"],
    ["wayfinder:prototype → 原型", rowOf(L("wayfinder:prototype")), "proto"],
    ["wayfinder:task → 执行", rowOf(L("wayfinder:task")), "execute"],
    ["ready-for-agent → 实施", rowOf(L("ready-for-agent")), "implement"],
    ["未知标签 → 兜底执行", rowOf(L("自定义杂项")), "execute"],
    ["接手与修复同现取接手", rowOf(L("ready-for-human").concat(L("bug"))), "claim"],
    ["needs-triage 与 needs-info 同现仍先诊断", rowOf(L("needs-triage").concat(L("needs-info"))), "diagnose"],
  ];
  for (const [name, row, want] of cases) {
    const got = Cards.rowActionKind(row);
    check(`ladder: ${name}`, got === want, `${got} ≠ ${want}`);
  }
}

// ---------------------------------------------------------------------------
// 切片 B:档位 → prompt(首行/关键句/占位替换/shared 展开;期望串为笔记原文)
// ---------------------------------------------------------------------------
function slicePrompts() {
  const URL = "#demo/01 诊断档票（E:\\x\\.scratch\\demo\\issues\\01-diagnose.md）";
  // execute(grill/research 同文)全文等于 mapTicketAdvance 的完整展开,逐字对照笔记
  const MAP_ADVANCE = [
    "/wayfinder",
    URL,
    "",
    "从第一性原理出发。",
    "",
    "请按 wayfinder 技能推进这张票。",
    "",
    "## 调查（建议先查后问）",
    "- [ ] 建议先阅读本票正文、评论及仓内相关内容后再提问。",
    "- [ ] 建议优先复用仓内既有相关笔记（查找与存放均循仓内习惯），复用时仅记录路径与一句话结论，不粘贴全文。",
    "- [ ] 确认已找到的既有笔记无法回答本次问题后，再按 /research 规则新查一次，并用一句话说明不适用的原因，新笔记路径回填至正文。",
    "- [ ] 提问前用一句话说明已查阅范围。",
    "",
    "## 收尾",
    "- [ ] 结束前把这张票的真实状态写进正文；没做完的写明下一步。",
    "",
    "## 工具",
    "- [ ] issue 相关操作优先使用 deck_ 开头的工具处理，如果deck_工具异常，根据当前工作区选择合适方式处理。",
    "- [ ] 及时使用 deck_issue_report 工具上报处理过、处理中的 issue 编号。",
    "- [ ] 每轮回复收尾时先判断一次：用户接下来几乎一定会做什么？想得到就调用 suggest_next_steps 给出 2~4 条最可能被他选中的做法；这一轮在等用户拍板时，其中一条把每题的推荐答案列好；想不到就不调用。",
  ].join("\n");

  const cases = [
    // [档位, 首行, 关键句(笔记原文)]
    ["diagnose", "/triage", "按 /triage 技能诊断这张 issue；诊断不等于修复，只弄清问题与分流：不改业务代码、不开始实施。"],
    ["claim", "/triage", "这张票停在 ready-for-human：有一块必须由人亲自做的部分。"],
    ["supplement", "/triage", "这张票停在 needs-info：缺关键信息，还不能开工。"],
    ["fix", "/implement", "按 /implement 技能修复这个 bug。"],
    ["grill", "/wayfinder", "请按 wayfinder 技能推进这张票。"],
    ["research", "/wayfinder", "请按 wayfinder 技能推进这张票。"],
    ["proto", "/wayfinder", "## 定版与移交"],
    ["execute", "/wayfinder", "请按 wayfinder 技能推进这张票。"],
    ["implement", "/implement", "按 /implement 技能实施这张票。"],
  ];
  // 各档实际引用的公共小节(按笔记原文;supplement 无 firstPrinciples,fix/implement 无 investigation)
  const USES_FP = { diagnose: 1, claim: 1, fix: 1, grill: 1, research: 1, proto: 1, execute: 1, implement: 1 };
  const USES_INV = { diagnose: 1, claim: 1, supplement: 1, grill: 1, research: 1, proto: 1, execute: 1 };
  for (const [kind, firstLine, keyLine] of cases) {
    const p = Actions.buildActionPrompt(kind, { url: URL });
    check(`prompt: ${kind} 首行 ${firstLine}`, p.startsWith(firstLine + "\n" + URL + "\n"), JSON.stringify(p.slice(0, 80)));
    check(`prompt: ${kind} 含关键句`, p.includes(keyLine), p.slice(0, 120));
    check(`prompt: ${kind} shared 全展开`, !p.includes("{{shared:"), p.slice(0, 80));
    check(`prompt: ${kind} 占位符已替换`, !p.includes("{url}"), p.slice(0, 80));
    check(`prompt: ${kind} firstPrinciples ${USES_FP[kind] ? "在" : "不在"}`,
      p.includes("从第一性原理出发。") === !!USES_FP[kind]);
    check(`prompt: ${kind} investigation ${USES_INV[kind] ? "在" : "不在"}`,
      p.includes("## 调查（建议先查后问）") === !!USES_INV[kind]);
    check(`prompt: ${kind} 含 sharedTools 收尾`, p.includes("## 工具") && p.includes("deck_issue_report"));
  }

  // execute 全文逐字对照(mapTicketAdvance = Opening + WrapUp 拼接)
  check("prompt: execute 全文等于 mapTicketAdvance 展开",
    Actions.buildActionPrompt("execute", { url: URL }) === MAP_ADVANCE,
    JSON.stringify(Actions.buildActionPrompt("execute", { url: URL }).slice(0, 160)));
  // 三档同文:discuss/execute/research 均展开为 mapTicketAdvance
  check("prompt: grill/research/execute 三档同文",
    Actions.buildActionPrompt("grill", { url: URL }) === MAP_ADVANCE &&
      Actions.buildActionPrompt("research", { url: URL }) === MAP_ADVANCE);
  // diagnose 收尾段带 ❓ 提问格式(笔记原文细节)
  check("prompt: diagnose 收尾提问格式",
    Actions.buildActionPrompt("diagnose", { url: URL }).includes("写成❓ Q1、Q2、Q3，逐个给推荐答案（➡️），等回复再动。"));

  // 档位文案表(card.act.* 九档全量)
  const LABELS = {
    diagnose: "诊断", fix: "修复", execute: "执行", claim: "接手", supplement: "补充",
    research: "研究", grill: "讨论", proto: "原型", implement: "实施",
  };
  for (const k in LABELS) check(`labels: ${k} → ${LABELS[k]}`, Actions.ACTION_LABELS[k] === LABELS[k], Actions.ACTION_LABELS[k]);

  // 未知档位:接线 bug,宁可报错不可静默
  let threw = false;
  try { Actions.buildActionPrompt("nope", { url: "U" }); } catch { threw = true; }
  check("prompt: 未知档位报错", threw);
}

// ---------------------------------------------------------------------------
// 切片 C:展开与占位的机制行为(成环/未知小节/多占位/未知占位保留)
// ---------------------------------------------------------------------------
function sliceMechanics() {
  let threw = false;
  try { Actions.expandTemplate("{{shared:a}}", { a: "{{shared:b}}", b: "{{shared:a}}" }); } catch { threw = true; }
  check("expand: 公共小节成环报错", threw);

  threw = false;
  try { Actions.expandTemplate("{{shared:nope}}"); } catch { threw = true; }
  check("expand: 未知公共小节报错", threw);

  check("fill: 多占位逐一替换({url}/{ts}/{path})",
    Actions.fillPlaceholders("{url} · {ts} · {path}", { url: "U", ts: "20261119-120000-000", path: "P" }) === "U · 20261119-120000-000 · P",
    Actions.fillPlaceholders("{url} · {ts} · {path}", { url: "U", ts: "20261119-120000-000", path: "P" }));
  check("fill: 无值的占位符保留原样", Actions.fillPlaceholders("a {path} b", {}) === "a {path} b");
}

// ---------------------------------------------------------------------------
// 切片 D:详情动作门控(detailTopGate 口径,未知状态不置灰)
// ---------------------------------------------------------------------------
function sliceGate() {
  const g = (row) => Actions.detailTopGateOf(row);
  check("gate: 关闭票 → closed 不可点",
    JSON.stringify(g(rowOf([], { state: "closed" }))) === JSON.stringify({ clickable: false, reason: "closed", blockedNumbers: [] }),
    JSON.stringify(g(rowOf([], { state: "closed" }))));
  check("gate: 被 open 票阻塞 → blocked [2]",
    JSON.stringify(g(rowOf([], { blockedBy: [{ key: "02", state: "open" }] }))) === JSON.stringify({ clickable: false, reason: "blocked", blockedNumbers: [2] }),
    JSON.stringify(g(rowOf([], { blockedBy: [{ key: "02", state: "open" }] }))));
  check("gate: 阻塞票已关闭 → 可点",
    g(rowOf([], { blockedBy: [{ key: "02", state: "closed" }] })).clickable === true);
  check("gate: 阻塞票状态缺失 → 未知不置灰",
    g(rowOf([], { blockedBy: [{ key: "02" }] })).clickable === true);
  check("gate: 阻塞票状态认不出(OPEN 大写归一后算 open)",
    g(rowOf([], { blockedBy: [{ key: "02", state: " OPEN " }] })).reason === "blocked");
  check("gate: 阻塞票号不可用(无数字) → 不置灰",
    g(rowOf([], { blockedBy: [{ key: "x", state: "open" }] })).clickable === true);
  const dup = g(rowOf([], { blockedBy: [
    { key: "10", state: "open" }, { key: "02", state: "open" }, { key: "2", state: "open" },
  ] }));
  check("gate: 票号去重升序",
    JSON.stringify(dup) === JSON.stringify({ clickable: false, reason: "blocked", blockedNumbers: [2, 10] }),
    JSON.stringify(dup));
  check("gate: 断链阻塞(无目标)不置灰——状态未知",
    g(rowOf([], { blockedBy: [null] })).clickable === true);
  check("gate: 正常开放票 → none",
    JSON.stringify(g(rowOf([]))) === JSON.stringify({ clickable: true, reason: "none", blockedNumbers: [] }));
}

// ---------------------------------------------------------------------------
// 切片 E:图标表(CARD_ACTION_STYLE 五种图标名都有 SVG 部件,给渲染用)
// ---------------------------------------------------------------------------
function sliceIcons() {
  for (const icon of ["chat", "play", "search", "hammer", "proto"]) {
    const parts = Actions.ACTION_ICONS[icon];
    check(`icons: ${icon} 有 SVG 部件`, Array.isArray(parts) && parts.length > 0 && parts.every((p) => p.tag && p.attrs));
  }
}

sliceLadder();
slicePrompts();
sliceMechanics();
sliceGate();
sliceIcons();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

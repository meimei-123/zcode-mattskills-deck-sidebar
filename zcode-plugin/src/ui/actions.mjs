// MattSkills 动作域(工单 07):详情页动作栏的 prompt 生成与门控,纯函数。
// 真源:port-notes/action-prompts.md(九模板 zh 全文、{{shared:*}} 五节原文、
// 十级判定表)与 detail-page.md §4(detailTopGate:未知状态不置灰)。
// 裁剪口径(与工单验收一致,取舍见工单报告):
//   - 保留十级阶梯产出的九档动作模板(diagnose/fix/implement/takeover/supplement/
//     discuss/execute/research/prototype;discuss/execute/research 三档同文 mapTicketAdvance);
//   - 裁掉 handoff1/handoff2:它们不是行档位动作,{path}(上一会话交接文档路径)面板无法提供;
//   - 裁掉容器注入键(specSplit/specExecute/specComplete/mapInspect):容器三态动作条不在本票。
// 双态加载:build 时原样拼进 bundle-0.txt(纯脚本,IIFE 挂 globalThis);Node 测试直接 import
// 执行同一 IIFE。无 DOM 依赖——渲染在 detail.mjs。
"use strict";
(function (global) {
  // ---- 档位文案(card.act.* 九档;工单 09 起值单处集中在 copy.mjs,bundle 段序在其后) ----
  var ACTION_LABELS = {};
  (function () {
    var copy = globalThis.MattSkillsCopy || {};
    var kinds = ["diagnose", "fix", "execute", "claim", "supplement", "research", "grill", "proto", "implement"];
    for (var i = 0; i < kinds.length; i++) ACTION_LABELS[kinds[i]] = copy["card.act." + kinds[i]] || kinds[i];
  })();

  // ---- 公共小节(shared-sections.yaml zh 全文;mapTicketAdvance = Opening + WrapUp 拼接) ----
  var SHARED_SECTIONS = {
    firstPrinciples: "从第一性原理出发。",
    sharedTools: [
      "## 工具",
      "- [ ] issue 相关操作优先使用 deck_ 开头的工具处理，如果deck_工具异常，根据当前工作区选择合适方式处理。",
      "- [ ] 及时使用 deck_issue_report 工具上报处理过、处理中的 issue 编号。",
      "- [ ] 每轮回复收尾时先判断一次：用户接下来几乎一定会做什么？想得到就调用 suggest_next_steps 给出 2~4 条最可能被他选中的做法；这一轮在等用户拍板时，其中一条把每题的推荐答案列好；想不到就不调用。",
    ].join("\n"),
    investigation: [
      "## 调查（建议先查后问）",
      "- [ ] 建议先阅读本票正文、评论及仓内相关内容后再提问。",
      "- [ ] 建议优先复用仓内既有相关笔记（查找与存放均循仓内习惯），复用时仅记录路径与一句话结论，不粘贴全文。",
      "- [ ] 确认已找到的既有笔记无法回答本次问题后，再按 /research 规则新查一次，并用一句话说明不适用的原因，新笔记路径回填至正文。",
      "- [ ] 提问前用一句话说明已查阅范围。",
    ].join("\n"),
    mapTicketAdvanceOpening: [
      "/wayfinder",
      "{url}",
      "",
      "{{shared:firstPrinciples}}",
      "",
      "请按 wayfinder 技能推进这张票。",
      "",
      "{{shared:investigation}}",
    ].join("\n"),
    mapTicketAdvanceWrapUp: [
      "## 收尾",
      "- [ ] 结束前把这张票的真实状态写进正文；没做完的写明下一步。",
      "",
      "{{shared:sharedTools}}",
    ].join("\n"),
  };
  SHARED_SECTIONS.mapTicketAdvance =
    SHARED_SECTIONS.mapTicketAdvanceOpening + "\n\n" + SHARED_SECTIONS.mapTicketAdvanceWrapUp;

  // ---- 动作模板(ticket-action-templates.yaml zh 全文;档位键按十级阶梯命名) ----
  var ACTION_TEMPLATES = {
    diagnose: [
      "/triage",
      "{url}",
      "",
      "{{shared:firstPrinciples}}",
      "",
      "按 /triage 技能诊断这张 issue；诊断不等于修复，只弄清问题与分流：不改业务代码、不开始实施。",
      "",
      "## 先核对是否已有实施",
      "- [ ] 先看正文、评论与已有记录里有没有实施痕迹：验收标准全部满足的，按 /triage 处理“已实现”票的规则收口，不要重复实施；只做了一半的，写明还缺什么再继续诊断；没有实施记录的，按正常诊断走。",
      "",
      "{{shared:investigation}}",
      "",
      "## 收尾",
      "- [ ] 结束前把这张票的真实状态写进正文；结尾用提问格式收尾：有待维护者拍板的事，有几个就问几个，写成❓ Q1、Q2、Q3，逐个给推荐答案（➡️），等回复再动。",
      "- [ ] 说明回复后你准备执行什么标签动作；没有待拍板的问题时，写明这张票已转到哪个终态。",
      "",
      "{{shared:sharedTools}}",
    ].join("\n"),
    fix: [
      "/implement",
      "{url}",
      "",
      "{{shared:firstPrinciples}}",
      "",
      "按 /implement 技能修复这个 bug。",
      "",
      "## 读现状",
      "- [ ] 已认领？若未认领，先认领。",
      "- [ ] 把这张票读全（正文 / 评论 / 标签 / 认领 / 父子与阻塞边），确认现象与验收标准。",
      "- [ ] 若还挂着 needs-triage，说明还没分流，先走完诊断再回来修。",
      "- [ ] 若复现不稳定、根因不明，先按 /diagnosing-bugs 技能定位根因，再回来修。",
      "",
      "## 收尾",
      "- [ ] 结束前把这张票的真实状态写进正文；做完了就关闭，没做完写明缺什么。",
      "",
      "{{shared:sharedTools}}",
    ].join("\n"),
    implement: [
      "/implement",
      "{url}",
      "",
      "按 /implement 技能实施这张票。",
      "",
      "{{shared:firstPrinciples}}",
      "",
      "## 读现状",
      "- [ ] 已认领？若未认领，先认领。",
      "- [ ] 把这张票读全（正文 / 评论 / 验收判据 / 父子与阻塞边），确认要交付什么；有歧义先问用户。",
      "- [ ] 有未关闭的前置票就先做前置，或写明为什么可以并行。",
      "",
      "## 收尾",
      "- [ ] 结束前把这张票的真实状态写进正文；做完了就关闭，没做完写明缺什么。",
      "- [ ] 如果这张票属于某张规格 issue，且它是最后一张实施 issue，提醒用户回到规格详情点「完成」做收口核对。",
      "",
      "{{shared:sharedTools}}",
    ].join("\n"),
    takeover: [
      "/triage",
      "{url}",
      "",
      "{{shared:firstPrinciples}}",
      "",
      "这张票停在 ready-for-human：有一块必须由人亲自做的部分。先复核这个判定，再决定继续交给用户、改判，还是按已完成收口；用户必须亲自做的部分留给用户，其余由你完成，不要替他做。",
      "",
      "## 读现状",
      "- [ ] 读全这张票（正文、评论、标签、认领、父子与阻塞边），确认它仍然开放、标签仍是 ready-for-human。",
      "- [ ] 先核对人那部分是否已经做完：票里已有验收记录且满足验收标准的，按 /triage 处理“已实现”票的规则核对后关票；只做了一半的，写明还缺什么；没有记录的，继续往下。",
      "",
      "{{shared:investigation}}",
      "",
      "## 判断人工档位",
      "- [ ] 复核这个判定属于哪一类：判断类决策 / 外部访问权限（账号、设备或第三方系统）/ 设计决策 / 需人工测试。",
      "- [ ] 判定成立 → 把这一类写进正文，说明 AI 不代劳的原因；判定不成立 → 按 /triage 的技能规则在正文写明改判依据、建议转回（通常回 needs-triage 重新分流），等维护者确认后再改标签。",
      "",
      "## 交给用户的清单",
      "- [ ] 只列用户必须亲自执行的部分：步骤、每步怎么验证、哪些不在范围内、做完后在票里回什么。",
      "- [ ] 把清单写进票里（正文或评论），不要只留在会话：下一个会话要能只凭票面开工。",
      "- [ ] 写清你之后怎么验收：用户回的结果对照哪条验收标准，不满足时差在哪。",
      "- [ ] 需要用户亲自执行的步骤较多或涉及外部系统时，用 /wizard 生成一份手把手清单。",
      "",
      "## 收尾",
      "- [ ] 用户还没做：保持 ready-for-human，把真实状态、清单位置、等待项写进正文。",
      "- [ ] 用户已确认做完：对照验收标准核对，回写事实（凭据位置 / URL / 数据形状，不要只写「已完成」）；满足就按 /triage 规则关票，不满足就写明差在哪、继续等或改判。",
      "",
      "{{shared:sharedTools}}",
    ].join("\n"),
    supplement: [
      "/triage",
      "{url}",
      "",
      "这张票停在 needs-info：缺关键信息，还不能开工。能自己补的先补齐，只能问人的按可直接回答的形式问出来；本会话不实施、不改代码、不关票。",
      "",
      "## 读现状",
      "- [ ] 读全该 issue（正文、评论、标签、认领、阻塞关系），核对报告人是否已经答复过：答了并覆盖缺口的，按 /triage 的 needs-info 回流规则核对后转回 needs-triage，不重复提问；没答全的，只追缺口。",
      "- [ ] 把缺口逐条列出来：缺什么、卡住哪一步、谁手上可能有（报告人 / 仓内既有记录 / 外部系统）。",
      "",
      "{{shared:investigation}}",
      "",
      "## 已确认事项",
      "- [ ] 将已确认的事项逐条写进正文，避免重复检索评论。",
      "- [ ] 往票里写内容时带上 triage 声明：> *This was generated by AI during triage.*",
      "",
      "## 问清楚（逐条可直接回答）",
      "- [ ] 每次仅提出最阻塞的一两个问题，明确缺失项（日志片段 / 复现步骤 / 期望结果）以及拿到后能推进哪一步。",
      "- [ ] 每个问题给出可直接回答的形式：指定粘贴片段、截图范围、二选一、填空；不提开放式问题。",
      "- [ ] 答案在当前维护者手上就当场问；在报告人或外部人手上，把问题写成一条票内评论（带上面的声明），并写明等谁回。",
      "- [ ] 每个问题需要从第一性原理出发，通过对抗式审查：这个问题真的必须问吗？答案能不能从票里、仓里或外部系统自己查出来。",
      "",
      "## 收尾",
      "- [ ] 本会话内拿到答复：核对答复覆盖了哪些缺口；答全了就转回 needs-triage 继续分流，没答全就只追问缺口、仍缺的保持 needs-info。",
      "- [ ] 答复还没到：保持 needs-info，把「缺失项、已提问题、等待对象」写进正文。",
      "- [ ] 等待期间：不实施、不修改代码、不关闭该 issue。",
      "",
      "{{shared:sharedTools}}",
    ].join("\n"),
    discuss: "{{shared:mapTicketAdvance}}",
    execute: "{{shared:mapTicketAdvance}}",
    research: "{{shared:mapTicketAdvance}}",
    prototype: [
      "{{shared:mapTicketAdvanceOpening}}",
      "",
      "## 定版与移交",
      "- [ ] 把定版写进本票正文，让后人能打开同一版：产物在哪，用什么区分这一版和其他版本（提交号、分支名或文件名），当时看的是哪个变体或哪组演示参数。有变体或演示参数的一并写下，没有就不写。",
      "- [ ] 写清什么算数：已点头的界面、状态与交互逐条列出；没被选中的备选明确写成不算数。下游只照列出的部分做。",
      "- [ ] 写下照做标准与复核人：实施时对照哪几个界面或状态、什么算还原；由当初点头这一版的人复核。这是给下游写规格与实施票的移交要求，不是本票要交的验收证据。",
      "",
      "{{shared:mapTicketAdvanceWrapUp}}",
    ].join("\n"),
  };

  // 阶梯档位(cards.mjs rowActionKind 的产出)→ 模板键:三处命名不同,其余同名。
  var LADDER_TO_TEMPLATE = { claim: "takeover", grill: "discuss", proto: "prototype" };

  // ---- {{shared:*}} 展开:逐层递归;未知小节、成环都报错(真源必须完整) ----
  var SHARED_RE = /\{\{shared:([A-Za-z0-9_-]+)\}\}/;
  function expandTemplate(tpl, shared, stack) {
    var table = shared || SHARED_SECTIONS;
    var seen = stack || [];
    return String(tpl === null || tpl === undefined ? "" : tpl).replace(new RegExp(SHARED_RE.source, "g"), function (_, name) {
      if (seen.indexOf(name) >= 0) throw Error("公共小节成环: " + seen.concat(name).join(" → "));
      if (!Object.prototype.hasOwnProperty.call(table, name)) throw Error("未知公共小节: " + name);
      return expandTemplate(table[name], table, seen.concat(name));
    });
  }

  // ---- 占位符替换:ctx 里有值的 {name} 逐一替换;无值保留原样(便于发现缺上下文) ----
  function fillPlaceholders(text, ctx) {
    return String(text).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, function (whole, name) {
      var v = ctx ? ctx[name] : undefined;
      return v === undefined || v === null ? whole : String(v);
    });
  }

  /** 档位 → 完整 prompt:模板 → shared 展开 → 占位替换。未知档位是接线 bug,报错。 */
  function buildActionPrompt(kind, ctx) {
    var tplKey = LADDER_TO_TEMPLATE[kind] || kind;
    if (!Object.prototype.hasOwnProperty.call(ACTION_TEMPLATES, tplKey)) throw Error("未知档位: " + kind);
    return fillPlaceholders(expandTemplate(ACTION_TEMPLATES[tplKey]), ctx || {});
  }

  // ---- 详情动作门控(detail-page.md §4,上游 detail-top-gate.ts 口径) ----
  /** 阻塞票「明确还没做完」:无合并时间,且状态归一后恰好是 open;缺失/认不出按未知,不置灰。 */
  function explicitlyUnfinished(node) {
    if (!node || typeof node !== "object") return false;
    if (node.mergedAt) return false; // 合并时间是已完成的硬证据
    var state = node.state === null || node.state === undefined ? "" : String(node.state).trim().toLowerCase();
    return state === "open";
  }
  /** 阻塞票号:只认可用正整数(M1 行无 number 字段,从 key 尾数字取),其余当未知。 */
  function usableNumber(node) {
    var m = /(\d+)\s*$/.exec(String((node && node.key) || ""));
    var n = m ? parseInt(m[1], 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  /**
   * 动作按钮能不能点:票关闭 → closed;被「明确 open」的票阻塞 → blocked(号去重升序);
   * 其余(含阻塞票数据不全的未知态)一律可点——凭猜置灰等于替用户否掉一张可能能开工的票。
   */
  function detailTopGateOf(row) {
    if (row && row.state !== "open") return { clickable: false, reason: "closed", blockedNumbers: [] };
    var list = row && Array.isArray(row.blockedBy) ? row.blockedBy : [];
    var numbers = [];
    for (var i = 0; i < list.length; i++) {
      if (!explicitlyUnfinished(list[i])) continue;
      var n = usableNumber(list[i]);
      if (n === null) continue;
      if (numbers.indexOf(n) < 0) numbers.push(n);
    }
    numbers.sort(function (a, b) { return a - b; });
    if (numbers.length) return { clickable: false, reason: "blocked", blockedNumbers: numbers };
    return { clickable: true, reason: "none", blockedNumbers: [] };
  }

  // ---- 图标(PixelCardBtns.ts 的 ICB 内联 SVG,结构化直拷;viewBox 0 0 24 24,12×12 渲染) ----
  var ACTION_ICONS = {
    chat: [
      { tag: "path", attrs: { d: "M21 15a2 2 0 01-2 2H8l-5 4V5a2 2 0 012-2h14a2 2 0 012 2z", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" } },
    ],
    play: [
      { tag: "path", attrs: { d: "M8 5.5l11 6.5-11 6.5z", fill: "currentColor", stroke: "none" } },
    ],
    search: [
      { tag: "circle", attrs: { cx: "11", cy: "11", r: "7", fill: "none", stroke: "currentColor", "stroke-width": "1.8" } },
      { tag: "path", attrs: { d: "M21 21l-4.3-4.3", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" } },
    ],
    hammer: [
      { tag: "path", attrs: { d: "M14 4l6 6-2.5 2.5-6-6z", fill: "none", stroke: "currentColor", "stroke-width": "1.8" } },
      { tag: "path", attrs: { d: "M3 21l7.5-7.5", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" } },
      { tag: "path", attrs: { d: "M12.5 9.5l2 2", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" } },
    ],
    proto: [
      { tag: "rect", attrs: { x: "3", y: "8.5", width: "13", height: "9", rx: "2", opacity: "0.52", fill: "none", stroke: "currentColor", "stroke-width": "1.8" } },
      { tag: "rect", attrs: { x: "7.8", y: "3.8", width: "13", height: "9", rx: "2", fill: "none", stroke: "currentColor", "stroke-width": "1.8" } },
    ],
  };

  global.MattSkillsActions = Object.freeze({
    ACTION_LABELS: ACTION_LABELS,
    ACTION_TEMPLATES: ACTION_TEMPLATES,
    SHARED_SECTIONS: SHARED_SECTIONS,
    ACTION_ICONS: ACTION_ICONS,
    expandTemplate: expandTemplate,
    fillPlaceholders: fillPlaceholders,
    buildActionPrompt: buildActionPrompt,
    detailTopGateOf: detailTopGateOf,
  });
})(typeof globalThis !== "undefined" ? globalThis : undefined);

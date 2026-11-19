// MattSkills 面板文案表(工单 09):全部界面中文单处集中,键名按上游 copy 词表
// (config/copy/*.yaml)组织,为 M3 i18n 配置化留缝——届时把本表换成上游同键名的
// 多语言词表即可,渲染点不动。纯脚本无 import,build 时拼进 bundle-0.txt(段序第一),
// Node 测试直接 import 执行同一 IIFE。
// 键名出处约定:
//   · 与上游同键名的键(card.* / list.* / nav.* / detail.* / tip.*):UI 角色与上游一致,
//     M1 的中文值暂为本插件自己的文案,M3 对齐上游词条;
//   · 其余(panel.* / writer.* / act.* 与 detail.* 里的 M1 增补)是本地键,同样按
//     「家族前缀.位置」命名,上游没有对应物。
// 占位符约定与上游一致:值里的 {n} 由渲染处 replace,中英两份必须一字不差
// (M1 仅 zh,静态自检见 test/scaffold.test.mjs 文案段)。
"use strict";
(function (global) {
  var COPY = {
    // ---- 面板骨架 / 加载 / 空工作区引导(M1 本地,panel.* 家族) ----
    "panel.loading": "正在加载看板…",
    "panel.loadFail": "看板加载失败",
    "panel.empty.title": "还没有工单",
    "panel.empty.body0": "此工作区还没有 .scratch/ 工单目录。运行 ",
    "panel.empty.setup": "/setup-matt-pocock-skills",
    "panel.empty.mid": " 初始化,或让 agent 用 ",
    "panel.empty.tickets": "/to-tickets",
    "panel.empty.end": " 拆解规格。",
    "panel.empty.hint": "生成工单后,本页签会展示任务看板。",
    "panel.boardTitle": "任务看板",

    // ---- 计数胶囊条(nav.takeable/occupied/bug/triage 键名同上游 panel.yaml,M1 补齐其余) ----
    "nav.takeable": "可接",
    "nav.open": "进行中",
    "nav.occupied": "占用",
    "nav.claimed": "已认领",
    "nav.blocked": "被阻塞",
    "nav.bug": "故障",
    "nav.triage": "诊断",
    "nav.closed": "已关闭",
    "nav.total": "全部",

    // ---- 卡面(card.* 键名同上游 cards.yaml:角标/结案章/阻塞脚注/状态) ----
    "card.openState": "在办",
    "card.legendClaimed": "已认领",
    "card.closedSeal": "结案",
    "card.blockedBy": "被 {n} 挡住",
    "card.bug": "BUG",
    "card.doing": "在办",
    "card.pickReady": "可接",
    // 动作档位文案(card.act.* 九档,同上游 cards.yaml;actions.mjs 的 ACTION_LABELS 从这里取值)
    "card.act.diagnose": "诊断",
    "card.act.fix": "修复",
    "card.act.execute": "执行",
    "card.act.claim": "接手",
    "card.act.supplement": "补充",
    "card.act.research": "研究",
    "card.act.grill": "讨论",
    "card.act.proto": "原型",
    "card.act.implement": "实施",

    // ---- 列表:筛选 / 排序 / 折叠(list.* 键名同上游 flow.yaml) ----
    "list.state.all": "全部",
    "list.state.open": "进行中",
    "list.state.closed": "已关闭",
    "list.state.blocked": "被阻塞",
    "list.state.frontier": "可接",
    "list.sort.updatedAt": "更新时间",
    "list.sort.createdAt": "创建时间",
    "list.sort.number": "编号",
    "list.sort.title": "标题",
    "list.all": "全部",
    "list.blocked": "被阻塞",
    "list.collapse": "收起",
    "list.none": "没有匹配的工单",
    "list.closedN": "已关闭 ({n})",
    "list.loading": "加载中…",

    // ---- 详情(detail.* / tip.* 键名同上游 flow.yaml,余 M1 本地) ----
    "list.back": "返回列表",
    "detail.descTitle": "描述",
    "detail.noBody": "无描述",
    "detail.loadFail": "详情加载失败",
    "detail.retry": "重试",
    "detail.badShape": "deck_issue_get 应答缺卡数据",
    "detail.commentsLoading": "评论 · 加载中",
    "detail.notYet": "评论 · 还没拿到",
    "detail.commentsCount": "评论 ({n})",
    "detail.commentsMore": "显示其余 {n} 条",
    "detail.updated": "· 更新 {n}",
    "detail.created": "· 创建 {n}",
    "detail.writeNote": "写回纪律:只动状态行/标签行/评论追加,正文永不重排",
    "tip.detailClosedReadonly": "这张票已关闭，只能查看。",
    "tip.detailBlockedBy": "被 {n} 阻塞，等它们关闭后才能执行。",

    // ---- 动作栏发送反馈(M1 本地,act.* 家族) ----
    "act.sending": "发送中…",
    "act.sent": "已发送",
    "act.fail": "发送失败:",

    // ---- 写入口(writer.* M1 本地;评论框占位/提交键名同上游 detail.cmtPlaceholder/tip.sendComment) ----
    "writer.close": "关闭卡",
    "writer.reopen": "重开卡",
    "detail.cmtPlaceholder": "写评论…(提交即落盘到卡片文件)",
    "tip.sendComment": "提交评论",
    "writer.sending": "写入中…",
    "writer.done": "已写入",
    "writer.emptyBody": "先写点内容再提交。",
  };
  global.MattSkillsCopy = COPY;
})(typeof globalThis !== "undefined" ? globalThis : undefined);

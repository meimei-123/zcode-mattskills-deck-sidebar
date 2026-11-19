// 工单 05 缝 2 测试:详情与评论(读)。stub 桥与列表测试共架(stub-host.mjs),
// 喂 fixtures 经真 dist/server.mjs 预录的 deck_issue_get 响应,断言可见 DOM:
// 行点击进详情(粘性顶栏/元行/正文 markdown 基础渲染/评论时间线/只读提示)、
// 正文三态(还没拿到 ≠ 无描述 ≠ 加载失败)、返回列表恢复、顶栏折叠阶梯、评论分页(页大小 50)。
// 工单 06 追加写面切片(H/I/J):评论提交、关闭/重开、写失败人话——临时工作区真写盘。
// fixtures 期望值独立于实现,来自卡片文件手工盘点。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeStubHost, startServer, byClass, byAttr, findAll, sleep, until } from "./stub-host.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const FIXTURES = join(ROOT, "test", "fixtures");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** 混合工作区起一个已渲染列表的宿主(详情最常用的起点)。 */
async function boardHost() {
  const server = await startServer(join(FIXTURES, "mixed"));
  const host = makeStubHost({ server });
  host.start();
  await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
  return { server, host };
}

/** 点列表行进详情,等到详情视图出现。工单 04 起关闭票默认折叠:找不到行先展开折叠区再找。 */
async function enterDetail(host, dataNum) {
  let row = byAttr(host.root, "data-num", dataNum)[0];
  if (!row) {
    const fold = byClass(host.root, "ms-closed-fold")[0];
    if (fold) {
      fold.click();
      await until(() => byAttr(host.root, "data-num", dataNum).length > 0, "closed rows render");
    }
    row = byAttr(host.root, "data-num", dataNum)[0];
  }
  if (!row) throw new Error(`行不存在: ${dataNum}`);
  row.click();
  const shown = await until(() => byClass(host.root, "ms-detail").length > 0, "detail render");
  return shown;
}

// ---------------------------------------------------------------------------
// 切片 A:列表行点击 → 详情视图(顶栏 / 头部 / 元行 / 正文 md / 评论时间线 / 只读提示 / 桥包络)
//   期望值来自 mixed fixture 手工盘点:m1-core-board/01 =
//   open/bug/无认领/创建 2026-11-15;正文一段「manifest/MCP 服务/引导态面板先立起来。」;
//   1 条评论(agent · 2026-11-15 · 骨架已提交,面板进下一票。)。
// ---------------------------------------------------------------------------
async function sliceEnter() {
  const { server, host } = await boardHost();
  try {
    const entered = await enterDetail(host, "#m1-core-board/01");
    check("enter: 行点击进详情视图", entered, host.root.textContent.slice(0, 120));
    check("enter: 详情态不残留列表行", byClass(host.root, "ms-row").length === 0);
    // 取数应答异步回来:等到正文段落出现再断言内容
    await until(() => byClass(host.root, "ms-md-p").length > 0, "detail body render");

    // 粘性顶栏:返回 + 编号 + 标题,三元素都留全文底稿(data-full)
    const bar = byAttr(host.root, "data-detail-topbar", "1")[0];
    check("enter: 粘性顶栏存在(data-detail-topbar)", !!bar);
    const back = byClass(bar, "ms-back")[0];
    check("enter: 返回按钮文案", back?.textContent === "返回列表", back?.textContent);
    check("enter: 顶栏编号", byClass(bar, "ms-topbar-num")[0]?.textContent === "#m1-core-board/01");
    check("enter: 顶栏标题", byClass(bar, "ms-topbar-title")[0]?.textContent === "插件骨架 tracer");
    check("enter: 顶栏元素带全文底稿 data-full",
      back?.getAttribute("data-full") === "返回列表" &&
        byClass(bar, "ms-topbar-num")[0]?.getAttribute("data-full") === "#m1-core-board/01",
      JSON.stringify([back?.getAttribute("data-full"), byClass(bar, "ms-topbar-num")[0]?.getAttribute("data-full")]));

    // 头部:编号徽标 + 标题
    const head = byClass(host.root, "ms-detail-head")[0];
    check("enter: 头部编号徽标", byClass(head, "ms-num")[0]?.textContent === "#m1-core-board/01");
    check("enter: 头部标题", byClass(head, "ms-detail-title")[0]?.textContent === "插件骨架 tracer");

    // 元行:状态 / 标签 / 认领(此卡无认领)/ 创建日期
    const meta = byClass(host.root, "ms-meta")[0];
    check("enter: 元行存在", !!meta);
    check("enter: 元行状态胶囊", byClass(meta, "ms-state-chip")[0]?.textContent === "在办",
      byClass(meta, "ms-state-chip")[0]?.textContent);
    const lab = byClass(meta, "ms-label")[0];
    check("enter: 元行标签 chip(bug)", lab?.textContent === "bug", lab?.textContent);
    check("enter: 元行标签色点走内置色表(#d73a4a)",
      byClass(meta, "ms-label-dot")[0]?.getAttribute("data-color") === "#d73a4a");
    check("enter: 无认领卡不画认领 chip", byClass(meta, "ms-assignee").length === 0);
    check("enter: 元行创建日期(DSH-CREATED)",
      byClass(meta, "ms-meta-date").some((n) => /创建 2026-11-15/.test(n.textContent)),
      JSON.stringify(byClass(meta, "ms-meta-date").map((n) => n.textContent)));

    // 正文:H1/字段行/评论区不入描述,只剩一段说明文字
    const body = byClass(host.root, "ms-body")[0];
    check("enter: 正文渲染成段落", byClass(body, "ms-md-p")[0]?.textContent === "manifest/MCP 服务/引导态面板先立起来。",
      byClass(body, "ms-md-p")[0]?.textContent);
    check("enter: 正文不重复标题", !body?.textContent.includes("插件骨架 tracer"), body?.textContent.slice(0, 80));
    check("enter: 正文不残留字段行", !body?.textContent.includes("**Status:** open"), body?.textContent.slice(0, 80));

    // 评论时间线:标题计数 + 头行(谁/日期)+ 正文
    check("enter: 评论标题计数", byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 (1)",
      byClass(host.root, "ms-comments-title")[0]?.textContent);
    const cmt = byClass(host.root, "ms-cmt-item")[0];
    check("enter: 评论头行 @谁", byClass(cmt, "ms-cmt-login")[0]?.textContent === "@agent",
      byClass(cmt, "ms-cmt-login")[0]?.textContent);
    check("enter: 评论日期(ISO 取日期)", byClass(cmt, "ms-cmt-date")[0]?.textContent === "2026-11-15",
      byClass(cmt, "ms-cmt-date")[0]?.textContent);
    check("enter: 评论正文", byClass(cmt, "ms-cmt-body")[0]?.textContent.includes("骨架已提交,面板进下一票。") === true,
      byClass(cmt, "ms-cmt-body")[0]?.textContent);

    // 底部写回纪律提示(工单 06 起详情可写,原只读提示改为纪律说明)
    const ro = byClass(host.root, "ms-writenote")[0];
    check("enter: 底部写回纪律提示", !!ro && ro.textContent.length > 0, ro?.textContent);

    // 桥包络:get 带目录前缀寻址到点的那张卡
    const getCalls = host.sent.filter((m) => m.method === "tools/call" && m.params?.name === "deck_issue_get");
    check("enter: 经桥调用 deck_issue_get", getCalls.length === 1, String(getCalls.length));
    check("enter: get 参数带工作单元前缀", getCalls[0]?.params?.arguments?.key === "m1-core-board/01",
      JSON.stringify(getCalls[0]?.params?.arguments));
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 B:正文三态——还没拿到 ≠ 无描述 ≠ 加载失败;评论标题同口径(没拿到不许报 (0))
// ---------------------------------------------------------------------------
async function sliceStates() {
  // 还没拿到:列表先渲染,再挂住 get 应答 → 详情停在加载态;放行后正文到位
  {
    const server = await startServer(join(FIXTURES, "mixed"));
    try {
      const host = makeStubHost({ server });
      host.start();
      await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
      host.holdToolsNow();
      await enterDetail(host, "#m1-core-board/01");
      check("states: 还没拿到 → 正文加载中", byClass(host.root, "ms-body-loading")[0]?.textContent === "加载中…",
        byClass(host.root, "ms-body-loading")[0]?.textContent);
      check("states: 还没拿到 ≠ 无描述", byClass(host.root, "ms-body-empty").length === 0);
      check("states: 评论没拿到不报 (0)", byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 · 加载中",
        byClass(host.root, "ms-comments-title")[0]?.textContent);
      await host.releaseTools();
      const loaded = await until(() => byClass(host.root, "ms-md-p").length > 0, "body after release");
      check("states: 应答回来正文渲染", loaded);
      check("states: 评论计数到位", byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 (1)");
    } finally {
      await server.stop();
    }
  }
  // 加载失败:桥对 get 回协议错 → 失败态(标题+消息+重试);重试可恢复
  {
    const server = await startServer(join(FIXTURES, "mixed"));
    const failNames = new Set(["deck_issue_get"]);
    try {
      const host = makeStubHost({ server, failNames });
      host.start();
      await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
      await enterDetail(host, "#m1-core-board/01");
      const failed = await until(() => byClass(host.root, "ms-body-error").length > 0, "error state");
      check("states: 加载失败态可见", failed);
      check("states: 失败标题", byClass(host.root, "ms-body-error-title")[0]?.textContent === "详情加载失败",
        byClass(host.root, "ms-body-error-title")[0]?.textContent);
      check("states: 失败带桥错误消息", /工具调用失败/.test(byClass(host.root, "ms-error-detail")[0]?.textContent || ""),
        byClass(host.root, "ms-error-detail")[0]?.textContent);
      check("states: 失败 ≠ 无描述", byClass(host.root, "ms-body-empty").length === 0);
      check("states: 失败时评论还没拿到", byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 · 还没拿到",
        byClass(host.root, "ms-comments-title")[0]?.textContent);
      check("states: 失败给重试按钮", byClass(host.root, "ms-retry").length === 1);
      failNames.clear();
      byClass(host.root, "ms-retry")[0].click();
      const recovered = await until(() => byClass(host.root, "ms-md-p").length > 0, "retry recovers");
      check("states: 重试后正文渲染", recovered);
      check("states: 重试后评论计数", byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 (1)");
    } finally {
      await server.stop();
    }
  }
  // 无描述:取回来了、抽完剩空 → 才说无描述;0 条评论此时可如实报 (0)
  {
    const server = await startServer(join(FIXTURES, "detail"));
    try {
      const host = makeStubHost({ server });
      host.start();
      await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
      await enterDetail(host, "#demo/02");
      const emptied = await until(() => byClass(host.root, "ms-body-empty").length > 0, "empty body");
      check("states: 取到空正文 → 无描述", emptied && byClass(host.root, "ms-body-empty")[0]?.textContent === "无描述",
        byClass(host.root, "ms-body-empty")[0]?.textContent);
      check("states: 无描述时加载态撤下", byClass(host.root, "ms-body-loading").length === 0);
      check("states: 0 条评论如实报 (0)", byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 (0)",
        byClass(host.root, "ms-comments-title")[0]?.textContent);
      check("states: 关闭卡状态胶囊", byClass(host.root, "ms-meta")[0] && /已关闭/.test(byClass(host.root, "ms-meta")[0].textContent));
    } finally {
      await server.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// 切片 C:返回列表恢复——列表从缓存原样重渲染,不重发 deck_issue_list,可再次进入
// ---------------------------------------------------------------------------
async function sliceBack() {
  const { server, host } = await boardHost();
  try {
    const listCalls = () => host.sent.filter((m) => m.method === "tools/call" && m.params?.name === "deck_issue_list").length;
    const before = listCalls();
    await enterDetail(host, "#m1-core-board/01");
    await until(() => byClass(host.root, "ms-md-p").length > 0, "detail body");

    byClass(host.root, "ms-back")[0].click();
    // 工单 04 合流:进入前未展开折叠,返回也应保持折叠(原样=当时的样子),可见 6 行
    const backShown = await until(() => byClass(host.root, "ms-row").length === 6, "board restored");
    check("back: 返回列表,6 行原样恢复(关闭票保持折叠)", backShown, String(byClass(host.root, "ms-row").length));
    byClass(host.root, "ms-closed-fold")[0].click();
    const expanded = await until(() => byClass(host.root, "ms-row").length === 8, "closed fold expands");
    check("back: 展开折叠区后 8 行", expanded, String(byClass(host.root, "ms-row").length));
    check("back: 计数胶囊条恢复", byClass(host.root, "ms-pill").length === 9);
    check("back: 恢复不重发 deck_issue_list", listCalls() === before, `${before} → ${listCalls()}`);
    check("back: 详情态撤下", byClass(host.root, "ms-detail").length === 0 && byClass(host.root, "ms-topbar").length === 0);

    // 再次进入:交互不因返回而坏掉
    const again = await enterDetail(host, "#explore-login/01");
    check("back: 返回后可再次进入详情", again);
    await until(() => byClass(host.root, "ms-cmt-item").length > 0, "second detail body");
    const meta = byClass(host.root, "ms-meta")[0];
    check("back: 第二张卡元行认领人(@dev)", byClass(meta, "ms-assignee")[0]?.textContent === "@dev",
      byClass(meta, "ms-assignee")[0]?.textContent);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 D:顶栏折叠(issueDetailFold 口径)——阶梯按元素序(返回→编号→标题)、尾部逐字裁、
// 不补省略号、fits = scrollWidth ≤ clientWidth+1。
// 桩的宽度模型:clientWidth 注入预算,scrollWidth 取顶栏当前文本总字数(粗粒度布局模型,
// 只用于驱动折叠机收敛,与真实浏览器同 API)。
// ---------------------------------------------------------------------------
async function sliceFold() {
  const server = await startServer(join(FIXTURES, "detail"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    await enterDetail(host, "#demo/01");
    await until(() => byClass(host.root, "ms-cmt-item").length > 0, "detail body");

    const bar = byAttr(host.root, "data-detail-topbar", "1")[0];
    const parts = ["ms-back", "ms-topbar-num", "ms-topbar-title"].map((c) => byClass(bar, c)[0]);
    const fulls = parts.map((p) => p.getAttribute("data-full"));
    const lens = fulls.map((s) => s.length);
    const total = lens[0] + lens[1] + lens[2];

    // 无测量环境(桩缺省):不折,全文保留
    check("fold: 放得下时全文保留", parts.every((p, i) => p.textContent === fulls[i]),
      JSON.stringify(parts.map((p) => p.textContent)));

    // 预算 total-9:按口径至少净掉 8 字(容忍 +1)→ 返回(4)全裁 + 编号裁 4,标题不动
    let budget = 0;
    Object.defineProperty(bar, "clientWidth", { configurable: true, get: () => budget });
    Object.defineProperty(bar, "scrollWidth", { configurable: true, get: () => bar.textContent.length });
    budget = total - 9;
    host.fireResize();
    const expectBack = ""; // 返回列表 4 字全裁(剩图标语义由样式兜底,不补省略号)
    const expectNum = fulls[1].slice(0, lens[1] - 4); // 尾部裁 4 字
    check("fold: 阶梯先折返回(全裁)", parts[0].textContent === expectBack, JSON.stringify(parts[0].textContent));
    check("fold: 再折编号(尾部逐字裁)", parts[1].textContent === expectNum,
      JSON.stringify({ got: parts[1].textContent, want: expectNum }));
    check("fold: 折够即停,标题不动", parts[2].textContent === fulls[2], JSON.stringify(parts[2].textContent));
    check("fold: 不补省略号", !bar.textContent.includes("…") && !bar.textContent.includes("..."), bar.textContent);
    check("fold: data-full 底稿不动", parts.every((p, i) => p.getAttribute("data-full") === fulls[i]));

    // 预算放宽 → 复位回全文(每次重算先全量复位)
    budget = total;
    host.fireResize();
    check("fold: 放宽后复位全文", parts.every((p, i) => p.textContent === fulls[i]),
      JSON.stringify(parts.map((p) => p.textContent)));
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 E:评论分页(上游 COMMENTS_PAGE_SIZE=50)——标题计全量,时间线一次铺 50,
// 超出给「显示其余 N 条」;点开补齐后按钮撤下
// ---------------------------------------------------------------------------
async function sliceCommentsPage() {
  const server = await startServer(join(FIXTURES, "detail"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    await enterDetail(host, "#demo/01");
    await until(() => byClass(host.root, "ms-cmt-item").length > 0, "comments render");

    check("page: 标题计全量 55", byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 (55)",
      byClass(host.root, "ms-comments-title")[0]?.textContent);
    check("page: 首屏只铺 50 条", byClass(host.root, "ms-cmt-item").length === 50,
      String(byClass(host.root, "ms-cmt-item").length));
    const more = byClass(host.root, "ms-cmt-more")[0];
    check("page: 超出给显示其余按钮", more?.textContent === "显示其余 5 条", more?.textContent);
    more.click();
    await until(() => byClass(host.root, "ms-cmt-item").length === 55, "all comments");
    check("page: 点开补齐 55 条", byClass(host.root, "ms-cmt-item").length === 55,
      String(byClass(host.root, "ms-cmt-item").length));
    check("page: 补齐后按钮撤下", byClass(host.root, "ms-cmt-more").length === 0);
    const items = byClass(host.root, "ms-cmt-item");
    check("page: 首条评论", byClass(items[0], "ms-cmt-login")[0]?.textContent === "@agent" &&
      byClass(items[0], "ms-cmt-date")[0]?.textContent === "2026-11-18",
      items[0]?.textContent.slice(0, 40));
    check("page: 尾条评论在位", (byClass(items[54], "ms-cmt-body")[0]?.textContent || "").includes("第 55 条评论"),
      items[54]?.textContent);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 F:markdown 基础渲染(标题/列表/代码块/粗斜体),数据来自 detail fixture 正文
// ---------------------------------------------------------------------------
async function sliceMarkdown() {
  const server = await startServer(join(FIXTURES, "detail"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    await enterDetail(host, "#demo/01");
    await until(() => byClass(host.root, "ms-md-pre").length > 0, "md render");

    const body = byClass(host.root, "ms-body")[0];
    // 标题:##/### 都渲染成 ms-md-h,文案剥井号
    const hs = byClass(body, "ms-md-h");
    check("md: 标题渲染", hs.length === 2 && hs[0]?.textContent === "验收要点" && hs[1]?.textContent === "小节标题",
      JSON.stringify(hs.map((h) => h.textContent)));
    // 列表:三条 li,首条 li 内粗体
    const ul = byClass(body, "ms-md-list")[0];
    const lis = ul ? findAll(ul, (n) => n.tagName === "LI") : [];
    check("md: 无序列表三条", ul?.tagName === "UL" && lis.length === 3, `${ul?.tagName} ${lis.length}`);
    const strong = findAll(ul, (n) => n.tagName === "STRONG")[0];
    check("md: 行内粗体", strong?.textContent === "长", strong?.textContent);
    const em = findAll(ul, (n) => n.tagName === "EM")[0];
    check("md: 行内斜体", em?.textContent === "斜体", em?.textContent);
    // 代码块:围栏内原文,** 不再当粗体
    const pre = byClass(body, "ms-md-pre")[0];
    const code = findAll(pre, (n) => n.tagName === "CODE")[0];
    check("md: 代码块原文", code?.textContent === "fenced line\n**不算粗体**", JSON.stringify(code?.textContent));
    check("md: 代码块内不解析粗体", findAll(pre, (n) => n.tagName === "STRONG").length === 0);
    // 段落:中英混排保留
    const ps = byClass(body, "ms-md-p");
    check("md: 段落渲染", ps.some((p) => /中文与 English 混排/.test(p.textContent)),
      JSON.stringify(ps.map((p) => p.textContent)));
    // 描述抽取:字段行/隐藏注释/Comments 段不混进正文
    check("md: 正文不残留 Assignees 字段行", !body.textContent.includes("Assignees"));
    check("md: 正文不含评论区内容", !body.textContent.includes("第 1 条评论"));
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 G(与工单 08 合流的回归):详情态下刷新不打扰画面——轮询/强刷钩子重拉的全套数据
// 只进缓存,详情视图不动;返回列表时用的就是刷新后的那批
// ---------------------------------------------------------------------------
async function sliceRefreshGuard() {
  const { server, host } = await boardHost();
  try {
    await enterDetail(host, "#m1-core-board/01");
    await until(() => byClass(host.root, "ms-md-p").length > 0, "detail body");
    host.win.MattSkillsPanel.refresh(); // 强刷钩子(静默重拉全套,工单 08)
    await sleep(200); // 等重拉应答回来
    check("merge: 详情态强刷不打扰画面",
      byClass(host.root, "ms-detail").length === 1 && byClass(host.root, "ms-md-p").length > 0,
      host.root.textContent.slice(0, 60));
    byClass(host.root, "ms-back")[0].click();
    const back = await until(() => byClass(host.root, "ms-row").length === 6, "board back");
    check("merge: 返回列表照常恢复(缓存被刷新更新过,折叠态保持)", back);
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") {
      host.win.MattSkillsPanel.stopPolling();
    }
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 工单 06 写面切片共用:临时工作区(拷 fixtures 后真写盘)+ 已渲染列表的宿主
// ---------------------------------------------------------------------------
function mkws(fixture) {
  const dir = mkdtempSync(join(tmpdir(), `t06ui-${fixture}-`));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}
async function writableBoardHost(fixture = "mixed") {
  const ws = mkws(fixture);
  const server = await startServer(ws);
  const host = makeStubHost({ server });
  host.start();
  await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
  return { ws, server, host };
}
const callsOf = (host, name) => host.sent.filter((m) => m.method === "tools/call" && m.params?.name === name);

// ---------------------------------------------------------------------------
// 切片 H(工单 06):评论提交——输入框 + 提交按钮 → 桥发 deck_issue_comment(带前缀 key);
// 成功轻反馈;详情评论时间线自动跟上;列表经 refresh() 重拉;磁盘真落 `### local — ISO` 块。
// ---------------------------------------------------------------------------
async function sliceWriteComment() {
  const { ws, server, host } = await writableBoardHost();
  try {
    await enterDetail(host, "#m1-core-board/01");
    await until(() => byClass(host.root, "ms-md-p").length > 0, "detail body");
    check("write: 评论输入框在详情里", byClass(host.root, "ms-cmt-input").length === 1);
    check("write: 提交按钮在", byClass(host.root, "ms-cmt-send").length === 1);

    // 空内容本地拦截,不发桥
    byClass(host.root, "ms-cmt-send")[0].click();
    check("write: 空评论不发桥", callsOf(host, "deck_issue_comment").length === 0);
    check("write: 空评论给本地提示", /先写点/.test(byClass(host.root, "ms-write-hint")[0]?.textContent || ""),
      byClass(host.root, "ms-write-hint")[0]?.textContent);

    // 提交真评论
    const listCallsBefore = callsOf(host, "deck_issue_list").length;
    byClass(host.root, "ms-cmt-input")[0].value = "面板评论来了。";
    byClass(host.root, "ms-cmt-send")[0].click();
    const sent = await until(() => callsOf(host, "deck_issue_comment").length === 1, "comment sent");
    check("write: 经桥发 deck_issue_comment", sent);
    const args = callsOf(host, "deck_issue_comment")[0]?.params?.arguments || {};
    check("write: 参数带前缀 key 与正文", args.key === "m1-core-board/01" && args.body === "面板评论来了。", JSON.stringify(args));

    check("write: 成功轻反馈(is-ok)", await until(() => byClass(host.root, "is-ok").length === 1, "ok hint"));
    check("write: 成功反馈文案", /已写入/.test(byClass(host.root, "ms-write-hint")[0]?.textContent || ""),
      byClass(host.root, "ms-write-hint")[0]?.textContent);
    check("write: 输入框已清空", byClass(host.root, "ms-cmt-input")[0]?.value === "");
    check("write: 评论计数 1→2", await until(() => byClass(host.root, "ms-comments-title")[0]?.textContent === "评论 (2)", "count 2"));
    const items = byClass(host.root, "ms-cmt-item");
    check("write: 时间线尾出现 @local 新评论",
      byClass(items[items.length - 1], "ms-cmt-login")[0]?.textContent === "@local" &&
        (byClass(items[items.length - 1], "ms-cmt-body")[0]?.textContent || "").includes("面板评论来了。"),
      items[items.length - 1]?.textContent.slice(0, 60));
    check("write: 写后 refresh() 重拉列表", await until(() => callsOf(host, "deck_issue_list").length > listCallsBefore, "list reloaded"));
    const disk = readFileSync(join(ws, ".scratch", "m1-core-board", "issues", "01-skeleton.md"), "utf8");
    check("write: 磁盘落 `### local — ISO` 块", /### local — \d{4}-\d{2}-\d{2}T/.test(disk) && disk.includes("面板评论来了。"));
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") host.win.MattSkillsPanel.stopPolling();
    await server.stop();
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 I(工单 06):关闭/重开——按钮随状态翻转;写后元行状态胶囊即时跟上;
// 桥发 deck_issue_close / deck_issue_reopen;磁盘状态行真换。
// ---------------------------------------------------------------------------
async function sliceWriteState() {
  const { ws, server, host } = await writableBoardHost();
  try {
    await enterDetail(host, "#m1-core-board/02");
    await until(() => byClass(host.root, "ms-md-p").length > 0, "detail body");
    const btn = byAttr(host.root, "data-act", "close")[0];
    check("state: open 卡给「关闭卡」按钮", btn?.textContent === "关闭卡", btn?.textContent);
    check("state: 没有重开按钮", byAttr(host.root, "data-act", "reopen").length === 0);

    btn.click();
    check("state: 经桥发 deck_issue_close", await until(() => callsOf(host, "deck_issue_close").length === 1, "close sent"));
    check("state: 参数带前缀 key", callsOf(host, "deck_issue_close")[0]?.params?.arguments?.key === "m1-core-board/02",
      JSON.stringify(callsOf(host, "deck_issue_close")[0]?.params?.arguments));
    check("state: 元行胶囊变「已关闭」", await until(() => byClass(host.root, "ms-state-chip")[0]?.textContent === "已关闭", "chip closed"));
    check("state: 按钮翻转为「重开卡」", await until(() => byAttr(host.root, "data-act", "reopen")[0]?.textContent === "重开卡", "reopen btn"));
    const disk1 = readFileSync(join(ws, ".scratch", "m1-core-board", "issues", "02-server-read.md"), "utf8");
    check("state: 磁盘状态行换 closed", disk1.includes("**Status:** closed"), disk1.split("\n").slice(2, 5).join("\n"));

    byAttr(host.root, "data-act", "reopen")[0].click();
    check("state: 经桥发 deck_issue_reopen", await until(() => callsOf(host, "deck_issue_reopen").length === 1, "reopen sent"));
    check("state: 胶囊回「在办」", await until(() => byClass(host.root, "ms-state-chip")[0]?.textContent === "在办", "chip open"));
    check("state: 按钮回「关闭卡」", await until(() => byAttr(host.root, "data-act", "close")[0]?.textContent === "关闭卡", "close btn"));
    const disk2 = readFileSync(join(ws, ".scratch", "m1-core-board", "issues", "02-server-read.md"), "utf8");
    check("state: 磁盘状态行换回 ready-for-agent", disk2.includes("**Status:** ready-for-agent"));
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") host.win.MattSkillsPanel.stopPolling();
    await server.stop();
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 J(工单 06):写失败显示服务端人话——卡文件被外因挪走后提交,服务端「找不到卡」
// 的中文错误原样上屏(is-err),输入不丢(可改可重试)。
// ---------------------------------------------------------------------------
async function sliceWriteFail() {
  const { ws, server, host } = await writableBoardHost();
  try {
    await enterDetail(host, "#m1-core-board/01");
    await until(() => byClass(host.root, "ms-md-p").length > 0, "detail body");
    rmSync(join(ws, ".scratch", "m1-core-board", "issues", "01-skeleton.md"));
    byClass(host.root, "ms-cmt-input")[0].value = "写给一张被挪走的卡。";
    byClass(host.root, "ms-cmt-send")[0].click();
    await until(() => callsOf(host, "deck_issue_comment").length === 1, "comment sent");
    check("fail: 服务端人话错误上屏(is-err)", await until(() => byClass(host.root, "is-err").length === 1, "err hint"));
    check("fail: 错误文案是服务端的「找不到卡」",
      /找不到卡/.test(byClass(host.root, "ms-write-hint")[0]?.textContent || ""),
      byClass(host.root, "ms-write-hint")[0]?.textContent);
    check("fail: 输入不丢可重试", byClass(host.root, "ms-cmt-input")[0]?.value === "写给一张被挪走的卡。");
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") host.win.MattSkillsPanel.stopPolling();
    await server.stop();
    rmSync(ws, { recursive: true, force: true });
  }
}

await sliceEnter();
await sliceStates();
await sliceBack();
await sliceFold();
await sliceCommentsPage();
await sliceMarkdown();
await sliceRefreshGuard();
await sliceWriteComment();
await sliceWriteState();
await sliceWriteFail();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

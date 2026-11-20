// 工单 07 缝 2 测试:详情页动作栏(档位渲染 + 实心/空心样式 + 桥 sendMessage 包络与载荷)。
// 与 panel-detail 共架(stub-host.mjs):真 dist/server.mjs 对 cards fixture 预录,cardsdemo
// 目录十档票一票一档(01 诊断 … 09 执行,10 兜底,11 关闭,12 被阻塞),正好逐档断言。
// 桥协议期望来自 excalidraw 0.3.4 内置客户端的实跑行为:ui/message 请求
// {role:"user", content:[{type:"text",text}]},宿主回空 result。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeStubHost, startServer, byClass, byAttr, classesOf, until } from "./stub-host.mjs";

// 共存开关(0.2.1 起默认上游复刻):旧 UI 系测试拨到 off
globalThis.localStorage = { getItem: () => "off", setItem() {}, removeItem() {} };

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const FIXTURES = join(ROOT, "test", "fixtures");
const CARD_PATH = (n) => join(FIXTURES, "cards", ".scratch", "cardsdemo", "issues", `${n}-${{
  "01": "diagnose", "02": "fix", "03": "claim", "04": "supplement", "05": "research",
  "06": "grill", "07": "proto", "08": "implement", "09": "execute", "10": "custom",
  "11": "closed-fix", "12": "blocked",
}[n]}.md`);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** cards 工作区起一个已渲染列表的宿主。 */
async function cardsHost(opts = {}) {
  const server = await startServer(join(FIXTURES, "cards"));
  const host = makeStubHost({ server, ...opts });
  host.start();
  await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
  return { server, host };
}

/** 点列表行进详情并等动作栏出现(工单 07 起详情必有动作栏,容器行除外)。 */
async function enterDetail(host, dataNum, wantBar = true) {
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
  if (!shown) throw new Error("详情未渲染");
  if (wantBar) await until(() => byClass(host.root, "ms-actionbar").length > 0, "actionbar render");
}

const sentMessages = (host) => host.sent.filter((m) => m.method === "ui/message");

// ---------------------------------------------------------------------------
// 切片 A:十档渲染(档位/文案/图标/实心空心/内联色)+ 每档点击后的 prompt 载荷
//   期望值独立于实现:档位表 = action-prompts.md §1;样式 = pixel-cards.md §2
//   (实心档底=主色、字=cardInkOn;描线档边=主色、透明底);文案 = cards.yaml card.act.*。
// ---------------------------------------------------------------------------
async function sliceTiers() {
  const { server, host } = await cardsHost();
  try {
    const TIERS = [
      // [编号, 档位, 文案, 图标, 空心, 首行, 卡标题(fixture 盘点), 主色断言]
      ["01", "diagnose", "诊断", "chat", false, "/triage", "诊断档票", { background: "#fbca04", color: "#1c1004" }],
      ["02", "fix", "修复", "hammer", false, "/implement", "修复档票", null],
      ["03", "claim", "接手", "play", false, "/triage", "接手档票", null],
      ["04", "supplement", "补充", "play", false, "/triage", "补充档票", null],
      ["05", "research", "研究", "search", true, "/wayfinder", "研究档票", { borderColor: "#0ea5e9" }],
      ["06", "grill", "讨论", "chat", true, "/wayfinder", "讨论档票", null],
      ["07", "proto", "原型", "proto", true, "/wayfinder", "原型档票", null],
      ["08", "implement", "实施", "hammer", false, "/implement", "实施档票", { background: "#1d4ed8" }],
      ["09", "execute", "执行", "play", false, "/wayfinder", "执行档票", null],
      ["10", "execute", "执行", "play", false, "/wayfinder", "自定义标签票", null], // 未知标签兜底执行
    ];
    for (const [num, kind, label, icon, hollow, firstLine, cardTitle, colors] of TIERS) {
      await enterDetail(host, `#cardsdemo/${num}`);
      const bar = byClass(host.root, "ms-actionbar")[0];
      const btn = byClass(bar, "ms-abtn")[0];
      check(`tier ${num}: 档位 ${kind}`, btn?.getAttribute("data-kind") === kind, btn?.getAttribute("data-kind"));
      check(`tier ${num}: 文案 ${label}`, btn?.textContent === label, btn?.textContent);
      check(`tier ${num}: 图标 ${icon}`, btn?.getAttribute("data-icon") === icon, btn?.getAttribute("data-icon"));
      check(`tier ${num}: ${hollow ? "空心描线" : "实心"}`, classesOf(btn).includes("hollow") === hollow,
        String(btn?.className));
      if (colors) {
        for (const prop in colors) {
          check(`tier ${num}: 内联 ${prop}=${colors[prop]}`, btn?.style[prop] === colors[prop],
            `${prop}=${btn?.style[prop]}`);
        }
      }
      // 点击 → ui/message 包络与载荷:首行命令 + 第二行「#卡号 标题(路径)」+ shared 已展开
      const before = sentMessages(host).length;
      btn.click();
      const got = await until(() => sentMessages(host).length > before, "ui/message sent");
      check(`tier ${num}: 点击发出 ui/message`, got);
      const msg = sentMessages(host).at(-1);
      check(`tier ${num}: 包络 role=user 单文本块`,
        msg?.params?.role === "user" &&
          Array.isArray(msg.params.content) && msg.params.content.length === 1 &&
          msg.params.content[0]?.type === "text",
        JSON.stringify(msg?.params));
      const text = msg?.params?.content?.[0]?.text ?? "";
      const refLine = `#cardsdemo/${num} ${cardTitle}（${CARD_PATH(num)}）`;
      check(`tier ${num}: 载荷首行 ${firstLine}`, text.startsWith(firstLine + "\n"), JSON.stringify(text.slice(0, 40)));
      check(`tier ${num}: 载荷第二行卡号/标题/路径`, text.split("\n")[1] === refLine,
        JSON.stringify(text.split("\n")[1]));
      check(`tier ${num}: 载荷 shared 展开`, !text.includes("{{shared:") && !text.includes("{url}"));
      check(`tier ${num}: 成功提示`, byClass(bar, "ms-act-status")[0]?.textContent === "已发送",
        byClass(bar, "ms-act-status")[0]?.textContent);
      byClass(host.root, "ms-back")[0].click();
      await until(() => byClass(host.root, "ms-row").length > 0, "board back");
    }
    check("tier: 十档各发一条 ui/message", sentMessages(host).length === 10, String(sentMessages(host).length));
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") {
      host.win.MattSkillsPanel.stopPolling();
    }
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 B:发送反馈——成功后按钮恢复;失败显示错误并恢复按钮
// ---------------------------------------------------------------------------
async function sliceFeedback() {
  // 失败:宿主对 ui/message 回协议错 → 错误可见、按钮恢复(可重点重试)
  {
    const { server, host } = await cardsHost({ failUiMessage: true });
    try {
      await enterDetail(host, "#cardsdemo/02");
      const btn = byClass(host.root, "ms-abtn")[0];
      btn.click();
      const failed = await until(
        () => (byClass(host.root, "ms-act-status")[0]?.textContent || "").includes("发送失败"),
        "send fail shown");
      check("feedback: 失败显示错误", failed, byClass(host.root, "ms-act-status")[0]?.textContent);
      check("feedback: 失败消息来自桥", /stub: /.test(byClass(host.root, "ms-act-status")[0]?.textContent || ""),
        byClass(host.root, "ms-act-status")[0]?.textContent);
      check("feedback: 失败后按钮恢复可点", btn.getAttribute("aria-disabled") !== "true" && !btn.getAttribute("disabled"),
        `${btn.getAttribute("aria-disabled")} ${btn.getAttribute("disabled")}`);
      // 再点一次:仍会再发(失败不该把按钮永久锁死)
      const before = sentMessages(host).length;
      btn.click();
      check("feedback: 失败后可再次发送", await until(() => sentMessages(host).length > before, "retry sent"));
    } finally {
      if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") {
        host.win.MattSkillsPanel.stopPolling();
      }
      await server.stop();
    }
  }
  // 发送中:挂起 ui/message 应答 → 按钮置灰禁用、状态「发送中…」;放行后转「已发送」
  {
    const { server, host } = await cardsHost({ holdUiMessage: true });
    try {
      await enterDetail(host, "#cardsdemo/01");
      const btn = byClass(host.root, "ms-abtn")[0];
      btn.click();
      const busy = await until(() => byClass(host.root, "ms-act-status")[0]?.textContent === "发送中…", "sending state");
      check("feedback: 发送中状态可见", busy, byClass(host.root, "ms-act-status")[0]?.textContent);
      check("feedback: 发送中按钮禁用", btn.getAttribute("disabled") === "1", btn.getAttribute("disabled"));
      await host.releaseUiMessage();
      check("feedback: 应答后转已发送",
        await until(() => byClass(host.root, "ms-act-status")[0]?.textContent === "已发送", "sent"));
      check("feedback: 已发送按钮恢复", btn.getAttribute("disabled") !== "1", btn.getAttribute("disabled"));
    } finally {
      if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") {
        host.win.MattSkillsPanel.stopPolling();
      }
      await server.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// 切片 C:门控(detailTopGate 口径)——关闭/被阻塞置灰不可发;未知状态不置灰
// ---------------------------------------------------------------------------
async function sliceGate() {
  const { server, host } = await cardsHost();
  try {
    // 11:已关闭(resolved)→ 置灰,点击无动作
    await enterDetail(host, "#cardsdemo/11");
    const closedBtn = byClass(host.root, "ms-abtn")[0];
    check("gate: 关闭票动作置灰", closedBtn?.getAttribute("aria-disabled") === "true", closedBtn?.getAttribute("aria-disabled"));
    check("gate: 关闭票悬停说明", closedBtn?.getAttribute("title") === "这张票已关闭，只能查看。",
      closedBtn?.getAttribute("title"));
    const n0 = sentMessages(host).length;
    closedBtn.click();
    await new Promise((r) => setTimeout(r, 80));
    check("gate: 关闭票点击不发送", sentMessages(host).length === n0, `${n0} → ${sentMessages(host).length}`);
    byClass(host.root, "ms-back")[0].click();
    await until(() => byClass(host.root, "ms-row").length > 0, "board back");

    // 12:被 open 的 #02 阻塞 → 置灰并点名
    await enterDetail(host, "#cardsdemo/12");
    const blockedBtn = byClass(host.root, "ms-abtn")[0];
    check("gate: 被阻塞票动作置灰", blockedBtn?.getAttribute("aria-disabled") === "true");
    check("gate: 被阻塞票悬停点名", blockedBtn?.getAttribute("title") === "被 #2 阻塞，等它们关闭后才能执行。",
      blockedBtn?.getAttribute("title"));
    const n1 = sentMessages(host).length;
    blockedBtn.click();
    await new Promise((r) => setTimeout(r, 80));
    check("gate: 被阻塞票点击不发送", sentMessages(host).length === n1, `${n1} → ${sentMessages(host).length}`);
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") {
      host.win.MattSkillsPanel.stopPolling();
    }
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 D:容器行(地图/规格)不画票动作栏——容器三态动作是另一张票的量
// ---------------------------------------------------------------------------
async function sliceContainers() {
  const { server, host } = await cardsHost();
  try {
    for (const num of ["#cardsdemo/00", "#specdemo/00"]) {
      await enterDetail(host, num, false);
      await until(() => byClass(host.root, "ms-detail").length > 0, "container detail");
      await new Promise((r) => setTimeout(r, 60)); // 等 get 应答也走完,确认不是时序问题
      check(`container ${num}: 详情无票动作栏`, byClass(host.root, "ms-actionbar").length === 0,
        String(byClass(host.root, "ms-actionbar").length));
      byClass(host.root, "ms-back")[0].click();
      await until(() => byClass(host.root, "ms-row").length > 0, "board back");
    }
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") {
      host.win.MattSkillsPanel.stopPolling();
    }
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 E(工单 09 跨票缝):详情里关闭卡后,写后重拉要把动作栏门禁一起翻新——
// 关闭 → 动作按钮置灰(aria-disabled + 悬停说明);重开 → 恢复可点。
// 临时工作区真写盘(与 panel-detail 写面切片同法),cards fixture #02 修复档票。
// ---------------------------------------------------------------------------
async function sliceGateAfterWrite() {
  const ws = mkdtempSync(join(tmpdir(), "t09gate-"));
  cpSync(join(FIXTURES, "cards"), ws, { recursive: true });
  const server = await startServer(ws);
  const host = makeStubHost({ server });
  const callsOf = (name) => host.sent.filter((m) => m.method === "tools/call" && m.params?.name === name);
  try {
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    await enterDetail(host, "#cardsdemo/02");
    await until(() => byClass(host.root, "ms-md-p").length > 0, "detail body");
    const btn0 = byClass(host.root, "ms-abtn")[0];
    check("seam: open 卡动作可点", btn0?.getAttribute("aria-disabled") !== "true" && !btn0?.getAttribute("title"),
      `${btn0?.getAttribute("aria-disabled")} ${btn0?.getAttribute("title")}`);

    // 写入口关闭卡 → 写后重拉 → 动作栏按新状态置灰
    byAttr(host.root, "data-act", "close")[0].click();
    check("seam: 经桥发 deck_issue_close", await until(() => callsOf("deck_issue_close").length === 1, "close sent"));
    const greyed = await until(() => byClass(host.root, "ms-abtn")[0]?.getAttribute("aria-disabled") === "true", "gate after close");
    check("seam: 写后关闭 → 动作栏置灰", greyed,
      byClass(host.root, "ms-abtn")[0]?.getAttribute("aria-disabled"));
    check("seam: 置灰悬停说明",
      byClass(host.root, "ms-abtn")[0]?.getAttribute("title") === "这张票已关闭，只能查看。",
      byClass(host.root, "ms-abtn")[0]?.getAttribute("title"));

    // 重开 → 重拉后恢复可点
    byAttr(host.root, "data-act", "reopen")[0].click();
    check("seam: 经桥发 deck_issue_reopen", await until(() => callsOf("deck_issue_reopen").length === 1, "reopen sent"));
    const restored = await until(() => {
      const b = byClass(host.root, "ms-abtn")[0];
      return b && b.getAttribute("aria-disabled") !== "true";
    }, "gate restored");
    check("seam: 重开 → 动作栏恢复可点", restored,
      `${byClass(host.root, "ms-abtn")[0]?.getAttribute("aria-disabled")} ${byClass(host.root, "ms-abtn")[0]?.getAttribute("title")}`);
    check("seam: 恢复后无置灰悬停说明", !byClass(host.root, "ms-abtn")[0]?.getAttribute("title"),
      byClass(host.root, "ms-abtn")[0]?.getAttribute("title"));
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") {
      host.win.MattSkillsPanel.stopPolling();
    }
    await server.stop();
    rmSync(ws, { recursive: true, force: true });
  }
}

await sliceTiers();
await sliceFeedback();
await sliceGate();
await sliceContainers();
await sliceGateAfterWrite();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

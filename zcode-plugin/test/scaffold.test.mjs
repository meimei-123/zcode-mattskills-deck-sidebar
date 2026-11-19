// 工单 01 骨架测试:产物存在性 / manifest 结构 / server 冒烟 / 引导态 / 市场清单。
// 缝 = 对外可观察边界:文件产物、stdio 协议应答、HTML 可见文案。node 直跑,无框架。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const require = createRequire(import.meta.url);

const PLUGIN_NAME = "zcode-mattpocock-skills-deck";
const PANEL_URI = `ui://${PLUGIN_NAME}/panel.html`;
const GUIDE_TEXT = "此工作区还没有 .scratch/ 工单目录";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// --- 1. 构建产物存在(dist 入库,server + ui/panel.html) ---
check("dist/server.mjs 存在", existsSync(join(ROOT, "dist", "server.mjs")));
check("dist/ui/panel.html 存在", existsSync(join(ROOT, "dist", "ui", "panel.html")));

// --- 2. manifest 结构对齐 excalidraw 官方形状 ---
const manifestPath = join(ROOT, ".zcode-plugin", "plugin.json");
check(".zcode-plugin/plugin.json 存在", existsSync(manifestPath));
if (existsSync(manifestPath)) {
  const m = require(manifestPath);
  check("manifest.name", m.name === PLUGIN_NAME, m.name);
  check("manifest.version 0.1.0", m.version === "0.1.0", m.version);

  const srv = m.mcpServers?.mattskills;
  check("mcpServers.mattskills 存在", !!srv);
  if (srv) {
    check("server.type=stdio", srv.type === "stdio");
    check("server.command=node", srv.command === "node");
    check("server.args 指向 ${ZCODE_PLUGIN_ROOT}/dist/server.mjs",
      Array.isArray(srv.args) && srv.args[0] === "${ZCODE_PLUGIN_ROOT}/dist/server.mjs");
    check("server.env.ZCODE_WORKSPACE_ROOT=${ZCODE_PROJECT_DIR}",
      srv.env?.ZCODE_WORKSPACE_ROOT === "${ZCODE_PROJECT_DIR}");
  }

  const s = m.ui?.surfaces?.[0];
  check("ui.surfaces[0] 存在", !!s);
  if (s) {
    check("surface.id=mattskills", s.id === "mattskills", s.id);
    check("surface.title 双语 zh-CN", s.title?.["zh-CN"] === "MattSkills");
    check("surface.title 双语 en-US", s.title?.["en-US"] === "MattSkills");
    check("surface.icon=square-kanban", s.icon === "square-kanban", s.icon);
    check("surface.server=mattskills", s.server === "mattskills", s.server);
    check(`surface.resourceUri=${PANEL_URI}(首段为插件名,同 kicad/designcraft 约定)`,
      s.resourceUri === PANEL_URI, s.resourceUri);
    check("surface.availability=session", s.availability === "session", s.availability);
  }
}

// --- 3. marketplace.json 本地市场清单 ---
const mkPath = join(ROOT, "marketplace.json");
check("marketplace.json 存在", existsSync(mkPath));
if (existsSync(mkPath)) {
  const mk = require(mkPath);
  check("marketplace.name=dev-mattpocock-skills-deck", mk.name === "dev-mattpocock-skills-deck", mk.name);
  const p = mk.plugins?.[0];
  check("marketplace.plugins[0].name=插件名", p?.name === PLUGIN_NAME, p?.name);
  check("marketplace.plugins[0].source 指向插件目录自身", p?.source === "./" || p?.source === ".",
    JSON.stringify(p?.source));
}

// --- 4. panel.html 引导态(中文文案,深色,无演示数据) ---
const panelPath = join(ROOT, "dist", "ui", "panel.html");
if (existsSync(panelPath)) {
  const html = readFileSync(panelPath, "utf8");
  check("panel 含中文引导文案", html.includes(GUIDE_TEXT));
  check("panel 指向 setup 技能", html.includes("/setup-matt-pocock-skills"));
  check("panel 指向 to-tickets 技能", html.includes("/to-tickets"));
  check("panel 深色背景", /background(-color)?:\s*#0|background(-color)?:\s*#1/.test(html));
  const body = html.replace(/<script[\s\S]*?<\/script>/g, "");
  check("panel 无演示卡片数据", !/TODO-\d|ticket-\d|MS-\d/i.test(body));
} else {
  check("panel.html 可读(供文案断言)", false);
}

// --- 5. server 冒烟:spawn → initialize → tools/list → resources/list → resources/read ---
async function smoke() {
  if (!existsSync(join(ROOT, "dist", "server.mjs"))) return;
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 5000);
  });

  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    check("initialize 应答 serverInfo.name", init.result?.serverInfo?.name === PLUGIN_NAME,
      JSON.stringify(init.result?.serverInfo));
    check("initialize 声明 tools+resources 能力",
      !!init.result?.capabilities?.tools && !!init.result?.capabilities?.resources);
    send({ jsonrpc: "2.0", method: "notifications/initialized" }); // 通知不应答,不挂

    const tools = await rpc("tools/list", {});
    // 工单 02 起工具面不再为空:三个只读工具(骨架期这条断言过"空列表",随工具面落地演进)。
    const toolNames = (tools.result?.tools || []).map((t) => t.name);
    check("tools/list 声明只读工具面(工单 02)",
      ["deck_issue_list", "deck_issue_get", "deck_issue_counts"].every((n) => toolNames.includes(n)),
      JSON.stringify(toolNames));

    const rl = await rpc("resources/list", {});
    const res = rl.result?.resources?.find((r) => r.uri === PANEL_URI);
    check("resources/list 含 panel 资源", !!res, JSON.stringify(rl.result));
    check("panel 资源 mimeType=text/html;profile=mcp-app",
      res?.mimeType === "text/html;profile=mcp-app", res?.mimeType);

    const rr = await rpc("resources/read", { uri: PANEL_URI });
    const text = rr.result?.contents?.[0]?.text ?? "";
    check("resources/read 返回 panel HTML 且含引导文案", text.includes(GUIDE_TEXT));

    const bad = await rpc("resources/read", { uri: "ui://nope/x.html" });
    check("resources/read 未知 URI 报错", bad.error?.code === -32002, JSON.stringify(bad.error));

    child.stdin.end();
    const code = await new Promise((r) => child.on("exit", r));
    check("stdin 结束后进程退出码 0", code === 0, String(code));
  } catch (e) {
    check("server 冒烟无异常", false, e.message);
    child.kill();
  }
}

await smoke();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

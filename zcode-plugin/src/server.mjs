// MattSkills MCP 服务骨架(工单 01):stdio JSON-RPC 握手 + 空 tools/list + panel.html 资源供给。
// 零依赖,按 kicad fallback server 的最小协议形状手写;panel 经 ui:// 资源交宿主加载(同 excalidraw)。
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = "zcode-mattpocock-skills-deck";
const VERSION = "0.1.0";
const PANEL_URI = `ui://${PLUGIN_NAME}/panel.html`;
const PANEL_MIME = "text/html;profile=mcp-app";

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, code, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // 通知无需应答
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: m.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: PLUGIN_NAME, version: VERSION },
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: [] });
    case "resources/list":
      return reply(m.id, {
        resources: [{ uri: PANEL_URI, name: "MattSkills panel", mimeType: PANEL_MIME }],
      });
    case "resources/read": {
      if (m.params?.uri !== PANEL_URI) return fail(m.id, -32002, "resource not found");
      return reply(m.id, {
        contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: readFileSync(join(HERE, "ui", "panel.html"), "utf8") }],
      });
    }
    default:
      return fail(m.id, -32601, `method not found: ${m.method}`);
  }
}).on("close", () => process.exit(0));

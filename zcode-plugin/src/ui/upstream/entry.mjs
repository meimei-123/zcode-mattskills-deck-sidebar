// entry.mjs —— 上游 src/client/index.ts 的骨架裁剪段(工单 U01 tracer,ADR-0002 修订)。
//
// 本文件由 build-upstream.mjs 拼接后进 bundle:
//   - `// ==== <kind>:<name> (spliced by build) ====` 标记处换上游叶子真源
//     (标记名与次序对上游 index.ts 校验,是上游标记序的保序子序列);
//   - apply 头部注入 kernel:ctx(上游 wireCtx 同位);
//   - 标记之间的装配段是本仓自有段(U01 只到面板壳;后续工单往 LEAVES 加叶子、
//     往这里加标记,装配段逐步换成上游 panelAssembly 等真源)。
//
// 方言(上游动态版方言同款):apply 闭包里的 React/styles/timer/h 等自由变量解析到
// 模块作用域 —— 上游由 DSH 宿主提供;本 bundle 用 preact/compat 充当 React(ADR-0002
// 修订),styles 走上游 pkg 产物同款 B2 接缝 shim。
import * as PreactCompat from "preact/compat";
import { createSeamCtx, SEAM_SERVICE_IDS } from "./seam.mjs";

const React = PreactCompat;
const styles = {
  // 上游 B2 style 接缝(pkg 方言 shim 同款):插 <style> 进 head,返回撤销器
  insert(css) {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-plugin", "zcode-mattpocock-skills-deck");
    styleEl.textContent = typeof css === "string" ? css : Array.isArray(css) ? css.join("") : String(css);
    document.head.appendChild(styleEl);
    return function () {
      try {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      } catch (e) {
        /* 忽略 */
      }
    };
  },
};

function apply(ctx) {
  const slots = ctx.get("slots");
  if (slots === undefined) return;
  // ==== leaf:hostShim (spliced by build) ====
  // ==== kernel:containerView (spliced by build) ====
  // ==== kernel:motion (spliced by build) ====
  // ==== kernel:styles (spliced by build) ====
  styles.insert(STYLE_TEXT);

  // ---- U01 骨架装配段(本仓自有;后续工单换 leaf:panelAssembly 等上游叶子) ----
  // locale:上游走 localeAdopt(localeData 生成物);骨架只消费 bind 的稳定 tr(退化语义同款)
  const localeSvc = ctx.get("locale");
  const tr =
    localeSvc && typeof localeSvc.bind === "function"
      ? localeSvc.bind("dsws")
      : function (key) {
          return key;
        };
  // Ctx 接线(上游 panelAssembly §5.11 同款,八字段冻结清单)
  const cx = createCx({
    ctx: ctx,
    h: h,
    rdom: null,
    storeSvc: null,
    localeSvc: localeSvc,
    timer: timer,
    api: null,
    router: null,
  });
  const withCx = function (Comp) {
    return function (props) {
      return h(DswsCtx.Provider, { value: cx }, h(Comp, props));
    };
  };
  // 面板壳(空壳 tracer):上游 dsws-panel 浮卡(460px、深色 --dsw-* 令牌回退值、原版
  // 边框阴影圆角),结构对应上游 Dock 的头/页签/正文三段;页签与正文内容由后续工单
  // 按叶子搬入,这里给一行占位说明。
  const DeckShell = function () {
    return h("div", { className: "dsws-panel" }, [
      h("div", { className: "dsws-head" }, [h("span", { className: "dsws-mtitle" }, [tr("panel.title")])]),
      h("div", { className: "dsws-tabs" }),
      h("div", { className: "dsws-body" }, [
        h("div", { className: "dsws-cgroup" }, ["U01 骨架:面板壳已就位,列表与地图由后续工单搬入"]),
      ]),
    ]);
  };
  // 挂载:上游右栏 tab 槽位路径(panelAssembly 的 sidebar.right.pane.tab);seam 把它
  // 渲到 surface 根(上游由宿主画进右栏,ZCode 里 surface 根就是我们的右栏等价物)
  slots.inject("sidebar.right.pane.tab", function () {
    return slots.register({ name: "sidebar.right.pane.tab", key: "zcode-mattpocock-skills-deck/deck:map" }, withCx(DeckShell));
  });
}

// ---------------------------------------------------------------------------
// 引导(本仓自有段):panel.html 内联脚本注入本 bundle 后调 boot —— 复用同一条桥,
// 协议仍是握手两拍(panel.html 侧已定),这里只拿现成 client。
// ---------------------------------------------------------------------------
const WORKSPACE_URI = "ui://zcode-mattpocock-skills-deck/workspace.json";

async function fetchWorkspace(client) {
  if (!client || typeof client.readResource !== "function") return null;
  try {
    const r = await client.readResource(WORKSPACE_URI);
    const t = r && r.contents && r.contents[0] && r.contents[0].text;
    return t ? JSON.parse(t) : null;
  } catch (e) {
    return null; // 拿不到就垫空根(数据面 U02 接)
  }
}

async function boot(deps) {
  const d = deps || {};
  const client = d.client || null;
  const doc = d.doc || (typeof document !== "undefined" ? document : null);
  const workspace = d.workspace || (await fetchWorkspace(client));
  // surface 根:上游面板挂宿主右栏;这里自建根元素承载(seam 把槽位组件渲进去)
  let root = d.root || null;
  if (!root && doc && doc.createElement && doc.body) {
    root = doc.createElement("div");
    root.setAttribute("id", "dsws-surface");
    doc.body.appendChild(root);
  }
  const ctx = createSeamCtx({ client: client, doc: doc, root: root, workspace: workspace });
  apply(ctx);
  return ctx;
}

window.MattSkillsUpstream = {
  apply: apply,
  boot: boot,
  seam: { createSeamCtx: createSeamCtx, SEAM_SERVICE_IDS: SEAM_SERVICE_IDS },
};

// seam.mjs —— ctx 八服务垫片(工单 U01;上游 client 消费的 DSH 宿主服务面,真数据 U02 接)。
// 上游 src/client 的 apply(ctx) 只认 ctx.get/effect/inject 三口;ZCode 页签里没有 DSH 宿主,
// 这里按 ADR-0002 修订垫最小面:timer 全局定时器、locale 静态 zh、slots 注册表 + Preact
// 渲到 surface 根(上游「面板挂宿主右栏」的等价落点)、sidebarRight/sidebarRightTabs/sessions/
// workspaces 桩、uiWorkspace 服务端注入的静态工作区根(panel.html 经 workspace.json 资源拉回)。
// 动作面:sessions.send 走 ui/message 桥(与旧 UI 同一条桥);开新会话 U01 为不可用桩。
import { h, render } from "preact";

export const SEAM_SERVICE_IDS = [
  "timer",
  "locale",
  "slots",
  "sidebarRight",
  "sidebarRightTabs",
  "sessions",
  "workspaces",
  "uiWorkspace",
];

// locale 词表(U02 升级):kernel:locale 的 localeAdopt 会把生成物词表逐门语言 register
// ('dsws', lang, dict) 进来 —— 垫片收下存表,bind('dsws') 返回的 tr 按 zh → en → 键名
// 解析(上游回退语义的垫片版);没注册前退回静态 panel.title(取自 config/copy/panel.yaml)。
const LEGACY_ZH = { "panel.title": "MattSkills" };
const localeNamespaces = {}; // ns → { lang → dict }
function lookup(ns, key, params) {
  const dict = localeNamespaces[ns] || {};
  let s =
    (dict.zh && Object.prototype.hasOwnProperty.call(dict.zh, key) && dict.zh[key]) ||
    (dict.en && Object.prototype.hasOwnProperty.call(dict.en, key) && dict.en[key]) ||
    (Object.prototype.hasOwnProperty.call(LEGACY_ZH, key) ? LEGACY_ZH[key] : key);
  if (params) s = s.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
  return s;
}
function zhTr(key, params) {
  return lookup("dsws", key, params);
}

/**
 * 建 seam ctx。deps: { client(桥,可空), doc, root(surface 根,可空), workspace({root,env}|null) }。
 * 返回上游形状的 ctx:get(name) → 服务或 undefined;effect(fn,label) 收卸载器;
 * inject(names,fn) 依赖齐了才调(最小语义,够骨架装配用)。
 */
export function createSeamCtx({ client = null, doc = null, root = null, workspace = null } = {}) {
  const documentRef = doc || (typeof document !== "undefined" ? document : null);
  const disposers = [];

  // slots:注册表 + 渲到 surface 根。每个注册画进自己的容器 div;真 DOM 不可用
  //(测试桩)时只记录不挂载 —— 上游组件拿到注册事实,挂载是宿主的事,这里同语义。
  const registrations = [];
  const slotsSvc = {
    inject(slotName, factory) {
      const disp = factory(); // 上游 __injectOnce 语义:工厂抛错暴露给调用方,不吞
      return function () {
        try {
          if (typeof disp === "function") disp();
        } catch (e) {
          /* 忽略 */
        }
      };
    },
    register(def, Component) {
      const rec = { def: def || {}, Component };
      registrations.push(rec);
      mount(rec);
      return function () {
        const i = registrations.indexOf(rec);
        if (i >= 0) registrations.splice(i, 1);
        try {
          if (rec.container && rec.container.remove) rec.container.remove();
        } catch (e) {
          /* 忽略 */
        }
      };
    },
    /** 注册表快照(自检口,测试与 U02 接线用)。 */
    registered() {
      return registrations.slice();
    },
  };
  function mount(rec) {
    if (!documentRef || !root || typeof root.insertBefore !== "function") return; // 假 DOM 只记录
    try {
      const box = documentRef.createElement("div");
      root.appendChild(box);
      rec.container = box;
      render(h(rec.Component), box);
    } catch (e) {
      // 挂载失败不吞注册事实:壳注册了,渲染问题留给调用方看见
      if (typeof console !== "undefined" && console.warn) console.warn("[seam] 槽位挂载失败:", e);
    }
  }

  const services = {
    timer: {
      timeout(fn, ms) {
        return setTimeout(fn, ms);
      },
      setTimeout(fn, ms) {
        return this.timeout(fn, ms);
      },
      interval(fn, ms) {
        return setInterval(fn, ms);
      },
      clearTimeout(id) {
        clearTimeout(id);
      },
    },
    locale: {
      // 上游 localeAdopt 按 LANG_CONFIG 清单逐门 addLanguage + register('dsws', lang, dict):
      // 垫片收下词表存表,bind 返回稳定 tr(调用时按 zh→en→键名解析)。
      getSnapshot() {
        return { active: "zh-CN", locales: [{ id: "zh", fallback: "" }, { id: "en", fallback: "zh" }] };
      },
      register(ns, locale, dict) {
        if (!localeNamespaces[ns]) localeNamespaces[ns] = {};
        localeNamespaces[ns][locale] = dict || {};
        return function () {
          try {
            delete localeNamespaces[ns][locale];
          } catch (e) {
            /* 忽略 */
          }
        };
      },
      addLanguage() {
        return function () {}; // 垫片:语言都在表内,收到登记即回卸载器
      },
      bind() {
        return zhTr;
      },
    },
    slots: slotsSvc,
    sidebarRight: {
      available() {
        return false; // U01 桩:右栏落点由 slots 渲染承担,U02 再对齐宿主形态
      },
    },
    sidebarRightTabs: {
      register() {
        return function () {}; // U01 桩:收下登记即回卸载器
      },
    },
    sessions: {
      current() {
        return null;
      },
      list() {
        return [];
      },
      send(text) {
        if (client && typeof client.sendMessage === "function") return client.sendMessage(text);
        return Promise.reject(new Error("seam: 无 client 桥,sessions.send 不可用"));
      },
      openNew() {
        return Promise.resolve({ ok: false, reason: "ZCode 宿主暂不支持开新会话(U01 桩)" });
      },
    },
    workspaces: {
      list() {
        return []; // U02 接真数据
      },
    },
    uiWorkspace: workspace || { root: null, env: {} },
  };

  const ctx = {
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined;
    },
    effect(fn, label) {
      try {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
      } catch (e) {
        if (typeof console !== "undefined" && console.warn) console.warn("[seam] effect 失败(" + label + "):", e);
      }
    },
    inject(names, fn) {
      if (names.every((n) => ctx.get(n) !== undefined)) fn();
      else if (typeof console !== "undefined" && console.warn)
        console.warn("[seam] ctx.inject 依赖缺失:", names.join(","));
    },
    dispose() {
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch (e) {
          /* 忽略 */
        }
      }
    },
  };
  return ctx;
}

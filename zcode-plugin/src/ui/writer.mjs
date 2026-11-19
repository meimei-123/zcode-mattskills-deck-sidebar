// MattSkills 详情写入口(工单 06):评论输入框 + 状态按钮(最小集:关闭/重开)。
// 纯脚本无 import,与 app.js/detail.mjs 由 build.mjs 拼进同一 bundle;detail.open 经
// window.MattSkillsWriter.mount 挂进来(独立段,方便与其他详情增强并行)。
// 全部写经桥调 MCP 写工具(deck_issue_comment/close/reopen),key 用 get 同口径的
// 目录前缀寻址;成功后调 window.MattSkillsPanel.refresh()(T08 强刷钩子)并回调
// onWritten() 让详情重拉;失败把服务端人话错误原样上屏,输入不丢。
"use strict";
(function () {
  var COPY = {
    closeBtn: "关闭卡",
    reopenBtn: "重开卡",
    placeholder: "写评论…(提交即落盘到卡片文件)",
    send: "提交评论",
    sending: "写入中…",
    done: "已写入",
    emptyBody: "先写点内容再提交。",
  };

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function textOf(res) {
    if (res && Array.isArray(res.content)) {
      for (var c of res.content) if (c && c.type === "text" && c.text) return c.text;
    }
    return "";
  }

  /**
   * 挂载写入口。
   * opts = { doc, host, client, getKey()→string, getCard()→card, onWritten() }
   * 返回 { render }:详情重拿到新卡后调 render(),按钮随状态翻转;输入框内容跨 render 保留。
   */
  function mount(opts) {
    var doc = opts.doc;
    var host = opts.host;
    var client = opts.client;
    var busy = false;
    var draft = ""; // 输入框草稿:写失败/重渲染不丢
    var hint = el(doc, "div", "ms-write-hint");
    var body = el(doc, "div", "ms-writer-body");
    host.append(hint, body);
    var ta = null;

    function show(text, kind) {
      hint.textContent = String(text || "");
      hint.className = "ms-write-hint" + (kind ? " is-" + kind : "");
    }

    function call(tool, args) {
      if (busy) return;
      busy = true;
      show(COPY.sending, "");
      client.callTool(tool, args).then(
        function (res) {
          busy = false;
          if (res && res.isError) return show(textOf(res) || "写入失败", "err");
          show(COPY.done, "ok");
          draft = ""; // 成功才清草稿;输入框即刻清空(不等重渲染——render 会从 value 回收草稿)
          if (ta) ta.value = "";
          if (typeof window.MattSkillsPanel === "object" && window.MattSkillsPanel && typeof window.MattSkillsPanel.refresh === "function") {
            window.MattSkillsPanel.refresh(); // 强刷钩子:列表缓存立即跟上(revision 已由写路径推进)
          }
          if (typeof opts.onWritten === "function") opts.onWritten(); // 详情重拉:时间线/元行/按钮翻新
        },
        function (err) {
          busy = false;
          show((err && err.message) || String(err), "err");
        }
      );
    }

    function doComment() {
      var text = String((ta && ta.value) || "").trim();
      if (!text) return show(COPY.emptyBody, "err");
      draft = text;
      call("deck_issue_comment", { key: opts.getKey(), body: text });
    }

    function doState(card) {
      var closed = card.state === "closed";
      call(closed ? "deck_issue_reopen" : "deck_issue_close", { key: opts.getKey() });
    }

    function render() {
      var card = opts.getCard();
      if (ta) draft = String(ta.value || ""); // 重渲染前收草稿
      body.replaceChildren();
      ta = null;
      if (!card || card.type === "map" || card.type === "spec") return; // 容器(规格/地图)不给写
      var closed = card.state === "closed";
      var row = el(doc, "div", "ms-cmd-row");
      var btn = el(doc, "button", "ms-cmd-btn" + (closed ? "" : " ms-cmd-close"), closed ? COPY.reopenBtn : COPY.closeBtn);
      btn.setAttribute("type", "button");
      btn.setAttribute("data-act", closed ? "reopen" : "close");
      btn.addEventListener("click", function () {
        doState(opts.getCard());
      });
      row.append(btn);
      body.append(row);

      var box = el(doc, "div", "ms-composer");
      ta = el(doc, "textarea", "ms-cmt-input");
      ta.setAttribute("placeholder", COPY.placeholder);
      ta.setAttribute("rows", "2");
      if (draft) ta.value = draft;
      var send = el(doc, "button", "ms-cmt-send", COPY.send);
      send.setAttribute("type", "button");
      send.addEventListener("click", doComment);
      box.append(ta, send);
      body.append(box);
    }

    render();
    return { render: render };
  }

  window.MattSkillsWriter = { mount: mount };
})();

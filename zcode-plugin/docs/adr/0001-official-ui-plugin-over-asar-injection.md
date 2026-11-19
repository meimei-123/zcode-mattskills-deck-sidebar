# 用官方 UI Plugin(ui.surfaces),不用 app.asar 注入

需要"侧边栏 MattSkills 页签 + Web UI"。ZCode 3.18.2 已内置官方 UI Plugin 机制(manifest `ui.surfaces` + `ui://` 页面 + ext-apps 桥),而参考项目 Lzyuuu 版靠改写 app.asar 注入 renderer。选官方机制:零补丁、升级免疫,动作按钮走 `sendMessage` 官方通路。代价是官方插件无法在聊天输入框上方注入胶囊状态行——该功能后置,届时再参考 Lzyuuu 的注入方案单独实现,与本插件的边界不变。

## Considered Options

- 官方 UI Plugin(选定)
- app.asar 注入真页签 / 借内置浏览器开本地 Web UI / 主进程 WebContentsView 自建面板(三者皆弃)

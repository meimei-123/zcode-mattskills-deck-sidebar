# zcode-mattskills-deck-sidebar

MattSkills Deck(DSH)在 ZCode 桌面端的侧栏移植:官方 UI Plugin(`ui.surfaces` + 同进程 MCP stdio server),右侧边栏 "MattSkills" 页签读写工作区 `.scratch/` 工单,agent 与人共用同一块数据。只移植侧边栏形态,上游对话框上的功能栏未引入。

## 仓库结构

本仓是 fork 形态:根目录除 `zcode-plugin/` 外,其余即上游 1.9.0-beta.33 快照——它是插件的构建期真源(`build-upstream.mjs` 从 `src/client/` splice 客户端骨架),运行时不需要它。

- 插件本体:[`zcode-plugin/`](./zcode-plugin/),安装、构建与架构见 [`zcode-plugin/README.md`](./zcode-plugin/README.md)

## 分支

- `main`:上游快照入库(轻量,排除 assets/video 与 docs/prototype)
- `zcode-plugin`:插件开发与发布分支(当前 0.5.0,本分支即默认分支)

## 归属与许可

MIT。上游:[FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)。上游设计语言/数据契约/prompt 模板的引用边界见 [`zcode-plugin/NOTICE.md`](./zcode-plugin/NOTICE.md) 与 [`zcode-plugin/docs/adr/0002-hybrid-port-boundary.md`](./zcode-plugin/docs/adr/0002-hybrid-port-boundary.md)。

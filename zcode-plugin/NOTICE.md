# NOTICE

本插件(zcode-mattpocock-skills-deck)是 [FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)(MIT License,Copyright (c) 2026 王辰浩)在 ZCode 桌面端的移植与扩展,并参考了 [Lzyuuu/zcode-mattpocock-skills-deck](https://github.com/Lzyuuu/zcode-mattpocock-skills-deck)(MIT)的移植经验。

## 归属

- **上游 DSH deck**(王辰浩/FeatherHunter,MIT):设计语言(PixelCards 色表/卡面对比度规则)、数据契约(实体/操作目录/规范标签)、prompt 模板(`{{shared:*}}` 小节与九个动作模板)、状态/计数/折叠口径、GitHub 房间(议题读写与变更探测)。GitHub 房间的代码整体取自上游:构建期从上游只读树克隆进 `dist/github-room.mjs`,不 vendor 源码,运行时也不依赖上游树。移植范围与边界见 `docs/adr/0002` 与 `docs/adr/0004`。
- **Lzyuuu 移植**(MIT):`ui.surfaces` 官方方案之外的注入式胶囊行留作后续阶段参考,本插件当前代码不包含其内容。
- **本插件新增**:ext-apps 桥适配、MCP 服务端(本地 Markdown 与 GitHub 议题两套后端的装配与分发)、面板壳与缝 2 测试架、文案表与文档。

## 许可

MIT。上游与本插件代码均按 MIT 分发;上游完整许可见父仓库 `LICENSE`(Copyright (c) 2026 王辰浩)。

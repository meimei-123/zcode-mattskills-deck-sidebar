# zcode-plugin(MattSkills for ZCode)

上游 DSH deck(FeatherHunter/dsh-mattpocock-skills-deck 1.9.0-beta.33)在 ZCode 上的移植:官方 UI Plugin 形态的任务看板,agent 与人共用同一块 `.scratch/` 数据。

## Language

**Surface(页签)**:
插件 manifest `ui.surfaces` 声明的会话侧边栏面板,即 "MattSkills" 页签本体,页面经 `ui://` 协议加载。
_Avoid_: 标签页组件、panel、注入式页签

**卡片(Card)**:
`.scratch/` 下一条工单/地图/规格所对应的 markdown 文件,看板的最小展示单元。
_Avoid_: 工单文件、ticket file、条目

**DeckState**:
MCP 服务从 `.scratch/` 解析出的看板状态投影,页签与 agent 工具消费同一形状。
_Avoid_: 面板数据、store

**PixelCards**:
上游的卡片视觉语言(动作色卡、戳、标签、图钉、对比度规则),本项目按 a′ 边界移植。
_Avoid_: 卡片组件库、UI kit

**ext-apps 桥**:
页签页面与插件 MCP 服务通信的官方协议桥(`@modelcontextprotocol/ext-apps`,callTool/sendMessage 等)。
_Avoid_: postMessage 通道、注入桥

**宿主接缝(hostShim)**:
上游 client kernel 中绑定 DSH 宿主的胶水层(hostShim/portal/slots/api-\*),移植时整体替换为 ext-apps 适配器,不搬代码。
_Avoid_: 宿主胶水(口语可用,文档用规范词)

**动作(Deck Action)**:
卡片按钮触发、经 ext-apps 桥 `sendMessage` 发进对话的 prompt(领取/修复/诊断/实施等),上游动作色表与之对应。
_Avoid_: 注入 prompt(prompt injection 指旧机制)、快捷指令

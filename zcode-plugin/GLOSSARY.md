# zcode-plugin(MattSkills for ZCode)

上游 DSH deck(FeatherHunter/dsh-mattpocock-skills-deck 1.9.0-beta.33)在 ZCode 上的移植:官方 UI Plugin 形态的任务看板,agent 与人共用同一块 `.scratch/` 数据。

## Language

**Surface(页签)**:
插件 manifest `ui.surfaces` 声明的会话侧边栏页签,即 "MattSkills" 页签本体;面板(Panel)经 `ui://` 协议加载进它。
_Avoid_: 标签页组件、面板(指 Surface 时)、注入式页签

**面板(Panel)**:
Surface 加载的 `ui://` Web UI 文档(panel.html 与 bundle),看板界面的实现件;Surface(页签)是产品概念,两者不混用。标识符(`panel.*` 键、panel.html 文件名)沿用不改;旧面板全局 `window.MattSkillsPanel` 已随 ms-* 层退役(U06)。
_Avoid_: 用面板指页签/Surface

**卡片(Card)**:
`.scratch/` 下一条工单/地图/规格所对应的 markdown 文件,看板的最小展示单元。
_Avoid_: 工单文件、ticket file、条目

**票(工单)**:
`.scratch/` 里的工作单元(ticket/map/spec 三型之一;口语泛指全部卡片),卡片(Card)是它的看板/文件呈现。指文件时说「卡片文件」,不写「票文件」。
_Avoid_: 票文件(指文件时用卡片文件)、票据

**工作区根(Workspace root)**:
宿主经 `ZCODE_WORKSPACE_ROOT` 注入的目录,即 home-repo 的路径;插件启动时据此定位项目清单。不是「活动项目」。
_Avoid_: 工作区(指活动项目时)

**项目根(Project root)**:
一个拥有自己 `.scratch/` 看板的目录;看板数据、版本管理、环境检查都以它为界。home-repo 是其中一员。
_Avoid_: 项目(泛指时)、代码仓(指项目根时)

**home-repo(会话根项目)**:
会话打开时所在目录对应的项目根。项目清单的第一项,隐式存在、不可删除,名字默认取目录名。
_Avoid_: 主仓、根仓、本仓(指会话根时)

**项目清单(Project registry)**:
会话根 `.deck/projects.json` 里逐项声明的项目根集合。切换的唯一来源,也是路径的信任边界;缺省或为空时只有 home-repo。
_Avoid_: 项目列表(口语可用)、配置(泛指时)

**活动项目(Active project)**:
当前被选中的项目根。列表、版本管理、环境检查三页都读它;默认是 home-repo,选择只存在当前会话的 MCP 服务进程里。
_Avoid_: 当前仓库、工作区(指活动项目时)

**DeckState**:
MCP 服务从 `.scratch/` 解析出的看板状态投影,面板与 agent 工具消费同一形状。
_Avoid_: 面板数据、store

**PixelCards**:
上游的卡片视觉语言(动作色卡、戳、标签、图钉、对比度规则),本项目按 a′ 边界移植。
_Avoid_: 卡片组件库、UI kit

**ext-apps 桥**:
面板与插件 MCP 服务通信的官方协议桥(`@modelcontextprotocol/ext-apps`,callTool/sendMessage 等)。
_Avoid_: postMessage 通道、注入桥

**宿主接缝(hostShim)**:
上游 client kernel 中绑定 DSH 宿主的胶水层(hostShim/portal/slots/api-\*),移植时整体替换为 ext-apps 适配器,不搬代码。
_Avoid_: 宿主胶水(口语可用,文档用规范词)

**动作(Deck Action)**:
卡片按钮触发、经 ext-apps 桥 `sendMessage` 发进对话的 prompt(领取/修复/诊断/实施等),上游动作色表与之对应。
_Avoid_: 注入 prompt(prompt injection 指旧机制)、快捷指令

**版本管理页签(Version Control Tab)**:
面板的第四枚页签(`versionControl`),内含改动/提交历史/工作树三视图与分支、标签、贮藏、改写等能力页;整族从上游 vc 克隆,UI 叶进 bundle-1,宿主取数打成 `dist/git.mjs`。
_Avoid_: 版本控制页、Git 页签、VC 面板(指页签时)

**地图详情页(Map Detail V2)**:
列表里点开地图/规格容器后进的那一页(`MapDetailV2Page`):档案区(标题/目的地/进度/子票计数)+ 子票卡片流(在办/可接/被挡/已完成)。子票全集经 `wf.mapTickets` → `deck_map_tickets` 按需取回;点档案进这张图自己的 IssueDetail。老页 `MapDetail` 三叶随上游保留但产品不挂。
_Avoid_: 容器页、地图面板(与侧栏面板混指)、子票页

**电话(Phone)**:
上游 vc 家族对宿主能力的调用名(`wf.gitStatus`、`wf.gitDiff` 等);本仓经 `deck_git({method,args})` 一条工具路由,方法名取 `handleGit*` 的驼峰后缀。不是网络电话。
_Avoid_: API 调用、宿主方法(泛指时)

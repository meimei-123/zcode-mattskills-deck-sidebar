# zcode-mattskills-deck-sidebar

MattSkills Deck(DSH)在 ZCode 桌面端的侧栏移植:官方 UI Plugin(`ui.surfaces` + 同进程 MCP stdio server),右侧边栏 "MattSkills" 页签读写工作区 `.scratch/` 工单,agent 与人共用同一块数据。只移植侧边栏形态,上游对话框上的功能栏未引入。

## 插件是怎么搭起来的

ZCode 的官方 UI Plugin 只要求两样东西:一枚页签声明,一个服务进程。本插件的全部本体在 [`zcode-plugin/`](./zcode-plugin/),安装与架构细节见 [`zcode-plugin/README.md`](./zcode-plugin/README.md)。

```text
.zcode-plugin/plugin.json
  ui.surfaces  → "MattSkills" 页签(resourceUri ui://…/panel.html,挂 mattskills 服务)
  mcpServers   → node dist/server.mjs(stdio,cwd=工作区根)

zcode-plugin/
├── dist/                        # 构建产物入库,装包即用,运行时零依赖
│   ├── server.mjs               # MCP 服务端:deck_* 工具族(读卡/写卡/技能/检查/地图/项目/git)
│   ├── git.mjs                  # 上游 vc 核心+宿主文件打包(esbuild,~1MB)
│   └── ui/
│       ├── panel.html           # ext-apps 客户端骨架:握手两拍 + 资源通道
│       ├── bundle-1.txt         # 上游 client 本体 splice 产物(单作用域 IIFE)
│       └── assets.json
├── src/                         # 本仓真源:服务端、桥适配、构建胶水
│   ├── server.mjs / cards.mjs / write.mjs / watch.mjs
│   ├── skill-roots.mjs          # 技能根单一真源(工作区→用户→插件内置)
│   └── git-entry.mjs            # Node 六服务垫片(subprocess/timer/fs/gate/logCtx/平台)
├── build.mjs / build-upstream.mjs / build-git.mjs   # 三段构建,见下
└── test/                        # 25 套 2266 断言(0.6.0)
```

运行时一条数据流:

```mermaid
sequenceDiagram
    participant U as 用户(与会话里的 agent 同座)
    participant P as 侧栏面板(上游 client 叶子)
    participant B as 桥(panel.html 内)
    participant S as MCP 服务(dist/server.mjs)
    participant D as 磁盘 .scratch/
    U->>P: 点票 / 筛选 / 动作
    P->>B: host.call('wf.issueDetail')
    B->>S: callTool('deck_issue_get')
    S->>D: 读 / 写卡片 markdown
    D-->>S: 文件变更(watch,revision 推进)
    S-->>P: 面板重取,看板更新
    P->>U: 动作类操作经 ui/message 发进当前对话
```

## 上游是怎么搬进来的:字面搬运纪律

对上游 client 不重写、不裁剪,按它的拼接构建约定原样搬——上游演化时,标记序对账测试先报警:

```text
build-upstream.mjs(机制仿上游 scripts/build.mts)
  读上游 src/client/index.ts 的标记 // ==== leaf:xxx (spliced by build) ====
    (标记次序 = 声明次序)
  每个叶子 .ts → esbuild 转译 → 剥行首 export
  按标记序拼进本仓骨架的同名标记处 → 单作用域 IIFE(裸名共享)
  约束:骨架标记必须是上游标记序的保序子序列(const 暂时性死区防护,测试锁死)
  Preact(+compat) 顶替宿主 React;ctx 八服务走 Node 垫片
产物 dist/ui/bundle-1.txt —— 运行时不依赖上游树
```

版本管理页(0.4.0)同理:`build-git.mjs` 把上游 vc 家族的核心与宿主文件读图打包成 `dist/git.mjs`,客户端 `host.call('wf.gitX')` 全部映射到一条 `deck_git` 工具(60 余条电话)。

对上游的有意偏离只有两处半,均记录在 [ADR-0002](./zcode-plugin/docs/adr/0002-hybrid-port-boundary.md):`deck_git` 的路径边界(工作区根内)、`withGhLane` 直通垫片;0.6.0 的头部项目 chip 是唯一面板分叉(ADR-0003)。

## 一步步走过来

每个版本对应 `.scratch/` 里的一份规格(本仓工单纪律:spec → 工单 → 实施 → 收口):

| 版本 | 规格 | 搬了什么 |
|---|---|---|
| 0.1.x | (M1) | 官方页签 + stdio MCP + 手搓看板,先把壳和数据面立起来 |
| 0.3.0 | ui-fidelity U01–U06 | 换成 1:1 复刻:splice 构建 + ctx 垫片 + Preact,删旧手搓层 |
| 0.3.1 | m2-pages | 技能页签(真读本机技能目录)、环境检查页签(本地真实事实组链)、响应式宽度通道 |
| 0.3.2 | m2-pages/05 | 真机反馈修订:撤内容级宽度上限,宽侧铺满 |
| 0.4.0 | m3-version-control | 上游 vc 家族整体克隆:69 UI 叶 + 核心/宿主打包,`deck_git` 一条工具路由 |
| 0.5.0 | m4-map-detail | 地图详情页:mapV2 十三叶 + `deck_map_tickets` |
| 0.6.0 | m5-project-switch | `.deck/projects.json` 项目清单 + 活动项目切换,列表/版本/检查三页跟随 |

共同纪律:每版测试先行(外部可观察行为,不测实现细节)、版本双清单同步递增(装机靠版本号,热改缓存会被 ZCode 重启回滚)、市场源零构建垃圾。

## 分支

- `main`:上游快照入库(轻量,排除 assets/video 与 docs/prototype)——它是构建期真源,运行时不需要
- `zcode-plugin`:插件开发与发布分支(当前 0.6.0,默认分支)

## 归属与许可

MIT。上游:[FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)。上游设计语言/数据契约/prompt 模板的引用边界见 [`zcode-plugin/NOTICE.md`](./zcode-plugin/NOTICE.md) 与 [`zcode-plugin/docs/adr/0002-hybrid-port-boundary.md`](./zcode-plugin/docs/adr/0002-hybrid-port-boundary.md)。

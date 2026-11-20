# M1 手工冒烟清单

装好插件(见 README)后按序走一遍。✓ = 预期;自动化已覆盖的步骤注明测试出处。
(U06 收口:旧 ms-* UI 层与「切换上游面板壳」逃生舱已退役,面板即上游复刻唯一面,
原共存期第 11/12 步并入第 2 步;自动化缝名随测试收口换成 upstream-*。)

| # | 操作 | 预期 | 自动化 |
|---|---|---|---|
| 1 | 安装插件并启用,开新会话 | 侧边栏出现 MattSkills 页签(方形看板图标) | **待人工(真机)** |
| 2 | 打开页签 | 上游复刻看板带数据起(460px 深色壳,列表/计数/筛选);无 `.scratch/` 时显示中文引导态(指向 /setup-matt-pocock-skills 与 /to-tickets) | upstream-skeleton(壳+样式链+引导流量)、upstream-list 覆盖;快照原型实测见下 |
| 3 | 对 agent 说"用 /to-tickets 在 m1-core-board 下建几张测试卡" | agent 调 `deck_issue_create`,卡片落盘 `.scratch/m1-core-board/issues/` | server-write 覆盖 |
| 4 | 看板(不刷新面板) | 防抖后自动出现新卡;计数胶囊条变 | live-refresh 覆盖 |
| 5 | 点开一张卡 | 详情:元行/正文/评论时间线;长文折叠可展开 | upstream-detail 覆盖 |
| 6 | 详情里写评论并提交 | "已写入"反馈;时间线追加 `### 谁 — ISO时间` 块;文件尾追加、正文未动 | upstream-detail 评论提交回环 + server-write 覆盖 |
| 7 | 点动作按钮(如"诊断") | 对话框收到 prompt(首行命令+卡号/标题/路径,模板已展开) | upstream-detail 动作发话覆盖 |
| 8 | agent 改卡片状态(或面板关闭卡) | 列表状态色/计数变;关闭后动作栏置灰;重开恢复 | server-write + upstream-detail 门禁三态覆盖 |
| 9 | 筛选 chips(状态/排序/标签) | 列表按选择过滤;记忆点击;无匹配出空态 | upstream-list 覆盖(筛选交互改变行集) |
| 10 | 删除 `.scratch/` 整个目录 | 面板回引导态不崩;重建后自动跟上 | live-refresh reconnect 覆盖 |

## 未自动化、需真机确认

- 页签真实形态(图标/标题/开合)与主题融合:看板深色与 ZCode 深色是否协调。**待人工**
- `ui/message` 在真机宿主的能力声明(`hostCapabilities.message`):若不支持,动作按钮应显示发送失败并可重试(失败路径有测试)。**待人工**
- 真机切工作区后看板数据源跟随。**待人工**
- (可选)双击 `prototype/m1-ui-preview.html` 对照快照原型(U06 已随新 UI 重生成);差异以真机为准——原型是一次性快照,不随代码日常更新。**待人工**

## 自动化实测记录(U06 复走,2026-11-20,离线)

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs`(src→dist + build-upstream 拼包) | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html(1350296 字节;旧 bundle-0/panel.css 已退役) |
| 测试 | `npm test` | ✓ 九套 856 断言全绿(scaffold 51 / server-read 79 / server-write 98 / live-refresh 17 / upstream-skeleton 66 / upstream-kernel 113 / upstream-cards 171 / upstream-list 172 / upstream-detail 89) |
| 本地服务 | dist/server.mjs stdio 冒烟(spawn → initialize → tools/list → resources/list/read)+ 引导流量(stub 宿主逐字执行 panel.html) | ✓ 工具面四读+六写声明齐;资产白名单只供 bundle-1(读 bundle-0 报 resource not found);握手两拍序:ui/initialize → initialized(紧随)→ resources/read;上游壳真实调用 deck_issue_list / counts |
| 工具面 | stdio 会话对临时工作区跑 建卡→列表→评论→状态改→关闭→重开→复核 | ✓(见下表) |

工具面逐步输出(节选,revision 2→6):

| 清单步 | 调用 | 实际输出(节选) |
|---|---|---|
| 3 建卡 | `deck_issue_create`(u06-smoke/冒烟测试卡,labels=[needs-triage]) | ok,revision=2,key=u06-smoke/01 |
| 4 列表 | `deck_issue_list` / `deck_issue_counts` | 共 1 张卡(open 1 · closed 0),revision=2 |
| 6 评论 | `deck_issue_comment`(body=冒烟:U06 收口复走评论。) | ok,revision=3,时间线追加 `### smoke — 2026-11-20T08:48:23.673Z` |
| 8 状态改 | `deck_issue_update`(status=in-progress) | ok,revision=4,状态行 → in-progress |
| 8 关闭 | `deck_issue_close`(reason=冒烟关闭) | ok,revision=5,状态行 → closed,原因记为一条评论(smoke) |
| 8 重开 | `deck_issue_reopen` | ok,revision=6,状态行 → ready-for-agent |
| (复核) | `deck_issue_list` | 共 1 张卡(open 1 · closed 0),commentCount=2,revision=6 |

## 上游面板壳快照实测(U01,2026-11-20,本地浏览器)

把 `dist/ui/bundle-1.txt` 内联进临时原型页(桩桥供 workspace.json),真实浏览器里 boot 后用计算样式实测,与上游 `kernel/styles.ts` 的 `.dsws-panel` 逐项对照:

| 判据 | 实测 | 上游真源 |
|---|---|---|
| 宽度 | `width: 460px` | `.dsws-panel{…width:460px…}` |
| 形态 | `position: fixed; left: 16px; top: 76px` | 同左 |
| 底色 | `rgb(22,24,29)` = #16181d | `--dsw-alias-bg-layer-2` 回退值 #16181d(宿主无该变量,回退生效) |
| 边框 | `rgb(42,45,53)` = #2a2d35 | `--dsw-alias-border-l1` 回退值 |
| 圆角/阴影 | `12px` / `0 8px 40px rgba(0,0,0,.45)` | 原版 `border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.45)` |
| 文字 | `rgb(230,237,243)` = #e6edf3 | `--dsw-alias-label-primary` 回退值 |
| 结构 | head(标题 MattSkills)/tabs/body 三段齐;STYLE_TEXT 落入 styleSheets | 上游 Dock 三段 + `styles.insert(STYLE_TEXT)` |

## 快照原型实测(U06,2026-11-20,无头 Edge)

`prototype/m1-ui-preview.html`(U06 重生成,内嵌 bundle-1 + 录制数据)file:// 直开:
mixed 工作区列表/容器行(地图+规格,执行/新会话按钮)/票行(bug、被阻塞、needs-triage 标签)/
关闭折叠(已关闭 2)/KPI 胶囊(可接 1 · 阻塞 3 · 已关闭 2)带数据真渲,桥日志
(read bundle-1.txt · read workspace.json · call deck_issue_list · …)随引导顺序出现。
截图与对照配对见 `E:\mattskillzcode\prototype\u06-shots\README.md`。

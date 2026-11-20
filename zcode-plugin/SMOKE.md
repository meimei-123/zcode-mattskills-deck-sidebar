# M1 手工冒烟清单

装好插件(见 README)后按序走一遍。✓ = 预期;自动化已覆盖的步骤注明测试出处。
(U06 收口:旧 ms-* UI 层与「切换上游面板壳」逃生舱已退役,面板即上游复刻唯一面,
原共存期第 11/12 步并入第 2 步;自动化缝名随测试收口换成 upstream-*。)

| # | 操作 | 预期 | 自动化 |
|---|---|---|---|
| 1 | 安装插件并启用,开新会话 | 侧边栏出现 MattSkills 页签(方形看板图标) | **待人工(真机)** |
| 2 | 打开页签 | 上游复刻看板带数据起(深色满幅壳,列表/计数/筛选);无 `.scratch/` 时显示中文引导态(指向 /setup-matt-pocock-skills 与 /to-tickets) | upstream-skeleton(壳+样式链+引导流量)、upstream-list 覆盖;快照原型实测见下 |
| 2a | 点「技能」页签 | 技能目录 27 行(名称/摘要/推荐标记);点行开详情,加载中出骨架/文案,正文按 markdown 渲染;读取失败出错误与重试,重试恢复 | upstream-skills 覆盖(目录 27 行 / 详情 markdown / 加载·失败·重试) |
| 2b | 点「环境检查」页签 | 链快照逐项列出状态/标题/原因(N/M 计数与步骤一致);点「重新检查」真实重扫并更新;失败步的修复按钮把提示词发进当前对话;页签打开时每 5 秒自问一次(本仓无宿主事件源),离页即停 | upstream-checks 覆盖(链快照状态/标题/原因、重检真重扫、修复动作发话、5 秒可见拍与离页停止) |
| 2c | 拖动侧边栏从宽到窄再拖回 | 窄档(<380px)行内按钮收成图标、页签按优先级折叠、无横向溢出;拖宽内容随容器铺满(0.3.2 起不设 460 上限);任意宽度互切页签状态不串 | upstream-responsive 覆盖(窄档收字/页签折叠/宽侧铺满/详情顶栏折叠) |
| 2d | 点「版本管理」页签 | 页签行四枚(列表/技能/版本管理/环境检查),版本管理高亮;改动页出当前分支与领先/落后、已暂存/未暂存两分组与文件行;点文件行出差异补丁 | upstream-versioncontrol 覆盖(四枚页签/改动页/文件差异);server-git 覆盖(gitStatus/gitDiff 真仓回包) |
| 2e | 切「提交历史」 | 提交列表(短 oid/标题/作者/时间);点单笔提交出逐文件清单;点清单文件出该提交补丁;翻批(50/批) | upstream-versioncontrol、server-git-history 覆盖(提交列表/单笔/逐文件) |
| 2f | 切「工作树」 | 当前工作树与分支状态;其他工作树列表(无则空态说明) | upstream-versioncontrol、server-git-refs 覆盖(工作树 list/add/remove/prune) |
| 2g | 改一个文件→暂存/取消暂存→提交;再拉取/推送 | 面板操作结果与 `git status`/`git log` 一致;提交前身份与消息预检;网络失败出诚实错误并可重试 | server-git-writes 覆盖(改动/提交/同步;本地 bare 前进落后、坏远端、pre-push 钩子);server-git-admin 覆盖(联网读超时) |
| 2h | 建分支/切分支/删分支/设上游;建标签 | 先预检签票(check)出计划与确认卡,确认后执行(write);过期票拒绝 | server-git-refs 覆盖(分支七 op、标签、过期票) |
| 2i | 贮藏:入栈/查看/应用/弹出/丢弃 | 贮藏条目与恢复点提示;应用/弹出后工作区变化与 git 一致 | server-git-refs 覆盖(贮藏 push/list/apply/pop/drop 与 restore) |
| 2j | 危险动作:重置、历史改写、变基、冲突向导 | 预检签票 + 确认卡 + 恢复点(备份/撤销)后才执行;拒绝过期票;冲突页逐文件处理与继续/中止 | server-git-history 覆盖(改写/变基/冲突/子模块);server-git-admin 覆盖(维护确认与备份要求) |
| 2k | 子模块/维护/迁移/配置钩子/诊断/平台各页 | 按上游能力账本渲染;只读页出数,写页预检签票;缺外部工具/能力时回诚实说明 | server-git-admin 覆盖(维护/迁移/配置钩子/诊断/平台);server-git-history 覆盖(子模块) |
| 2l | 换到另一个工作区再切回 | VC 读数与写状态整体复位:分支/差异/任务面板不串仓 | **待人工(真机)**(跨工作区复位无自动化断言) |
| 2m | 点列表里的地图/规格行 | 进上游 V2 地图详情页:顶栏(返回/面包屑/三态主按钮)、档案区(标题/目的地/进度/「本图 N 张子票（已关闭 C 张）」)、子票卡片流(在办/可接/被挡/已完成,含快照里没有的已关闭子票);点档案进这张图自己的详情页,返回逐级弹回,再返回回列表 | upstream-list(M4 切片:进页/档案/取数/卡片流/档案跳转/返回)、upstream-mapdetail(十三叶与接线)、server-map(电话契约与目的地解析) |
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
- 真机拖拽侧边栏的手感与首帧:拖到窄档时第一帧是否先闪一下宽档布局(宽度通道首帧仍按 460 起量)。**待人工**
- 面板填满侧边栏后,圆角/边框与 ZCode 侧边栏的融合观感(是否像原生的一格,而不是浮在里面的卡片)。**待人工**
- 两个新页签的真机目检(技能目录/文档详情、环境检查链快照):截图备料见 `E:\mattskillzcode\prototype\m2-shots\README.md`,偏差由人工目检裁定。**待人工**
- 版本管理页的真机观感(窄侧栏/宽页签):四枚页签行是否折叠得当,改动/历史/工作树三视图与差异区在窄档是否可读、无横向溢出。截图备料见 `E:\mattskillzcode\prototype\m3-shots\README.md`,偏差由人工目检裁定。**待人工**
- 地图详情页的真机观感:档案区标题/目的地/进度条在窄档是否折行得当;子票卡片流的四段顺序与卡片密度;点档案进 IssueDetail 的面包屑与逐级返回。**待人工**
- 地图详情页在「一张子票都没有」与「取数失败」两态:档案区应显示占位短横与原因截断,不显示假的 0 张;真机断网可试。**待人工**
- 真实远端(https/ssh)的凭据提示与失败话术:自动化只用本地 bare 仓与静默 TCP 冒充;真远端要确认凭据助手提示、超时与失败文案是否诚实。**待人工**
- `git-filter-repo` 等外部工具缺席时的提示:历史改写/维护页应回上游的诚实错误(说明缺什么),不静默失败。**待人工**
- 非 git 工作区的「不是仓库」引导态:协调根 `E:\mattskillzcode` 本身不是 git 仓、插件仓是嵌套仓;真机要在这种工作区确认 VC 页给引导而不是报错。**待人工**
- (可选)双击工作区副本 `E:\mattskillzcode\prototype\m1-ui-preview.html` 对照快照原型(U06 已随新 UI 重生成;源在 ui-preview 分支 `zcode-plugin/prototype/`);差异以真机为准——原型是一次性快照,不随代码日常更新。**待人工**

## 自动化实测记录(0.5.0 收口,2026-11-21,离线)

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs`(src→dist + build-upstream 拼包 + build-git 打包) | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html;bundle-1.txt code.length=2352483(UTF-16 码元),2507726 字节;dist/git.mjs code.length=955015,1021356 字节 |
| 测试 | `npm test` | ✓ 二十套 2015 断言全绿(scaffold 53 / server-read 124 / server-map 25 / server-write 98 / live-refresh 17 / upstream-skeleton 71 / upstream-kernel 113 / upstream-cards 171 / upstream-list 191 / upstream-mapdetail 78 / upstream-detail 90 / upstream-skills 78 / upstream-responsive 76 / upstream-checks 63 / upstream-versioncontrol 306 / server-git 35 / server-git-history 99 / server-git-refs 84 / server-git-admin 137 / server-git-writes 106) |
| 地图数据面 | `deck_map_tickets({key, effortId?})` + `deck_issue_list` 容器行 | ✓ 全部子票(含已关闭/关地图)、统计与上游 phone 同形;同号多图不带 effortId 拒绝;非容器/坏键回 isError;目的地解析忽略围栏与注释示例 |
| 地图渲染面 | upstream-list M4 切片(真 bundle + 真点击) | ✓ 点地图行进 V2 页;档案区标题/目的地/「本图 3 张子票（已关闭 1 张）」;卡片流;取数电话 key=00/effortId=dogfood-test;点档案进 IssueDetail 再逐级返回;返回列表 |
| 版本 | 双清单 + scaffold | ✓ plugin.json / marketplace.json / scaffold 断言均 0.5.0;package.json 保持 0.1.0;panel.html 未动 |

## 自动化实测记录(0.4.0 收口,2026-11-20,离线)

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs`(src→dist + build-upstream 拼包 + build-git 打包) | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html;bundle-1.txt code.length=2298445(UTF-16 码元),2449853 字节;dist/git.mjs code.length=955015,1021356 字节(本次构建日志) |
| 测试 | `npm test` | ✓ 十八套 1896 断言全绿(scaffold 53 / server-read 124 / server-write 98 / live-refresh 17 / upstream-skeleton 71 / upstream-kernel 113 / upstream-cards 171 / upstream-list 176 / upstream-detail 89 / upstream-skills 78 / upstream-responsive 76 / upstream-checks 63 / upstream-versioncontrol 306 / server-git 35 / server-git-history 99 / server-git-refs 84 / server-git-admin 137 / server-git-writes 106) |
| 工具面 | `deck_git({method,args})` | ✓ 66 个 `handleGit*` 方法;未知方法/越界 cwd/坏参数回结构化人话;回包原样进 `structuredContent` |
| 版本 | 双清单 + scaffold | ✓ plugin.json / marketplace.json / scaffold 断言均 0.4.0;package.json 保持 0.1.0;panel.html 未动 |

版本断言按 TDD 先改红(manifest 与 marketplace 两项失败),再改双清单转绿;构建产物可复现(dist 未因版本 bump 变化)。

## 自动化实测记录(0.3.1 收口,2026-11-20,离线)

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs`(src→dist + build-upstream 拼包) | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html(0.3.2 构建日志口径 code.length=1328981(UTF-16 码元);版本占位 `__DSW_VERSION__` 当前没有叶子引用,产物里没有版本串) |
| 测试 | `npm test` | ✓ 十二套 1129 断言全绿(0.3.2;scaffold 53 / server-read 124 / server-write 98 / live-refresh 17 / upstream-skeleton 71 / upstream-kernel 113 / upstream-cards 171 / upstream-list 176 / upstream-detail 89 / upstream-skills 78 / upstream-responsive 76 / upstream-checks 63 —— 响应式套件少 2 条:0.3.2 撤掉 460 上限,三条上限断言换成一条「内容随容器铺满」) |
| 收口断言 | upstream-skeleton + upstream-list 新增 9 条 | ✓ bundle/骨架无「U06+ 搬入」;地图详情层 mapV2 占位仍在;页签分发表 skills→SkillsTab、checks→ChecksTab、pr 无能力回 ListTab(点验 KPI 行与 9 行开票行集) |

## 自动化实测记录(U06 复走,2026-11-20,离线)

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs`(src→dist + build-upstream 拼包) | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html(1350296 字节;删前 1457974,−107678 —— bundle-0 88661 + panel.css 14638 + panel.html 瘦身;旧层 5s 轮询随之消除,双 UI 双份拉数开销归零) |
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

`E:\mattskillzcode\prototype\m1-ui-preview.html`(U06 重生成,内嵌 bundle-1 + 录制数据;源在 ui-preview 分支 `zcode-plugin/prototype/`)file:// 直开:
mixed 工作区列表/容器行(地图+规格,执行/新会话按钮)/票行(bug、被阻塞、needs-triage 标签)/
关闭折叠(已关闭 2)/KPI 胶囊(可接 1 · 阻塞 3 · 已关闭 2)带数据真渲,桥日志
(read bundle-1.txt · read workspace.json · call deck_issue_list · …)随引导顺序出现。
截图与对照配对见 `E:\mattskillzcode\prototype\u06-shots\README.md`。

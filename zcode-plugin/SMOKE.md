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
| 2n | 先不开清单打开面板;再在 home-repo 根放 `.deck/projects.json`(至少一条同机绝对路径 + 一条相对路径,再故意放一条坏条目如指向不存在的目录) | 无清单时头部没有 chip,chip 的位置是「＋ 项目」入口(0.6.1 起;0.6.0 及之前这里什么都没有);有清单时入口消失,头部右侧出现项目 chip,显示活动项目(home-repo);坏条目被跳过,chip 转警告态,展开层附跳过原因,末行是「让 agent 修正清单」 | server-project(清单缺失/坏条目/坏 JSON/相对路径解析)、upstream-chip(入口/三态/warning 行/修正入口)覆盖 |
| 2o | 点 chip 展开,点选另一个项目 | 展开层 home-repo 第一、有效项目可点;切换后 chip 换名并打勾,切换在途禁点;列表/计数/详情来自新项目,home-repo 的卡片文件一字不动;卡片 key 仍是项目内 `effort/NN` | server-project、server-project-writes、upstream-chip(点选切换/整体重取)覆盖 |
| 2p | 切换后走三页:版本管理(改动/历史)、环境检查、再回列表 | 版本管理页回到初始视图并读新仓(分支/改动是新仓的,越界 cwd 被拒);环境检查链按新项目根组(git:repo 反映新根,技能步不变)。切到新项目后改它的卡片,面板最迟约 5 秒自己跟上(0.6.1 起);切回 home-repo 再改 home 的卡片,同样跟上,两个项目的修订号互不干扰 | server-git-project(桥根随活动项目/路径边界)、server-project-writes(监听重挂/切换恰好 +1)、upstream-versioncontrol(切换复位)、upstream-chip(切项目换基准/迟到的旧项目重取不盖新项目)覆盖 |
| 2q | 从新项目卡片点动作按钮(领取/实施/诊断) | 发进对话的 prompt 恰好前置一行「项目:<name>(<项目根>);以下操作都在该项目内进行。」,其后动作模板与上游一致;切回 home-repo 后同一按钮不再带前言 | upstream-inject 覆盖(前置一行/不叠加/逐字放行) |
| 2r | 版本管理页发起危险动作(如重置)只出预检签票、不确认,直接点 chip 切项目 | 切换被拒,人话说明要确认执行或等票据过期(最多 120 秒);确认执行(凭票)或等票据过期后可切;切到当前项目本身不受影响 | server-git-project(哨兵布防/结清/幂等 noop 不挡)覆盖 |
| 2s | 切回 home-repo;再手改清单:删掉或改名当前活动项目条目(先切到它再删),等几个刷新周期 | 切回 home-repo 正常,头部与看板回 home-repo;正在看的项目被移出清单后,面板最迟约 5 秒自动回退 home-repo、看板跟着重取,展开层自动打开并说明原因(不悄悄换项目) | server-project(现读回退)、server-project-writes(同名改路径下一次用新路径)、upstream-chip(回退跟随四种变体)覆盖 |
| 2t | 没有清单的 home-repo(如 dtz-team-repo),点头部「＋ 项目」 | 对话里出现一条请求,首行是 `/setup-home-repo`,带工作区根与清单路径;点完到下一次刷新落定前入口变淡禁点,连点只发一条 | upstream-chip(入口发话全文/在途不叠发/修正入口免项目前言)覆盖 |
| 2u | 接 2t:看 agent 执行 setup-home-repo | 先调 `deck_project_list`;从 `AGENTS.md` 的产品线地图抽出项目指针并逐个核实;给出候选表(建议短名/路径/出处/佐证),文档里没写的项目靠同级目录兜底列出;**停下等确认**;确认后才写 `.deck/projects.json`;最后用 `deck_project_list` 验证到警告为空。默认不改 `AGENTS.md` 与 `.gitignore` | **待人工(真机)**(技能驱动 agent 的行为无法自动化) |
| 2v | 接 2u:清单落盘后不碰面板;之后把清单整份删掉 | 最迟约 5 秒头部冒出项目 chip、入口消失,不用重开会话;清单删掉后 chip 消失、入口回来;清单展开着等几个刷新周期不会自己收起 | upstream-chip(刷新拍/清单出现·被删·损坏三态/展开层不自收)覆盖 |
| 3 | 对 agent 说"用 /to-tickets 在 m1-core-board 下建几张测试卡" | agent 调 `deck_issue_create`,卡片落盘 `.scratch/m1-core-board/issues/` | server-write 覆盖 |
| 4 | 看板(不刷新面板):让 agent 建一张卡、改一张卡的状态;或用外部编辑器直接改卡片文件 | 最迟约 5 秒(一个刷新周期)列表自己跟上:新卡出现、状态色与计数变;用户正开着的详情、筛选、滚动位置都不被打断。把面板切到后台再改卡片,回到前台应立即跟上,不用等下一拍。连续两次改动之间面板不会闪空或跳回顶部 | upstream-chip 列表跟随切片(跟随/修订号不变不重取/保留用户状态/隐藏不取与回可见补一格/重取在途不叠发/读失败保留旧内容/切项目换基准/迟到的旧项目重取不盖新项目);live-refresh 覆盖服务端监听与 revision |
| 5 | 点开一张卡 | 详情:元行/正文/评论时间线;长文折叠可展开 | upstream-detail 覆盖 |
| 6 | 详情里写评论并提交 | "已写入"反馈;时间线追加 `### 谁 — ISO时间` 块;文件尾追加、正文未动 | upstream-detail 评论提交回环 + server-write 覆盖 |
| 7 | 点动作按钮(如"诊断") | 对话框收到 prompt(首行命令+卡号/标题/路径,模板已展开) | upstream-detail 动作发话覆盖 |
| 8 | agent 改卡片状态(或面板关闭卡) | 列表状态色/计数变;关闭后动作栏置灰;重开恢复 | server-write + upstream-detail 门禁三态覆盖 |
| 9 | 筛选 chips(状态/排序/标签) | 列表按选择过滤;记忆点击;无匹配出空态 | upstream-list 覆盖(筛选交互改变行集) |
| 10 | 删除 `.scratch/` 整个目录 | 面板回引导态不崩;重建后自动跟上 | live-refresh reconnect 覆盖 |

## GitHub 后端走查(0.7.0,需真 gh 与公开仓库)

仓库用 `meimei-123/zcode-mattskills-deck-sidebar`(公开)。写作用带明显标记的临时议题,走完即关,不留测试垃圾。

第一个确认点:ZCode 的 MCP 服务进程能不能解析到 gh。最省事的验证是在面板头部展开后端 chip 手选 **GitHub**——切得过去就说明两项本地预检都过了(gh 可解析、项目根解析出仓库)。要单独证一次,就让 agent 调 `deck_project_list`,看活动项目的 `backend.repo.name` 与 `backend.writable` 有值。解析不到就把 gh 可执行文件的绝对路径设进 `ZCODE_GH_PATH` 再重启 ZCode。

| # | 操作 | 预期 | 自动化 |
|---|---|---|---|
| G1 | 在 `meimei-123/zcode-mattskills-deck-sidebar` 的 `docs/agents/issue-tracker.md` 首行写 `# Issue tracker: GitHub`,打开看板 | 列表出现仓库的议题(拉取请求不出现);chip 显示 GitHub;卡片上有标签、认领人、创建/更新时间;状态筛选与计数按房间口径 | **待人工(真机)**;读通路由 server-github-read、upstream-backend 覆盖 |
| G2 | 点后端 chip 展开,在 GitHub 与本地 Markdown 之间来回切 | 每次切换都整体重取(列表、计数、导航与详情缓存全换);chip 跟着变;切回本地后卡片来自 `.scratch/`;手选只在本会话有效,新会话按锚文件走 | **待人工(真机)**;判定、切换与重取由 server-backend、upstream-backend 覆盖 |
| G3 | 手选 GitHub 后点展开层里的「让 agent 写进锚文件」 | 对话里出现一段话,第一行是「<项目根>/docs/agents/issue-tracker.md 的首行写入 "# Issue tracker: GitHub"」,不带项目前言;agent 写完后 `deck_project_list` 的 `backend.source` 变 `anchor` | **待人工(真机)**;发话全文由 upstream-inject、upstream-backend 覆盖 |
| G4 | 让 agent 建一条议题,标题带 `[smoke-0.7.0]` 标记;再依次评论、改标签、关闭(带原因)、重开 | 议题出现在列表;评论进详情时间线;关闭时先发原因评论再关;重开回到开放;写成功后面板在一个刷新周期内跟上;摘要带仓库短名与议题号 | **待人工(真机)**;写通路与写后读回由 server-github-write 覆盖 |
| G5 | 点卡片上的议题链接 | 能在浏览器或 ZCode webview 的新窗口里打开原议题;开不了的话至少能复制地址 | **待人工(真机)** |
| G6 | 三态:退出登录(`gh auth logout`)、临时让 gh 解析不到(摘掉 PATH 里的 gh,或在没装 gh 的机器上试)、制造限流(读额度耗尽或用低额度令牌) | chip 转警告态并说明是哪一种;环境检查页对应步骤给出修复指引;列表区说明原因、不留空壳;恢复后「重新检查」回到正常 | **待人工(真机)**;三档人话与七步链由 server-github-envcheck、server-github-read 覆盖 |
| G7 | 只读仓库(用一个只有读权限的仓库或协作者账号) | 看板照常能看;建票/评论/关开/改标签都被拒并说明只读;没有写出任何写命令 | **待人工(真机)**;只读门由 server-github-write 覆盖 |
| G8 | 收尾:G4 的临时议题关掉 | 议题在 GitHub 上是 closed(或删掉);仓库里不留测试垃圾 | **待人工(真机)** |

## 未自动化、需真机确认

- GitHub 后端真机走查(0.7.0):见上面「GitHub 后端走查」一节,G1–G8 全部待人工。其中第一个确认点是 ZCode 的 MCP 服务进程里 PATH 有没有 gh;第二个未验证点是议题链接能不能在 ZCode 的 webview 里开新窗口。
- 页签真实形态(图标/标题/开合)与主题融合:看板深色与 ZCode 深色是否协调。**待人工**
- `ui/message` 在真机宿主的能力声明(`hostCapabilities.message`):若不支持,动作按钮应显示发送失败并可重试(失败路径有测试)。**待人工**
- 真机切工作区后看板数据源跟随。**待人工**
- 真机拖拽侧边栏的手感与首帧:拖到窄档时第一帧是否先闪一下宽档布局(宽度通道首帧仍按 460 起量)。**待人工**
- 面板填满侧边栏后,圆角/边框与 ZCode 侧边栏的融合观感(是否像原生的一格,而不是浮在里面的卡片)。**待人工**
- 两个新页签的真机目检(技能目录/文档详情、环境检查链快照):截图备料在工作区本地(不入库),偏差由人工目检裁定。**待人工**
- 版本管理页的真机观感(窄侧栏/宽页签):四枚页签行是否折叠得当,改动/历史/工作树三视图与差异区在窄档是否可读、无横向溢出。截图备料在工作区本地(不入库),偏差由人工目检裁定。**待人工**
- 地图详情页的真机观感:档案区标题/目的地/进度条在窄档是否折行得当;子票卡片流的四段顺序与卡片密度;点档案进 IssueDetail 的面包屑与逐级返回。**待人工**
- 地图详情页在「一张子票都没有」与「取数失败」两态:档案区应显示占位短横与原因截断,不显示假的 0 张;真机断网可试。**待人工**
- 跨项目切换真机复走(0.6.0 的 2n–2s,装 0.6.1 一并走):在 dtz-team-repo 配 `.deck/projects.json`(手写或走 2t–2u 让 agent 建),按 2n–2s 走一遍:chip 出现与三态 → chip 切到 dsh-forge → 列表/版本管理/环境检查三页跟随 → 从 dsh-forge 卡片点动作,prompt 首行带 dsh-forge 根与「以下操作都在该项目内进行」→ 写一张卡确认落盘在 dsh-forge、摘要带项目名 → 版本页危险预检未结时拒切 → 切回 home-repo。重点确认:相对路径在同构目录布局下解析正确、junction 指同一板只出现一次、清单手改后不重开即生效。**待人工**
- 插件自带的技能宿主认不认(0.6.1 的第一个确认点):装上后对 agent 说一句"列出你能用的技能里有 setup-home-repo 吗",或直接输 `/setup-home-repo`;认不到就说明宿主不把本地市场源插件的 `skills/` 当技能,2t 的请求首行会解析失败——届时把技能正文内联进请求作为回退。另调一次 `deck_skill_doc({name:"setup-home-repo"})`,`source` 是 `plugin` 说明 MCP 进程拿得到插件根。**待人工**
- 清单入口的真机观感(0.6.1):无清单时头部「＋ 项目」入口是否足够低调、不抢标题;窄侧栏收成「＋」后仍可点;清单损坏时展开层末行的「让 agent 修正清单」与警告行是否分得清。**待人工**
- 列表跟随的真机手感(0.6.1 起):面板开着时 agent 连续建几张卡,列表是否每张都在约 5 秒内出现、有没有闪动或跳回顶部;用户正开着一张卡的详情时别的卡变了,详情是否纹丝不动、返回列表后看到的是新数据;把面板切到后台几分钟再回来,是否立即补上期间的变化。**待人工**
- 真实远端(https/ssh)的凭据提示与失败话术:自动化只用本地 bare 仓与静默 TCP 冒充;真远端要确认凭据助手提示、超时与失败文案是否诚实。**待人工**
- `git-filter-repo` 等外部工具缺席时的提示:历史改写/维护页应回上游的诚实错误(说明缺什么),不静默失败。**待人工**
- 非 git 工作区的「不是仓库」引导态:真机要在协调根这类非 git 工作区确认 VC 页给引导而不是报错。**待人工**
- (可选)双击工作区本地的 m1-ui-preview.html 原型副本对照快照原型(U06 已随新 UI 重生成;源在 ui-preview 分支 `zcode-plugin/prototype/`);差异以真机为准——原型是一次性快照,不随代码日常更新。**待人工**

## 自动化实测记录(m7 收口,0.7.0,2026-11-26,离线)

集成分支 `m7-github-backend` 的终态(七票:垫片与房间 bundle、后端判定、读通路、写通路与 `deck_map_link`、修订号与探测、环境检查七步、面板后端 chip,加本票收口),`node build.mjs` 重建 dist 后跑全量;真实退出码 0,零失败。

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs` | ✓ 四段构建(src→dist + build-upstream 拼包 + build-git + build-github):dist/ui 只余 assets.json / bundle-1.txt / panel.html;bundle-1.txt code.length=2393650(UTF-16 码元),2550414 字节;dist/git.mjs code.length=955248,1021589 字节;dist/github-room.mjs code.length=317718,342567 字节(上游依赖闭包 68 个文件 + 1 个时间参数生成物,`node --check` 通过) |
| 测试 | `npm test` | ✓ 三十三套 3022 断言全绿(scaffold 83 / markdown-frozen 19 / github-room 28 / server-backend 53 / server-github-read 131 / server-github-write 123 / server-github-probe 61 / server-github-envcheck 51 / server-read 132 / server-map 34 / server-project 51 / server-project-writes 49 / server-write 98 / live-refresh 17 / upstream-skeleton 71 / upstream-kernel 113 / upstream-cards 171 / upstream-backend 118 / upstream-list 191 / upstream-mapdetail 78 / upstream-detail 90 / upstream-skills 78 / upstream-responsive 76 / upstream-checks 63 / upstream-versioncontrol 318 / upstream-chip 216 / upstream-inject 22 / server-git 35 / server-git-history 99 / server-git-refs 84 / server-git-admin 137 / server-git-writes 106 / server-git-project 26)。相对 0.6.1 的 2438:+584,来自七套新套件(github-room 28 / server-backend 53 / server-github-read 131 / server-github-write 123 / server-github-probe 61 / server-github-envcheck 51 / upstream-backend 118)与黄金对照(markdown-frozen 19);既有 25 套断言数一个没改 |
| 一条总断言 | `node test/markdown-frozen.test.mjs`(黄金文件由 0.6.1 @ 908343b 的基线 dist 录制) | ✓ 17 条调用(列表全量/open/keys、get 01 与 1、counts、list_labels、map_tickets、project_list、create/comment/update/set_labels/close/reopen、写后读回、env_check)与黄金逐字一致。规范化只动四样:工作区根→`<WS>`、ISO 时间戳→`<ISO>`、`revision`→`<REV>`、`checkedAt`→`<AT>`;`deck_project_list` 的 `active.backend` 整块删掉。sanity 复验:不删 backend 时恰好只有 `project_list` 一条红——两版之间没有第二处差异 |
| 版本 | 双清单 + scaffold(先改断言验红,再升双清单转绿) | ✓ plugin.json / marketplace.json / scaffold 断言均 0.7.0;package.json 保持 0.1.0(构建依赖清单,不参与发布) |

**收口时修掉的一处时间敏感**:全量跑前两次时 `server-github-probe` 各红过一次(d 组「恢复后立即再拍仍按基础间隔限速」、f 组「第二次不出站」)。根因在 `src/github/probe.mjs`:探测时刻原先按**开始**记,而测试把 `ZCODE_GITHUB_PROBE_MS` 收短到 500ms,机器忙时一次探测(数次假 gh 起进程)本身跨过 500ms,紧接着的一拍就会再探。已改成按**探测结束**记(间隔的语义本来就是「两次出站之间至少隔多久」,慢探测不该让下一拍立刻到点);改后该套连跑三次、全量一次全绿,判据与断言一条没改。

## 自动化实测记录(m6 收口,0.6.1,2026-11-24,离线)

集成分支的终态(票 01 技能随插件分发 + 票 02 清单入口 + 票 03 收口 + 评审的两处修复 + 列表跟随的修复),真实退出码 0。

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs` | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html;bundle-1.txt code.length=2369711(UTF-16 码元),2525838 字节;dist/git.mjs 与 0.6.0 逐字节相同(955015 码元,1021356 字节);src 与 dist 的 server/registry/watch/env-check 四件逐字节同步 |
| 测试 | `npm test` | ✓ 二十五套 2438 断言全绿(scaffold 83 / server-read 132 / server-map 34 / server-project 51 / server-project-writes 49 / server-write 98 / live-refresh 17 / upstream-skeleton 71 / upstream-kernel 113 / upstream-cards 171 / upstream-list 191 / upstream-mapdetail 78 / upstream-detail 90 / upstream-skills 78 / upstream-responsive 76 / upstream-checks 63 / upstream-versioncontrol 318 / upstream-chip 216 / upstream-inject 22 / server-git 35 / server-git-history 99 / server-git-refs 84 / server-git-admin 137 / server-git-writes 106 / server-git-project 26)。相对 0.6.0 的 2253:scaffold +30、server-read +8、upstream-chip +147(其中 8 条是评审两处修复的切片、38 条是列表跟随的切片),其余 22 套不变 |
| 技能产物 | scaffold(真 YAML 解析器读 frontmatter) | ✓ manifest 带 `"skills": "skills"`、MCP env 透传 `ZCODE_PLUGIN_ROOT`;`skills/setup-home-repo/SKILL.md` 的 frontmatter 只有 name 与 description、name 与目录名一致、不设 disable-model-invocation;description 写清三个触发场景;正文按节钉住契约串(探索读序、指针形态、排除项、候选表、停下等确认、对账三类差异、条目规则、验证到警告为空、默认不改 AGENTS.md 与 .gitignore) |
| 技能可读 | server-read(`ZCODE_PLUGIN_ROOT` 指向插件根,假 HOME 收窄另外三档) | ✓ `deck_skill_doc({name:"setup-home-repo"})` 读到原文、来源是 plugin、path 落在插件根;`deck_env_check` 技能根一步因此 done,且可读技能根只有插件内置一处 |
| 清单入口 | upstream-chip(真 bundle + 假 DOM + 可控定时器桩) | ✓ 无清单时头部有「＋ 项目」入口、无 chip;有清单时入口不渲染;入口是 button、带 title/aria-label、落在 chip 的位置、不在页签行里。点入口发出的文本首行 `/setup-home-repo`,带工作区根、清单路径、现状三态之一;不带项目前言。清单损坏、有条目被跳过时展开层末行是修正入口,发同一段请求;清单完好时没有修正入口。活动项目是非 home 项目时修正入口仍免前言,同一状态下普通动作照旧带前言 |
| 在途 | upstream-chip | ✓ 点击后入口挂 busy、禁点、aria-busy 置真;刷新落定前连点只发一条;点击后重新对齐拍的相位(在跑的 5000ms 拍只有一枚);落定后放行、能再点;发送失败立刻放行;修正入口与头部入口同一个在途口径。在途的修正入口撞上切项目:切换在途那一拍整拍跳过,切换落定后入口放行、能再点(原先会一直禁点) |
| 清单状态拍 | upstream-chip | ✓ 面板挂载即注册 5000ms 拍;不挑页签(切到技能页仍在);每拍至多一次 `deck_project_list`;上一拍未回时后续拍不叠发、落定后下一拍照常;页面隐藏不取、回可见照常。清单落盘后下一拍 chip 冒出来、入口消失;清单被删后 chip 消失、入口回来;清单损坏后展开层出现修正入口。清单身份变了(出现/被删/损坏)展开态归位;清单没变时展开着连过两拍不会自己收起。bundle 没有 `.deck` 文件监听 |
| 回退跟随 | upstream-chip | ✓ 活动项目根变了:chip 换回 home、面板工作区根跟回、`deck_issue_list` 再取一次、说明自动打开展开层。四种变体:回包带说明 / 说明已被别的调用带走(note 为空,上一个项目已不在清单里,面板用自己知道的事实说)/ 根没变时不重取、不说明 / 清单整份坏掉时说明点名清单读不出来。之后的清单回包正常时,说明在下一拍撤掉 |
| 认拍的口径 | upstream-chip、upstream-checks | ✓ 两套都改成只认「本面板 boot 之后 / 点开检查页之后新注册的」拍。原先全表按 5000ms 找:chip 套里「面板挂载即注册刷新拍」在实现之前就是假绿(认到了前面切片留下的检查页可见拍);加了清单拍之后 checks 套反过来认错拍,4 条红。改后两套断言数:chip 170、checks 63(不变) |
| 期望随规格变更的断言 | upstream-chip | 两条只改期望、条目保留:无清单时头部子元素 1→2(标题 + 入口);warning 行从 pop 最后一个子节点变成倒数第二个(修正入口是最后一行)。依据是规格「面板入口」一节,ADR-0003 的 m6 修订记录登记为对两条原决定的修订 |
| 面板常驻定时器 | upstream-inject | ✓ 清单状态拍是面板第一枚常驻定时器,Node 里靴面板的进程事件循环不再自己清空:该套原先靠自然退出,改动后打着「全部通过」挂死,把整条测试链卡在第 19 套。bundle 公开对象上加 `unmount()`,该套收尾调它再退出,进程退出码 0。其余十套靴面板的套件本就显式 `process.exit`,不受影响 |
| 列表跟随 | upstream-chip(行数据取自 test/fixtures/u04-list 经真解析器生成) | ✓ 面板没有看板的周期刷新是 0.3.0 起的既有缺陷(U06 删旧面板层时把 counts 轮询一起删了),并入 0.6.1 修掉:清单状态拍每拍多读一次 deck_issue_counts,修订号变了才重取看板。七块:卡片被外部改了下一拍列表跟着变 / 修订号没变连过三拍不重取(每拍只读一次 counts) / 重取只换数据,状态筛选、标签筛选、开着的卡、工作单元、导航栈原样保留 / 页面隐藏不取、转回可见立即补一格 / 切项目在途这一拍不碰看板 / counts 读失败不重取、保留已显示的内容、不进错误态、下一拍跟上 / 切项目后以新项目的修订号为基准不误重取。竞态一块:重取在途时切项目,迟到的旧项目重取既不盖掉新项目的数据、也不动基准 |
| 版本 | 双清单 + scaffold(先改断言验红,再升双清单转绿) | ✓ plugin.json / marketplace.json / scaffold 断言均 0.6.1;package.json 保持 0.1.0;重建后产物零变化 |

**评审修掉的两处(都在回退跟随与在途窗口的交互上,自动化原先照不到)**:

- 回退说明撤不掉:说明写进行内说明字段后没有地方清它,每 5 秒的刷新拍都带着一句已经过期的「已回退」,挂到用户切换一次项目为止。改为回退说明自己记标志,根不再变化后的下一拍撤掉;chip 切换被拒写进同一个字段的错误不是回退说明,留到用户下一次操作。
- 在途的清单入口会卡死:清单损坏或有跳过条目时,展开层里修正入口和项目项同时可见。点了修正入口、那一拍到来之前又点项目,切项目在途期间刷新拍整拍跳过,入口等的那次落定不会来,切换结束也不碰它,于是一直禁点到面板卸载。改为切项目落定时放行在途的入口。

**验红与验绿时踩的两个假信号,留作提醒**:后台任务通知里的「exit code 0」是 shell 包装的退出码,测试的真实结果要把 `exit=$?` 写进日志再看;`node test | grep ...; echo $?` 取到的是 `grep` 的退出码,要把输出重定向到文件、直接取 node 进程的 `$?`。本段的数字都是按这两条复核过的。

## 自动化实测记录(m5 收口,0.6.0,2026-11-21,离线)

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs`(src→dist + build-upstream 拼包 + build-git 打包) | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html;bundle-1.txt code.length=2361507(UTF-16 码元),2516944 字节;dist/git.mjs code.length=955015,1021356 字节 |
| 测试 | `npm test` | ✓ 二十五套 2253 断言全绿(scaffold 53 / server-read 124 / server-map 34 / server-project 51 / server-project-writes 49 / server-write 98 / live-refresh 17 / upstream-skeleton 71 / upstream-kernel 113 / upstream-cards 171 / upstream-list 191 / upstream-mapdetail 78 / upstream-detail 90 / upstream-skills 78 / upstream-responsive 76 / upstream-checks 63 / upstream-versioncontrol 318 / upstream-chip 69 / upstream-inject 22 / server-git 35 / server-git-history 99 / server-git-refs 84 / server-git-admin 137 / server-git-writes 106 / server-git-project 26) |
| 清单面 | `deck_project_list` / `deck_project_use`(临时工作区真清单,server-project/server-project-writes) | ✓ 文件缺失静默单根;条目级容错(路径不存在/不是目录/重名/非法名/指向 home-repo 均跳过带人话);整份坏 JSON 退单根 + 错误;相对路径按 home-repo 根解析;realpath 去重;home-repo 恒第一;坏名字拒绝并列可用名,不猜 |
| 跟随面 | 切换后读写/监听/环境检查/git(真 mkdtemp 仓,server-project-writes/server-git-project) | ✓ 六件写工具落活动项目、home-repo 文件一字不动、摘要带项目名;旧根编辑不再推进 revision、切换恰好 +1;环境检查前五步按活动根、技能步锚工作区根;git 桥根随活动项目重建、越界 cwd 拒;危险动作预检未结时拒切、凭票执行后放行、切到当前项目本身不挡 |
| 面板面 | upstream-chip + upstream-inject(真 bundle + 假 DOM) | ✓ 无清单 chip 隐藏(头部与上游逐字一致);普通/警告/busy 三态;展开层 home-repo 第一、坏条目以警告附末、拒绝原因行内可见;点选切换整体重取、版本页回初始视图;注入前言仅活动项目非 home 时恰好一行,home/无清单逐字放行,不叠加 |
| 版本 | 双清单 + scaffold(先改断言验红,再升双清单转绿) | ✓ plugin.json / marketplace.json / scaffold 断言均 0.6.0;package.json 保持 0.1.0;dist 重建可复现(版本 bump 未动产物) |

## 自动化实测记录(0.5.0 收口,2026-11-21,离线)

| 面 | 跑法 | 结果 |
|---|---|---|
| 构建 | `node build.mjs`(src→dist + build-upstream 拼包 + build-git 打包) | ✓ dist/ui 只余 assets.json / bundle-1.txt / panel.html;bundle-1.txt code.length=2352483(UTF-16 码元),2507726 字节;dist/git.mjs code.length=955015,1021356 字节 |
| 测试 | `npm test` | ✓ 二十套 2024 断言全绿(scaffold 53 / server-read 124 / server-map 34 / server-write 98 / live-refresh 17 / upstream-skeleton 71 / upstream-kernel 113 / upstream-cards 171 / upstream-list 191 / upstream-mapdetail 78 / upstream-detail 90 / upstream-skills 78 / upstream-responsive 76 / upstream-checks 63 / upstream-versioncontrol 306 / server-git 35 / server-git-history 99 / server-git-refs 84 / server-git-admin 137 / server-git-writes 106) |
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

工作区本地的 m1-ui-preview.html(U06 重生成,内嵌 bundle-1 + 录制数据;源在 ui-preview 分支 `zcode-plugin/prototype/`)file:// 直开:
mixed 工作区列表/容器行(地图+规格,执行/新会话按钮)/票行(bug、被阻塞、needs-triage 标签)/
关闭折叠(已关闭 2)/KPI 胶囊(可接 1 · 阻塞 3 · 已关闭 2)带数据真渲,桥日志
(read bundle-1.txt · read workspace.json · call deck_issue_list · …)随引导顺序出现。
截图与对照配对的备料在工作区本地(不入库)。

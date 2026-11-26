# a′ 混合移植:搬域逻辑与视觉,重写宿主接缝

上游 client 分三层,耦合方式不同:PixelCards 自包含、页面层经"裸名共享作用域"构建约定引用 kernel、kernel 又分域逻辑(计数/分桶/KPI 投影,MCP 服务端反正要实现)与 DSH 宿主胶水。因此按 a′ 边界移植:**搬** `views/cards/` + 页面层 + kernel 域逻辑子集(保持可剥离 TS 风格);**换**:宿主接缝(hostShim/portal/slots/api-\*)→ 薄 ext-apps 适配器,暴露同名函数;**扔**:DSH 专属胶水与 locale 代码生成管线(M1 文案内联)。全重写被否:保真必逐行读上游代码,等于伪装的移植;整体移植被否:胶水无 ZCode 对应物。

## Consequences

- 上游升级时,`views/` 与 kernel 域逻辑可按文件 diff 同步;接缝层不可同步,是有意为之。
- 构建用自己的拼接/esbuild 管线替代上游 `scripts/build.mts` 的 splice 约定,裸名约定保持,降低搬运改动面。

## M1 有意偏离(实施记录)

落地时两处偏离上面的口径,都是零依赖 bundle 与测试独立装载的取舍;上游 views 同步时改面变大,届时建迁移票一并处理:

- **段间以命名空间互调,不是裸名共享作用域**:bundle 段间经 `globalThis.MattSkills*`(`window.MattSkills*`)挂载互调,没搬上游的裸名 splice 共享约定——Consequences 里"裸名约定保持"一条在 M1 未兑现。Node 测试直接 import 同一 IIFE 也靠显式命名空间接线。
- **域逻辑是纯 JS IIFE,不是可剥离 TS**:同理由,esbuild 拼接推迟;域逻辑仍按可剥离的写法收敛(纯函数、无 DOM),只是文件形态是 JS。

三处 smell M1 接受,留待与上游 views 同步时一并收敛(本次不改):

- LABEL_COLORS / mtimeIso / 显示编号 / Comments 切分在面板与服务端同值直拷重复;
- 字段行(Status/Labels)正则 6 连散布(cards.mjs / write.mjs);
- key 归一(补两位)5 处散布(cards.mjs / write.mjs)。

## 修订(2026-11-19 夜,UI 保真度复刻)

用户验收 T04 重画版后裁定"1:1 复刻上游素材"。自此 a′ 的"搬域逻辑与视觉"按字面执行:上游 `src/client/` 本体(骨架/kernel/视图/样式)经其 splice 构建整文件搬入,仅替换宿主接缝——ctx 8 服务垫片(timer/locale/slots/sidebarRight/sidebarRightTabs/sessions/workspaces/uiWorkspace)与 React 运行时(宿主注入 → bundle 内 Preact 兼容层)。T04 的"照笔记重画"版废弃,旧 ms-* 视图层在 ui-fidelity U06 删除。容器形态:先按上游原样(460px 浮动 dsws-panel)复刻看效果,适配裁决后置。工单:`.scratch/ui-fidelity/`(U01-U06)。

## 实施修订记录(ui-fidelity U06 收口,2026-11-20)

- **a′ 的"搬视觉"自 U01 起为字面搬运**:上游 client 本体 + ctx 八服务垫片 + Preact(上述修订的执行结果);T04 重画版废弃。
- **U06 删旧 ms-* 层,双 UI 时代结束**:`src/ui/{app.js,copy.mjs,actions.mjs,detail.mjs,writer.mjs,panel.css,cards.mjs}` 与 bundle-0/panel.css 产物删除,panel.html 只注 bundle-1 起上游复刻(0.2.1 的 off 逃生舱随层退役);段间命名空间互调(`globalThis.MattSkills*`)与"域逻辑纯 JS IIFE"两条 M1 偏离随旧层一并归零——bundle-1 内部即上游原样的裸名 splice 共享作用域(esbuild IIFE),M1 有意偏离清单至此只剩服务端重复与散布类 smell 三条(不受本票影响)。

## 实施修订记录(m2,0.3.1,2026-11-20)

- **容器形态**:由上游原样的固定 460px 浮动窗改为填满 surface —— `.dsws-panel` 改 `position:static` + 宽高 100%,0.3.1 曾按 460px 给行/KPI/正文根设内容上限;0.3.2 按真机反馈(内容锁窄、不跟侧边栏拉伸)撤掉内容级上限,行/KPI/正文根随容器铺满;窄档判据仍是 380px;字号与间距不随宽度缩放(用户裁定)。
- **装配段两个本仓补件**:`nowStr`(上游真源 `src/refresh/rooms/client/snapshot-sync.ts`,纯日期串)与 `refreshAll`(上游真源 `refresh-timer.ts`,本仓只做 refreshing→emit→chainEventRefresh→收尾,不搬快照并发与同工作区组扇出);两者所在 refresh rooms 家族不搬,补件只为让整叶搬入的 loadChain/ChecksTab 不崩。
- **检查页刷新通路**:上游靠宿主事件源驱动重算(界面无自续定时器);本仓无宿主推送通道,检查页可见时用上游活跃探测拍同一节奏(5 秒)自问一次 `chainEventRefresh(..., force=true)`,页面隐藏跳过,离页即停。
- **标签重排**:上游 ListTab 的指纹(snapshot/tab/stateFilter/lblFilters)不含宽度,靠宿主重挂/重渲触发;本仓面板不重挂,在宽度 ResizeObserver 回调里补一次 `fitAllTags()`(页面隐藏时跳过测量)。
- **bundle 无版本串**:骨架没有 `__DSW_VERSION__`/`__DSW_REPO_URL__`/`__DSW_BUILD_COMMIT__` 引用,构建的版本占位替换当前无消费方,产物里没有版本串 —— 既有状况,本批未改。
- **测试假 DOM 六份副本**:upstream 六个套件各带一份 fake DOM helper,是既有测试舱模式;本批只新增两套断言,不做全量抽取。已接受为 smell,后续可收进共享 helper。
- **检查步骤 id 用本仓事实名**:`scratch:workspace`(.scratch 看板目录存在)与 `scratch:cards`(卡片可读)替代借用的上游 `tracker:initialized`/`md:workspace`(上游判据不同);其余 id 不动。连带效应:上游派生的 `setupPendingOf`/`setupCheck` 读不到 `tracker:initialized` 行,恒为 false/undefined —— 这两者在本仓闭包里都没有调用点(调用方 refresh-timer/statusbar 未搬),不产生行为影响。
- **技能根单一真源**:新建 `src/skill-roots.mjs`,`deck_skill_doc` 与 `env:skills` 判据共用同一顺序(工作区 → ~/.zcode → ~/.agents → 插件内置);env-check 旧实现漏了插件根,随之补齐。

## 实施修订记录(m3,0.4.0,2026-11-20)

- **版本管理页签 = 上游 vc 家族整体克隆**:69 个 UI 叶经 `build-upstream.mjs` splice 进 bundle-1(标记序按上游 `index.ts`:`vcStyles`/`vcShellStyles` 在样式区,其余 67 叶在 `tabs` 之前),19 片 `shared:vc*` 共享层追闭;宿主 70 文件(`src/host/versionControl*.ts` 67 + `stallWatch`/`fsAbsence`/`runningMarkers` 3)与核心 48 文件(`src/shared/version-control/**`)由 `build-git.mjs` 构建期打包进 `dist/git.mjs`。**新写的是四件**:Node 六服务垫片(`subprocess`/`timer`/`fs`/`gate`/`logCtx`/平台)、`deck_git` 一条工具、构建胶水(`build-git.mjs`),以及 `src/git/credential-safe.mjs`(上游 `createCredentialSafeGit` 的人工去类型子集拷贝;不是原样拷贝,升级需重拷)。
- **垫片与上游 Job 的进程树差异**:`subprocess.terminate()` 只对直接子进程发 SIGTERM/SIGKILL,不覆盖整棵进程树;上游 DSH Job 层会回收进程组。本仓没有 Job 层,git 拉起的钩子或传输助手在 terminate 后可能继续跑到自然退出。退出码与 collected 输出仍按上游口径回收,差异只在「谁被信号覆盖」。
- **有意偏离一:`withGhLane` 直通**:单会话单消费者,没有并发闸需求;`src/git/admission-stub.mjs` 的 `(opts, run) => run()` 取代上游 outbound-admission。
- **有意偏离二:`deck_git` 路径边界**:`args.cwd` 与克隆/迁移/工作树/平台输出/补丁输出/fast-import 输入等目标路径必须落在工作区根内,越界回 `{ok:false,error:{kind:'boundary'}}`;工具对 agent 可见,不能变成全盘 git 执行器。判定按真实路径:工作区根取一次 `realpathSync.native` 缓存,目标存在就 realpath,不存在就向上找最近的已存在祖先 realpath 后拼回剩余段 —— 根内指向根外的 symlink/junction 也会被拦住,`..foo` 这类合法目录名不误伤。
- **垫片要点**:`subprocess` 按上游调用面实现 `spawn({argv,cwd,stdio,graceMs,env}) → {done,collected,stdin?,terminate}`(argv 直传、无 shell;stdout/stderr collector 有字节上限,超限保留尾部并标 lossy/truncated);`timer` 一律 unref(命令超时看门狗不钉住进程);长任务记录落系统临时目录(优先级 `createGitBridge({cacheDir})` > `ZCODE_VC_TASK_CACHE` > 系统临时目录按工作区根散列);`now` 可注入供票期测试。
- **已知上游问题(只记录,未改)**:`gitPlatformCheck`/`gitPlatformRun` 的 `readScreenOf` 回 `{ok,screen}`,调用方读 `screenReply.data.screen`,形状不一致恒回 `kind=shape`(面板不调用这两条);同步域 pull 的 argv 把 `origin/main` 当仓库地址,`gitSyncWrite` 的 pull 必失败(写域 `gitPull` 走配置上游,正常快进);`prune` 的备份路径算在仓库根同级,工作区根=仓库根时备份落在工作区外;`migrate init` 只支持已存在的空目录;`git-filter-repo` 不是本仓依赖。
- **管理页可达性(与上游一致)**:上游产品页签(`VersionControlTab` 的块模型)只挂改动/提交历史/工作树三视图;`vcShellPages` 的 16 个管理页(分支与标签/远端/子模块/维护/迁移/配置/钩子/诊断/平台/贮藏/变基/冲突/搜索等)由 `vcRenderTabAt`/`vcRenderAllPages` 渲染,但上游产品没有调用方,只被上游测试与门禁使用。本仓照搬同一结构:页面全在 bundle 里、可经测试自检面直接渲染,产品页签不出管理页导航入口;`gitChangesCheck/Write` 同理由未挂载的 13 动作面板使用,行内暂存走直接 `gitStage`(可逆动作无预检)。这不是本仓裁剪,是上游 1.9.0-beta.33 的产品现状。
- **既有 smell 顺延**:`src/git/credential-safe.mjs` 是上游 `createCredentialSafeGit` 的人工去类型子集拷贝(升级需重拷,不可按文件 diff 同步);上游测试的假 DOM 各套一份(新增 vc 套件同模式),未做共享抽取。

## 实施修订记录(m4,0.5.0,2026-11-21)

- **只搬 V2,不搬老页三叶**:地图/规格容器的产品入口在上游 #1402 已切到 `MapDetailV2Page`(Dock 列表分支 `active ? MapDetailV2Page : ...`);V2 只复用老页顶栏 `MapDetailTop`,老 `mapDetailHead`/`mapDetail`/`mapDetailSpecBody` 不登记、不进闭包。共新增 13 叶:`mapV2Styles`(样式区,紧随卡片样式插入)+ `mapDetailTop`(ticketRow 与 detailActionBar 之间)+ 11 片 `mapV2*`(detailActionBar 之后、detailProjection 之前)。
- **分发按上游口径算 active**:`active = findGroupByIdentity(compute(st), topMap, topEffort)`,渲染顺序 active → issue → list;同号地图在不同工作单元里是两张,按 (effort, 编号) 找。本地地图编号是 `"00"`、行 `number` 是 0 —— 0 是合法坐标(`findMapByIdentity` 同时比 number 与补零 key),`MapDetailV2Page` 自己也写明不拦 0。
- **数据面:一条电话 + 两个字段**:`wf.mapTickets` 适配到新工具 `deck_map_tickets({key, effortId?})`,回包与上游宿主同形 `{ok,key,items,stats,total,fetched,capped,missing}`;子票行按 `prepareRow` 归一(大写 state、`blockedBy` 压键串 + `blockedByRefs` 旁表带标题/状态、`claimedBy` 取第一个 assignee、`progress` 按上游 `src/shared/issue-file/src/progress.ts` 的读路径移植:屏蔽代码块/引用块/注释,认 `进度`/`Progress`、老标题百分比与 `##进度` 紧贴写法)。`deck_issue_list` 的 map/spec 行新增 `destination`(正文 `## Destination` 段;围栏与 HTML 注释里的同名标题不算),经 `panelRowOf` 原样进快照。
- **快照首帧不另造**:`ingest.mjs` 的 `groupDeck` 早已给开容器装 `tickets`、给所有容器算 `stats{total,closed}`(上游 `containerStateOf`/圆环读它),V2 进页即可先画快照那份;已关闭子票与关地图的子票才走按需取数。规格没有「目的地」一节时不画空态提示(上游行为)。
- **正文不进地图页**:上游 2026-10-23 定地图页不再展示笔记/已定决策/战雾/范围外/规格七段,正文全文由点档案进这张图自己的 IssueDetail 看;本仓只补 `destination`,不解析其余区块。
- **子票动作与跳转**:子票卡点行走上游 `enterSubDetail` → IssueDetail;地图档案区点按压导航栈进这张图的 IssueDetail(issue 详情取 `effort/00`),返回逐级弹回。
- **测试**:`server-map` 34 条(电话契约/目的地与进度解析/拒绝路径)、`upstream-mapdetail` 78 条(十三叶与标记序、bundle 接线、旧占位清零)、`upstream-list` 增 M4 切片 15 条(真点击进页、档案/目的地/计数、取数电话、档案跳转、逐级返回;取数回包走真解析器)。二十套 2024 断言全绿。

## 实施修订记录(m7,0.7.0,2026-11-26)

按同一套字面搬运纪律又克隆了一个房间:上游 GitHub 房间(`src/tracker/rooms/github` 的 TS 依赖图)由 `build-github.mjs` 构建期读入,打成 `dist/github-room.mjs`;房间源码一字不改,装机不依赖上游树。新写的只有 Node 垫片(与版本管理页共用 `src/node-shims.mjs`)、构建胶水、出站控制面的直通实现,以及 `src/github/` 的分发层。本次新增的有意偏离都归在 ADR-0004,不改变本文的 a′ 口径:

- **后端显式启用,不按远端地址自动识别**:上游判定顺序是「手选 > 声明 > 自动识别」,本仓去掉自动识别(手选 > 锚文件 > 默认本地 Markdown)。远端在 GitHub 上只产生一条提示,不出站。
- **仓库只从活动项目根解析**:工具不接受仓库参数;与 `deck_git` 的路径边界同一条理由——agent 可见的工具不能变成任意仓库的 gh 执行器。
- **不做上游的额度账本与并发名额闸**:出站控制面保留五样本事的形状,接直通实现(立即放行、不排队、无冷却窗口);限速改由服务端按项目根的探测间隔承担。
- **房间错误原文保留上游口径**:错误里会出现 DSH 与 `DSH_GH_PATH`,人话摘要由本仓另写,原文进结构化明细;上游文本不动。
- **本地 Markdown 回包与 0.6.1 逐字一致**:唯一例外是 `deck_project_list` / `deck_project_use` 的 `active` 多一块 `backend`,由 `test/markdown-frozen.test.mjs` 的黄金对照守。

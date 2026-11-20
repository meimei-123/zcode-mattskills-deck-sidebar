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

- **版本管理页签 = 上游 vc 家族整体克隆**:69 个 UI 叶经 `build-upstream.mjs` splice 进 bundle-1(标记序按上游 `index.ts`:`vcStyles`/`vcShellStyles` 在样式区,其余 67 叶在 `tabs` 之前),19 片 `shared:vc*` 共享层追闭;宿主 70 文件(`src/host/versionControl*.ts` 67 + `stallWatch`/`fsAbsence`/`runningMarkers` 3)与核心 48 文件(`src/shared/version-control/**`)由 `build-git.mjs` 构建期打包进 `dist/git.mjs`。新写的只有 Node 六服务垫片(`subprocess`/`timer`/`fs`/`gate`/`logCtx`/平台)、`deck_git` 一条工具与构建胶水。
- **有意偏离一:`withGhLane` 直通**:单会话单消费者,没有并发闸需求;`src/git/admission-stub.mjs` 的 `(opts, run) => run()` 取代上游 outbound-admission。
- **有意偏离二:`deck_git` 路径边界**:`args.cwd` 与克隆/迁移/工作树/平台输出/补丁输出/fast-import 输入等目标路径必须落在工作区根内,越界回 `{ok:false,error:{kind:'boundary'}}`;工具对 agent 可见,不能变成全盘 git 执行器。
- **垫片要点**:`subprocess` 按上游调用面实现 `spawn({argv,cwd,stdio,graceMs,env}) → {done,collected,stdin?,terminate}`(argv 直传、无 shell;stdout/stderr collector 有字节上限,超限保留尾部并标 lossy/truncated);`timer` 一律 unref(命令超时看门狗不钉住进程);长任务记录落系统临时目录(优先级 `createGitBridge({cacheDir})` > `ZCODE_VC_TASK_CACHE` > 系统临时目录按工作区根散列);`now` 可注入供票期测试。
- **已知上游问题(只记录,未改)**:`gitPlatformCheck`/`gitPlatformRun` 的 `readScreenOf` 回 `{ok,screen}`,调用方读 `screenReply.data.screen`,形状不一致恒回 `kind=shape`(面板不调用这两条);同步域 pull 的 argv 把 `origin/main` 当仓库地址,`gitSyncWrite` 的 pull 必失败(写域 `gitPull` 走配置上游,正常快进);`prune` 的备份路径算在仓库根同级,工作区根=仓库根时备份落在工作区外;`migrate init` 只支持已存在的空目录;`git-filter-repo` 不是本仓依赖。
- **既有 smell 顺延**:`src/git/credential-safe.mjs` 是上游 `createCredentialSafeGit` 的人工去类型子集拷贝(升级需重拷,不可按文件 diff 同步);上游测试的假 DOM 各套一份(新增 vc 套件同模式),未做共享抽取。

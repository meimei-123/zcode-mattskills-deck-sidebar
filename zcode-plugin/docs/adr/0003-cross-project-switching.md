# 跨项目 = 显式项目清单 + 单活动项目切换,不做合并总览

**Status:** accepted

dtz-team-repo 作为公司层单一入口,却只能读自己根下的 `.scratch/`;真实看板分散在 dsh-forge、dtz-jxkh-assistant、4gEHM/nail-4g-ehm、4gNail/nail-fw-bench 等项目根。决定:home-repo 根放一份只读的 `.deck/projects.json`,面板头部提供项目 chip,`deck_project_list` / `deck_project_use` 在 MCP 服务进程内切换**一个**活动项目;列表、版本管理、环境检查三页跟随,卡片 key 保持 `effort/NN`,不引入三段身份。清单是唯一信任来源,插件不自动发现、不改清单;活动项目被移出清单时下一次调用回退 home-repo。

## Considered Options

- **合并总览**(一个列表混排多项目):最贴"一眼看全",但要配套 `project/effort/NN` 三段 key、多根并发监听、跨根写路由,并把上游的列表/详情/ingest 改成分组形态;上游保真与单根不变量都要让路。v1 不做;清单与切换状态是它的地基。
- **只读总览**:没有跨根写路由的风险,但在公司层看到可领取的票却拿不了,分诊闭环断一半。
- **不改插件**:成本为零,但"从公司层单一入口出发"的定位失效,用户只能逐个项目开会话。
- **自动发现**(扫 `E:\DTZ`):4gNail 根的 `.scratch` 是杂物堆,还有嵌套 clone;扫出噪声、拖慢递归监听,且新项目出现没有门槛。

## Consequences

- 项目集合由人负责:加项目=手写一行,插件不猜;路径是机器相关的,清单默认本地、可审查。
- 活动项目只存在服务进程内,新会话复位 home-repo;不持久化,避免"隔天新开会话写错项目"。
- `deck_git` 的目标随活动项目,agent 的 shell cwd 仍是 home-repo;动作 prompt 必须前置项目根——这条不对称是设计的一部分,不是缺陷。
- 卡片 key 仍是项目内 `effort/NN`;同一个 key 只在活动项目内有意义,跨项目阻塞引用不支持。
- 清单校验是条目级容错:坏条目跳过并给 warning;整份 JSON 坏掉才退回单根。一个笔误不该打掉全部项目。
- 面板唯一分叉是头部 chip 与注入前言;上游列表、详情、动作模板零改动,合上游成本保持在可接受范围。
- 没有 `.deck/projects.json` 的工作区行为与之前逐字一致。
- 若日后要做合并总览,需要另立 ADR,并重新设计 key 与写路由;本次的清单与切换状态可复用。

## 实施修订记录(m5,0.6.0,2026-11-21)

实现按本文逐条落地(新增五套:server-project / server-project-writes / server-git-project / upstream-chip / upstream-inject,二十五套全绿)。以下六条是落地时刻的取舍与细化,不改变上面的决定:

- **回退落定即清**:活动项目被移出清单/改名/清单整份坏掉的那一次调用回退 home-repo 并带人话说明,进程内的失效选择就地清空;后续调用干净地按 home-repo 走,不重复报同一原因。清单是唯一信任边界,失效选择不留底。
- **切换恰好 +1**:`.scratch` 监听随活动项目重建时,新实例从旧 revision 起步、初扫必推进一次 = 切换恰好 +1,面板据此重取;revision 跨根单调由 server 层保证,旧根编辑在切换后不再推进。
- **技能根锚工作区根**:环境检查的技能步经 `skillRoot` 参数锚 home-repo(技能根是用户级事实);前五步与 `git:repo` 按活动项目根组链。
- **危险动作哨兵按票据 TTL**:「未确认的危险 git 动作」在 server 层记哨兵——`deck_git` 回包带预检签票(id + expiresAtMs)时布防到票的到期时刻(上游票期 120 秒),凭票执行档(ticketId 非空)无论成败即结清,按签票时的根键控互不影响;面板取消确认卡不发任何电话,这条路径靠票据过期自然结清(最多一个票期后恢复可切)。票据表住在 vc 家族闭包里、桥的对外面查不到整表,这是挡住「push/reset 落到另一个仓库」的最小口径。
- **workspace.json 的 root 现算**:资源读时按活动项目现算 root(vc 页 cwd 的取数来源),`env.ZCODE_WORKSPACE_ROOT` 仍是宿主注入的 home 根(home-repo 身份);无清单时 root 与旧口径逐字一致。「版本页回到初始视图」由上游 VersionControlTab 自己的 cwd 变化复位分支接住,面板补件只负责看板重取与清上一项目的导航/详情缓存。
- **注入前言的严格口径**:前言只在前置身份明确为非 home 活动项目(`active.isHome !== false`)时加;home-repo、清单缺失、身份未落定一律逐字放行——身份残缺宁可少一行前言,不冒充项目上下文。

未进记录的取舍:chip 样式类用 `dsws-pchip-*` / `[data-deck-chip*]` 前缀避让上游既有 `.dsws-chip` 标签芯片,纯内部命名,不改变本文任何决定。

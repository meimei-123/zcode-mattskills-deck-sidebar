# M1 手工冒烟清单

装好插件(见 README)后按序走一遍。✓ = 预期;自动化已覆盖的步骤注明测试出处。

| # | 操作 | 预期 | 自动化 |
|---|---|---|---|
| 1 | 安装插件并启用,开新会话 | 侧边栏出现 MattSkills 页签(方形看板图标) | 待维护者(真机) |
| 2 | 打开页签 | 无 `.scratch/` 时显示中文引导态(指向 /setup-matt-pocock-skills 与 /to-tickets) | 缝 2 覆盖 |
| 3 | 对 agent 说"用 /to-tickets 在 m1-core-board 下建几张测试卡" | agent 调 `deck_issue_create`,卡片落盘 `.scratch/m1-core-board/issues/` | 缝 1 server-write 覆盖 |
| 4 | 看板(不刷新面板) | 防抖后自动出现新卡;计数胶囊条变 | 缝 1/2 live-refresh 覆盖 |
| 5 | 点开一张卡 | 详情:元行/正文/评论时间线;长文折叠可展开 | 缝 2 panel-detail 覆盖 |
| 6 | 详情里写评论并提交 | "已写入"反馈;时间线追加 `### 谁 — ISO时间` 块;文件尾追加、正文未动 | 缝 1/2 写面覆盖 |
| 7 | 点动作按钮(如"诊断") | 对话框收到 prompt(首行命令+卡号/标题/路径,shared 小节已展开) | 缝 2 panel-actions 覆盖 |
| 8 | agent 改卡片状态(或面板关闭卡) | 列表状态色/计数变;关闭后动作栏置灰;重开恢复 | 缝 1/2 + 切片 E 覆盖 |
| 9 | 筛选 chips(状态/排序/标签) | 列表按选择过滤;记忆点击;无匹配出空态 | 缝 2 panel-list 覆盖 |
| 10 | 删除 `.scratch/` 整个目录 | 面板回引导态不崩;重建后自动跟上 | 缝 1 reconnect 覆盖 |
| 11 | 打开页签(共存期) | 旧 UI 之上浮出上游 dsws-panel 空壳:460px 宽、深色 #16181d 底、#2a2d35 边框、12px 圆角、原版阴影,头行标题 MattSkills | U01 upstream-skeleton 覆盖(壳 vnode+样式链);快照原型实测见下 |
| 12 | 点排障区「切换上游面板壳」按钮 | localStorage `mattskills-upstream` 翻转并重载;off 后纯旧 UI | 待维护者(真机) |

## 未自动化、需真机确认

- 页签真实形态(图标/标题/开合)与主题融合:看板深色与 ZCode 深色是否协调。
- `ui/message` 在真机宿主的能力声明(`hostCapabilities.message`):若不支持,动作按钮应显示发送失败并可重试(失败路径有测试)。
- 真机切工作区后看板数据源跟随。
- (可选)双击 `prototype/m1-ui-preview.html` 对照快照原型,差异以真机为准——原型是一次性快照,不随代码更新。

## 自动化实测记录(2026-11-19,离线)

用 `dist/server.mjs` 的 stdio 会话(仿 test/server-read.test.mjs 的 startServer)对临时工作区跑了一遍数据面:建卡→列表→评论→状态改→关闭→重开,覆盖清单步骤 3-8 的工具侧;面板侧仍以缝 2 测试为准,真机项见上节。每步实际输出(节选):

| 清单步 | 调用 | 实际输出(节选) |
|---|---|---|
| 3 建卡 | `deck_issue_create`(m1-smoke/冒烟测试卡,labels=[needs-triage]) | 已建卡 #m1-smoke/01「冒烟测试卡」,写入 .scratch/m1-smoke/issues/01-冒烟测试卡.md。(revision=2) |
| 4 列表 | `deck_issue_list` | 共 1 张卡(容器 0 / 票 1,open 1 · closed 0)。#m1-smoke/01 冒烟测试卡(revision=2;面板自动跟上的防抖面归缝 1/2 live-refresh) |
| 6 评论 | `deck_issue_comment`(body=冒烟:第一条评论。) | 已在 #m1-smoke/01「冒烟测试卡」追加评论(smoke · 2026-11-19T10:23:31.778Z),落盘到 .scratch/m1-smoke/issues/01-冒烟测试卡.md。(revision=3) |
| 8 状态改 | `deck_issue_update`(status=in-progress) | 已把 #m1-smoke/01「冒烟测试卡」状态行改为「in-progress」。(revision=4) |
| 8 关闭 | `deck_issue_close`(reason=冒烟关闭) | 已关闭 #m1-smoke/01「冒烟测试卡」(状态行 → closed,原因已记为一条评论(smoke))。(revision=5) |
| 8 重开 | `deck_issue_reopen` | 已重开 #m1-smoke/01「冒烟测试卡」(状态行 → ready-for-agent)。(revision=6) |
| (复核) | `deck_issue_list` | 共 1 张卡(容器 0 / 票 1,open 1 · closed 0)。#m1-smoke/01 冒烟测试卡(revision=6) |

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

真机页签上的同款确认归清单步骤 11/12。

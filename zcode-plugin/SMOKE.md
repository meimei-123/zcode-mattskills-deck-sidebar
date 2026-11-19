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

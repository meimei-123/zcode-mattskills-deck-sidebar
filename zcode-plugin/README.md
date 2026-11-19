# zcode-mattpocock-skills-deck

MattSkills 任务看板的 ZCode 插件:侧边栏 "MattSkills" 页签(官方 `ui.surfaces`)+ 自带 MCP 服务读写工作区 `.scratch/` 工单,agent 与人共用同一块数据。

## 架构一句话

官方 UI Plugin 形态——manifest 声明 Surface 页签,面板经 `ui://` 资源加载并由内置桥(工具调用/消息发话/资源读取)连接同进程 MCP 服务;数据契约是上游 DSH deck 1.9.0-beta.33 本地 Markdown 后端子集(见 `GLOSSARY.md` 与 `docs/adr/`)。

## 安装

1. 构建:`npm install` 后 `node build.mjs`(产物进 `dist/`,已入库,通常不需要;构建依赖 esbuild+preact,只进 bundle 产物,运行时零依赖)。
2. ZCode 里 **插件市场 → 添加 → 添加插件市场**,粘贴本目录(`zcode-plugin/`)路径。
3. 在 **个人 → dev-mattpocock-skills-deck → zcode-mattpocock-skills-deck → 安装**,并在设置中启用。
4. 新会话(或刷新)后,侧边栏出现 **MattSkills** 页签。无 `.scratch/` 时显示引导态。

试用:让 agent 跑 `/to-tickets` 拆解规格建卡,或直接说"列出我的工单"(调 `deck_issue_list`)。看板自动跟随磁盘变化。

## 新旧面板并存(ui-fidelity 共存期)

页签里两套面板同时活着:旧 UI(ms-*)照旧;上方另浮一张上游原样的 **dsws-panel 空壳**(460px 浮卡,来自上游 `src/client` 的 splice 拼接 bundle + Preact,见 `build-upstream.mjs` 与 ADR-0002 修订)。回退纯旧 UI:页签底部排障区点「切换上游面板壳」按钮,或把 localStorage `mattskills-upstream` 设为 `off` 后重开页签。后续工单往壳里搬上游列表/地图,U06 删旧 UI。

## 目录

```
.zcode-plugin/plugin.json   清单(Surface + MCP)
src/                        server/write/watch(数据面)+ ui/(面板,bundle 源;upstream/ 为上游骨架+垫片)
build-upstream.mjs          上游 client 叶子 splice 拼接构建(bundle-1.txt)
dist/                       构建产物(server.mjs + ui/),安装即用
test/                       九套直跑测试(缝 1:工具边界;缝 2:面板 DOM/桥包络;U01:上游骨架)
prototype/                  UI 快照原型(一次性,见 SMOKE.md 提示)
```

## 与上游的关系

上游 [FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) 1.9.0-beta.33 的设计与契约子集,按 a′ 混合移植边界实现(ADR-0002):域逻辑与视觉对齐上游,宿主接缝换成 ext-apps 桥。本仓库主体是上游快照仓库内的 `zcode-plugin/` 开发分支,移植对照物就在父目录。许可与署名见 [NOTICE.md](NOTICE.md)。

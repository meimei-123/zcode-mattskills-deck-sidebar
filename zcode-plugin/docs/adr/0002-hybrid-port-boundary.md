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

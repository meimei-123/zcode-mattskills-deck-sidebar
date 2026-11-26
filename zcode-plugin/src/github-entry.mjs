// src/github-entry.mjs —— GitHub 房间 bundle 入口(票 01):只转出上游房间的对外成员,不写运行时逻辑。
//
// 源码树里本文件指向上游只读树的 TS 图(`../../src/tracker/rooms/github/room/index.js`;`.js`→同名
// `.ts` 的换算由 build-github.mjs 的解析插件在构建期做)。dist 里 build-github 会把同名文件改写成一
// 行转出 `./github-room.mjs` 的 shim(与 dist/git-entry.mjs 同款),装机只认 bundle。
//
// 上游的 `export default createGithubBackend` 有意不转:本仓的消费方(票 03 的房间装配)按具名取,
// 少一个默认导出,模块表面就少一条歧义。
export {
  createGithubBackend,
  githubMatches,
  githubModule,
  describe,
  issueAddress,
  repoSearchAddress,
  issueRefPattern,
  links,
  capabilities,
  parseGithubRepo,
  getRepoKey,
  openRepository,
  GITHUB_CHECKS,
  fixes,
  prompts,
  initProject,
} from "../../src/tracker/rooms/github/room/index.js";

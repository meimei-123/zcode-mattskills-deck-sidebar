// 上游真源签名:src/refresh/rooms/host/outbound-admission.ts 的 withGhLane(laneOpts, run, onQueueFailure?),
// 完整实现是「读/写两桶并发闸 + 排队 + 冷却」;本插件单会话单消费者,没有并发闸需求,直通即可。
// 版本管理宿主族只把它当「跑之前拿名额、跑完放回」的包装(见 upstream src/host/versionControl.ts runGit),
// 第三参 onQueueFailure 只在排队失败时被调用;直通路径永不排队,故不调用。
export async function withGhLane(_laneOpts, run) {
  return run();
}

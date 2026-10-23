/**
 * git 快进拉取的参数与判定（sync 与 market 共用唯一实现）。
 *
 * 为什么不用 `git pull --ff-only`：它是「fetch 写 FETCH_HEAD + 读 FETCH_HEAD 合并」的两步动作。
 * 两个消费者并发驱动同一个工作副本时 FETCH_HEAD 会留下多行 for-merge 记录，随后**每个** pull 都以
 * `fatal: Cannot fast-forward to multiple branches.`（exit 128）失败（本机 5 并发实测 5 个全败）；
 * 这条失败落在自动同步的 intent journal 里就会被判「不可证明」⇒ 落盘 durable SAFE MODE。
 * 显式 refspec fetch + 显式远端跟踪分支 merge 完全不读 FETCH_HEAD（同样 5 并发实测全成功），
 * 语义与 ff-only pull 一致：能快进就快进，不能快进就报「历史分叉」。
 */

/** `git fetch` 参数：只更新 origin/<branch> 这个远端跟踪引用，不写 FETCH_HEAD */
export function fastForwardFetchArgs(branch: string): string[] {
  return ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
}

/** `git merge` 参数：快进到显式远端跟踪分支（不依赖 upstream 配置，也不读 FETCH_HEAD） */
export function fastForwardMergeArgs(branch: string): string[] {
  return ['merge', '--ff-only', `origin/${branch}`];
}

/** 远端还没有同名分支（全新空仓库 / 分支被改名）：调用方按「无 upstream」同姿态静默跳过 */
export function isMissingRemoteRefError(text: string): boolean {
  return /could.?n't find remote ref|could not find remote ref/i.test(text);
}

/** `rev-parse --abbrev-ref HEAD` 的输出 → 分支名；detached HEAD（'HEAD'）返回空串 */
export function parseCurrentBranch(stdout: string): string {
  const branch = stdout.trim();
  return branch === 'HEAD' ? '' : branch;
}

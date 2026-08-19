/**
 * m-market：市场仓库地址校验（纯函数，node 可测）。
 *
 * 设计文档 docs/design/2026-08-19-market-publish-design.md §3.1：
 * 条目来源仓库（repo）与市场仓库 URL 只接受 http(s)，**拒绝 git@/ssh/scp 等形态**——
 * 市场通道只走 https clone、永不注入凭据（ssh 依赖用户机器凭据，且 userinfo 已拒）。
 * 复用 sync 的 validateRepoUrl（拒绝 userinfo / 空白），叠加 scheme 强制。
 */
import { validateRepoUrl } from '../sync/sync-config.ts'

/** 校验市场仓库地址；合法返回 null，非法返回错误消息。仅接受 http(s)，拒绝 git@/ssh/空白/含 userinfo。 */
export function validateMarketRepoUrl(repoUrl: string): string | null {
  const err = validateRepoUrl(repoUrl)
  if (err !== null) return err
  if (!/^https?:\/\//i.test(repoUrl.trim())) {
    return '市场仓库地址仅支持 http(s)（拒绝 git@/ssh 等形态）'
  }
  return null
}

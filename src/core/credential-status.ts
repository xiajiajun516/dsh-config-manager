/**
 * 凭据可用性查询（core 与 sync 共享的唯一判据）。
 *
 * 为什么单独成模块：MissingSecret 计划项此前只看`备份里`的 credentialsStatus（源机状态），
 * 于是目标机**已经配置好**的凭据仍被要求补录 —— 用户报告「已有的重复密钥也会提示」。
 * 判据必须落在目标机侧，且**读不到就保守判为未配置**（宁可多提示一次，不可少提示一次）。
 *
 * 安全：只回布尔，永不读取/回传凭据值（HostContext.credentials 本身不回读值）。
 */
import type { HostContext } from './types.ts';

/**
 * ref 在**目标机**是否已配置。
 * 凭据服务不可用 / ref 不合法 → false（保守：仍按「需要补录」处理）。
 */
export async function isCredentialConfigured(
  ctx: Pick<HostContext, 'credentials'>,
  ref: string,
): Promise<boolean> {
  try {
    return (await ctx.credentials.describe(ref)).configured === true;
  } catch {
    return false;
  }
}

/**
 * 可选 Cordis 服务读取（**唯一实现**）：只在调用点读、从不注入，因此不会把可选服务变成
 * 硬依赖、也不会因为服务缺失而阻塞 fiber。
 *
 * 边界：core 不得 import `@deepseek-ai/*`（tests/architecture-boundaries.test.ts），
 * 所以这里只描述「能 ctx.get(name)」这一最小面；宿主入口把真 ctx 传进来即可。
 */

/** 宿主 context 的最小可用面（Cordis `Context` 结构上满足）。 */
export interface ServiceGetter {
  get(name: string): unknown;
}

export function readService<T>(ctx: ServiceGetter, serviceName: string): T | undefined {
  const candidate = ctx.get(serviceName);
  return candidate === null || typeof candidate !== 'object' ? undefined : (candidate as T);
}

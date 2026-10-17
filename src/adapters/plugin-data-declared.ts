/**
 * 「已安装插件自述数据目录（dsh.dataDirs）」的**单一扫描实现**。
 *
 * 为什么单独一个模块：这份扫描有两个消费者 ——
 *  - \`pluginData\` / \`pluginAssets\` adapter（决定要收集哪些区域）；
 *  - \`plugins\` adapter（导出选择器「按插件看」需要知道**每个插件自己声明的数据区域**，
 *    才能在不读任何数据目录的前提下画出树骨架）。
 * 两处各写一份必然漂移（同一条铁律：同一事实只有一份实现）。
 *
 * 语义（与改造前 plugin-data.ts 的私有实现逐字一致）：
 *  - 读的是 **profile 实际安装**的那份 manifest（\`profiles/<profile>/node_modules/<pkg>/package.json\`），
 *    不是全局目录 —— 同一个包在不同 profile 可以是不同版本，声明必须取本 profile 装的；
 *  - 读不到（未安装 / 无声明 / 形状非法）一律跳过：本机制是**附加**信息，绝不因为一个包读不出来
 *    就影响内置来源或整次导出；
 *  - 本函数**不缓存**（缓存策略由调用方决定：pluginData 有实例级 TTL 缓存，plugins 有模块级缓存）。
 */
import { parseDeclaredDataDirs } from '../core/plugin-data-registry.ts';
import type { PluginDataSource } from '../core/plugin-data-registry.ts';
import type { HostContext } from '../core/types.ts';

/** 单次扫描最多读取多少个已安装插件的 manifest（防御性上限：profile 依赖数量异常时不无限读） */
export const MAX_DECLARED_PACKAGES = 300;

/**
 * 解析声明时用的 profile 目录名。
 *
 * 与 DSH 的 profile 解析同口径：空 / undefined = \`web\`（与改造前的私有实现一致）。
 */
export function declaredProfileName(profile: string | undefined): string {
  return profile !== undefined && profile !== '' ? profile : 'web';
}

/** 扫描本机已安装插件自述的数据目录声明（零副作用；读不到的一律跳过）。 */
export async function scanDeclaredDataSources(
  ctx: HostContext,
  maxPackages: number = MAX_DECLARED_PACKAGES,
): Promise<PluginDataSource[]> {
  const base = 'profiles/' + declaredProfileName(ctx.profile);
  const out: PluginDataSource[] = [];
  let deps: string[] = [];
  try {
    const raw = await ctx.fs.readFile(base + '/package.json');
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    const dep = (parsed as { dependencies?: unknown } | null)?.dependencies;
    if (dep !== null && typeof dep === 'object') deps = Object.keys(dep).slice(0, maxPackages);
  } catch {
    deps = [];
  }
  for (const name of deps) {
    try {
      const raw = await ctx.fs.readFile(base + '/node_modules/' + name + '/package.json');
      const manifest: unknown = JSON.parse(new TextDecoder().decode(raw));
      const source = parseDeclaredDataDirs(name, manifest);
      if (source !== null) out.push(source);
    } catch {
      // 未安装 / 无 manifest → 无声明，跳过
    }
  }
  return out;
}

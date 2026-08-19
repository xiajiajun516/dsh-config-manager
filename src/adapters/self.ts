/**
 * self 分区 adapter（插件自身配置，设计「self 分区」）：
 * 数据源 = $DSH_HOME/dsh-config-manager/ 下的插件自身配置文件（白名单收集，非递归）：
 *   - sync/sync-config.json     同步通道配置（git repoUrl / webdav url+username；凭据值走 credentials 槽位，不含 secret）
 *   - sync/sync-autosync.json   自动同步调度配置
 *   - sync/sync-selection.json  同步分区选择（默认/高级模式 + 勾选分区）
 *   - sync/ui-prefs.json        插件 UI 偏好（如上次选择的同步通道；从 localStorage 迁入）
 *   - market/market-config.json 配置市场配置
 *
 * 排除项：sync/sync-history.json（执行记录，属数据非配置）、market/cache/（缓存）、
 * snapshots/（快照）、tmp/ exports/（临时/导出产物）——只备份「配置」，不备份数据。
 *
 * 实现：继承 FileCollectionAdapter 复用 analyzeImport/applyItem/validate（幂等 hash 比对、
 * 快照/回滚路径一致），仅覆写 export() 为白名单收集（self 目录内存在大量非配置子目录，
 * 不能像 skills/sessions 那样整体递归）。
 *
 * relativePath 一律是「相对 baseDir」的路径（如 sync/sync-config.json），与
 * FileCollectionAdapter 的基准目录语义一致：导入时按 path.join(baseDir, rel) 写回
 * $DSH_HOME/dsh-config-manager/<rel>；ZIP 内位于 self/<rel>。
 *
 * 安全不变量：配置文件本身不含凭据值（同步凭据走 DSH credentials 槽位引用），
 * 且文件类分区不进 SecretScanner（与 pluginFiles/skills 同语义）。
 */
import path from 'node:path';
import { msgOf } from '../core/messages.ts';
import type { ExportOptions, ExportSection, HostContext } from '../core/types.ts';
import type { FilesSection } from '../schema/types.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { FileCollectionAdapter } from './file-collection.ts';

/** self 分区白名单文件（相对 baseDir，即 $DSH_HOME/dsh-config-manager/）。 */
export const SELF_CONFIG_FILES: readonly string[] = [
  'sync/sync-config.json',
  'sync/sync-autosync.json',
  'sync/sync-selection.json',
  'sync/ui-prefs.json',
  'market/market-config.json',
];

export class SelfAdapter extends FileCollectionAdapter {
  readonly id = 'self' as const;
  readonly displayName = 'Plugin Self Config';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  /** 插件自身配置目录（相对 homeDir；宿主按 dataDir 解析注入，缺省 dsh-config-manager） */
  readonly baseDir: string;

  constructor(baseDir = 'dsh-config-manager') {
    super();
    this.baseDir = baseDir;
  }

  /** 白名单收集：只导出配置类文件（存在才收），不递归（排除快照/历史/缓存/临时产物）。
   *  relativePath 产出相对 baseDir 的路径（与 analyzeImport/applyItem 的 path.join(baseDir, ref) 匹配）。 */
  override async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const warnings: string[] = [];
    for (const rel of SELF_CONFIG_FILES) {
      // ctx.fs.readFile 语义 = 相对 homeDir 的完整路径 → 拼接 baseDir；产出仍为相对 baseDir
      const data = await ctx.fs.readFile(path.join(this.baseDir, rel)).catch(() => null);
      if (data === null) continue; // 未创建过的配置文件跳过（如从未配置市场/同步）
      files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
    }
    if (files.length === 0) {
      warnings.push(msgOf(ctx)('adapter.dirEmpty', { type: this.displayName }));
    }
    return {
      sectionId: this.id,
      data: { version: 1, files },
      counts: { files: files.length },
      warnings,
    };
  }
}

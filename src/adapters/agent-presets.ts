/**
 * agentPresets 分区 adapter（设计 §3.3）：
 * 数据源 = ~/.dsh/.agent-presets/（用户可写目录，每预设一个目录：agent.cordis.yml + preset.yml）。
 * system 预设（安装目录）只记引用不复制（本 adapter 只读用户目录）。
 */
import { FileCollectionAdapter } from './file-collection.ts';
import { sectionMeta } from '../schema/section-registry.ts';

export class AgentPresetsAdapter extends FileCollectionAdapter {
  readonly id = 'agentPresets' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('agentPresets').displayName;
  readonly defaultIncluded = sectionMeta('agentPresets').defaultIncluded;
  readonly portability = sectionMeta('agentPresets').portability;
  readonly baseDir = '.agent-presets';
}

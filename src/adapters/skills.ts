/**
 * skills 分区 adapter（设计 §3.3）：
 * 数据源 = ~/.dsh/skills/（flat .md + 目录 bundle；dsh-skill-filesystem 发现）。
 * 仅迁移用户主目录技能；~/.agents/skills、项目级技能默认不迁（研究报告 §2.2）。
 */
import { FileCollectionAdapter } from './file-collection.ts';
import { sectionMeta } from '../schema/section-registry.ts';

export class SkillsAdapter extends FileCollectionAdapter {
  readonly id = 'skills' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('skills').displayName;
  readonly defaultIncluded = sectionMeta('skills').defaultIncluded;
  readonly portability = sectionMeta('skills').portability;
  readonly baseDir = 'skills';
}

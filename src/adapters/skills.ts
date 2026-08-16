/**
 * skills 分区 adapter（设计 §3.3）：
 * 数据源 = ~/.dsh/skills/（flat .md + 目录 bundle；dsh-skill-filesystem 发现）。
 * 仅迁移用户主目录技能；~/.agents/skills、项目级技能默认不迁（研究报告 §2.2）。
 */
import { FileCollectionAdapter } from './file-collection.ts';

export class SkillsAdapter extends FileCollectionAdapter {
  readonly id = 'skills' as const;
  readonly displayName = 'Skills';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  readonly baseDir = 'skills';
}

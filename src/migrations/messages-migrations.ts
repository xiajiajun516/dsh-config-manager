/**
 * 迁移链领域消息目录（zh 源 / en 镜像）。
 *
 * 为什么不放在 src/core/messages-core.ts：架构边界（tests/architecture-boundaries.test.ts）
 * 规定 src/migrations/** 只允许依赖 node 内置 / 自身 / ../schema / ../utils，
 * **不得 import ../core** —— 迁移链必须保持对 core 零耦合（core 消费它，不能反过来）。
 * 因此本目录自带一份零依赖的消息解析器：语言源由 core 侧接线（core → migrations 是允许方向，
 * 见 src/core/messages-core.ts 的 setMigrationLanguageSource），未接线时 = zh
 * （与迁移链改造前的行为逐字一致）。
 *
 * 纪律：
 *  - zh 值 = 改造前的中文字面量原样（逐字不变，既有测试断言依赖它）；
 *  - en 值类型 Record<keyof typeof zh, string>（缺键/多键即编译错误），必须纯英文；
 *  - 动态明细（版本号、from/to）一律以 {param} 插值传入。
 */
export const zh = {
  'migrations.stepConflict': '迁移步骤冲突: {stepFrom}→{stepTo} 与 {dupFrom}→{dupTo} 重叠',
  'migrations.schemaTooNew': '备份 schema v{from} 高于当前 v{target}，需升级本插件',
  'migrations.schemaTooOld': '备份 schema v{from} 低于最低支持 v{min}',
  'migrations.noPath': '没有从 schema v{from} 到 v{to} 的迁移路径',
  'migrations.stepNotAdvanced': '迁移步骤 {from}→{to} 未前进（注册表损坏）',
};

export const en: Record<keyof typeof zh, string> = {
  'migrations.stepConflict': 'Migration step conflict: {stepFrom}→{stepTo} overlaps {dupFrom}→{dupTo}',
  'migrations.schemaTooNew': 'Backup schema v{from} is newer than the current v{target}; upgrade this plugin',
  'migrations.schemaTooOld': 'Backup schema v{from} is older than the minimum supported v{min}',
  'migrations.noPath': 'No migration path from schema v{from} to v{to}',
  'migrations.stepNotAdvanced': 'Migration step {from}→{to} does not advance (corrupt registry)',
};

export type MigrationMessageKey = keyof typeof zh;
export type MigrationMessageParams = Readonly<Record<string, string | number>>;

let languageSource: () => 'zh' | 'en' = () => 'zh';

/** core 侧接线：让迁移链文案跟随引擎语言（core → migrations 是允许方向）。 */
export function setMigrationLanguageSource(resolve: () => 'zh' | 'en'): void {
  languageSource = resolve;
}

/** 插值：{param} → 形参值；缺参原样保留（与 engine-locale.ts 的 interpolate 同口径）。 */
function interpolate(template: string, params?: MigrationMessageParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * 迁移链的活翻译器：每次调用解析当前语言（默认 zh，绝不抛错），未知键回落键名。
 * 与 src/core/engine-locale.ts 的 engineMsg 同口径，只是不依赖 core。
 */
export function migMsg(key: MigrationMessageKey, params?: MigrationMessageParams): string {
  let lang: 'zh' | 'en' = 'zh';
  try { lang = languageSource() === 'en' ? 'en' : 'zh'; } catch { lang = 'zh'; }
  return interpolate((lang === 'en' ? en : zh)[key], params);
}

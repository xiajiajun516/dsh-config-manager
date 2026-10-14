/**
 * core 侧「分区清单派生」回归（t30）。
 *
 * 背景（审计 core-flow#F-10）：core 里曾各抄一份分区清单 —— `backup-plan.buildSectionFlags` 手抄 15 项、
 * `analyzer.APPLY_ORDER` 手抄 13 项、`backup.FILE_BASES` 手抄 6 项。任一处漏改都表现为**静默**行为偏差
 * （分区漏进 manifest / 执行顺序错 / 文件落到错位置），既有测试都发现不了。
 *
 * 本文件把三处钉在注册表（`src/schema/section-registry.ts`）上：
 *  - 静态面：`buildSectionFlags` / `APPLY_ORDER` 的声明里不得再出现分区 id 字面量清单；
 *  - 行为面：键集合 == 注册表分区全集；真实分区的执行顺序逐项等于历史顺序（行为等价）；
 *  - 漂移面：离线三清单（默认/可选/不可用）必须覆盖注册表全集 —— 新增分区必须显式归类。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_BACKUP_SECTIONS, OFFLINE_BACKUP_SECTIONS, OFFLINE_EXCLUDED_SECTIONS, OFFLINE_UNAVAILABLE_SECTIONS,
  OPT_IN_BACKUP_SECTIONS,
  buildSectionFlags,
} from './backup-plan.ts';
import { APPLY_ORDER } from './analyzer.ts';
import { resolveFileTarget } from './backup.ts';
import { SECTION_IDS, isFileSection, requireSectionMeta } from '../schema/config.ts';
import type { HostContext } from './types.ts';
import type { SectionId } from '../schema/types.ts';

/** src/ 根目录（相对本测试文件：core/ → src/） */
const SRC_ROOT = path.resolve(import.meta.dirname, '..');

async function source(rel: string): Promise<string> {
  return fs.readFile(path.join(SRC_ROOT, rel), 'utf8');
}

/** 取出某个函数的声明体（供静态面断言：该函数内不得出现分区 id 字面量） */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `源码里找不到 ${signature}`);
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n}', open);
  assert.notEqual(close, -1, `${signature} 的函数体未闭合`);
  return src.slice(open, close);
}

/* ------------------------------------------------------------ buildSectionFlags */

test('buildSectionFlags：键集合 == 注册表分区全集（既不漏项也不虚报）', () => {
  const flags = buildSectionFlags(['skills', 'self']);
  assert.deepEqual(Object.keys(flags).sort(), [...SECTION_IDS].sort(), '键集合必须等于注册表分区全集');
  assert.equal(flags.skills, true);
  assert.equal(flags.self, true);
  for (const id of SECTION_IDS) {
    if (id === 'skills' || id === 'self') continue;
    assert.equal(flags[id], false, `未收集分区 ${id} 必须为 false（绝不虚报）`);
  }
});

test('buildSectionFlags：源码不再手抄分区清单（由注册表派生；修复前该用例失败）', async () => {
  const body = functionBody(await source('core/backup-plan.ts'), 'export function buildSectionFlags');
  const literalIds = SECTION_IDS.filter((id) => body.includes(`'${id}'`));
  assert.deepEqual(literalIds, [], `buildSectionFlags 内不得出现分区 id 字面量：${literalIds.join(', ')}`);
  assert.ok(body.includes('SECTION_IDS'), '必须消费注册表导出的 SECTION_IDS，而不是自带一份全集');
});

/* ------------------------------------------------------------ APPLY_ORDER */

/** 历史 APPLY_ORDER 的真实分区顺序（P1-1 起含 self）——行为等价的黄金基准 */
const HISTORICAL_APPLY_ORDER: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'prompts', 'skills', 'agentPresets',
  'agentInstructions', 'workspaces', 'pluginFiles', 'mcp', 'plugins', 'credentialsStatus',
  'self',
];

test('APPLY_ORDER：真实分区的相对顺序逐项等于历史顺序（行为等价），且覆盖注册表全集', () => {
  assert.deepEqual(
    APPLY_ORDER.filter((id) => HISTORICAL_APPLY_ORDER.includes(id)),
    HISTORICAL_APPLY_ORDER,
    '导入执行顺序（真实分区）必须与历史逐项一致',
  );
  assert.deepEqual([...APPLY_ORDER].sort(), [...SECTION_IDS].sort(), '注册表全集都必须有序位（新增分区自动落在默认相位，不被静默漏掉）');
});

test('APPLY_ORDER：源码不再手抄分区清单（由注册表 SECTION_IDS 派生；修复前该用例失败）', async () => {
  const src = await source('core/analyzer.ts');
  assert.equal(
    src.includes("'settings', 'ui', 'providers', 'prompts'"),
    false,
    'APPLY_ORDER 不得再手抄分区清单（应改为 SECTION_IDS × 相位策略）',
  );
  assert.ok(
    /export const APPLY_ORDER[\s\S]{0,200}SECTION_IDS/.test(src),
    'APPLY_ORDER 必须由注册表 SECTION_IDS 派生（相位策略只表达相对先后）',
  );
});

/* ------------------------------------------------------------ 离线三清单 */

test('离线分区清单：id 必须都是已注册分区（拼错/改名不再静默失效）', () => {
  for (const id of [...DEFAULT_BACKUP_SECTIONS, ...OPT_IN_BACKUP_SECTIONS, ...OFFLINE_BACKUP_SECTIONS, ...OFFLINE_UNAVAILABLE_SECTIONS]) {
    assert.ok(requireSectionMeta(id) !== null, `${id} 必须是已注册分区`);
  }
});

test('离线分区清单：注册表所有分区都必须显式归类（可收集 / 离线不可用 / 明确不参与）', () => {
  // 「明确不参与离线」：sessions 体量巨大且属用户数据（GUI 侧单独 opt-in）、secrets 无分区载荷
  // （凭据值走独立加密容器）。二者都不在 CLI 离线备份的目标集合内 —— 但必须**显式**列出，
  // 否则新增分区会被静默漏收/漏报。
  // pluginData / pluginAssets 也在此列（第三方插件数据的收集依赖 adapter 的来源注册表；
  // 见 backup-plan.ts 的 OFFLINE_EXCLUDED_SECTIONS —— 直接引用产品常量，避免测试与实现各抄一份）
  const NOT_OFFLINE_APPLICABLE: readonly SectionId[] = [
    'sessions', 'secrets', ...OFFLINE_EXCLUDED_SECTIONS,
  ];
  const classified = new Set<string>([...OFFLINE_BACKUP_SECTIONS, ...OFFLINE_UNAVAILABLE_SECTIONS, ...NOT_OFFLINE_APPLICABLE]);
  assert.deepEqual([...classified].sort(), [...SECTION_IDS].sort(), '新增分区必须在 backup-plan 里显式归类');
});

/* ------------------------------------------------------------ FILE_BASES */

test('resolveFileTarget：文件类分区都有明确根（$DSH_HOME 内，或系统 home 根的那两个分区）', () => {
  // 文件本来就在 $DSH_HOME 根的分区：AGENTS.md / 插件自有文件白名单
  const HOME_ROOT_SECTIONS: readonly SectionId[] = ['agentInstructions', 'pluginFiles'];
  // **系统 home 为根**的分区（第三方插件数据）：$DSH_HOME 之外的第二个根，见 backup.ts 的 fsForSection
  const OS_HOME_SECTIONS: readonly SectionId[] = ['pluginData', 'pluginAssets'];
  const ctx = {
    homeDir: path.join('C:', 'home', '.dsh'),
    osHomeDir: path.join('C:', 'home'),
    profile: 'web',
  } as unknown as HostContext;
  const atHomeRoot = path.join(ctx.homeDir, 'probe.txt');
  for (const id of SECTION_IDS.filter((s) => isFileSection(s))) {
    const target = resolveFileTarget(ctx, id, 'probe.txt');
    if (OS_HOME_SECTIONS.includes(id)) {
      assert.equal(target, path.join(ctx.osHomeDir as string, 'probe.txt'), `${id} 的根必须是系统 home`);
      continue;
    }
    assert.ok(target.startsWith(ctx.homeDir), `${id} 的目标必须在 homeDir 下: ${target}`);
    if (HOME_ROOT_SECTIONS.includes(id)) {
      assert.equal(target, atHomeRoot, `${id} 是 home 根分区`);
    } else {
      assert.notEqual(
        target,
        atHomeRoot,
        `${id} 缺基准目录时会静默写到 homeDir 根（FILE_BASES 漏项 = 静默写错位置）`,
      );
    }
  }
});

test('FILE_BASES：完整性由注册表派生校验（源码静态面；修复前该用例失败）', async () => {
  const src = await source('core/backup.ts');
  assert.ok(
    src.includes('SECTION_IDS') && src.includes('isFileSection('),
    'FILE_BASES 必须按注册表逐项校验「每个文件类分区都有基准目录」，而不是靠人工维护',
  );
});

/* ------------------------------------------------------------ skippedLinks 措辞（cli-F2 残留，t37） */

/**
 * cli-F2 修好后，recursive-walk 对**普通目录**超过深度上限也记 too-deep（原先只有链接记）。
 * backup-plan 的告警前缀过去一律写「链接未进备份」→「内容为什么缺」的原因被误述成链接问题。
 * 判据：普通目录超深 → 措辞指向层级上限；链接类跳过（越界/断链/自引用）→ 仍写「链接未进备份」。
 */
test('t37 skippedLinks 措辞：普通目录超深不得被描述成「链接」问题（修复前失败）', async () => {
  const os = await import('node:os');
  const { collectBackupEntries } = await import('./backup-plan.ts');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-bp-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-out-'));
  try {
    // (a) 普通目录超深：skills/d/d/…（70 层 > 内核 MAX_DEPTH=64）
    let deepAbs = path.join(home, 'skills');
    for (let i = 0; i < 70; i++) deepAbs = path.join(deepAbs, 'd');
    await fs.mkdir(deepAbs, { recursive: true });
    await fs.writeFile(path.join(deepAbs, 'leaf.json'), '{}');
    // (b) 链接类跳过：junction 指向 home 之外（Windows 上建 junction 不需要管理员）
    await fs.symlink(outside, path.join(home, 'skills', 'outlink'), 'junction');

    const plan = await collectBackupEntries(home, ['skills']);
    const depthLine = plan.warnings.find((w) => w.includes('（too-deep）'));
    const linkLine = plan.warnings.find((w) => w.includes('outlink'));
    assert.ok(depthLine !== undefined, '普通目录超深必须写进 warnings（绝不静默）：' + plan.warnings.join(' | '));
    assert.ok(linkLine !== undefined, '链接越界必须写进 warnings：' + plan.warnings.join(' | '));
    assert.match(depthLine, /层级超过上限/, '普通目录超深的原因必须指向层级上限，实际：' + depthLine);
    assert.doesNotMatch(depthLine, /链接未进备份/, '普通目录超深不得被描述成链接问题，实际：' + depthLine);
    assert.match(linkLine, /链接未进备份/, '链接类跳过仍必须是链接措辞，实际：' + linkLine);
    // issue #76 附带修正：内核返回的已是 homeDir 相对路径，**不得再叠一层分区前缀**（曾打印成 skills/skills/outlink）
    assert.match(linkLine, /skills\/outlink（/, '路径必须只出现一次且为 homeDir 相对形态，实际：' + linkLine);
    assert.doesNotMatch(linkLine, /skills\/skills\//, '不得叠加分区前缀（skills/skills/…），实际：' + linkLine);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('issue #76：离线备份跳过 skills 下的 node_modules，并在 warnings 里说明（真机形态）', async () => {
  const os = await import('node:os');
  const { collectBackupEntries } = await import('./backup-plan.ts');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-bp-deps-'));
  try {
    const nm = path.join(home, 'skills', 'md2pdf', 'node_modules', 'marked');
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(home, 'skills', 'md2pdf', 'SKILL.md'), 'S');
    await fs.writeFile(path.join(home, 'skills', 'md2pdf', 'package.json'), '{}');
    await fs.writeFile(path.join(nm, 'index.js'), 'M');
    await fs.writeFile(path.join(nm, 'extra.js'), 'M');

    const plan = await collectBackupEntries(home, ['skills']);
    const names = plan.entries.map((e) => e.name);
    assert.ok(names.some((n) => n.endsWith('md2pdf/SKILL.md')), '技能本体必须进归档: ' + names.join(','));
    assert.ok(names.some((n) => n.endsWith('md2pdf/package.json')), 'package.json 必须进归档（目标机据此重建依赖）');
    assert.deepEqual(names.filter((n) => n.includes('node_modules/')), [], '依赖树不得进归档: ' + names.join(','));
    const line = plan.warnings.find((w) => w.includes('运行时依赖目录')) ?? '';
    assert.ok(line.length > 0, '缺依赖目录告警: ' + plan.warnings.join(' | '));
    assert.match(line, /2 个文件/, '必须报出被跳过的文件数量级');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

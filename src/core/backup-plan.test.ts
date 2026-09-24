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
  DEFAULT_BACKUP_SECTIONS, OFFLINE_BACKUP_SECTIONS, OFFLINE_UNAVAILABLE_SECTIONS, OPT_IN_BACKUP_SECTIONS,
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
  const NOT_OFFLINE_APPLICABLE: readonly SectionId[] = ['sessions', 'secrets'];
  const classified = new Set<string>([...OFFLINE_BACKUP_SECTIONS, ...OFFLINE_UNAVAILABLE_SECTIONS, ...NOT_OFFLINE_APPLICABLE]);
  assert.deepEqual([...classified].sort(), [...SECTION_IDS].sort(), '新增分区必须在 backup-plan 里显式归类');
});

/* ------------------------------------------------------------ FILE_BASES */

test('resolveFileTarget：文件类分区都有明确基准目录（除两个 home 根分区外不得落 homeDir 根）', () => {
  // 只有这两个分区的文件**本来就在** $DSH_HOME 根（AGENTS.md / 插件自有文件白名单）
  const HOME_ROOT_SECTIONS: readonly SectionId[] = ['agentInstructions', 'pluginFiles'];
  const ctx = { homeDir: path.join('C:', 'home', '.dsh'), profile: 'web' } as unknown as HostContext;
  const atHomeRoot = path.join(ctx.homeDir, 'probe.txt');
  for (const id of SECTION_IDS.filter((s) => isFileSection(s))) {
    const target = resolveFileTarget(ctx, id, 'probe.txt');
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

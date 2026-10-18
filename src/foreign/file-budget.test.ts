/**
 * `src/foreign/` 的**体积停止线护栏**（三档，可机械触发）。
 *
 * 为什么要有这份护栏（t4，档 B 前置）：竞品 dsh-chat-import 的 1000/800 行纪律**只写在
 * AGENTS.md**，零自动兜底 —— 结果它**自己已经越线**（discovery.mjs 2285 行 / tools.mjs 1557 行，
 * 见 outputs/competitor-recon-2026-10-05/read-chat-import.md §7.3 与 read-vault.md §9）。
 * 本仓库的 7/8/9 个来源马上要落地，若没有机械停止线，「加一个来源」会以「往同一个文件里
 * 再塞一段」的形态腐化，而**没有任何红灯**。
 *
 * 三档（各自独立、都能单独红）：
 *  A. **行数闸门**：`src/foreign/` 下全部手维护的 `.ts`（排除 `*.test.ts` 与 fixtures）逐档限额，
 *     超线即 fail，**失败消息自带拆分指引**（第一句就告诉你去拆哪、怎么拆）。
 *  B. **分层 import 白名单**：`src/foreign/**` 里 import `node:fs`/`node:fs/promises` 的模块集合
 *     必须**恰好等于**白名单 —— 往翻译层（纯函数层）里 import fs 一律红灯。
 *  C. **来源形状枚举**：每个来源 id 必须恰好有 `read-<id>.ts` + `<id>.ts` 两个模块，
 *     且**多一个、少一个都红**（这是「同一来源的解析/发现逻辑出现第 3 处副本」唯一可机械化的近似）。
 *
 * 范式来自本仓库既有的源码级守卫：`tests/packaging-contract.test.ts`（正则读源码，不 import 宿主）
 * 与 `tests/route/route-fence.test.ts`（结构守卫「绕过 kit 就红」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { FOREIGN_SOURCE_IDS } from './registry.ts';
import { FOREIGN_SOURCE_MODULE_SHAPES } from './source-modules.ts';

const FOREIGN_DIR = import.meta.dirname;

/* ---------------- A. 行数闸门 ---------------- */

/**
 * 两档行数上限（与竞品同口径：翻译层 800 / 读盘层 1000）。
 *
 * `read-<id>.ts` = 读盘层（host 面，含路径真值表与文件遍历）→ 1000；
 * 其余手维护的 `src/foreign/*.ts` = 翻译层 / 共享内核 / 注册表 → 800。
 */
export const FOREIGN_LINE_BUDGETS = {
  /** 读盘层（`read-*.ts`） */
  reader: 1000,
  /** 翻译层 / 内核 / 注册表 / IR（其余一切手维护模块） */
  converter: 800,
} as const;

/**
 * 显式豁免清单（`<文件名>: <理由>`）。
 *
 * 语义与竞品**刻意不同**：它允许「提案未批准前继续只做 bugfix」的状态**可见**，而不是让
 * 超线变成改测试数字。往这里加条目 = 公开承认该文件欠一次拆分，评审时一眼可见。
 * 本仓库当前**没有**豁免项 —— 既有的 `registry.ts`（502 行）在限额内。
 */
export const FOREIGN_LINE_EXEMPT: Readonly<Record<string, string>> = {};

function budgetFor(name: string): number {
  return name.startsWith('read-') ? FOREIGN_LINE_BUDGETS.reader : FOREIGN_LINE_BUDGETS.converter;
}

/** 手维护的模块（排除测试与夹具；`lib/` 产物不在本目录） */
async function listForeignModules(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(FOREIGN_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue; // 测试不受体积线约束（它们不承载运行时逻辑）
    out.push(entry.name);
  }
  return out.sort();
}

test('A 行数闸门：手维护模块逐档限额，超线即红（失败消息自带拆分指引）', async () => {
  const files = await listForeignModules();
  assert.ok(files.length > 0, '扫描面不能为空（否则闸门形同虚设）');
  const violations: string[] = [];
  for (const name of files) {
    if (FOREIGN_LINE_EXEMPT[name] !== undefined) continue;
    const text = await fsp.readFile(path.join(FOREIGN_DIR, name), 'utf8');
    const lines = text.split('\n').length;
    const limit = budgetFor(name);
    if (lines > limit) {
      violations.push(
        name + ' —— ' + String(lines) + ' 行 / 上限 ' + String(limit) + ' 行（超出 ' + String(lines - limit) + ' 行）。\n' +
        '    拆法：① 纯函数部分搬进一个新的共享模块（`session-ir.ts` 就是为此而生的 IR 层）；\n' +
        '    ② 该来源特有的部分留在本源文件（`<id>.ts`）；③ 读盘/路径真值表留在 `read-<id>.ts`。\n' +
        '    若确需暂时超线：把文件名加进本文件的 FOREIGN_LINE_EXEMPT 并写明理由（评审可见）。',
      );
    }
  }
  assert.deepEqual(violations, [], 'src/foreign/ 有模块越过体积停止线：\n  ' + violations.join('\n  '));
});

test('A 行数闸门：豁免清单只允许放行真实存在且确实超线的模块（防止清单变成垃圾桶）', async () => {
  const files = await listForeignModules();
  for (const [name, reason] of Object.entries(FOREIGN_LINE_EXEMPT)) {
    assert.ok(files.includes(name), '豁免清单里的 ' + name + ' 不存在（清掉它）');
    assert.ok(reason.trim() !== '', name + ' 的豁免理由不能为空');
    const lines = (await fsp.readFile(path.join(FOREIGN_DIR, name), 'utf8')).split('\n').length;
    assert.ok(
      lines > budgetFor(name),
      name + ' 已回到限额内（' + String(lines) + ' ≤ ' + String(budgetFor(name)) + '），把豁免删掉',
    );
  }
});

/* ---------------- B. 分层 import 白名单 ---------------- */

/**
 * 允许 import `node:fs` / `node:fs/promises` 的模块，**恰好**是这些：
 *
 *  - `read-*.ts`：读盘层（host 面）—— 它的职责就是读别人的磁盘；
 *  - `registry.ts`：装配层，detect 只做 `stat` 探测（只 stat、绝不读内容）；
 *  - `claude-sessions.ts`：**只 import 类型**（`import type { Stats }`，零运行期 I/O），
 *    为将来「大文件只读头尾」的追加通道保留一个只读句柄形状。
 *
 * **`bundle.ts` 刻意不在名单里**（t4 实测核对）：它产出 zip 字节，但走的是 `utils/zip.ts`，
 * 自己**不 import `node:fs`**。白名单是「恰好相等」的集合，凭职责印象放进去会让断言变成
 * 永远的假绿（少一项却从不红）—— 加模块前先 grep `node:fs`，不要凭职责猜。
 *
 * 名单**恰好相等**（不是包含）：少一个 = 有人删了读盘层还没清理白名单；多一个 = 有人往
 * 翻译层/IR 层里 import 了 fs —— 那正是这条纪律要挡的事。
 *
 * 档 B 追加（2026-10-05，**逐个 grep `node:fs` 实测，不凭职责猜**；并在全部写者停下后再复 grep 一次）：
 *  - `session-read.ts`：会话类来源**共用**的读盘内核（listDirNames / readJsonSafe / statOrNull /
 *    readBytesSafe …），24 个会话来源里 t3/t4 的 read-*.ts **一律经它读盘**，自己不 import fs；
 *  - `read-gemini / read-kimi / read-qoder / read-workbuddy / read-qwen / read-continue / read-pi /
 *    read-openclaw`（t2 的 8 个读盘层）：各自直接 import fs；
 *  - `sqlite.ts`：**t9 起是宿主侧模块**（只读复制路线要 `node:fs/promises`），不是纯函数层 ——
 *    这一条与 t4 初版注释相反，是**复 grep 才发现**的（照抄旧注释会漏、凭职责猜也会漏）。
 *  反例（**确实不 import fs，不得加进来**）：`platform-paths.ts` / `session-source.ts` /
 *  `truth-table.ts`（kernel.ts / session-ir.ts 里的 "node:fs" 只出现在注释里）。
 */
export const FOREIGN_FS_IMPORT_ALLOWLIST: readonly string[] = [
  'claude-sessions.ts',
  'read-antigravity.ts',
  'read-claude-code.ts',
  'read-codex.ts',
  'read-continue.ts',
  'read-copilot.ts',
  'read-cursor.ts',
  'read-gemini.ts',
  'read-hermes.ts',
  'read-kimi.ts',
  'read-openclaw.ts',
  'read-pi.ts',
  'read-qoder.ts',
  'read-qwen.ts',
  'read-workbuddy.ts',
  'registry.ts',
  'session-read.ts',
  'sqlite.ts',
];

const FS_IMPORT_RE = /(?:^|\n)\s*import\s+(?:type\s+)?[^;\n]*?from\s+'node:fs(?:\/promises)?'/;

/**
 * **手维护的实现模块**（B/C 两档的适用面）——递归收集 `src/foreign/` 下的 .ts，
 * 跳过 fixtures / node_modules，**并排除 `*.test.ts`**。
 *
 * 为什么必须排除测试：测试要读 fixture，**天然**会 import `node:fs`；但「翻译层不许碰盘」
 * 的语义对象是**实现模块**，不是测试。A 档行数闸门本来就用了同一排除口径，B 档必须一致 ——
 * 否则护栏会把测试文件误报成「翻译层越界」，红灯指向错误的地方（t4 实测踩过一次）。
 */
async function listForeignImplementationTs(rel = ''): Promise<string[]> {
  const out: string[] = [];
  const abs = rel === '' ? FOREIGN_DIR : path.join(FOREIGN_DIR, rel);
  for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
    if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
    const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
    if (entry.isDirectory()) {
      out.push(...await listForeignImplementationTs(childRel));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue; // 测试不适用任何一档（与 A 档同口径）
    out.push(childRel);
  }
  return out.sort();
}

test('B 分层白名单：实现模块里 import node:fs 的集合恰好等于白名单（翻译层不许碰盘）', async () => {
  const all = await listForeignImplementationTs();
  const withFs: string[] = [];
  for (const rel of all) {
    const text = await fsp.readFile(path.join(FOREIGN_DIR, rel), 'utf8');
    if (FS_IMPORT_RE.test(text)) withFs.push(rel);
  }
  assert.deepEqual(
    withFs,
    [...FOREIGN_FS_IMPORT_ALLOWLIST].sort(),
    '读盘层与翻译层的边界被破坏：\n' +
    '  多出来的模块 = 往纯函数层 import 了 node:fs（翻译/IR 层必须零 I/O）；\n' +
    '  少掉的模块 = 读盘层被搬走或删掉，请同步更新白名单。\n' +
    '  实测：' + withFs.join(', '),
  );
});

test('B 分层白名单：IR 层与真值表模块绝不读盘（`session-ir.ts` 只允许纯计算内建）', async () => {
  // 这一条是白名单的**语义补强**：即便有人把 session-ir.ts 加进白名单也必须先红一次 ——
  // IR 是所有会话类来源共用的地基，掺进 I/O 就等于把「解析 → IR → 合成」三段式毁掉。
  for (const name of ['session-ir.ts', 'types.ts', 'kernel.ts', 'source-modules.ts']) {
    const text = await fsp.readFile(path.join(FOREIGN_DIR, name), 'utf8');
    assert.equal(FS_IMPORT_RE.test(text), false, name + ' 不得 import node:fs（纯函数层）');
    assert.equal(/from\s+'\.\/read-/.test(text), false, name + ' 不得 import 读盘层（方向是 read → convert → IR）');
  }
});

/* ---------------- C. 来源形状枚举 ---------------- */

test('C 来源形状：每个来源 id 恰好 `read-<id>.ts` + `<id>.ts`，多一个少一个都红', async () => {
  const all = await listForeignImplementationTs();
  const modules = new Set(all.filter((f) => !f.includes('/')));

  const actual: string[] = [];
  for (const shape of FOREIGN_SOURCE_MODULE_SHAPES) {
    for (const part of shape.modules) {
      if (!modules.has(part)) assert.fail('来源 ' + shape.id + ' 缺少模块 ' + part + '（形状枚举是单一事实源）');
      actual.push(part);
    }
  }
  assert.deepEqual(
    [...actual].sort(),
    [...modules].filter((m) => isSourceShaped(m)).sort(),
    '来源模块集合与形状枚举不一致：新增来源必须同时补 read-<id>.ts 与 <id>.ts，并登记进 source-modules.ts',
  );
});

/** 判据 = 该模块名是否「看起来属于某个来源」（`<id>.ts` 或 `read-<id>.ts`）；共享模块由下面的清单挡住 */
function isSourceShaped(name: string): boolean {
  const base = name.replace(/\.ts$/, '').replace(/^read-/, '');
  return FOREIGN_SOURCE_IDS.includes(base as (typeof FOREIGN_SOURCE_IDS)[number]);
}

test('C 来源形状：形状枚举与冻结词表逐项一致（漏配一处即红）', () => {
  assert.deepEqual(
    FOREIGN_SOURCE_MODULE_SHAPES.map((s) => s.id),
    [...FOREIGN_SOURCE_IDS],
    'source-modules.ts 必须与 registry.ts 的 FOREIGN_SOURCE_IDS 逐项同序',
  );
});

test('C 来源形状：共享模块清单是封闭集合（新模块必须显式登记，防止形状面悄悄扩容）', async () => {
  const all = await listForeignImplementationTs();
  const modules = all.filter((f) => !f.includes('/'));
  const shared = modules.filter((m) => !isSourceShaped(m));
  const expected = [
    'bundle.ts', 'claude-sessions.ts', 'kernel.ts',
    /* t6 新增：本域追加消息目录（零 source 形状；中文只在这里，装配期抛错的文案经 engineMsg 取）。 */
    'messages.ts',
    /* 档 B 新增的 5 个共享地基（零 source 形状，但也不是来源模块）： */
    'platform-paths.ts',
    /* 2026-10-18 新增：Claude Code 插件/市场读盘层（名字不含来源 id，故不是来源形状模块；
       它是 claude-code 专属读盘子模块，由 read-claude-code.ts 动态 import）。清单按字母序比较。 */
    'read-claude-plugins.ts', 'registry.ts', 'session-ir.ts', 'session-read.ts', 'session-source.ts',
    'source-modules.ts', 'sqlite.ts', 'truth-table.ts', 'types.ts',
  ];
  assert.deepEqual(
    shared.sort(),
    expected,
    'src/foreign/ 顶层的共享模块集合变了：新共享模块要在本用例里登记（并想清楚它属于哪一层）',
  );
});

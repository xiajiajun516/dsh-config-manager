/**
 * 客户端路由一致性守卫（W4）：**客户端路由常量 ↔ 宿主路由字面量** 对账。
 *
 * 为什么需要它（审计 client-state#F-06）：客户端路由此前是 7 份手写字面量，拼错即 404，
 * 而 404 会被 `readJson` 映射成「插件未挂载」—— 把配置错误伪装成部署问题。
 * 收敛到 `common/routes.ts` 后，这条源码级对账把「客户端存在的路径」与「宿主注册的路径」钉在一起。
 *
 * 与 W1 的分工：`tests/route/route-parity.test.ts` 钉**宿主侧**路由清单快照（宿主自己不许漏或多），
 * 本条钉**客户端侧**路由常量必须命中宿主路由集合（方向相反，互补）。
 *
 * 解析口径（行级结构锚点，不用整文件 tokenizer —— 后者会被正则字面量里的引号带偏）：
 *  - 扫 `src/index.ts` 与 `src/routes/` 目录下的全部 .ts（W1 已把路由拆到 routes 目录）；
 *  - 逐行取 `'/api/dsh-config-manager…'` 字面量（宿主用 `API.<name>` 常量表登记路由，
 *    常量值就是字面量，所以常量表所在文件也在扫描范围内）；
 *  - 注释行（`//` / `*` / `/*` 开头）整行跳过，且同行 `//` 之后的匹配也跳过。
 *    **宁严不松**：漏采=红（安全），多采=绿（危险）；
 *  - 负向自检见 parity-00：合成样本里注释中的假路径必须不被采信。
 *
 * 例外：宿主 **prefix 路由**（recovery：只注册前缀，子路径由宿主内部按 path 分发，
 * 没有逐条字面量）在 `PREFIX_ROUTED` 里显式登记，按前缀覆盖校验。新客户端路径若在宿主找不到
 * （或宿主 prefix 集合变了）→ 本测试点名，必须显式登记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_BASE,
  CONFIG_MANAGER_API,
  HISTORY_API,
  INCIDENT_API,
  MARKET_API,
  MY_CONFIGS_API,
  RECOVERY_API,
  ROLLBACK_POINT_ROUTES,
  SYNC_API,
} from './routes.ts';

/** 仓库根（本文件位于 src/client/common/） */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 全部路由族（新增路由族必须登记在这里，否则本测试看不到它）。 */
const ROUTE_FAMILIES: readonly Record<string, string>[] = [
  CONFIG_MANAGER_API, SYNC_API, MARKET_API, MY_CONFIGS_API, INCIDENT_API, RECOVERY_API, HISTORY_API,
];

/**
 * 宿主 prefix 路由覆盖的客户端路径：宿主只注册前缀（`API.recovery`），
 * 子路径由宿主内部按 path 分发，因此没有逐条宿主字面量。
 */
const PREFIX_ROUTED = new Set<string>([





  RECOVERY_API.status,
  RECOVERY_API.lockRecover,
  // T5：会话体检（只读）—— 同样由 recovery prefix 路由内部按 path 分发（`segments[0] === 'sessions'`）。
  // 终端用户可见的后果：这条路径**不会**新增宿主注册路由条目，因此 route-parity 的 71 条快照不变。
  RECOVERY_API.sessions,
  // issue #56：显式解除 SAFE MODE —— 同样由 recovery prefix 路由内部按 path 分发
  // （`segments[0] === 'safe-mode'`），不新增宿主注册路由条目。
  RECOVERY_API.safeModeClear,
  // T8：应用内会话修复（写路径）—— 由 recovery prefix 路由内部按 path 分发
  // （`segments[0] === 'sessions'` 下的 `repair` / `rollback` 子路径），不新增宿主注册路由条目。
  RECOVERY_API.sessionsRepair,
  RECOVERY_API.sessionsRollback,
  // S7：rollback-points（工作区 + 会话回滚，两态）—— 由 recovery prefix 路由内部按 path 分发
  // （`segments[0] === 'rollback-points'` 下的 storage / <id>/{preview,rewind,delete}），
  // 不新增宿主注册路由条目，因此 route-parity 的 79 条快照不变。
  RECOVERY_API.rollbackPoints,
  RECOVERY_API.rollbackPointsStorage,
  // issue #88 / #89：留点开关（prefs）与台账清理（cleanup）—— 同样挂在 rollback-points 这一段
  // 之下、由 recovery prefix 路由内部按 path 分发，因此不新增宿主注册路由条目。
  // 它们**不进** `ROLLBACK_POINT_ROUTES`：那张表是 t1 冻结的 7 条 wire contract 快照
  //（6 条冻结 + 只读 file-diff），这里两条是后加的行为开关，不参与冻结集。
  RECOVERY_API.rollbackPointsPrefs,
  RECOVERY_API.rollbackPointsCleanup,
]);

/**
 * rollback-points 族的**端点 ↔ RecoveryApi 方法**一一对账（S7 / T2）。
 *
 * `<id>` 是占位符（不是可直接请求的路径），所以这些子路径不进 `RECOVERY_API`（也就不进
 * `clientPaths()` 的宿主字面量对账）；但「客户端声明了哪 7 条端点、实现了哪 7 个方法」必须
 * 两边都齐 —— 少了 = 界面点了 404，多了 = 死代码或改错方向。
 */
const ROLLBACK_POINT_ENDPOINTS: readonly string[] = [
  RECOVERY_API.rollbackPoints,
  RECOVERY_API.rollbackPointsStorage,
  `${RECOVERY_API.rollbackPoints}/<id>`,
  `${RECOVERY_API.rollbackPoints}/<id>/preview`,
  `${RECOVERY_API.rollbackPoints}/<id>/file-diff`,
  `${RECOVERY_API.rollbackPoints}/<id>/rewind`,
  `${RECOVERY_API.rollbackPoints}/<id>/delete`,
];

/** 客户端 api 文件（对账对象；与 http-usage-guard 的收敛范围同源）。 */
const RECOVERY_API_FILE = 'src/client/recovery/recovery-api.ts';

function readClientSource(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 源码里声明的异步方法名（`async name(`）。 */
function declaredAsyncMethods(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/^\s*async\s+([A-Za-z0-9_]+)\s*\(/gm)) out.push(match[1] as string);
  return out;
}

const ROUTE_LITERAL = /'(\/api\/dsh-config-manager[^']*)'/g;

/** 从宿主源码提取路由字面量（行级；注释整行/同行注释后都不采信）。 */
function extractHostPaths(source: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const match of line.matchAll(ROUTE_LITERAL)) {
      const before = line.slice(0, match.index ?? 0);
      if (before.includes('//')) continue;
      out.add(match[1] as string);
    }
  }
  return out;
}

function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTs(full, out);
    else if (/\.ts$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 宿主路由源码：src/index.ts + src/routes/**（W1 拆分后的落点）。 */
function hostRouteSources(): string[] {
  const files = [path.join(ROOT, 'src', 'index.ts')];
  const routesDir = path.join(ROOT, 'src', 'routes');
  if (fs.existsSync(routesDir)) collectTs(routesDir, files);
  return files;
}

/** 宿主侧全部路由字面量。 */
function hostRouteLiterals(): Set<string> {
  const literals = new Set<string>();
  for (const file of hostRouteSources()) {
    for (const value of extractHostPaths(fs.readFileSync(file, 'utf8'))) literals.add(value);
  }
  return literals;
}

/** 客户端请求路径（跳过 `base`：那是路径拼接前缀，不是请求目标）。 */
function clientPaths(): string[] {
  const out = new Set<string>();
  for (const family of ROUTE_FAMILIES) {
    for (const [key, value] of Object.entries(family)) {
      if (key === 'base') continue;
      out.add(value);
    }
  }
  return [...out].sort();
}

function prefixCovered(value: string, literals: Set<string>): boolean {
  for (const literal of literals) {
    if (value === literal || value.startsWith(literal + '/')) return true;
  }
  return false;
}

test('parity-00 提取器自检：注释里的假路径不采信、真实字面量采信；宿主扫描不空转', () => {
  const sample = [
    "// 注释里的 '/api/dsh-config-manager/ghost'",
    " * 文档注释里的 '/api/dsh-config-manager/ghost2'",
    "/* 块注释里的 '/api/dsh-config-manager/ghost3' */",
    "  status: '/api/dsh-config-manager/status',",
    "  export: '/api/dsh-config-manager/export',",
    "const u = 'http://x'; // '/api/dsh-config-manager/ghost4'",
  ].join('\n');
  assert.deepEqual(
    [...extractHostPaths(sample)].sort(),
    ['/api/dsh-config-manager/export', '/api/dsh-config-manager/status'],
    '只有真实代码行里的字面量能进入集合（回退即红：注释里的假路径会让本断言失败）',
  );
  const literals = hostRouteLiterals();
  assert.ok(literals.size >= 40, `宿主路由字面量只扫到 ${literals.size} 条，路由来源/扫描器可能已变更（W1 之前是 65 条）`);
  assert.ok(literals.has('/api/dsh-config-manager/status'), '宿主扫描至少应包含 /status');
});

test('parity-01 客户端路由都在 API_BASE 命名空间内', () => {
  for (const p of clientPaths()) {
    assert.ok(p.startsWith(API_BASE + '/'), `客户端路由 ${p} 不在 ${API_BASE} 下`);
  }
});

test('parity-02 客户端每个路由都能在宿主路由源码里找到（精确命中，prefix 路由除外）', () => {
  const literals = hostRouteLiterals();
  const missing = clientPaths().filter((p) => !PREFIX_ROUTED.has(p) && !literals.has(p));
  assert.deepEqual(
    missing,
    [],
    '这些客户端路由在宿主路由源码里没有同名（或新增为 prefix 路由后未登记）——拼错即 404，且会被伪装成「插件未挂载」',
  );
});

test('parity-03 prefix 路由（recovery）确有宿主前缀字面量覆盖', () => {
  const literals = hostRouteLiterals();
  for (const p of PREFIX_ROUTED) {
    assert.ok(prefixCovered(p, literals), `prefix 路由 ${p} 没有对应的宿主前缀字面量（宿主路由可能改名/迁移）`);
  }
});

test('parity-05 rollback-points 族：7 条端点与 RecoveryApi 方法一一对账（两个方向）', () => {
  const entries = Object.values(ROLLBACK_POINT_ROUTES);
  assert.equal(entries.length, 7, 'rollback-points 族必须恰好 7 条端点（6 条冻结契约 + 只读 file-diff）');
  assert.deepEqual(
    entries.map((entry) => entry.path).sort(),
    [...ROLLBACK_POINT_ENDPOINTS].sort(),
    '端点清单必须与冻结契约逐字一致（多一条=死代码，少一条=界面打不出去）',
  );

  // ① 每条端点都必须是 recovery prefix 下的子路径（\`<id>\` 占位符只能是 id 段，不能拼错层级）
  const literals = hostRouteLiterals();
  for (const entry of entries) {
    assert.ok(
      entry.path === RECOVERY_API.rollbackPoints
        || entry.path === RECOVERY_API.rollbackPointsStorage
        || entry.path.startsWith(RECOVERY_API.rollbackPoints + '/<id>'),
      '端点 ' + entry.path + ' 不在 rollback-points 族下（拼错即 404）',
    );
    assert.ok(prefixCovered(entry.path, literals), '端点 ' + entry.path + ' 没有宿主 recovery 前缀字面量覆盖');
  }

  // ② 正向：每个方法都必须真的在 RecoveryApi 里实现（名字改了/删了就红）
  const source = readClientSource(RECOVERY_API_FILE);
  const declared = declaredAsyncMethods(source);
  for (const entry of entries) {
    assert.ok(
      declared.includes(entry.method),
      'RecoveryApi 里没有 ' + entry.method + '() —— 端点 ' + entry.path + ' 缺少实现',
    );
  }

  // ③ 反向：rollback-points 族的方法不得游离在表外（死代码 / 改错名）
  const tableMethods = new Set(entries.map((entry) => entry.method));
  const familyMethods = declared.filter((name) => /^(rollbackPoint|restoreRollbackPoint|removeRollbackPoint)/.test(name));
  assert.deepEqual(
    [...familyMethods].sort(),
    [...tableMethods].sort(),
    'rollback-points 族方法与 \`ROLLBACK_POINT_ROUTES\` 必须一一对应（旧 checkpoint* 方法不在本族内）',
  );
});

test('parity-04 未精确命中的客户端路由必须已在 PREFIX_ROUTED 显式登记', () => {
  const literals = hostRouteLiterals();
  const unregistered = clientPaths().filter((p) => !literals.has(p) && !PREFIX_ROUTED.has(p));
  assert.deepEqual(unregistered, [], '新增客户端路由要么在宿主有同名路由，要么在 PREFIX_ROUTED 显式登记');
});

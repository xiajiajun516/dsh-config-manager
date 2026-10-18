/**
 * W1 路由拆分安全网：**路由清单 parity 快照**（改造前先跑绿，重构后逐条一致）。
 *
 * 最新增量（T-ui-merge，2026-10-18）：`POST /sync/merge-preview`（只读三方合并预览）与
 * `POST /sync/apply-merge`（按分区级裁决执行，过 mutation gate）→ **81**；
 * 并行会话的 `POST /sync/probe`（通道连通性自检，只读）→ **82**。
 * （`POST /sync/inventory` 曾把计数抬到 83，2026-10-18 按用户要求整项移除 → 回到 **82**。）
 * `/sync/inventory` 移除后 `/sync/probe` 与 `/sync/download` 之间不再有端点，两者紧邻。
 *
 * 快照来源：2026-09-23 W1 动结构**之前**的 \`src/index.ts\` 的 \`routesList\`（67 条声明 /
 * 68 个 (method,path) 组合；其中 recovery 为 prefix 路由）。
 * 后续增量：m-disk-usage 新增 `GET /disk-usage` 与 `POST /disk-usage/cleanup` → 70；
 * m-update-check 新增 `GET /update-check` → **71**。
 * 「拉取即导入」新增 `POST /sync/download` → **72**（宿主把远端快照落地成本机 ZIP）。
 * 产物库「远端快照 → 删除」新增 `POST /sync/snapshot-delete` → **73**（只删远端那一份）。
 * 外部 agent 导入收口（t22）新增 `GET /foreign-sources`（六来源本机发现，只读）→ **74**。
 * GUI 入口接线（t17）新增 `POST /foreign-import`（外部来源 → 受控临时目录 bundle，供导入向导消费）→ **75**。
 * F-2 官方 session.export 通道新增 `GET /session-export`（缺 sessionId = 探测，带 sessionId = 流式代理 ZIP，
 * **同一路径两形态**，所以只算一条）→ **76**。
 * 仓库选择器（同步通道「选择已有仓库 / 新建仓库」）新增 `GET+POST /sync/github/repositories` → **77**
 * 插件自更新（关于页「立即更新」）新增 `POST /update-apply` → **78**（检查更新仍只读，只有这条写动作）。
 * issue #79 工作副本自救入口新增 `POST /sync/workdir/reset`（relink 非破坏 / reclone 需显式 confirm）→ **79**。
 * （同一路径两个方法：GET 列举 / POST 新建；路径不得重复是 webServer 的硬约束，故不拆成两条）。
 * 快照是本次重构唯一的行为契约：kit 化 + 按域拆组文件之后，声明集合必须逐条不变。
 *
 * **T4（会话体检）为什么没有让这里变成 72**：它挂在**既有**的 `recovery` prefix 路由下
 * （`GET /api/dsh-config-manager/recovery/sessions`），与 `/recovery/status`、`/recovery/lock/recover`
 * 同族 —— prefix 路由内部的子路径分发不算新条目（快照的语义单位是「注册到 webServer 的路由声明」，
 * 而不是「逻辑端点」）。这条不是笔误，是刻意选择：本族已经是 prefix，新子路径不新增围栏面。
 *
 * 为什么快照里没有「顺序」：DSH webServer 的契约是「命名路由必须互不相同，注册顺序不影响请求」
 * （node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:44-49 的类文档），
 * 且本族的两条 prefix 互不嵌套，故断言取 (kind, methods, path) 的**集合**。
 *
 * 解析口径：从真实源码里**解析声明**（不是断言某段文本存在），并带负向自检
 * （见 \`解析器自检\`）——否则「解析不到任何路由」会假绿。
 *
 * 迁移记录（必须保留）：
 *  - 阶段 1（改造前）：解析 ranges \`path: API.<key>\` + \`kind\` + 方法判定（guard / req.method 比较），
 *    API 常量从同一份源码里解析。此版本先跑绿，作为改造的基线证据。
 *  - 阶段 2（改造后）：解析 \`endpoint({ path, methods, kind? }\` 声明（src/index.ts + src/routes/*.ts）。
 *    快照**一行未改**——这正是「逐条一致」的证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

/** (kind, methods, path) 三元组 → 稳定字符串（methods 按 METHOD_ORDER 规范化）。 */
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'DELETE'] as const;

/**
 * 路由清单快照（79 条；见文件头「迁移记录」；68 = W1 快照 67 + 档案启动 `/profiles/launch` + 档案复制 `/profiles/copy` − 已下线的 `/lifecycle`；
 * m-disk-usage 新增 `GET /disk-usage` 与 `POST /disk-usage/cleanup` → 70；m-update-check 新增 `GET /update-check` → 71；
 * 「拉取即导入」`POST /sync/download` → 72；远端快照删除 `POST /sync/snapshot-delete` → 73；
 * 外部 agent 导入收口（t22）`GET /foreign-sources` → 74；GUI 入口接线（t17）`POST /foreign-import` → 75；
 * F-2 `GET /session-export`（探测 + 流式代理同一路径两形态，只算一条）→ 76；
 * 仓库选择器 `GET+POST /sync/github/repositories`（列举 + 新建同一路径）→ 77；
 * 插件自更新 `POST /update-apply`（用户显式点「立即更新」，唯一写动作）→ 78；
 * issue #79 `POST /sync/workdir/reset`（工作副本重建；reclone 需 confirm）→ 79）。
 *
 * ⚠️ **成本提示（P-3）**：这是**硬编码清单**，不是从源码派生的期望值 —— 新增一条路由
 * **必须同步更新这里**，否则本测试必然变红（T14 复现：临时加一条 `endpoint({ path: '/api/dsh-config-manager/__p3_probe',
 * methods: ['GET'] }, …)` 声明后，本文件立即报「路由清单与改造前快照不一致」；删掉探针后复绿）。
 * 也就是说，kit 化后的「新增 API 只改一处」
 * 只对**生产源**成立；这份快照是刻意保留的第二处**登记动作**（代价换取的是一条独立的
 * 「路由集合未被无意增删」断言），不要把两者混读成「加路由零成本」。
 */
const ROUTE_SNAPSHOT = [
  ['exact', 'POST', '/api/dsh-config-manager/analyze'],
  ['exact', 'GET', '/api/dsh-config-manager/backup-files'],
  ['exact', 'POST', '/api/dsh-config-manager/backup-files/delete'],
  ['exact', 'GET+PUT', '/api/dsh-config-manager/backup-schedule'],
  ['exact', 'POST', '/api/dsh-config-manager/backup-schedule/run'],
  ['exact', 'POST', '/api/dsh-config-manager/consult'],
  ['exact', 'GET', '/api/dsh-config-manager/crash'],
  ['exact', 'POST', '/api/dsh-config-manager/decrypt-archive'],
  ['exact', 'GET', '/api/dsh-config-manager/disk-usage'],
  ['exact', 'POST', '/api/dsh-config-manager/disk-usage/cleanup'],
  ['exact', 'GET', '/api/dsh-config-manager/download'],
  ['exact', 'POST', '/api/dsh-config-manager/execute'],
  ['exact', 'POST', '/api/dsh-config-manager/execute/skip'],
  ['exact', 'POST', '/api/dsh-config-manager/export'],
  ['exact', 'POST', '/api/dsh-config-manager/export-preview'],
  ['exact', 'POST', '/api/dsh-config-manager/foreign-import'],
  ['exact', 'GET', '/api/dsh-config-manager/foreign-sources'],
  ['exact', 'GET', '/api/dsh-config-manager/history'],
  ['exact', 'GET', '/api/dsh-config-manager/history/export'],

  ['exact', 'POST', '/api/dsh-config-manager/market/browse'],
  ['exact', 'POST', '/api/dsh-config-manager/market/download'],
  ['exact', 'POST', '/api/dsh-config-manager/market/prepare'],
  ['exact', 'POST', '/api/dsh-config-manager/market/refresh'],
  ['exact', 'GET', '/api/dsh-config-manager/market/status'],
  ['exact', 'POST', '/api/dsh-config-manager/me/delete'],
  ['exact', 'POST', '/api/dsh-config-manager/me/items'],
  ['exact', 'POST', '/api/dsh-config-manager/me/listing'],
  ['exact', 'POST', '/api/dsh-config-manager/me/relist'],
  ['exact', 'POST', '/api/dsh-config-manager/me/status'],
  ['exact', 'POST', '/api/dsh-config-manager/me/update'],
  ['exact', 'POST', '/api/dsh-config-manager/me/upload'],
  ['exact', 'POST', '/api/dsh-config-manager/plan'],
  ['exact', 'GET', '/api/dsh-config-manager/profiles'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/copy'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/create'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/delete'],
  ['exact', 'GET', '/api/dsh-config-manager/profiles/detail'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/launch'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/rename'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/stop'],
  ['exact', 'GET', '/api/dsh-config-manager/progress'],
  ['prefix', 'GET+POST', '/api/dsh-config-manager/recovery'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/release-notes-prompt'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/rescue'],
  ['exact', 'POST', '/api/dsh-config-manager/restore'],
  ['exact', 'GET', '/api/dsh-config-manager/runs'],
  ['exact', 'POST', '/api/dsh-config-manager/runs/cancel'],
  ['exact', 'POST', '/api/dsh-config-manager/runs/cancel/decision'],
  ['exact', 'GET', '/api/dsh-config-manager/snapshots'],
  ['exact', 'POST', '/api/dsh-config-manager/snapshots/delete'],
  ['exact', 'POST', '/api/dsh-config-manager/snapshots/file-diff'],
  ['exact', 'POST', '/api/dsh-config-manager/snapshots/pin'],
  ['exact', 'GET', '/api/dsh-config-manager/session-export'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/star-prompt'],
  ['exact', 'GET', '/api/dsh-config-manager/status'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/apply-items'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/apply-merge'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/sync/autosync'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/cancel'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/config'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/cancel'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/poll'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/start'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/validate'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/sync/github/repositories'],
  ['exact', 'GET', '/api/dsh-config-manager/sync/history'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/merge-preview'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/probe'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/pull'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/download'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/push'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/rollback'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/selection'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/snapshot-delete'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/snapshots-list'],
  ['exact', 'GET', '/api/dsh-config-manager/sync/status'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/sync'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/ui-prefs'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/workdir/reset'],
  ['exact', 'POST', '/api/dsh-config-manager/update-apply'],
  ['exact', 'GET', '/api/dsh-config-manager/update-check'],
  ['exact', 'POST', '/api/dsh-config-manager/upload'],
];

function normalizeMethods(methods: Iterable<string>): string {
  const set = new Set(methods);
  return METHOD_ORDER.filter((m) => set.has(m)).join('+');
}

function row(kind: string, methods: Iterable<string>, routePath: string): string {
  return `${kind} ${normalizeMethods(methods)} ${routePath}`;
}

/** 解析端点路径：字面量或 \`API.<key>\`（后者用同一份源码里的 API 常量表解析）。 */
function resolvePath(expr: string, apiPaths: Map<string, string>): string {
  const literal = /^'([^']*)'$/.exec(expr.trim());
  if (literal !== null) return literal[1] as string;
  const key = /^API\.(\w+)$/.exec(expr.trim());
  assert.ok(key !== null, `无法解析路由路径表达式: ${expr}`);
  const resolved = apiPaths.get(key[1] as string);
  assert.ok(resolved !== undefined, `API 常量表缺少键: ${(key[1] as string)}`);
  return resolved;
}

/** 从 API 常量表源码解析 path 字面量（唯一来源，避免测试里再抄一份路径）。 */
function parseApiPaths(source: string): Map<string, string> {
  const out = new Map<string, string>();
  // 行尾归一：src/index.ts 在工作区是 CRLF（\r 会让行尾 $ 锚点失配 → 解析出空表 → 假绿）
  for (const line of source.split('\n').map((l) => l.replace(/\r$/, ''))) {
    const m = /^\s{2}(\w+): '(\/api\/dsh-config-manager[^']*)',$/.exec(line);
    if (m !== null) out.set(m[1] as string, m[2] as string);
  }
  return out;
}

/**
 * 解析当前工作区的全部路由声明 → (kind, methods, path) 行集合。
 *
 * 阶段 2 的解析口径：\`endpoint({ ... }\` 的 spec 内联对象（无嵌套花括号）+ 可能的 API 常量路径。
 */
function declaredRoutes(): string[] {
  const sources: string[] = [fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')];
  const routesDir = path.join(root, 'src/routes');
  for (const entry of fs.readdirSync(routesDir).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    sources.push(fs.readFileSync(path.join(routesDir, entry), 'utf8'));
  }
  const apiPaths = parseApiPaths(sources[0] as string);
  const rows: string[] = [];
  // 说明：不做整体注释剥离（本仓库的 stripJsComments 会把字符串内容一起清掉，见 bundle-selfcontained 的教训）。
  // 改为按**结构**判别声明：spec 必须含带值的 path（字面量或 API 键）与 methods 数组 —— kit.ts 文档注释里的
  // 示例文本（endpoint({ path, methods, kind? }, handler)）没有冒号值，天然不会命中。
  for (const source of sources) {
    // 声明形状：`endpoint({ ...spec }, <handler>)` —— spec 内不含花括号，故 [^{}]* 足够且不会跨声明
    const re = /endpoint\(\{([^{}]*)\}\s*,/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1] as string;
      const pathMatch = /path:\s*([^,]+?)\s*,/.exec(spec);
      const methodsMatch = /methods:\s*\[([^\]]*)\]/.exec(spec);
      if (pathMatch === null || !/^\s*(?:'[^']*'|"[^"]*"|API\.\w+)\s*$/.test(pathMatch[1] as string)) continue;
      const kindMatch = /kind:\s*'(exact|prefix)'/.exec(spec);
      assert.ok(pathMatch !== null, `endpoint 声明缺少 path: ${spec}`);
      assert.ok(methodsMatch !== null, `endpoint 声明缺少 methods: ${spec}`);
      const methods = (methodsMatch[1] as string)
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter((s) => s !== '');
      assert.ok(methods.length > 0, `endpoint 声明 methods 为空: ${spec}`);
      rows.push(row(kindMatch?.[1] ?? 'exact', methods, resolvePath(pathMatch[1] as string, apiPaths)));
    }
  }
  return rows.sort();
}

test('W1 parity：路由清单与预期快照逐条一致（82 条）', () => {
  const expected = ROUTE_SNAPSHOT.map(([kind, methods, routePath]) => row(kind as string, (methods as string).split('+'), routePath as string)).sort();
  const actual = declaredRoutes();
  assert.equal(expected.length, 82, '快照自身应为 82 条');
  assert.deepEqual(actual, expected, 'kit 化/拆组后路由声明集合必须逐条不变');
});

test('W1 parity 解析器自检：少一条 / 改一条 / 改方法都会被检出（防「解析不到即假绿」）', () => {
  const expected = ROUTE_SNAPSHOT.map(([kind, methods, routePath]) => row(kind as string, (methods as string).split('+'), routePath as string)).sort();
  const actual = declaredRoutes();
  // 反向控制：从解析结果里删一条（模拟「声明被误删」）、改一条路径（模拟「路径漂移」），断言两者都不再相等。
  const dropped = actual.slice(1);
  assert.notDeepEqual(dropped, expected, '少一条路由必须被判为不一致');
  const renamed = [...actual.slice(1), actual[0]!.replace(/\/[^/]+$/, '/__drifted__')];
  assert.notDeepEqual(renamed, expected, '路径漂移必须被判为不一致');
  // 解析器必须真的解析到 82 条（否则上面的 deepEqual 可能是「两边都空」的假绿）
  assert.equal(actual.length, 82, `解析到的路由数应为 82，实际 ${actual.length}`);
});

/** 单份源码里的真实路由声明数（与 declaredRoutes 同一解析口径）。 */
function countDeclarations(text: string): number {
  let n = 0;
  const re = /endpoint\(\{([^{}]*)\}\)?\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1] as string;
    const pathMatch = /path:\s*([^,]+?)\s*,/.exec(spec);
    if (pathMatch === null || !/^\s*(?:'[^']*'|"[^"]*"|API\.\w+)\s*$/.test(pathMatch[1] as string)) continue;
    if (!/methods:\s*\[[^\]]*\]/.test(spec)) continue;
    n++;
  }
  return n;
}

/** 全部宿主路由源（src/index.ts + src/routes/*.ts）。 */
function routeSources(): Array<{ file: string; text: string }> {
  const out = [{ file: 'src/index.ts', text: fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8') }];
  const dir = path.join(root, 'src/routes');
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push({ file: 'src/routes/' + entry, text: fs.readFileSync(path.join(dir, entry), 'utf8') });
  }
  return out;
}

/**
 * routes-F5 回归：**路由计数散文必须与真实声明数一致**。
 *
 * 为什么需要它：parity 快照钉住了「路由集合」，但源码注释里的**计数口径**（「保留的 N 条」
 * 「buildRoutes() N 条」「其余 N 条」）此前长期漂移（写 8/57/61，实际 7/70）—— 而这段散文
 * 正是「少一条即静默少一道围栏」这条安全不变量的叙述基础。这里把每个数字与真实声明数对账：
 * 写错即红灯，逼着新增路由的人同步更新注释（与快照清单同一维护动作）。
 */
test('W1 parity：路由计数散文必须与真实声明数一致（routes-F5 回归）', () => {
  const sources = routeSources();
  const actual = declaredRoutes().length;
  const indexSource = sources[0] as { file: string; text: string };
  const indexCount = countDeclarations(indexSource.text);
  const builtCount = actual - indexCount;
  assert.equal(actual, 82, '真实声明总数应为 82');
  assert.equal(indexCount, 7, 'src/index.ts 保留的声明应为 7');
  assert.equal(builtCount, 75, 'buildRoutes 拆出的声明应为 75');

  const claims: Array<{ file: string; label: string; stated: number; expected: number }> = [];
  const collect = (file: string, text: string, re: RegExp, label: string, expected: number): void => {
    for (const m of text.matchAll(re)) claims.push({ file, label, stated: Number(m[1]), expected });
  };
  for (const { file, text } of sources) {
    collect(file, text, /保留的 (\d+) 条/g, 'src/index.ts 保留条数', indexCount);
    collect(file, text, /buildRoutes\(\)[^0-9]{0,2}(\d+) 条/g, 'buildRoutes 条数', builtCount);
    collect(file, text, /其余 (\d+) 条/g, '拆出条数', builtCount);
  }

  // routes-F5b（t87）：**AGENTS.md 的计数散文同样对账**。此前守卫只扫 src 源码注释与快照清单，
  // AGENTS.md 写「合计 73 条 / 保留的 8 条」漂了一整轮也没人发现（t82 的 S2-1）—— 而这段散文
  // 正是「少一条即静默少一道围栏」这条安全不变量的**对外叙述**，同样必须与真实声明数同源。
  // 只做文本级断言（不引入新依赖）：数字写错 → 文件名 + 标签 + 应有值一起报出来。
  /**
   * routes-F5b（2026-10-14 补）：**两个文件都要扫**。
   *
   * AGENTS.md 已按新体例瘦身成「只留硬规则 + 一行指针」，目录结构 / 常用命令这类清单下移到
   * `docs/lessons/repo-overview.md` —— 只扫 AGENTS.md 会把「散文被搬到下移文件」误判成
   * 「计数声明消失」（假红），而这段散文正是「少一条即静默少一道围栏」的对外叙述。
   */
  const claimsFiles: readonly string[] = ['AGENTS.md', 'docs/lessons/repo-overview.md'];
  const agentsClaimsSpec: ReadonlyArray<readonly [RegExp, string, number]> = [
    [/保留的 (\d+) 条/g, 'src/index.ts 保留条数', indexCount],
    [/钉住的 (\d+) 条/g, 'src/index.ts 保留条数（窗口守卫）', indexCount],
    [/其余 (\d+) 条/g, '拆出条数', builtCount],
    [/合计 \*\*(\d+)\*\* 条/g, '合计条数', actual],
    [/本插件 (\d+) 条路由/g, '插件路由总数', actual],
    [/全部 (\d+) 条路由/g, '插件路由总数（影响面）', actual],
  ];
  for (const rel of claimsFiles) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const [re, label, expected] of agentsClaimsSpec) {
      collect(rel, text, re, label, expected);
    }
  }
  const agentsClaims = claims.filter((c) => claimsFiles.includes(c.file));
  assert.ok(
    agentsClaims.length >= agentsClaimsSpec.length,
    claimsFiles.join(' + ') + ' 里至少要扫到 ' + String(agentsClaimsSpec.length) + ' 处路由计数声明（扫不到即假绿），实际 ' + String(agentsClaims.length),
  );

  assert.ok(claims.length >= 4, '至少要扫到 4 处计数声明（扫不到即假绿），实际 ' + String(claims.length));
  assert.deepEqual(
    claims.filter((c) => c.stated !== c.expected).map((c) => c.file + ': ' + c.label + ' 写 ' + String(c.stated) + '，应为 ' + String(c.expected)),
    [],
    '路由计数散文必须与真实声明数一致（写错即红灯）',
  );
});

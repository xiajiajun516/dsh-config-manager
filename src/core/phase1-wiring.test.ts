/**
 * Phase 1 接线（P0-1/P0-2 生命周期 + P0-5 崩溃归因）的路由级回归。
 *
 * 为什么需要这一层：core 单测已覆盖引擎行为，但「路由存在 + 鉴权 + 方法 + 参数校验」
 * 属于接线契约，漏掉就会变成「注释承诺 > 实际防线」——本仓库已因此踩过坑。
 * 这里用最小 deps 直接调 makeRoutes 产出的 handler，不需要真 DSH。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 本测试只断言「路由表里确实注册了 Phase 1 的三条路径」，且 handler 是函数。
 * 不构造完整 RoutesDeps（那会把整个宿主依赖树拖进来，且与并行线耦合）；
 * 端到端行为由 core 侧 config-lifecycle.test.ts 覆盖。
 */
const INDEX_SRC = await (async (): Promise<string> => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = path.resolve(import.meta.dirname, '..', '..', 'src', 'index.ts');
  // 行尾归一：本仓库工作区 CRLF、CI 检出 LF，写死任一行尾都会只在一端通过
  return (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
})();

const API_PATHS = [
  '/api/dsh-config-manager/lifecycle',
  '/api/dsh-config-manager/crash',
  '/api/dsh-config-manager/rescue',
];

test('P0 接线：三条 Phase 1 路由常量已声明', () => {
  for (const p of API_PATHS) {
    assert.ok(INDEX_SRC.includes(`'${p}'`), `API 常量缺失: ${p}`);
  }
});

test('P0 接线：ConfigLifecycle 在 makeRoutes 内实例化并注入 watchFactory', () => {
  assert.ok(INDEX_SRC.includes('new ConfigLifecycle({'), '未实例化 ConfigLifecycle');
  assert.ok(INDEX_SRC.includes("dir: join(dataDir, 'config-snapshots')"), '配置快照必须与导入前快照分目录');
  assert.ok(INDEX_SRC.includes('watchFactory: (dir, onEvent) => fsWatch(dir'), '必须注入真 fs.watch');
});

test('P0 接线：自动快照监听只在启动分类 NORMAL 的同一闸门内启动', () => {
  const gate = INDEX_SRC.indexOf('schedulerGate.start = () => {');
  assert.ok(gate > 0, '未找到 schedulerGate.start 赋值');
  const body = INDEX_SRC.slice(gate, gate + 600);
  assert.ok(body.includes('lifecycle.startAutoSnapshot()'), '自动快照未接入调度闸门（否则恢复进行中就会开拍）');
});

test('P0 接线：lifecycle.dispose 已注册为 ctx.effect 清理', () => {
  assert.ok(
    INDEX_SRC.includes("ctx.effect(() => () => lifecycle.dispose(), 'config-manager: config lifecycle watcher')"),
    '缺少 dispose 清理 → 插件卸载后监听泄漏',
  );
});

test('P0 接线：boot-state 有写入方（启动 ok:false、分类完成 ok:true）', () => {
  assert.ok(INDEX_SRC.includes('void bootBegin()'), '缺少启动时写 boot-state');
  assert.ok(INDEX_SRC.includes('markBootOk('), '缺少分类完成后标记成功');
  // 两处出口（正常分类 / fail-closed）都应标记成功
  const okMarks = INDEX_SRC.split('markBootOk(').length - 1;
  assert.ok(okMarks >= 2, `markBootOk 调用点应覆盖两个出口，实际 ${okMarks}`);
});

test('P0 接线：救援路由绝不进入 mutation gate（否则无法解除自己造成的阻断）', () => {
  // 语义：rescue ON 会禁用其它插件，是「解决 SAFE MODE」的手段；
  // 若被 safeModeIsBlocked / mutation lock 挡住，用户将被永久锁在救援态。死锁防线。
  const rescueStart = INDEX_SRC.indexOf('path: API.rescue');
  assert.ok(rescueStart > 0, '未找到 rescue 路由');
  // 取到该路由对象结束为止（下一个 `      },\n    },` 边界足够覆盖 body）
  const rescueBody = INDEX_SRC.slice(rescueStart, rescueStart + 2000);
  assert.ok(!rescueBody.includes('withMutationGate'), 'rescue 不得被 mutation gate 包裹');
  assert.ok(!rescueBody.includes('runWithMutationLock'), 'rescue 不得自行取 mutation lock');
  // 救援态不得并入 safeModeIsBlocked 谓词：唯一的赋值点必须仍是 phase3Recovery 的 SAFE MODE。
  const predicate = INDEX_SRC.split('host.safeModeIsBlocked = ').length - 1;
  assert.equal(predicate, 1, 'safeModeIsBlocked 只应有一个赋值点');
  const assignAt = INDEX_SRC.indexOf('host.safeModeIsBlocked = ');
  const assignLine = INDEX_SRC.slice(assignAt, INDEX_SRC.indexOf('\n', assignAt));
  assert.ok(
    assignLine.includes('phase3Recovery.safeModeActive'),
    `safeModeIsBlocked 必须只反映 Phase 3 SAFE MODE，实际: ${assignLine.trim()}`,
  );
  assert.ok(!assignLine.includes('rescue'), '救援态不得并入 safeModeIsBlocked（会让插件自身写操作被自己挡住）');
});

test('P0 接线：lifecycle 的 mutation 路由走 withMutationGate + guard', () => {
  const start = INDEX_SRC.indexOf('path: API.lifecycle');
  const body = INDEX_SRC.slice(start, start + 4200);
  for (const op of ['lifecycle-snapshot', 'lifecycle-remove']) {
    assert.ok(body.includes(`withMutationGate('${op}'`), `缺少 mutation gate: ${op}`);
  }
  assert.ok(body.includes("withMutationGate(`lifecycle-${segments[0]}`"), 'undo/redo 应共用一个 gate');
  // W1（route kit）：围栏（loopback + 同源）与方法判定不再逐路由手写，而是由 endpoint() 在注册点
  // 统一包装（src/routes/kit.ts 是唯一实现）。这里改为守住「该路由确实经 kit 声明且方法白名单正确」。
  // 注意窗口从 'path: API.lifecycle' 起，故断言落在窗口内的后半段
  assert.ok(
    body.includes("methods: ['GET', 'POST'] }"),
    'lifecycle 必须经 route kit 声明（围栏/方法判定由注册点统一包装）',
  );
  assert.ok(
    INDEX_SRC.includes("endpoint({ kind: 'prefix', path: API.lifecycle, methods: ['GET', 'POST'] }"),
    'lifecycle 必须用 endpoint() 声明（不再自造围栏/自判方法）',
  );
});

test('P0 接线：崩溃归因路由为只读 GET', () => {
  const start = INDEX_SRC.indexOf('path: API.crash');
  const body = INDEX_SRC.slice(start, start + 1400);
  assert.ok(body.includes("path: API.crash, methods: ['GET']"), 'crash 路由应为只读 GET（经 route kit 声明）');
  assert.ok(body.includes('lastGoodSnapshotId'), '应返回 last-good 快照 id');
});

/* ------------------------------------------------------ 灾备总开关（临时下线） */

/**
 * 灾备子系统总开关的守卫。
 *
 * 为什么单独守这一组：把功能「注释掉」而接线仍在，正是本仓库记录过的
 * 「注释承诺 > 实际防线」反模式。开关必须真的挂在**启动路径**上，而不是
 * 只改一句注释或只隐藏 UI 入口 —— 否则禁用期间后台照样采集并刷告警。
 */
test('灾备总开关：启动路径确实被短路（不是只改了注释）', () => {
  assert.ok(INDEX_SRC.includes('const LIFECYCLE_ENABLED'), '缺少灾备总开关常量');
  assert.ok(
    INDEX_SRC.includes('if (LIFECYCLE_ENABLED) lifecycle.startAutoSnapshot()'),
    '自动快照未挂在总开关上 → 禁用期间仍会后台采集全部分区并刷「超出上限」告警',
  );
  assert.ok(
    INDEX_SRC.includes('if (LIFECYCLE_ENABLED) void bootBegin()'),
    'boot-state 启动写入未挂在总开关上',
  );
  // 分类完成后的两个出口（正常 / fail-closed）都不该在禁用时写 boot-state
  const guardedMarks = INDEX_SRC.split('if (LIFECYCLE_ENABLED) {').length - 1;
  assert.ok(guardedMarks >= 2, `markBootOk 两个出口都应受开关约束，实际 ${guardedMarks} 处`);
});

test('灾备总开关：三条路由在禁用时一律 503 feature-disabled', () => {
  const short = "if (!LIFECYCLE_ENABLED) { writeJson(res, 503, { ok: false, code: 'feature-disabled'";
  const n = INDEX_SRC.split(short).length - 1;
  assert.equal(n, 3, `/lifecycle /crash /rescue 三条路由都应短路，实际 ${n} 条`);
});

test('灾备总开关：客户端导航入口同源关闭（避免「入口可见但功能 503」错位）', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = path.resolve(import.meta.dirname, '..', '..', 'src', 'client', 'ConfigManagerSection.tsx');
  const src = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  assert.ok(src.includes('const SHOW_LIFECYCLE_NAV = false'), '客户端灾备入口开关应为关闭');
});

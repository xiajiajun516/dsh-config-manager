/**
 * 运行中心终止通道的**宿主接线守卫**（源码级）。
 *
 * 为什么不能只靠引擎单测：本功能最容易出的错全在接线层，而且都不报错，只表现为行为诡异：
 *  ① 终止/决策两条路由若被 withMutationGate 包住 → 调用时 /execute 正持 GLOBAL 环境锁，
 *     必然 423 mutation-locked，用户点「终止」永远失败（与 /execute/skip 同一坑）；
 *  ② 决策回调若不把 run 置为 pendingDecision → UI 看不到「在等人」，只能干等超时；
 *  ③ 超时兜底若缺失 → 用户不选就永久卡在安全点（run 永远 running）；
 *  ④ 启动自洽审计若不注入 → 「保留」变成「没人检查盘面」，与需求本意相反。
 * 这些点都由本文件钉住（与本仓库既有的 host 接线守卫同一手法：源码窗口 + 子串断言）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const routesSource = fsSync.readFileSync(path.join(root, 'src/routes/import.ts'), 'utf8');
const hostSource = fsSync.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

/** 取某个标记之后的一段源码（路由块很长，窗口足以覆盖 handler）。 */
function block(source: string, marker: string, span: number): string {
  const start = source.indexOf(marker);
  assert.ok(start > 0, '未找到标记：' + marker);
  return source.slice(start, start + span);
}

const RUNS_CANCEL = "path: '/api/dsh-config-manager/runs/cancel'";
const RUNS_DECISION = "path: '/api/dsh-config-manager/runs/cancel/decision'";
const EXECUTE = "path: '/api/dsh-config-manager/execute'";
const RUNS = "path: '/api/dsh-config-manager/runs'";

test('H-01 终止路由不得经 withMutationGate（否则必然 423：/execute 正持 GLOBAL 锁）', () => {
  const cancel = block(routesSource, RUNS_CANCEL, 900);
  assert.ok(cancel.includes('entry.signal.abort()'), '必须 abort run 级信号');
  assert.ok(!cancel.includes('withMutationGate'), '经 gate 会与其他 mutation 抢锁，终止永远 423 失败');
  const decision = block(routesSource, RUNS_DECISION, 900);
  assert.ok(decision.includes('entry.settle('), '必须把用户选择回传给停在安全点的引擎');
  assert.ok(!decision.includes('withMutationGate'), '同上：不得经 mutation gate');
});

test('H-02 终止路由区分「没有这个 run」与「该任务不支持终止」（能力边界不是 404）', () => {
  const cancel = block(routesSource, RUNS_CANCEL, 900);
  assert.ok(cancel.includes("runs.get(runId) === undefined ? 404 : 409"), '404=不存在，409=不支持协作式取消');
  assert.ok(cancel.includes("msg('runs.cancelUnsupported')"), '不支持时必须给出可读原因');
});

test('H-03 /execute 必须登记 run 级终止通道并透传三个新选项', () => {
  const execute = block(routesSource, EXECUTE, 12000);
  assert.ok(execute.includes('runCancels.set(runId, cancelEntry)'), '必须登记 run 级通道');
  assert.ok(execute.includes('cancelSignal: cancelEntry.signal.signal'), '引擎必须拿到 run 级信号');
  assert.ok(execute.includes('onCancelDecision:'), '必须提供决策回调');
  assert.ok(execute.includes('bootSafetyAudit,'), '「保留」分支必须注入启动自洽审计');
  assert.ok(execute.includes('runCancels.delete(runId)'), 'finally 必须回收登记（否则 runId 泄漏）');
  assert.ok(execute.includes('runAbortControllers.delete(runId)'), '项级通道（跳过当前插件）必须保持独立存在');
});

test('H-04 决策回调必须置待决策态，并带超时兜底到安全侧', () => {
  const execute = block(routesSource, EXECUTE, 12000);
  assert.ok(execute.includes("runs.setPendingDecision(runId, 'cancel')"), '待决策态是 UI 弹决策框的唯一依据');
  assert.ok(execute.includes('runs.setPendingDecision(runId, null)'), '决策完成后必须清掉（否则永远显示在等人）');
  assert.ok(execute.includes('setTimeout('), '必须有超时兜底');
  assert.ok(execute.includes('cancelDecisionTimeoutMs'), '超时时长经 env 注入（不得硬编码在路由里）');
  assert.ok(execute.includes("settleCancel?.('rollback')"), '超时必须落到安全侧默认：回滚');
});

test('H-05 /runs 支持 scope=recent，缺省行为不变', () => {
  const runs = block(routesSource, RUNS, 700);
  assert.ok(runs.includes("scope === 'recent' ? runs.listRecent(50) : runs.listActive()"), 'recent 走 listRecent');
});

test('H-06 宿主 env 暴露终止通道与审计', () => {
  assert.ok(hostSource.includes('const runCancels = new Map<string,'), 'run 级通道结构恒定');
  assert.ok(hostSource.includes('const CANCEL_DECISION_TIMEOUT_MS = 5 * 60 * 1000'), '等待上限必须是分钟量级的显式常量');
  assert.ok(hostSource.includes('bootSafetyAudit,'), 'env 必须带上审计器');
  assert.ok(hostSource.includes('cancelDecisionTimeoutMs: CANCEL_DECISION_TIMEOUT_MS,'), '超时时长经 env 下发');
});

test('H-07 启动自洽审计的宿主接线：读写走 HostContext.fs，YAML 走 js-yaml，bundle 解析走多根探测', () => {
  const audit = block(hostSource, 'const bootSafetyAudit = async', 1400);
  assert.ok(audit.includes('host.fs.readFile(relPath)'), '读配置必须走 HostContext.fs（内存 mock 可注入）');
  assert.ok(audit.includes('host.fs.writeFile(relPath'), '剔除不可解析 bundle 才需要写');
  assert.ok(audit.includes('parseYaml: (text) => yaml.load(text)'), 'YAML 解析必须注入（core 不 import js-yaml）');
  assert.ok(hostSource.includes('const bundleResolvable = async'), 'bundle 可解析探测必须是宿主实现');
  assert.ok(hostSource.includes("for (const root of [join(host.homeDir, 'profiles'"), '多根探测：只有所有根都找不到才判不可解析（宁少剪不误剪）');
});
test('H-08 终止请求必须同时 abort「当前计划项」——否则插件安装跑几十分钟，用户只能干等', () => {
  const cancel = block(routesSource, RUNS_CANCEL, 1200);
  assert.ok(cancel.includes('runAbortControllers.get(runId)?.abort()'), '必须顺手 kill 当前项的子进程（run 级取消只在项边界生效）');
  assert.ok(cancel.includes('runs.requestCancel(runId)'), '必须记录请求时刻（界面据此显示「已等待 X 分钟」）');
  assert.ok(cancel.includes("msg('runs.cancelWaitingSafePoint')"), '必须在 run 日志里写明「已请求终止 + 已中止当前项子进程」');
});

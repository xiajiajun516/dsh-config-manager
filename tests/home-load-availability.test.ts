/**
 * 首页加载可用性守卫（源码级，零依赖）。
 *
 * 真机现场（2026-10）：`GET /sync/status` 在同一个环境里 300 秒不返回，其余只读端点都在毫秒级；
 * 旧首屏把它和另外 4 个毫秒级请求塞进同一个 `Promise.allSettled`，全部 settle 才撤骨架 ⇒
 * **整页骨架永久停在「加载中…」**。修法有两半，这里把两半都钉死，防止有人「顺手把 sync 加回去」：
 *   1. 客户端：首屏快请求集合里不得再出现 `syncApi.status()`；同步状态独立加载、独立超时、独立失败态。
 *   2. 服务端：`/sync/status` 的取值体必须继续被总预算包住（裸 await 会让 HTTP 响应永不被写出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 读仓库内文件原文（守卫只做源码断言，不 import 组件）。 */
function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

test('L-01 首屏快请求集合不含同步状态：不得退回一把梭的 allSettled', () => {
  const src = read('src/client/home/HomePanel.tsx');
  assert.equal(
    src.includes('Promise.allSettled(['),
    false,
    '首屏快请求不得再合并成一个 allSettled：任一请求挂住就会把整页骨架一起按死（2026-10 现场）',
  );
  assert.ok(
    src.includes('const HOME_SYNC_TIMEOUT_MS = 30_000'),
    '同步状态必须有独立的 30 秒档超时（沿用默认 {seconds} 超时文案，与实测时长一致）',
  );
  assert.ok(
    src.includes('syncApi.status({ timeoutMs: HOME_SYNC_TIMEOUT_MS, workDirDetail: false })'),
    '同步状态必须带自己的超时调用，并关掉工作副本 detail（首页不渲染 WorkDirCard，省 5 次 git 子进程）',
  );
  assert.equal(
    src.includes('syncApi.status()'),
    false,
    '不得出现无参 status() 调用 —— 那会退回同步族的 5 分钟档，等于把整页挂回去',
  );
});

test('L-02 同步段有独立三态与失败文案，骨架按段判定', () => {
  const src = read('src/client/home/HomePanel.tsx');
  assert.ok(
    src.includes("const [syncState, setSyncState] = useState<'loading' | 'ready' | 'failed'>('loading')"),
    '同步段必须有自己的加载态（loading/ready/failed），不能借用首屏 loading',
  );
  assert.ok(
    src.includes("t('overview.meta.syncUnavailable')"),
    '读取失败必须如实说「读取超时」；落到「未配置」会让用户去重配一个本来配好的通道',
  );
  assert.ok(
    src.includes("const segLoading = (key: OverviewMetricKey): boolean => (key === 'sync' ? syncState === 'loading' : loading)"),
    '骨架必须按段判定：同步段只看 syncState',
  );
  assert.equal(
    src.split('segLoading(seg.key)').length - 1,
    2,
    '骨架判断（值与注两处）都必须走 segLoading(seg.key)',
  );
});

test('L-03 /sync/status 的取值体继续被总预算包住，超时明确回 503', () => {
  const src = read('src/routes/sync.ts');
  assert.ok(
    /withTimeout\(\s*collectSyncStatus\([^()]*\),\s*SYNC_STATUS_BUDGET_MS\b/.test(src),
    '取值体必须套总预算：只读端点也会碰 DSH credentials 服务与 git 工作副本自检，两者都可能永不返回',
  );
  assert.ok(
    src.includes("msg('host.syncStatusTimeout')"),
    '超时必须可辨识（同一句文案用于判定 503 / 500），否则客户端只看到空等',
  );
  assert.ok(
    src.includes("message === msg('host.syncStatusTimeout') ? 503 : 500"),
    '预算耗尽 = 暂不可用（503）；其余异常仍是 500',
  );
});

test('L-04 workDir detail 开关贯通四层：默认完整、按需降级', () => {
  // 为什么单独钉：/sync/status 的 730 ms 里 585 ms 是 7 次 git.exe 启动（Windows 每次约 80 ms）。
  // 只有同步页的 WorkDirCard 需要 ahead/dirty/remoteSnapshots；首页与产物库只要「地址是否跟随」。
  const route = read('src/routes/sync.ts');
  assert.ok(
    route.includes("queryParam(new URL(req.url ?? '/', 'http://localhost'), 'detail') !== '0'"),
    '路由必须从 query 读 detail（缺省 = 完整自检，只有显式 detail=0 才降级）',
  );
  assert.ok(
    route.includes('collectSyncStatus({ workDirDetail })'),
    '取值体必须收到 detail 选择',
  );
  assert.ok(
    route.includes('syncWorkDir.inspect(gitRepoUrl, { detail: opts.workDirDetail })'),
    '降级必须真的传到工作副本自检，不能只解析不生效',
  );
  const host = read('src/index.ts');
  assert.ok(
    host.includes('inspectWorkDir({ detail: opts.detail !== false })'),
    '宿主缺省仍做完整自检（opts.detail !== false），避免漏传参数悄悄丢掉三项事实',
  );
  const api = read('src/client/sync/sync-api.ts');
  assert.ok(
    api.includes("workDirDetail === false ? SYNC_API.status + '?detail=0' : SYNC_API.status"),
    '客户端只在显式 workDirDetail:false 时降级',
  );
  for (const rel of ['src/client/home/HomePanel.tsx', 'src/client/library/LibraryActions.tsx', 'src/client/library/LibraryPanel.tsx']) {
    assert.ok(read(rel).includes('workDirDetail: false'), rel + ' 不渲染 WorkDirCard → 必须关掉 detail');
  }
});

/**
 * GitHub Gist 通道：**delete 的索引并发语义**回归（写后复核 + 有界重做）。
 *
 * 背景与 upload 侧同源（见 gist-overwrite-semantics.test.ts 文首）：gist 的 PATCH 端点拒绝任何
 * 条件请求头（issue #110，gist-transport.ts 文首），索引写没有条件写这道闸。现在 delete 也做
 * **写后复核**：PATCH 之后重新 GET 索引，确认 ① 目标 id 已从索引消失且载荷文件已删除；
 * ② 读前已有的其它条目一个都没少。任一条不成立 ⇒ 整轮重做「读-合并-写」，最多 3 轮，
 * 仍失败抛 `sync.gist.indexConflict`（`kind:'conflict'`、`code:'index-conflict'`）。
 *
 * 这些用例**钉住现行语义**，不是背书并发安全：
 * - 抓得住「我们写完之后被别人整体覆盖」→ 重做后目标真的没了、别人的条目还在（用例②）；
 * - 抓不住「别人在我们读取与 PATCH 之间写入」→ 那些条目我们没读到，仍会被这次写入覆盖
 *   （残余窗口，通道物理决定；要堵必须换 git / webdav / s3 的条件写）；
 * - gist 不做 blob 外置（gist-transport.ts:22-24），「别人载荷不丢」在本通道的等价物 =
 *   该快照自己的文件 `<prefix>-<id>.json` 逐字节不变。
 *
 * 若未来给 gist 换成真正的条件写（或 GitHub 放开条件头），用例②③应当变红 —— 那正是改动意图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GistTransport, GistTransportError, GIST_DEFAULT_FILE_PREFIX } from './gist-transport.ts';
import type { GistRequestFn, GistResponse } from './gist-transport.ts';
import { computeSnapshotMeta } from '../transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta } from '../transport.ts';

const GIST_ID = 'aa5a315d61ae9438b18d';
const TOKEN = 'ghp_ExampleTokenValueThatMustNeverLeak123456';
const API = 'https://api.github.com';
const GIST_URL = API + '/gists/' + GIST_ID;
const INDEX_FILE = GIST_DEFAULT_FILE_PREFIX + '-index.json';
const CONDITIONAL_HEADERS = ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];

const snapshotFile = (id: string): string => GIST_DEFAULT_FILE_PREFIX + '-' + id + '.json';

interface GistCall { method: string; url: string; headers: Record<string, string>; body?: string }

/** 文件名 → 文件内容（假 gist 就是扁平文件命名空间，与真实 gist 一致） */
type Store = Record<string, string>;

function res(status: number, bodyText = ''): GistResponse {
  return { status, ok: status >= 200 && status < 300, async text() { return bodyText; } };
}

function sampleSnapshot(id: string, createdAt: string, marker: string): SyncSnapshot {
  return {
    id,
    createdAt,
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { marker }, revision: 1, secrets: [] } } },
    },
  };
}

const snapA = sampleSnapshot('snap-a', '2026-10-20T08:00:00.000Z', 'from-A');
const snapC = sampleSnapshot('snap-c', '2026-10-20T08:30:00.000Z', 'from-C');
const metaA = computeSnapshotMeta(snapA);
const metaC = computeSnapshotMeta(snapC);
/** 别人（C 机）在自己的 gist 里那份快照载荷的原始字节 */
const payloadA = JSON.stringify(snapA);
const payloadC = JSON.stringify(snapC);

/**
 * 极简假 gist 服务端：
 * - GET /gists/{id} → 扁平文件视图（可被用例替换成「旧基线」）；
 * - PATCH /gists/{id} → 只改请求体里列出的文件（null = 删除），其余文件保持不变；
 * - onPatch 钩子在每次 PATCH 落盘之后触发，用来模拟「另一个人紧接着又写了一次索引」；
 * - 其余请求一律 500，避免测试悄悄依赖未建模的端点。
 */
function makeHarness(baseline: Store = { [INDEX_FILE]: '[]' }) {
  const files: Store = { ...baseline };
  const calls: GistCall[] = [];
  const patches: GistCall[] = [];
  const hooks: { onPatch?: (patchNo: number) => void } = {};

  const applyPatch = (body: string): void => {
    const parsed = JSON.parse(body) as { files?: Record<string, { content: string } | null> };
    for (const [name, entry] of Object.entries(parsed.files ?? {})) {
      if (entry === null) delete files[name];
      else files[name] = entry.content;
    }
  };

  const makeClient = (view: () => Store): GistRequestFn => async (method, url, opts = {}) => {
    const call: GistCall = {
      method,
      url,
      headers: opts.headers ?? {},
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    };
    calls.push(call);
    if (method === 'GET' && url === GIST_URL) {
      const viewFiles: Record<string, { content: string }> = {};
      for (const [name, content] of Object.entries(view())) viewFiles[name] = { content };
      return res(200, JSON.stringify({ files: viewFiles }));
    }
    if (method === 'PATCH' && url === GIST_URL) {
      applyPatch(call.body ?? '{}');
      patches.push(call);
      hooks.onPatch?.(patches.length);
      return res(200, '{}');
    }
    return res(500, 'unexpected ' + method + ' ' + url);
  };

  /** 缺省复核/重做等待 0ms：这些用例只验证语义，不允许真实 sleep 拖慢测试 */
  const transport = (view: () => Store): GistTransport =>
    new GistTransport({
      gistId: GIST_ID,
      credentials: { getToken: async () => TOKEN },
      request: makeClient(view),
      indexConflictRetryDelayMs: 0,
    });

  return { files, calls, patches, hooks, transport };
}

function parseIndex(files: Store): SyncSnapshotMeta[] {
  const raw = files[INDEX_FILE];
  assert.ok(raw !== undefined, '索引文件必须存在（写后复核不允许索引被清空）');
  return JSON.parse(raw) as SyncSnapshotMeta[];
}

/** 两台机在同一基线之后的索引：目标条目 + 别人的条目 */
function seededBaseline(): Store {
  return {
    [INDEX_FILE]: JSON.stringify([metaC, metaA]),
    [snapshotFile('snap-a')]: payloadA,
    [snapshotFile('snap-c')]: payloadC,
  };
}

function assertNoConditionalHeaders(patches: GistCall[]): void {
  for (const [i, call] of patches.entries()) {
    const present = CONDITIONAL_HEADERS.filter((h) => call.headers[h] !== undefined);
    assert.deepEqual(present, [], '第 ' + String(i + 1) + ' 次 PATCH 不带任何条件请求头（gist 端点会回 400）');
  }
}

/* ---------------- ① 正常删除：一次 PATCH，索引只剩别人的条目 ---------------- */

test('删除①：正常路径 ⇒ 1 次 PATCH，目标从索引与载荷里都消失，别人的条目/载荷不变', async () => {
  const harness = makeHarness(seededBaseline());
  const transport = harness.transport(() => harness.files);

  await transport.delete('snap-a');

  assert.equal(harness.patches.length, 1, '正常路径只应写一次');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-c'], '索引里只剩别人的条目');
  assert.equal(harness.files[snapshotFile('snap-a')], undefined, '目标载荷文件被置 null（删除）');
  assert.equal(harness.files[snapshotFile('snap-c')], payloadC, '别人的载荷逐字节不变');
  assert.equal(JSON.parse(harness.files[snapshotFile('snap-c')] ?? '{}').sections.settings.version, 1);
  // 删除只该写索引 + 目标文件 null；不得顺手重写别人的载荷
  const patchedFiles = Object.keys((JSON.parse(harness.patches[0]?.body ?? '{}') as { files: Record<string, unknown> }).files);
  assert.deepEqual(patchedFiles.sort(), [snapshotFile('snap-a'), INDEX_FILE].sort(), 'PATCH 只碰目标载荷与索引');
  assertNoConditionalHeaders(harness.patches);
});

/* ---------------- ② 写后被别人整体覆盖：目标又回来了 ⇒ 重做 ---------------- */

test('删除②：写后索引被别人整体覆盖（目标 id 又出现）⇒ 复核发现 ⇒ 重做后目标真的没了', async () => {
  const harness = makeHarness(seededBaseline());
  const transport = harness.transport(() => harness.files);
  // 模拟另一台机拿着同一份旧基线紧接着又写了一次索引：目标条目被写回来
  harness.hooks.onPatch = (patchNo) => {
    if (patchNo === 1) harness.files[INDEX_FILE] = JSON.stringify([metaC, metaA]);
  };

  await transport.delete('snap-a');

  assert.equal(harness.patches.length, 2, '第一轮的删除被别人覆盖 ⇒ 第二轮回读最新索引后重做');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-c'], '最终索引里目标不在、别人条目在');
  assert.equal(harness.files[snapshotFile('snap-a')], undefined, '最终目标载荷已删除');
  assert.equal(harness.files[snapshotFile('snap-c')], payloadC, '别人的载荷逐字节不变');
  assertNoConditionalHeaders(harness.patches);
});

/* ---------------- ③ 三轮都被覆盖：抛 index-conflict，远端不被破坏 ---------------- */

test('删除③：每轮写后都被覆盖 ⇒ 3 次 PATCH 后抛 index-conflict，索引与别人的载荷不被破坏', async () => {
  const harness = makeHarness(seededBaseline());
  const transport = harness.transport(() => harness.files);
  harness.hooks.onPatch = () => {
    // 每次都把目标条目写回来，删除永远「没生效」
    harness.files[INDEX_FILE] = JSON.stringify([metaC, metaA]);
  };

  await assert.rejects(
    () => transport.delete('snap-a'),
    (err: unknown) => {
      assert.ok(err instanceof GistTransportError, '抛的必须是 GistTransportError');
      assert.equal(err.kind, 'conflict');
      assert.equal(err.code, 'index-conflict');
      assert.match(err.message, /索引在写入期间被他人改动/);
      assert.ok(!err.message.includes(TOKEN), '错误消息不得回显 token');
      return true;
    },
  );

  assert.equal(harness.patches.length, 3, '重做上限 3 轮（不无限重试）');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-c', 'snap-a'], '索引没有被写成空表/半成品');
  assert.equal(harness.files[snapshotFile('snap-c')], payloadC, '别人的载荷逐字节不变');
  assertNoConditionalHeaders(harness.patches);
});

/* ---------------- ④ 目标本来就不存在：幂等成功、零 PATCH ---------------- */

test('删除④：目标 id 本来就不在索引与文件里 ⇒ 幂等成功，0 次 PATCH', async () => {
  const harness = makeHarness({
    [INDEX_FILE]: JSON.stringify([metaC]),
    [snapshotFile('snap-c')]: payloadC,
  });
  const transport = harness.transport(() => harness.files);

  await transport.delete('snap-a');

  assert.equal(harness.patches.length, 0, '无事可做时不允许发 PATCH');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-c']);
  assert.equal(harness.files[snapshotFile('snap-c')], payloadC);
});

/* ---------------- ⑤ 索引有、载荷已不在：只写索引，不置 null ---------------- */

test('删除⑤：索引里还有但载荷文件已不存在 ⇒ 只写索引，不再对不存在的文件置 null', async () => {
  const harness = makeHarness({
    [INDEX_FILE]: JSON.stringify([metaC, metaA]),
    [snapshotFile('snap-c')]: payloadC,
  });
  const transport = harness.transport(() => harness.files);

  await transport.delete('snap-a');

  assert.equal(harness.patches.length, 1);
  const patchedFiles = Object.keys((JSON.parse(harness.patches[0]?.body ?? '{}') as { files: Record<string, unknown> }).files);
  assert.deepEqual(patchedFiles, [INDEX_FILE], '目标载荷本来就不在 ⇒ PATCH 只写索引');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-c']);
});

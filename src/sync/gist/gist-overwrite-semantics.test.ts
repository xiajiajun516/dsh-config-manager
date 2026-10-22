/**
 * GitHub Gist 通道：索引写入的并发语义回归（写后复核 + 有界重做）。
 *
 * 背景：gist 的 PATCH 端点拒绝**任何**条件请求头（issue #110，见 gist-transport.ts 文首），
 * 所以索引写没有条件写这道闸。现在的兜底是 upload 里的**写后复核**：PATCH 之后重新 GET 索引，
 * 若本次条目丢了、或读前已有的条目丢了，就整轮重做「读-合并-写」，最多 3 轮，仍失败抛
 * `sync.gist.indexConflict`（`kind:'conflict'`）。
 *
 * 这些用例**钉住现行语义**，不是背书并发安全：
 * - 抓得住「我们写完之后被别人整体覆盖」→ 重做后两边的条目都在（用例②）；
 * - 抓不住「别人在我们读取与 PATCH 之间写入」→ 那些条目我们没读到，仍会被这次写入覆盖
 *   （用例④，通道物理决定；要堵这个窗口必须换 git / webdav / s3 的条件写）；
 * - gist 不做 blob 外置（gist-transport.ts:22-24），故「内容寻址载荷」在本通道的等价物 =
 *   该快照自己的文件 `<prefix>-<id>.json`：只被本机 upload 写、被 delete 置 null，别人 push
 *   不会触碰 ⇒ 索引可见性会丢，载荷本身不丢（用例②④都用逐字节相等 + download 证明）。
 *
 * 若未来给 gist 换成真正的条件写（或 GitHub 放开条件头），用例④应当变红 —— 那正是改动意图。
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
/** 任何条件请求头（gist 端点出现即 400，见 issue #110） */
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
const snapB = sampleSnapshot('snap-b', '2026-10-20T09:00:00.000Z', 'from-B');
const snapC = sampleSnapshot('snap-c', '2026-10-20T08:30:00.000Z', 'from-C');

/**
 * 极简假 gist 服务端：
 * - GET /gists/{id} → 调用方传入的「视图」决定它看到哪一版（可模拟某台机器读到的旧基线）；
 * - PATCH /gists/{id} → 只改请求体里列出的文件（null = 删除），**其余文件保持不变**，
 *   与 GitHub gist PATCH 的文档语义一致；
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

function assertNoConditionalHeaders(patches: GistCall[]): void {
  for (const [i, call] of patches.entries()) {
    const present = CONDITIONAL_HEADERS.filter((h) => call.headers[h] !== undefined);
    assert.deepEqual(present, [], '第 ' + String(i + 1) + ' 次 PATCH 不带任何条件请求头（gist 端点会回 400）');
  }
}

/* ---------------- ① 正常先后 push：后写者读到前者，两边条目都在 ---------------- */

test('先后 push①：后写者读到前者的索引 ⇒ 合并写入，两台机的条目都在最终索引里', async () => {
  const harness = makeHarness();
  const machineA = harness.transport(() => harness.files);
  const machineB = harness.transport(() => harness.files);

  await machineA.upload(snapA);
  const metaB = await machineB.upload(snapB);

  assert.equal(metaB.id, 'snap-b', 'B 正常返回自己的 meta');
  assert.equal(harness.patches.length, 2, '两次写入各发一次 PATCH（写后复核不额外写，重做没有被触发）');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-a', 'snap-b'], '索引按 createdAt 升序含有两台机的条目');
  assert.equal(harness.files[snapshotFile('snap-a')] !== undefined, true, 'A 的载荷仍在');
  assertNoConditionalHeaders(harness.patches);
});

/* ---------------- ② 写入被随后到达的写入覆盖：复核发现 → 重做 → 双方都在 ---------------- */

test('写后复核②：本次写入被随后到达的索引覆盖 ⇒ 检测到丢失并重做，双方条目都在最终索引里', async () => {
  const harness = makeHarness();
  const machineB = harness.transport(() => harness.files);

  // 模拟「B 写完之后，另一台机 C 立刻用自己的索引整体覆盖了远端」：
  // 这是写后复核唯一能看见的一类并发改动（我们的条目从索引里消失）。
  const payloadC = JSON.stringify(snapC);
  harness.hooks.onPatch = (patchNo) => {
    if (patchNo !== 1) return;
    harness.files[snapshotFile('snap-c')] = payloadC;
    harness.files[INDEX_FILE] = JSON.stringify([computeSnapshotMeta(snapC)]);
  };

  const metaB = await machineB.upload(snapB);

  assert.equal(metaB.id, 'snap-b');
  assert.equal(harness.patches.length, 2, '第一次写入被覆盖 ⇒ 复核失败 ⇒ 第二次整轮重做，共两次 PATCH');
  const ids = parseIndex(harness.files).map((m) => m.id);
  assert.deepEqual(ids, ['snap-c', 'snap-b'], '重做时读到 C 的条目并一起写回：谁都没被吞掉');
  assert.equal(harness.files[snapshotFile('snap-c')], payloadC, 'C 的载荷不被本次写入改动（逐字节相同）');
  assert.equal(harness.files[snapshotFile('snap-b')] !== undefined, true, 'B 自己的载荷已经写入');
  assertNoConditionalHeaders(harness.patches);
});

/* ---------------- ③ 持续冲突：3 次仍失败 → 抛 indexConflict，远端不被破坏 ---------------- */

test('写后复核③：每次写入都被覆盖 ⇒ 三次后抛 indexConflict，远端索引保持他人内容不被破坏', async () => {
  const harness = makeHarness();
  const machineB = harness.transport(() => harness.files);

  // 每次 PATCH 落盘后都立刻用别人的索引覆盖：复核每次都应该失败。
  const payloadC = JSON.stringify(snapC);
  harness.files[snapshotFile('snap-c')] = payloadC;
  const foreignIndex = JSON.stringify([computeSnapshotMeta(snapC)]);
  harness.hooks.onPatch = () => {
    harness.files[INDEX_FILE] = foreignIndex;
  };

  await assert.rejects(
    () => machineB.upload(snapB),
    (err: unknown) => {
      assert.ok(err instanceof GistTransportError, '必须抛通道自己的错误类型');
      assert.equal(err.kind, 'conflict', 'kind=conflict：并发冲突，需要人工重试，不是瞬时网络错误');
      assert.equal(err.code, 'index-conflict', '稳定的机器可判定错误码（不靠文案判错）');
      assert.match(err.message, /索引在写入期间被他人改动/, '错误文案说明原因并给出下一步');
      assert.doesNotMatch(err.message, /ghp_/, '错误消息绝不回显 token');
      return true;
    },
  );

  assert.equal(harness.patches.length, 3, '最多三轮「读-合并-写」，不许无限重试');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-c'], '失败后索引仍是他人那份（没有被写成半截/空）');
  assert.equal(harness.files[snapshotFile('snap-c')], payloadC, '他人的载荷逐字节未变');
  assertNoConditionalHeaders(harness.patches);
});

/* ---------------- ④ 残余限制：别人在读取与 PATCH 之间写入的条目仍会被覆盖 ---------------- */

test('残余限制④：别人在「读取」与「PATCH」之间写入的条目仍会被本次覆盖且不报错（无条件写的物理边界）', async () => {
  const harness = makeHarness();
  const machineA = harness.transport(() => harness.files);
  // 复现「两台机基于同一基线同时读、先后写」：B 的**第一次**读（合并前的那次）看到 A 写入之前的
  // 空索引，之后的重读（写后复核）才看到真实远端。真实世界里这两次读都是网络往返，窗口就是这样产生的。
  const staleBaseline: Store = { ...harness.files };
  let readsB = 0;
  const machineB = harness.transport(() => (readsB++ === 0 ? staleBaseline : harness.files));

  await machineA.upload(snapA);

  // B 用旧基线合并出自己的索引，PATCH 整体覆盖；A 的条目不在 B 读到的索引里，
  // 所以写后复核（比对「读前条目是否还在」）看不见它 —— 不会重试，也不会报错。
  const metaB = await machineB.upload(snapB);
  assert.equal(metaB.id, 'snap-b', '后写者仍正常返回（没有 conflict/412 语义）');
  assert.equal(harness.patches.length, 2, 'B 没有触发重做（读前条目为空 ⇒ 复核无从发现被覆盖的 A）');
  assert.deepEqual(parseIndex(harness.files).map((m) => m.id), ['snap-b'], '索引被整体覆盖：A 的条目消失且不报错');

  const payloadA = snapshotFile('snap-a');
  const before = harness.files[payloadA];
  assert.ok(before !== undefined, 'A push 后存在自己的载荷文件');
  assert.equal(harness.files[payloadA], before, 'B 的 PATCH 未列出该文件 ⇒ 服务端保持原样，载荷不丢');

  const observer = harness.transport(() => harness.files);
  assert.deepEqual((await observer.list()).map((m) => m.id), ['snap-b'], '第三方 list() 只看到后写者');
  const downloaded = await observer.download('snap-a');
  assert.deepEqual(computeSnapshotMeta(downloaded), computeSnapshotMeta(snapA), '按 id 仍能取回 A 的载荷且内容逐字段一致');
  assertNoConditionalHeaders(harness.patches);
});

/* ---------------- ⑤ 同 id 同内容：零 PATCH 早退语义不变 ---------------- */

test('幂等早退⑤：同 id 且分区 hash 全等 ⇒ 零 PATCH、零重做直接返回远端 meta', async () => {
  const harness = makeHarness();
  const machine = harness.transport(() => harness.files);

  await machine.upload(snapA);
  const patchesAfterFirst = harness.patches.length;
  const callsAfterFirst = harness.calls.length;

  const again = await machine.upload(snapA);

  assert.equal(again.id, 'snap-a');
  assert.equal(harness.patches.length, patchesAfterFirst, '内容相同不写远端（早退在写后复核之前）');
  assert.equal(harness.calls.length, callsAfterFirst + 1, '也不发多余的请求：整轮只多出一次「读索引」的 GET');
});

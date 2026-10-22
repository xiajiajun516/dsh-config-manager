/**
 * GitHub Gist 通道：多机「同一基线先后 push」的覆盖语义回归。
 *
 * ⚠️ 这是**钉住现状**（characterization），不是背书并发安全：
 * - 本通道的 PATCH 恒不带任何条件请求头（gist 端点对 any conditional header 回 400，issue #110；
 *   见 gist-transport.ts:58-63），因此**没有**写前并发保护；
 * - 两台机器从同一基线各推一份新索引时，后写者会用自己读到的旧索引整体覆盖索引文件：
 *   先写者的条目从索引里消失，但**不会**报错；
 * - gist 不做 blob 外置（gist-transport.ts:22-24，会话这类大分区应走 git/webdav/s3），
 *   所以「内容寻址 blob」在本通道的等价物 = 该快照自己的载荷文件 `<prefix>-<id>.json`：
 *   它只会在本机 upload 里被写、被 delete 里被置 null，别人 push 时不会被触碰 ⇒ 载荷不丢。
 *   本文件第二条用例用逐字节相等 + download 取回共同证明这一点。
 *
 * 若未来给 gist 换成「先读后比对的乐观锁」或别家的条件写，这两个用例应当变红 —— 那正是改动意图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GistTransport, GIST_DEFAULT_FILE_PREFIX } from './gist-transport.ts';
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

/**
 * 极简假 gist 服务端：
 * - GET /gists/{id} → 全量文件内容（调用方传入的「视图」决定它看到哪一版，用来模拟两台机器各自读到的基线）；
 * - PATCH /gists/{id} → 只改请求体里列出的文件（null = 删除），**其余文件保持不变**，
 *   与 GitHub gist PATCH 的文档语义一致；
 * - 其余请求一律 500，避免测试悄悄依赖未建模的端点。
 */
function makeHarness(baseline: Store = { [INDEX_FILE]: '[]' }) {
  const files: Store = { ...baseline };
  const calls: GistCall[] = [];
  const patches: GistCall[] = [];

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
      return res(200, '{}');
    }
    return res(500, 'unexpected ' + method + ' ' + url);
  };

  const transport = (view: () => Store): GistTransport =>
    new GistTransport({ gistId: GIST_ID, credentials: { getToken: async () => TOKEN }, request: makeClient(view) });

  return { files, calls, patches, transport };
}

/** 两台机器「同一基线」的场景：A 先 push，B 用的是 A push 之前读到的基线视图 */
async function twoMachinesSameBaseline(): Promise<{
  harness: ReturnType<typeof makeHarness>;
  snapA: SyncSnapshot;
  snapB: SyncSnapshot;
}> {
  const harness = makeHarness();
  const frozenBaseline: Store = { ...harness.files };
  const snapA = sampleSnapshot('snap-a', '2026-10-20T08:00:00.000Z', 'from-A');
  const snapB = sampleSnapshot('snap-b', '2026-10-20T09:00:00.000Z', 'from-B');

  const machineA = harness.transport(() => harness.files);
  const machineB = harness.transport(() => frozenBaseline);

  await machineA.upload(snapA); // A 先写：索引 = [A]
  await machineB.upload(snapB); // B 仍按基线写：索引 = [B]
  return { harness, snapA, snapB };
}

/* ---------------- ① 后写者整体覆盖、不抛错 ---------------- */

test('多机同基线先后 push①：后写者整体覆盖索引且不抛错（gist 无条件的现状语义）', async () => {
  const harness = makeHarness();
  const frozenBaseline: Store = { ...harness.files };
  const snapA = sampleSnapshot('snap-a', '2026-10-20T08:00:00.000Z', 'from-A');
  const snapB = sampleSnapshot('snap-b', '2026-10-20T09:00:00.000Z', 'from-B');
  const machineA = harness.transport(() => harness.files);
  const machineB = harness.transport(() => frozenBaseline);

  await machineA.upload(snapA);

  // 关键断言语义：现行实现不做条件写，所以 B 的 push **必须成功、绝不 reject**。
  // 未来若改成条件写（远端已变即中止）→ 这里抛错，用例变红，正是改动需要被看见的地方。
  const metaB = await machineB.upload(snapB);
  assert.equal(metaB.id, 'snap-b', 'B 的 push 正常返回自己的 meta（没有 conflict/412 语义）');

  assert.equal(harness.patches.length, 2, '两台机器各发一次 PATCH（没有额外的重试/探测写）');

  const secondPatch = harness.patches[1];
  assert.ok(secondPatch !== undefined, '必须有第二次 PATCH');
  const bBody = JSON.parse(secondPatch.body ?? '{}') as {
    files: Record<string, { content: string } | null>;
  };
  assert.deepEqual(
    Object.keys(bBody.files).sort(),
    [snapshotFile('snap-b'), INDEX_FILE].sort(),
    'B 的 PATCH 只声明自己的载荷与索引两个文件',
  );
  assert.equal(bBody.files[snapshotFile('snap-a')], undefined, 'B 绝不把 A 的载荷置 null（不删别人的文件）');

  const indexBody = harness.files[INDEX_FILE];
  assert.ok(indexBody !== undefined, '索引文件必须存在');
  const idxAfter = JSON.parse(indexBody) as SyncSnapshotMeta[];
  assert.deepEqual(idxAfter.map((m) => m.id), ['snap-b'], '索引被整体覆盖：A 的条目消失（不是合并，也不报错）');

  for (const [i, call] of harness.patches.entries()) {
    const present = CONDITIONAL_HEADERS.filter((h) => call.headers[h] !== undefined);
    assert.deepEqual(present, [], '第 ' + String(i + 1) + ' 次 PATCH 不带任何条件请求头（gist 端点会回 400）');
  }

  const observer = harness.transport(() => harness.files);
  assert.deepEqual(
    (await observer.list()).map((m) => m.id),
    ['snap-b'],
    '第三方 list() 只看到后写者：先写者的快照从「有哪些快照」里消失',
  );
});

/* ---------------- ② 索引覆盖但先写者的载荷不丢 ---------------- */

test('多机同基线先后 push②：索引被覆盖，但 A 的载荷文件逐字节未变且 download 仍能取回', async () => {
  const { harness, snapA } = await twoMachinesSameBaseline();

  const payloadFileA = snapshotFile('snap-a');
  const payloadAfterA = harness.files[payloadFileA];
  assert.ok(payloadAfterA !== undefined, 'A push 后必须存在自己的载荷文件');
  assert.equal(
    harness.files[payloadFileA],
    payloadAfterA,
    'B 的 push 之后 A 的载荷逐字节未变（PATCH 未列出该文件 ⇒ 服务端保持原样，不丢）',
  );

  const observer = harness.transport(() => harness.files);
  const listed = (await observer.list()).map((m) => m.id);
  assert.deepEqual(listed, ['snap-b'], '索引里已没有 A');

  const downloaded = await observer.download('snap-a');
  assert.equal(downloaded.id, 'snap-a', '按 id 仍能取回 A 的快照（载荷不丢，丢的只是索引可见性）');
  assert.equal(downloaded.createdAt, snapA.createdAt);
  assert.deepEqual(downloaded.sections, snapA.sections, '取回的分区内容与 A 写入时逐字段相同（内容未损坏）');
  assert.deepEqual(
    computeSnapshotMeta(downloaded),
    computeSnapshotMeta(snapA),
    'meta（分区 hash / manifest）与 A 本地完全一致 ⇒ 内容寻址意义上的载荷可复原',
  );

  // 说明证据边界：gist 不做 blob 外置（gist-transport.ts:22-24），这里「载荷不丢」指的是本快照文件本身；
  // 若未来引入外置 blob（文件数上限/截断问题会先撞上），需要另立用例证明 blob 不被后写者清理。
});

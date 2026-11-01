/**
 * UiT 目录（`src/ui/i18n.ts`）的 i18n 契约测试 —— t12：新增**语境中立**的通用超时键
 * `error.requestTimeout`。
 *
 * 背景：W4（t4）把客户端请求封装收敛到 `src/client/common/http.ts` 后，**默认**超时路径只能二选一：
 *  - `error.fallback`（「操作失败」）——不说是超时、无可操作信息；
 *  - 请求族专属键（导出/同步/恢复/灾备，「请检查网络与仓库可达性」一类）——套到普通本机读写会给出
 *    **错误诊断**（把「宿主卡死」说成网络或恢复问题）。
 * t12 补一条语境中立的通用超时键，t13 把默认路径切过去。本文件同时钉住**文案契约**与**接线事实**：
 *
 *  1. zh / en 齐备、互为镜像（不同文、非空）、带 `{seconds}` 占位符且插值生效；
 *  2. 措辞与四个请求族键及 `error.fallback` **两两不同**，且不含任何语境专属措辞
 *     （导出/同步/恢复/灾备/网络/仓库/撤销/重做 ↔ Export/Sync/Recovery/network/repository/undo/redo）；
 *  3. 既有请求族专属键**未被删除或改写**（仍带各自语境诊断 + `{minutes}` 占位符）。
 *
 *  4. **默认超时路径实际使用该键**：既经 `timeoutMessage` 缺省参数，也经真实请求（`getJson` / `openStream`
 *     在宿主不响应时的统一超时错误文案）——接线在 `src/client/common/http.ts` 的 `DEFAULT_TIMEOUT_KEY`。
 *     这一条必须在这里再钉一次：只查字典会漏掉「键加了但默认路径没换」这种半成品。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeUiT, uiEn, uiZh, zhUiT } from './i18n.ts';
import {
  ConfigManagerApiError,
  DEFAULT_TIMEOUT_KEY,
  getJson,
  openStream,
  REQUEST_TIMEOUT_MS,
  timeoutMessage,
} from '../client/common/http.ts';

const enT = makeUiT('en');

/** 请求族专属超时键：各自调用点仍在使用，**不得**被默认键取代或改写。 */
const FAMILY_KEYS = [
  'error.exportTimeout',
  'error.syncTimeout',
  'error.recoveryTimeout',
] as const;

/** 每个请求族键仍必须携带的语境专属措辞（被改写即红灯）。 */
const FAMILY_ZH_MARKERS: Record<(typeof FAMILY_KEYS)[number], string> = {
  'error.exportTimeout': '导出',
  'error.syncTimeout': '同步',
  'error.recoveryTimeout': '恢复',
};

/** 语境专属标记：通用键里出现任何一个，就说明它不够中立（会误报诊断）。 */
const ZH_CONTEXT_MARKERS = ['导出', '同步', '恢复', '灾备', '网络', '仓库', '撤销', '重做'];
const EN_CONTEXT_MARKERS = ['Export', 'Sync', 'Recovery', 'network', 'repository', 'undo', 'redo'];

/** 永不返回的 fetch：只有 abort 能让它 reject（模拟宿主卡死；与 http.test.ts 的夹具同款）。 */
function installHangingFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as typeof fetch;
  test.after(() => { globalThis.fetch = original; });
}

test('i18n-01 error.requestTimeout：zh / en 齐备、镜像、带 {seconds} 占位符', () => {
  // 类型层：uiEn 是 Record<UiTextKey, string>，zh 缺键 → 编译失败；这里再钉运行期取值
  const zh = uiZh['error.requestTimeout'];
  const en = uiEn['error.requestTimeout'];
  assert.equal(typeof zh, 'string', 'zh 字典必须新增 error.requestTimeout');
  assert.equal(typeof en, 'string', 'en 字典必须镜像该键');
  assert.notEqual(zh.trim(), '', 'zh 文案不得为空');
  assert.notEqual(en.trim(), '', 'en 文案不得为空');
  assert.notEqual(zh, en, 'zh / en 不得同文（en 是镜像而不是复制）');
  assert.match(zh, /\{seconds\}/, '通用超时键按秒插值（30s 档位读作「30 秒」更准）');
  assert.match(en, /\{seconds\}/, 'en 镜像同样按秒插值');
  // 插值真的经过 makeUiT 的参数替换路径
  assert.match(zhUiT('error.requestTimeout', { seconds: '30' }), /30/, 'zh 插值必须生效');
  assert.match(enT('error.requestTimeout', { seconds: '30' }), /30/, 'en 插值必须生效');
});

test('i18n-02 默认键措辞中立：与请求族键及 error.fallback 都不同，且不含语境专属措辞', () => {
  const zh = uiZh['error.requestTimeout'];
  const en = uiEn['error.requestTimeout'];
  for (const key of FAMILY_KEYS) {
    assert.notEqual(zh, uiZh[key], `zh 不得与 ${key} 同文（同文等于借用请求族措辞）`);
    assert.notEqual(en, uiEn[key], `en 不得与 ${key} 同文`);
  }
  assert.notEqual(zh, uiZh['error.fallback'], '默认键必须比 error.fallback 更具体（要点明这是一次超时）');
  assert.match(zh, /超时/, '仍要点明「超时」这一事实');
  assert.match(en, /timed out/i, 'en 同样要点明超时');
  for (const marker of ZH_CONTEXT_MARKERS) {
    assert.equal(zh.includes(marker), false, `zh 不得含语境专属措辞「${marker}」（会误导诊断）`);
  }
  for (const marker of EN_CONTEXT_MARKERS) {
    assert.equal(
      en.toLowerCase().includes(marker.toLowerCase()),
      false,
      `en 不得含语境专属措辞「${marker}」`,
    );
  }
});

test('i18n-03 既有请求族专属超时键仍在，且各自保留语境专属诊断', () => {
  for (const key of FAMILY_KEYS) {
    assert.match(uiZh[key], /\{minutes\}/, `${key} 仍按分钟插值（既有调用点行为不变）`);
    assert.match(uiEn[key], /\{minutes\}/, `${key} 的 en 镜像仍按分钟插值`);
    assert.ok(
      uiZh[key].includes(FAMILY_ZH_MARKERS[key]),
      `${key} 仍带语境专属措辞「${FAMILY_ZH_MARKERS[key]}」（未被默认键改写）`,
    );
  }
  // sync 键的「网络与仓库可达性」诊断必须原样保留：它正是「请求族专属、不能当默认」的证据
  assert.match(uiZh['error.syncTimeout'], /网络与仓库可达性/);
  assert.match(uiEn['error.syncTimeout'], /network and repository reachability/);
});

test('i18n-04 默认超时路径走 error.requestTimeout（timeoutMessage 缺省参数，不是请求族键）', () => {
  assert.equal(DEFAULT_TIMEOUT_KEY, 'error.requestTimeout', '模块默认超时键必须是语境中立通用键');
  const zh = timeoutMessage(zhUiT, REQUEST_TIMEOUT_MS);
  assert.equal(zh, zhUiT('error.requestTimeout', { seconds: '30' }), '缺省 30s → 通用键的 30 秒文案');
  assert.equal(
    timeoutMessage(enT, REQUEST_TIMEOUT_MS),
    enT('error.requestTimeout', { seconds: '30' }),
    'en 缺省路径同样走通用键',
  );
  assert.notEqual(zh, zhUiT('error.fallback'), '默认路径不得再退回 error.fallback');
  for (const key of FAMILY_KEYS) {
    assert.notEqual(zh, zhUiT(key, { minutes: '1' }), `默认路径不得落在 ${key} 的文案上`);
  }
  // 显式指定时仍按指定键（请求族调用点不受影响）
  assert.equal(timeoutMessage(zhUiT, REQUEST_TIMEOUT_MS, 'error.syncTimeout'), zhUiT('error.syncTimeout', { minutes: '1' }));
});

test('i18n-05 默认超时路径走 error.requestTimeout（真实请求：getJson / openStream 宿主不响应）', async () => {
  installHangingFetch();
  // 50ms 触发（不真等）：seconds = max(1, round(0.05)) = 1
  await assert.rejects(getJson('/api/hang', zhUiT, { timeoutMs: 50 }), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError, '超时必须映射为 ConfigManagerApiError');
    assert.equal((err as Error).message, zhUiT('error.requestTimeout', { seconds: '1' }));
    return true;
  });
  await assert.rejects(openStream('/api/download', zhUiT, { timeoutMs: 50 }), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError, 'openStream headers 阶段超时同样走统一错误');
    assert.equal((err as Error).message, zhUiT('error.requestTimeout', { seconds: '1' }));
    return true;
  });
});

// 复数语法（2026-11-01）：`{n, plural, one|other}`。英文 (s)/(ies) 括号式复数全站清零后，
// 单复数由这条替换链决定 —— 它错了整站英文都会退回 "1 files"。
test('i18n-06 plural 段按数量选形：1/-1 取 one，0/2/非数取 other', () => {
  assert.equal(enT('report.unit.files', { n: 1 }), 'file');
  assert.equal(enT('report.unit.files', { n: 2 }), 'files');
  assert.equal(enT('report.unit.files', { n: 0 }), 'files');
  assert.equal(enT('report.unit.files', { n: -1 }), 'file', '负数是绝对值为 1，不当成复数');
  assert.equal(enT('report.unit.files', { n: '1' }), 'file', '占位符值是字符串也要认');
  assert.equal(enT('report.unit.files', { n: 'n/a' }), 'files', '无法解析成数字时按复数兜底，不抛错');
  // 缺参时与普通占位符同口径：原样保留模板（调用点漏传会显形，而不是静默选错形）
  assert.equal(enT('report.unit.files'), '{n, plural, file|files}');
});

test('i18n-07 plural 段与数字并存：数字仍由普通占位符渲染，且只出现一次', () => {
  const en = enT('consult.attention', { count: 1 });
  assert.equal(en, '1 item needs attention');
  assert.equal(enT('consult.attention', { count: 3 }), '3 items need attention');
  // 动词单复数必须跟着变：`3 item need` / `1 items did` 这类残留是这条断言的主要目标
  assert.equal(
    enT('sync.importPartial', { n: 1 }),
    'Partly successful: 1 item did not take effect (the rest were written; nothing rolled back)',
  );
  assert.equal(
    enT('sync.importPartial', { n: 4 }),
    'Partly successful: 4 items did not take effect (the rest were written; nothing rolled back)',
  );
});

test('i18n-08 英文字典不留 (s)/(ies) 括号式复数（今日起由 plural 段承担）', () => {
  const offenders: string[] = [];
  const collect = (dict: Record<string, string>, label: string) => {
    for (const [key, value] of Object.entries(dict)) {
      if (/\(s\)|\(ies\)/.test(value) && !/http\(s\)/.test(value)) offenders.push(label + ':' + key + ' = ' + value);
    }
  };
  collect(uiEn, 'uiEn');
  // 客户端四本字典同查：改的是源码文本，不 import（client 侧不保证可被 node 直接加载）
  for (const rel of ['../client/locales.ts', '../client/sync/sync-locales.ts', '../client/market/market-locales.ts', '../client/recovery/recovery-locales.ts']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      if (/\((s|ies)\)/.test(line) && !/http\(s\)/.test(line) && /:\s*'/.test(line)) offenders.push(rel + ' :: ' + line.trim());
    }
  }
  assert.deepEqual(offenders, [], '括号式复数会让 1 渲染成 "1 file(s)"；改用 {n, plural, file|files}');
});

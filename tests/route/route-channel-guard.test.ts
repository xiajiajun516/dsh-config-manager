/**
 * W1（host-entry B7 收尾）：**宿主路由层不得手写通道判定/枚举**——单一来源是
 * \`src/sync/sync-config.ts\` 的 \`SYNC_CHANNELS\` / \`channelOf\` / \`parseSyncChannel\`。
 *
 * 为什么扩这条守卫：W1 把 57 条路由拆到 \`src/routes/*.ts\`，而原有的 B7 守卫
 * （\`src/sync/sync-config.test.ts\`）只扫 \`src/index.ts\` —— 拆分会让它**静默失去覆盖**。
 * 本文件补上三件事：
 *  1. 覆盖范围 = 全部宿主路由源（\`src/index.ts\` + \`src/routes/*.ts\`）；
 *  2. 新增**谓词形态**：\`isWebDavConfig(cfg) ? 'webdav' : ...\` 这类「用类型守卫直接产出通道值」的写法
 *     同样是把通道判定散落出去（t3 收口的那处 :3731 webdav 子对象开关即此形态）；
 *  3. 负向自检：把同一扫描器喂给合成片段，证明它真的会红（否则「扫不到即假绿」）。
 *
 * 注释剥离复用 utils/bundle-scan.ts 的 stripJsComments（多趟并集；注释里写 ['git','webdav']
 * 的诱饵文本不会误报——那是本仓库踩过两次的坑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { stripJsComments } from '../../src/utils/bundle-scan.ts';

const root = path.resolve(import.meta.dirname, '../..');

function routeSources(): Map<string, string> {
  const out = new Map<string, string>();
  out.set('src/index.ts', fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8'));
  const dir = path.join(root, 'src/routes');
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.set('src/routes/' + entry, fs.readFileSync(path.join(dir, entry), 'utf8'));
  }
  return out;
}

/** 扫描器：返回「真实代码行」里的通道判定违规（注释行在两趟里至少一趟被清空 → 不采信）。 */
function scanChannelLiterals(source: string): string[] {
  const tplLines = stripJsComments(source, true, false).split(String.fromCharCode(10));
  const opaqueLines = stripJsComments(source, false, true).split(String.fromCharCode(10));
  const bad: string[] = [];
  tplLines.forEach((line, i) => {
    const t = line.trim();
    if (t === '' || (opaqueLines[i] ?? '').trim() === '') return;
    if (t.includes("['git', 'webdav']") || t.includes("['git','webdav']")) bad.push(String(i + 1) + ': 通道数组字面量 ' + t);
    if (/\?\s*'webdav'\s*:\s*'git'/.test(t) || /\?\s*'git'\s*:\s*'webdav'/.test(t)) bad.push(String(i + 1) + ': 裸通道三元判定 ' + t);
    // 谓词形态：类型守卫直接产出通道字面量（应改用 channelOf(cfg)）
    if (/is(WebDav|Git)Config\([^)]*\)[^?]*\?\s*'(webdav|git)'/.test(t)) bad.push(String(i + 1) + ': 谓词形态通道判定 ' + t);
  });
  return bad;
}

test('B7+：全部宿主路由源都不得手写通道数组/通道三元/谓词形态判定', () => {
  const sources = routeSources();
  assert.ok(sources.size >= 12, '扫描范围必须覆盖 index.ts + 拆出的路由组（实际 ' + sources.size + ' 个文件）');
  const violations: string[] = [];
  for (const [file, text] of sources) for (const v of scanChannelLiterals(text)) violations.push(file + ' ' + v);
  assert.deepEqual(violations, [], '宿主路由源不得手写通道判定（应消费 channelOf / parseSyncChannel / SYNC_CHANNELS）:' + String.fromCharCode(10) + violations.join(String.fromCharCode(10)));
  // 正向断言：确实接上了单一来源（否则上面可能因「什么都没写」而假绿）
  const joined = [...sources.values()].join(String.fromCharCode(10));
  assert.ok(joined.includes('channelOf('), '宿主路由源必须消费 channelOf（单一来源）');
  assert.ok(joined.includes('parseSyncChannel('), '宿主路由源必须消费 parseSyncChannel（单一来源）');
});

test('B7+ 扫描器自检：三种形态各自都会红（防「扫不到即假绿」）', () => {
  const banned = [
    "const x = ['git', 'webdav']",
    "const c = flag ? 'webdav' : 'git'",
    "const c2 = isWebDavConfig(cfg) ? 'webdav' : 'git'",
  ];
  for (const snippet of banned) {
    assert.ok(scanChannelLiterals(snippet).length > 0, '必须检出: ' + snippet);
  }
  // 允许的形态（W1 收口后的实际写法）不得误报
  const allowed = [
    "const channel = channelOf(syncCfg)",
    "webdav: channelOf(syncCfg) === 'webdav' ? describeWebDavSlot(syncCfg, credential.configured) : undefined,",
    "if (!isWebDavConfig(cfg)) return undefined",
    "for (const channel of SYNC_CHANNELS) out[channel] = await build(channel)",
  ];
  for (const snippet of allowed) {
    assert.deepEqual(scanChannelLiterals(snippet), [], '不得误报: ' + snippet);
  }
  // 注释诱饵不得误报（本仓库已两次踩到「注释里的同名串」）
  const decoy = [
    '// 反例（注释）：const x = [',
    "'git', 'webdav'] 与 flag ?",
    " 'webdav' : 'git'",
    '// const c2 = isWebDavConfig(cfg) ? ',
    "'webdav' : 'git'",
    'const channel = channelOf(cfg)',
  ].join(String.fromCharCode(10));
  assert.deepEqual(scanChannelLiterals(decoy), [], '注释里的诱饵文本不得误报');
});

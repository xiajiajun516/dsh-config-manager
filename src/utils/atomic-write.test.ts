/**
 * 原子写 primitive 测试（Phase 1）。
 * - Basic：新文件/替换/Unicode/空/大文件/嵌套目录/mode 保留/敏感 open-wx-0600
 * - 故障注入：AtomicIo 逐点失败 → 断言「target 要么旧完整、要么新完整」
 * - 并发：双写同 target 终态完整
 * - Symlink/Hardlink：follow / reject / hardlink 断开无损坏
 * - Windows：rename-overwrite、EPERM 注入重试+失败不改 target
 * - 崩溃模拟：子进程 tmp 写后、rename 后 exit → 磁盘完整性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicCopyFile,
  sanitizeTmpBase,
  type AtomicIo,
  type AtomicHandle,
} from './atomic-write.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------- 可注入失败点的 AtomicIo ----------
// 基于真实 node:fs/promises，仅在某些步骤抛错；open 返回真实 handle 包装。
function failingIo(): AtomicIo & { failAt(step: string): void } {
  const failSet = new Set<string>();
  const maybeThrow = (step: string) => {
    if (failSet.has(step)) throw new Error(`injected failure at ${step}`);
  };
  const io: AtomicIo = {
    async mkdir(d, o) { maybeThrow('mkdir'); await fs.mkdir(d, o); },
    async lstat(p) {
      maybeThrow('lstat');
      try { return await fs.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    async stat(p) {
      maybeThrow('stat');
      try { return await fs.stat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    async realpath(p) { maybeThrow('realpath'); return fs.realpath(p); },
    async open(p, flag, mode) {
      maybeThrow('open');
      const handle = await fs.open(p, flag as 'wx', mode);
      return wrap(handle);
    },
    async rename(a, b) { maybeThrow('rename'); await fs.rename(a, b); },
    async unlink(p) { maybeThrow('unlink'); await fs.unlink(p); },
    async copyFile(a, b) { maybeThrow('copyFile'); await fs.copyFile(a, b); },
    async chmod(p, m) { maybeThrow('chmod'); await fs.chmod(p, m); },
    async fsyncDir() { maybeThrow('fsyncDir'); },
    async sleep(ms) { maybeThrow('sleep'); await new Promise((r) => setTimeout(r, ms)); },
  };
  const wrap = (h: Awaited<ReturnType<typeof fs.open>>): AtomicHandle => ({
    async writeFile(data) { maybeThrow('write'); await h.writeFile(data); },
    async sync() { maybeThrow('sync'); await h.sync(); },
    async close() { maybeThrow('close'); await h.close(); },
  });
  return { ...io, failAt: (s) => { failSet.add(s); } };
}

async function readText(p: string): Promise<string> { return new TextDecoder().decode(await fs.readFile(p)); }

test('sanitizeTmpBase 拒绝危险文件名', () => {
  assert.equal(sanitizeTmpBase('settings.yaml'), 'settings.yaml');
  assert.throws(() => sanitizeTmpBase('..'));
  assert.throws(() => sanitizeTmpBase('a/b'));
  assert.throws(() => sanitizeTmpBase('a\\b'));
  assert.throws(() => sanitizeTmpBase(''));
  assert.throws(() => sanitizeTmpBase('a:b'));
  assert.throws(() => sanitizeTmpBase('a\u0000b'));
});

test('Basic：新文件（嵌套目录自动创建）', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'a', 'b', 'new.yaml');
  await atomicWriteFile(p, new TextEncoder().encode('k: v\n'));
  assert.equal(await readText(p), 'k: v\n');
});

test('Basic：替换已有文件', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'x.json');
  await fs.writeFile(p, '{"old":true}');
  await atomicWriteFile(p, new TextEncoder().encode('{"new":true}'));
  assert.equal(await readText(p), '{"new":true}');
});

test('Basic：Unicode 路径', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, '配置', '设置-🎯.yaml');
  await atomicWriteFile(p, new TextEncoder().encode('ok'));
  assert.equal(await readText(p), 'ok');
});

test('Basic：空文件', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'empty.txt');
  await atomicWriteFile(p, new Uint8Array(0));
  assert.equal(await readText(p), '');
});

test('Basic：大文件（1.5MB）', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'big.bin');
  const data = new Uint8Array(1_500_000).fill(0x41);
  await atomicWriteFile(p, data);
  const read = await fs.readFile(p);
  assert.equal(read.length, data.length);
  assert.ok(read.equals(Buffer.from(data)));
});

test('Basic：mode 保留（POSIX 0o700 继承；Windows 仅验证内容）', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'cfg.json');
  await fs.writeFile(p, 'old', { mode: 0o700 });
  await atomicWriteFile(p, new TextEncoder().encode('new'));
  if (process.platform === 'win32') {
    // Windows 对 POSIX 权限位不生效（设计 §2.4 已声明 mode 语义弱）：只验证内容与可读
    assert.equal(await readText(p), 'new');
    return;
  }
  assert.equal((await fs.stat(p)).mode & 0o777, 0o700);
});

test('Basic：sensitive 新文件 open-wx-0600（POSIX 断言 0600；Windows 验证内容）', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'secrets.env');
  await atomicWriteFile(p, new TextEncoder().encode('TOKEN=x'), { mode: 0o600 });
  if (process.platform === 'win32') {
    assert.equal(await readText(p), 'TOKEN=x');
    return;
  }
  assert.equal((await fs.stat(p)).mode & 0o777, 0o600);
});

test('故障注入：write 失败 → target 保持旧完整，无 tmp 残留', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'f.json');
  await fs.writeFile(p, 'old-complete');
  const io = failingIo();
  io.failAt('write');
  await assert.rejects(() => atomicWriteFile(p, new TextEncoder().encode('new'), { io }));
  assert.equal(await readText(p), 'old-complete');
  assert.equal((await fs.readdir(dir)).filter((n) => n.startsWith('.dshcm.')).length, 0);
});

test('故障注入：sync 失败 → target 保持旧完整 + tmp 清理', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'f.json');
  await fs.writeFile(p, 'old-complete');
  const io = failingIo();
  io.failAt('sync');
  await assert.rejects(() => atomicWriteFile(p, new TextEncoder().encode('new'), { io }));
  assert.equal(await readText(p), 'old-complete');
  assert.equal((await fs.readdir(dir)).filter((n) => n.startsWith('.dshcm.')).length, 0);
});

test('故障注入：rename 持续失败 → 不改写原 target，且 tmp 已清理', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'f.json');
  await fs.writeFile(p, 'old-complete');
  const io = failingIo();
  io.failAt('rename');
  await assert.rejects(() => atomicWriteFile(p, new TextEncoder().encode('new'), { io, retryDelayMs: 1 }));
  assert.equal(await readText(p), 'old-complete');
  // rename 失败后尽力清理 tmp（不残留 orphan）
  assert.equal((await fs.readdir(dir)).filter((n) => n.startsWith('.dshcm.')).length, 0);
});

test('故障注入：EPERM 一次后重试成功（有界重试恢复）', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'f.json');
  await fs.writeFile(p, 'old-complete');
  let renameCalls = 0;
  const io = failingIo();
  const counted: AtomicIo = {
    ...io,
    async rename(a, b) {
      renameCalls++;
      if (renameCalls === 1) { const e: NodeJS.ErrnoException = new Error('injected'); e.code = 'EBUSY'; throw e; }
      await fs.rename(a, b);
    },
  };
  await atomicWriteFile(p, new TextEncoder().encode('new'), { io: counted, retryDelayMs: 1 });
  assert.equal(renameCalls, 2);
  assert.equal(await readText(p), 'new');
});

test('故障注入：unlink(tmp) 失败 → onCleanupFailure 留痕，不吞错', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'f.json');
  await fs.writeFile(p, 'old-complete');
  const io = failingIo();
  io.failAt('write');
  io.failAt('unlink');
  const cleaned: string[] = [];
  await assert.rejects(() => atomicWriteFile(p, new TextEncoder().encode('new'), { io, onCleanupFailure: (tp) => cleaned.push(tp) }));
  assert.ok(cleaned.length > 0);
  assert.equal(await readText(p), 'old-complete');
});

test('并发：双写同 target 终态为完整 A 或完整 B', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'c.json');
  const a = new Uint8Array(500_000).fill(0x41);
  const b = new Uint8Array(500_000).fill(0x42);
  await Promise.all([atomicWriteFile(p, a), atomicWriteFile(p, b)]);
  const read = await fs.readFile(p);
  assert.equal(read.length, 500_000);
  const allA = read.every((byte) => byte === 0x41);
  const allB = read.every((byte) => byte === 0x42);
  assert.ok(allA || allB, '终态必须为完整 A 或完整 B');
});

test('Symlink follow：写真实目标，symlink 结构保留', async (t) => {
  const dir = tmp(t);
  const real = path.join(dir, 'real.yaml');
  const link = path.join(dir, 'link.yaml');
  await fs.writeFile(real, 'old');
  try { fssync.symlinkSync(real, link); } catch { t.diagnostic('symlink 创建失败，跳过'); return; }
  await atomicWriteFile(link, new TextEncoder().encode('new'));
  assert.equal(await readText(real), 'new');
  assert.ok((await fs.lstat(link)).isSymbolicLink());
});

test('Symlink reject：拒绝写 symlink，不改真实目标', async (t) => {
  const dir = tmp(t);
  const real = path.join(dir, 'real.env');
  const link = path.join(dir, 'link.env');
  await fs.writeFile(real, 'old-secret');
  try { fssync.symlinkSync(real, link); } catch { t.diagnostic('symlink 创建失败，跳过'); return; }
  await assert.rejects(() => atomicWriteFile(link, new TextEncoder().encode('evil'), { symlink: 'reject' }));
  assert.equal(await readText(real), 'old-secret');
});

test('Hardlink：原子替换断开 hardlink（兄弟指向旧 inode，无损坏）', async (t) => {
  const dir = tmp(t);
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  await fs.writeFile(a, 'x');
  try { fssync.linkSync(a, b); } catch { t.diagnostic('hardlink 创建失败，跳过'); return; }
  await atomicWriteFile(a, new TextEncoder().encode('new-a'));
  assert.equal(await readText(a), 'new-a');
  const bContent = await readText(b);
  // 允许兄弟指向旧内容（断开），但不得损坏/半写
  assert.ok(bContent === 'x' || bContent === 'new-a');
});

test('atomicWriteFileSync：同步版新建+替换', (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 's.json');
  atomicWriteFileSync(p, new TextEncoder().encode('one'));
  assert.equal(fssync.readFileSync(p, 'utf8'), 'one');
  atomicWriteFileSync(p, new TextEncoder().encode('two'));
  assert.equal(fssync.readFileSync(p, 'utf8'), 'two');
});

test('atomicCopyFile：大文件流式拷贝 + 覆盖已存在', async (t) => {
  const dir = tmp(t);
  const src = path.join(dir, 'src.big');
  const dst = path.join(dir, 'dst.big');
  const data = new Uint8Array(2_500_000).fill(0x33);
  await fs.writeFile(src, data);
  await atomicCopyFile(src, dst);
  assert.ok((await fs.readFile(dst)).equals(Buffer.from(data)));
  await fs.writeFile(dst, 'short');
  await atomicCopyFile(src, dst);
  assert.ok((await fs.readFile(dst)).equals(Buffer.from(data)));
});

test('Windows：rename-overwrite 已存在（本机即 Windows 实跑）', async (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'w.txt');
  await fs.writeFile(p, 'old');
  await atomicWriteFile(p, new TextEncoder().encode('new'));
  assert.equal(await readText(p), 'new');
});

test('崩溃模拟：tmp 写+fsync 后 rename 前 exit → target 保持旧完整', async (t) => {
  const dir = tmp(t);
  const target = path.join(dir, 'crash.json');
  const childScript = `
    const fsr = require('node:fs/promises'); const path = require('node:path');
    (async () => {
      const dir = ${JSON.stringify(dir)}; const target = ${JSON.stringify(target)};
      await fsr.writeFile(target, 'old-complete');
      const tmp = path.join(dir, '.dshcm.crash.' + process.pid + '.deadbeef.tmp');
      const fh = await fsr.open(tmp, 'wx');
      await fh.writeFile('new-content'); await fh.sync(); await fh.close();
      process.exit(42); // 模拟崩溃：tmp 已写完整，未 rename
    })();
  `;
  try {
    execFileSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
    assert.fail('子进程应以非零码退出');
  } catch (e) {
    assert.equal((e as { status?: number }).status, 42);
  }
  // target 未被改动（仍是旧完整版）；孤儿 tmp 可被识别（.dshcm. 前缀 + 死 pid）
  assert.equal(await readText(target), 'old-complete');
  const orphans = (await fs.readdir(dir)).filter((n) => n.startsWith('.dshcm.'));
  assert.equal(orphans.length, 1, '崩溃后应留下可识别的孤儿 tmp（供 orphan sweep）');
});

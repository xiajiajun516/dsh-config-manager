/**
 * 文件级 vault 单元测试（src/security/vault.ts）。
 *
 * 覆盖：镜像 → 删除源 → 恢复 → 缺失提示；幂等；清理旧镜像；不覆盖已存在目标；
 * 路径穿越防御。全部基于内存 FileSystemFacade mock（对齐 core 层解耦，node 可测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { refreshVault, restoreVaultFiles, listVault, vaultRootOf, DEFAULT_SENSITIVE_RELS } from './vault.ts';
import type { FileSystemFacade } from '../core/types.ts';
import { normalizePath } from '../utils/paths.ts';

/* ================= 内存 fs mock（key 与宿主一致：home 内绝对路径归一化） ================= */

class MemFs implements FileSystemFacade {
  files = new Map<string, Uint8Array>();
  private readonly homeDir: string;
  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }
  private key(p: string): string {
    return normalizePath(path.resolve(this.homeDir, p));
  }
  async readFile(relPath: string): Promise<Uint8Array> {
    const v = this.files.get(this.key(relPath));
    if (v === undefined) throw new Error(`ENOENT: ${relPath}`);
    return v;
  }
  async writeFile(relPath: string, data: Uint8Array): Promise<void> {
    this.files.set(this.key(relPath), data);
  }
  async exists(relPath: string): Promise<boolean> {
    return this.files.has(this.key(relPath));
  }
  async copy(from: string, to: string): Promise<void> {
    const v = this.files.get(this.key(from));
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(this.key(to), v);
  }
  async remove(relPath: string): Promise<void> {
    this.files.delete(this.key(relPath));
  }
  async listRecursive(dir: string): Promise<string[]> {
    const base = normalizePath(path.resolve(this.homeDir));
    const prefix = normalizePath(path.resolve(this.homeDir, dir));
    const out: string[] = [];
    for (const k of this.files.keys()) {
      if (k === prefix || k.startsWith(prefix + '/')) {
        out.push(k.slice(base.length).replace(/^[\\/]+/, ''));
      }
    }
    return out.sort();
  }
  async mkdir(): Promise<void> { /* 内存实现无需建目录 */ }
}

const HOME = path.resolve('/home/alice'); // POSIX 风格绝对路径，跨平台 key 一致
const DATA_DIR = path.join(HOME, 'dsh-config-manager');
const CRED = '.credentials.yaml';
const CRED_SRC = path.join(HOME, CRED);
const CRED_VAULT = path.join(DATA_DIR, 'vault', CRED);
const CRED_BYTES = Buffer.from('apiKey: sk-super-secret-123\n', 'utf8');

test('refreshVault：现存敏感文件镜像入库，重复调用幂等', async () => {
  const fs = new MemFs(HOME);
  await fs.writeFile(CRED_SRC, CRED_BYTES);

  const r1 = await refreshVault(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.deepEqual(r1.mirrored, [CRED], '应镜像 .credentials.yaml');
  assert.deepEqual(r1.cleaned, [], '首次刷新无清理');
  assert.deepEqual(r1.skipped, [], '无跳过项');
  // vault 内容与源字节一致
  const mirrored = await fs.readFile(CRED_VAULT);
  assert.deepEqual(Buffer.from(mirrored), CRED_BYTES, 'vault 镜像字节应与源一致');

  // 幂等：再次刷新结果一致，无重复条目
  const r2 = await refreshVault(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.deepEqual(r2.mirrored, [CRED]);
  const entries = await listVault(fs, DATA_DIR, HOME);
  assert.equal(entries.length, 1, '重复刷新不应产生重复条目');
  assert.equal(entries[0]!.rel, CRED);
  assert.equal(entries[0]!.vaultPath, CRED_VAULT);
});

test('refreshVault：源缺失跳过；源删除与清单移除触发旧镜像清理', async () => {
  const fs = new MemFs(HOME);

  // 源缺失：不报错、不入库
  const r0 = await refreshVault(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.deepEqual(r0.mirrored, []);
  assert.deepEqual(r0.cleaned, []);

  // 先镜像 → 删除源 → 再刷新：清理旧镜像
  await fs.writeFile(CRED_SRC, CRED_BYTES);
  await refreshVault(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.equal(await fs.exists(CRED_VAULT), true, '镜像应先入库');
  await fs.remove(CRED_SRC); // 模拟凭据文件被删除
  const r1 = await refreshVault(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.deepEqual(r1.mirrored, [], '源不存在不再镜像');
  assert.deepEqual(r1.cleaned, [CRED], '源已删除 → 旧镜像被清理');
  assert.equal(await fs.exists(CRED_VAULT), false, 'vault 旧镜像应已删除');

  // 清单移除（rels 不再包含）：旧镜像同样被清理
  await fs.writeFile(CRED_SRC, CRED_BYTES);
  await refreshVault(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  const r2 = await refreshVault(fs, DATA_DIR, HOME, []);
  assert.deepEqual(r2.cleaned, [CRED], 'rel 不在清单 → 旧镜像被清理');
});

test('restoreVaultFiles：回填缺失目标、不覆盖已存在目标、缺失项提示重填', async () => {
  const fs = new MemFs(HOME);
  await fs.writeFile(CRED_VAULT, CRED_BYTES); // 只有 vault 有镜像

  // 目标缺失 → 回填
  const r1 = await restoreVaultFiles(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.deepEqual(r1.restored, [CRED]);
  assert.deepEqual(r1.missing, []);
  assert.deepEqual(Buffer.from(await fs.readFile(CRED_SRC)), CRED_BYTES, '目标应回填 vault 内容');

  // 目标已存在 → 不覆盖（安全）
  const newer = Buffer.from('apiKey: sk-newer-on-target\n', 'utf8');
  await fs.writeFile(CRED_SRC, newer);
  const r2 = await restoreVaultFiles(fs, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.deepEqual(r2.restored, []);
  assert.deepEqual(r2.skipped, [{ rel: CRED, reason: 'targetExists' }]);
  assert.deepEqual(Buffer.from(await fs.readFile(CRED_SRC)), newer, '已存在目标不得被覆盖');

  // vault 缺对应文件（跨机恢复/从未镜像）→ missing 提示重填
  const OTHER = 'profiles/web/secrets.yaml';
  const r3 = await restoreVaultFiles(fs, DATA_DIR, HOME, [CRED, OTHER]);
  assert.deepEqual(r3.missing, [OTHER]);
  assert.deepEqual(r3.restored, []);

  // 跨机场景：vault 为空 → 全部 missing
  const fs2 = new MemFs(HOME);
  const r4 = await restoreVaultFiles(fs2, DATA_DIR, HOME, DEFAULT_SENSITIVE_RELS);
  assert.deepEqual(r4.restored, []);
  assert.deepEqual(r4.missing, [CRED], 'vault 空 = 跨机恢复，提示重填');
});

test('listVault：按 rel 排序列出镜像内容', async () => {
  const fs = new MemFs(HOME);
  await fs.writeFile(CRED_VAULT, CRED_BYTES);
  await fs.writeFile(path.join(DATA_DIR, 'vault', 'profiles', 'web', 'secrets.yaml'), Buffer.from('token: t\n', 'utf8'));

  const entries = await listVault(fs, DATA_DIR, HOME);
  assert.deepEqual(entries.map((e) => e.rel), ['.credentials.yaml', 'profiles/web/secrets.yaml']);
  assert.ok(entries.every((e) => e.vaultPath.startsWith(vaultRootOf(DATA_DIR))), 'vaultPath 应在 vault 根下');

  // 空 vault → 空数组
  const fs2 = new MemFs(HOME);
  assert.deepEqual(await listVault(fs2, DATA_DIR, HOME), []);
});

test('非法 rel（路径穿越 / 绝对路径 / 盘符）被拒绝', async () => {
  const fs = new MemFs(HOME);
  const badRels = ['../escape.yaml', '/etc/passwd', 'C:\\evil.yaml', 'a/../../b.yaml'];
  for (const rel of badRels) {
    await assert.rejects(refreshVault(fs, DATA_DIR, HOME, [rel]), /非法敏感文件路径/, `refresh 应拒绝 ${rel}`);
    await assert.rejects(restoreVaultFiles(fs, DATA_DIR, HOME, [rel]), /非法敏感文件路径/, `restore 应拒绝 ${rel}`);
  }
});

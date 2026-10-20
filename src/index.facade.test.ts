/**
 * DshPluginsFacade / ensureActivationRow 测试（M5 补写，failing-first 目标）：
 *   - install 无 marketplace 时走官方 dsh plugin CLI 通道，且绝不抛「插件市场服务不可用」
 *   - listInstalled 委托 profile 文件实时读取（真实版本）
 *   - ensureActivationRow 幂等（重复安装不重复行；bundle 包跳过）
 *
 * 通过注入 mock runner（DshPluginsFacade 构造器第 4 参）拦截子进程，不触发真实
 * dsh/pnpm；profile 目录用真实临时目录（node:fs），node_modules 落盘 package.json
 * 驱动 hasDshBundlePatch 判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DshPatchFileFacade, DshPluginsFacade, DshSessionStoreFacade, ensureActivationRow, normalizeListedSession, resolveDshVersion, sessionPersistenceShapeOf, workspaceAttachFailureChildId, workspaceAttachWarningOf } from './index.ts';
import { zhMsg } from './core/messages.ts';
import { createLogger, type Logger } from './utils/logger.ts';
import { resolveProfileDir } from './core/plugin-cli.ts';
import { USER_PATCH_FILE } from './core/patch-layers.ts';
import type { DshPluginResult } from './core/plugin-cli.ts';
import type { PatchChange, PatchFileFacade } from './core/types.ts';

/* ------------------------------------------------ mock 基础设施 */

/**
 * 内存 patch 门面：`lines` = 用户层，`byFile` = 其它层（issue #71 起 patch 有 home / profile 两层）。
 *
 * `ensureActivationRow` 现在把激活行写进 **profile 层**（`profiles/<p>/cordis.patch.yml`），
 * 所以断言要按层看：`byFile` 里那一桶才是激活行。
 */
class MemPatchFile implements PatchFileFacade {
  lines = new Map<string, { lineId: string; raw: unknown }>();
  byFile = new Map<string, Map<string, { lineId: string; raw: unknown }>>();
  bucket(file: string): Map<string, { lineId: string; raw: unknown }> {
    if (file === USER_PATCH_FILE) return this.lines;
    let bucket = this.byFile.get(file);
    if (bucket === undefined) {
      bucket = new Map<string, { lineId: string; raw: unknown }>();
      this.byFile.set(file, bucket);
    }
    return bucket;
  }
  /** 全部层加起来的行数（旧断言「一共几行」用）。 */
  get size(): number {
    let n = this.lines.size;
    for (const bucket of this.byFile.values()) n += bucket.size;
    return n;
  }
  async readPatchLines(file: string): Promise<{ lineId: string; raw: unknown }[]> {
    if (file === USER_PATCH_FILE) return [...this.lines.values()];
    const bucket = this.byFile.get(file);
    return bucket === undefined ? [] : [...bucket.values()];
  }
  async applyPatchChanges(file: string, changes: PatchChange[]): Promise<void> {
    const bucket = this.bucket(file);
    for (const c of changes) {
      if (c.action === 'remove') bucket.delete(c.lineId);
      else bucket.set(c.lineId, { lineId: c.lineId, raw: c.raw });
    }
  }
}

interface TempProfile {
  homeDir: string;
  profileDir: string;
  cleanup: () => void;
}

function makeTempProfile(): TempProfile {
  const homeDir = mkdtempSync(join(tmpdir(), 'dsh-cm-facade-'));
  const profileDir = resolveProfileDir(homeDir, 'web');
  mkdirSync(profileDir, { recursive: true });
  return {
    homeDir,
    profileDir,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  };
}

/** 写 node_modules/<name>/package.json；bundlePatch 缺省 = 非 bundle。 */
function writeInstalledPkg(profileDir: string, name: string, version: string, bundlePatch?: string): void {
  const pkgDir = join(profileDir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  const manifest: Record<string, unknown> = { name, version };
  if (bundlePatch !== undefined) manifest['dsh'] = { bundle: { patch: bundlePatch } };
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function okResult(): DshPluginResult {
  return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
}

/* ------------------------------------------------------- 测试主体 */

test('install: 无 marketplace 时走 CLI 通道（mock runner 记录 argv），成功 → needsRestart + 非 bundle 补激活行', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0'); // 非 bundle
    const calls: { profileDir: string; profile: string; args: string[] }[] = [];
    const runner = async (p: string, profile: string, args: readonly string[]): Promise<DshPluginResult> => {
      calls.push({ profileDir: p, profile, args: [...args] });
      return okResult();
    };
    const patchFile = new MemPatchFile();
    const facade = new DshPluginsFacade(homeDir, 'web', patchFile, runner);

    const r = await facade.install('pkg-a');
    assert.equal(r.needsRestart, true);
    assert.equal(calls.length, 1, 'install 恰好一次 CLI 调用');
    assert.equal(calls[0]?.profileDir, profileDir);
    assert.equal(calls[0]?.profile, 'web');
    assert.deepEqual(calls[0]?.args, ['add', 'pkg-a'], '必须构造 dsh plugin --profile web add pkg-a 的 argv');
    // 非 bundle：成功路径幂等补激活行 —— 写进 **profile 层**（issue #71：激活行属于档案，不属于 home 层）
    assert.deepEqual(
      [...patchFile.bucket('profiles/web/cordis.patch.yml').keys()],
      ['pm-pkg-a'],
      '非 bundle 插件安装后写入 pm-<slug> 激活行',
    );
    assert.deepEqual(patchFile.bucket('profiles/web/cordis.patch.yml').get('pm-pkg-a')?.raw, { id: 'pm-pkg-a', name: 'pkg-a' });
    assert.equal(patchFile.lines.size, 0, '不得落到用户（home）层');
  } finally {
    cleanup();
  }
});

test('install: bundle 包成功 → 不补 patch 行（reconcile 维护 bundles）', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-bundle', '1.0.0', 'patch.yml'); // bundle
    const runner = async (): Promise<DshPluginResult> => okResult();
    const patchFile = new MemPatchFile();
    const facade = new DshPluginsFacade(homeDir, 'web', patchFile, runner);

    await facade.install('pkg-bundle');
    assert.equal(patchFile.size, 0, 'bundle 包不写 patch 行');
  } finally {
    cleanup();
  }
});

test('install: 非 registry spec（github:）原样安装；registry 区间按「包名@spec」安装（issue #101）', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'dsh-memory-evolve', '1.0.0');
    writeInstalledPkg(profileDir, 'dshmarket', '1.0.3');
    const calls: { args: string[] }[] = [];
    const runner = async (_p: string, _profile: string, args: readonly string[]): Promise<DshPluginResult> => {
      calls.push({ args: [...args] });
      return okResult();
    };
    const facade = new DshPluginsFacade(homeDir, 'web', new MemPatchFile(), runner);

    await facade.install('dsh-memory-evolve', 'github:csyangwen/dsh-memory-evolve');
    await facade.install('dshmarket', 'dshmarket@^1.0.3');
    await facade.install('pkg-plain');
    assert.deepEqual(calls.map((c) => c.args), [
      ['add', 'github:csyangwen/dsh-memory-evolve'],
      ['add', 'dshmarket@^1.0.3'],
      ['add', 'pkg-plain'],
    ], 'github: 来源原样安装；registry 区间带包名（裸包名会被目标机既有 spec 挡住，issue #101）；缺省仍退化为裸包名');
  } finally {
    cleanup();
  }
});

test('install: 精确版本 target 原样执行，并回读 node_modules 实际版本（issue #101 落地校验依据）', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'dsh-free-search', '0.9.3');
    const calls: { args: string[] }[] = [];
    const runner = async (_p: string, _profile: string, args: readonly string[]): Promise<DshPluginResult> => {
      calls.push({ args: [...args] });
      // 模拟 pnpm 真的按 target 装了备份记录的版本
      writeInstalledPkg(profileDir, 'dsh-free-search', '0.9.5');
      return okResult();
    };
    const facade = new DshPluginsFacade(homeDir, 'web', new MemPatchFile(), runner);

    const r = await facade.install('dsh-free-search', 'dsh-free-search@0.9.5');
    assert.deepEqual(calls[0]?.args, ['add', 'dsh-free-search@0.9.5'], '精确版本必须进 argv，不能退化成裸包名');
    assert.equal(r.needsRestart, true);
    assert.equal(r.installedVersion, '0.9.5', '回读安装后的真实版本，供 adapter 校验是否真的落地');
  } finally {
    cleanup();
  }
});

test('install: CLI 失败 → 分类后的可读错误，且绝不出现「插件市场服务不可用」', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const runner = async (): Promise<DshPluginResult> => ({
      exitCode: 1, timedOut: false, stdout: '',
      stderr: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/ghost-pkg: Not Found - 404',
    });
    const facade = new DshPluginsFacade(homeDir, 'web', new MemPatchFile(), runner);

    await assert.rejects(
      () => facade.install('pkg-a'),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /fetch-404/, '错误必须带分类 code');
        assert.doesNotMatch(msg, /插件市场服务不可用/, 'CLI 通道失败绝不能回退到 marketplace 报错');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('install: 激活行补写失败 → 明确报错（不吞），允许重试幂等补行', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const runner = async (): Promise<DshPluginResult> => okResult();
    const brokenPatch = new MemPatchFile();
    brokenPatch.applyPatchChanges = async () => {
      throw new Error('disk full');
    };
    const facade = new DshPluginsFacade(homeDir, 'web', brokenPatch, runner);

    await assert.rejects(
      () => facade.install('pkg-a'),
      /激活行写入 profile 补丁失败/,
    );
  } finally {
    cleanup();
  }
});

test('listInstalled: 委托 profile 文件实时读取，返回真实落盘版本', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        dependencies: { '@linxin666/dsh-ssh': '^0.1.0', 'pkg-a': '1.0.0', '@deepseek-ai/dsh-base': '0.1.0-rc.6' },
        dsh: { profile: { bundles: ['@linxin666/dsh-ssh'] } },
      }, null, 2) + '\n',
      'utf8',
    );
    writeInstalledPkg(profileDir, '@linxin666/dsh-ssh', '0.1.12', 'patch.yml');
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    writeInstalledPkg(profileDir, '@deepseek-ai/dsh-base', '0.1.0-rc.6');

    const facade = new DshPluginsFacade(homeDir, 'web', new MemPatchFile(), async () => okResult());
    const list = await facade.listInstalled();
    const ssh = list.find((p) => p.name === '@linxin666/dsh-ssh');
    assert.equal(ssh?.version, '0.1.12', '真实落盘版本（声明是 ^0.1.0）');
    assert.equal(ssh?.isBundle, true);
    assert.equal(list.some((p) => p.name === '@deepseek-ai/dsh-base'), false);
  } finally {
    cleanup();
  }
});

test('ensureActivationRow: 幂等——重复安装不重复行', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const patchFile = new MemPatchFile();

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    assert.equal(patchFile.size, 1, '三次调用只产生一行');
  } finally {
    cleanup();
  }
});

test('ensureActivationRow: 已有同 name 行（任意 id）→ 不重复插入', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const patchFile = new MemPatchFile();
    patchFile.lines.set('user-line', { lineId: 'user-line', raw: { id: 'user-line', name: 'pkg-a' } });

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    assert.equal(patchFile.size, 1, '按 name 去重，不新增行');
    assert.equal(patchFile.lines.has('user-line'), true);
  } finally {
    cleanup();
  }
});

test('ensureActivationRow: bundle 包跳过（reconcile 已维护 bundles）', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-bundle', '1.0.0', 'patch.yml');
    const patchFile = new MemPatchFile();

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-bundle'), 'pkg-bundle');
    assert.equal(patchFile.size, 0, 'bundle 包不写 patch 行');
  } finally {
    cleanup();
  }
});


/* ------------------------------- resolveDshVersion（桌面端 About 页版本错误） */

test('resolveDshVersion：优先 profileContext.installAnchor（真正在跑的那份 runtime）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ver-'));
  try {
    // 磁盘上的 hoisted 旧副本（真机形态：web 档案装出来的 0.1.5-rc.1）
    const hoisted = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(hoisted, { recursive: true })
    writeFileSync(join(hoisted, 'package.json'), JSON.stringify({ version: '0.1.5-rc.1' }), 'utf8')
    // 桌面端真正在跑的运行时（app.asar 内那份）
    const anchorDir = join(home, 'fake-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(anchorDir, { recursive: true })
    const anchor = join(anchorDir, 'package.json')
    writeFileSync(anchor, JSON.stringify({ version: '0.2.0-rc.2' }), 'utf8')

    assert.equal(resolveDshVersion(home, 'desktop', anchor), '0.2.0-rc.2', '必须报真正在跑的版本，而不是磁盘上过期的 hoisted 副本')
    // installAnchor 不可读 → 退到当前档案自己的依赖树
    const profileDsh = join(home, 'profiles', 'cmtest', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(profileDsh, { recursive: true })
    writeFileSync(join(profileDsh, 'package.json'), JSON.stringify({ version: '0.1.7' }), 'utf8')
    assert.equal(resolveDshVersion(home, 'cmtest', join(home, 'missing', 'package.json')), '0.1.7')
    // 都没有 → hoisted 树 → 仍可取；全不可读 → unknown
    assert.equal(resolveDshVersion(home, 'nope', null), '0.1.5-rc.1')
    assert.equal(resolveDshVersion(join(home, 'empty-home'), 'nope', null), 'unknown')
    assert.equal(resolveDshVersion(home, 'web', '   '), '0.1.5-rc.1', '空白 installAnchor 视为没有')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
});

test('ensureActivationRow: scope 包名 slug 形态正确（@scope/name → pm-scope-name）', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, '@org/pkg-a', '1.0.0');
    const patchFile = new MemPatchFile();

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', '@org', 'pkg-a'), '@org/pkg-a');
    assert.equal(patchFile.size, 1);
    assert.equal(patchFile.bucket('profiles/web/cordis.patch.yml').has('pm-org-pkg-a'), true, '去 @ 后连字符 slug');
  } finally {
    cleanup();
  }
});

/* --------------------- F-1：会话存储读侧形状兼容（sessionPersistence.list()） --------------------- */

type SessionCtx = ConstructorParameters<typeof DshSessionStoreFacade>[0]

/** 假的 Cordis ctx：只有 readService 用到的 get(name) 有意义（其余服务一律 undefined）。 */
function storeCtx(services: Record<string, unknown>): SessionCtx {
  return { get: (name: string) => services[name] ?? null } as unknown as SessionCtx
}

/** 静默 logger：F-1 的「响亮」路径会写 error 日志，测试不该刷屏（断言的是抛错/返回值）。 */
function silentLogger(): Logger {
  return createLogger({ level: 'error', sink: () => {} })
}

/**
 * 假工作区实体（模拟 DSH `WorkspaceEntity` 的**关键**语义）。
 *
 *  · `attachSession` 成功后**把子会话写进 `sessionIds`** —— DSH 的 attach 就是写成员名单，
 *    而「复核档」（要求 C）读的正是这份名单；夹具不更新就等于模拟「写调用没抛错但没落盘」。
 *  · `reject` → attach 抛错（模拟 cwd 对不上 / 目录不存在 / 域未就绪）；
 *  · `noop`   → attach 不抛错也不改名单（专门喂给「复核必须抓到假成功」那条用例）。
 */
function workspaceFixture(opts: { id?: string; path?: string; sessionIds?: readonly string[]; reject?: string; noop?: boolean } = {}): Record<string, unknown> {
  const sessionIds = [...(opts.sessionIds ?? [])]
  return {
    id: opts.id ?? 'ws-1',
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    get sessionIds(): readonly string[] { return sessionIds },
    async attachSession(id: string): Promise<void> {
      if (opts.reject !== undefined) throw new Error(opts.reject)
      if (opts.noop === true) return
      sessionIds.push(id)
    },
  }
}

/** 读假工作区的成员名单（断言用）。 */
function membersOf(record: Record<string, unknown>): readonly string[] {
  const ids = record['sessionIds']
  return Array.isArray(ids) ? ids as readonly string[] : []
}

/**
 * 模拟 DSH `realpathNormalize` 的规范化（**确定性**，不依赖真实盘符/短名/大小写）：
 * 分隔符统一 + 去掉尾分隔符 + 大小写折叠。用于注入 realpath seam 的那几条回落档用例。
 */
function canonicalPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

test('回退 fork：必须走 DSH 自己的 sessionController.fork（子会话要落盘、要有 agent），绝不直接调底层 SessionStore.fork', async () => {
  const calls: unknown[] = []
  const storeFork = () => { throw new Error('绝不该走底层 SessionStore.fork：它造的会话不落盘、没有 agent') }
  // 夹具必须 hoist：复核档（要求 C）会在 attach 之后**再读一次** list()，
  // 若每次 list() 都新建一条记录，复核永远看不到刚写进去的成员（那是夹具失真，不是代码问题）。
  const workspace = workspaceFixture({ sessionIds: ['parent-1'] })
  const facade = new DshSessionStoreFacade(storeCtx({
    // 底层 store 故意放一个「一调就炸」的 fork：真走了它，这个用例必红
    sessions: { fork: storeFork },
    sessionController: { fork: async (request: unknown) => { calls.push(request); return { sessionId: 'child-native' } } },
    workspaceRegistry: { list: () => [workspace] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  assert.deepEqual(await facade.forkSession('parent-1', 42), { childSessionId: 'child-native' })
  assert.deepEqual(calls, [{ sessionId: 'parent-1', atSeq: 42 }], 'atSeq 必须是目标回合前的 inclusive 边界，逐字透传')
})

test('回退 fork：宿主没有 sessionController 时结构化失败（**绝不**退回底层 store fork 造一个不能用、不落盘的会话）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessions: { fork: () => ({ id: 'session-1' }) },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await facade.forkSession('parent-1', 3), { error: 'session-controller-unavailable' })
})

test('回退 fork：子会话必须挂回**原会话所属工作区**（否则侧栏落到「未分组」；用户 2026-10-11 反馈）', async () => {
  const parentWorkspace = workspaceFixture({ id: 'ws-parent', sessionIds: ['parent-1'] })
  const otherWorkspace = workspaceFixture({ id: 'ws-other', sessionIds: ['someone-else'], reject: '不许挂到别人的工作区' })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-1' }) },
    workspaceRegistry: { list: () => [otherWorkspace, parentWorkspace] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  assert.deepEqual(await facade.forkSession('parent-1', 7), { childSessionId: 'child-1' })
  assert.deepEqual(membersOf(parentWorkspace), ['parent-1', 'child-1'], '成员名单必须真的写上（复核档读它）')
  assert.deepEqual(membersOf(otherWorkspace), ['someone-else'], '只挂命中 sessionIds 的那个工作区')
})

test('回退 fork：原会话自己就不在任何工作区时，按**子会话 cwd** 归到同目录工作区（用户 2026-10-12 反馈）', async () => {
  const project = workspaceFixture({ id: 'ws-a', path: 'D:/proj/a', sessionIds: ['someone-else'] })
  const otherDir = workspaceFixture({ id: 'ws-b', path: 'D:/proj/b', sessionIds: [], reject: '不同目录，attachSession 会自己拒绝' })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-cwd' }) },
    sessions: { get: (id: string) => (id === 'child-cwd' ? { header: { id, cwd: 'D:/proj/a' } } : undefined) },
    workspaceRegistry: { list: () => [otherDir, project] },
  }), 'C:/home/.dsh', zhMsg, silentLogger(), async (p) => canonicalPath(p))

  assert.deepEqual(
    await facade.forkSession('parent-nowhere', 5),
    { childSessionId: 'child-cwd' },
    'cwd 与工作区 path 指向同一目录 ⇒ 归位成功，不该再报 warning',
  )
  assert.deepEqual(membersOf(project), ['someone-else', 'child-cwd'], '只对同目录的那一条调 attachSession')
  assert.deepEqual(membersOf(otherDir), [], '不同目录的工作区一个字节都不许写')

test('回退 fork（2026-10-17 真机）：子会话还没进活会话服务 ⇒ 按**落盘 header** 的 cwd 归位（与 DSH 自己的 readSessionHeader 同源回落）', async () => {
  const project = workspaceFixture({ id: 'ws-a', path: 'D:/proj/a', sessionIds: [] })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-stored' }) },
    // 活会话服务里**没有**这个子会话（fork 刚返回、索引还没就绪）——修复前这里直接 cwd-unavailable
    sessions: { get: () => undefined },
    sessionPersistence: { list: async () => [{ header: { id: 'child-stored', cwd: 'D:/proj/a' } }] },
    workspaceRegistry: { list: () => [project] },
  }), 'C:/home/.dsh', zhMsg, silentLogger(), async (p) => canonicalPath(p))

  assert.deepEqual(
    await facade.forkSession('parent-nowhere', 5),
    { childSessionId: 'child-stored' },
    '落盘 header 读得到 cwd ⇒ 必须归位（修复前报 workspace-attach-failed:cwd-unavailable ⇒ 侧栏「未分组」）',
  )
  assert.deepEqual(membersOf(project), ['child-stored'])
})

test('回退 fork（2026-10-17 真机）：子会话 header 读不出 cwd ⇒ 用**父会话 cwd** 归位（DSH 的 fork 逐字继承父 header.cwd）', async () => {
  const project = workspaceFixture({ id: 'ws-a', path: 'D:/proj/a', sessionIds: [] })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-nocwd' }) },
    sessions: {
      get: (id: string) => {
        if (id === 'child-nocwd') return { header: { id } }
        if (id === 'parent-1') return { header: { id, cwd: 'D:/proj/a' } }
        return undefined
      },
    },
    workspaceRegistry: { list: () => [project] },
  }), 'C:/home/.dsh', zhMsg, silentLogger(), async (p) => canonicalPath(p))

  assert.deepEqual(await facade.forkSession('parent-1', 5), { childSessionId: 'child-nocwd' })
  assert.deepEqual(membersOf(project), ['child-nocwd'], '父 cwd 与工作区同目录 ⇒ 必须归位（同源事实，不是猜测）')
})

test('回退 fork：两条 cwd 来源都拿不到 ⇒ 如实失败，并把**具体理由**落一行可查的归位诊断（桌面版拿不到宿主 stdout）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dcm-attach-diag-'))
  try {
    const project = workspaceFixture({ id: 'ws-a', path: 'D:/proj/a', sessionIds: [] })
    const facade = new DshSessionStoreFacade(storeCtx({
      sessionController: { fork: async () => ({ sessionId: 'child-lost' }) },
      sessions: { get: () => undefined },
      workspaceRegistry: { list: () => [project] },
    }), home, zhMsg, silentLogger(), async (p) => canonicalPath(p))

    assert.deepEqual(await facade.forkSession('parent-nowhere', 5), {
      childSessionId: 'child-lost',
      warning: 'workspace-attach-failed:cwd-unavailable',
    })
    const log = readFileSync(join(home, 'dsh-config-manager', 'logs', 'rewind-workspace-attach.jsonl'), 'utf8')
    assert.match(log, /"childId":"child-lost"/)
    assert.match(log, /"reason":"cwd-unavailable"/)
    assert.match(log, /child\(/, 'detail 必须带子会话那一侧的读取细节，光有理由码不够排查')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

})

test('t10 ③ 档（修复前必红）：cwd 与工作区 path 仅大小写/分隔符/短名不同 —— 由 DSH 的 resolveByPath 判同一目录后仍归位', async () => {
  const project = workspaceFixture({ id: 'ws-1', path: 'D:/Progra~1/MyProj', sessionIds: ['someone-else'] })
  const resolveCalls: string[] = []
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-canon' }) },
    sessions: { get: (id: string) => (id === 'child-canon' ? { header: { id, cwd: 'd:\\PROGRA~1\\myproj' } } : undefined) },
    workspaceRegistry: {
      list: () => [project],
      // 模拟 DSH 的 realpathNormalize：大小写折叠 + 分隔符统一（真机上还会展开短名）
      resolveByPath: async (p: string) => { resolveCalls.push(p); return canonicalPath(p) === canonicalPath('D:/Progra~1/MyProj') ? project : undefined },
    },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  assert.deepEqual(await facade.forkSession('parent-nowhere', 5), { childSessionId: 'child-canon' })
  assert.deepEqual(resolveCalls, ['d:\\PROGRA~1\\myproj'], 'cwd 必须交给 DSH 的解析器判同一性（裸字符串比较在真机上必然落空）')
  assert.deepEqual(membersOf(project), ['someone-else', 'child-canon'])
})

test('t10 ③ 档回落：resolveByPath 不可用 → 双端 realpath + win32 大小写折叠仍能归位', async () => {
  const project = workspaceFixture({ id: 'ws-1', path: 'D:/Proj/A', sessionIds: [] })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-fb' }) },
    sessions: { get: (id: string) => (id === 'child-fb' ? { header: { id, cwd: 'd:\\proj\\a\\' } } : undefined) },
    workspaceRegistry: { list: () => [project] },
  }), 'C:/home/.dsh', zhMsg, silentLogger(), async (p) => canonicalPath(p))

  assert.deepEqual(await facade.forkSession('parent-nowhere', 5), { childSessionId: 'child-fb' })
  assert.deepEqual(membersOf(project), ['child-fb'])
})

test('t10 ③ 档：目录不存在 → 失败理由是 directory-missing（具体理由，不是笼统 false）', async () => {
  const ghost = workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: [] })
  const viaResolver = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-gone' }) },
    sessions: { get: (id: string) => (id === 'child-gone' ? { header: { id, cwd: 'D:/gone' } } : undefined) },
    workspaceRegistry: { list: () => [ghost], resolveByPath: async () => { throw new Error('ENOENT: no such file or directory') } },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await viaResolver.forkSession('parent-nowhere', 1), {
    childSessionId: 'child-gone',
    warning: workspaceAttachWarningOf({ ok: false, reason: 'directory-missing' }),
  })
  assert.deepEqual(membersOf(ghost), [], '判失败就一个字节都不许写')

  const viaRealpath = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-gone2' }) },
    sessions: { get: (id: string) => (id === 'child-gone2' ? { header: { id, cwd: 'D:/gone' } } : undefined) },
    workspaceRegistry: { list: () => [ghost] },
  }), 'C:/home/.dsh', zhMsg, silentLogger(), async () => { throw new Error('ENOENT') })
  assert.deepEqual(await viaRealpath.forkSession('parent-nowhere', 1), {
    childSessionId: 'child-gone2',
    warning: 'workspace-attach-failed:directory-missing',
  })
})

test('t10 ③ 档：目录存在但没有工作区认领 ⇒ no-workspace-for-cwd（具体理由）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-loose' }) },
    sessions: { get: (id: string) => (id === 'child-loose' ? { header: { id, cwd: 'D:/loose' } } : undefined) },
    workspaceRegistry: { list: () => [workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: [] })], resolveByPath: async () => undefined },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await facade.forkSession('parent-nowhere', 1), {
    childSessionId: 'child-loose',
    warning: 'workspace-attach-failed:no-workspace-for-cwd',
  })
})

test('t10 复核：attach 没抛错但 list() 里仍不含子会话 ⇒ 按失败处理并给出理由（不许报成功）', async () => {
  const halfWritten = workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: ['parent-1'], noop: true })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-half' }) },
    workspaceRegistry: { list: () => [halfWritten] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await facade.forkSession('parent-1', 3), {
    childSessionId: 'child-half',
    warning: 'workspace-attach-failed:verify-failed',
  })
  assert.deepEqual(membersOf(halfWritten), ['parent-1'], '没写进去就不许报成功')
})

test('t10 理由可区分：attachSession 缺失（形状不符）/ registry 未接线 / list 抛错 / attach 抛错 各回各的理由', async () => {
  const shapeOnly = workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: ['parent-1'] })
  delete shapeOnly['attachSession']
  const shape = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-shape' }) },
    workspaceRegistry: { list: () => [shapeOnly] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await shape.forkSession('parent-1', 1), { childSessionId: 'child-shape', warning: 'workspace-attach-failed:attach-session-missing' })

  const unregistered = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-noreg' }) },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await unregistered.forkSession('parent-1', 1), { childSessionId: 'child-noreg', warning: 'workspace-attach-failed:registry-unavailable' })

  const listThrows = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-list' }) },
    workspaceRegistry: { list: () => { throw new Error('registry not ready') } },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await listThrows.forkSession('parent-1', 1), { childSessionId: 'child-list', warning: 'workspace-attach-failed:registry-list-failed' })

  const attachThrows = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-throw' }) },
    workspaceRegistry: { list: () => [workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: ['parent-1'], reject: 'workspace write failed' })] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await attachThrows.forkSession('parent-1', 1), { childSessionId: 'child-throw', warning: 'workspace-attach-failed:attach-rejected' })
})

test('t10 要求 D：官方 fork 已归位（子会话已在成员名单里）⇒ 本兜底只复核、不重复写', async () => {
  const already = workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: ['parent-1', 'child-official'], reject: '重复写就该被发现' })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-official' }) },
    workspaceRegistry: { list: () => [already] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await facade.forkSession('parent-1', 1), { childSessionId: 'child-official' })
  assert.deepEqual(membersOf(already), ['parent-1', 'child-official'], '不重复写：attachSession 里的 reject 一次都没被触发')
})

test('回退 fork：直接命中的工作区写失败后，仍按同目录兜底归位（一次抛错不等于彻底放弃）', async () => {
  const broken = workspaceFixture({ id: 'ws-broken', path: 'D:/proj/a', sessionIds: ['parent-1'], reject: '域未就绪' })
  const sameDir = workspaceFixture({ id: 'ws-same', path: 'D:/proj/a', sessionIds: [] })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-fallback' }) },
    sessions: { get: (id: string) => (id === 'child-fallback' ? { header: { id, cwd: 'D:/proj/a' } } : undefined) },
    workspaceRegistry: { list: () => [broken, sameDir] },
  }), 'C:/home/.dsh', zhMsg, silentLogger(), async (p) => canonicalPath(p))

  assert.deepEqual(await facade.forkSession('parent-1', 9), { childSessionId: 'child-fallback' })
  assert.deepEqual(membersOf(sameDir), ['child-fallback'], '第一档抛错必须换下一档继续找，而不是直接判失败')
  assert.deepEqual(membersOf(broken), ['parent-1'], '失败的那条不得被写')
})

test('回退 fork：子代理会话沿 parentSession 上溯祖先的工作区（DSH forkWorkspace 对 subagent 同款）', async () => {
  const workspace = workspaceFixture({ id: 'ws-main', path: 'D:/proj/a', sessionIds: ['main-1'] })
  const headers: Record<string, unknown> = {
    'sub-1': { id: 'sub-1', parentSession: 'main-1' },
    'main-1': { id: 'main-1' },
    'child-lineage': { id: 'child-lineage', cwd: 'D:/nowhere' },
  }
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-lineage' }) },
    sessions: { get: (id: string) => (headers[id] === undefined ? undefined : { header: headers[id] }) },
    workspaceRegistry: { list: () => [workspace] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  assert.deepEqual(await facade.forkSession('sub-1', 4), { childSessionId: 'child-lineage' })
  assert.deepEqual(membersOf(workspace), ['main-1', 'child-lineage'], '血缘档命中（子会话 cwd 刻意对不上任何工作区，排除第三档）')
})

test('回退 fork：挂不上工作区**不影响回退本身**（结构化 warning 带具体理由，绝不抛、绝不假装已归位）', async () => {
  const noRegistry = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-2' }) },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(
    await noRegistry.forkSession('parent-1', 3),
    { childSessionId: 'child-2', warning: 'workspace-attach-failed:registry-unavailable' },
  )

  const refusing = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => ({ sessionId: 'child-3' }) },
    workspaceRegistry: { list: () => [workspaceFixture({ sessionIds: ['parent-1'], reject: 'workspace write failed' })] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(
    await refusing.forkSession('parent-1', 3),
    { childSessionId: 'child-3', warning: 'workspace-attach-failed:attach-rejected' },
    '工作区写失败只降级成 warning（回退本身已生效），但理由必须是具体的',
  )
})

/* --------------------- t16：官方 fork attach 失败时保住子会话 --------------------- */

/**
 * 假的 DSH `RemoteError('session/workspace-attach-failed', …)`。
 *
 * 形状按 DSH 源码逐字（**不猜字段名**）：
 *  · 抛出点 `dsh-api-session-controller/lib/index.js` L829-836：
 *    `new RemoteError('session/workspace-attach-failed', …, { sessionId: childId, workspaceId })`；
 *  · 错误类 `dsh-typert-protocol/lib/index.js` L11-28：`code` + `details` + `isDSHRemoteError`；
 *  · DSH 客户端同款取值 `lib/client.js` L3013-3015：`error.details.sessionId`。
 */
function remoteAttachFailure(sessionId: string, workspaceId: string): Error {
  const error = new Error('session "' + sessionId + '" was forked but could not attach to workspace "' + workspaceId + '"')
  return Object.assign(error, {
    code: 'session/workspace-attach-failed',
    details: { sessionId, workspaceId },
    isDSHRemoteError: true,
  })
}

test('t16：官方 fork 抛 session/workspace-attach-failed（细节带 childId）⇒ 子会话被保住、不报 fork-failed，并走本兜底归位', async () => {
  const workspace = workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: [] })
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => { throw remoteAttachFailure('child-kept', 'ws-1') } },
    sessions: { get: (id: string) => (id === 'child-kept' ? { header: { id, cwd: 'D:/proj/a' } } : undefined) },
    workspaceRegistry: { list: () => [workspace], resolveByPath: async () => workspace },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  assert.deepEqual(
    await facade.forkSession('parent-1', 7),
    { childSessionId: 'child-kept' },
    '子会话已创建 ⇒ 必须返回 childSessionId（旧行为会整体报 fork-failed）',
  )
  assert.deepEqual(membersOf(workspace), ['child-kept'], '并且真的走了本兜底归位')
})

test('t16：fork 抛错但**取不到 childId** ⇒ 保持现状报 fork-failed（绝不假装成功）', async () => {
  // ① code 对、但 details 里没有 sessionId（形状不符）
  const noDetails = new DshSessionStoreFacade(storeCtx({
    sessionController: {
      fork: async () => {
        const error = new Error('attach failed without details')
        throw Object.assign(error, { code: 'session/workspace-attach-failed', details: { workspaceId: 'ws-1' } })
      },
    },
    workspaceRegistry: { list: () => [] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  const noDetailsOutcome = await noDetails.forkSession('parent-1', 1)
  assert.deepEqual(noDetailsOutcome, { error: 'attach failed without details' })
  assert.equal('childSessionId' in noDetailsOutcome, false, '取不到 childId 时不许返回子会话（那就是假装成功）')

  // ② 完全不是这个错误码（例如域未就绪）
  const other = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => { throw new Error('gateway/internal: composeAgent failed') } },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(await other.forkSession('parent-1', 1), { error: 'gateway/internal: composeAgent failed' })
})

test('t16：兜底归位失败 ⇒ 结果仍含 childSessionId + warning（workspace-attach-failed:<reason>）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionController: { fork: async () => { throw remoteAttachFailure('child-lost', 'ws-1') } },
    sessions: { get: (id: string) => (id === 'child-lost' ? { header: { id, cwd: 'D:/loose' } } : undefined) },
    workspaceRegistry: { list: () => [workspaceFixture({ id: 'ws-1', path: 'D:/proj/a', sessionIds: [] })], resolveByPath: async () => undefined },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  assert.deepEqual(await facade.forkSession('parent-1', 1), {
    childSessionId: 'child-lost',
    warning: 'workspace-attach-failed:no-workspace-for-cwd',
  })
})

test('t16：workspaceAttachFailureChildId —— 只认 DSH 的 code + details.sessionId（不猜字段名）', () => {
  assert.equal(workspaceAttachFailureChildId(remoteAttachFailure('child-9', 'ws-9')), 'child-9')
  // 同 code 但字段名不对（details.childId）⇒ 不认（DSH 用的是 details.sessionId）
  const wrongField = Object.assign(new Error('x'), { code: 'session/workspace-attach-failed', details: { childId: 'child-9' } })
  assert.equal(workspaceAttachFailureChildId(wrongField), undefined)
  assert.equal(workspaceAttachFailureChildId(Object.assign(new Error('x'), { code: 'session/workspace-attach-failed' })), undefined)
  assert.equal(workspaceAttachFailureChildId(Object.assign(new Error('x'), { code: 'session/workspace-attach-failed', details: { sessionId: '' } })), undefined)
  assert.equal(workspaceAttachFailureChildId(new Error('plain')), undefined)
  assert.equal(workspaceAttachFailureChildId(null), undefined)
})
test('F-1 sessionPersistenceShapeOf：按 API 形状探测（open=handle / readFrom|append=legacy）', () => {
  assert.equal(sessionPersistenceShapeOf({ open: () => {}, list: async () => [] }), 'handle')
  assert.equal(sessionPersistenceShapeOf({ readFrom: () => {}, list: async () => [] }), 'legacy')
  assert.equal(sessionPersistenceShapeOf({ append: () => {}, list: async () => [] }), 'legacy')
  assert.equal(sessionPersistenceShapeOf({ list: async () => [] }), 'unknown', '两个基线特征都没有 → 不猜')
  assert.equal(sessionPersistenceShapeOf(null), 'unknown')
  assert.equal(sessionPersistenceShapeOf([]), 'unknown', '数组不是服务对象')
});

test('F-1 normalizeListedSession：handle 与 legacy 两种元素形状归一到同一视图', () => {
  const nested = { id: 's1', parentSession: 'p1', origin: 'subagent' }
  assert.deepEqual(
    normalizeListedSession({ header: nested }),
    { id: 's1', parent: 'p1', origin: 'subagent', raw: nested },
    'handle 形态：header 在 element.header，raw 必须是那个 header 对象本身',
  )
  const flat = { id: 's2', parentSessionId: 'p2', origin: 'subagent' }
  assert.deepEqual(
    normalizeListedSession(flat),
    { id: 's2', parent: 'p2', origin: 'subagent', raw: flat },
    'legacy 形态：header 字段平铺；父 id 连 DSH 的 RPC 投影名 parentSessionId 也认',
  )
  assert.equal(normalizeListedSession({ id: 's3' })?.parent, undefined, '没有父 id 时不给 parent（不猜）')
  assert.equal(normalizeListedSession({ foo: 1 }), undefined, '认不出 id → undefined（调用方必须响亮处理）')
  assert.equal(normalizeListedSession(null), undefined)
  assert.equal(normalizeListedSession({ header: { origin: 'subagent' } }), undefined, 'header 是对象但取不出 id → 不认')
});

test('F-1 parentRelations：旧（legacy）形状 list() 元素仍能解析出父子关系（绝不退化成空 Map）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionPersistence: {
      readFrom: () => {},   // 旧基线特征：没有 open()
      list: async () => [
        { id: 'child-1', parentSession: 'parent-1', origin: 'subagent' },
        { id: 'parent-1', origin: 'user' },
        { id: 'child-2', parentSessionId: 'parent-1', origin: 'subagent' },
      ],
    },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  const relations = await facade.parentRelations()
  assert.deepEqual(
    [...relations.keys()].sort(), ['child-1', 'child-2'],
    '旧形状必须解析出两条子会话 —— 空 Map 就是 F-1 的真机事故（父链连带静默失效）',
  )
  assert.deepEqual(relations.get('child-1'), { parent: 'parent-1', subagent: true })
  assert.deepEqual(relations.get('child-2'), { parent: 'parent-1', subagent: true }, 'parentSessionId 投影名也认')
  assert.equal(relations.has('parent-1'), false, '没有父 id 的顶层会话不进 Map')
});

test('F-1 parentRelations：新（handle）形状元素解析结果与 legacy 一致', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionPersistence: {
      open: () => {},
      list: async () => [
        { header: { id: 'child-1', parentSession: 'parent-1', origin: 'subagent' } },
        { header: { id: 'parent-1', origin: 'user' } },
      ],
    },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.deepEqual(
    [...(await facade.parentRelations())],
    [['child-1', { parent: 'parent-1', subagent: true }]],
  )
});

test('F-1 parentRelations：元素形状一个都认不出 → 抛错（绝不返回空 Map 冒充「没有父子关系」）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionPersistence: { list: async () => [{ totallyDifferent: 1 }, { shape: 'v9' }] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  await assert.rejects(() => facade.parentRelations(), /sessionPersistence/)
});

test('F-1 parentRelations：列举抛错 → 抛错（不吞成空 Map，避免被 5 s TTL 缓存放大）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionPersistence: { list: async () => { throw new Error('corrupt session log') } },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  await assert.rejects(() => facade.parentRelations(), /corrupt session log/)
});

test('F-1 parentRelations：空列举 = 确实没有会话 → 空 Map（不抛错）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionPersistence: { list: async () => [] },
  }), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.equal((await facade.parentRelations()).size, 0)
});

test('F-1 parentRelations：宿主未接线 sessionPersistence → 空 Map（确定性事实，不抛错）', async () => {
  const facade = new DshSessionStoreFacade(storeCtx({}), 'C:/home/.dsh', zhMsg, silentLogger())
  assert.equal((await facade.parentRelations()).size, 0)
});

test('F-1 reindexSessionHeader：legacy 形状下仍能命中，并把**原样 header** 交给注册表', async () => {
  const indexed: unknown[] = []
  const rawHeader = { id: 's-1', parentSession: 'p-1', origin: 'subagent' }
  const facade = new DshSessionStoreFacade(storeCtx({
    sessionPersistence: { append: () => {}, list: async () => [{ id: 'other' }, rawHeader] },
    workspaceRegistry: { indexHeader: (header: unknown) => { indexed.push(header) } },
  }), 'C:/home/.dsh', zhMsg, silentLogger())

  assert.equal(await facade.reindexSessionHeader('s-1'), true, '旧形状必须命中（恒 false 就是 F-1 事故）')
  assert.equal(indexed.length, 1)
  assert.equal(indexed[0], rawHeader, '必须回传原样 header 对象，不得自造（注册表要拿它校验 cwd）')
  assert.equal(await facade.reindexSessionHeader('missing'), false, '确实没有该会话 → false')
});

/* --------------------- issue #75：cordis.patch.yml 方言（!!js）读写与覆盖护栏 --------------------- */

/**
 * 真实 patch 门面（不是 MemPatchFile）：issue #75 的 bug 就在这一层 —— 默认 schema 的
 * yaml.load 遇到 DSH 的 !!js 表达式会抛错，旧实现 catch 成空数组，于是「整层 patch 行消失」；
 * 写回路径更会把读不出来的原文件整体重写（只剩本次导入的行）。
 */
function patchHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cm-patch-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** 真机形态：顶层行 + 行内 JS 表达式（`!!js (function(){…})()`）+ 普通行。 */
const JS_ROW_YAML = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  disabled: !!js (function(){ return true })()',
  '- id: plain-plugin',
  '  disabled: true',
  '',
].join('\n')

test('#75 readPatchLines：带 !!js 的层必须读出全部行（不得整层丢失）', async () => {
  const { home, cleanup } = patchHome()
  try {
    writeFileSync(join(home, USER_PATCH_FILE), JS_ROW_YAML, 'utf8')
    const facade = new DshPatchFileFacade(home, 'web', zhMsg)
    const lines = await facade.readPatchLines(USER_PATCH_FILE)
    assert.deepEqual(lines.map((l) => l.lineId), ['llm-pi-ai', 'plain-plugin'])
    assert.deepEqual((lines[0]?.raw as Record<string, unknown>)['disabled'], { __jsExpr: '(function(){ return true })()' })
  } finally {
    cleanup()
  }
})

test('#75 applyPatchChanges：!!js 与其它行都保真写回（再次读出来等价）', async () => {
  const { home, cleanup } = patchHome()
  try {
    writeFileSync(join(home, USER_PATCH_FILE), JS_ROW_YAML, 'utf8')
    const facade = new DshPatchFileFacade(home, 'web', zhMsg)
    await facade.applyPatchChanges(USER_PATCH_FILE, [
      { lineId: 'added', raw: { id: 'added', disabled: false }, action: 'insert' },
    ])
    const text = readFileSync(join(home, USER_PATCH_FILE), 'utf8')
    assert.ok(text.includes('!!js (function(){ return true })()'), '!!js 必须原样写回: ' + text)
    const lines = await facade.readPatchLines(USER_PATCH_FILE)
    assert.deepEqual(lines.map((l) => l.lineId), ['llm-pi-ai', 'plain-plugin', 'added'])
    assert.deepEqual((lines[0]?.raw as Record<string, unknown>)['disabled'], { __jsExpr: '(function(){ return true })()' })
  } finally {
    cleanup()
  }
})

test('#75 覆盖护栏：原文件解析不了时拒绝改写（不得把读不出来的行删掉）', async () => {
  const { home, cleanup } = patchHome()
  try {
    const broken = '- id: a\n  x: [1,\n'
    writeFileSync(join(home, USER_PATCH_FILE), broken, 'utf8')
    const facade = new DshPatchFileFacade(home, 'web', zhMsg)

    const readErr = await facade.readPatchLines(USER_PATCH_FILE).then(() => null, (err: unknown) => err as Error)
    assert.ok(readErr !== null, '解析失败必须抛错（旧实现返回 [] → 整层从导出/同步里消失）')
    assert.match(String(readErr.message), /读不出来/)
    assert.equal(String(readErr.message).includes('[1,'), false, '不得回传源码片段（可能内联密钥）')

    await assert.rejects(
      () => facade.applyPatchChanges(USER_PATCH_FILE, [{ lineId: 'x', raw: { id: 'x' }, action: 'insert' }]),
      /已拒绝覆盖写入/,
    )
    assert.equal(readFileSync(join(home, USER_PATCH_FILE), 'utf8'), broken, '文件必须逐字节保持原样')
  } finally {
    cleanup()
  }
})

test('#75 不存在的层仍按「本来就没有」处理（ENOENT 不是错误）', async () => {
  const { home, cleanup } = patchHome()
  try {
    const facade = new DshPatchFileFacade(home, 'web', zhMsg)
    assert.deepEqual(await facade.readPatchLines(USER_PATCH_FILE), [], '文件不存在 → 空层')
    await facade.applyPatchChanges(USER_PATCH_FILE, [
      { lineId: 'first', raw: { id: 'first', disabled: true }, action: 'insert' },
    ])
    assert.deepEqual((await facade.readPatchLines(USER_PATCH_FILE)).map((l) => l.lineId), ['first'])
  } finally {
    cleanup()
  }
})

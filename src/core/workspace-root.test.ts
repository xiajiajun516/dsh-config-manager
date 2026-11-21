import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWorkspaceMappings,
  deriveWorkspaceTargets,
  sanitizeWorkspaceName,
} from './workspace-root.ts';
import { workspaceRootMappings } from './import-planning.ts';

test('P4-1 根目录为空或相对时不做任何推导（缺省行为不变）', () => {
  const inputs = [{ path: '/home/old/proj', title: 'proj' }];
  assert.deepEqual(deriveWorkspaceTargets(inputs, ''), []);
  assert.deepEqual(deriveWorkspaceTargets(inputs, '   '), []);
  assert.deepEqual(deriveWorkspaceTargets(inputs, 'work'), []);
  assert.deepEqual(deriveWorkspaceMappings(inputs, './relative'), []);
});

test('P4-2 标题优先、拼在根目录下（POSIX 与 Windows 分隔符跟随根目录）', () => {
  const posix = deriveWorkspaceTargets([{ path: '/home/old/proj', title: 'proj' }], '/home/new/', { platform: 'linux' });
  assert.deepEqual(posix, [{ sourcePath: '/home/old/proj', targetPath: '/home/new/proj', name: 'proj' }]);

  const win = deriveWorkspaceTargets([{ path: 'C:\\old\\proj', title: 'proj' }], 'D:\\work', { platform: 'win32' });
  assert.deepEqual(win, [{ sourcePath: 'C:\\old\\proj', targetPath: 'D:\\work\\proj', name: 'proj' }]);

  // 根目录写成 D:/work（正斜杠）就沿用正斜杠，不混拼
  const mixed = deriveWorkspaceTargets([{ path: 'C:\\old\\proj', title: 'proj' }], 'D:/work', { platform: 'win32' });
  assert.equal(mixed[0]?.targetPath, 'D:/work/proj');
});

test('P4-3 无标题时用源路径末段；源路径重复只出一条', () => {
  const targets = deriveWorkspaceTargets(
    [
      { path: '/home/old/api' },
      { path: '/home/old/api/' },
      { path: '/home/old/web' },
    ],
    '/target',
    { platform: 'linux' },
  );
  assert.deepEqual(targets.map((t) => t.name), ['api', 'web']);
});

test('P4-4 同名工作区顺延 -2 / -3（Windows 折叠大小写）', () => {
  const inputs = [
    { path: '/old/a/proj', title: 'proj' },
    { path: '/old/b/proj', title: 'proj' },
    { path: '/old/c/proj', title: 'proj' },
  ];
  assert.deepEqual(
    deriveWorkspaceTargets(inputs, '/new', { platform: 'linux' }).map((t) => t.targetPath),
    ['/new/proj', '/new/proj-2', '/new/proj-3'],
  );
  const folded = deriveWorkspaceTargets(
    [
      { path: 'C:\\a\\Proj', title: 'Proj' },
      { path: 'C:\\b\\proj', title: 'proj' },
    ],
    'D:\\new',
    { platform: 'win32' },
  );
  assert.deepEqual(folded.map((t) => t.name), ['Proj', 'proj-2']);
});

test('P4-5 Windows 目标侧清洗：非法字符、尾部点、保留名、空名', () => {
  assert.equal(sanitizeWorkspaceName('a<b>c:d"e|f?g*h', 'win32'), 'a_b_c_d_e_f_g_h');
  assert.equal(sanitizeWorkspaceName('trailing. ', 'win32'), 'trailing');
  assert.equal(sanitizeWorkspaceName('CON', 'win32'), '_CON');
  assert.equal(sanitizeWorkspaceName('lpt9.bak', 'win32'), '_lpt9.bak');
  assert.equal(sanitizeWorkspaceName('   ', 'win32'), '_');
  // 非 Windows 侧只去路径分隔符与控制字符，保留点号
  assert.equal(sanitizeWorkspaceName('v1.2 final', 'linux'), 'v1.2 final');
  assert.equal(sanitizeWorkspaceName('a/b', 'linux'), 'a_b');
});

test('P4-6 名字过长时截断且不留尾部点', () => {
  const long = 'x'.repeat(100) + '...';
  const name = sanitizeWorkspaceName(long, 'win32');
  assert.equal(name.length, 80);
  assert.equal(/[. ]$/.test(name), false);
});

test('P4-7 isClaimed 命中即跳过（显式映射优先，不重复产出规则）', () => {
  const inputs = [
    { path: '/old/proj', title: 'proj' },
    { path: '/old/other', title: 'other' },
  ];
  const targets = deriveWorkspaceTargets(inputs, '/new', {
    platform: 'linux',
    isClaimed: (source) => source === '/old/proj',
  });
  assert.deepEqual(targets.map((t) => t.sourcePath), ['/old/other']);
});

test('P4-8 相对/空源路径不参与推导（不猜落点）', () => {
  const targets = deriveWorkspaceTargets(
    [{ path: 'relative/proj' }, { path: '  ' }, { path: '/abs/proj' }],
    '/new',
    { platform: 'linux' },
  );
  assert.deepEqual(targets.map((t) => t.sourcePath), ['/abs/proj']);
});

const workspacesSection = (records: { path: string; title?: string }[]) =>
  new Map([['workspaces' as const, { version: 1, workspaces: records.map((r, i) => ({ id: `ws-${i}`, sessionIds: [], ...r })) }]]);

test('P4-10 计划期推导：读 workspaces 载荷，产出 appliesTo=[workspaces] 的规则', () => {
  const mappings = workspaceRootMappings(
    workspacesSection([{ path: 'C:\\old\\api', title: 'api' }, { path: 'C:\\old\\web', title: 'web' }]),
    'D:\\work',
    'win32',
    [],
  );
  assert.deepEqual(mappings, [
    { oldPrefix: 'C:\\old\\api', newPrefix: 'D:\\work\\api', appliesTo: ['workspaces'] },
    { oldPrefix: 'C:\\old\\web', newPrefix: 'D:\\work\\web', appliesTo: ['workspaces'] },
  ]);
});

test('P4-11 用户手填的 workspaces 映射优先：命中的源路径不推导', () => {
  const mappings = workspaceRootMappings(
    workspacesSection([{ path: '/old/api', title: 'api' }, { path: '/old/web', title: 'web' }]),
    '/work',
    'linux',
    [{ oldPrefix: '/old/api', newPrefix: '/custom/api', appliesTo: ['workspaces'] }],
  );
  assert.deepEqual(mappings.map((m) => m.oldPrefix), ['/old/web']);
});

test('P4-12 无根目录 / 无 workspaces 载荷 / 载荷形状不对 → 一律不推导', () => {
  assert.deepEqual(workspaceRootMappings(workspacesSection([{ path: '/old/api' }]), undefined, 'linux', []), []);
  assert.deepEqual(workspaceRootMappings(workspacesSection([{ path: '/old/api' }]), '  ', 'linux', []), []);
  assert.deepEqual(workspaceRootMappings(new Map(), '/work', 'linux', []), []);
  assert.deepEqual(workspaceRootMappings(new Map([['workspaces', { version: 1 } as unknown]]), '/work', 'linux', []), []);
});

test('P4-9 映射形态：只作用于 workspaces，from/to 与目标路径一致', () => {
  const mappings = deriveWorkspaceMappings([{ path: '/old/proj', title: 'proj' }], '/new', { platform: 'linux' });
  assert.deepEqual(mappings, [{ oldPrefix: '/old/proj', newPrefix: '/new/proj', appliesTo: ['workspaces'] }]);
});

test('P4-13 重名后缀不得把名字顶过 80 字符上限', () => {
  const long = 'x'.repeat(120);
  const targets = deriveWorkspaceTargets(
    [{ path: '/old/a', title: long }, { path: '/old/b', title: long }],
    '/new',
    { platform: 'linux' },
  );
  assert.equal(targets.length, 2);
  assert.equal(targets[0]?.name, 'x'.repeat(80), '未被占用时截到上限');
  assert.equal(targets[1]?.name, 'x'.repeat(78) + '-2');
  assert.ok((targets[1]?.name.length ?? 0) <= 80, '加后缀后仍不得超上限');
});

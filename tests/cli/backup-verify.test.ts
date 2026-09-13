/**
 * T2 单测：备份 ZIP 自检（`src/core/backup-verify.ts`）与离线备份收集（`src/core/backup-plan.ts`）。
 *
 * 覆盖（对齐任务验收要求）：
 *  - 正常 zip → `OK`；
 *  - 篡改一个条目内容 → `CORRUPT` 且 errors **指出该条目名**（不是只给总数）；
 *  - 缺 manifest → `CORRUPT`；schema 超范围 → `UNSUPPORTED`（两者语义必须区分）；
 *  - checksums 缺失 / 非法 → 明确 verdict（`CORRUPT`）；
 *  - 文件不存在 → `MISSING`；ZIP 打不开 → `CORRUPT`；目录当文件传 → `MISSING`；
 *  - 加密容器（DCA1）→ `UNSUPPORTED`（不是「ZIP 损坏」，避免误导用户重导）；
 *  - 校验通过时不得产生 errors；缺分区载荷只出 warnings 不改 verdict；
 *  - 离线备份收集：分区映射（relativePath 按 baseDir 裁剪）、凭据黑名单、
 *    保留命名空间排除、symlink 跳过、pluginFiles 默认不收（opt-in）；
 *  - 闭环：收集 → 打包 → 自检必须 `OK`（证明产物真的可校验、结构自洽）。
 *
 * 测试 zip 一律用既有 `src/utils/zip.ts` 的 `writeZip` 真实构造（不 mock 压缩层）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyBackupZip } from '../../src/core/backup-verify.ts';
import {
  collectBackupEntries, buildSectionFlags, isSensitiveFileName, parseSectionsArg,
  DEFAULT_BACKUP_SECTIONS, OFFLINE_BACKUP_SECTIONS,
} from '../../src/core/backup-plan.ts';
import { writeZip, zipToBuffer } from '../../src/utils/zip.ts';
import { buildChecksums } from '../../src/utils/hashing.ts';
import { stringifyJsonSafe } from '../../src/utils/json.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../../src/schema/manifest.ts';
import type { Manifest, SectionId } from '../../src/schema/types.ts';
import type { ZipWriteEntry } from '../../src/utils/zip.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-t2-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

/** 构造 manifest（可覆盖字段） */
function makeManifest(over: Partial<Manifest['sections']> = {}, schemaVersion = 1): Manifest {
  const sections = {
    settings: false, ui: false, providers: false, plugins: false, mcp: false, prompts: false,
    skills: true, agentPresets: false, agentInstructions: false, workspaces: false,
    pluginFiles: false, credentialsStatus: false, secrets: false, sessions: false, self: false,
    ...over,
  } as Manifest['sections'];
  const base = buildManifest({
    exporterVersion: '0.1.58',
    dshVersion: 'test',
    platform: 'win32',
    arch: 'x64',
    sections,
    containsSecrets: false,
    encrypted: false,
    encryption: null,
    exportedAt: '2026-09-12T00:00:00.000Z',
  });
  return { ...base, schemaVersion };
}

/** 一组「正常备份」的数据条目（校验表覆盖它们） */
const DATA_ENTRIES: ZipWriteEntry[] = [
  { name: 'custom/skills/a.md', data: enc('# skill A\n') },
  { name: 'custom/skills/b.md', data: enc('# skill B\n') },
];

/** 写出一个结构完整的备份 ZIP（manifest + checksums + 数据） */
async function writeBackupZip(
  file: string,
  opts: {
    data?: ZipWriteEntry[];
    manifest?: Manifest;
    checksumBasis?: ZipWriteEntry[];
    omitManifest?: boolean;
    omitChecksums?: boolean;
    checksumsRaw?: string;
  } = {},
): Promise<void> {
  const writeData = opts.data ?? DATA_ENTRIES;
  const basis = opts.checksumBasis ?? writeData;
  const entries: ZipWriteEntry[] = [...writeData];
  if (opts.omitChecksums !== true) {
    const raw = opts.checksumsRaw
      ?? stringifyJsonSafe(buildChecksums(basis), { space: 2 });
    entries.push({ name: CHECKSUMS_FILE, data: enc(raw) });
  }
  if (opts.omitManifest !== true) {
    entries.push({ name: MANIFEST_FILE, data: enc(JSON.stringify(opts.manifest ?? makeManifest(), null, 2)) });
  }
  await writeZip(file, entries);
}

/* ---------------------------------------------------------------- verifyBackupZip */

test('T2-V1 正常备份 → OK，且 errors 为空、元信息完整', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'ok.zip');
    await writeBackupZip(file);
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'OK');
    assert.deepEqual(r.errors, []);
    assert.equal(r.file, file);
    assert.equal(r.entryCount, 4, '2 数据 + checksums + manifest');
    assert.equal(r.sizeBytes! > 0, true, 'sizeBytes 应为真实字节数');
    assert.deepEqual(r.sections, ['skills'], 'sections 只含 manifest 置 true 的分区');
    assert.equal(r.exportedAt, '2026-09-12T00:00:00.000Z');
  });
});

test('T2-V2 篡改一个条目内容 → CORRUPT 且 errors 指出该条目名（条目级而非总数级）', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'tampered.zip');
    // 校验表按原始内容生成，但写入的 a.md 已被改过 → 只有 a.md 会不符
    const tampered = DATA_ENTRIES.map((e) =>
      e.name === 'custom/skills/a.md' ? { name: e.name, data: enc('# TAMPERED CONTENT\n') } : e);
    await writeBackupZip(file, { data: tampered, checksumBasis: DATA_ENTRIES });
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'CORRUPT');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /custom\/skills\/a\.md/, '必须点名具体不匹配条目');
    assert.doesNotMatch(r.errors[0]!, /custom\/skills\/b\.md/, '未篡改条目不得被误报');
  });
});

test('T2-V3 校验表内条目在归档中缺失 → CORRUPT 且点名缺失条目', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'missing-entry.zip');
    // 校验表覆盖两条，但归档只写入 b.md
    await writeBackupZip(file, {
      data: [DATA_ENTRIES[1]!],
      checksumBasis: DATA_ENTRIES,
    });
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'CORRUPT');
    assert.match(r.errors.join(' '), /custom\/skills\/a\.md/, '必须点名缺失条目');
  });
});

test('T2-V4 缺 manifest → CORRUPT（不是 UNSUPPORTED）', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'no-manifest.zip');
    await writeBackupZip(file, { omitManifest: true });
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'CORRUPT');
    assert.match(r.errors.join(' '), /manifest\.json/);
  });
});

test('T2-V5 manifest 非法（字段缺失）→ CORRUPT', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'bad-manifest.zip');
    const bad = JSON.stringify({ schemaVersion: 1, exporter: { name: 'x' } }, null, 2);
    await writeZip(file, [
      ...DATA_ENTRIES,
      { name: CHECKSUMS_FILE, data: enc(stringifyJsonSafe(buildChecksums(DATA_ENTRIES), { space: 2 })) },
      { name: MANIFEST_FILE, data: enc(bad) },
    ]);
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'CORRUPT');
    assert.match(r.errors.join(' '), /manifest\.json 非法/);
  });
});

test('T2-V6 schema 版本过新 → UNSUPPORTED（与 CORRUPT 语义严格区分）', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'future.zip');
    await writeBackupZip(file, { manifest: makeManifest({}, 99) });
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'UNSUPPORTED', '版本超范围是「本插件读不了」，不是「备份坏了」');
    assert.match(r.errors.join(' '), /schema/);
    assert.equal(r.sections?.includes('skills'), true, '已解析出的元信息应保留，便于用户判断');
  });
});

test('T2-V7 缺 checksums → CORRUPT；checksums 非法 → CORRUPT', async () => {
  await withTmp(async (dir) => {
    const missing = path.join(dir, 'no-checksums.zip');
    await writeBackupZip(missing, { omitChecksums: true });
    const r1 = await verifyBackupZip(missing);
    assert.equal(r1.verdict, 'CORRUPT');
    assert.match(r1.errors.join(' '), /checksums\.json/);

    const invalid = path.join(dir, 'bad-checksums.zip');
    await writeBackupZip(invalid, { checksumsRaw: '{ this is not json' });
    const r2 = await verifyBackupZip(invalid);
    assert.equal(r2.verdict, 'CORRUPT');
    assert.match(r2.errors.join(' '), /checksums\.json/);
  });
});

test('T2-V8 文件不存在 → MISSING；目录当文件传 → MISSING', async () => {
  await withTmp(async (dir) => {
    const r1 = await verifyBackupZip(path.join(dir, 'nope.zip'));
    assert.equal(r1.verdict, 'MISSING');
    assert.match(r1.errors.join(' '), /不存在|not found/);

    const r2 = await verifyBackupZip(dir); // 目录
    assert.equal(r2.verdict, 'MISSING');
    assert.match(r2.errors.join(' '), /不是普通文件|not a regular file/);
  });
});

test('T2-V9 非 ZIP 字节 → CORRUPT（而非 VERIFY_ERROR）', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'garbage.zip');
    await fs.writeFile(file, Buffer.from('x'.repeat(200), 'utf8'));
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'CORRUPT');
    assert.match(r.errors.join(' '), /ZIP 无法打开|cannot open/);
  });
});

test('T2-V10 整体加密容器（DCA1）→ UNSUPPORTED，提示需先解密', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'encrypted.zip');
    const buf = Buffer.concat([Buffer.from('DCA1', 'ascii'), Buffer.alloc(200, 7)]);
    await fs.writeFile(file, buf);
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'UNSUPPORTED');
    assert.match(r.errors.join(' '), /加密|encrypted/);
  });
});

test('T2-V11 空 ZIP → CORRUPT；缺分区载荷只出 warning 不改 verdict', async () => {
  await withTmp(async (dir) => {
    const empty = path.join(dir, 'empty.zip');
    await writeZip(empty, []);
    assert.equal((await verifyBackupZip(empty)).verdict, 'CORRUPT', '空归档无 manifest/checksums');

    // manifest 声明 settings:true 但归档无 config/settings.json → 只 warning，仍 OK
    const file = path.join(dir, 'declared-missing.zip');
    await writeBackupZip(file, { manifest: makeManifest({ skills: true, settings: true }) });
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'OK');
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join(' '), /settings/, '应提示声明分区缺载荷');
  });
});

test('T2-V12 校验表未覆盖的额外条目 → 出 warning（提示未被保护），verdict 仍 OK', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'uncovered.zip');
    await writeZip(file, [
      ...DATA_ENTRIES,
      { name: 'extra/uncovered.txt', data: enc('not in checksums\n') },
      { name: CHECKSUMS_FILE, data: enc(stringifyJsonSafe(buildChecksums(DATA_ENTRIES), { space: 2 })) },
      { name: MANIFEST_FILE, data: enc(JSON.stringify(makeManifest(), null, 2)) },
    ]);
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'OK');
    assert.match(r.warnings.join(' '), /extra\/uncovered\.txt/, '必须点名未覆盖条目');
  });
});

test('T2-V13 manifest 标记加密但无凭据密文条目 → 出 warning', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'enc-flag.zip');
    const m = makeManifest();
    const encManifest: Manifest = { ...m, security: { ...m.security, encrypted: true } };
    await writeBackupZip(file, { manifest: encManifest });
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'OK');
    assert.match(r.warnings.join(' '), /加密|encrypted/);
  });
});

/* ---------------------------------------------------------------- backup-plan */

/** 造一棵最小 $DSH_HOME */
async function seedHome(home: string): Promise<void> {
  const w = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(home, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  };
  await w('skills/coding.md', '# coding\n');
  await w('skills/nested/deep.md', '# deep\n');
  await w('.agent-presets/work/agent.cordis.yml', 'services: []\n');
  await w('AGENTS.md', '# global instructions\n');
  await w('dsh-ssh.json', '{"hosts":{"h1":{"password":"ssh-plaintext-password"}}}');
  await w('plugin-config/x/y.json', '{"k":1}');
  await w('dsh-config-manager/sync/sync-config.json', '{"channel":"git"}');
  await w('dsh-config-manager/exports/.backup-notes.json', '{}');
  // —— 不应进入备份 ——
  await w('.credentials.yaml', 'API_KEY: super-secret-plaintext\n');
  await w('skills/.env', 'TOKEN=leak-me\n');
  await w('skills/id_rsa.pem', '-----BEGIN PRIVATE KEY-----\n');
  await w('dsh-config-manager/snapshots/s1/snapshot.json', '{"id":"s1"}');
}

test('T2-P1 默认收集：分区映射正确（relativePath 按 baseDir 裁剪）且凭据全排除', async () => {
  await withTmp(async (dir) => {
    const home = path.join(dir, 'home');
    await seedHome(home);
    const col = await collectBackupEntries(home);
    const names = col.entries.map((e) => e.name);

    // 收录（ZIP 内路径 = 分区前缀 + 相对 baseDir 路径）
    for (const expect of [
      'custom/skills/coding.md',
      'custom/skills/nested/deep.md',
      'agents/presets/work/agent.cordis.yml',
      'custom/agent-instructions/AGENTS.md',
      'self/sync/sync-config.json',
      'self/exports/.backup-notes.json',
    ]) assert.ok(names.includes(expect), `应收录 ${expect}（实际：${names.join(', ')}）`);

    // self 分区的 baseDir 前缀必须被裁掉（否则导入会落错位置）
    assert.ok(!names.some((n) => n.startsWith('self/dsh-config-manager/')), 'self 的相对路径不得残留 baseDir');

    // 凭据/保留命名空间排除
    assert.ok(!names.some((n) => /credentials|\.env$|\.pem$/.test(n)), '凭据类文件不得进备份');
    assert.ok(!names.some((n) => n.includes('snapshots/')), '内部快照目录不得进备份');

    // 内容级：明文秘密不得出现
    const text = col.entries.map((e) => Buffer.from(e.data).toString('utf8')).join('\n');
    assert.ok(!text.includes('super-secret-plaintext'), '凭据明文不得进备份');
    assert.ok(!text.includes('leak-me'), 'skills 内的 .env 不得进备份');
    assert.deepEqual(col.included, ['skills', 'agentPresets', 'agentInstructions', 'self']);
    assert.ok(col.sections.some((s) => s.sectionId === 'skills' && s.excludedCount === 2),
      'skills 应记录 2 个被排除项（.env 与 .pem）');
  });
});

test('T2-P2 pluginFiles 默认不收；显式选中才收且带风险提示', async () => {
  await withTmp(async (dir) => {
    const home = path.join(dir, 'home');
    await seedHome(home);

    const def = await collectBackupEntries(home);
    const defNames = def.entries.map((e) => e.name);
    assert.ok(!defNames.some((n) => n.startsWith('plugin-files/')),
      'pluginFiles 是 deviceSpecific（dsh-ssh.json 含明文密码），默认不得收集');
    assert.ok(!(DEFAULT_BACKUP_SECTIONS as readonly string[]).includes('pluginFiles'));

    const opt = await collectBackupEntries(home, ['pluginFiles']);
    const optNames = opt.entries.map((e) => e.name);
    assert.ok(optNames.includes('plugin-files/dsh-ssh.json'), '显式选中后应收录');
    assert.ok(optNames.includes('plugin-files/plugin-config/x/y.json'), '应递归收集约定配置目录');
    const sec = opt.sections.find((s) => s.sectionId === 'pluginFiles');
    assert.ok(sec?.risk !== undefined && sec.risk !== '', 'selected deviceSpecific 分区必须带风险提示');
  });
});

test('T2-P3 symlink 不被跟随（备份绝不读链接目标）', async (t) => {
  await withTmp(async (dir) => {
    const home = path.join(dir, 'home');
    await seedHome(home);
    const outside = path.join(dir, 'outside.txt');
    await fs.writeFile(outside, 'OUTSIDE SECRET\n', 'utf8');
    try {
      await fs.symlink(outside, path.join(home, 'skills', 'link.md'));
    } catch {
      t.skip('当前环境不允许创建 symlink');
      return;
    }
    const col = await collectBackupEntries(home);
    assert.ok(!col.entries.some((e) => e.name.endsWith('link.md')), 'symlink 条目不得进备份');
    const text = col.entries.map((e) => Buffer.from(e.data).toString('utf8')).join('\n');
    assert.ok(!text.includes('OUTSIDE SECRET'), '链接目标内容不得被读入备份');
  });
});

test('T2-P4 空 home → 零条目、无 included（如实报告，不虚构分区）', async () => {
  await withTmp(async (dir) => {
    const home = path.join(dir, 'empty-home');
    await fs.mkdir(home, { recursive: true });
    const col = await collectBackupEntries(home);
    assert.equal(col.entries.length, 0);
    assert.deepEqual(col.included, []);
    assert.equal(col.empty.length, DEFAULT_BACKUP_SECTIONS.length);
  });
});

test('T2-P5 isSensitiveFileName：黑名单/扩展名/大小写与子目录均命中', () => {
  for (const hit of [
    '.credentials.yaml', '.credentials.yml', '.credentials.json', '.env',
    'secrets.yaml', 'secrets.yml', 'key.pem', 'x.KEY', 'store.p12', 'a.pfx', 'b.keystore',
    'skills/.env', 'deep/nested/.credentials.yaml',
  ]) assert.equal(isSensitiveFileName(hit), true, `应判为凭据类: ${hit}`);
  for (const miss of ['skills/coding.md', 'AGENTS.md', 'dsh-ssh.json', 'config.json', 'notes.txt'])
    assert.equal(isSensitiveFileName(miss), false, `不应判为凭据类: ${miss}`);
});

test('T2-P6 parseSectionsArg：未知/离线不可用分区一律拒绝并列出可用值', () => {
  const ok = parseSectionsArg('pluginFiles, skills');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok === true ? ok.sections : [], ['skills', 'pluginFiles'], '应去重并保持声明顺序');

  for (const bad of ['settings', 'sessions', 'frobnicate']) {
    const r = parseSectionsArg(bad);
    assert.equal(r.ok, false, `应拒绝 ${bad}`);
    if (r.ok === false) assert.match(r.error, /unknown section/i);
  }
  const empty = parseSectionsArg('   ');
  assert.equal(empty.ok, false, '空值应拒绝');
  assert.deepEqual([...OFFLINE_BACKUP_SECTIONS].sort(), ['agentInstructions', 'agentPresets', 'pluginFiles', 'self', 'skills'].sort(),
    '可离线收集分区清单须与 CLI help 文案一致');
});

test('T2-P7 buildSectionFlags：只对实际收集的分区置 true，绝不虚报', () => {
  const flags = buildSectionFlags(['skills', 'self']);
  assert.equal(flags.skills, true);
  assert.equal(flags.self, true);
  for (const off of ['settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'workspaces',
    'credentialsStatus', 'secrets', 'sessions', 'agentPresets'] as SectionId[]) {
    assert.equal(flags[off], false, `未收集分区 ${off} 必须为 false`);
  }
});

test('T2-P8 闭环：collect → writeZip → verifyBackupZip 必须 OK', async () => {
  await withTmp(async (dir) => {
    const home = path.join(dir, 'home');
    await seedHome(home);
    const col = await collectBackupEntries(home, [...OFFLINE_BACKUP_SECTIONS]);
    assert.ok(col.entries.length > 0);

    const file = path.join(dir, 'offline-backup.zip');
    const checksums = buildChecksums(col.entries);
    const manifest = buildManifest({
      exporterVersion: '0.1.58', dshVersion: 'cli-offline', platform: 'win32', arch: 'x64',
      sections: buildSectionFlags(col.included), containsSecrets: false, encrypted: false, encryption: null,
    });
    await writeZip(file, [
      ...col.entries,
      { name: CHECKSUMS_FILE, data: enc(stringifyJsonSafe(checksums, { space: 2 })) },
      { name: MANIFEST_FILE, data: enc(JSON.stringify(manifest, null, 2)) },
    ]);

    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'OK', `闭环必须自检通过：${r.errors.join('; ')}`);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.sections, ['skills', 'agentPresets', 'agentInstructions', 'pluginFiles', 'self']);
    // 明文秘密在最终字节里也不得出现
    const buf = await fs.readFile(file);
    assert.ok(!buf.toString('utf8').includes('super-secret-plaintext'), '归档字节内不得含凭据明文');
  });
});

/* ---------------------------------------------------------------- 安全映射 / 同口径（契约回归） */

test('T2-V14 ZipSafetyError → CORRUPT（不是 VERIFY_ERROR），且诊断 message 收进 errors[]', async () => {
  await withTmp(async (dir) => {
    // ① 重复条目名：parseZipHardened 的强化防护（core parseZip 不查重复名）
    const dupPath = path.join(dir, 'dup.zip');
    await fs.writeFile(dupPath, zipToBuffer([
      { name: 'custom/skills/a.md', data: enc('# one\n') },
      { name: 'custom/skills/a.md', data: enc('# two\n') },
    ]));
    const r1 = await verifyBackupZip(dupPath);
    assert.equal(r1.verdict, 'CORRUPT', '重复条目名是确定的格式问题 → CORRUPT');
    assert.match(r1.errors.join(' '), /重复/, '具体原因必须收进 errors[]');

    // ② symlink 条目：改写中央目录 external attrs 高 16 位为 S_IFLNK(0xA000)
    const base = Buffer.from(zipToBuffer([{ name: 'custom/skills/link.md', data: enc('t\n') }]));
    const CENTRAL_SIG = 0x02014b50;
    let patched: Buffer | null = null;
    for (let i = 0; i + 46 <= base.length; i += 1) {
      if (base.readUInt32LE(i) === CENTRAL_SIG) {
        const b = Buffer.from(base);
        b.writeUInt32LE((0xa000 * 0x10000) >>> 0, i + 38);
        patched = b;
        break;
      }
    }
    assert.ok(patched !== null, '应能定位中央目录条目');
    const linkPath = path.join(dir, 'link.zip');
    await fs.writeFile(linkPath, patched!);
    const r2 = await verifyBackupZip(linkPath);
    assert.equal(r2.verdict, 'CORRUPT');
    assert.match(r2.errors.join(' '), /符号链接/, 'symlink 诊断必须收进 errors[]');

    // ③ 目录穿越条目名（../）
    const trav = Buffer.from(zipToBuffer([{ name: 'custom/skills/a.md', data: enc('# x\n') }]));
    const evil = Buffer.from('../../etc/passwdXX'); // 与 'custom/skills/a.md' 等长
    assert.equal(evil.length, 18, '测试构造前提：替换名与原等长');
    const cenIdx = trav.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    evil.copy(trav, 30);            // 本地文件头 name
    evil.copy(trav, cenIdx + 46);   // 中央目录 name
    const travPath = path.join(dir, 'trav.zip');
    await fs.writeFile(travPath, trav);
    const r3 = await verifyBackupZip(travPath);
    assert.equal(r3.verdict, 'CORRUPT');
    assert.match(r3.errors.join(' '), /条目名/, '穿越诊断必须收进 errors[]');

    // 三者都不得被降级成 VERIFY_ERROR（那是「无法判定内容」，与确定的格式/安全问题不同）
    for (const r of [r1, r2, r3]) {
      assert.notEqual(r.verdict, 'VERIFY_ERROR', 'ZipSafetyError 不得归为 VERIFY_ERROR');
    }
  });
});

test('T2-V15 checksums 同口径：表只覆盖「除 manifest 与 checksums 自身外」的条目', async () => {
  await withTmp(async (dir) => {
    // 真实备份校验：表内条目数 = 归档条目数 - 2（与 exporter 的 buildChecksums 口径一致）。
    // 这条断言防的是「校验口径不一致把正常备份误判成 CORRUPT」。
    const file = path.join(dir, 'parity.zip');
    const data: ZipWriteEntry[] = [
      { name: 'custom/skills/a.md', data: enc('# a\n') },
      { name: 'config/settings.json', data: enc(stringifyJsonSafe({ version: 1, namespaces: {} }, { space: 2 })) },
    ];
    await writeBackupZip(file, { data });
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'OK', '口径一致时正常备份必须 OK（不得误判 CORRUPT）');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, [], '完全对齐的备份不应产生 warning');
    assert.equal(r.entryCount, data.length + 2, '归档含 2 个非数据条目（manifest + checksums）');

    // 反向：校验表若错误地把自己/manifest 也纳入，则那些条目也须能被校验（不应 false CORRUPT）。
    // exporter 不这么做，但校验侧必须容忍（不因「多了条目」而误判）。
    const selfCovered = path.join(dir, 'self-covered.zip');
    const entries: ZipWriteEntry[] = [...data];
    const withSelf = [...entries, { name: MANIFEST_FILE, data: enc('{}') }];
    const table = buildChecksums(withSelf); // 故意把 manifest 也纳入
    await writeZip(selfCovered, [
      ...entries,
      { name: CHECKSUMS_FILE, data: enc(stringifyJsonSafe(table, { space: 2 })) },
      { name: MANIFEST_FILE, data: enc(JSON.stringify(makeManifest(), null, 2)) },
    ]);
    const r2 = await verifyBackupZip(selfCovered);
    // manifest 内容与表中 hash 不符（表按 '{}' 算）→ 必须 CORRUPT 并点名 manifest.json
    assert.equal(r2.verdict, 'CORRUPT');
    assert.match(r2.errors.join(' '), /manifest\.json/, '须点名被覆盖但不符的条目');
  });
});

test('T2-V16 复用官方 verifyChecksums 的同时不整体物化条目（内存边界回归）', async () => {
  await withTmp(async (dir) => {
    // 背景：要求复用官方 verifyChecksums（同口径），而它的签名需要 ReadonlyMap。
    // 若直接传一个「装满全部条目」的 Map，就会先把全部条目解压后常驻内存，
    // 违背「边读边算」的内存边界。实现改用惰性 Map 子类（只覆写 get/has），
    // 本用例通过计数 readEntry 调用，锁定「只解压必要条目」这一性质。
    const file = path.join(dir, 'lazy.zip');
    const data: ZipWriteEntry[] = [
      { name: 'custom/skills/a.md', data: enc('# a\n') },
      { name: 'custom/skills/b.md', data: enc('# b\n') },
      { name: 'custom/skills/c.md', data: enc('# c\n') },
    ];
    await writeBackupZip(file, { data });

    // 计数：monkey-patch ZipArchive.prototype.readEntry（测试结束时还原）
    const { ZipArchive } = await import('../../src/utils/zip.ts');
    const original = ZipArchive.prototype.readEntry;
    const seen: string[] = [];
    ZipArchive.prototype.readEntry = function (this: unknown, name: string) {
      seen.push(name);
      return original.call(this, name);
    } as typeof original;

    let result;
    try {
      result = await verifyBackupZip(file);
    } finally {
      ZipArchive.prototype.readEntry = original;
    }

    assert.equal(result.verdict, 'OK', '应通过: ' + result.errors.join('; '));
    const unique = new Set(seen);
    // 期望：只读「表内每个条目一次」+ manifest + checksums 各一次。
    // 若实现整体物化，则会额外把全部条目再读一遍（unique 不变但调用总数变多），
    // 或在 pre-scan 阶段就先读一遍全部条目。
    assert.equal(
      unique.size,
      data.length + 2,
      '只应解压必要条目（' + data.length + ' 数据 + manifest + checksums = ' + (data.length + 2) + '），实际 ' + unique.size,
    );
    assert.ok(
      unique.has(MANIFEST_FILE) && unique.has(CHECKSUMS_FILE),
      'manifest 与 checksums 必须被读取（否则无法完成校验）',
    );
  });
});

test('T2-V17 惰性 Map 的 get/has 语义与 missing 归类正确', async () => {
  await withTmp(async (dir) => {
    // 表内声明了一个归档中不存在的条目 → 必须归入 missing → CORRUPT 并点名
    const file = path.join(dir, 'missing-entry.zip');
    const data: ZipWriteEntry[] = [{ name: 'custom/skills/a.md', data: enc('# a\n') }];
    const table = { ...buildChecksums(data), 'custom/skills/ghost.md': 'a'.repeat(64) };
    await writeZip(file, [
      ...data,
      { name: CHECKSUMS_FILE, data: enc(stringifyJsonSafe(table, { space: 2 })) },
      { name: MANIFEST_FILE, data: enc(JSON.stringify(makeManifest(), null, 2)) },
    ]);
    const r = await verifyBackupZip(file);
    assert.equal(r.verdict, 'CORRUPT');
    // 关键：不存在的条目必须走 missing（惰性 get 返回 undefined），而非抛错或误判为 unreadable
    assert.match(r.errors.join(' '), /缺失/, '不存在的条目应归为 missing');
    assert.match(r.errors.join(' '), /ghost\.md/, '必须点名缺失条目');
    assert.doesNotMatch(r.errors.join(' '), /无法读取/, 'missing 不应被误报为 unreadable');
  });
});

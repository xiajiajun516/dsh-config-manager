/**
 * utils/zip 单元测试（t25）：
 *  - ① 默认解析器 `parseZip` **本身就是最严版本**：重复条目名 / symlink 条目 / 本地文件头越界
 *    三项加固已内置（此前只存在于 security/zip-security.ts 的可选注入版，默认路径是弱版）；
 *  - ③ 导出侧条目数上限与读侧**同源**（同一常量 DEFAULT_ZIP_SAFETY_LIMITS），
 *    超限抛 ZipSafetyError（可读文案），不再是 EOCD 的 UInt16 溢出裸 RangeError。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_ZIP_SAFETY_LIMITS,
  ZIP_MAX_WRITABLE_ENTRIES,
  ZipSafetyError,
  assertZipEntryCount,
  crc32,
  parseZip,
  writeZip,
  zipToBuffer,
} from './zip.ts';

/* ---------------- 手工构造原始 ZIP（绕过写侧，用于读侧攻击样本） ---------------- */

interface RawEntry {
  name: string;
  data: Uint8Array;
  /** 中央目录 external attrs（高 16 位 = Unix mode） */
  externalAttrs?: number;
  /** 覆盖本地文件头偏移（越界样本用） */
  localOffsetOverride?: number;
}

/**
 * `opts.eocdEntryCount`：覆盖 EOCD 里声明的条目数（不改实际中央目录）。
 * 用于构造「声明的条目数超限」样本 —— 默认解析器在遍历中央目录**之前**先按该字段判上限，
 * 因此无需真的写出一万条就能驱动读侧防线（t36 后写侧已不再允许越过读侧上限，
 * 这类样本只能这样造）。
 */
function buildRawZip(entries: RawEntry[], opts: { eocdEntryCount?: number } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); // store（样本不需要压缩）
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    offsets.push(offset);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdOffset = offset;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10); // store
    cen.writeUInt32LE(crc32(data), 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(e.externalAttrs ?? 0, 38);
    cen.writeUInt32LE(e.localOffsetOverride ?? offsets[i]!, 42);
    central.push(cen, nameBuf);
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.eocdEntryCount ?? entries.length, 8);
  eocd.writeUInt16LE(opts.eocdEntryCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.from(Buffer.concat([...locals, cd, eocd]));
}

const isZipSafetyErrorWith = (re: RegExp) => (err: unknown): boolean =>
  err instanceof ZipSafetyError && re.test((err as Error).message);

/* ---------------- ① 默认解析器即最严 ---------------- */

test('zip: 默认 parseZip 拒绝重复条目名（读取歧义）', () => {
  const buf = buildRawZip([
    { name: 'a.txt', data: Buffer.from('first') },
    { name: 'a.txt', data: Buffer.from('second') },
  ]);
  assert.throws(() => parseZip(buf), isZipSafetyErrorWith(/重复/));
});

test('zip: 默认 parseZip 拒绝 symlink 条目（external attrs S_IFLNK），普通 mode 不误伤', () => {
  const symlinkAttrs = (0xa1ff << 16) >>> 0; // S_IFLNK | 0777
  assert.throws(
    () => parseZip(buildRawZip([{ name: 'link', data: Buffer.from('target'), externalAttrs: symlinkAttrs }])),
    isZipSafetyErrorWith(/符号链接/),
  );
  const normalAttrs = (0x81a4 << 16) >>> 0; // S_IFREG | 0644
  const ok = parseZip(buildRawZip([{ name: 'file.txt', data: Buffer.from('x'), externalAttrs: normalAttrs }]));
  assert.deepEqual(ok.names(), ['file.txt']);
});

test('zip: 默认 parseZip 拒绝本地文件头越界（localOffset + 30 超出 ZIP）', () => {
  const buf = buildRawZip([{ name: 'a.txt', data: Buffer.from('x'), localOffsetOverride: 0xffff_0000 }]);
  assert.throws(() => parseZip(buf), isZipSafetyErrorWith(/本地文件头越界/));
});

test('zip: 默认 parseZip 缺省限额即读侧默认（10001 条被拒，上限文案含常量值）', () => {
  const over = Array.from({ length: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1 }, (_, i) => ({
    name: `f${i}.bin`,
    data: Buffer.alloc(0),
  }));
  assert.throws(() => parseZip(buildRawZip(over)), isZipSafetyErrorWith(/条目数 10001 超过上限 10000/));
});

test('zip: 加固后仍接受自身产物（zipToBuffer 正常 ZIP 可解析并读回）', () => {
  const buf = zipToBuffer([
    { name: 'a/b.txt', data: Buffer.from('hello') },
    { name: 'c.json', data: Buffer.from('{"x":1}') },
  ]);
  const archive = parseZip(buf);
  assert.deepEqual(archive.names(), ['a/b.txt', 'c.json']);
  assert.equal(Buffer.from(archive.readEntry('a/b.txt')).toString(), 'hello');
});

/* ---------------- ③ 导出侧条目数上限 ---------------- */

test('zip: 导出口条目上限与读侧同源（10000），且读侧上限未被调高', () => {
  assert.equal(DEFAULT_ZIP_SAFETY_LIMITS.maxEntries, 10_000, '读侧 10000 上限不得调整');
  assert.equal(DEFAULT_ZIP_SAFETY_LIMITS.maxTotalBytes, 500 * 1024 * 1024);
  assert.doesNotThrow(() => assertZipEntryCount(DEFAULT_ZIP_SAFETY_LIMITS.maxEntries));
  assert.throws(() => assertZipEntryCount(DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1), isZipSafetyErrorWith(/上限 10000/));
  // t36：写侧上限**只允许收紧** —— 传入更大的 maxEntries 会被钳到读侧上限，
  // 故此处报的是 10000，而不是 UInt16 物理上限 65535。
  // （改动前本断言期望 /65535/：那时只与物理上限取 min，读侧上限可被调用方绕过。）
  assert.throws(
    () => assertZipEntryCount(ZIP_MAX_WRITABLE_ENTRIES + 1, { maxEntries: 1_000_000 }),
    isZipSafetyErrorWith(/上限 10000（/),
  );
  // UInt16 物理上限仍是第二因子（当前高于读侧上限，故不先于它生效）
  assert.ok(
    ZIP_MAX_WRITABLE_ENTRIES > DEFAULT_ZIP_SAFETY_LIMITS.maxEntries,
    '物理上限应高于读侧上限，否则第二因子失去意义',
  );
});


test('zip: 显式调高 maxEntries 无法越过读侧上限（t36：不得写出读不回来的 ZIP）', () => {
  const over = Array.from({ length: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1 }, (_, i) => ({
    name: `o${i}.txt`,
    data: new Uint8Array(0),
  }));
  // 改动前：max = min(1_000_000, 0xFFFF) = 65535 → 10001 条**写得出来**，
  // 而默认 parseZip（10_000）必然拒绝 → 「导出成功却导不回」。以下两条断言在改动前均为红。
  assert.throws(() => zipToBuffer(over, { maxEntries: 1_000_000 }), isZipSafetyErrorWith(/上限 10000（/));
  assert.throws(
    () => assertZipEntryCount(over.length, { maxEntries: 1_000_000 }),
    isZipSafetyErrorWith(/上限 10000（/),
  );
  // 只允许**收紧**：往下调的 maxEntries 依然生效
  assert.doesNotThrow(() => zipToBuffer(over.slice(0, 10), { maxEntries: 10 }));
  assert.throws(() => zipToBuffer(over.slice(0, 11), { maxEntries: 10 }), isZipSafetyErrorWith(/上限 10（/));
});

test('zip: 调高 maxEntries 后写出的产物仍能被默认解析器读回（写侧恒不高于读侧）', () => {
  const exactly = Array.from({ length: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries }, (_, i) => ({
    name: `p${i}.txt`,
    data: new Uint8Array(0),
  }));
  const buf = zipToBuffer(exactly, { maxEntries: 1_000_000 }); // 传入值被钳到 10_000
  assert.equal(parseZip(buf).names().length, DEFAULT_ZIP_SAFETY_LIMITS.maxEntries);
});

test('zip: EOCD 声明的条目数超限 → parseZip 先于中央目录遍历拒绝（读侧防线，样本不经写侧）', () => {
  const buf = buildRawZip([{ name: 'a.txt', data: Buffer.from('x') }], {
    eocdEntryCount: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1,
  });
  assert.throws(() => parseZip(buf), isZipSafetyErrorWith(/条目数 10001 超过上限 10000/));
});

test('zip: zipToBuffer 条目数超限抛 ZipSafetyError（而不是 UInt16 溢出的裸 RangeError）', () => {
  const over = Array.from({ length: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1 }, (_, i) => ({
    name: `f${i}.txt`,
    data: new Uint8Array(0),
  }));
  try {
    zipToBuffer(over);
    assert.fail('超限必须抛出');
  } catch (err) {
    assert.ok(err instanceof ZipSafetyError, `应为 ZipSafetyError，实际 ${(err as Error)?.constructor?.name}`);
    assert.ok(!(err instanceof RangeError), '不得是 Buffer 的裸 RangeError');
    assert.match((err as Error).message, /上限 10000/);
  }
});

test('zip: 恰好 10000 条可写出且能被默认解析器读回（读写上限一致）', () => {
  const exactly = Array.from({ length: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries }, (_, i) => ({
    name: `g${i}.txt`,
    data: new Uint8Array(0),
  }));
  const buf = zipToBuffer(exactly);
  assert.equal(parseZip(buf).names().length, DEFAULT_ZIP_SAFETY_LIMITS.maxEntries);
});

/* ---------------- t46：writeZip 流式 + 异步压缩 的格式与行为守卫 ---------------- */

/** 多形态夹具：嵌套路径 / 空文件 / 二进制 / 中文名 / 不可压缩数据 —— 覆盖布局的各类分支。 */
function writeZipFixture(): { name: string; data: Uint8Array }[] {
  return [
    { name: 'config/settings.json', data: Buffer.from(JSON.stringify({ version: 1, namespaces: {} })) },
    { name: 'a/b/c/deep.txt', data: Buffer.from('deep') },
    { name: 'empty.bin', data: new Uint8Array(0) },
    { name: '中文/名字.json', data: Buffer.from('{"k":"中文"}', 'utf8') },
    { name: 'bin/random.dat', data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)) },
  ];
}

test('zip(t46): writeZip 产物与 zipToBuffer **逐项等价**（流式改写不得改格式）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-w-'))
  try {
    const entries = writeZipFixture()
    const viaBuffer = zipToBuffer(entries)
    const outPath = path.join(tmp, 'out.zip')
    await writeZip(outPath, entries)
    const viaStream = await fs.readFile(outPath)
    // 容器尺寸一致（布局逐字节对齐），内容/条目名逐项一致（压缩流不得漂移）
    assert.equal(viaStream.length, viaBuffer.length, '两个写路径产出的 ZIP 长度必须一致')
    const a = parseZip(viaBuffer)
    const b = parseZip(viaStream)
    assert.deepEqual(b.names(), a.names())
    for (const name of a.names()) {
      assert.deepEqual(Buffer.from(b.readEntry(name)), Buffer.from(a.readEntry(name)), name + ' 内容必须一致')
    }
    // 默认解析器可读回（格式契约）
    assert.equal(b.names().length, entries.length)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('zip(t46): writeZip 受同一读侧条目数上限约束，且超限时不留下任何产物', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-wl-'))
  try {
    const over = Array.from({ length: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `o${i}.txt`, data: new Uint8Array(0) }))
    const outPath = path.join(tmp, 'over.zip')
    await assert.rejects(() => writeZip(outPath, over, { maxEntries: 1_000_000 }), isZipSafetyErrorWith(/上限 10000（/))
    await assert.rejects(() => fs.stat(outPath), '超限必须在写任何字节前拒绝')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('zip(t46): writeZip 拒绝不安全条目名，且不留残留文件（原子发布）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-ws-'))
  try {
    const outPath = path.join(tmp, 'safe.zip')
    await assert.rejects(
      () => writeZip(outPath, [{ name: '../evil.txt', data: Buffer.from('x') }]),
      isZipSafetyErrorWith(/不安全的条目名/),
    )
    assert.deepEqual(await fs.readdir(tmp), [], '失败后目录里不得留下 tmp 或半成品')
    // 正常路径：可覆盖既有文件并原子发布
    await fs.writeFile(outPath, 'old-content')
    await writeZip(outPath, [{ name: 'k.txt', data: Buffer.from('v') }])
    assert.deepEqual(parseZip(await fs.readFile(outPath)).names(), ['k.txt'])
    assert.deepEqual(await fs.readdir(tmp), ['safe.zip'], '发布后不得留下 tmp')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

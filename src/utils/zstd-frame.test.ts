/**
 * 多帧 zstd 工具单测（issue #45 P3）。
 *
 * 钉住的语义：帧边界识别（拼接容器 / 撕裂末帧 / maxFrames）、损坏拒绝（魔数 / 保留位 / 保留块类型）、
 * 以及「编码出来的帧带内容校验和」—— 写回的会话日志必须能被 DSH 自己的解码路径接受。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeZstdFrame, encodeZstdFrame, firstFrameEnd, scanZstdFrames, ZSTD_MAGIC, zstdAvailable } from './zstd-frame.ts';

const header = Buffer.from('{"version":3,"id":"session-a","cwd":"D:/old"}\n', 'utf8');
const batch = Buffer.from('{"seq":1}\n{"seq":2}\n', 'utf8');

test('运行时的 Node 提供 zstd 编解码（engines 已要求 22.19+/24）', () => {
  assert.equal(zstdAvailable(), true);
  assert.equal(encodeZstdFrame(header).readUInt32LE(0), ZSTD_MAGIC);
});

test('encodeZstdFrame：帧头带内容校验和标志（与 DSH CHECKSUM_OPTIONS 同款）', () => {
  const frame = encodeZstdFrame(header);
  // descriptor 紧跟在 4 字节魔数之后；bit2 = Content_Checksum_flag
  assert.equal((frame.readUInt8(4) & 4) !== 0, true);
  assert.deepEqual(decodeZstdFrame(frame), header);
});

test('scanZstdFrames：拼接容器逐帧给出边界，内容可分别解出', () => {
  const f1 = encodeZstdFrame(header);
  const f2 = encodeZstdFrame(batch);
  const f3 = encodeZstdFrame(Buffer.from('third', 'utf8'));
  const container = Buffer.concat([f1, f2, f3]);

  const scan = scanZstdFrames(container);
  assert.equal(scan.frames.length, 3);
  assert.equal(scan.tornStart, undefined);
  assert.deepEqual(scan.frames[0], { start: 0, end: f1.length });
  assert.deepEqual(scan.frames[1], { start: f1.length, end: f1.length + f2.length });
  assert.deepEqual(scan.frames[2], { start: f1.length + f2.length, end: container.length });
  assert.deepEqual(decodeZstdFrame(container.subarray(0, f1.length)), header);
  assert.deepEqual(decodeZstdFrame(container.subarray(f1.length, f1.length + f2.length)), batch);
  assert.equal(firstFrameEnd(container), f1.length, 'firstFrameEnd = 第 1 帧结束偏移');
});

test('scanZstdFrames：撕裂的末帧 → 前面的完整帧照常返回 + tornStart 指到末帧起点', () => {
  const f1 = encodeZstdFrame(header);
  const f2 = encodeZstdFrame(batch);
  const torn = Buffer.concat([f1, f2.subarray(0, f2.length - 3)]);
  const scan = scanZstdFrames(torn);
  assert.equal(scan.frames.length, 1);
  assert.equal(scan.tornStart, f1.length);
  assert.equal(firstFrameEnd(torn), f1.length);
});

test('scanZstdFrames：maxFrames 只解析前 N 帧（读 header 时的省流路径）', () => {
  const container = Buffer.concat([encodeZstdFrame(header), encodeZstdFrame(batch)]);
  const scan = scanZstdFrames(container, 1);
  assert.equal(scan.frames.length, 1);
  assert.equal(scan.tornStart, undefined, '命中上限不算撕裂');
});

test('firstFrameEnd：整个文件就是一个完整帧 → 帧长；不足一帧 → null', () => {
  const frame = encodeZstdFrame(header);
  assert.equal(firstFrameEnd(frame), frame.length);
  assert.equal(firstFrameEnd(frame.subarray(0, frame.length - 2)), null);
  assert.equal(firstFrameEnd(Buffer.alloc(0)), null);
  assert.deepEqual(scanZstdFrames(Buffer.alloc(0)), { frames: [] });
});

test('损坏拒绝：魔数不对 / 帧头保留位 / 保留块类型都抛错（绝不猜测）', () => {
  assert.throws(() => scanZstdFrames(Buffer.from('not-zstd-at-all', 'utf8')), /invalid frame magic/);
  // descriptor = 0x18 → bit3/bit4 是保留位
  assert.throws(
    () => scanZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x18])),
    /reserved frame-header bit/,
  );
  // descriptor = 0（非 single-segment → 1 字节 window descriptor），block header = 6 → 块类型 3（保留）
  assert.throws(
    () => scanZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x06, 0x00, 0x00])),
    /reserved block type/,
  );
});

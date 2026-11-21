import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentIdOfHex,
  attachmentIdOfRelPath,
  extractAttachmentIds,
  hexOfAttachmentId,
} from './attachment-refs.ts';

const HEX_A = 'a'.repeat(64);
const HEX_B = '0123456789abcdef'.repeat(4);
const ID_A = `sha256:${HEX_A}`;
const ID_B = `sha256:${HEX_B}`;

test('attachment-refs: 只认 attachmentId 字段形态，不误命中源码粘贴里的 sha256 字样', () => {
  const text = [
    '{"type":"image","attachment":{"attachmentId":"' + ID_A + '","mediaType":"image/jpeg"}}',
    'const header = "x-oss-content-sha256";',
    "sha256: ''",
    'README 里写着 sha256:' + HEX_B + '（没有引号与字段名）',
  ].join('\n');
  assert.deepEqual([...extractAttachmentIds(text)], [ID_A]);
});

test('attachment-refs: 多个引用去重，且容忍字段前后空白', () => {
  const text = `{"attachmentId": "${ID_A}"}\n{"attachmentId":"${ID_B}"}\n{"attachmentId":"${ID_A}"}`;
  assert.deepEqual([...extractAttachmentIds(text)].sort(), [ID_A, ID_B].sort());
});

test('attachment-refs: 大写 hex 与短 hex 不算附件 id（宿主形状是严格小写 64 位）', () => {
  const upper = `sha256:${'A'.repeat(64)}`;
  const short = `sha256:${'a'.repeat(63)}`;
  const text = `{"attachmentId":"${upper}"}\n{"attachmentId":"${short}"}`;
  assert.equal(extractAttachmentIds(text).size, 0);
});

test('attachment-refs: hex 与 id 双向转换对称，非法输入返回 null', () => {
  assert.equal(hexOfAttachmentId(ID_A), HEX_A);
  assert.equal(attachmentIdOfHex(HEX_A), ID_A);
  assert.equal(hexOfAttachmentId(`sha256:${HEX_A.toUpperCase()}`), null);
  assert.equal(hexOfAttachmentId('sha256:xyz'), null);
  assert.equal(attachmentIdOfHex('abc'), null);
});

test('attachment-refs: 库里三种布局都能由路径反推 id（不硬编码深度）', () => {
  assert.equal(attachmentIdOfRelPath(`v1/objects/aa/${HEX_A}`), ID_A);
  assert.equal(attachmentIdOfRelPath(`v1/file-objects/01/${HEX_B}`), ID_B);
  assert.equal(attachmentIdOfRelPath(`v1/files/aa/${HEX_A}/report.pdf`), ID_A);
  assert.equal(attachmentIdOfRelPath('v1/tmp/scratch.bin'), null);
  assert.equal(attachmentIdOfRelPath(`v1\\objects\\aa\\${HEX_A}`), ID_A);
});

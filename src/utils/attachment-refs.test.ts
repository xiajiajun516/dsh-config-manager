import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentIdOfHex,
  attachmentIdOfRelPath,
  extractAttachmentIds,
  extractAttachmentRefs,
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

test('attachment-refs(G5): 同趟抽出 mediaType 与字节数（附件行的展示名来源）', () => {
  const text = [
    '{"attachmentId":"' + ID_A + '","mediaType":"image/jpeg","bytes":10240}',
    // 同一个 id 第二次出现但没带 mediaType：保留首个非空声明，不得清空
    '{"attachmentId":"' + ID_A + '"}',
  ].join('\n');
  const refs = extractAttachmentRefs(text);
  assert.equal(refs.get(ID_A)?.mediaType, 'image/jpeg');
  assert.equal(refs.get(ID_A)?.bytes, 10240);
});

test('attachment-refs(G5): 形状不符的 mediaType 一律不采信，也不因此漏掉引用本身', () => {
  // 宿主直出的 mediaType 是 MIME；带空格或引号的东西不是它，宁可不显示也别渲染出怪字符串
  const text = '{"attachmentId":"' + ID_A + '","mediaType":"image/png; <script>","bytes":-1}';
  const refs = extractAttachmentRefs(text);
  assert.deepEqual([...refs.keys()], [ID_A], '引用本身必须照收');
  assert.equal(refs.get(ID_A)?.mediaType, undefined);
  assert.equal(refs.get(ID_A)?.bytes, undefined, 'bytes 只认非负整数，"-1" 这种畸形值不采信');
});

test('attachment-refs(G3): 真名在对象末尾也能取到（字段顺序无关），且不跨对象串名', () => {
  // 宿主直出的顺序是 attachmentId → mediaType → bytes → width/height → name：真名排在最后，
  // 旧实现只抓「紧邻 attachmentId 的字段」，因此一条都取不到（这是附件行显示 image/png 的根因）。
  const text = [
    '{"attachmentId":"' + ID_A + '","mediaType":"image/png","bytes":10,"width":715,"height":516,"name":"P-01-after.png"}',
    '{"attachmentId":"' + ID_B + '","mediaType":"image/png","bytes":20}',
  ].join('\n');
  const refs = extractAttachmentRefs(text);
  assert.deepEqual(refs.get(ID_A), { mediaType: 'image/png', bytes: 10, name: 'P-01-after.png' });
  assert.deepEqual(refs.get(ID_B), { mediaType: 'image/png', bytes: 20 }, '第二个对象没有 name，绝不能继承上一个的真名');
});

test('attachment-refs(G3): 带路径分隔符 / 引号 / 控制字符的 name 不采信，但引用与 mediaType 保留', () => {
  for (const name of ['dir/evil.png', 'bad"name.png', 'line\nbreak.png']) {
    const text = '{"attachmentId":"' + ID_A + '","mediaType":"image/png","name":' + JSON.stringify(name) + '}';
    const refs = extractAttachmentRefs(text);
    assert.equal(refs.get(ID_A)?.name, undefined, '会破坏行标题的 name 不得进展示名：' + name);
    assert.equal(refs.get(ID_A)?.mediaType, 'image/png', '拒绝 name 不得连引用一起丢');
  }
});

test('attachment-refs(G3): 中文、空格与点号的真名照收（本机附件名就是这样）', () => {
  const text = '{"attachmentId":"' + ID_A + '","name":"截图 2026-11-21 20.24.38.png"}';
  assert.equal(extractAttachmentRefs(text).get(ID_A)?.name, '截图 2026-11-21 20.24.38.png');
});

test('attachment-refs: 库里三种布局都能由路径反推 id（不硬编码深度）', () => {
  assert.equal(attachmentIdOfRelPath(`v1/objects/aa/${HEX_A}`), ID_A);
  assert.equal(attachmentIdOfRelPath(`v1/file-objects/01/${HEX_B}`), ID_B);
  assert.equal(attachmentIdOfRelPath(`v1/files/aa/${HEX_A}/report.pdf`), ID_A);
  assert.equal(attachmentIdOfRelPath('v1/tmp/scratch.bin'), null);
  assert.equal(attachmentIdOfRelPath(`v1\\objects\\aa\\${HEX_A}`), ID_A);
});

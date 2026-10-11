/**
 * 「查看」→ 右侧栏标签页的地址契约与降级判定单测（纯函数，node 可测）。
 *
 * 为什么值得单测：这条链路的失败模式全是**静默**的 —— 地址拼错 = 侧栏认领不了、
 * 解析失败 = 标签页显示空、服务缺 receiver = 打开动作必然抛。
 * 所以这里逐条钉住：往返、坏地址、收窄（含 bind 回原对象）、三档打开结果。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  asSidebarRightFace,
  asSidebarRightTabsFace,
  declaredPaneTabKind,
  openRollbackDiff,
  parseRollbackDiffAddress,
  rollbackDiffAddress,
  rollbackDiffBaseName,
  rollbackDiffTabDefinition,
  rollbackDiffTitle,
  ROLLBACK_DIFF_ADDRESS_PREFIX,
  ROLLBACK_DIFF_TAB_ID,
  ROLLBACK_DIFF_TAB_KIND,
} from './rollback-diff-tab.ts'

test('地址往返：Windows 盘符 / 空格 / 中文 / 井号都逐字还原（都编码进地址）', () => {
  for (const file of [
    'D:\\Projects\\dsh-config-manager\\src\\core\\rollback-point.ts',
    'C:\\Users\\y z\\My Docs\\a b.md',
    '/home/u/项目/说明 文档#1.md',
  ]) {
    const address = rollbackDiffAddress('p-1', file)
    assert.ok(address.startsWith(ROLLBACK_DIFF_ADDRESS_PREFIX))
    assert.deepEqual(parseRollbackDiffAddress(address), { pointId: 'p-1', path: file }, file)
  }
})

test('地址解析：非本类型 / 形状不成 / 解码失败一律 null（绝不猜一个文件出来）', () => {
  assert.equal(parseRollbackDiffAddress(undefined), null)
  assert.equal(parseRollbackDiffAddress('dsh-resource://file/abc'), null)
  assert.equal(parseRollbackDiffAddress(ROLLBACK_DIFF_ADDRESS_PREFIX), null)
  assert.equal(parseRollbackDiffAddress(ROLLBACK_DIFF_ADDRESS_PREFIX + 'onlyid'), null)
  assert.equal(parseRollbackDiffAddress(ROLLBACK_DIFF_ADDRESS_PREFIX + '/D:\\a.txt'), null, '空 id 不成')
  assert.equal(parseRollbackDiffAddress(ROLLBACK_DIFF_ADDRESS_PREFIX + 'p-1/'), null, '空路径不成')
  assert.equal(parseRollbackDiffAddress(ROLLBACK_DIFF_ADDRESS_PREFIX + 'p-1/%E0%A4%A'), null, '解码失败不成')
})

test('标题 = 文件名（坏地址回落空串，绝不把整条地址当标题）', () => {
  assert.equal(rollbackDiffBaseName('D:\\a\\b\\c.ts'), 'c.ts')
  assert.equal(rollbackDiffBaseName('/a/b/'), 'b')
  assert.equal(rollbackDiffBaseName('plain.md'), 'plain.md')
  assert.equal(rollbackDiffTitle(rollbackDiffAddress('p', 'D:\\a\\b\\c.ts')), 'c.ts')
  assert.equal(rollbackDiffTitle('dsh-resource://file/x'), '')
})

test('类型定义：只认自己前缀的地址（patterns + canOpen 同源）', () => {
  const def = rollbackDiffTabDefinition()
  assert.equal(def.id, ROLLBACK_DIFF_TAB_ID)
  assert.equal(def.kind, ROLLBACK_DIFF_TAB_KIND)
  assert.deepEqual(def.patterns, [ROLLBACK_DIFF_ADDRESS_PREFIX + '**'])
  assert.equal(def.canOpen?.(rollbackDiffAddress('p', 'D:\\a.txt')), true)
  assert.equal(def.canOpen?.('dsh-resource://file/a.txt'), false)
})

test('打开动作三档：缺服务 / 调用抛错 / 成功（kind 必须带上我们自己的种类）', () => {
  assert.deepEqual(openRollbackDiff(undefined, rollbackDiffAddress('p', 'a')), { ok: false, reason: 'no-sidebar' })
  const broken = { openResource: () => { throw new Error('no session') } }
  const failed = openRollbackDiff(broken, rollbackDiffAddress('p', 'a'))
  assert.equal(failed.ok, false)
  assert.equal(failed.ok === false ? failed.reason : '', 'failed')
  const calls: { address: string; kind?: string }[] = []
  const ok = openRollbackDiff({ openResource: (address, options) => { calls.push({ address, kind: options?.kind }) } }, rollbackDiffAddress('p', 'a'))
  assert.deepEqual(ok, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.kind, ROLLBACK_DIFF_TAB_KIND)
})

test('收窄必须 bind 回原服务对象（丢 receiver 会让 openResource/register 必然抛）', () => {
  const service = {
    seen: [] as string[],
    registered: undefined as string | undefined,
    openResource(address: string) { this.seen.push(address) },
    register(definition: { id: string }) { this.registered = definition.id; return () => {} },
  }
  const face = asSidebarRightFace(service)
  assert.ok(face !== undefined)
  face.openResource(rollbackDiffAddress('p', 'a'))
  assert.equal(service.seen.length, 1, 'this 仍指向原对象')
  const tabs = asSidebarRightTabsFace(service)
  assert.ok(tabs !== undefined)
  tabs.register(rollbackDiffTabDefinition())
  assert.equal(service.registered, ROLLBACK_DIFF_TAB_ID)
  assert.equal(asSidebarRightFace({}), undefined)
  assert.equal(asSidebarRightTabsFace({ register: 1 }), undefined)
  assert.equal(asSidebarRightFace(null), undefined)
})

test('槽位形态探测：只有 keyed 才算可用；chain / 抛错 / 无 spec 一律 null', () => {
  assert.equal(declaredPaneTabKind({ spec: () => ({ kind: 'keyed', scope: 'session' }) }), 'keyed')
  assert.equal(declaredPaneTabKind({ spec: () => ({ kind: 'chain' }) }), 'chain')
  assert.equal(declaredPaneTabKind({ spec: () => undefined }), null)
  assert.equal(declaredPaneTabKind({ spec: () => { throw new Error('boom') } }), null)
  assert.equal(declaredPaneTabKind(null), null)
  assert.equal(declaredPaneTabKind(undefined), null)
})

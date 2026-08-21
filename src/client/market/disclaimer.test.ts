/**
 * m-disclaimer 免责状态单测：key 隔离、读写往返、存储异常降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  disclaimerStorageKey, readDisclaimerDismissed, writeDisclaimerDismissed,
  DISCLAIMER_STORAGE_PREFIX,
} from './disclaimer.ts'

/** 内存 Storage mock（最小实现 Pick<Storage,'getItem'|'setItem'>） */
function mockStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem(key: string): string | null { return data.get(key) ?? null },
    setItem(key: string, value: string): void { data.set(key, value) },
  }
}

test('disclaimer: key 生成带前缀且三操作互不相同', () => {
  assert.equal(disclaimerStorageKey('upload'), `${DISCLAIMER_STORAGE_PREFIX}upload`)
  assert.equal(disclaimerStorageKey('download'), `${DISCLAIMER_STORAGE_PREFIX}download`)
  assert.equal(disclaimerStorageKey('install'), `${DISCLAIMER_STORAGE_PREFIX}install`)
  const keys = new Set((['upload', 'download', 'install'] as const).map(disclaimerStorageKey))
  assert.equal(keys.size, 3, '三操作 key 必须互不相同（分开记）')
})

test('disclaimer: 未写入时默认 false（要弹免责）', () => {
  const storage = mockStorage()
  assert.equal(readDisclaimerDismissed('upload', storage), false)
  assert.equal(readDisclaimerDismissed('download', storage), false)
})

test('disclaimer: 写入后读回 true，且只影响对应操作（分开记）', () => {
  const storage = mockStorage()
  writeDisclaimerDismissed('upload', storage)
  assert.equal(readDisclaimerDismissed('upload', storage), true, 'upload 已勾选 → 不再提示')
  assert.equal(readDisclaimerDismissed('download', storage), false, 'download 未勾选 → 仍提示')
  assert.equal(readDisclaimerDismissed('install', storage), false, 'install 未勾选 → 仍提示')
})

test('disclaimer: 存储抛异常（隐私模式）时读写静默降级不抛错', () => {
  const broken: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('SecurityError') },
  }
  assert.equal(readDisclaimerDismissed('upload', broken), false, 'getItem 异常 → false（仍提示）')
  assert.doesNotThrow(() => writeDisclaimerDismissed('upload', broken), 'setItem 异常 → 静默忽略')
})

test('disclaimer: 值非 "1"（脏数据/旧格式）视为未勾选', () => {
  const storage = mockStorage()
  storage.setItem(disclaimerStorageKey('download'), 'yes')
  assert.equal(readDisclaimerDismissed('download', storage), false)
})

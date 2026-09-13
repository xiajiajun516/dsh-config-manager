/**
 * 护栏：client 半的构建产物 `lib/client.js` 必须**自包含**。
 *
 * 为什么需要这条护栏
 * ------------------
 * DSH 的 client loader 只取这一个 `lib/client.js`，不会去解析额外的模块。因此任何被
 * **外置**（externalize）的 import 都会在运行时变成 `require("<pkg>")`，而该 pkg 在宿主
 * 的 module table 里不存在 → 加载即崩。`lucide-react` / `@radix-ui/*` 正是靠
 * `tsdown.config.ts` 的 `deps.alwaysBundle` 被内联进来，才让单文件 bundle 成立。
 *
 * 该不变量此前只存在于构建配置的注释里，没有任何测试兜底：一旦 `alwaysBundle` 正则被改坏
 * （或依赖被误移回 external），产物会静默地重新出现 `require("lucide-react")`，直到用户
 * 端加载崩掉才暴露。本测试把这条不变量钉死。
 *
 * 允许 require 的只有 DSH client runtime 自己提供的四个模块（白名单见
 * `src/utils/bundle-scan.ts`）。
 *
 * 前置条件：需要先 `npm run build`（或 `npm run bundle`）产出 `lib/client.js`。
 * 产物不存在时本测试**跳过并说明**，而不是假装通过——CI 在 build 之后单独跑它（见
 * `.github/workflows/ci.yml` / `publish.yml` 的 “Bundle self-contained guard” 步骤）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLIENT_BUNDLE_RUNTIME_WHITELIST,
  scanBundleRequires,
} from '../utils/bundle-scan.ts'

const BUNDLE_PATH = resolve(import.meta.dirname, '..', '..', 'lib', 'client.js')

test('lib/client.js 自包含：只 require 运行时白名单内的外部包', (t) => {
  if (!existsSync(BUNDLE_PATH)) {
    t.diagnostic(
      `未找到 ${BUNDLE_PATH}（lib/ 已被 gitignore）。请先 npm run build；本测试在产物存在时才有判定力。`,
    )
    return
  }

  const source = readFileSync(BUNDLE_PATH, 'utf8')
  const result = scanBundleRequires(source)

  // 每一趟都必须真的剥掉了注释（否则说明扫描器失效，判定没有意义）。
  for (const pass of result.passes) {
    assert.ok(
      pass.strippedLength > 0 && pass.strippedLength < source.length,
      `扫描趟 ${pass.id} 剥注释后长度应小于原文（bundle 必然带注释/banner）`,
    )
  }

  // 各趟一致性：不一致说明 bundle 里存在让状态机失衡的解析歧义。
  // 此处不直接失败（并集已保证不漏报），但作为诊断信号上报，便于发现新的歧义源。
  t.diagnostic(
    `各趟 require 集合一致：${result.passesAgree}` +
      (result.passesAgree
        ? ''
        : `（不一致：${result.passes.map((p) => `${p.id}=[${p.specifiers.join('|')}]`).join(' ')}）`),
  )

  // 动态 require 无法静态判定，出现即说明构建配置被改坏，直接失败。
  assert.deepEqual(
    result.dynamicHits.map((h) => `line ${h.line}: require(${h.specifier})`),
    [],
    'client bundle 不应存在非字面量的 require() 调用',
  )

  assert.deepEqual(
    result.violations,
    [],
    `lib/client.js 外置了非白名单依赖：${result.violations.join(', ')}\n` +
      `白名单：${CLIENT_BUNDLE_RUNTIME_WHITELIST.join(', ')}\n` +
      `修复方向：把该依赖加回 tsdown.config.ts 的 deps.alwaysBundle（并保留在 devDependencies）。`,
  )

  // node:* 内置模块不属于本护栏判定范围（浏览器半不应依赖它们，但那是另一条不变量）。
  if (result.nodeBuiltins.length > 0) {
    t.diagnostic(`注意：bundle 内出现 Node 内置 require：${result.nodeBuiltins.join(', ')}`)
  }

  t.diagnostic(
    `lib/client.js 的 require 说明符：${result.specifiers.join(', ')}` +
      `（各趟计数 ${JSON.stringify(result.passes.map((p) => [p.id, p.counts]))}）`,
  )
})

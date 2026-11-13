/**
 * 档案侧的同步文件读取 / 文件名清洗（host 专用，唯一实现）。
 *
 * 为什么不并进 `dsh-profile-shared.ts`：那个模块被**浏览器半**import
 * （`src/client/run-store.ts`、`src/client/api.ts`、`src/client/profiles/ProfilesPanel.tsx`、
 * `src/ui/dsh-profiles-view.ts`），必须保持零依赖；本模块用 `node:fs` 的 `readFileSync`
 * （档案数量级为个位数，同步读最简单），并进去就会把 node: 依赖打进 client bundle。
 *
 * 此前 `dsh-profile-manager.ts` / `dsh-profile-runtime.ts` / `dsh-profile-launcher.ts`
 * 各有一份 `readTextSafe`（runtime 与 launcher 逐字相同）、`sanitizeFileName` 与
 * `sanitizeFilePart`（同一正则）。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * 读文本文件；不可读返回 **null** —— 语义差异由调用方显式表达（**不得把 null 统一成 ''**）：
 *  - 档案管理器用 null 参与「该档案没有清单 → 视为非 DSH profile」的判定；
 *  - 运行时 / 启动器用 `readTextSafe(p) ?? ''`，靠 `JSON.parse('')` 抛错来「忽略这条记录」。
 */
export function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 文件名片段清洗（profile 名已过校验；这里只是防意外字符）。 */
export function sanitizeFilePart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * 运行心跳文件名（**唯一实现**）—— 可读前缀 + 名字哈希。
 *
 * 为什么必须带哈希（审计 P11-2 P1，2026-11-13 实测）：心跳文件此前叫
 * `<sanitizeFilePart(name)>.json`，而清洗是**多对一**的 —— `web` 与 `web!` 都落到
 * `web.json`，于是两个实例共享同一个心跳文件：后写的覆盖先写的，`listActive()` 只看得到
 * 一个，`stopExternal` 可能停错人，`withdraw()` 也会删掉别人的心跳（对方从此「不可见」，
 * 界面上又能被重复启动 —— 正是这套机制要防的事）。
 *
 * 判据：清洗只用于可读性（截断到 48 字符、去掉结尾的点/空格，Windows 会吃掉结尾点），
 * **唯一性由 sha256(原名) 的前 12 hex 保证**；\0 之类不可达字符也天然被哈希区隔。
 */
export function runtimeFileName(name: string): string {
  const readable = sanitizeFilePart(name).replace(/[. ]+$/, '').slice(0, 48)
  const digest = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12)
  return readable === '' ? `${digest}.json` : `${readable}-${digest}.json`
}

/**
 * 旧版心跳文件名（升级清理专用）：`<sanitizeFilePart(name)>.json`。
 *
 * 只用于「自报/自撤时顺手删掉自己那份旧文件」—— 否则升级后同一个 profile 会留下两份心跳，
 * `listActive` 对同名记录会看到两条。绝不用于读别人的记录。
 */
export function legacyRuntimeFileName(name: string): string {
  return `${sanitizeFilePart(name)}.json`
}

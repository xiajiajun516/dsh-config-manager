/**
 * DSH 右侧栏槽位在本仓库的**类型镜像**（只声明我们真的用的那两位：正文位 + 芯片位）。
 *
 * 为什么需要镜像：`ctx.slots.register({ name })` 的 name 必须落在 ui-slots 的 `SlotMap` 里，
 * 而本仓库的依赖里没有 `@deepseek-ai/dsh-client-ui-sidebar-right`（与 chat-slots.ts 同一处境）。
 *
 * 镜像来源（逐条核过真机 app.asar 0.2.0-rc.2 的 ui-sidebar-right/client.js）：
 *  · 正文位 = `sidebar.right.pane.tab`，**keyed / session** 位，key = tab 类型的**实现 id**
 *    （自带的文本预览注册 key 就是它的包名；我们的是 `config-manager.rollback-diff`）；
 *  · 每个正文组件由 seat 注入 `useTabInfo()`（给出 `tab.contentId` = 打开时用的资源地址），
 *    这正是「同一个文件开两个标签各看各的」的依据 —— 我们**不**用全局变量记目标；
 *  · 芯片位 = `sidebar.right.pane.tab.title`（同样是 keyed / session，key 同正文位：
 *    宿主的 tab 类型定义**没有 icon 字段** —— 芯片只由 title 文字画出来，所以「文件名前面那颗
 *    文件类型图标」只能由这个位子自己画，见 `rollback-diff-tab.ts` 与 `RollbackDiffTabTitle`）；
 *  · 旧版 DSH（0.1.x）没有这些槽位 ⇒ 装配点做形态探测后**不注册**（只丢对应的那一件事）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * 右侧栏一个 pane 的 tab 正文位（keyed / session scope）。
     * 本插件只注册自己的实现 id：`config-manager.rollback-diff`。
     */
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      keyProps: {
        'config-manager.rollback-diff': {
          /** 侧栏 seat 注入的 tab 信息钩子（资源地址在这里；拿不到时如实说读不出来）。 */
          useTabInfo?: () => { tab?: { contentId?: unknown } }
        }
      }
      owner: {
        /** 该位由 seat 组合出来的通用 props（我们只读 tab 信息钩子）。 */
        useTabInfo?: () => { tab?: { contentId?: unknown } }
      }
    }

    /**
     * 右侧栏一个 pane 的 tab **芯片**位（keyed / session scope，key 同正文位）。
     * 芯片内容 = 我们画的「文件类型图标 + 文件名」；宿主自己的标题文字是它的兜底形态。
     */
    'sidebar.right.pane.tab.title': {
      kind: 'keyed'
      scope: 'session'
      keyProps: {
        'config-manager.rollback-diff': {
          /** seat 注入的 tab 信息钩子（芯片要读标题与资源地址）。 */
          useTabInfo?: () => { tab?: { title?: unknown; contentId?: unknown } }
        }
      }
      owner: {
        /** 该位由 seat 组合出来的通用 props（我们只读 tab 信息钩子）。 */
        useTabInfo?: () => { tab?: { title?: unknown; contentId?: unknown } }
      }
    }
  }
}

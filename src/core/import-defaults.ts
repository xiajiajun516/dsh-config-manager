/**
 * 导入执行策略的**唯一缺省**（IE-02）。
 *
 * 为什么单独一个零依赖模块：这个缺省必须被四处引用 —— 引擎 `src/core/importer.ts`、
 * HTTP 路由 `src/routes/import.ts`、UI 向导 `src/ui/import-wizard.ts`、同步通道
 * `src/sync/sync-engine.ts`。而 `src/ui/import-wizard.ts` 会被 `src/client/run-store.ts`
 * 作为**值**导入并打进浏览器 bundle，所以它不能从 `src/core/importer.ts` 取这个值
 * （那条路径经 Analyzer 拖进 node 内建与 ZIP 依赖）。本文件零依赖，两端都能安全引入。
 *
 * 语义：任一计划项失败立即整体回滚（安全侧，也就是 UI 文案「失败时整体回滚（推荐）」）。
 * 要「单项失败如实记录并继续其余项」必须显式传 `false`，不再靠各入口各写一份缺省。
 */
export const DEFAULT_ROLLBACK_ON_ERROR = true;

/**
 * adapters 域（src/adapters/**）的追加消息目录（zh 源 / en 镜像），归 t6 作用域。
 *
 * 为什么不在 \`src/core/messages.ts\` 追加：该文件不在本作用域的 inScope 内，且既有 372 键有冻结指纹。
 * 本模块经 \`registerMessageCatalog\` 注册**追加目录**：engineMsg / makeMsg 的查找顺序是
 * 「既有目录 → en 下回退既有 zh → 注册目录 → 键名」，所以本域新键只在既有目录未命中时生效，
 * 不可能遮蔽 core 的既有 adapter.* 键。
 *
 * 纪律：zh 值 = 改动前的既有中文文案**逐字原样**；en 为 \`Record<keyof typeof zh, string>\`（缺键即编译错）。
 * **导入本模块即完成注册**：本域消费面是注入的 ctx.msg（MsgFunc）与 engineMsg，两者都查注册目录。
 */
import { engineMsg as engineMsgOf, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgFunc } from '../core/msg-types.ts';

export const zh = {
  // ---------- 链接 / 依赖目录报告（issue #37 / #76）----------
  'adapter.linkDirEntry': '{path}（{files}）',
  'adapter.linkSkipLine': '{reason} {count} 个: {paths}{more}',
  'adapter.listSeparator': '；',
  // ---------- pluginFiles / tarball ----------
  'adapter.pluginFilesCollectDirInvalid': 'pluginFiles collectDir 非法（须为相对 ~/.dsh 根的安全路径）: {dir}',
  'adapter.tarballRelPathInvalid': '非法 tarball 相对路径: {path}',
  'adapter.localTarballUnpackFailed': '本地插件 {name} 的 tarball 解包失败，回退原始 spec：{err}',
  // ---------- prompts 计划项明细 ----------
  'adapter.promptDiffDetail': '行 {line} current={current} imported={imported}',
  // ---------- 会话连带失败明细 ----------
  'adapter.sessionUncoupledNote': '{id}（{reason}）',
  // ---------- 工作区告警拼接 ----------
  'adapter.workspaceNotesParen': '（{notes}）',
  // ---------- localStorage 等 Host 无通道的 UI 状态说明 ----------
  'adapter.uiLocalStorageTaskBoard': '任务看板数据存于浏览器 localStorage，Host 侧无访问通道，需在目标机器重新配置',
  'adapter.uiLocalStoragePanel': '面板宽度/折叠状态存于浏览器 localStorage，Host 侧无访问通道，需在目标机器重新配置',
  'adapter.uiLocalStorageGeneric': '浏览器端 UI 状态无法经 Host API 迁移',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'adapter.linkDirEntry': '{path} ({files})',
  'adapter.linkSkipLine': '{reason} {count} item(s): {paths}{more}',
  'adapter.listSeparator': '; ',
  'adapter.pluginFilesCollectDirInvalid': 'pluginFiles collectDir is invalid (must be a safe path relative to the ~/.dsh root): {dir}',
  'adapter.tarballRelPathInvalid': 'Invalid relative tarball path: {path}',
  'adapter.localTarballUnpackFailed': 'Failed to unpack the tarball of local plugin {name}; falling back to the original spec: {err}',
  'adapter.promptDiffDetail': 'line {line} current={current} imported={imported}',
  'adapter.sessionUncoupledNote': '{id} ({reason})',
  'adapter.workspaceNotesParen': ' ({notes})',
  'adapter.uiLocalStorageTaskBoard': 'Task-board data lives in the browser localStorage and the host has no access path; reconfigure it on the target machine',
  'adapter.uiLocalStoragePanel': 'Panel width/collapsed state lives in the browser localStorage and the host has no access path; reconfigure it on the target machine',
  'adapter.uiLocalStorageGeneric': 'Browser-side UI state cannot be migrated through the host API',
};

registerMessageCatalog({ id: 'adapters-domain', zh, en });

/** 本域活翻译器（与 core 的 engineMsg 同一实现；导入本模块即完成目录注册）。 */
export const engineMsg: MsgFunc = engineMsgOf;

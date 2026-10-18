/**
 * GitHub Gist 通道（批次3 Q2）的模块内双语消息目录（zh 源 / en 镜像）。
 * 与 \`src/sync/s3/messages.ts\` 同一套纪律与同一份工厂（\`makeCatalogMsg\`）：
 * 键先落在这里（写作用域不含 \`src/core/messages.ts\`），汇报里按同一张表交给字典拥有者并入。
 * 纪律：用户可见字符串不得硬编码在通道实现里；token 值永不进消息。
 */
import { makeCatalogMsg } from '../s3/messages.ts';
import type { MsgFunc } from '../../core/msg-types.ts';

export const gistZh = {
  'sync.gist.gistIdRequired': 'gistId 必须是非空字符串（在 GitHub 上新建一个（私密）gist 后填入其 id）',
  'sync.gist.gistIdInvalid': 'gistId 不合法: {id}（GitHub gist id 是十六进制串）',
  'sync.gist.apiBaseUrlInvalid': '无法解析 GitHub API 根地址（必须是合法 http(s) URL，且不含用户名/密码）: {url}',
  'sync.gist.tokenRequired': 'credentials 必须提供 getToken()',
  'sync.gist.filePrefixInvalid': 'gist 文件名前缀不合法: {prefix}（不得为空、不得含斜杠或 ..）',
  'sync.gist.invalidSnapshotId': '非法快照 id: {id}（仅允许字母数字开头，字符限 . _ -）',
  'sync.gist.gistMissing': 'Gist {id} 不存在或当前令牌无权访问（HTTP {status}）',
  'sync.gist.fileMissing': 'Gist 里缺少快照文件 {file}（可能被手工删除）',
  'sync.gist.contentTruncated': 'Gist 文件 {file} 内容被截断，raw 下载也失败: {err}',
  'sync.gist.rawFetchFailed': '下载 gist 文件原文失败（{url}，HTTP {status}）',
  'sync.gist.tooManyRedirects': '{url} 重定向超过 {n} 次上限，疑似跳转循环',
  'sync.gist.requestFailed': '{method} {url} 失败 (HTTP {status}): {err}',
  'sync.gist.requestError': '{method} {url} 请求出错: {err}',
  'sync.gist.timeout': '{method} {url} 请求超时（{timeout}ms）',
  'sync.gist.indexInvalid': '{url} 解析失败或结构非法: {err}',
  'sync.gist.snapshotInvalid': '快照 {id} 解析失败或结构非法: {err}',
  // ---- cloud-sync 借鉴项 ①②③：条件写 / 探针 / 归属提示 ----
  'sync.gist.concurrentWrite': 'Gist 已被其它设备更新（PATCH 冲突，HTTP {status}）：本次写入已中止，请重新同步后再试',
  'sync.gist.probeOk': '连接正常（Gist 可读写，远端 {count} 份快照）',
  'sync.gist.probeForeignContent': '该 Gist 里已有 {count} 个不属于本插件的文件：请确认这是你的同步专用 Gist（前缀 {prefix}），否则可能覆盖别人的数据',
} as const;

export const gistEn: Record<keyof typeof gistZh, string> = {
  'sync.gist.gistIdRequired': 'gistId must be a non-empty string (create a (secret) gist on GitHub and paste its id)',
  'sync.gist.gistIdInvalid': 'Invalid gistId: {id} (a GitHub gist id is a hexadecimal string)',
  'sync.gist.apiBaseUrlInvalid': 'Cannot parse the GitHub API base URL (must be a valid http(s) URL without username/password): {url}',
  'sync.gist.tokenRequired': 'credentials must provide getToken()',
  'sync.gist.filePrefixInvalid': 'Invalid gist file name prefix: {prefix} (must not be empty or contain slashes or ..)',
  'sync.gist.invalidSnapshotId': 'Invalid snapshot id: {id} (must start alphanumeric; only . _ - allowed)',
  'sync.gist.gistMissing': 'Gist {id} does not exist or the current token cannot access it (HTTP {status})',
  'sync.gist.fileMissing': 'The gist is missing snapshot file {file} (it may have been deleted manually)',
  'sync.gist.contentTruncated': 'Gist file {file} is truncated and the raw download also failed: {err}',
  'sync.gist.rawFetchFailed': 'Failed to download the raw gist file ({url}, HTTP {status})',
  'sync.gist.tooManyRedirects': '{url} exceeded {n} redirects, possible redirect loop',
  'sync.gist.requestFailed': '{method} {url} failed (HTTP {status}): {err}',
  'sync.gist.requestError': '{method} {url} request error: {err}',
  'sync.gist.timeout': '{method} {url} request timed out ({timeout}ms)',
  'sync.gist.indexInvalid': '{url} failed to parse or is structurally invalid: {err}',
  'sync.gist.snapshotInvalid': 'Snapshot {id} failed to parse or is structurally invalid: {err}',
  'sync.gist.concurrentWrite': 'The gist was updated by another device (PATCH conflict, HTTP {status}): this write was aborted, please sync again',
  'sync.gist.probeOk': 'Connection OK (gist readable and writable, {count} remote snapshots)',
  'sync.gist.probeForeignContent': 'This gist already contains {count} files that are not ours: confirm it is your dedicated sync gist (prefix {prefix}) or you may overwrite someone else’s data',
};

/** 缺省（zh）Gist 通道翻译器。 */
export const gistMsg: MsgFunc = makeCatalogMsg(gistZh, gistEn, 'zh');

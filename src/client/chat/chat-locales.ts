/**
 * 聊天内「↺ 回退」入口（config-manager-chat）的独立字典：zh 为源语言，en 镜像每个键。
 * 独立命名空间、独立文件：不触碰共享的 locales.ts，也不与 recovery 字典混住。
 *
 * `ChatKey` 由 client/index.ts 在 ctx.locale.register 处做编译期校验（漏键/多键即编译失败）。
 *
 * 键域纪律（**为什么这本字典刻意只有几行**）：
 *  - 与设置页同一批 `rollback.*` 词汇（三选一 mode / code / outcome / segment / 预览计数 /
 *    结果行）由 **config-manager-recovery** 字典单一所有（T2 产出）。组件同时拿到
 *    `t`（本字典）与 `rt`（recovery 字典）：两个入口说同一句话，改一处两边一起变，
 *    这里**不复制**那些键值（复制即两处真相）。
 *  - 本文件只写「聊天入口独有」的话：回合尾按钮、该回合还没有回滚点、子会话打开与降级。
 *
 * ⚠️ 新增本字典 = 新增一本目录，必须由 captain 登记进 i18n 守卫的归属清单
 * （`tests/helpers/i18n-scan.ts` 的 KNOWN_CATALOG_FILES + `tests/i18n-hardcoded-guard.test.ts`
 * S11 的 knownFiles 与 `all.length` 计数），否则 `node --test tests/i18n-hardcoded-guard.test.ts`
 * 会把本文件里的 zh 串判成硬编码缺陷（A1）。本任务的写作用域不含 tests/**，故登记动作归 captain。
 */

export const zh = {
  /** 回合尾按钮的可见文案（图标 ↺ 由组件渲染，文案不进图标） */
  'chat.entry.label': '回退',
  /** 该回合还没有回滚点（留点发生在回合结束时） */
  'chat.entry.noPoint': '这个回合还没有回滚点',
  /** 打开对话框后先读台账 + 只读预览（零写入） */
  'chat.entry.loading': '正在读取回滚点与该回合的只读预览…',
  /** 子会话行的动作按钮 */
  'chat.open.child': '打开子会话',
  /** 自动打开的进行态 */
  'chat.open.opening': '正在打开子会话…',
  /** 降级①（T9-F1）：**有**导航入口，但重拉列表后仍没有它 —— 这句话被证实过，不假装已打开 */
  'chat.open.degraded': '子会话 {id} 还没有出现在会话列表里，自动打开没有成功：请手动打开它（如实降级，不假装已打开）',
  /** 降级②（T9-F1）：**有**入口、列表里也有（或列表读不出来），但这次导航调用失败 —— 与①是两个原因 */
  'chat.open.failed': '会话导航调用失败，子会话 {id} 没有自动打开（子会话已创建）：请手动打开它',
  /** 降级③（T9-F1）：**本客户端没有可用的会话导航入口**（DSH 版本不提供）；绝不能说成「还没出现在列表里」 */
  'chat.open.unavailable': '本客户端没有可用的会话导航入口（当前 DSH 版本不提供），所以没有自动打开：子会话 {id} 已创建，请手动打开它',
  /** 不可回退但宿主没给原因键时的兜底（T9-F3）：说「原因未知」，**不得**说成「没有可回退的内容」 */
  'chat.preview.reasonUnknown': '这个回滚点当前不可回退，但宿主没有给出原因（原因未知）',
  /** 回退请求在途 */
  'chat.rewind.running': '正在回退…',
  /** 关闭对话框（Modal.Header 的 closeLabel 必须是已翻译文案） */
  'chat.close': '关闭',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'chat.entry.label': 'Rewind',
  'chat.entry.noPoint': 'This turn has no rollback point yet',
  'chat.entry.loading': 'Reading the rollback points and this turn\u2019s read-only preview\u2026',
  'chat.open.child': 'Open child session',
  'chat.open.opening': 'Opening the child session\u2026',
  'chat.open.degraded': 'Child session {id} is not in the session list yet, so the automatic open did not succeed: open it manually (an honest downgrade, not a claimed success)',
  'chat.open.failed': 'The session navigation call failed, so child session {id} was not opened automatically (the child session does exist): open it manually',
  'chat.open.unavailable': 'This client exposes no usable session navigation entry (the installed DSH version does not provide one), so nothing was opened automatically: child session {id} exists, open it manually',
  'chat.preview.reasonUnknown': 'This rollback point cannot be restored right now, but the host gave no reason (cause unknown)',
  'chat.rewind.running': 'Rewinding\u2026',
  'chat.close': 'Close',
};

export type ChatKey = keyof typeof zh;

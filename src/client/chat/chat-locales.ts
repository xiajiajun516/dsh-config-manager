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
  /**
   * 回退入口的**无障碍文案**（2026-10-10 起屏幕上只有图标、没有文字标签；
   * 这颗按钮的 aria-label/title 用它，「回退按钮只有一个 icon」不等于「按钮没有名字」）。
   */
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
  /** 预览对话框的说明行（Cursor「Confirm Undo」风格的第二张截图：一句话说清这次动作会做什么） */
  'chat.preview.summary': '这次回退会做以下改动：',
  /**
   * 顶部选择框（用户 2026-10-12 第 1 条）：要不要**连文件一起**退回去。
   * 勾 = 文件 + 对话一起退（默认）；取消 = 只退对话，工作区一个字节都不动。
   */
  'chat.preview.revertFiles': '回退文件的更改',
  /**
   * 顶部**汇总**（2026-10-12 第二轮）：这一屏的第一决策信息 —— 用户先判规模，再逐行核文件。
   * 三个数字的口径与「文件行」逐条一致（同一份 `rollbackPreviewScope`）：
   *  `{n}` 个文件 = 会被改动的文件数；`+A`/`−D` **只累加两侧都可信的行数**
   *  （任一侧读不出来的文件两列都不计 —— 被计成 0 就是一个会被证伪的断言）；
   *  删除集是**另一条**清单（`{n} 项删除`），单独计数、不与上面混加。
   * 注意：这不是「chat.preview.summary」那句话（那句描述性文案按 DESIGN §7 已下线，且被源级守卫钉住）；
   * 这里是**数字**，数字留、句子走。
   */
  'chat.preview.scope.files': '{n} 个文件',
  'chat.preview.scope.added': '+{n}',
  'chat.preview.scope.removed': '−{n}',
  'chat.preview.scope.deleted': '{n} 项删除',
  /** 取消勾选（只退对话）时的汇总：数字与用户无关，改写一句「文件不动」；清单仍在下面、且不再变半透明 */
  'chat.preview.scope.off': '只回退对话，文件不改动',
  /** 文件行上悬停出现的「查看」（在看得到的前提下才出现：没有侧栏能力时换成下面那句） */
  'chat.preview.view': '查看',
  /** 「查看」= 名字本身：无障碍名必须带**这个文件**的全路径（列表里同名按钮一屏好几个） */
  'chat.preview.viewHint': '查看差异：{path}',
  /** 没有右侧栏能力（旧 DSH / 侧栏服务缺失）→ 如实降级为弹窗内展示，不假装打开过 */
  'chat.preview.viewInline': '本客户端没有右侧栏，差异改为在这里展示',
  'chat.preview.viewFailed': '打开右侧栏失败：{detail}',
  /** 回退请求在途 */
  'chat.rewind.running': '正在回退…',
  /**
   * 简洁版预览对话框的**主按钮**文案（用户 2026-10-10：底部只有主按钮「回退」与「取消」）。
   * 与设置页回滚卡的 `rollback.rewind`（'回退到此处'）刻意分开：聊天入口的语境是
   * 「回到这条消息之前」，按钮只写「回退」——同一句话在两张卡上不再被两个语境共用。
   */
  'chat.rewind.submit': '回退',
  /** 关闭对话框（Modal.Header 的 closeLabel 必须是已翻译文案） */
  'chat.close': '关闭',
  /* —— T1：每条用户消息一个入口（接管 conversation.chat.node 的 user key）—— */
  /** 复制动作（与 native 复制的 aria-label 同义） */
  'chat.entry.copy': '复制这条消息',
  /** 复制成功的 1 秒反馈 */
  'chat.entry.copied': '已复制',
  /** content 里我们无法理解的块（宿主叫「附加内容块」；这里必须原样兜底上屏，不得静默丢弃） */
  'chat.entry.extraBlock': '附加内容块',
  /** 兜底块过长时的截断说明（{total} = 原始字符数） */
  'chat.entry.truncated': '已截断，共 {total} 字符',
  /** owner 没给图片渲染位（宿主版本差异）：图片我们绝不自己渲染，如实说 */
  'chat.entry.noImageRenderer': '宿主没有提供图片渲染位，这条消息里的图片无法显示',
  /** 引用会话汇总行（宿主 ui-chat 的 message.referenceSummary，逐字同义；★ 非 ui-primitives 依赖） */
  'chat.entry.referenceSummary': '引用会话 · {labels}',
  /** 汇总行里多个 label 之间的分隔符（宿主 message.referenceSeparator：zh 用顿号、en 用逗号空格） */
  'chat.entry.referenceSeparator': '、',
  /** 禁用①：节点里取不到可核实的回合号（与宿主同一条读法：location.kind 必须是 turn/step） */
  'chat.entry.disabled.noTurn': '取不到可核实的回合号（当前 DSH 版本未提供），无法在聊天里回退',
  /** 禁用②：回合还在进行中 —— 真的还没到留点那一刻 */
  'chat.entry.disabled.turnOpen': '这个回合还没结束，还没有回滚点',
  /** 禁用③：缺少 sessionId，无法按「同会话」匹配 */
  'chat.entry.disabled.noSession': '取不到会话标识，无法匹配回滚点',
  /**
   * 禁用④：还没读到，或**收尾后的有界重试窗口还开着**（列表读到空只是暂态 —— 引擎在收尾后
   * 还要几秒才写完点，真机 7.8 s）。窗口内**不得**说「没有回滚点」，所以这里如实说「正在读取」。
   */
  'chat.entry.disabled.pointsPending': '正在读取回滚点…',
  /** 禁用⑤：已读到列表、确实没有「同会话 + 同回合」的点 */
  'chat.entry.disabled.noPoint': '这个回合还没有回滚点',
  /** 禁用⑥：收尾状态既不是 closed 也不是 open（读不到 / unknown）——不能证明已收尾，也不说成没结束 */
  'chat.entry.disabled.turnUnknown': '这个回合的收尾状态未知，暂不可回退',
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
  'chat.preview.summary': 'Confirming this undo will make the following changes:',
  'chat.preview.revertFiles': 'Revert file changes',
  'chat.preview.scope.files': '{n} files',
  'chat.preview.scope.added': '+{n}',
  'chat.preview.scope.removed': '\u2212{n}',
  'chat.preview.scope.deleted': '{n} to delete',
  'chat.preview.scope.off': 'Session only \u2014 files stay as they are',
  'chat.preview.view': 'View diff',
  'chat.preview.viewHint': 'View diff: {path}',
  'chat.preview.viewInline': 'This client has no right sidebar, so the diff is shown here instead',
  'chat.preview.viewFailed': 'Could not open the right sidebar: {detail}',
  'chat.rewind.running': 'Rewinding\u2026',
  'chat.rewind.submit': 'Rewind',
  'chat.close': 'Close',
  'chat.entry.copy': 'Copy this message',
  'chat.entry.copied': 'Copied',
  'chat.entry.extraBlock': 'Extra content block',
  'chat.entry.truncated': 'truncated, {total} characters total',
  'chat.entry.noImageRenderer': 'The host exposes no image render seat, so images in this message cannot be shown',
  'chat.entry.referenceSummary': 'Referenced session \u00b7 {labels}',
  'chat.entry.referenceSeparator': ', ',
  'chat.entry.disabled.noTurn': 'No verifiable turn number is available (the installed DSH version does not provide one), so rewinding from the chat is unavailable',
  'chat.entry.disabled.turnOpen': 'This turn has not finished yet, so no rollback point exists',
  'chat.entry.disabled.noSession': 'No session identity is available, so rollback points cannot be matched',
  'chat.entry.disabled.pointsPending': 'Reading the rollback points\u2026',
  'chat.entry.disabled.noPoint': 'This turn has no rollback point yet',
  'chat.entry.disabled.turnUnknown': 'This turn\u2019s closing state is unknown, so rewinding is unavailable for now',
};

export type ChatKey = keyof typeof zh;

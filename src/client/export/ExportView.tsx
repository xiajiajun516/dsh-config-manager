/**
 * 导出页（Export —— Workbench Rebuild 2026-09，绑 src/ui/export-flow.ts 的 ExportFlow 控制器）。
 *
 * 布局（564px 画布，致密单列；UI-26：旧描述里的「快速/自定义模式分段」与「预览弹窗」都不存在了）：
 *   1. 工具栏：「选择要导出的内容」（ghost）+「开始导出」（primary）+ 一行模式提示
 *   2. 安全选项（分组标题）：加密备份 / 导出密钥 复选 +（加密时）密码双列内联
 *   3. 命名行（分组标题）：自定义文件名 + 备注 双列（各带常驻规则提示）
 *   4. 进度条 / 结果报告 + 自动下载提示
 *   5. 页尾「本次将导出」构成卡（Card.fillViewport + .compositionViewport 内滚；
 *      承担 DESIGN.md 的 Canvas 纪律，数字与选择器 footer 同源）
 *   6. 内容选择弹窗（Modal wide + ContentPicker）：分区 → 最小可拆单元
 *
 * 业务能力：
 * - 默认勾选 = 推荐分区（ExportFlow.quickSelection()，可迁移、非设备专属），之后由内容选择器调整；
 * - 选择器按分区 / 逐条目调整（设备相关 / 敏感分区以内联徽章 + 页内警示标注）；
 * - 安全选项：加密备份（AES-256-GCM）与导出密钥两个独立选项；勾选导出密钥自动联动
 *   勾选加密（密钥绝不明文），取消加密一并取消导出密钥（includeSecrets ⇒ encrypt）；
 * - 自定义文件名（失焦自动补全 .zip；合法性校验与宿主一致）+ 备注；
 * - 内容清单经 export-preview 端点只读拉取（零写入；逐分区惰性缓存，页面挂载即按当前勾选预热）；
 * - 密码仅内存（api.exportPassword 随请求体传输，绝不落盘/入 sessionStorage）；
 * - 导出完成自动下载到浏览器「下载」目录（可再手动下载）。
 *
 * m2：全部 UI 状态由模块级 runStore 持有（切页/关面板不重建、刷新恢复），
 * 控制器实例（ExportFlow）由 store 缓存复用。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import { normalizeExportFileName } from '../../ui/export-flow.ts'
import {
  buildExportRequest, pickerSummary, type Selection, type SelectionSection,
} from '../../ui/selection-model.ts'
import { formatBytes } from '../../ui/report.ts'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { resolveFailedSections } from '../api.ts'
import type { ConfigManagerApi, ExportPreviewResponse } from '../api.ts'
import { runStore } from '../run-store.ts'
import { Banner, Button, Card, Checkbox, Spinner } from '../common/ui.tsx'
import { ContentPicker } from '../common/ContentPicker.tsx'
import { SectionComposition } from '../common/SectionComposition.tsx'
import { sectionLabel, sectionLabeler } from '../common/section-labels.ts'
import { Modal } from '../common/Modal.tsx'
import { PreviewIcon } from '../common/Icon.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { ProgressBar } from '../common/ProgressBar.tsx'
import { ReportView } from '../common/ReportView.tsx'
import { toast } from '../common/toast-store.ts'
import css from '../config-manager.module.css'

export interface ExportViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

/**
 * 导出页：Quick/Custom 切换 → 勾选/密码 → 执行 → 进度 → 报告 → 自动下载。
 */
export function ExportView({ api, t }: ExportViewProps) {
  // m2：状态统一来自模块级 store（sessionStorage 持久化；切页不重建）
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const exp = state.export
  // 控制器实例由 store 缓存复用（切页 / 关面板不重建）
  const flow = runStore.exportFlow(api)

  const selection = exp.selection
  /** Phase 1：被排除的最小可拆单元 id（稀疏 —— 默认全选） */
  const excludedUnits = exp.excludedUnits
  const includeSecrets = exp.includeSecrets
  const encrypt = exp.encrypt
  /** P0-④：自定义导出文件名（.zip；空 = 宿主自动命名；仅表单非敏感字段） */
  const fileName = exp.fileName
  /** P0-④：导出备注（写入备份列表显示；非敏感） */
  const note = exp.note
  // 密码字段仅内存（store 的敏感字段，绝不序列化进 sessionStorage）
  const password = exp.password
  const passwordConfirm = exp.passwordConfirm
  const running = exp.running
  const progress = exp.progress
  const result = exp.result
  const error = exp.error
  /** 下载进行中（瞬态 UI） */
  const [downloading, setDownloading] = useState(false)
  /** 下载防重入 ref */
  const downloadingRef = useRef(false)
  /** Phase 1：内容选择器（分区 → 最小可拆单元）开关 */
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 已取到的分区条目清单（按分区惰性缓存：打开选择器时不把 sessions 全量读一遍） */
  const [inv, setInv] = useState<Record<string, ExportPreviewResponse['sections'][number]>>({})
  /**
   * 正在读取清单的**分区**列表（逐分区记账，不是一个 boolean）。
   * 用途：用户勾一个新分区时立刻给出遮罩 + 加载动画 —— sessions 这类大分区要读很久，
   * 没有反馈会被当成卡死（用户实测反馈）。
   */
  const [invPending, setInvPending] = useState<SectionId[]>([])
  const invLoading = invPending.length > 0
  const [invError, setInvError] = useState<string | null>(null)
  /**
   * 清单**读取失败**的分区（逐分区记账，不是一个数字）。
   * 用途（UI-07）：失败分区行内标注「读取失败 · 将整体导出」并抑制误导性的「已选 0/0」——
   * 引擎对清单缺失的分区按**整体导出**处理（见 src/ui/selection-model.ts 的 buildExportRequest），
   * 界面必须如实陈述这一点。
   */
  const [invFailed, setInvFailed] = useState<SectionId[]>([])
  /** 正在请求中的分区（防止同一分区被并发重复请求） */
  const invInFlight = useRef<Set<string>>(new Set())

  /** 拉取指定分区的条目清单（已取过的不重复请求）。 */
  const fetchInventory = async (sections: SectionId[]): Promise<void> => {
    const todo = sections.filter((s) => inv[s] === undefined && !invInFlight.current.has(s))
    if (todo.length === 0) return
    for (const s of todo) invInFlight.current.add(s)
    setInvPending((prev) => [...prev, ...todo.filter((s) => !prev.includes(s))])
    try {
      const result = await api.exportPreview(todo)
      setInv((prev) => {
        const next = { ...prev }
        for (const s of result.sections) next[s.section] = s
        return next
      })
      /**
       * 失败分区（t7）：宿主给的**精确清单** `result.failedSections` 优先，缺失时回退到
       * 「请求了但没回来」的推断 —— 解析逻辑在 API 层（`resolveFailedSections`，node 可测），
       * 组件只调用；旧宿主没有该字段时行为与改造前完全一致。
       */
      const failedNow = resolveFailedSections(todo, result)
      setInvFailed((prev) => [...new Set([...prev.filter((s) => !todo.includes(s)), ...failedNow])])
      setInvError(null)
    } catch (err) {
      // 请求整体失败（宿主异常 / 网络中断）：本次在途分区全部计为读取失败（UI-07 的复现路径）
      setInvFailed((prev) => [...new Set([...prev.filter((s) => !todo.includes(s)), ...todo])])
      setInvError(err instanceof Error ? err.message : String(err))
    } finally {
      for (const s of todo) invInFlight.current.delete(s)
      setInvPending((prev) => prev.filter((s) => !todo.includes(s)))
    }
  }

  /**
   * UI-04：页面加载即按**当前勾选**读取清单 —— 主页面的「本次将导出」数据块必须与选择器
   * 合计**同源**（同一个 pickerSummary / 同一份 inv），否则两处数字会对不上。
   * 仍然是逐分区惰性请求：默认勾选里不含 sessions / pluginFiles 这类大分区，
   * 勾选它们时本来也要读（与打开选择器同一条路径，工具栏按钮同步显示 Spinner）。
   * 勾选变化由 applyPicker 负责触发，这里只在挂载时补第一次。
   */
  useEffect(() => {
    void fetchInventory(runStore.getSnapshot().export.selection)
    // 只在挂载时取一次；后续勾选变化由 applyPicker 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 打开选择器：先取「当前已勾选分区」的清单（预设分区的常见路径一次到位）。 */
  const openPicker = (): void => {
    if (running) return
    setPickerOpen(true)
      // 与 pickerValue 同一来源，保证「打开就看到的」=「会导出的」
    void fetchInventory(selection)
  }

  /** 选择模型的分区：目录全量 + 已取到的单元清单（未取到的 units 为空 = 整体开关）。
   *  portability / sensitive 来自分类目录 —— 选择器据此渲染「设备相关 / 敏感」徽章（UI-09）。 */
  const pickerNodes: SelectionSection[] = flow.categories.map((c) => {
    const got = inv[c.id]
    return {
      section: c.id,
      count: got?.count ?? 0,
      sizeBytes: got?.sizeBytes ?? 0,
      units: got?.items ?? [],
      portability: c.portability,
      sensitive: c.sensitive === true,
    }
  })
  /**
   * 选择器展示 / 导出的分区集合 = store 里的 `selection`（**唯一来源**）。
   *
   * 这里曾有一个 `mode === 'quick' ? quickSelection() : selection` 分支：只要停在快速模式，
   * 选择器就**无视**用户勾选 —— 点「全不选」后仍显示默认分区。模式与分支已整体删除：
   * 只有一条导出流程，勾选状态就是唯一事实。
   */
  const pickerValue: Selection = { sections: selection, excluded: excludedUnits }

  /** 本次会导出什么（选择器 → 请求参数）。同时用作「没有任何内容」的守卫。 */
  const exportRequest = buildExportRequest(pickerValue, pickerNodes)
  const nothingSelected = exportRequest.only.length === 0

  /**
   * UI-04：页面底部的「本次将导出」数据块（消灭底部空洞 + 不打开弹窗也能核对）。
   * 合计口径与选择器 footer **同源**（同一个 pickerSummary）；构成行只列真正会导出的分区。
   */
  const composition = pickerNodes.filter((n) => exportRequest.only.includes(n.section))
  const summary = pickerSummary(pickerValue, pickerNodes)
  /**
   * 逐分区的清单读取状态（F-03）：**未读到的分区绝不显示 0 条目 / 0 B**。
   * 引擎对清单缺失的分区按整体导出处理 —— 显示 0 与真实行为语义相反，
   * 合计也会严重低报（实测 only=[settings,sessions] 时 sizeBytes 只算了 settings 的 1000B）。
   */
  const compositionRows = composition.map((n) => {
    const state: 'ready' | 'loading' | 'failed' =
      inv[n.section] !== undefined ? 'ready' : (invFailed.includes(n.section) ? 'failed' : 'loading')
    return { section: n.section, count: n.count, sizeBytes: n.sizeBytes, state }
  })
  /** 未读到清单的分区数（> 0 时合计必须标注「不少于该值」） */
  const unreadCount = compositionRows.filter((r) => r.state !== 'ready').length

  /**
   * UI-09：勾选里是否含「设备相关」分区（sessions / pluginFiles / credentialsStatus）。
   * 走 ExportFlow.validateSelection（结构化结果），文案与分区名在展示层组装 ——
   * 纯逻辑层不再产出中文文案。非阻断：只提示「跨设备导入时可能不适用」。
   */
  const deviceSpecific = flow.validateSelection(selection).deviceSpecific
  const deviceNames = deviceSpecific.map((id) => sectionLabel(id, t)).join('、')
  /** UI-09：设备相关分区的就地警示（非阻断）。**保持单行**（.noticeLine 截断 + title 全文）——
   *  高度确定才能让公告位不抖动（见 .noticeSlot 注释）。 */
  const deviceWarning = deviceSpecific.length > 0
    ? (
      <Banner kind="warn">
        <span className={css.noticeLine} title={`${t('export.selectionWarnings')} ${deviceNames}`}>
          {t('export.selectionWarnings')} {deviceNames}
        </span>
      </Banner>
    )
    : null

  /**
   * 公告位内容（页面与选择器弹窗共用同一个槽位）：
   * 「未勾选」优先，否则显示「设备相关」警示 —— 两者天然互斥（未勾选时 selection 为空，
   * validateSelection 不可能报出设备相关分区），所以槽位内容最多一个，高度恒定。
   */
  const notice = nothingSelected
    ? <Banner kind="warn"><span className={css.noticeLine}>{t('export.nothingSelected')}</span></Banner>
    : deviceWarning

  /** 选择器变更：直接落库（不再有「切换模式」这一步）。 */
  const applyPicker = (next: Selection): void => {
    runStore.patch({ export: { selection: next.sections, excludedUnits: next.excluded } })
    // 新勾选的分区立即取清单，否则它只显示为「不可细分的整体开关」
    void fetchInventory(next.sections)
  }

  const setIncludeSecrets = (next: boolean): void => {
    // 导出密钥联动加密：勾选导出密钥时默认同时选中加密（密钥绝不明文存储）
    runStore.patch({ export: { includeSecrets: next, encrypt: next ? true : exp.encrypt } })
  }
  const setEncrypt = (next: boolean): void => {
    // 取消加密时若仍勾选着导出密钥 → 一并取消（密钥必须以加密形式备份，安全底线）
    runStore.patch({ export: { encrypt: next, includeSecrets: next ? includeSecrets : false } })
  }
  const setPassword = (value: string): void => {
    runStore.patch({ export: { password: value } })
  }
  const setPasswordConfirm = (value: string): void => {
    runStore.patch({ export: { passwordConfirm: value } })
  }
  const setFileName = (value: string): void => {
    runStore.patch({ export: { fileName: value } })
  }
  const setNote = (value: string): void => {
    runStore.patch({ export: { note: value } })
  }

  const passwordInvalid =
    encrypt && (password === '' || password !== passwordConfirm)

  /** 自定义文件名合法性（P0-④）：留空合法（自动命名）；非空必须合法文件名。
   *  提交时经 normalizeExportFileName 自动补全 .zip（host 端 isValidExportFileName 仍兜底）。 */
  const trimmedName = fileName.trim()
  const baseName = trimmedName.replace(/\.zip$/i, '')
  const fileNameInvalid = trimmedName !== '' && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(baseName)

  /** 执行导出（Quick 或 Custom）；成功后自动下载到浏览器「下载」目录 */
  const runExport = async (): Promise<void> => {
    if (passwordInvalid || fileNameInvalid) return
    runStore.patch({
      export: { running: true, error: null, result: null, downloaded: false, progress: null, runId: null },
    })
    // m3：请求进行期间经 /runs 发现 runId 并轮询 /progress（500ms）显示真实进度
    runStore.watchRunning('export', 500)
    try {
      // 加密密码随本次导出请求体传给 Host 半（仅内存）
      api.exportPassword = encrypt ? password : null
      // includeSecrets 只表示「导出密钥」；安全上密钥必须以加密形式备份，
      // UI 联动保证 includeSecrets ⇒ encrypt，这里再兜底一次
      // 只导出「至少勾选了一个单元」的分区（分区勾选但单元全取消 = 不导出），
      // 并对**部分勾选**的分区下发条目白名单。
      const run = await flow.run(exportRequest.only, {
        includeSecrets: includeSecrets && encrypt,
        // P0-④：自定义文件名（trim 后为空 = 自动命名；自动补全 .zip 后缀）+ 备注
        fileName: normalizeExportFileName(fileName),
        note: note.trim(),
        ...(exportRequest.includeItems !== undefined ? { includeItems: exportRequest.includeItems } : {}),
      })
      // ExportResponse 携带 runId（/progress 查询与刷新恢复用）；控制器类型不含，运行时对象有
      const runId = (run as { runId?: unknown }).runId
      runStore.patch({
        export: {
          result: run,
          runId: typeof runId === 'string' ? runId : null,
          progress: { stage: 'done', step: 1, total: 1 },
        },
      })
      {/* 导出完成即自动下载到浏览器「下载」目录 */}
      await download(run.zipPath)
      // 下载是静默的（不弹系统框），用户点完很可能已切走 → 用 Toast 送达回执
      toast.ok(t('export.saved', { name: run.report.file.name }))
    } catch (err) {
      runStore.patch({ export: { error: err instanceof Error ? err.message : String(err) } })
    } finally {
      runStore.stopRunWatch('export')
      runStore.patch({ export: { running: false } })
    }
  }

  /** 把导出的 ZIP 下载到浏览器（默认静默下载；防重入锁共享）。 */
  const download = async (zipPath: string): Promise<void> => {
    if (zipPath === '' || downloadingRef.current) return
    downloadingRef.current = true
    setDownloading(true)
    try {
      runStore.patch({ export: { error: null } })
      await api.download(zipPath)
      runStore.patch({ export: { downloaded: true } })
    } catch (err) {
      // 下载失败：同时用 Toast 送达（自动下载是静默的，用户可能已切走）
      const message = err instanceof Error ? err.message : String(err)
      runStore.patch({ export: { error: message } })
      toast.error(message)
    } finally {
      downloadingRef.current = false
      setDownloading(false)
    }
  }

  return (
    <div className={css.viewBody}>
      {/* 1. 工具栏：选择内容 + 执行（原来还有「快速/自定义导出」二选一，已移除：
          勾选状态就是唯一事实，不再有第二套流程） */}
      <div className={css.actionRow}>
        {/* 用户要求：两个按钮**左对齐**（原先用 .statusSpacer 推到了右侧），
            且**「开始导出」在前、「选择要导出的内容」在后**（主操作在左，选择内容在它右边）。 */}
        <Button
          variant="primary"
          disabled={running || passwordInvalid || fileNameInvalid || nothingSelected}
          onClick={() => { void runExport() }}
        >
          {running ? <Spinner /> : t('export.run')}
        </Button>
        <Button size="sm" disabled={running} title={t('picker.title')} onClick={openPicker}>
          {invLoading ? <Spinner /> : <PreviewIcon size={13} />} {t('picker.title')}
        </Button>
      </div>
      <div className={css.modeHint}>{t('export.hint')}</div>
      {/* 公告位 = **恒定高度**槽位（.noticeSlot）。原先「未勾选」与「设备相关」是两个各自条件
          渲染的 Banner，出现/消失时内容流高度变化 —— 垂直居中的弹窗与页面会跳（用户实测反馈）。
          两者天然互斥（未勾选时 deviceSpecific 必为空），因此共用同一个槽位。 */}
      <div className={css.noticeSlot}>{notice}</div>

      {/* 3. 安全选项（UI-11：恢复分组标题 —— 否则这一组与下面的「文件名与备注」是两块
          外观完全相同的输入区，读不出边界；标题键 export.security 此前已备但无引用点） */}
      <div className={css.groupLabel}>{t('export.security')}</div>
      <div className={css.optionsRow}>
        <Checkbox
          checked={encrypt}
          onChange={setEncrypt}
          label={<span className={css.categoryName}>{t('export.encrypt')}</span>}
        />
        <Checkbox
          checked={includeSecrets}
          onChange={setIncludeSecrets}
          label={<span className={css.categoryName}>{t('export.includeSecrets')}</span>}
        />
        <span className={css.statusSpacer} />
      </div>
      <div className={`${css.hint} ${css.groupHintRow}`}>
        {encrypt ? t('export.encryptHint') : t('export.includeSecretsHint')}
      </div>
      {encrypt && (
        <div className={css.secretFields}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('export.password')}</span>
            <input type="password" className={css.input} value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPassword(e.target.value) }} autoComplete="new-password" />
            {password === '' && <span className={css.formError}>{t('export.passwordRequired')}</span>}
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('export.passwordConfirm')}</span>
            <input type="password" className={css.input} value={passwordConfirm} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPasswordConfirm(e.target.value) }} autoComplete="new-password" />
            {password !== '' && password !== passwordConfirm && <span className={css.formError}>{t('export.passwordMismatch')}</span>}
          </label>
        </div>
      )}

      {/* 4. 命名行：文件名 + 备注（双列；UI-11 恢复分组标题） */}
      <div className={css.groupLabel}>{t('export.naming')}</div>
      <div className={css.secretFields}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('export.fileName')}</span>
          <input
            type="text"
            className={css.input}
            value={fileName}
            placeholder="dsh-config-2026-08-24"
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setFileName(e.target.value) }}
            onBlur={() => {
              // 失焦自动补全 .zip 后缀（空值保持空 = 宿主自动命名）
              if (fileName.trim() !== '') setFileName(normalizeExportFileName(fileName))
            }}
          />
          {/* UI-12：规则提示**常驻**（原来只有输入非法后才出现错误，用户在此之前不知道规则）；
              顺序保持「先说明规则、后报错」。 */}
          {fileNameInvalid
            ? <span className={css.formError}>{t('export.fileNameInvalid')}</span>
            : <span className={css.hint}>{t('export.fileNameHint')}</span>}
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('export.note')}</span>
          <input
            type="text"
            className={css.input}
            value={note}
            placeholder={t('export.notePlaceholder')}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setNote(e.target.value) }}
          />
          {/* UI-12：备注说明同样常驻（键 export.noteHint 此前无引用点） */}
          <span className={css.hint}>{t('export.noteHint')}</span>
        </label>
      </div>

      {/* Phase 1：内容选择弹窗（分区 → 最小可拆单元；选择即生效，合计实时更新） */}
      <Modal
        open={pickerOpen}
        onClose={() => { setPickerOpen(false) }}
        title={t('picker.title')}
        wide
      >
        <Modal.Header
          title={t('picker.title')}
          closeLabel={t('common.close')}
          onClose={() => { setPickerOpen(false) }}
        />
        <Modal.Body scroll>
          {/* 固定高度容器（.pickerModalBody）：**弹窗几何不随任何内部内容变化**。
              上一版只把公告位做成恒高，仍然抖 —— 因为只要对话框高度由内容决定，
              任何一个内部元素（错误 Banner / 读取失败提示 / 合计文案换行 / 列表条目增减）
              变高变矮，垂直居中的对话框就会整体位移。逐个元素做恒高是打地鼠，
              这里改为把外层高度钉死，让「会变的内容」只吃内部弹性空间。 */}
          <div className={css.pickerModalBody}>
            {invError !== null && <Banner kind="error">{invError}</Banner>}
            <ContentPicker
              nodes={pickerNodes}
              value={pickerValue}
              onChange={applyPicker}
              t={t}
              sectionLabel={sectionLabeler(t)}
              loading={invLoading && Object.keys(inv).length === 0}
              busy={invLoading}
              pendingSections={invPending}
              failedSections={invFailed}
            />
            {/* 与页面共用同一个恒定高度公告位（原因见页面处注释） */}
            <div className={css.noticeSlot}>{notice}</div>
          </div>
        </Modal.Body>
        {/* UI-23：底部动作用 Modal.Footer（带分隔线的固定底栏）—— 原先是正文流里的按钮，
            会随内容滚动、条目多时被裁到折线以下。顶部关闭 X 并存是既有约定。 */}
        <Modal.Footer>
          <Button variant="ghost" onClick={() => { setPickerOpen(false) }}>{t('common.close')}</Button>
        </Modal.Footer>
      </Modal>

      {running && <ProgressBar event={progress} active />}

      {error !== null && (
        <ErrorBanner error={error} onRetry={() => { void runExport() }} retrying={running} t={api.t} />
      )}

      {result !== null && !running && (
        <>
          <ReportView
            kind="export"
            exportReport={result.report}
            onDownload={() => { void download(result.zipPath) }}
            downloadBusy={downloading}
            t={api.t}
            // 分区清单显示名走 section-labels 单一映射（中文），不再显示 pluginFiles 这类适配器 id
            sectionLabel={sectionLabeler(t)}
          />
        </>
      )}

      {/* 最后一个数据块（UI-04 / DESIGN.md「Canvas 纪律」）：本次将导出的分区构成 + 合计。
          卡片以 .fillViewport 撑满剩余视口、清单在其内滚动，消除内容之下的整屏纯背景色空洞；
          数字与选择器 footer 同源（同一个 pickerSummary）。 */}
      {/* 该块**恒常渲染**（F-03/C 轮：nothingSelected 时不能整块消失，否则底部空洞回归 ——
          「无内容可导出」本身就是一条需要用户看到的状态，而不是留白）。 */}
      <Card className={css.fillViewport}>
        <div className={css.groupHeader}>
          <span className={css.groupLabel}>{t('export.compositionTitle')}</span>
          <span className={css.groupNote}>{t('export.compositionHint')}</span>
          <span className={css.statusSpacer} />
          {compositionRows.length > 0 && (
            /* 有未读取分区时合计只报**下限**并显式标注（F-03）：宁可说「不少于」，也不虚报一个偏小的数 */
            unreadCount > 0
              ? (
                <span className={css.hint}>
                  {t('export.compositionPartial', {
                    sections: String(summary.sections),
                    units: String(summary.units),
                    size: formatBytes(summary.sizeBytes),
                  })}
                </span>
              )
              : (
                <span className={css.hint}>
                  {t('picker.summary', {
                    sections: String(summary.sections),
                    units: String(summary.units),
                    size: formatBytes(summary.sizeBytes),
                  })}
                </span>
              )
          )}
        </div>
        <div className={css.compositionViewport}>
          {compositionRows.length === 0
            ? <div className={css.hint}>{t('export.compositionEmpty')}</div>
            : (
              <SectionComposition
                sections={compositionRows}
                t={t}
                sectionLabel={sectionLabeler(t)}
              />
            )}
        </div>
      </Card>
    </div>
  )
}

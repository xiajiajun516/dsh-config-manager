/**
 * 环境页（UI v2 §9）—— 两个子视图：**档案列表**（主视图）与**维护与诊断**（全屏子视图）。
 *
 * 为什么把两者放一页：它们回答的是同一个问题 ——「我这台机器现在是什么状态」。
 * 档案是「有哪些实例」，维护是「文件系统与事故」。v1 把它们拆在档案页与备份页，
 * 用户排查崩溃时要在两个页签之间来回跳。
 *
 * 档案部分的实现**逐字沿用 v1 的 ProfilesPanel**（判定逻辑一行不改，§9 的硬要求）；
 * 换的只是外壳：外面多一层「档案列表 / 维护与诊断」的分段切换。
 *
 * 「档案」= DSH 的 profile（`$DSH_HOME/profiles/<name>`），由 src/profiles/dsh-profile-manager.ts
 * 读目录定义、由 src/profiles/dsh-profile-launcher.ts 管实例。本视图：
 * - **列表**：形态（web/headless/自定义）、bundle 层、依赖数、patch 条目、node_modules、更新时间；
 * - **运行状态卡**：当前运行的 profile + 本插件启动的实例（端口 / 打开 / 停止）；
 * - **启动 / 停止该档案**：让 host 用 `dsh --profile <名> --port <空闲端口>` 拉起**独立实例**
 *   （自动挑端口 + 自动开浏览器），当前实例不受影响；只对 Web 形态开放（其余形态没有浏览器界面，
 *   spawn 出来是隐形进程），非 Web 形态点击后给出终端命令而不是静默失败；
 *   **已经在跑的档案，行内按钮变成「停止」**——停止走 ConfirmDialog（会中断那个实例里的会话）；
 * - **新建 / 重命名 / 删除**：删除是**物理删除**（含 node_modules），走 ConfirmDialog；
 *   删除当前运行中的档案需额外勾选确认；
 * - **详情**：package.json 与 cordis.patch.yml 原文（只读）。
 *
 * 状态**全部住在 runStore.profiles 切片**（本组件订阅读取，不另存一份）：切页签不丢进行中态，
 * 迟到的回执也能把界面拉回同步；组件私有 state 只剩一次性正文（detail/detailLoading/detailError）。
 * 安全：profile 定义不含秘密值（dependencies 只有包名与 spec）；错误文本渲染前过 redact()。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import { redact } from '../../security/redaction.ts'
import { DSH_PROFILE_LAUNCH_TIMEOUT_MS } from '../../profiles/dsh-profile-shared.ts'
import type { DshProfileDetail, DshProfileMeta, DshProfileRunningView } from '../../profiles/dsh-profile-shared.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { runStore, toProfilesStoreSlice, type ProfilesStoreSlice } from '../run-store.ts'
import { RecoveryPanel } from '../recovery/RecoveryPanel.tsx'
import type { RecoveryPort } from '../../ui/types.ts'
import type { IncidentApi } from '../recovery/incident-api.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, SectionTitle, Segmented, Spinner } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Skeleton, SkeletonList } from '../common/Skeleton.tsx'
import { Select } from '../common/Select.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { Modal } from '../common/Modal.tsx'
import { toast } from '../common/toast-store.ts'
import { copyTextToClipboard } from '../common/clipboard.ts'
import {
  bundleLines, canLaunchProfile, copyWarningKey, countIncompleteProfileCopies, dependencyLines, formatBytes,
  formatProfileTime, incompleteCopyFacts, incompleteCopyStartedAtText, isIncompleteProfileCopy, issueLabelKey,
  launchBlockReason, launchState, launchWarningKey, profileInstallCommand, profileRowAction, profileRowCapabilities,
  profileRowFacts, profileShapeLabelKey, profilesPanelPhase,
  profileVersionFacts, sessionFormatRisk,
  restartCommand, runningRecordFor, shapeLabelKey, sortProfilesForDisplay, stopResultKey, summarizeProfiles,
  suggestCopyName, validateProfileNameInput,
} from '../../ui/dsh-profiles-view.ts'
import css from '../config-manager.module.css'

export interface ProfilesPanelProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

/**
 * 面板状态 = **run-store 的档案切片**（一一对应，组件不得再持有切片外的字段）：
 * 切片住在模块级单例里，所以切页签（组件卸载）**不丢任何字段** —— 这正是「启动中 /
 * 停止中 / 提交中」按钮态不再一卸载就归零的机制（真机 bug：切走再回来按钮变回「启动」，
 * 用户以为没点上而重复点击）。
 *
 * 需要组件私有的只剩**一次性正文**（detail / detailLoading / detailError）：切片只存
 * `selectedName`，弹窗正文挂载后按名重取，所以刷新/切页签回来都不是空弹窗。
 */
type PanelState = ProfilesStoreSlice

/** useSyncExternalStore 的选择器（模块级常量：引用稳定，不随渲染重建）。 */
function selectProfilesSlice(): PanelState {
  return runStore.getSnapshot().profiles
}

/** host 侧 engine 错误码 → 文案（未知错误回退到通用模板，不显示裸英文码）。 */
const ERROR_CODES = ['notLaunchable', 'launcherUnavailable', 'launchFailed', 'alreadyRunning', 'notRunning', 'stopFailed', 'instanceRunning', 'exists', 'notFound', 'currentProfile', 'invalidName', 'reservedName', 'unknownTemplate', 'managedProfile'] as const

function profileErrorText(t: TranslateNS<'config-manager'>, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  for (const code of ERROR_CODES) {
    if (message === code || message.includes(code)) {
      // launchFailed / stopFailed 的 message 形如 `<code>: <细节>`：细节是排障的唯一线索，不能吞掉
      if ((code === 'launchFailed' || code === 'stopFailed') && message.includes(': ')) {
        const tail = message.slice(message.indexOf(': ') + 2).trim()
        return tail === '' ? t(`profiles.error.${code}`) : `${t(`profiles.error.${code}`)} — ${redact(tail)}`
      }
      return t(`profiles.error.${code}`)
    }
  }
  return t('profiles.error.generic', { message: redact(message) })
}

/** 复制文本到剪贴板（与 HomePanel 同一交互约定：结果以 Toast 反馈；剪贴板调用走 common/clipboard.ts）。 */
function copyText(text: string, t: TranslateNS<'config-manager'>, okKey: 'profiles.copied' | 'profiles.launch.copiedUrl' | 'profiles.duplicate.copiedInstall' = 'profiles.copied'): void {
  void copyTextToClipboard(text).then((ok) => {
    if (ok) toast.ok(t(okKey))
    else toast.warn(t('toast.copyFailed'))
  })
}

export interface EnvironmentPanelProps extends ProfilesPanelProps {
  /** 维护与诊断需要的端口（磁盘体检 / 事故处理 / 会话健康 / 救援模式） */
  recoveryApi: RecoveryPort
  recoveryT: TranslateNS<'config-manager-recovery'>
  incidentApi: IncidentApi
}

export function EnvironmentPanel({ api, t, recoveryApi, recoveryT, incidentApi }: EnvironmentPanelProps) {
  /**
   * 子视图：档案列表（主视图）/ 维护与诊断（全屏）。
   * 维护是**全屏子视图**，不是 Segmented 里的第三格（§9）—— 它自己有四张卡要排。
   *
   * 它**不是组件私有 state 而是 runStore 切片的字段**：命令面板（`maintenance.open` /
   * `recovery.open`）与 SAFE MODE 横幅都要能直达这里，而它们只能写 store ——
   * 留在 useState 里，命令就只会把用户送到「档案」列表（§4.4 明确不允许）。
   * 刷新不保留（`normalizeProfilesSlice` 只恢复磁盘上有意义的字段），与改造前一致。
   */

  /**
   * 面板状态 = 单例里的档案切片（直接订阅，不再另存 React state）：
   *  - 切页签（组件卸载）不丢进行中态与草稿；
   *  - 上一次挂载遗留的请求回执落地时（此刻组件可能已重挂），单例一通知界面就同步 ——
   *    只写 store 不通知的话，用户回来看到的是永远转不完的「启动中」（真机实测）；
   *  - 挂载即读当前值，无需 initFromStore 那套拷贝。
   */
  const state = useSyncExternalStore(runStore.subscribe, selectProfilesSlice)
  const subView = state.subView
  const mountedRef = useRef(true)
  /** 详情原文（一次性读取；切片只存档案名 selectedName，挂载后按名重取） */
  const [detail, setDetail] = useState<DshProfileDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  /**
   * 唯一的写入口：合并进单例（本组件即便已卸载，迟到的回执也照写）。
   * 基线取 **store 当前值**而不是闭包里的旧快照：请求可能在面板卸载后才回执，
   * 这期间用户已回到页面并刷新过列表 —— 用卸载前的旧快照做基会把刚取回的新数据写回旧值。
   */
  const patch = (p: Partial<PanelState>): void => {
    runStore.patch({ profiles: toProfilesStoreSlice({ ...runStore.getSnapshot().profiles, ...p }) })
  }

  useEffect(() => () => { mountedRef.current = false }, [])

  const load = (): void => {
    patch({ loadError: null })
    api.profilesList().then(
      (snapshot) => {
        const profiles = snapshot.profiles ?? []
        const running = snapshot.running ?? []
        const templates = snapshot.templates ?? []
        // 基线取 store 当前值（不是本闭包的旧快照）：迟到的回执/并发的目标都不该被旧值覆盖
        const cur = runStore.getSnapshot().profiles
        // 目标已消失 → 关闭详情/重命名/删除/停止会话，避免对着幽灵档案操作
        const stillExists = (name: string | null): boolean => name !== null && profiles.some((p) => p.name === name)
        const stillRunning = (name: string | null): boolean => name !== null && running.some((rr) => rr.name === name)
        patch({
          profiles,
          current: snapshot.current ?? null,
          running,
          templates,
          createTemplate: templates.some((tp) => tp.id === cur.createTemplate) ? cur.createTemplate : 'base',
          selectedName: stillExists(cur.selectedName) ? cur.selectedName : null,
          renameTargetName: stillExists(cur.renameTargetName) ? cur.renameTargetName : null,
          copyTargetName: stillExists(cur.copyTargetName) ? cur.copyTargetName : null,
          deleteTargetName: stillExists(cur.deleteTargetName) ? cur.deleteTargetName : null,
          // 待确认的停止目标若已经不在运行了 → 关掉确认框（避免「停一个幽灵实例」）
          stopTargetName: stillRunning(cur.stopTargetName) ? cur.stopTargetName : null,
        })
      },
      (err) => {
        patch({ loadError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  useEffect(load, [api])

  /** 拉取详情正文（一次性；按名重取，所以刷新/切页签回来都不是空弹窗）。 */
  const fetchDetail = (name: string): void => {
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    api.profileDetail(name).then(
      (value) => {
        if (!mountedRef.current) return
        setDetail(value)
        setDetailLoading(false)
      },
      (err) => {
        if (!mountedRef.current) return
        setDetailError(profileErrorText(t, err))
        setDetailLoading(false)
      },
    )
  }

  /** 打开详情（只读；切片只记名字，正文现场重取）。 */
  const openDetail = (profile: DshProfileMeta): void => {
    patch({ selectedName: profile.name, error: null })
    fetchDetail(profile.name)
  }

  const closeDetail = (): void => {
    patch({ selectedName: null })
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
  }

  // 上次挂载时详情是开着的（切页签回来 / 刷新恢复）→ 按名字重建弹窗：正文重取，不给空弹窗
  useEffect(() => {
    const restored = state.selectedName
    if (restored !== null) fetchDetail(restored)
  }, [])

  const doCreate = (): void => {
    const name = state.createName.trim()
    const issue = validateProfileNameInput(name)
    if (issue !== null) {
      patch({ error: nameIssueText(t, name, issue) })
      return
    }
    if (state.creating) return
    patch({ creating: true, error: null })
    // 回执不再用 mountedRef 拦：patch 直达单例，面板卸载期间出的结果也照写（否则按钮永久停在「创建中」）
    api.profileCreate(name, state.createTemplate).then(
      (meta) => {
        patch({ creating: false, createName: '', error: null })
        toast.ok(t('profiles.create.done', { name: meta.name }))
        load()
      },
      (err) => {
        const text = profileErrorText(t, err)
        patch({ creating: false, error: text })
        toast.error(text)
      },
    )
  }

  /** 重命名：目标由渲染期解析出的档案对象传入（列表一刷新就自动跟随，不留幽灵目标）。 */
  const doRename = (target: DshProfileMeta): void => {
    if (state.renaming) return
    const newName = state.renameValue.trim()
    const issue = validateProfileNameInput(newName)
    if (issue !== null) {
      patch({ error: nameIssueText(t, newName, issue) })
      return
    }
    patch({ renaming: true, error: null })
    api.profileRename(target.name, newName).then(
      (meta) => {
        patch({ renaming: false, renameTargetName: null, renameValue: '', error: null })
        toast.ok(t('profiles.rename.done', { name: meta.name }))
        load()
      },
      (err) => {
        patch({ renaming: false, error: profileErrorText(t, err) })
      },
    )
  }

  /** 删除（物理删除目录，不可恢复）：目标由渲染期解析出的档案对象传入。 */
  const doDelete = (target: DshProfileMeta): void => {
    if (state.deleting) return
    if (target.isCurrent && !state.deleteCurrentConfirmed) {
      patch({ error: t('profiles.deleteCurrentWarning') })
      return
    }
    patch({ deleting: true, error: null })
    api.profileDelete(target.name, { allowCurrent: target.isCurrent }).then(
      () => {
        patch({ deleting: false, deleteTargetName: null, deleteCurrentConfirmed: false, error: null })
        toast.ok(t('profiles.delete.done', { name: target.name }))
        load()
      },
      (err) => {
        patch({ deleting: false, error: profileErrorText(t, err) })
      },
    )
  }

  /**
   * 「停止该档案」：host 先请子进程自己退出，优雅期（6s）超时才强杀进程树。
   * 回执带停止后的 running 列表 —— 按钮立刻变回「启动」，并如实说明是优雅退出还是被强杀。
   */
  const doStop = (record: DshProfileRunningView): void => {
    if (state.stopping !== null) return
    patch({ stopping: record.name, error: null })
    api.profileStop(record.name).then(
      ({ result, running }) => {
        patch({ stopping: null, stopTargetName: null, running, error: null })
        // 三种终态分开说：强制杀掉 / 早已不在都不许伪装成「优雅退出」
        toast.ok(t(stopResultKey(result), { name: record.name }))
      },
      (err) => {
        const text = profileErrorText(t, err)
        patch({ stopping: null, stopTargetName: null, error: text })
        toast.error(text)
      },
    )
  }

  /**
   * 「启动该档案」：host 用 `dsh --profile <名> --port <空闲端口>` 拉起独立实例并等就绪（最长 20s）。
   * 非 Web 形态没有浏览器界面 → 不发起请求，就地给终端命令；host 侧的 launchFailed 会带上日志尾部。
   * 回执（含带 token 的 URL）写进切片：切页签回来横幅还在，不会「点完就没了」。
   */
  const doLaunch = (profile: DshProfileMeta): void => {
    if (state.launching !== null) return
    if (!canLaunchProfile(profile)) {
      patch({ launchResult: null, launchBlocked: profile.name, error: null })
      return
    }
    patch({ launchBlocked: null, launching: profile.name, error: null })
    api.profileLaunch(profile.name).then(
      ({ launch: result, running }) => {
        patch({ launching: null, error: null, running, launchResult: result })
        if (launchState(result) === 'ready') {
          toast.ok(t('profiles.launch.started', { name: result.name, port: result.port }))
        } else {
          toast.warn(t('profiles.launch.pending', { name: result.name, port: result.port, seconds: Math.round(DSH_PROFILE_LAUNCH_TIMEOUT_MS / 1000) }))
        }
      },
      (err) => {
        const text = profileErrorText(t, err)
        patch({ launching: null, error: text })
        toast.error(text)
      },
    )
  }

  /**
   * 「复制该档案」：host 整份拷贝 `<home>/profiles/<源名>` → 新档案名（可选是否带 node_modules）。
   * 回执落进切片（含 warnings）：带 node_modules 的档案实测要二十多秒（285 MB），切页签回来横幅还在；
   * 没带 node_modules 的副本**启动会失败**，所以横幅必须给出安装命令 —— 绝不静默。
   */
  const doDuplicate = (target: DshProfileMeta): void => {
    if (state.copying) return
    const name = state.copyValue.trim()
    const issue = validateProfileNameInput(name)
    if (issue !== null) {
      patch({ error: nameIssueText(t, name, issue) })
      return
    }
    patch({ copying: true, error: null })
    api.profileCopy(target.name, name, { includeNodeModules: state.copyIncludeModules }).then(
      ({ copy }) => {
        patch({ copying: false, copyTargetName: null, copyValue: '', copyResult: copy, error: null })
        toast.ok(t('profiles.duplicate.done', { name: copy.name }))
        load()
      },
      (err) => {
        const text = profileErrorText(t, err)
        patch({ copying: false, error: text })
        toast.error(text)
      },
    )
  }

  /**
   * 阶段由切片派生（`profilesPanelPhase`）：列表已恢复时一次后台刷新不该把视图打回「加载中」。
   * 旧实现每次挂载都先置 loading —— 切回页签必然闪一下空态。
   */
  const phase = profilesPanelPhase(state.profiles, state.loadError)
  const profileList = state.profiles ?? []
  const rows = sortProfilesForDisplay(profileList, {
    currentName: state.current,
    runningNames: state.running.map((r) => r.name),
  })
  const summary = summarizeProfiles(profileList)
  // cross-F3：未被完成的副本（中断的复制残留）单独计数 —— 它们不是「档案」，混进形态分布只会误导
  const incompleteCount = countIncompleteProfileCopies(profileList)
  // 会话格式体检的基准 = 当前实例自己的格式版本（从当前档案行取；读不到就是 null → 不提示，不猜）。
  // 为什么用它：DSH 对「读不出的会话格式」是静默跳过的，档案页必须让用户看见版本错配。
  const currentFormatVersion = profileList.find((p) => p.isCurrent)?.sessionFormatVersion ?? null
  const createIssue = state.createName.trim() === '' ? null : validateProfileNameInput(state.createName)
  // 弹窗目标按档案名即时解析：列表一刷新就自动跟随（目标消失 → 弹窗自己关掉）
  const renameTarget = state.renameTargetName === null
    ? null
    : profileList.find((p) => p.name === state.renameTargetName) ?? null
  const deleteTarget = state.deleteTargetName === null
    ? null
    : profileList.find((p) => p.name === state.deleteTargetName) ?? null
  const stopTarget = state.stopTargetName === null
    ? null
    : state.running.find((r) => r.name === state.stopTargetName) ?? null
  const copyTarget = state.copyTargetName === null
    ? null
    : profileList.find((p) => p.name === state.copyTargetName) ?? null
  /** 启动回执 / 非 Web 提示（切片字段的本地别名，渲染段与改造前同形） */
  const launch = state.launchResult
  const launchBlocked = state.launchBlocked
  // 「启动被挡下」的原因：managed（Desktop 独占档案）不能给 `dsh --profile desktop` 命令 —— 那条命令正是被拒绝的那条。
  const launchBlockedReason = launchBlocked === null
    ? 'notWeb' as const
    : launchBlockReason({ name: launchBlocked, shape: profileList.find((p) => p.name === launchBlocked)?.shape ?? 'generic' })
  /** 最近一次复制回执（切片字段的本地别名） */
  const copyResult = state.copyResult

  return (
    <div className={css.viewBody}>
      {/* 页级标题：只留标题 ——「档案 = 插件组合（bundles）+ 依赖 + patch 层」这句现在挂在
          「档案」分区标题的 ⓘ 上（2026-10-12 用户要求说明性文案一律进 ⓘ；此前页级与分区级
          各渲染一次同一句话，同一屏出现两遍）。 */}
      <SectionTitle title={t('environment.title')} />

      {/* 子视图切换：档案列表 ↔ 维护与诊断 */}
      <div className={css.actionRow}>
        <Segmented
          items={[
            { id: 'list', label: t('environment.tab.profiles') },
            { id: 'maintenance', label: t('environment.tab.maintenance') },
          ]}
          active={subView}
          onChange={(id) => { patch({ subView: id === 'maintenance' ? 'maintenance' : 'list' }) }}
          ariaLabel={t('environment.title')}
        />
        <span className={css.statusSpacer} />
      </div>

      {subView === 'maintenance' && (
        /* 维护与诊断 = 直接复用整个 RecoveryPanel（顺序在它内部，见该文件渲染段）：
           状态与待处理事项（异常优先）→ 事故处置（崩溃 / 救援模式）→ 残留 → 诊断三块
           （磁盘占用缺省展开，会话体检与「工作区 + 会话回滚」缺省收起）。
           拆成四张独立卡片就得把「确认 → 执行 → 验证」的状态机提到父级，反而更脆。 */
        <RecoveryPanel
          recoveryApi={recoveryApi}
          t={recoveryT}
          incidentApi={incidentApi}
          copyT={t}
          infoHintLabel={t('common.infoHint')}
          diskApi={api}
        />
      )}

      {subView === 'list' && (
      <>
      <SectionTitle title={t('profiles.title')} info={<InfoHint text={t('profiles.subtitle')} label={t('common.infoHint')} />} />

      {/* —— 运行状态：当前运行中的 profile + 本插件启动的实例（可打开 / 可停止） —— */}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('profiles.running.title')}</div>
        <div className={css.kvRow}>
          <span className={css.kvKey}>{t('profiles.current')}</span>
          <span className={css.kvValue}>
            {state.current === null ? '—' : <span className={css.mono}>{state.current}</span>}
          </span>
        </div>
        {state.running.length === 0 && <div className={css.hint}>{t('profiles.running.none')}</div>}
        {state.running.map((record) => (
          <div key={record.name} className={css.actionRow}>
            <span className={css.kvValue}>
              <span className={css.mono}>{record.name}</span>
              {record.port !== null && <>{' · '}{t('profiles.running.port', { port: record.port })}</>}
              {' · '}{t(record.current ? 'profiles.running.originCurrent' : record.owned ? 'profiles.running.originOwned' : 'profiles.running.originExternal')}
            </span>
            {record.url !== null && <Button size="sm" href={record.url}>{t('profiles.running.open')}</Button>}
            {/* 当前实例不能停自己（进程会死在响应途中）：给禁用按钮 + 说明，而不是藏起来 */}
            <Button
              size="sm"
              variant="ghost"
              disabled={state.stopping !== null || record.current}
              title={record.current ? t('profiles.stop.currentHint') : record.owned ? t('profiles.stop.hint') : t('profiles.stop.hintExternal')}
              onClick={() => { patch({ stopTargetName: record.name, error: null }) }}
            >
              {state.stopping === record.name ? <Spinner label={t('profiles.stopping')} /> : t('profiles.stop')}
            </Button>
          </div>
        ))}
      </Card>

      {/* —— 「启动该档案」的反馈：就绪给带 token 的认证 URL；没就绪给告警 + 日志路径 —— */}
      {launchBlocked !== null && (
        <Banner kind="warn">
          {launchBlockedReason === 'managed' ? (
            <div>{t('profiles.launch.managed', { name: launchBlocked })}</div>
          ) : (
            <>
              <div>{t('profiles.launch.notWeb', { name: launchBlocked })}</div>
              <div className={css.actionRow}>
                <code className={css.mono}>{restartCommand(launchBlocked)}</code>
                <Button size="sm" onClick={() => { copyText(restartCommand(launchBlocked), t) }}>
                  {t('profiles.copy')}
                </Button>
              </div>
            </>
          )}
        </Banner>
      )}
      {launch !== null && (
        <Banner kind={launchState(launch) === 'ready' ? 'ok' : 'warn'}>
          <div>
            {launchState(launch) === 'ready'
              ? t('profiles.launch.started', { name: launch.name, port: launch.port })
              : t('profiles.launch.pending', { name: launch.name, port: launch.port, seconds: Math.round(DSH_PROFILE_LAUNCH_TIMEOUT_MS / 1000) })}
          </div>
          <div className={css.kvRow}>
            <span className={css.kvKey}>{t('profiles.launch.log')}</span>
            <span className={css.kvValue}><span className={css.mono}>{launch.logFile}</span></span>
          </div>
          {launch.warnings.map((warning) => (
            <div key={warning} className={css.hint}>{t(launchWarningKey(warning))}</div>
          ))}
          <div className={css.actionRow}>
            {launch.url !== null && (
              <>
                <Button size="sm" variant="primary" href={launch.url}>{t('profiles.launch.open')}</Button>
                <Button size="sm" onClick={() => { copyText(launch.url ?? '', t, 'profiles.launch.copiedUrl') }}>
                  {t('profiles.launch.copyUrl')}
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => { patch({ launchResult: null }) }}>{t('common.close')}</Button>
          </div>
        </Banner>
      )}

      {/* —— 「复制该档案」的回执：没带 node_modules 的副本不能直接启动，必须给出安装命令 —— */}
      {copyResult !== null && (
        <Banner kind={copyResult.warnings.length > 0 ? 'warn' : 'ok'}>
          <div>{t('profiles.duplicate.done', { name: copyResult.name })}</div>
          {copyResult.warnings.map((warning) => (
            <div key={warning}>
              <div>{t(copyWarningKey(warning))}</div>
              <div className={css.actionRow}>
                <code className={css.mono}>{profileInstallCommand(copyResult.name)}</code>
                <Button size="sm" onClick={() => { copyText(profileInstallCommand(copyResult.name), t, 'profiles.duplicate.copiedInstall') }}>
                  {t('profiles.copy')}
                </Button>
              </div>
            </div>
          ))}
          <div className={css.actionRow}>
            <Button size="sm" variant="ghost" onClick={() => { patch({ copyResult: null }) }}>{t('common.close')}</Button>
          </div>
        </Banner>
      )}

      {/* —— 新建档案 —— */}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('profiles.create.title')} <InfoHint text={t('profiles.create.hint')} label={t('common.infoHint')} /></div>
        <div className={css.actionRow}>
          <input
            type="text"
            className={css.input}
            placeholder={t('profiles.create.placeholder')}
            aria-label={t('profiles.create.nameLabel')}
            value={state.createName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ createName: e.target.value }) }}
          />
          <Select
            ariaLabel={t('profiles.create.templateLabel')}
            value={state.createTemplate}
            onChange={(next) => { patch({ createTemplate: next }) }}
            options={state.templates.map((template) => ({
              value: template.id,
              label: `${template.id} — ${template.bundles.join(' + ')}`,
            }))}
          />
          <Button variant="primary" disabled={state.creating || state.createName.trim() === '' || createIssue !== null} onClick={doCreate}>
            {state.creating ? <Spinner label={t('profiles.create.creating')} /> : t('profiles.create.action')}
          </Button>
        </div>
        {createIssue !== null && <span className={css.formError}>{nameIssueText(t, state.createName.trim(), createIssue)}</span>}
      </Card>

      {/* —— 列表 —— */}
      {phase === 'loading' && <SkeletonList label={t('profiles.loading')} />}
      {phase === 'error' && (
        <Banner kind="error">
          {redact(state.loadError ?? t('common.unknownError'))}
          <Button size="sm" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}
      {phase === 'ready' && profileList.length === 0 && <Empty>{t('profiles.empty')}</Empty>}
      {phase === 'ready' && profileList.length > 0 && (
        <>
          <div className={css.listHeaderRow}>
            <span className={css.groupLabel}>{t('profiles.list.title')} <InfoHint text={t('profiles.list.hint')} label={t('common.infoHint')} /></span>
            <span className={css.cellMeta}>
              {t('profiles.list.count', { count: summary.total })} ·{' '}
              {t('profiles.list.summary', { web: summary.web, headless: summary.headless, generic: summary.generic, installed: summary.withNodeModules })}
              {incompleteCount > 0 && <> · {t('profiles.list.incompleteCount', { count: incompleteCount })}</>}
            </span>
            <Button size="sm" onClick={load}>{t('profiles.refresh')}</Button>
          </div>
          <div className={css.snapshotList} role="list" aria-label={t('profiles.list.title')}>
            {rows.map((profile) => {
              const facts = profileRowFacts(profile)
              // cross-F3：残留行（未完成的副本）以独立形态呈现，且只留删除动作 —— 判据全部在纯函数层
              const incomplete = isIncompleteProfileCopy(profile)
              const caps = profileRowCapabilities(profile)
              const copyFacts = incomplete ? incompleteCopyFacts(profile) : null
              const copyStartedText = copyFacts === null ? null : incompleteCopyStartedAtText(copyFacts.startedAt)
              const runningRecord = runningRecordFor(state.running, profile.name)
              const rowAction = profileRowAction(profile.name, state.running)
              const version = profileVersionFacts(profile)
              const formatRisk = sessionFormatRisk(profile, currentFormatVersion)
              return (
                <div key={profile.name} className={css.profileRow} role="listitem" data-selected={profile.name === state.selectedName ? '' : undefined}>
                  <div className={css.profileRowHeader}>
                    {/* 整行「信息区」可点：行内只给计数，完整清单（bundle 层 / 逐条依赖 / patch 原文）在详情弹窗里 */}
                    <button type="button" className={css.profileRowMain} title={t(incomplete ? 'profiles.incomplete.hint' : 'profiles.list.hint')} onClick={() => { openDetail(profile) }}>
                      <span className={css.profileRowTitle}>
                        <span className={`${css.mono} ${css.profileRowName}`}>{profile.name}</span>
                        <span className={css.badgeRow}>
                          {profile.isCurrent && <Badge kind="ok">{t('profiles.current')}</Badge>}
                          {runningRecord !== undefined && (
                            <Badge kind="info">
                              {runningRecord.port !== null ? t('profiles.running.badge', { port: runningRecord.port }) : t('profiles.running.badgePlain')}
                            </Badge>
                          )}
                          {/* 残留行必须自报「未完成的副本」——不得伪装成普通「自定义」档案（t50）；非残留行走原形态键 */}
                          <Badge kind={incomplete ? 'warn' : 'info'}>{t(profileShapeLabelKey(profile))}</Badge>
                          {version.dshVersion !== null && (
                            <Badge kind="info">{t('profiles.version.dsh', { version: version.dshVersion })}</Badge>
                          )}
                          {version.sessionFormatVersion !== null && (
                            <Badge kind="info">{t('profiles.version.format', { version: String(version.sessionFormatVersion) })}</Badge>
                          )}
                          {formatRisk !== 'none' && (
                            <Badge kind={formatRisk === 'newer' ? 'warn' : 'error'}>
                              {t(formatRisk === 'newer' ? 'profiles.format.newer' : 'profiles.format.older')}
                            </Badge>
                          )}
                          {profile.issues.map((issue) => (
                            <Badge key={issue} kind="error">{t(issueLabelKey(issue))}</Badge>
                          ))}
                        </span>
                      </span>
                      <span className={css.profileRowMeta}>
                        {/* 残留行：讲清「从哪来、何时开始、目录在哪（脱敏后）」；普通档案的行摘要逐字不变 */}
                        {incomplete && copyFacts !== null
                          ? (
                            <>
                              {copyFacts.copiedFrom !== null && <>{t('profiles.incomplete.from', { name: copyFacts.copiedFrom })}{' · '}</>}
                              {copyStartedText !== null && <>{t('profiles.incomplete.startedAt', { time: copyStartedText })}{' · '}</>}
                              {copyFacts.dir !== null && t('profiles.incomplete.dir', { path: redact(copyFacts.dir) })}
                            </>
                          )
                          : (
                            <>
                              {t('profiles.row.summary', { bundles: facts.bundles, patch: facts.patchEntries, deps: facts.deps })}
                              {' · '}{facts.hasNodeModules ? t('profiles.nodeModules.yes') : t('profiles.nodeModules.no')}
                              {' · '}{profile.patchReload === 'startup' ? t('profiles.patchReload.startup') : t('profiles.patchReload.live')}
                              {profile.updatedAtMs !== null && ` · ${t('profiles.updatedAt', { time: formatProfileTime(profile.updatedAtMs) })}`}
                            </>
                          )}
                      </span>
                    </button>
                    <span className={css.actionRow} data-inline>
                      {/* cross-F3：残留行不给启动/停止那一格（generic 必然 notLaunchable）；删除恒在 */}
                      {caps.launchOrStop && rowAction === 'current' && (
                        <Button size="sm" disabled title={t('profiles.stop.currentHint')}>{t('profiles.current')}</Button>
                      )}
                      {caps.launchOrStop && rowAction === 'stop' && runningRecord !== undefined && (
                        <Button
                          size="sm"
                          title={runningRecord.owned ? t('profiles.stop.hint') : t('profiles.stop.hintExternal')}
                          disabled={state.stopping !== null}
                          onClick={() => { patch({ stopTargetName: runningRecord.name, error: null }) }}
                        >
                          {state.stopping === profile.name ? <Spinner label={t('profiles.stopping')} /> : t('profiles.stop')}
                        </Button>
                      )}
                      {caps.launchOrStop && rowAction === 'launch' && (
                        <Button
                          size="sm"
                          variant="primary"
                          title={canLaunchProfile(profile) ? t('profiles.launch.hint') : launchBlockReason(profile) === 'managed' ? t('profiles.launch.managed', { name: profile.name }) : t('profiles.launch.notWeb', { name: profile.name })}
                          disabled={state.launching !== null || state.stopping !== null}
                          onClick={() => { doLaunch(profile) }}
                        >
                          {state.launching === profile.name ? <Spinner label={t('profiles.launching')} /> : t('profiles.launch')}
                        </Button>
                      )}
                      {caps.duplicate && (
                      <Button
                        size="sm"
                        title={t('profiles.duplicateHint')}
                        disabled={state.copying}
                        onClick={() => {
                          patch({
                            copyTargetName: profile.name,
                            copyValue: suggestCopyName(profile.name, profileList.map((p) => p.name)),
                            copyIncludeModules: profile.hasNodeModules,
                            error: null,
                          })
                        }}
                      >
                        {t('profiles.duplicate')}
                      </Button>
                      )}
                      {caps.rename && (
                      <Button size="sm" onClick={() => { patch({ renameTargetName: profile.name, renameValue: profile.name, error: null }) }}>
                        {t('profiles.rename')}
                      </Button>
                      )}
                      <Button size="sm" variant="danger" onClick={() => { patch({ deleteTargetName: profile.name, deleteCurrentConfirmed: false, error: null }) }}>
                        {t('profiles.delete')}
                      </Button>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* —— 详情弹窗（只读原文） —— */}
      <Modal open={state.selectedName !== null} onClose={closeDetail} title={t('profiles.detail')} wide busy={detailLoading}>
        <Modal.Header
          title={state.selectedName !== null ? t('profiles.detailTitle', { name: state.selectedName }) : t('profiles.detail')}
          closeLabel={t('common.close')}
          onClose={closeDetail}
          closeDisabled={false}
        />
        <Modal.Body scroll>
          {detailLoading && <Skeleton count={3} label={t('profiles.loading')} />}
          {detailError !== null && <Banner kind="error">{detailError}</Banner>}
          {detail !== null && (
            <>
              {/* 概览：行内被折叠掉的计数/状态在这里全量展开 */}
              <div className={css.groupLabel}>{t('profiles.detail.info')}</div>
              <div className={css.badgeRow}>
                <Badge kind="info">{t(shapeLabelKey(detail.shape))}</Badge>
                <Badge kind="info">{t('profiles.bundles.count', { count: detail.bundles.length })}</Badge>
                <Badge kind="info">{t('profiles.patchEntries', { count: detail.patchEntryCount })}{t('common.parens', { text: formatBytes(detail.patchBytes) })}</Badge>
                <Badge kind="info">{detail.patchReload === 'startup' ? t('profiles.patchReload.startup') : t('profiles.patchReload.live')}</Badge>
                <Badge kind={detail.hasNodeModules ? 'ok' : 'warn'}>
                  {detail.hasNodeModules ? t('profiles.nodeModules.yes') : t('profiles.nodeModules.no')}
                </Badge>
                {detail.updatedAtMs !== null && <Badge kind="info">{t('profiles.updatedAt', { time: formatProfileTime(detail.updatedAtMs) })}</Badge>}
              </div>
              <div className={css.kvRow}>
                <span className={css.kvKey}>{t('profiles.dir')}</span>
                <span className={css.kvValue}><span className={css.mono}>{detail.dir}</span></span>
              </div>
              {detail.issues.length > 0 && (
                <Banner kind="warn">
                  {detail.issues.map((issue) => <div key={issue}>{t(issueLabelKey(issue))}</div>)}
                </Banner>
              )}
              <div className={css.kvRow}>
                <span className={css.kvKey}>{t('profiles.bundles')}</span>
                <span className={css.kvValue}>
                  {bundleLines(detail).length === 0
                    ? t('profiles.bundles.none')
                    : (
                      <span className={css.detailLines}>
                        {bundleLines(detail).map((line, index) => (
                          <span key={line} className={css.mono}>{index + 1}. {line}</span>
                        ))}
                      </span>
                    )}
                </span>
              </div>
              {dependencyLines(detail).length > 0 && (
                <div className={css.kvRow}>
                  <span className={css.kvKey}>{t('profiles.deps')}</span>
                  <span className={css.kvValue}>
                    <span className={css.detailLines}>
                      {dependencyLines(detail).map((line) => (
                        <span key={line} className={css.mono}>{line}</span>
                      ))}
                    </span>
                  </span>
                </div>
              )}
              <div className={css.groupLabel}>{t('profiles.detail.manifest')}</div>
              <div className={css.reportScroll}>
                {/* 档案原文一律先过 redact()：package.json 的依赖 spec 可能内联私有源/令牌 */}
                <pre className={css.reportText}>{redact(detail.manifest ?? '')}</pre>
              </div>
              <div className={css.groupLabel}>{t('profiles.detail.patch')}</div>
              <div className={css.reportScroll}>
                {/* cordis.patch.yml 可能内联字面量密钥（!!js 表达式旁），同样先脱敏 */}
                <pre className={css.reportText}>{detail.patch !== null ? redact(detail.patch) : (detail.patchBytes > 0 ? t('profiles.detail.patchTooLarge') : t('profiles.detail.patchMissing'))}</pre>
              </div>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={closeDetail}>{t('common.close')}</Button>
        </Modal.Footer>
      </Modal>

      {/* —— 复制档案：整份拷贝（大档案是否连 node_modules 一起拷由用户定） —— */}
      <ConfirmDialog
        open={copyTarget !== null}
        title={t('profiles.duplicateTitle')}
        message={copyTarget !== null ? t('profiles.duplicateMessage', { name: copyTarget.name }) : undefined}
        confirmLabel={t('profiles.duplicate')}
        cancelLabel={t('common.cancel')}
        busy={state.copying}
        onConfirm={() => { if (copyTarget !== null) doDuplicate(copyTarget) }}
        onCancel={() => { patch({ copyTargetName: null, copyValue: '', error: null }) }}
      >
        <input
          type="text"
          className={css.input}
          value={state.copyValue}
          aria-label={t('profiles.duplicate.nameLabel')}
          disabled={state.copying}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ copyValue: e.target.value }) }}
        />
        {copyTarget !== null && copyTarget.hasNodeModules && (
          <>
            <Checkbox
              checked={state.copyIncludeModules}
              disabled={state.copying}
              onChange={(checked: boolean) => { patch({ copyIncludeModules: checked, error: null }) }}
              label={t('profiles.duplicate.includeModules')}
            />
            <div className={css.hint}>{t('profiles.duplicate.includeModulesHint')}</div>
          </>
        )}
        {copyTarget !== null && !copyTarget.hasNodeModules && (
          <div className={css.hint}>{t('profiles.duplicate.onlyManifest')}</div>
        )}
        {state.error !== null && <span className={css.formError}>{state.error}</span>}
      </ConfirmDialog>

      {/* —— 重命名 —— */}
      {renameTarget !== null && (
        <ConfirmDialog
          open
          title={t('profiles.renameTitle')}
          message={t('profiles.renameMessage', { name: renameTarget.name })}
          confirmLabel={t('profiles.rename')}
          cancelLabel={t('common.cancel')}
          busy={state.renaming}
          onConfirm={() => { if (renameTarget !== null) doRename(renameTarget) }}
          onCancel={() => { patch({ renameTargetName: null, renameValue: '', error: null }) }}
        >
          <input
            type="text"
            className={css.input}
            value={state.renameValue}
            aria-label={t('profiles.renameTitle')}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ renameValue: e.target.value }) }}
          />
          {state.error !== null && <span className={css.formError}>{state.error}</span>}
        </ConfirmDialog>
      )}

      {/* —— 停止实例：会中断那个实例里正在跑的会话 → 走确认，不静默杀 —— */}
      <ConfirmDialog
        open={stopTarget !== null}
        title={t('profiles.stopTitle')}
        message={stopTarget !== null
          ? t(stopTarget.owned ? 'profiles.stopMessage' : 'profiles.stopMessageExternal', { name: stopTarget.name, port: stopTarget.port ?? '—' })
          : undefined}
        confirmLabel={t('profiles.stop')}
        cancelLabel={t('common.cancel')}
        // 会中断该实例里正在跑的会话（profiles.stopMessage 明说）——与删除/回滚/断开同属破坏性动作，
        // 确认层用 danger 语义（此前只有主色，与「删除不可恢复」在视觉上无法区分）。
        danger
        busy={state.stopping !== null}
        onConfirm={() => { if (stopTarget !== null) doStop(stopTarget) }}
        onCancel={() => { patch({ stopTargetName: null, error: null }) }}
      />

      {/* —— 删除（物理删除，不可恢复） —— */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('profiles.deleteTitle')}
        message={deleteTarget !== null
          ? `${isIncompleteProfileCopy(deleteTarget) ? t('profiles.delete.incompleteMessage', { name: deleteTarget.name }) : t('profiles.deleteMessage', { name: deleteTarget.name })}${deleteTarget.isCurrent ? `\n\n${t('profiles.deleteCurrentWarning')}` : ''}`
          : undefined}
        confirmLabel={t('profiles.delete')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.deleting}
        onConfirm={() => { if (deleteTarget !== null) doDelete(deleteTarget) }}
        onCancel={() => { patch({ deleteTargetName: null, deleteCurrentConfirmed: false, error: null }) }}
      >
        {deleteTarget?.isCurrent === true && (
          <Checkbox
            checked={state.deleteCurrentConfirmed}
            onChange={(checked: boolean) => { patch({ deleteCurrentConfirmed: checked, error: null }) }}
            label={t('profiles.deleteCurrentConfirm')}
          />
        )}
        {state.error !== null && <span className={css.formError}>{state.error}</span>}
      </ConfirmDialog>

      {/* —— 表单级错误（无弹窗时也要可见） —— */}
      {state.error !== null && renameTarget === null && deleteTarget === null && copyTarget === null && (
        <Banner kind="error">{state.error}</Banner>
      )}
      </>
      )}
    </div>
  )
}

/** 名称校验码 → 文案（保留名文案带 {name} 占位）。 */
function nameIssueText(t: TranslateNS<'config-manager'>, name: string, issue: 'required' | 'tooLong' | 'illegal' | 'reserved'): string {
  if (issue === 'required') return t('profiles.nameRequired')
  if (issue === 'tooLong') return t('profiles.nameTooLong')
  if (issue === 'reserved') return t('profiles.nameReserved', { name })
  return t('profiles.nameInvalid')
}

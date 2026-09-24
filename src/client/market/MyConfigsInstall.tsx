/**
 * 「我的配置」装回本地向导页 —— t49 物理拆分：从 MyConfigsView.tsx 的 renderInstall 段
 * 原样提取，行为/视觉不变。页面外壳（标题 + 返回按钮 + viewBody）留在容器里，本文件只渲染
 * 「下载中 / 详情审阅 / 级联勾选 + 导入」这一块，并复用市场侧同一个 MarketImportReview。
 * 状态与提交仍在容器：本文件只读 install / installRef 并回调 patchInstall。
 */
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { MyInstallState } from './my-configs-view.ts'
import type { Selection } from '../../ui/selection-model.ts'
import { Badge, Banner, Spinner } from '../common/ui.tsx'
import { marketDetailView } from './market-view.ts'
import { MarketImportReview } from './MarketImportReview.tsx'
import css from '../config-manager.module.css'

export interface MyConfigsInstallProps {
  /** 装回本地全量状态（非 null：容器已保证 installOpen 且 install 存在时才渲染） */
  install: MyInstallState
  /** 最近一次 install 全量（取 zipPath 用；与容器同一个 ref，避免闭包过期） */
  installRef: { current: MyInstallState | null }
  /** 编辑中的分区勾选（由容器经 ui/my-configs-view.ts 的 myPickerSelection 装配） */
  pickerSelection: Selection | null
  /** 详情展示用的仓库 URL（容器经 myEntryRepoUrl 兜底目标仓库） */
  repoUrl: string
  /** 主 ConfigManagerApi（executeImportPlan 等） */
  importApi: ConfigManagerApi
  /** 市场字典（与 MyConfigsView 同一个 t） */
  t: TranslateNS<'config-manager-market'>
  /** config-manager 字典（级联树 / 分区名 / 冲突决策；与 MarketPanel 同一份） */
  cmT: TranslateNS<'config-manager'>
  /** 展示层翻译器（marketDetailView 用；= meApi.t） */
  uiT: UiT
  /** 装回本地状态局部提交（容器实现：写 ref → setState → 镜像切片上抛） */
  patchInstall: (patch: Partial<MyInstallState>) => void
}

export function MyConfigsInstall({
  install, installRef, pickerSelection, repoUrl, importApi, t, cmT, uiT, patchInstall,
}: MyConfigsInstallProps) {
  const { detail } = install
  const detailView = detail !== null ? marketDetailView(detail, detail.repo ?? repoUrl, true, uiT) : null
  return (
    <>
      {/* R-17：下载/导入失败已由全局 Toast 告知（原 install.error Banner 移除）。
          下方 Spinner 以 install.error 为「失败标记」守卫：失败时 detail 恒为 null，
          若不守卫会一直旋转，让用户误以为仍在加载。 */}
      {detail === null && install.error === null && <div className={css.statRow}><Spinner label={t('list.loading')} /></div>}
      {detail === null && install.error !== null && (
        <div className={css.statRow}><span className={css.hint}>{t('myconfigs.install.failed')}</span></div>
      )}
      {detail !== null && detailView !== null && (<>
        <Banner kind="warn"><strong>{t('detail.needReview')}</strong></Banner>
        <div className={css.statRow}>
          <Badge kind={detailView.badge.valid ? 'ok' : 'error'}>{detailView.badge.statusText}</Badge>
          <Badge kind="info">{detailView.badge.sectionsText}</Badge>
        </div>
        {/* 导入审阅（2026-09）：与「浏览条目详情」共用同一个组件（R4d）—— 级联树勾选 +
            就地高风险警示 + 逐项摘要 + 冲突决策 + 导入 + 导入后一键回滚。 */}
        {detailView.canImport && pickerSelection !== null && (
          <MarketImportReview
            importApi={importApi}
            t={t}
            cmT={cmT}
            zipPath={detail.zipPath}
            plan={detail.plan}
            selection={pickerSelection}
            onSelectionChange={(next) => {
              const zipPath = installRef.current?.detail?.zipPath
              if (zipPath === undefined) return
              patchInstall({ selectionState: { zipPath, selection: next } })
            }}
            resolutions={install.conflictResolutions}
            onResolutionsChange={(next) => { patchInstall({ conflictResolutions: next }) }}
            onPlanChange={(plan) => {
              const cur = installRef.current
              if (cur === null || cur.detail === null) return
              patchInstall({ detail: { ...cur.detail, plan } })
            }}
            importing={install.importing}
            onImportingChange={(value) => { patchInstall({ importing: value }) }}
            result={install.importResult}
            onResultChange={(result) => { patchInstall({ importResult: result }) }}
            onErrorChange={(message) => { patchInstall({ error: message }) }}
            itemName={detail.name}
          />
        )}
      </>)}
      {/* R-07：装回本地导入结果已由全局 Toast 送达（原 importResult Banner 移除） */}
    </>
  )
}

/**
 * 配置市场「发布到市场」向导的框架无关渲染/校验模型（m-market-publish，node 可测）。
 *
 * 设计纪律（docs/design/2026-08-19-market-publish-design.md §3.4）：
 *  - 全部无副作用纯函数，React 壳（PublishView）只装配，不承载业务逻辑；
 *  - 5 步流程：选择配置包 → 本地校验 → 生成条目包 → 推送作者仓库 → 提交收录申请；
 *  - 状态组件内自持（同 MarketPanel 策略，不进 sessionStorage）。
 *
 * 安全硬约束（与安全不变量同款）：
 *  - itemId 须过 SAFE_ITEM_ID_RE（防 items/<id>/ 路径越界，assertSafeItemId 同源正则）；
 *  - repoUrl 可选但若填必须为 http(s) 且无 userinfo（轻量等价实现 sync validateRepoUrl 的
 *    语义，不 import node 模块、浏览器/node 双端可跑；凭据永不拼入 URL）；
 *  - 本层只生成 git 命令模板与 index.json 收录片段**文本**，不做任何 git 写操作、
 *    不持有凭据（与 About 页「Star 由用户在 GitHub 完成」同款产品纪律）；
 *  - 内容校验（zip 加固解包 / containsSecrets / SHA-256）在 Host 侧 prepare 端点，本层不管。
 */
import { zhUiT, type UiT } from './i18n.ts'
import { SAFE_ITEM_ID_RE } from '../market/types.ts'

/* ---------------------------------------------------------------- 步骤模型 */

/** 发布向导 5 步（设计文档 §3.4：选择配置包 / 本地校验 / 生成条目包 / 推送作者仓库 / 提交收录申请） */
export const PUBLISH_STEP_IDS = ['select', 'validate', 'prepare', 'push', 'submit'] as const
export type PublishStepId = (typeof PUBLISH_STEP_IDS)[number]

/** 发布向导步骤信息（标题已翻译；React 壳只渲染）。 */
export interface PublishStepInfo {
  id: PublishStepId
  /** 步骤标题（经 UiT 翻译） */
  title: string
}

/** 5 步模型（顺序即流程；文案走 i18n 字典，不硬编码中文）。 */
export function publishSteps(t: UiT = zhUiT): PublishStepInfo[] {
  return [
    { id: 'select', title: t('marketPublish.stepSelect') },
    { id: 'validate', title: t('marketPublish.stepValidate') },
    { id: 'prepare', title: t('marketPublish.stepPrepare') },
    { id: 'push', title: t('marketPublish.stepPush') },
    { id: 'submit', title: t('marketPublish.stepSubmit') },
  ]
}

/* ---------------------------------------------------------------- 字段校验 */

/** 发布向导表单字段（用户填写；全部纯字符串，UI 按需组装）。 */
export interface PublishFormFields {
  /** 条目 id（须过 SAFE_ITEM_ID_RE：字母数字开头，仅 . _ -，最长 128） */
  itemId: string
  /** 条目标题（必填非空） */
  name: string
  /** 条目版本（展示用；空则由 Host prepare 缺省 '1.0.0'） */
  version: string
  description: string
  author: string
  /** 类别（逗号分隔文本；UI 解析为数组，空串 = 无类别） */
  categories: string
  /** 作者托管仓库 URL（**可选**；非空须 http(s) 且无 userinfo，凭据绝不拼入） */
  repoUrl: string
}

/** 空表单初值（React 壳 useState 初始 + 测试用）。 */
export const EMPTY_PUBLISH_FORM: PublishFormFields = {
  itemId: '',
  name: '',
  version: '',
  description: '',
  author: '',
  categories: '',
  repoUrl: '',
}

/** 表单字段错误（null = 该字段合法；文案已翻译）。 */
export interface PublishFieldErrors {
  itemId: string | null
  name: string | null
  repoUrl: string | null
}

/**
 * 发布仓库 URL 合法性校验（返回错误消息；null = 合法）。
 * **可选字段**：空串/空白视为「未填」= 合法；非空须：
 *  - 不含空白字符（\s）；
 *  - http(s) 开头（拒绝 git@ / ssh / ftp 等非 http(s) 形态，市场仓库只走 https clone）；
 *  - authority 段不含 userinfo（`user[:password]@host`），凭据必须走 DSH credentials。
 * 语义与 sync 的 validateRepoUrl 对齐（拒绝 userinfo / 空白），另按市场设计补强「非 http(s) 拒绝」。
 */
export function validatePublishRepoUrl(repoUrl: string, t: UiT = zhUiT): string | null {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    return null // 可选字段：未填 = 合法
  }
  const url = repoUrl.trim()
  if (/\s/.test(url)) {
    return t('marketPublish.repoWhitespace')
  }
  if (!/^https?:\/\//i.test(url)) {
    return t('marketPublish.repoScheme')
  }
  const authority = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? ''
  if (authority.includes('@')) {
    return t('marketPublish.repoUserinfo')
  }
  return null
}

/** 表单校验：itemId（SAFE_ITEM_ID_RE）+ name 必填 + repoUrl 可选校验。返回逐字段错误。 */
export function validatePublishForm(form: PublishFormFields, t: UiT = zhUiT): PublishFieldErrors {
  const errors: PublishFieldErrors = { itemId: null, name: null, repoUrl: null }
  if (!SAFE_ITEM_ID_RE.test(form.itemId)) {
    errors.itemId = t('marketPublish.errorItemId')
  }
  if (form.name.trim() === '') {
    errors.name = t('marketPublish.errorName')
  }
  const repoErr = validatePublishRepoUrl(form.repoUrl, t)
  if (repoErr !== null) errors.repoUrl = repoErr
  return errors
}

/** 表单是否全部合法（generate 按钮可用性 / canProceed 的 prepare 前置）。 */
export function publishFormValid(errors: PublishFieldErrors): boolean {
  return errors.itemId === null && errors.name === null && errors.repoUrl === null
}

/* ---------------------------------------------------------------- git 命令模板 */

export interface GitPushCommandsInput {
  /** 作者公开仓库 URL（调用方应先过 validatePublishRepoUrl；本函数不再校验，纯模板渲染） */
  repoUrl: string
  /** 条目 id（调用方应先过 SAFE_ITEM_ID_RE；本函数不再校验） */
  itemId: string
  /** git clone 目标目录名（本地工作目录） */
  dir: string
}

/**
 * 生成「推送到作者仓库」的 git 命令模板（用户在**自己的公开仓库**里执行；
 * 插件不做任何 git 写操作、不持有凭据）。
 *
 * 语义：clone 空仓库 → 进入 → 建 items/<id>/ → 从发布目录复制条目文件
 * （prepare 产物解压为 `dist/`，含 dist/items/<id>/manifest.json + config.zip）→
 * add → commit → push。
 */
export function buildGitPushCommands(input: GitPushCommandsInput): string[] {
  const { repoUrl, itemId, dir } = input
  return [
    `git clone ${repoUrl} ${dir}`,
    `cd ${dir}`,
    `mkdir -p items/${itemId}`,
    `cp -r ../dist/items/${itemId}/. items/${itemId}/`,
    `git add items/${itemId}`,
    `git commit -m "publish ${itemId}"`,
    `git push origin HEAD`,
  ]
}

/* ---------------------------------------------------------------- index 收录片段 */

export interface IndexEntrySnippetInput {
  /** 条目 id（须已过 SAFE_ITEM_ID_RE） */
  id: string
  /** 条目标题（必填） */
  name: string
  description?: string
  author?: string
  version?: string
  /** ISO-8601 时间（可选；缺省不写入） */
  updatedAt?: string
  categories?: string[]
  /** 作者托管仓库 URL（收录引用必填；UI 传 form.repoUrl，未填时给出提示） */
  repo: string
}

/**
 * 生成「提交收录申请」（PR）时追加进官方 index.json `items[]` 的条目片段
 * （pretty JSON 文本，`JSON.parse` 可直接通过；可选字段空值不写入）。
 * 字段形状与 src/market/index-parser.ts 的白名单解析面一致。
 */
export function buildIndexEntrySnippet(item: IndexEntrySnippetInput): string {
  const entry: Record<string, string | string[] | undefined> = {
    id: item.id,
    name: item.name,
  }
  if (item.description !== undefined && item.description.trim() !== '') {
    entry.description = item.description.trim()
  }
  if (item.author !== undefined && item.author.trim() !== '') {
    entry.author = item.author.trim()
  }
  if (item.version !== undefined && item.version.trim() !== '') {
    entry.version = item.version.trim()
  }
  if (item.updatedAt !== undefined && item.updatedAt.trim() !== '') {
    entry.updatedAt = item.updatedAt.trim()
  }
  if (item.categories !== undefined && item.categories.length > 0) {
    entry.categories = item.categories
  }
  entry.repo = item.repo
  return JSON.stringify(entry, null, 2)
}

/* ---------------------------------------------------------------- 步骤状态机 */

/** 发布向导进度状态（组件内自持；纯函数推导导航）。 */
export interface PublishProgressState {
  /** 当前步骤 */
  step: PublishStepId
  /** 步骤 1 完成：已选择配置 zip */
  zipSelected: boolean
  /** 步骤 2 完成：本地校验通过（dry-run 合法 + 无 secrets） */
  validated: boolean
  /** 步骤 3 完成：条目包已生成（prepare 结果就绪） */
  prepared: boolean
  /** 步骤 4 完成：用户已确认推送指引（可选标记，不阻塞前进） */
  pushAcknowledged: boolean
}

/** 初值（进入发布向导时的状态）。 */
export const INITIAL_PUBLISH_STATE: PublishProgressState = {
  step: 'select',
  zipSelected: false,
  validated: false,
  prepared: false,
  pushAcknowledged: false,
}

/**
 * 当前步骤是否可前进到下一步（纯函数推导，React 壳只装配）：
 * - `select`  ：须已选择配置 zip（zipSelected）；
 * - `validate`：须本地校验通过（validated，dry-run 合法 + 无 secrets）；
 * - `prepare` ：须条目包已生成（prepared，含表单校验通过——生成动作本身以 publishFormValid 为前提）；
 * - `push`    ：引导页无硬性前置（复制命令即可前进到收录申请）；
 * - `submit`  ：最后一步，不可再前进。
 */
export function canProceed(state: PublishProgressState): boolean {
  switch (state.step) {
    case 'select': return state.zipSelected
    case 'validate': return state.validated
    case 'prepare': return state.prepared
    case 'push': return true
    case 'submit': return false
  }
}

/** 线性下一步（最后一步返回 null）。 */
export function nextStepId(step: PublishStepId): PublishStepId | null {
  const i = PUBLISH_STEP_IDS.indexOf(step)
  return i >= 0 && i < PUBLISH_STEP_IDS.length - 1 ? PUBLISH_STEP_IDS[i + 1] ?? null : null
}

/** 线性上一步（第一步返回 null）。 */
export function prevStepId(step: PublishStepId): PublishStepId | null {
  const i = PUBLISH_STEP_IDS.indexOf(step)
  return i > 0 ? PUBLISH_STEP_IDS[i - 1] ?? null : null
}

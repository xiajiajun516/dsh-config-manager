/**
 * 插件自更新（关于页「立即更新」）—— **用户显式点击**后，经官方 `dsh plugin` 通道把本插件
 * 升级到指定版本。这是 update-check（只读探测）之外唯一的写动作，且绝不由「检查更新」自动触发
 * （core/update-check.ts 的语义保持不变：仍然只读、不改盘、不安装）。
 *
 * 六条硬边界：
 *  ① 只在这一个显式入口执行；没有定时器、没有自动升级路径。
 *  ② 目标版本必须是 semver 形态，且**严格大于**当前版本（复用 validator 的同一份比较规则，
 *     预发布版低于同名正式版 —— 不在此另写一套 semver）。
 *  ③ 当前安装来源必须是 registry：依赖 spec 为 link:/file:/git:/workspace:/http(s):
 *     时拒绝 —— 用 registry 包覆盖本地/开发安装（隔离测试 home 就是 `link:`）
 *     会静默破坏开发环境。
 *  ④ `desktop` 档案由桌面应用独占管理（普通 CLI 对它无条件拒绝）→ 不给更新。
 *  ⑤ 安装**钉住精确版本**（`<pkg>@<version>`）而不是裸包名 / @latest：pnpm 11 的
 *     minimumReleaseAge 会把 @latest 解析回「发布满阈值」的旧版，而用户刚刚在界面上看到的
 *     就是这个精确版本 —— 两者必须一致（与 about-view.ts 的升级命令同一决策）。
 *  ⑥ 失败必须如实：exitCode≠0 / 超时 / spawn 失败 → 复用 installErrorFor 的可操作诊断；
 *     成功也只表示**文件已换新**，必须重启 DSH 才生效（调用方回 needsRestart）。
 */
import { compareVersionStrings, isConcreteVersion } from './validator.ts'
import { installErrorFor } from './plugin-cli.ts'
import type { DshPluginResult } from './plugin-cli.ts'
import { PLUGIN_NPM_PACKAGE } from './update-check.ts'
import type { SelfUpdateFailureCode } from '../utils/shared-constants.ts'

/** 目标安装 spec（钉住精确版本；单一拼接点，界面命令与 argv 恒等）。 */
export function selfUpdateSpec(version: string): string {
  return `${PLUGIN_NPM_PACKAGE}@${version}`
}

/** 非 registry 来源的依赖 spec 前缀（与 core/plugin-cli.ts 的安装语义同一口径）。 */
const NON_REGISTRY_SPEC = /^(github:|gitlab:|bitbucket:|git\+|file:|link:|workspace:|https?:)/i

/** 计划输入（全部来自宿主：当前版本、检查结果、运行档案、profile 清单里的依赖 spec）。 */
export interface SelfUpdatePlanInput {
  /** 当前运行的插件版本（PLUGIN_VERSION） */
  current: string
  /** 目标版本（来自 update-check 的 latest） */
  target: string
  /** 当前档案名（host.profile） */
  profile: string
  /** profile package.json 里本插件当前声明的依赖 spec；未安装 / 读不到 → undefined */
  installedSpec?: string | undefined
}

/** 计划结果：可执行的 argv + 可复制命令，或带码的拒绝原因（码由界面映射本地化文案）。 */
export type SelfUpdatePlan =
  | { ok: true; version: string; argv: string[]; command: string }
  | { ok: false; code: SelfUpdateFailureCode; error: string }

/** 纯函数：校验一次自更新请求（零副作用；不读盘、不起进程）。 */
export function planSelfUpdate(input: SelfUpdatePlanInput): SelfUpdatePlan {
  const profile = (input.profile ?? '').trim()
  if (profile === '') {
    return { ok: false, code: 'profile-unknown', error: 'cannot determine the running profile' }
  }
  if (profile === 'desktop') {
    return { ok: false, code: 'unsupported-profile', error: 'the desktop profile is managed by the desktop app' }
  }
  const target = (input.target ?? '').trim()
  if (!isConcreteVersion(target)) {
    return { ok: false, code: 'invalid-version', error: `not a valid version: ${target === '' ? '(empty)' : target}` }
  }
  if (compareVersionStrings(target, input.current) <= 0) {
    return { ok: false, code: 'not-newer', error: `${target} is not newer than ${input.current}` }
  }
  const installedSpec = (input.installedSpec ?? '').trim()
  if (installedSpec !== '' && NON_REGISTRY_SPEC.test(installedSpec)) {
    return { ok: false, code: 'non-registry-install', error: `installed from a non-registry source (${installedSpec})` }
  }
  const spec = selfUpdateSpec(target)
  return {
    ok: true,
    version: target,
    argv: ['add', spec],
    command: `dsh plugin --profile ${profile} add ${spec}`,
  }
}

/** 注入式 runner（生产 = core/plugin-cli.ts 的 runDshPlugin；测试用桩，不真起子进程）。 */
export type SelfUpdateRunner = (
  profileDir: string,
  profile: string,
  pluginArgs: readonly string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<DshPluginResult>

/** 执行依赖：runner + 目标 profile 目录（宿主注入，路由不自己拼路径）。 */
export interface SelfUpdateDeps {
  runner: SelfUpdateRunner
  profileDir: string
  profile: string
  signal?: AbortSignal
}

/** 执行结果：成功（需重启）/ 失败（带码 + 可读原因）。 */
export type SelfUpdateOutcome =
  | { ok: true; version: string; command: string; needsRestart: true }
  | { ok: false; code: SelfUpdateFailureCode; error: string }

/** 执行已通过校验的计划：官方 CLI 通道安装，失败按 installErrorFor 归类（绝不静默）。 */
export async function runSelfUpdate(
  plan: Extract<SelfUpdatePlan, { ok: true }>,
  deps: SelfUpdateDeps,
): Promise<SelfUpdateOutcome> {
  const result = await deps.runner(deps.profileDir, deps.profile, plan.argv, undefined, deps.signal)
  if (result.aborted === true || deps.signal?.aborted === true) {
    return { ok: false, code: 'install-failed', error: 'update aborted' }
  }
  if (result.exitCode !== 0 || result.timedOut) {
    return { ok: false, code: 'install-failed', error: installErrorFor(PLUGIN_NPM_PACKAGE, result).message }
  }
  return { ok: true, version: plan.version, command: plan.command, needsRestart: true }
}

/**
 * DSH 自带目录选择器的解析层。
 *
 * 真机取证（DSH 0.2.1-rc.3，`resources/app.asar` 内）：
 * - 桌面壳把原生选择器挂在全局：`globalThis.__DSH_DIRECTORY_PICKER__.pick(): Promise<string | null>`，
 *   DSH 自己的 `@deepseek-ai/dsh-client-ui-directory-picker-native` 优先用它。
 * - Web 侧走服务：`new UiWorkspaceService(...)` 里 `super(ctx, "uiWorkspace")`，
 *   即服务名是 **uiWorkspace**（不是 workspaces），方法 `pickDirectory(): Promise<string | null>`。
 *
 * 这里只做「按优先级找一个能用的入口」，找不到就抛错交给上层降级：
 * 上层顺序是 DSH 原生 → 插件自己的系统对话框 → 内置浏览器。
 */

/** 桌面壳全局选择器（Electron 侧注入；web 版本没有）。 */
export interface DesktopDirectoryPicker {
  pick?: () => Promise<string | null>
}

/** DSH 客户端服务里只要这个能力。 */
export interface DirectoryPickService {
  pickDirectory?: () => Promise<string | null>
}

/** 解析所需的两个来源（都可缺；测试直接注入替身）。 */
export interface DirectoryPickSources {
  /** `globalThis.__DSH_DIRECTORY_PICKER__` */
  desktop?: DesktopDirectoryPicker | undefined
  /** `ctx.get(name)`：服务名随 DSH 版本变，两个都试。 */
  getService?: ((name: string) => unknown) | undefined
}

/** 服务名按 DSH 版本从新到旧：0.2.x = uiWorkspace，更早 = workspaces。 */
const SERVICE_NAMES = ['uiWorkspace', 'workspaces'] as const

function asService(value: unknown): DirectoryPickService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as DirectoryPickService
  return typeof candidate.pickDirectory === 'function' ? candidate : undefined
}

/**
 * 造一个惰取 thunk：每次都重新读服务（宿主重连/服务重建后旧快照会失效）。
 * 找不到任何入口就抛错 —— 调用方据此归成 `unavailable` 并降级，绝不静默当成「用户取消」。
 */
export function makeDshDirectoryPicker(sources: DirectoryPickSources): () => Promise<string | null> {
  return async () => {
    const desktop = sources.desktop
    if (desktop !== undefined && typeof desktop.pick === 'function') return desktop.pick()
    for (const name of SERVICE_NAMES) {
      const service = asService(sources.getService?.(name))
      if (service?.pickDirectory !== undefined) return service.pickDirectory()
    }
    throw new Error('config-manager: DSH directory picker unavailable')
  }
}

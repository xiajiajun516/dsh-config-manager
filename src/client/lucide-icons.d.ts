/**
 * lucide-react 单图标深路径导入的类型声明（逐图标 tree-shake，详见 Icon.tsx）。
 *
 * 这些 .mjs 深路径无随附类型；NodeNext 下物理文件存在时 TS 不回退通配 ambient，故为每个
 * 用到的图标做精确路径声明。
 *
 * 关键：本文件刻意不含任何顶层 import/export —— 一旦有，文件即变为「模块」，内部的
 * `declare module` 退化为「增量合并(augmentation)」，要求被声明模块已有基础声明；而这些
 * 子路径模块并无基础声明，augmentation 会静默失效（实测恰好部分图标因此报 TS7016）。
 * 保持全局脚本态后，`declare module` 才是真正的全局 ambient 声明，对所有图标一致生效。
 * 图标类型用 lucide 的 ForwardRefExoticComponent 形状内联描述，避免顶层 import。
 *
 * 本文件同时覆盖 vanilla `lucide` 的深路径（`lucide/dist/esm/icons/*.mjs`）—— 那是
 * 形变图标（common/morph-icons.ts）的数据来源，同一套「无随附类型 + 逐图标声明」的约束。
 */

type LucideIconComponent = import('lucide-react').LucideIcon
/** vanilla `lucide` 的图标**数据**（形变图标用；与上者的组件形状不同，勿混用）。 */
type LucideIconNodeData = import('morphicons').IconNode

declare module 'lucide-react/dist/esm/icons/arrow-right.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/check-circle.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/chevron-down.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/chevron-right.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/clock.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/copy.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/database-backup.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/download.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/eye.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/file.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/folder-input.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/hard-drive-download.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/history.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/info.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/lock.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/message-square.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/package-check.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/pencil.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/refresh-cw.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/rotate-cw.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/search.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/trash-2.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/triangle-alert.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/upload.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/x.mjs' { const i: LucideIconComponent; export default i }
declare module 'lucide-react/dist/esm/icons/circle-alert.mjs' { const i: LucideIconComponent; export default i }

/* —— vanilla `lucide`：形变图标的数据（common/morph-icons.ts） —— */
declare module 'lucide/dist/esm/icons/chevron-right.mjs' { const i: LucideIconNodeData; export default i }
declare module 'lucide/dist/esm/icons/chevron-down.mjs' { const i: LucideIconNodeData; export default i }
declare module 'lucide/dist/esm/icons/copy-check.mjs' { const i: LucideIconNodeData; export default i }
declare module 'lucide/dist/esm/icons/copy.mjs' { const i: LucideIconNodeData; export default i }

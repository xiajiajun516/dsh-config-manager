# Client 半（src/client）构建依赖清单 — 给 p3 的输入

> ⚠️ **一次性交接输入，不是当前规范**（2026-10 复核）：§1/§2 记录的依赖与 tsconfig 变更**均已落地**，现状看 `package.json` / `tsconfig.json`；
> §3 的「13 条路由契约」是当时的计划清单，**现已作废**（实际路由见 `docs/modules/*.md` 与 `tests/route/route-parity.test.ts` 的快照，合计 82 条）；§4 的绑定表仍是理解 `src/ui` ↔ `src/client` 分工的快捷索引。
> 保留本文件是因为 `src/client/client-types.ts`、`src/client/api.ts` 与 `docs/design/2026-08-19-about-tab-design.md` 有注释指过来。**不要在这里新增内容。**
>
> 本文件由 p1（client 半）产出，只描述 `src/client/**` 需要的依赖与 tsconfig 变更；
> **p1 未修改 package.json / tsconfig**（按任务约定，构建配置由 p3 负责）。

## 1. 必装依赖

### runtime peerDependencies（`dsh.client.inject` 声明，参考 dsh-ssh package.json）

| 包 | 版本基线 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-client-runtime` | `^0.1.0-rc.6` | ClientContext 类型、slots 运行时 |
| `@deepseek-ai/dsh-client-locale` | `^0.1.0-rc.6` | `ctx.locale` 声明合并（index.ts 用） |
| `@deepseek-ai/dsh-client-ui-settings` | `^0.1.0-rc.6` | `settings.section` SlotMap 声明合并（index.ts 用） |
| `@deepseek-ai/dsh-client-ui-slots` | `^0.1.0-rc.6` | SlotMap / LocaleNamespaceMap / PropsRuntime / TranslateNS |
| `@deepseek-ai/cordis` | `^4.0.1` | Context 基础类型 |
| `react` / `react-dom` | `^18.2.0`（dsh-ssh 同款） | 组件渲染 |
| `@types/react` / `@types/react-dom` | `~18.3.1` / `^18.3.5` | dev 类型 |

`dsh.client` 声明（对照 dsh-ssh）：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-ui-settings"
    ],
    "platform": "web"
  }
}
```

### devDependencies（构建）

| 包 | 用途 |
|---|---|
| `lightningcss` | `^1.32.0`（dsh-ssh 同款）— CSS Modules 编译 |
| `tsdown` | `^0.22.2`（dsh-ssh 同款）— host+client bundle |
| `typescript` | `~5.7.2` 或现有 `^5.9.0` 均可 |

## 2. tsconfig 变更（p3 需加）

现有 `tsconfig.json`：`lib: ["ES2023"]` + `types: ["node"]` + include `src/**/*.ts`。

client 需要：

```jsonc
{
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["node", "react", "react-dom"]        // 或经 @types 自动解析
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.d.ts"]
}
```

> 说明：`src/client/**` 的 `.tsx` 文件当前不在 `include`（`src/**/*.ts` 不匹配 `.tsx`），
> 不影响现有 `npm run typecheck`（core/ui 仍全绿）；p3 打开 `.tsx` 后
> 需一并补齐 DOM lib 与 jsx，否则 client 类型不通过。

## 3. Host 半 `/api/dsh-config-manager/*` 路由契约（**已作废，仅留一条仍有效的约定**）

本节当时列了 13 条路由的计划契约，**现在全部过时**：实际路由合计 82 条（宿主 `src/index.ts` 7 条 + `src/routes/*.ts` 75 条），由 `tests/route/route-parity.test.ts` 的快照钉住；按功能分组的现状说明在 `docs/modules/` 与 `docs/components/client-ui.md`。

仍有效的一条约定（客户端据此分流错误，而不是当「备份损坏」）：**未解锁的整体加密容器（DCA1）** 在 `/analyze`、`/plan`、`/execute` 上一律返回 `400 { code: 'encrypted-container' }`，与 mutation gate 的 `mutation-locked` 同一约定；形态判定实现只有 `src/security/container-kind.ts` 一份。

其余（上传落盘位置、密码开关、错误体形状、路由围栏）以当前代码为准，不再在此维护。

## 4. 与 src/ui 的绑定点（p1 实现摘要）

| src/ui 模块 | client 消费 |
|---|---|
| `export-flow.ts` 的 `ExportFlow` / `DEFAULT_CATEGORIES` | `export/ExportView.tsx`（port=api） |
| `types.ts` 的 `EXPORT_GROUPS` / `ProgressEvent` / `ImportPreviewSummary` | 导出勾选目录 / 进度条 / 预览摘要 |
| `import-wizard.ts` 的 `ImportWizard` | `import/ImportWizardView.tsx`（port=api） |
| `conflict-view.ts` 的 `ConflictCollector` | `import/ConflictList.tsx` |
| `report.ts` 的 `renderExportReport` / `renderImportReport` / `renderRollbackReport` / `importSectionStats` / `importTotals` / `importProblems` | `common/ReportView.tsx` |
| `import-log.ts` 的 `buildImportLogModel` / `filterImportLogEntries` / `importLogLevelIcon` | `import/ImportLogPanel.tsx` |
| `import-stepper.ts` 的 `importStepperModel` / `importStepperSource` | `import/ImportWizardView.tsx` |
| `errors.ts` 的 `toActionableError` / `formatActionableError` | `common/ErrorBanner.tsx` |
| `progress.ts` 的 `stageText` / `ProgressTracker` | `common/ProgressBar.tsx` |
| `security/redaction.ts` 的 `redact` | 全部文本展示前的强制脱敏（双保险） |

> 例外：`ui/path-mapping.ts` 的 `PathMappingEditor` 依赖 `utils/paths.ts`（`node:path`），
> 浏览器 bundle 不可用 —— `import/PathMappingForm.tsx` 做轻量等价实现（输入输出形状
> 与 core `PathMapping` 一致，实际前缀替换由 Host 侧 core 在 `createImportPlan` 阶段执行）。

# Client 半（src/client）构建依赖清单 — 给 p3 的输入

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

## 3. Host 半 `/api/dsh-config-manager/*` 路由契约（client 按此调用）

p1 只做 client 侧 fetch 封装（`src/client/api.ts`），Host 半（`src/index.ts`）按此实现：

```
GET  /api/dsh-config-manager/status        → ServiceStatus { ready, pluginVersion, dshVersion, platform, arch }
POST /api/dsh-config-manager/export        body: { includeSecrets, only?, password? } → ExportResponse { zipPath, manifest, report }
GET  /api/dsh-config-manager/download?path → 文件流（content-disposition: filename="..."）
POST /api/dsh-config-manager/upload?name   body: 原始字节 → UploadResponse { zipPath, name, sizeBytes }
POST /api/dsh-config-manager/analyze       body: { zipPath } → ImportAnalysis
POST /api/dsh-config-manager/plan          body: { zipPath, decisions } → ImportPlan
POST /api/dsh-config-manager/execute       body: { zipPath, plan, opts: { confirm, secretInputs, rollbackOnError } } → ImportResult
```

- `password` 仅加密备份模式传入（Host 侧 `security/encryption.ts` scrypt+AES-256-GCM），
  **绝不写入 manifest / 任何配置**；
- `upload` 落 Host 受控临时目录（如 `~/.dsh/dsh-config-manager/tmp/`），返回的 zipPath
  供 analyze/plan/execute 引用；
- 错误响应统一 `{ error: string }`（client `readJson` 依赖该形状）；
- Host 侧路由安全围栏参考 dsh-ssh `isLoopbackRequest`（仅 127.0.0.1 + 同源）。

## 4. 与 src/ui 的绑定点（p1 实现摘要）

| src/ui 模块 | client 消费 |
|---|---|
| `export-flow.ts` 的 `ExportFlow` / `DEFAULT_CATEGORIES` | `export/ExportView.tsx`（port=api） |
| `types.ts` 的 `EXPORT_GROUPS` / `ProgressEvent` / `ImportPreviewSummary` | 导出勾选目录 / 进度条 / 预览摘要 |
| `import-wizard.ts` 的 `ImportWizard` | `import/ImportWizardView.tsx`（port=api） |
| `conflict-view.ts` 的 `ConflictCollector` | `import/ConflictList.tsx` |
| `report.ts` 的 `renderExportReport` / `renderImportReport` / `renderRollbackReport` / `suggestedActions` / `importSectionStats` | `common/ReportView.tsx` |
| `errors.ts` 的 `toActionableError` / `formatActionableError` | `common/ErrorBanner.tsx` |
| `progress.ts` 的 `stageText` / `ProgressTracker` | `common/ProgressBar.tsx` |
| `security/redaction.ts` 的 `redact` | 全部文本展示前的强制脱敏（双保险） |

> 例外：`ui/path-mapping.ts` 的 `PathMappingEditor` 依赖 `utils/paths.ts`（`node:path`），
> 浏览器 bundle 不可用 —— `import/PathMappingForm.tsx` 做轻量等价实现（输入输出形状
> 与 core `PathMapping` 一致，实际前缀替换由 Host 侧 core 在 `createImportPlan` 阶段执行）。

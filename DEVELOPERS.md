# 🛠️ DSH Config Manager — 开发者 / 维护者文档

> 面向开发者与维护者。**用户请直接看 [README.md](README.md)（英文）或 [README.zh-CN.md](README.zh-CN.md)。**

---

## 📦 开发命令

```bash
npm install --legacy-peer-deps   # 安装依赖（部分 DSH 核心包未发布公共 registry，需跳过 peer 解析）
npm run typecheck                # 类型检查（tsc --noEmit）
npm run build                    # 构建：Host 半 lib/（tsc）+ client bundle lib/client.js（tsdown）
npm run bundle                   # 仅重建 client bundle（tsdown）
npm test                         # 运行全部测试（node --test，192 个）
npm run smoke                    # 仅核心引擎冒烟测试
```

## 🏗️ 架构

```
src/
├── core/       核心引擎（与 DSH 运行时解耦，ConfigAdapter/HostContext 接口 + 内存 mock 可测）
│               exporter / analyzer(三段式) / importer(14步) / backup(快照) / rollback(逆序补偿)
├── schema/     领域类型 / Manifest / 版本判定（集中，CURRENT_SCHEMA_VERSION=1）
├── security/   secret-scanner / redaction / zip-security / integrity / encryption(scrypt+AES-256-GCM)
├── adapters/   12 个真实配置适配器（settings/ui/providers/plugins/mcp/prompts/skills/
│               agentPresets/workspaces/credentials/pluginFiles/sessions）
├── migrations/ schema 迁移链（registry + v1→v2 占位）
├── ui/         框架无关 UI 逻辑层（九步导入向导 / 冲突 / 路径映射 / 进度 / 报告）
├── client/     React 界面（settings.section 挂载，/api/dsh-config-manager/* 调 Host）
├── profiles/   ProfileManager（保存/切换带 Preview+快照+回滚）
└── index.ts    Host 半 Cordis 插件入口（name='config-manager'，7 端点路由）
```

**安全不变量**：Secret 默认不导出 / 导入前强制快照 / Dry Run 零写入 / 冲突不默认覆盖 / ZIP 视为不可信输入 / 日志全程脱敏。

## 🚀 自动发布（npm + GitHub Release）

打 tag 即全自动（`.github/workflows/publish.yml`）：

```bash
npm version patch          # 0.1.x → 0.1.x+1（改版本 + 打 tag）
git push origin main --tags
```

CI 流水线：`typecheck → 192 测试 → build → npm pack → npm publish（OIDC）→ 创建 GitHub Release（tgz 附件 + 自动更新日志）`

- **npm 发布走 Trusted Publishing（OIDC）**：无任何长期令牌；workflow 需 `id-token: write` + npm ≥ 11.5.1（workflow 会先升级 npm）
- 一次性配置（首次）：
  ```bash
  npm login
  npm trust github dsh-config-manager --file publish.yml --repo xiajiajun516/dsh-config-manager --allow-publish
  ```
- `dist/` 目录需先创建（`mkdir -p dist && npm pack --pack-destination ./dist`），否则 npm pack 报 ENOENT

## 🧪 测试矩阵

**192 个测试全部通过**（node:test，零额外依赖），覆盖规范 §33 + 验收场景 A–G：

| 类别 | 覆盖 |
|---|---|
| 导出 | 正常 / 空 / 大配置(1MB+) / Unicode / 特殊字符 / Secret 过滤 |
| 导入 | 正常 / Merge / Replace / Skip(不删目标独有) / Conflict / 缺失插件 / 缺失依赖 / 缺失密钥 / 未确认拒绝 |
| 回滚（场景 E） | 多适配器混合中途失败 → 整体恢复；rollbackOnError=false 对照；部分回滚诚实报告 |
| 迁移（场景 G） | migrateToCurrent 机制级边界（当前 v1 即最新，无真实 v2 可端到端验证） |
| 安全（场景 F） | 恶意 ZIP / 超大条目 / checksum 不匹配 / Zip Slip / 绝对路径 |
| 跨平台（场景 B） | win32↔darwin↔linux 批量前缀映射 |
| 冲突导航（回归） | 只前进的阶段导航（path-mapping 后不回跳 conflicts） |

## 📋 完整技术限制

1. Workspace 只能创建/改标题（DSH 无整体覆盖写通道；路径与会话列表由 DSH 维护）
2. 部分 DSH 核心包未发布公共 npm registry（`dsh-plugin-marketplace` 等）——安装需 `--config.auto-install-peers=false`
3. MCP 无管理 API——以组合 patch 行导入，需重启生效
4. 插件安装需重启（installPlugin 返回 needsRestart）
5. 浏览器 localStorage UI 状态不迁移（Host 无通道）
6. keybindings / workflows 配置 / commands / rules——DSH 无此概念，不实现假分区
7. 凭据值无法回滚（DSH 不回读值，回滚需人工补录）
8. 新建项无法回滚删除（settings 无删除语义）
9. Schema 迁移 v1→v2 为占位（CURRENT=1）
10. 历史会话默认不迁移（v1 仅文件级复制）
11. 加密备份密码丢失无法解密（设计使然）

## 📌 常见坑

- **pnpm 裸名 add 不升级**：`dsh plugin add dsh-config-manager`（无版本）会保留已记录版本；用 `@latest` 或精确版本
- **pnpm 缓存旧 latest 元数据**：`@latest` 可能解析到旧版，用精确版本最稳
- **MemFs 测试路径**：内存 fs 的 key 必须与宿主 path 解耦（POSIX 上 path.resolve 对 win32 home 会注入 cwd）

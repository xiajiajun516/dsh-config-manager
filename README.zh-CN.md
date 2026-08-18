# 🎒 DSH Config Manager

**把你的 DSH 配置打包带走 —— 换台电脑，环境一键恢复。**

[English](README.md) · [简体中文](README.zh-CN.md)

---

## 这是什么？🤔

DSH 是你的 AI 助手工作台，里面存着你的各种设置：模型配置、插件、常用技能、工作区……

**DSH Config Manager 就是它的「搬家工具」**：

```
┌──────────────┐   ① 一键导出    ┌─────────────────┐   ② 一键导入    ┌──────────────┐
│   电脑 A      │ ─────────────► │  dsh-config.zip  │ ─────────────► │   电脑 B      │
│   我的配置     │                │   （一个文件）     │                │  配置全部恢复  │
└──────────────┘                └─────────────────┘                └──────────────┘
```

> ⚠️ **安全第一**：默认**不导出**任何密钥（API Key / Token / 密码）。详见 [安全](#-安全)。

---

## ✨ 核心亮点

| 图标 | 功能 | 一句话说明 |
|:---:|---|---|
| 🚀 | **一键导出** | 点一下，把推荐配置打包成一个 ZIP |
| 📦 | **一键导入** | 在另一台电脑点一下，环境就回来了 |
| 👀 | **先预览再导入** | 导入前完整预览，**绝不偷偷改你的配置** |
| ⚔️ | **冲突处理** | 遇到同名配置，让你自己选：保留现有的 / 用导入的 |
| 🗺️ | **路径自动映射** | 换了电脑路径变了？自动检测并让你重新指定 |
| 🔒 | **密钥安全** | API Key 默认不导出；非加密导入后提醒重新填写，加密备份用密码解锁恢复 |
| ↩️ | **自动回滚** | 导入失败自动恢复原样，不会弄坏现有配置 |
| 📸 | **快照恢复** | 撤销一次导入：整文件还原 + 卸载新增插件（CLI 与 GUI 均支持） |
| 🔄 | **远程同步** | 通过 **Git 私有仓库或 WebDAV** 推送 / 拉取可移植配置（密钥永不参与同步） |
| 🗂️ | **配置档案 Profiles** | 保存多套配置（工作 / 个人），随时切换 |

---

## 📸 功能截图

| 导出备份 | 导入预览 |
|:---:|:---:|
| ![一键导出](assets/screenshot-export.png) | ![导入预览](assets/screenshot-import-preview.png) |

| 快照恢复 | 远程同步 |
|:---:|:---:|
| ![快照恢复](assets/screenshot-snapshots.png) | ![远程同步](assets/screenshot-sync.png) |

---

## 🔄 它是怎么工作的？

### 导出（打包带走）

```
读取你的配置 → 剔除密钥（安全） → 生成清单 → 计算校验和 → 打包成 ZIP
```

### 导入（恢复环境）

每一步都先确认、先备份，**绝不直接改你的配置**：

```
选择 ZIP → 校验文件 → 检查完整性 → 检查版本 → 兼容性检查
    → 扫描内容 → 生成导入计划 → 预览确认
    → 自动备份当前配置 → 执行导入 → 验证 → 完成
                      │
                      └─ 中途失败？→ 自动恢复原样（回滚）
```

---

## 📥 安装

本插件是标准的 **DSH 插件**，安装只需要两步：

```bash
# ① 安装插件
dsh plugin --profile web add dsh-config-manager@latest --config.auto-install-peers=false

# ② 重启 DSH（设置页就会出现「备份与迁移」入口）
```

> 💡 照着复制就行：`--config.auto-install-peers=false` 跳过几个尚未公开发布的 DSH 核心依赖（运行时由 DSH 自己提供），`@latest` 确保装到最新版。
>
> 🐛 **`@latest` 装到了旧版？** 这是 **pnpm 11 的 `minimumReleaseAge` 供应链发布年龄策略**（不是缓存）：发布不足约 30 天的新版本会被排除出版本解析，直到进入白名单。两种解决办法：
> - 装一次精确版本即可自动白名单，之后 `@latest` 正常：
>   ```bash
>   dsh plugin --profile web add dsh-config-manager@0.1.8 --config.auto-install-peers=false
>   ```
> - 或一行命令彻底关闭年龄门槛（在 profile 的 `pnpm-workspace.yaml` 顶部加 `minimumReleaseAge: 0`）：
>   ```powershell
>   $f = "$env:USERPROFILE\.dsh\profiles\web\pnpm-workspace.yaml"
>   $c = Get-Content $f -Raw
>   if ($c -notmatch '(?m)^minimumReleaseAge:') {
>     Set-Content -LiteralPath $f -Value ("minimumReleaseAge: 0`n" + $c) -Encoding utf8
>     Write-Output "已添加 minimumReleaseAge: 0"
>   } else {
>     Write-Output "已存在，无需修改"
>   }
>   ```

---

## 🚀 快速上手（3 分钟体验）

```
电脑 A（导出）
  1. 打开 DSH → 设置 → 「备份与迁移」
  2. 点「导出配置」→ 选「快速导出」
  3. 得到一个 dsh-config-2026-08-14.zip（可确认报告里没有密钥）

把 ZIP 拷到电脑 B（导入）
  1. 打开 DSH → 「备份与迁移」→「导入配置」
  2. 选择 ZIP → 等待分析 → 查看「导入预览」
  3. 有路径问题？→ 选择新路径（可批量映射）
  4. 有同名配置冲突？→ 选择 保留现有的 / 用导入的
  5. 确认导入 → 等待完成
  6. 按提示重新填写缺失的 API Key
  7. ✅ 设置 / 插件 / MCP / 技能 / 工作区 / 全局指令（AGENTS.md）都回来了
```

---

## 🧩 功能详解

### 📤 导出（两种方式）

| 方式 | 说明 |
|---|---|
| **快速导出**（推荐） | 一键导出推荐配置：设置 / UI / 模型 / 插件 / MCP / 技能 / Agent 预设 / 全局指令（AGENTS.md）/ 工作区等 |
| **自定义导出** | 自己勾选要导出的分类 |

> 导出文件：`dsh-config-<日期>.zip`，内含清单 + 各分类数据 + SHA-256 校验和。

### 📥 导入（安全流程）

- **未确认不写入**：分析、预览阶段零修改
- **先备份再导入**：执行前自动备份将被修改的配置
- **失败自动回滚**：按你的选择整体回滚或跳过失败项继续

### 👀 导入预览（Dry Run）

导入前完整展示：

```
✓ 18 项设置将被更新      ✓ 6 个插件已安装
⚠ 2 个插件需要安装       ⚠ 3 个密钥需要重新填写
⚠ 1 个路径需要映射        ⚠ 2 处冲突需要处理
```

### ⚔️ 冲突处理

目标电脑已有同名配置时，让你选：

| 选项 | 含义 |
|---|---|
| **保留现有的** | 不动目标电脑的原配置 |
| **用导入的** | 用备份里的配置覆盖 |

> 说明：刻意**不提供**「稍后决定 / 再看看」选项——未决的冲突会让导入无法继续，每个冲突都必须在继续前做出选择。

### 🗺️ 路径映射

换了电脑，`C:\Users\alice\projects` 在另一台机器上不存在？插件会：
1. 自动检测失效的绝对路径
2. 让你选择新路径
3. 支持**批量前缀映射**（如 `C:\Users\alice\` → `/Users/bob/` 一键替换所有相关路径）

### 🔒 密钥处理

| 场景 | 行为 |
|---|---|
| 默认备份 | **不含任何密钥值**，只记录"哪些密钥需要填写" |
| 加密备份（可选，显式勾选） | scrypt + AES-256-GCM，每次导出随机 salt 与 IV；密钥绝不明文落盘，密码**绝不写入备份文件** |
| 加密备份导入 | 必须输入导出时的加密密码解锁：输入→验证密码→凭据自动恢复，**无密码无法导入** |
| 非加密导入后 | 提示「3 个密钥需要重新填写」，输入后仅保存在内存中写入 |

### 🔄 远程同步（Git / WebDAV）

通过**两种通道之一**在机器间推送 / 拉取可移植配置——除传输方式外，使用方式完全一致：

| | Git 私有仓库 | WebDAV |
|:---:|---|---|
| **端点** | `repoUrl` | `webdav.url` |
| **凭据** | 认证 token 存入 DSH credentials（`DSH_CONFIG_MANAGER_SYNC_TOKEN`） | `username` 存配置、可在界面回显；**密码永不同步、永不记日志**——存入 DSH credentials `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD` |

- **两通道保留策略一致**：远端只保留最新 **10** 个快照（`MAX_REMOTE_SNAPSHOTS=10`），更旧的自动删除。
- **切换通道重新开始**：Git 与 WebDAV 的快照 / 共同祖先**互不共享**。切换通道后，同步从新远端的空基线重新开始——请先推送一个新快照。
- **WebDAV 认证**采用 HTTP Basic：`username` 存配置、可在界面回显；`password` 则实时从 DSH credentials 槽位 `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD` 读取——绝不出现于任何同步文件或日志。
- **插件自动安装**：拉取差异时，备份里新增的插件会在确认导入时**自动安装**，无需在差异列表里逐项手动勾选；只有**版本冲突**的插件仍需要你决定「保留当前 / 采用备份」。

### 🗂️ 配置档案（Profiles）

保存多套配置（如「工作」「个人」），随时切换；切换同样带预览 + 自动备份 + 回滚。

### 📸 快照恢复（撤销一次导入）

每次导入都会先创建**安全快照**。导入后如果觉得哪里不对劲，可以把目标环境恢复到导入前的状态：

| 动作 | 说明 |
|---|---|
| 整文件还原 | settings.yaml / settings.json / cordis.patch.yml 的 blob 写回 `$DSH_HOME`；快照时不存在、导入后新增的文件会被移除 |
| 插件卸载 | 导入期间新增的插件经官方 `dsh plugin remove` 卸载（与基线对比；旧快照无基线时只给提示） |
| 文件补偿 | skills / agentPresets / agentInstructions / pluginFiles / sessions 的 blob 写回原路径 |
| 凭据 | DSH 不回读凭据值——只提示人工重新填写 |

**GUI**：设置 → 「备份与迁移」→「快照恢复」tab → 选择快照 → 预览恢复计划（dry-run，零写入）→ 确认执行。

---

### 🚨 CLI —— DSH 挂了时的第一救急手段

GUI 住在 DSH *里面* —— DSH 起不来时，GUI 也帮不了你。而 `dsh-config-manager` 的 **CLI 完全独立于 DSH 运行时**（纯 Node + 核心引擎，**绝不 import `@deepseek-ai/*`** —— 即使 DSH 的 peer 包损坏或缺失也照常运行）。因此它是你在**配置损坏、GUI 无法启动、或换新机器要还原环境**时的**第一救急工具**。

它是一个独立的 npm 命令行工具，**需单独安装**（与插件安装是两回事）。在任意可能需要救急的机器上装一次即可：

```bash
# --omit=peer：离线 CLI 只需要 js-yaml，不需要 DSH 的 peer 依赖包
npm install -g dsh-config-manager@latest --omit=peer
```

> ⚠️ 只安装/更新插件（`dsh plugin --profile web add ...`）只启用 GUI，**不会**产生 `dsh-config-manager` 命令。请先执行上面这条安装命令，然后使用下面任意命令。

全部命令（`dsh-config-manager help` 也会列出）：

```text
dsh-config-manager help                                        # 列出全部命令与参数
dsh-config-manager snapshots [--data-dir <dir>]                # 列出快照（最新在前）
dsh-config-manager restore [--id <id>] [--dry-run]
                           [--profile <name>] [--settings <path>]
dsh-config-manager reinstall [--version <v>] [--yes] [--list]
                             [--wipe-config] [--dry-run]       # 一键重装 DSH 程序本体
```

**`reinstall` —— DSH 损坏时的救急重装。** 跨平台一键重装 `@deepseek-ai/dsh` 启动器（按操作系统自动选用正确命令：Windows 走 PowerShell、Unix 走 bash）。默认重装启动器 + 清全局残留缓存；交互式多选会询问是否勾选**危险**清理项（设置 / 插件 / 会话与凭据）——这些**默认不勾选**，且只要涉及删数据的动作，执行前都必须**二次确认输入 `YES`**。清空 `~/.dsh` 数据前会先做一份 `.reinstall-backup` 紧急备份（`snapshots/` 目录按设计绝不触碰）。

```bash
# 查看可选清理项
dsh-config-manager reinstall --list

# 交互式：选择清理项 → 确认 → 重装 DSH
dsh-config-manager reinstall

# 非交互：全部勾选并跳过确认
dsh-config-manager reinstall --yes

# 连配置数据一起清（等价于勾选全部数据项）——仍会要求交互确认
dsh-config-manager reinstall --wipe-config

# 只预览执行计划，不真正运行
dsh-config-manager reinstall --dry-run
```

**快照恢复。** 列出并恢复安全快照（恢复引擎内置于 CLI，无论 DSH 能否启动都能用）：

```bash
dsh-config-manager snapshots                                  # 列出快照（最新在前）
dsh-config-manager restore --dry-run                          # 预览恢复计划（零写入）
dsh-config-manager restore --id <snapshot-id>                 # 执行恢复（先备份当前文件）
```

每次覆盖/删除前都会先把当前文件复制到 `<snapshotDir>/pre-restore/`，可人工反悔。任一动作失败则退出码为 1；报告如实列出 已还原 / 已卸载插件 / 需人工处理 / 失败 / 跳过。

**典型救急流程**（DSH 起不来时）：① `dsh-config-manager reinstall` 先把启动器重装回来（必要时顺带清理），② `dsh web` 重新启动 DSH，③ 从仓库装回插件，④ 从远程仓库拉取快照（或执行 `dsh-config-manager restore`）把配置恢复回来。整个流程中 CLI 全程可用，与 DSH 是否健康无关。

---

## 🛡️ 安全

- **默认备份不包含任何密钥值** —— 这是硬性规则，导出时强制执行
- **默认不导出**：API Key / 密码 / Token / Cookie / 会话 / 设备唯一 ID / 日志缓存 / 插件二进制
- **ZIP 是"不可信输入"**：防御 Zip Slip、恶意路径、压缩炸弹、损坏文件——任何一项触发就整体拒绝
- **日志全程脱敏**：密钥值永不进入日志
- **加密备份（显式选择）**：密钥仅以 scrypt + AES-256-GCM 密文导出——每次导出随机 salt 与 IV，绝不明文；密码只在内存中，绝不写入文件

---

## 🤝 兼容性

| 状态 | 含义 |
|---|---|
| ✅ Excellent | 同平台、配置齐全、版本兼容 |
| 👍 Good | 备份来自更旧版本的 DSH |
| ⚠️ Partial | 跨平台 / 部分配置缺失 / 备份比当前新 |
| ❌ Unsupported | 备份版本超出支持范围（无法导入） |

---

## ❓ 常见问题

**Q：备份会包含我的 API Key 吗？**
默认不会。默认备份**绝不包含任何密钥**，只记录哪些密钥需要重新填写。若你显式选择**加密备份**，密钥才会包含在内，但仅以 scrypt + AES-256-GCM 密文存在（每次导出随机 salt 与 IV）——绝不明文。

**Q：导入会不会覆盖我现有的配置？**
不会偷偷覆盖。有冲突时让你选择：保留现有的 / 用导入的；导入前还会自动备份，失败可回滚。

**Q：换电脑（Windows → macOS）能用吗？**
能。插件会自动检测失效的绝对路径，让你重新映射（支持批量替换）。

**Q：导出的 ZIP 被改坏了还能导入吗？**
不能。校验和检查不通过会直接拒绝导入（防止损坏或篡改）。

**Q：重复导入会重复吗？**
不会。按插件 ID / MCP 名称 / 技能名等稳定标识去重，重复导入自动跳过已有项。

**Q：加密备份导入时需要密码吗？**
需要。导入向导会要求输入导出时设置的加密密码并验证通过后才能继续执行；密码仅存于内存、绝不保存。密码错误或缺失都会阻止导入（密码正确时凭据直接从备份解密恢复，无需重新填写）。

---

## 📋 已知限制（用户须知）

1. **安装/更新插件或 MCP 后需重启 DSH 才生效**
2. **部分界面状态不迁移**（如任务看板数据、面板宽度——它们存在浏览器里，不在 DSH 配置文件内）
3. **keybindings / workflows 配置 / commands**：DSH 当前没有这些概念，因此不会导出相关内容。全局 agent 规则已由**全局指令（Agent Instructions）**承接（`~/.dsh/AGENTS.md`，注入每个会话）；项目级 `AGENTS.md` / `CLAUDE.md` 属于各项目仓库本身，不在个人配置迁移范围内
4. **历史会话默认不迁移**（v1 仅支持文件级复制）
5. **加密备份**：密码丢失则无法解密（设计使然——请牢记密码）
6. **快照恢复是离线的、诚实的**：离线引擎无法恢复的条目（快照无整文件备份时的 settings namespace / patch 行、存在 DSH storages 里的 workspace 记录）会如实列为跳过并指向在线回滚；凭据**值**绝不自动改写（只提示人工补录）；无插件基线的旧快照只提示人工核对新增插件

> 维护者与开发者：构建、测试、自动发布与完整技术说明见 [DEVELOPERS.md](DEVELOPERS.md)。

---

**产品原则**：宁可少迁移一个配置，也不要破坏你现有的配置。任何导入都遵循 `分析 → 预览 → 备份 → 修改 → 验证 → 回滚(如需要)`；任何密钥都遵循 `不默认导出 / 不记日志 / 不暴露 / 不静默转移`。

# 配置管家 · dsh-Go 原生插件

配置管家在 dsh-Go（Android）原生界面里的入口。不需要打开网页版：读状态、导出、导入、同步、
恢复都在手机原生面板里完成。

- 包名：`local-dsh-config-manager-go`（`package.json.name` / `cordis.patch.yml` id+name /
  `lib/index.js` 的 `export const name` 三处一致，`test/manifest.test.mjs` 钉住）
- 最低 App：`minApp = 1.0.16`（视图 v2 输入组件与 files 能力从这一版起可用）
- 依赖：宿主插件 `dsh-config-manager` 必须同时启用（本插件只做界面，数据全部来自它的
  `/api/dsh-config-manager/*` 路由）

## 安装

```bash
# 1) 把插件包放进引擎可见的目录（本机引擎）
dsh plugin --profile web add integrations/dsh-go/config-manager

# 2) 让 App 重新载入插件（改过 lib/ 之后每次都走这一步）
#    App：设置 › 插件 › 已安装 › 重启内核以重载
```

安装后四个面板出现在 **全部功能**（features）与 **对话详情·插件页签**（session.tab）；
加号旁的「配置管家」工具与对话操作区各有两个快捷入口，输入框上方有一条同步状态条。

## 面板

| 面板 | 内容 | 读/写 |
| --- | --- | --- |
| 概览 `overview` | 版本、当前档案、引擎与同步健康、诊断入口 | 只读（诊断跳网页版） |
| 产物库 `library` | 快照与导出备份混排，按 capabilities 分派动作 | 读 + 删除/恢复 |
| 同步 `sync` | 传输/仓库/基线、差异逐项与批量裁决、应用、回滚 | 读 + 写 |
| 导入导出 `flow` | 导入向导（选文件→上传→Plan→裁决→执行→结果）与导出 | 写 |

槽位预算：面板 4/4、`composer.tools` 2/2、`session.actions` 2/2、`composer.strip` 1/1。
第 5 个面板不会出现，新入口只能加在已有槽位里。

## 每个写操作的同一条链路

选目标 → 上传 → 解析 → 生成计划 → 展示差异 → 二次确认 → 执行 → 轮询进度 → 结果/失败原因。

- **导入**先 `POST /plan` 试运行（宿主零写入）；冲突不默认覆盖，逐项或批量裁决后必须重跑计划；
  执行只提交这一份 plan，`opts.confirm=true`、`rollbackOnError=true`，不传 `secretInputs`
  （手机上不写凭据）。
- **恢复**先 `POST /restore {dryRun:true}` 拿 `planFingerprint`，执行时原样带回；宿主锁内重比，
  不符回 409 `plan-changed`。手机端不自动重启、不自动覆盖。
- **同步**先 `POST /sync/sync` 拉差异，逐项/批量 `adopt` 后 `/sync/apply-items`；
  批量裁决覆盖全部可裁决项、只排除 `Error`（与 web 版 `isBulkDecidable` 同口径）。
- **导出**产物先落宿主 exports 目录，再尝试复制到 `/sdcard/Download/DSH-Go`（需要 App 打开
  「挂载手机存储」）；复制失败时如实给出宿主路径而不是假装成功。

长任务不在 handler 里 await（3 秒预算）：起后台 promise，界面靠 `emit`/`refresh` 与
`/runs?scope=recent` 轮询看进度；同一时刻只允许一个写任务（单飞行槽）。

## 安全

- `includeSecrets` 恒 `false`；密码只存内存、不进视图、不进日志、不落盘。
- 视图与报告渲染前一律过 `redact()`（`lib/redact.js` 是宿主 `src/security/redaction.ts` 的
  同语义副本，`test/redact.test.mjs` 用语料逐字比对，宿主改口径这里会红）。
- 不改 dsh-Go 源码与生成物；宿主 SAFE MODE 与既有门禁原样复用。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 设置页「插件」那一行仍是「网页版」 | 原生面板只映射到 `features`/`session.tab`/`chat.panel`/`plugin` 四个槽位，`settingsSection` 槽位没有 native occupant；入口点是「全部功能 → 配置管家」一步之差。见 `docs/evidence/dsh-go-native-plugin.md` |
| 加密备份不能在手机上导入 | 视图组件没有密码类型（协议明文禁止），明文输入密码违反不变量 ⇒ 加密容器只提示改到电脑端解锁 |
| 远程主机模式没有文件选择 | `files` 只在 Android 本机引擎可用（远程中继不转发 `/dsh-go/*`），面板不显示选文件按钮，只提示改到电脑端 |
| 导出到手机依赖「挂载手机存储」 | 未开启时只能拿到宿主绝对路径（可复制） |
| 凭据项在手机端不写入 | `opts.secretInputs` 不传 ⇒ 缺凭据的项按 `MissingSecret` 跳过，需到电脑端补齐 |

## 开发

```bash
cd integrations/dsh-go/config-manager
node --test test/*.test.mjs                                  # 29 项：清单/字典/红action/预算/守卫
cd ../.. && node .tmp/dsh-go/sdk/plugin-kit/bin/check.mjs \
  integrations/dsh-go/config-manager --load --lang zh        # 退出码 0 = 四个面板都能显示
```

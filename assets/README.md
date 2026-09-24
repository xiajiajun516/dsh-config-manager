# Screenshots / 截图说明

`assets/` 存放提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表时用的插件截图。图片**必须托管在 GitHub**（本仓库即可），第三方图床会被站点构建拒绝。

## 使用方式

1. 在 DSH 中打开本插件的「备份与迁移」界面，截取关键画面（导出向导 / 导入预览 / 快照恢复 / 同步）。
2. 将图片放入本目录，推荐 PNG，命名与 `screenshots.json` 中一致。
3. 提交并推送本仓库到 GitHub（图片通过 `raw.githubusercontent.com` 被引用）。
4. 向 `awesome-dsh-plugin` 仓库发 PR 时，把仓库根目录的 `screenshots.json` 一并提交。

> 本仓库根目录的 `screenshots.json` 是给 awesome-dsh-plugin 用的模板：
> 图片 key 必须与该插件条目在 `data/plugins/xiajiajun516__dsh-config-manager.yml` 中的 `url` 完全一致。

## 建议截图（1–8 张）

| 文件名 | 内容建议 |
|---|---|
| `screenshot-overview-en.png` / `screenshot-overview-zh.png` | 总览（Overview） |
| `screenshot-backups-en.png` / `screenshot-backups-zh.png` | 备份与快照列表 |
| `screenshot-export-en.png` / `screenshot-export-zh.png` | 一键导出界面 |
| `screenshot-import-en.png` / `screenshot-import-zh.png` | 导入向导第一步（选择 ZIP 文件） |
| `screenshot-sync-en.png` / `screenshot-sync-zh.png` | 远程同步界面 |
| `screenshot-market-en.png` / `screenshot-market-zh.png` | 配置市场界面 |
| `screenshot-profiles-en.png` / `screenshot-profiles-zh.png` | 档案（DSH Profiles）界面 |

命名规则：`screenshot-<页面>-<语言>.png`；`-en` 供仓库根 `README.md` 引用，`-zh` 供 `README.zh-CN.md` 引用，7 个页面共 14 张。改名或换图后必须同步 `screenshots.json`，并向 `awesome-dsh-plugin` 提交更新，否则列表页的图片链接会 404。

图片内容、张数、顺序随时可以改——换图时同步更新 `screenshots.json` 并提交新的 PR（只改自己那条）。

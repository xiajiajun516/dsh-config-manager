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
| `screenshot-export.png` | 一键导出界面 |
| `screenshot-import-preview.png` | 导入前预览（dry-run） |
| `screenshot-snapshots.png` | 快照恢复列表 |
| `screenshot-sync.png` | 远程同步界面 |
| `screenshot-market.png` | 配置市场界面 |

图片内容、张数、顺序随时可以改——换图时同步更新 `screenshots.json` 并提交新的 PR（只改自己那条）。

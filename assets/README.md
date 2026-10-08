# Screenshots / 截图说明

`assets/` 存放提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表时用的插件截图。图片**必须托管在 GitHub**（本仓库即可），第三方图床会被站点构建拒绝。

## 使用方式

1. 在 DSH 中打开本插件的「备份与迁移」界面，截取关键画面（首页 / 产物库 / 同步 / 环境四个一级页面各一张）。
2. 将图片放入本目录，推荐 PNG，命名与 `screenshots.json` 中一致。
3. 提交并推送本仓库到 GitHub（图片通过 `raw.githubusercontent.com` 被引用）。
4. 向 `awesome-dsh-plugin` 仓库发 PR 时，把仓库根目录的 `screenshots.json` 一并提交。

> 本仓库根目录的 `screenshots.json` 是给 awesome-dsh-plugin 用的模板：
> 图片 key 必须与该插件条目在 `data/plugins/xiajiajun516__dsh-config-manager.yml` 中的 `url` 完全一致。

## 建议截图（1–8 张）

| 文件名 | 内容 |
|---|---|
| `screenshot-overview-en.png` / `screenshot-overview-zh.png` | **首页**（Home：状态条 + 立即备份 / 导出 / 导入 / 远程同步 + 最近活动） |
| `screenshot-backups-en.png` / `screenshot-backups-zh.png` | **产物库**（Artifact library：源筛选 + 扁平列表 + 底栏「手动导出 / 从文件导入 / 逛市场 / 发布到市场」） |
| `screenshot-sync-en.png` / `screenshot-sync-zh.png` | **同步**（Sync：Git / WebDAV / 对象存储 / Gist 四条通道卡） |
| `screenshot-profiles-en.png` / `screenshot-profiles-zh.png` | **环境 · 档案**（Environment → Profiles：运行状态 + 全部档案） |

> **文件名沿用 v1 时代的槽位名**（`overview` / `backups` / `sync` / `profiles`），与现在的页面名一一对应关系见上表 —— 这样换图不会动 `screenshots.json` 里的 URL。
> 命名规则：`screenshot-<槽位>-<语言>.png`；`-en` 供仓库根 `README.md` 引用，`-zh` 供 `README.zh-CN.md` 引用，4 个槽位共 8 张。**改名**（而非换图）必须同步 `screenshots.json`，并向 `awesome-dsh-plugin` 提交更新，否则列表页的图片链接会 404。

图片内容、张数、顺序随时可以改——换图时同步更新 `screenshots.json` 并提交新的 PR（只改自己那条）。

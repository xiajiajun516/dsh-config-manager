# OpenDesign 优化备料（dsh-config-manager）

> 目的：把「用 OpenDesign 重做插件前端」从一句想法变成可执行的投喂包。
> 结论先行：**库里没有一份能直接读懂本插件的文档，这份目录就是那份文档。** OpenDesign 只能看见你给它的 HTML/文字，看不见仓库。

## 这个目录是什么

| 文件 | 给谁看 | 内容 |
| --- | --- | --- |
| `00-brief.md` | OpenDesign（直接投喂） | 自包含的 brief：产品背景、画布、必须保留的功能、禁止项、交付格式 |
| `01-canvas-and-tokens.md` | 双方 | 画布尺寸、字体、颜色三层、83 个 `--cm-*` token、字号/间距/圆角/控件高档位 |
| `02-screen-home.md` | 双方 | 首页内容清单、区块顺序、状态矩阵、每块的真实数据形状 |
| `03-screen-library.md` | 双方 | 产物库同上（筛选/搜索/行/展开态/底栏） |
| `04-rules.md` | DSH（落地时自检） | 落地硬约束与验收口径：什么能做、什么一改就违规 |
| `05-baseline.md` | DSH | 真机基线截图的缺口、成因、两种补法 |
| `06-opendesign-runbook.md` | DSH | 实际投喂步骤：怎么建项目、怎么出 3 张风格票、怎么评审、怎么落到 React |

## 阶段与产物

- **A 备料（本目录）** ✅ 事实、约束、清单、基线缺口
- **B 方向（3 张风格票）** 同一份 brief、同一 564×720 画幅，用 3 套 design system 各出 1 张首页稿 → 用户选 1
- **C 全量稿** 4 页 + 3 个关键流程（导出确认 / 导入确认 / 同步差异确认），各覆盖 空·加载·错误·长列表
- **D 落地** 手写 React + CSS Modules，顺序 home → library → environment → sync
- **E 验收** typecheck / test / build + bundle 扫描 / 截图并排 / CHANGELOG / SemVer MINOR

## 三条铁律（写给 DSH 自己）

1. **OpenDesign 的 HTML 永不进 bundle**。它是**结构 + 视觉规格**，落地一律手写 React 组件 + 往 `config-manager.module.css` 里加类。
2. **OpenDesign 的配色必须能换算成 token 增量**。它给出 `#5e6ad2` 这种字面量时，我们要问的是「映射到哪个 `--cm-*`、缺哪一档、兜底值是什么」，不是把它抄进 TSX。
3. **功能入口一个都不能少**（用户 2026-11-07 定：允许合并与重排区块，但保留全部功能入口）。清单见 `02`/`03` 的「功能入口清单」小节，评审时逐条打勾。

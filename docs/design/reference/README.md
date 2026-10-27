# 外部参考（只读）

这里保存第三方 DESIGN.md 分析的**逐字副本**，作为 `docs/components/cli-rescue-console.md` 的出处依据。
它们**不是**本仓库的规范：本仓库的 UI 规范是根目录 `DESIGN.md`。

| 文件 | 来源 | 用途 |
|---|---|---|
| `ibm-DESIGN.md` | https://github.com/VoltAgent/awesome-design-md 的 `design-md/ibm/DESIGN.md` | 救急台亮色：语义四色、surface 画布、12–18px 字阶、按钮/表单/卡片状态、间距阶 |
| `raycast-DESIGN.md` | 同上，`design-md/raycast/DESIGN.md` | 救急台暗色：surface 阶梯与四个语义 accent |

原仓库 MIT 许可。这些文件描述的是**公开可见的 CSS 值**，不代表对任何品牌视觉资产的所有权；
本项目只从中提取通用设计令牌，不使用任何品牌标识、字体文件或图片资源。

更新方式（如需升级版本，逐字替换并重跑 `npm test`）：

```powershell
$slug='ibm'
Invoke-WebRequest "https://raw.githubusercontent.com/voltagent/awesome-design-md/main/design-md/$slug/DESIGN.md" -OutFile "docs/design/reference/$slug-DESIGN.md"
```

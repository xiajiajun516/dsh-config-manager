# 04 · 落地硬约束与验收口径

> 这份不是给 OpenDesign 的，是给「把手稿搬进仓库」的人（DSH）的自检表。
> 每条都对应仓库里一道真实存在的守卫或一份权威文档，违反即 CI 红或评审打回。

## 1 什么算「可以做」

用户 2026-11-07 拍板（原文「1 推荐，2 推荐，3 推荐，4 跟随宿主」）：

- ✅ 合并区块、重排区块顺序（**例外**：读取失败横幅必须在状态条之前）
- ✅ 换掉容器形态（卡片 → 数据带、表格 → 时间轴）
- ✅ 新增/删除**装饰性**元素
- ✅ 用新 token 表达新层级（但必须先写进 `DESIGN.md`）
- ❌ 删掉任何功能入口（`02`/`03` 的清单即验收对象）
- ❌ 引入第二套视觉体系（新图标库、新字体、新圆角体系、动画库）
- ❌ 加依赖（运行时只有 `js-yaml`；UI/CSS/图标/动画/工具库一律不加）
- ❌ 浅色/深色两套对照稿（只跟随宿主 token，不做 `prefers-color-scheme`）

## 2 一成不变的边界

| 边界 | 硬规则 | 守卫 |
| --- | --- | --- |
| 颜色 | 组件只写 `--cm-*`；`--dsw-*` 只出现在 `--cm-*` 定义行；无字面量色值；tint 用 `color-mix` | `src/client/css-token-guard.test.ts` |
| 字号/间距 | 只许 token 档位；TSX 里禁 `fontSize` 字面量、禁 `padding/margin/gap` 字面量 | 同上 + `css-scale-guard.test.ts` |
| 样式载体 | 只进 `src/client/config-manager.module.css`；禁内联 `<style>`、禁第三方 css | 同上 |
| 图标 | 只 `lucide-react`，经 `common/Icon.tsx` | 代码评审 + bundle 扫描 |
| 形变动画 | 只有 `ExpandChevron` / `CopyStateIcon`（`morphicons`） | 评审 |
| 原语 | 先用 `common/ui.tsx` 的 15 个原语，能解决就不新建 | 评审（复用优先 ①②③④） |
| 文案 | 禁硬编码，必须进字典（zh 逐字保留 + en 补齐） | `tests/i18n-hardcoded-guard.test.ts` |
| 高度 | 长列表/大报告限高内滚（`*Scroll` 系列），禁撑长整页 | `DESIGN.md` §9c |
| bundle | client 不得 import node 模块；构建后单独跑 bundle 扫描 | `src/client/bundle-selfcontained.test.ts` |

## 3 OpenDesign 稿件 → React 的搬运规则

1. **HTML 永不进 bundle**。它只当规格；落地是手写 TSX + 往 module.css 加类。
2. 每个 `data-block` 对应一个 TSX 区块，类名沿用语义名（CSS Modules 会哈希，名字只影响可读性）。
3. 稿里的 `:root` 变量表 = 我们的「token 增量申请单」：逐条映射到既有 `--cm-*`；映射不上的列出来，先改 `DESIGN.md` 再加。
4. 稿里的 hover/active/focus 态必须显式写出来才搬（原生焦点环走 `--cm-focus-color`，鼠标输入时宿主会置 transparent）。
5. 稿里的静态数字换成真实数据源（`overview-view.ts` / `artifact-view.ts` 的视图模型），**不许在组件里算业务数字**。
6. 空/加载/错误三态，点评测时按 `02`/`03` 的状态矩阵逐格对照，缺一格打回。

## 4 验收命令（顺序固定）

```
npm run typecheck
npm test                       # 含 css-token-guard / css-scale-guard / i18n-hardcoded-guard
npm run build                  # 动了 client/样式必须跑
node --test src/client/bundle-selfcontained.test.ts   # Build 之后单独跑
```

大改再加 `npm run smoke`。

## 5 交付前逐项判定

- [ ] 功能入口清单 100% 打勾（`02` §6 / `03` §7）
- [ ] 三态（空/加载/错误）都有实现，且与矩阵一致
- [ ] 未知值没有显示成 0
- [ ] 564×720 下无横向滚动、无底部 >40px 空带
- [ ] token 守卫、scale 守卫、i18n 守卫全绿
- [ ] 新文案 zh/en 双份
- [ ] `CHANGELOG.md` 的 `## [Unreleased]` 有一条用户能看懂的条目
- [ ] SemVer 判定为 MINOR（视觉重构但功能不减 = 兼容新增/改进）
- [ ] `DESIGN.md` 若改了 token/scale/页级模式，同步更新
- [ ] 截图并排（before / after）进 commit 描述或 PR

## 6 明确不做（避免 scope drift）

- 不改 host 端（`src/index.ts` / `src/routes/`）与任何 API 契约
- 不改 `src/ui/` 视图模型的业务判定（只允许为了新结构新增派生字段，且带单测）
- 不重做 `sync` 页交互流程（D 阶段最后才碰，且只做视觉层）
- 不动聊天气泡回退入口（`.chatEntryScope`）

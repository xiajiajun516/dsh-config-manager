# 08 · 落地记录：tile → React（Stage D）

> 记录 tiles 里哪些视觉决定真的进了 `src/client/`，哪些没进以及为什么。
> 后续谁再改这几页，先看这里避免把已经论证过的取舍重新翻一遍。

## 已完成（2 页）

| tile | React 落点 | 改了什么 |
| --- | --- | --- |
| `tiles/home-T1-linear.html` | `src/client/home/HomePanel.tsx` + `config-manager.module.css` | 状态条由单行改**两行式**：上行 `.statTop` 只放健康点与文案；下行 `.statMetrics` 四列等宽（`.statSeg` = `.statSegLabel` 11px 在上 + `.statSegValue` 的 `b` 13px 与 `.statSegDim` 11px 在下）。旧写法「名词 + 值 + 补充值挤一行」废弃。 |
| `tiles/sync-T1-linear.html` | `src/client/sync/SyncChannelEntryCard.tsx` | 通道卡由「标题行 + 徽章行 + 远端事实格 + 动作行」四段压成**单行 `.channelRow`**：展开箭头 · 名称 · ⓘ · 已配置徽章 · 凭据徽章 · 远端 mono 预览 · 上次同步 · 配置 · 解除连接。`.factGrid` 与标题行删除。 |

两处判据已同步写回 `DESIGN.md`（「状态条」一节整段重写为两行式），不是只在代码里改掉了事。

## 明确不做（有理由，别重开）

| tile 里的做法 | 为什么没做 |
| --- | --- |
| `tiles/library-T1-linear.html` 把 5 个来源筛选与搜索框并成一行 | `src/client/library/files-layout.test.ts` 的「布局-03」要求 `.libraryFilters` 与 `.librarySearch` 都是 `flex: none`（这两条不许被列表挤扁）。一行塞不下 5 个带计数的来源筛选，硬塞会把来源裁掉。**产物库保持「筛选一行 + 搜索一行」**，其余（行高、两段式行、能力按钮）与 tile 一致。 |
| `tiles/environment-T1-linear.html` 把「档案列表」与「维护与诊断」合并成一页四段 | `RecoveryPanel` 内容很长，合并会把这一页拉成长卷轴，收益低、回归面大。**保持两个子视图**。 |

## 绕不开的守卫（改这几页前先读）

- `src/client/css-scale-guard.test.ts`：字号只 11 / 12 / 12.5 / 13px；圆角只 0 / 4 / 6 / 8 / 999 / 50%；行高只 1.25 / 1.5；间距只 0 / 1 / 2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 24（另有 38 / 22 / -4px 豁免）。
- `src/client/css-token-guard.test.ts`：组件只能写 `--cm-*`；`--dsw-*` 只准出现在定义行；TSX 里禁 `var(--dsw-`、像素字号、色值、padding/margin/gap 字面量。
- `src/client/common/info-hint-guard.test.ts` 的「t6-1」：`channel.openHint` 必须仍以 `<InfoHint text={t('channel.openHint')} label={t('common.infoHint')} />` 出现 —— 想省掉这枚 ⓘ 改成 `title` 会失败。
- `src/client/library/files-layout.test.ts`「布局-03」：见上表。

## 验证口径（本次实际跑过）

```bash
npm run typecheck                       # exit 0
npm test                                # 5439 tests / 5437 pass / 0 fail / 2 skipped
TEMP=.tmp/buildtmp TMP=.tmp/buildtmp npm run build
node --test src/client/bundle-selfcontained.test.ts   # build 之后单独跑
```

## 视觉验收的缺口（诚实记录）

真机基线截图仍拿不到：Electron 主进程没有开 `--remote-debugging-port`，受控 Chrome 打开 `http://127.0.0.1:55442` 返回 401（缺 dsh web 会话 cookie）。因此本轮的视觉对照是「tile PNG ↔ 结构文档 ↔ 组件代码」三方比对，不是真机前后截图并排。

要补这一环，最省事的是：打开一次设置面板 →「备份与迁移」，我抓宿主窗口截图做 after；before 用 `docs/design/open-design-brief/05-baseline.md` 记录的结构事实替代。

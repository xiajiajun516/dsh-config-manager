# 历史会话（sessions）导出的压缩空间 — 实测与方案评估

> 性质：**只读实测 + 方案评估**，不改变任何行为。文档写给本仓库（并行线的实现输入），不是对外契约；
> 若其中任何结论被实现，格式相关部分必须落到 `docs/spec/bundle-format-v1.md` 并重跑 `tests/conformance/`。
>
> 实测时间：2026-09-20 · 实测机器：Windows / Node v24.13.0 · `DSH_HOME=C:\Users\<user>\.dsh` ·
> 工作树基线 `1159a08` + 未提交的并行线改动（引用行号可能随并行线漂移，引用时请以符号名为准）。

## 1. 结论先行

**能压，但幅度分层**：

| 范围 | 现状（原样复制进 ZIP） | 可达到 | 倍数 |
|---|---|---|---|
| 全部历史（376.45 MB / 663 个日志） | 369.91 MB | 210.09 MB（解码后单帧 zstd-12，整树实测） | **1.79×** |
| 大文件子集（top-80 文件 ≈170 MB） | — | 62.67 MB（zstd-19） | ≈2.7× |
| 跨会话 solid 容器（top-20 样本 64.65 MB） | 64.65 MB | 15.14 MB | **4.3×** |
| 单个超长会话（4.40 MB 日志） | 4.40 MB | 0.24 MB | **18×** |

「18 倍」只属于少数长会话；**全量历史只有约 2 倍**。收益来源不是压缩级别，而是**把 DSH 的逐批小帧合并成一个流**。

## 2. 实测方法（可复现）

只读遍历 `$DSH_HOME/sessions/**/*.jsonl.zstd`，在内存中还原每份日志的明文后重压；不写任何文件。

- 被测数据：`sessions` 树共 **379.8 MB / 660 个会话单元 / 664 个文件**（663 个 `*.jsonl.zstd` = 376.45 MB，另有 1 个 `.jsonl` 与 1 个 `.jsonl.decoded.jsonl`）。
- 尺寸分布：top-100 文件占 51.2%、top-200 占 72.9%、top-400 占 93.6%；`>3.8 MB` 的只有 3 个。
- 内核：`zlib.zstdDecompressSync` 逐帧还原 + `zlib.zstdCompressSync` 重压（`ZSTD_c_windowLog=27`、`ZSTD_c_checksumFlag=1`）。

各方案实测（同一批数据）：

| 方案 | 结果 | 换算 |
|---|---|---|
| 现状：原样复制 + ZIP `deflateRaw`（`src/utils/zip.ts:88`） | 369.91 MB | 仅省 1.7%，且白跑 CPU |
| 保留帧边界、逐帧单独重压（zstd-19，top-20 样本 64.65 MB） | 58.33 MB | ≈1.1×（几乎无收益） |
| 每个日志解码后压成**单帧** zstd-12（全树） | 210.09 MB | **1.79×** |
| 同上 zstd-19（top-80 文件） | 62.67 MB | ≈2.7× |
| **跨文件 solid 单流**（top-20 样本 64.65 MB） | 15.14 MB（z19）/ 17.60 MB（z12） | **4.3×** |
| 单会话样本 A：4.40 MB（2642 帧 → 12.07 MB 明文） | 0.24 MB | **18×** |
| 单会话样本 B：4.28 MB（1754 帧 → 12.09 MB 明文） | 0.21 MB | **20×** |

耗时（单线程，含解码）：top-20（64.65 MB）zstd-19 = 122.5 s；全树 zstd-12 = 266 s（其中前 100 个文件占 226 s）。zstd-19 全树预计 ≥10 min，需要 worker 并行才可交互。

**只带最新 N 个会话**（现成能力，`ExportOptions.sessions.limit`）：10 → **7.5 MB**、25 → 14.1 MB、50 → **15.4 MB**、100 → 38.8 MB、200 → 83.8 MB。这是性价比最高的一档，不需要任何格式改动。

## 3. 机制：为什么能压、为什么只能压到 2 倍

DSH 的会话日志**不是一个大 zstd 文件，而是拼接帧容器**（`@deepseek-ai/dsh-session-persistence-jsonl`：写入端每批 `zstdCompress(input, {checksumFlag:1})` 追加一帧，读取端 `scanZstdFrames` 逐帧做结构扫描）。

- 4.40 MB 的日志里有 **2642 个帧**，帧明文长度中位仅 **277 B**、p90 754 B、最大 197238 B。
- 明文 12.07 MB / 4550 行，类型分布显示 **95 个 `request/header`** —— 每个 header 都把完整对话历史重发一遍，即明文体积近似 O(轮次²)。
- 帧之间**互不引用**（每帧可独立解压），所以这份跨帧冗余在每帧各自压缩时被彻底切断：保留帧边界的重压只有 1.1×，合并成单流立刻到 3.5×（top-20）、18×（长会话）。
- 反过来，**短会话没有这份冗余**：把 top-80 之外那 583 个小文件算进来，全树被拉回 1.79×。这是「全量只有 2 倍」的原因。

## 4. 落地代价与风险

1. **字节不再相同**：重编码后帧边界/压缩字节都会变，可逆性只在**明文层**保证。乐观证据：会话按**事件计数**寻址（`SessionLogOffset` 是事件数、不是字节偏移），且会话目录内没有索引/旁挂文件（660 个叶子目录里只有 4 个含 2 个文件，全是格式代际或 `.decoded.jsonl` 派生件）。
2. **运行时能力探测**：解码依赖 `zlib.zstdDecompressSync`（Node ≥22.15 / 24 才有；本机 24.13 可用），而插件声明 Node≥22 —— 老 22.x 上必须**降级回原样复制**，否则导出直接失败。
3. **契约同步**：条目语义一变就要改 `docs/spec/bundle-format-v1.md`（`sessions` 分区条目语义 + manifest 标记）并重跑 `tests/conformance/`；还要定义旧版本插件读到新包时怎么办。
4. **内存与流式**：`zipToBuffer(entries)`（`src/utils/zip.ts:88`）与 `writeZip`（`src/utils/zip.ts:155`）是**全内存**的，`Exporter` 也先把全部条目攒在数组里（`src/core/exporter.ts:301-387`）。379.8 MB 会话的峰值会到 ~750 MB，做全量必须流式写 ZIP 或分片。
5. **ZIP 安全限额**：solid 单条目会撞 `maxSingleBytes=100 MB`（必须分片）；重压后的压缩比（长会话可达 ~50×）仍在 `maxRatio=200` 内，安全。

## 5. 与并行线的边界

已知归**并行线**开发、本文档不实现：`sessions` 导入限额配置化、重编码压全量的显式开关、导出默认走 `sessions.limit`。

并行线落地时的三处易漏点（本仓库实测/代码证据）：

- **限额不止一处硬编码**：`DEFAULT_ZIP_SAFETY_LIMITS` 在 `src/utils/zip.ts:35-41`（`maxEntries:10_000` / `maxTotalBytes:500MB` / `maxCompressedBytes:200MB` / `maxSingleBytes:100MB` / `maxRatio:200`），而 `src/market/security.ts:40-44` 与 `src/market/prepare.ts:89-93` **各自抄了同一组数字**；三处不同进同出会让市场侧与本地导入侧限额语义分叉。
- **「默认 sessions.limit」是默认行为变更**：现在是 `defaultIncluded=false`、勾选即全带（379.8 MB）。改成默认只带最新 N 个，必须同时定 N 并给显式 UI 提示（文案已就绪：`src/core/messages.ts:27-29` 的 `export.sessionsLimited` / `export.sessionsNone` / `export.sessionsLimitNoMtime`），否则静默丢历史。另：读不到 `mtimeMs` 时**刻意**退回全量 + 告警（`src/adapters/sessions.ts:63-83`），不要「优化」成按未知即最旧排序。
- **宿主未覆盖导入限额**：`makeImporter()`（`src/index.ts:1669-1685`）只传了 `parseZipOverride`，没有 `limits`，因此默认限额生效。

## 6. 未验证项（NOT VERIFIED）

- **重编码后的日志能否被 DSH 正常加载**：未跑真实例验证（需要 `cmtest` profile 起隔离实例，见 `DEVELOPERS.md` 的 E2E 配方）。目前只有代码证据（事件计数寻址 + 无旁挂索引）。
- **「全量历史包会被自家导入器拒绝」**：依据是 `maxCompressedBytes=200MB` 且宿主未覆盖 `limits`（`src/index.ts:1669`）——**代码证据，未跑真导入**（370 MB 包未实际生成/导入）。
- **跨会话 solid 的整树上限**：只实测了 top-20 样本（4.3×），未对 376 MB 全量跑 solid（内存与耗时成本高）。
- **zstd-19 的整树收益**：只实测了 top-80 文件（170 MB → 62.67 MB）；整树只跑过 zstd-12（210.09 MB），故结论表只引用该数。

## 附 A：可复现测量脚本（一次性，勿入库）

```js
// node --max-old-space-size=8192 measure.js   （只读，不写文件）
const fs = require('fs'), path = require('path'), z = require('zlib');
const root = path.join(process.env.DSH_HOME, 'sessions');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, out) : e.name.endsWith('.jsonl.zstd') && out.push({ p, n: fs.statSync(p).size });
  }
  return out;
};
const frames = (b) => { const o = []; for (let i = 0; i + 3 < b.length; i++) if (b[i] === 40 && b[i+1] === 181 && b[i+2] === 47 && b[i+3] === 253) o.push(i); return o; };
const opt = (lvl) => ({ params: { [z.constants.ZSTD_c_compressionLevel]: lvl, [z.constants.ZSTD_c_windowLog]: 27, [z.constants.ZSTD_c_checksumFlag]: 1 } });
let tOrig = 0, tCur = 0, tRe = 0;
for (const f of walk(root)) {
  const orig = fs.readFileSync(f.p); tOrig += orig.length;
  tCur += z.deflateRawSync(orig).length;                       // 现状：ZIP 内 deflate
  const offs = frames(orig), parts = [];                       // 逐帧还原明文
  for (let k = 0; k < offs.length; k++) parts.push(z.zstdDecompressSync(orig.subarray(offs[k], k + 1 < offs.length ? offs[k+1] : orig.length)));
  tRe += z.zstdCompressSync(Buffer.concat(parts), opt(12)).length;
}
console.log('raw', tOrig, 'zip-deflate', tCur, 'reencoded-z12', tRe);
```

## 附 B：数字口径

- 「原始」= `sessions` 树下 `*.jsonl.zstd` 的磁盘字节之和（376.45 MB / 663 个文件）。
- 倍数一律 = 原始 ÷ 结果，越大越好；`≈2×` 指全量历史，`18×` 指单个长会话，二者不可混用。
- 所有数字来自**同一台机器、同一份数据**的单次实测（2026-09-20）；换机器/换会话构成会有偏差，方向性结论（帧合并是主要收益来源）不受影响。
- **复跑会小幅漂移**：活动会话持续追加帧，同一天复跑附 A 脚本得到 raw 395,322,580 / zip-deflate 388,462,567 / reencoded-z12 220,595,614 字节（raw 比首次 +0.15%，比值仍为 1.79×）。引用数字时请连同采集时刻一起说明。

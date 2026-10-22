# ADR-0003：同步写路径的并发保护 —— 条件写，且 gist 是明确例外

- 状态：已采纳（Accepted），**gist 例外已收口**：不做条件头，改走「写后复核 + 有界重做」，残余窗口如实登记
- 日期：2026-10-22（记录既有决策）；2026-10-23 补 gist 收口方案

## 背景

同步把「快照载荷 + 索引」写到远端。两台机器基于同一基线先后 push 时，若写索引是无条件的，后写者会**整体覆盖**索引：
前者的条目消失，但它的载荷文件仍在（因为 PATCH 只列出自己的文件）。丢的是可见性，不是数据；但如果有人据此认为「同步是安全的」，
下次改成「先读后写全部文件」就可能真的删掉别人的载荷。

四个传输的条件写能力天生不同：git 靠 push 非快进被拒；WebDAV 用 `If-Match`（412）；S3 用 `if-match`/`if-none-match`；
而 gist 端点对**任何**条件请求头都回 400 —— 这是实测结论，不是设计疏忽。

## 决策

1. 索引写入必须**条件写**：远端被改过即中止并报错，绝不静默覆盖别人的条目（git/webdav/s3）。
2. gist 通道**完全不做条件头**（`src/sync/gist/gist-transport.ts:58-63` 有明确注释与落点）。但因为「无条件 = 静默覆盖」不可接受，
   写路径（upload 与 delete）统一加**写后复核 + 有界重做**：PATCH 后重读索引，校验「本次条目已落盘 / 目标已消失」且
   「读前看到的条目一个不少」；不成立整轮重做，最多 3 轮，仍失败抛 `index-conflict`（文案键 `sync.gist.indexConflict`）。
   这让「被覆盖」从静默变成可发现的错误，代价是冲突时需要用户重试。原先钉住现状的 `src/sync/gist/gist-overwrite-semantics.test.ts`
   现在同时覆盖复核失败路径，并新增 `src/sync/gist/gist-delete-concurrency.test.ts` 覆盖删除侧。
3. push 前先比「基线与远端最新」，不一致即零写入返回 conflict；merge 用 `state.ancestorId` 指向的本地祖先副本 + 分区 hash 双基线，
   **无祖先不猜**（宁可降级为两方合并并要求确认）。

## 后果

- 好：git/webdav/s3 上「两台机器同时改」是可发现的错误，不是静默数据丢失。
- 坏：gist 仍有**无法关闭的残余窗口** —— 别人在「我们读取索引」与「我们 PATCH」之间写入的条目会被覆盖（快照载荷本身不丢）。
  这是无条件协议的物理边界：写后复核能发现「我们写完之后不一致」，发现不了「我们写的瞬间别人也在写」。
- 选项取舍（已收口）：
  · **单写者承诺**：否 —— 插件无法强制第三方写者（同一个 gist 可能被另一台机器、另一个账号或别人的脚本写），承诺无法执行。
  · **read-merge-write**：已采纳为主体（upload 内先读索引再合并），本次再补**写后复核 + 有界重做**闭环。
  · **强保证**：只能用 git / webdav / s3（索引写是条件写，`If-Match` / 412 视为冲突）。文档必须讲明 gist 不等价，别让人误以为安全。

## 证据

- `src/sync/gist/gist-transport.ts:22-24`（不做 blob 外置的三条原因）、`:58-63`（不做条件写）、`:248-255`（一次 PATCH 写载荷+索引）
- `src/sync/gist/gist-overwrite-semantics.test.ts`、`src/sync/gist/gist-delete-concurrency.test.ts`（写后复核与重做的正反路径）
- `src/sync/gist/messages.ts`（`sync.gist.indexConflict` 文案）
- `docs/spec/sync-channel-v1.md` 能力矩阵、`docs/lessons/sync-channel.md`

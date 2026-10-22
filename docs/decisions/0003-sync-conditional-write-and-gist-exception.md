# ADR-0003：同步写路径的并发保护 —— 条件写，且 gist 是明确例外

- 状态：已采纳（Accepted），**gist 例外仍待产品决策**
- 日期：2026-10-22（记录既有决策）

## 背景

同步把「快照载荷 + 索引」写到远端。两台机器基于同一基线先后 push 时，若写索引是无条件的，后写者会**整体覆盖**索引：
前者的条目消失，但它的载荷文件仍在（因为 PATCH 只列出自己的文件）。丢的是可见性，不是数据；但如果有人据此认为「同步是安全的」，
下次改成「先读后写全部文件」就可能真的删掉别人的载荷。

四个传输的条件写能力天生不同：git 靠 push 非快进被拒；WebDAV 用 `If-Match`（412）；S3 用 `if-match`/`if-none-match`；
而 gist 端点对**任何**条件请求头都回 400 —— 这是实测结论，不是设计疏忽。

## 决策

1. 索引写入必须**条件写**：远端被改过即中止并报错，绝不静默覆盖别人的条目（git/webdav/s3）。
2. gist 通道**完全不做条件写**（`src/sync/gist/gist-transport.ts:58-63` 有明确注释与落点）。当前语义由
   `src/sync/gist/gist-overwrite-semantics.test.ts` 钉住：后写者整体覆盖索引、不抛错、A 的载荷逐字节未变且仍可 download 复原。
3. push 前先比「基线与远端最新」，不一致即零写入返回 conflict；merge 用 `state.ancestorId` 指向的本地祖先副本 + 分区 hash 双基线，
   **无祖先不猜**（宁可降级为两方合并并要求确认）。

## 后果

- 好：git/webdav/s3 上「两台机器同时改」是可发现的错误，不是静默数据丢失。
- 坏：gist 用户在两台机器同时同步时会静默丢索引条目（载荷不丢）。当前选择是**如实记录 + 测试钉住现状**，而不是假装安全。
- 待决策：gist 是「单写者」还是「read-merge-write」。read-merge-write 需要读回索引再合并，仍有竞态窗口（gist 无 CAS），
  只能缩小概率；单写者则需要一个显式锁或文档承诺。**这是产品决策，未采纳任何一种。**

## 证据

- `src/sync/gist/gist-transport.ts:22-24`（不做 blob 外置的三条原因）、`:58-63`（不做条件写）、`:248-255`（一次 PATCH 写载荷+索引）
- `src/sync/gist/gist-overwrite-semantics.test.ts`（双机同基线先后 push 的两种断言）
- `docs/spec/sync-channel-v1.md` 能力矩阵、`docs/lessons/sync-channel.md`

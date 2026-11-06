# ADR-0002：未解锁的加密容器不得进入 ZIP 解析器

- 状态：已采纳（Accepted）
- 日期：2026-10-22（记录既有决策）

## 背景

备份可以被密码加密。加密后的容器对 ZIP 解析器来说**不是 ZIP**：直接喂给 `loadBundle`/`analyzeImport` 会得到
「缺少中央目录结束记录」这类底层错误，用户会以为备份文件损坏，而真正该做的是先解锁。

## 决策

1. 备份形态判定只有一份实现：`src/security/container-kind.ts` 的 `readContainerKind()`（只读前 4 字节，读不到回落 `'zip'`）。
2. 三个入口 `/analyze`、`/plan`、`/execute` 在做任何解析之前先判形态；为 `'encrypted'` 时返回 **400 + `code:'encrypted-container'`**
   + 解锁引导文案键 `import.encryptedContainerNeedsUnlock`，绝不进入解析/计划/执行。
3. 机器码唯一来源 `src/utils/shared-constants.ts` 的 `ENCRYPTED_CONTAINER_CODE`；`container-kind.ts` 只 re-export，客户端也只按这个常量分派。
4. 路由级回归测试：`tests/route/encrypted-container-gate.test.ts`（`/execute` 真 handler 400 且零写入；`/analyze`/`/plan` 源码窗口断言闸门顺序）。

## 后果

- 好：错误可判别，客户端能直接进「输入密码解锁」阶段，而不是弹一个「备份损坏」的死路。
- 好：三处闸门共用同一常量与文案键，改文案只改字典。
- 坏：新增任何「接受归档文件」的入口时，必须记得加同一道闸门；目前由测试与源码守卫共同提醒（`/analyze`、`/plan` 在 `src/index.ts` 内联，无法用路由层测试，只能窗口断言）。

## 证据

- `src/security/container-kind.ts`、`src/utils/shared-constants.ts`
- `src/routes/import.ts:189-191`、`src/index.ts:4275-4277`、`src/index.ts:4314-4316`
- `src/client/import/use-import-wizard-controller.ts`（按常量分派解锁引导）

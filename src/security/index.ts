/**
 * 安全模块公共出口（m4-security）：
 *  secret-scanner / encryption / integrity / zip-security / redaction。
 *
 * 与 core 的注入点对齐：
 *  - `createSecretScanner()`        → ExporterOptions.scanner（SecretScanner 契约）
 *  - `createEncryptionProvider(pw)` → ExporterOptions.encryption（EncryptionProvider 契约）
 *  - `createHardenedZipParser()`    → ImporterOptions.parseZipOverride（(buf, limits?) => ZipArchive）
 *  - `safeExtractHardened()`        → m5 导入文件类分区落盘通道
 *  - `verifyChecksumsJson()`        → 完整性校验通道（core analyzer 已有内置校验，本模块供独立调用）
 */
export * from './secret-scanner.ts';
export * from './encryption.ts';
export * from './integrity.ts';
export * from './zip-security.ts';
export * from './redaction.ts';

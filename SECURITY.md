# 安全策略 / Security Policy

## 受支持版本 / Supported Versions

DSH Config Manager 保持滚动发布（滚动发布，建议始终使用最新版本）。
我们只对**最新发布版本**提供安全修复；历史版本请升级后再反馈。

DSH Config Manager follows rolling releases. Security fixes are provided for
the **latest published version** only — please upgrade before reporting.

| 版本 / Version | 支持状态 / Support |
| --- | --- |
| 最新版 / Latest (>= 0.1.x) | ✅ 受支持 / Supported |
| 历史版本 / Older | ❌ 不受支持 / Not supported |

## 安全设计不变量 / Security Invariants

本插件在安全上有一组硬约束，改动时不得破坏（详见 `DEVELOPERS.md`）：

- **Secret 默认不导出**：凭据值（token / password / 密钥）默认不写入导出文件、同步文件或日志
- **凭据不可回读**：DSH 凭据槽位永不回读值，只做文件级读取
- **日志全程脱敏**：`redactValue` 掩码所有敏感值；UI 渲染前所有错误/报告文本再过 `redact()` 兜底
- **ZIP 视为不可信输入**：zip bomb 条目数上限、checksum 校验、Zip Slip 拒绝
- **加密备份**：密码仅内存传入、不落盘不落日志；解密明文 ZIP 用完即清

This plugin enforces hard security invariants: secrets are not exported by
default, credential values are never read back from DSH slots, all logs are
redacted, ZIP archives are treated as untrusted input, and encryption
passwords never touch disk or logs (see `DEVELOPERS.md`).

## 漏洞报告 / Reporting a Vulnerability

请 **不要** 在公开 issue 中提交安全漏洞细节（尤其是 PoC 与样本数据）。

Please **do not** post vulnerability details (especially PoCs and sample data)
in public issues.

### 方式一（推荐）/ Preferred: GitHub 私有漏洞报告

使用 GitHub 的 **Security → Report a vulnerability**（私有漏洞报告）功能：

1. 打开 <https://github.com/xiajiajun516/dsh-config-manager/security/advisories>
2. 点击 **New draft security advisory** 提交报告
3. 报告将仅对维护者可见，我们会尽快处理并在修复后公开致谢

Use the private security advisory flow at
<https://github.com/xiajiajun516/dsh-config-manager/security/advisories> —
reports stay private until a fix is released.

### 方式二 / Alternative: 直接联系

如果私有报告不可用，可发邮件至仓库维护者（GitHub 主页可见邮箱），
主题请以 `[SECURITY]` 开头。

If private reporting is unavailable, email the maintainer (address visible on
the GitHub profile) with subject prefix `[SECURITY]`.

## 处理时限 / Disclosure Timeline

| 阶段 / Stage | 时限 / Timeline |
| --- | --- |
| 初步确认 / Initial triage | 3 个工作日 / 3 business days |
| 修复发布 / Fix release | 按严重程度而定，通常 ≤ 14 天 / varies, typically ≤ 14 days |

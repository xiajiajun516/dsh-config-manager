<!--
  CHANGELOG 版本段通用骨架 —— 每一轮都从这里开始，保证各版本段落结构一致。

  由 .github/scripts/changelog-section.mjs 使用：
    release <version> [--date YYYY-MM-DD] [--changelog 路径]
        把当前 `## [Unreleased]` 改名成 `## [<version>] - <date>`（内容原样保留），
        并在顶部插入本骨架的新 `## [Unreleased]` —— 下一轮从同一结构起步。
    check <version> [--changelog 路径]
        发布门禁：校验该版本段是否符合本文件的结构（publish.yml 在 npm publish 之前调用）。

  本注释在生成骨架时被剥掉，不会进入 CHANGELOG。

  固定结构（正文里出现的东西）：

    ## [Unreleased]

    > **<中文主题>**：一句话说明本轮主题；可以继续写多段（每段以 `> ` 起）。
    >
    > **Theme**: one-line English theme for this release.

    ### <emoji> <中文小节名> / <English section name>      ← 可选，0..n 个

    - **<中文要点标题>**：说明。
      **<English point title>**: description.

    > **致谢 / Thanks**：<贡献者与 PR 链接>                ← 可选

  体例：一条 bullet = 一个用户能看懂的更新或修复（中文一行 + 英文缩进续行），只写「现在能做什么 / 不再怎样」；
        不写文件名 / 测试名 / 字段与接口细节 / 根因过程 / 内部代号 / 未验证声明，同一功能的多次迭代合并成一条。

  规则（发布门禁 check 会逐条验）：
    ① 标题必须带 ISO 日期：`## [0.1.70] - 2026-10-06`（脚本 release 已代填）；
    ② 必须有引用块（`> `），其中必须同时有中文主题与 `> **Theme**:` 英文主题；
    ③ `###` 小节后面必须有内容，不接受空标题；
    ④ 占位符是 {{...}}：**没填完就发不出去**（门禁拒绝残留 {{...}}）。
-->
## [{{heading}}]

> **{{本版主题}}**：{{一句话中文主题}}
>
> **Theme**: {{one-line English theme}}

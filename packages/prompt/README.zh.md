---
description: "prompt 包组地图：构建于 system-prompt 注册表之上的会话级提示词管理服务——从冻结的只读 catalog 开始。"
kind: "package-group"
---

# packages/prompt

[English](README.md) | 中文

## 摘要

prompt 包组承载 Prompt Control 服务，在不触碰拥有事实的插件的前提下管理模型被告知的内容。它直接构建于 system-prompt 注册表之上：贡献的来源在该处保留，本组在其上暴露管理接口。本组从最小形态开始——`prompt-control` 包冻结只读 catalog 与公共品牌类型——并在同一服务之后成长：Profile 存储、规则解释器与请求最终化。当您需要按会话枚举或控制提示词贡献时选择本组；贡献提示词内容本身仍归 [`packages/core/system-prompt`](../core/system-prompt/README.zh.md)。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发注记](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`prompt-control/`](prompt-control/README.zh.md) | Prompt Control 服务：带来源的提示词贡献已求值只读 catalog | `ctx.promptControl` |

`prompt-control` 是本组当前的唯一包。来源捕获在注册时由 system-prompt 注册表完成，因此 catalog 是对已注册状态的纯读取，不是平行清单。

-----

<a id="related-documentation"></a>
## 相关文档

- [System-prompt 子系统](../../docs/subsystems/system-prompt.zh.md) — catalog 所镜像的注册表、组装管线与贡献类型。
- [Prompt Control P0 Agent Note](../../.agents/notes/proposed/feature/2026-09-07-prompt-control-p0.zh.md) — 后续增量所实现的决策门（接管点、投影后审计、`request/input` 词汇）。
- [架构](../../docs/architecture.zh.md) — turn 流程与新行为的去处。

-----

<a id="dev-note"></a>
## 开发注记

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

---
description: "Prompt Control 的冻结 catalog 服务，供在提示词注册表之上构建 Profile 管理、规则求值与请求最终化的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-prompt-control

[English](README.md) | 中文

## 概述

`dsh-prompt-control` 定义 Prompt Control 服务（`ctx.promptControl`），负责会话级的提示词管理。本增量冻结只读接口：`catalog()` 委托 system-prompt 注册表，返回一次组装背后各提示词贡献的已求值、带来源的视图——section、context 与 variable，每一条都携带稳定品牌标识、owner 包、scope、位置 order、动态标记、`complete` 声明与已求值文本。resolver 函数永不外泄注册表。Profile 存储、规则解释器与请求最终化将在后续增量中构建于同一服务之上。当您需要枚举"模型被告知了什么、每一部分来自哪里"时选择本包——贡献提示词内容仍归 `dsh-system-prompt`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 agent 运行、且 `dsh-system-prompt` 已挂载的地方挂载本包——服务经注入列表要求注册表，并提供 `ctx.promptControl`。

### 读取提示词 catalog

`catalog(context, options)` 返回一个组装 scope 的冻结 catalog。默认视图只列出生效贡献——恰好是该 scope 一次组装会使用的内容；`includeShadowed: true` 附加已注册但被遮蔽的条目，标记为 `effective: false` 并指明顶掉它的更近 scope。

```text
const catalog = ctx.promptControl.catalog({ scope: agentScope })
for (const section of catalog.sections) {
  // section.id — the stable branded identity (equals section.name)
  // section.source.ownerPackage / section.source.scope / section.source.lifetime
  // section.order / section.text (evaluated) / section.dynamic / section.complete
  // section.effective
}
catalog.contexts // the same view for dynamic runtime-context contributions
catalog.variables // evaluated values plus the same provenance
```

context 条目镜像组装抑制：runtime context 被抑制的视图不列出任何条目。catalog 不运行 `system-prompt/assemble` waterfall，也不强制 complete section——`complete` 只作为声明报告。resolver 求值失败与等价组装完全一致地传播。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释本包如何实现上述行为；可观察契约见[使用本包](#use-this-package)。

### 设计概念

本增量不持有任何提示词状态。来源在贡献注册处捕获——system-prompt 注册表在插入时为每个 section、context 与 variable 盖上 owner 包（注册调用方的 Cordis fiber 名）、scope 与动态标记——因此 catalog 是对已注册状态的纯读取，不是可能漂移的平行清单。服务把整个契约委托给 `SystemPrompt.catalog`，并把签名冻结为 Profile 存储、规则解释器与请求最终化赖以构建的稳定 seam。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PromptControl` 服务、`catalog()` 委托、公共品牌与 catalog 类型再导出 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约对多数消费方已经足够；需要周边领域与设计理由时再读以下内容。

- [system-prompt 包](../../core/system-prompt/README.zh.md) — catalog 所镜像的 section、context 与 variable 注册表。
- [Prompt Control P0 Agent Note](../../../.agents/notes/proposed/feature/2026-09-07-prompt-control-p0.zh.md) — 后续增量所实现的决策门（接管点、投影后审计、`request/input` 词汇）。

-----

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义服务何时需要特别留心。它们是当前包约束，不是任务清单。

- **尚无自有提示词状态** — Profile 存储、会话 Profile 选择与规则解释器将在后续增量中落于同一服务之后；catalog 是当前唯一接口。
- **tool 注册来源尚未编目** — 工具 schema 经 system-prompt 的 tool provider 流入组装；其来源 catalog 随请求接管增量交付。
- **catalog 是 waterfall 之前的视图** — 被组装 waterfall 监听器转换过的贡献不在此归属；实际分派的请求由后续审计记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布运行时 invariant 伴包；本服务不持有提示词状态，catalog 是对 system-prompt 注册表的纯读取，组装行为由其自带的 invariant 伴包覆盖。

</details>

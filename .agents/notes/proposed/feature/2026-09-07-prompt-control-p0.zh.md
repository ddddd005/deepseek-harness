# Agent Note: Prompt Control P0 — waterfall takeover, post-projection audit, and the request/input vocabulary

Status: proposed

[English](2026-09-07-prompt-control-p0.md) | 中文

## Problem

DSH 的每次模型请求都在没有一个受管理的最终控制阶段的情况下直接分派。提示词 section、动态 context、工具 schema 和以 user 角色注入的内容（Skill、AGENTS.md）以渲染后的文本抵达 Adapter：组装后不保留任何结构化来源身份，没有任何会话级规则层可以禁用或替换某个贡献，请求级临时指令一旦插入就会进入持久历史，也没有任何持久记录捕获 Adapter 实际收到的请求。"模型可见 ⟺ 已记录"不变式目前仅靠 `request/header` 追加和 `request/context` fold 满足——它们描述的是分派前的组装 config、system 文本和工具列表，既不是已分派的请求，也不包含任何规则应用结果。

首个交付物必须先证明核心路径可以被可靠接管，而不是先搭建编辑器：一个只读的贡献 catalog、一个持久化规则层、一个最终化点、一条审计记录，以及失败时不产生 I/O 的可证明保证。任何更大的范围（前端、工具编辑、相对定位）都会把接口固定在尚未验证的接管之上。

## Proposal

P0 在主对话（`conversation` purpose）上交付一个可验证的闭环，拆分为四个 PR：来源元数据与只读 catalog（PR1）、Prompt Profile 存储与 P0 规则解释器（PR2）、最终化与投影后审计、`request/input` 事件、tool 来源 catalog 及其原子化的读取/SDK 消费方（PR3），以及一个无密钥会话快照加文档与验收矩阵收尾（PR4）。Compaction、会话标题、工具编辑、相对定位、全局/基底/会话规则层、Host API、前端和带外端点都在 P0 之外，按阶段逐项重新评估。

### 决策门

**最终化接管点：`llm/stream` waterfall。** prompt-control 以全局监听器（与流不变式监听器相同的注册形态）拦截 `llm/stream`——它是两条分派路径的唯一汇合点：直连 `stream()` 与一次性 `PreparedLlmCall.stream`。waterfall 载荷已经携带 `sessionId` 与 `purpose`（compaction 与 session-title 会设置；普通对话不设置）；`turn`/`step`/`attempt` 由 agent loop 写入 `GenerateOptions` 上一个附加的、Adapter 忽略的字段（Adapter 只依据已知字段构造 Provider 载荷），因此 loop 的分派顺序不动，监听器获得完整请求上下文。P0 中非对话 purpose 原样通过监听器。

**投影后审计：`adapterStream` 内新增 `llm/dispatch` waterfall。** Adapter 的确切输入只有在其 `adapterStream` 解析完 config、把文件投影为文本、对纯文本模型投影图片、剥离异构 Adapter 的 replay state 之后——即 `dispatch(...)` 之前一刻——才存在。在该边界新增第二个 waterfall，把最终冻结的请求交给 prompt-control，由其追加 `request/input` 后再调用 `next()` 进入 Adapter。在 Adapter 可迭代对象创建之前抛出错误可以阻止所有 Provider I/O，并以终止错误 finish chunk 呈现（现有 Adapter 边界约定）；`llm/stream` 监听器中的最终化失败仍是插件抛错，重试 waterfall 已能将其与 Adapter 故障区分。

**`request/input` 语义：第一方 required 事件、log-only、不作为重建真源。** 审计记录存储 purpose、turn、step、attempt、基底预设 id、Profile id/revision、投影后的 `system`/`messages`/`tools` 与已应用规则 id，且永不进入 `deriveMessages()`。它不标记 `ignorable`：`Session.append` 的信封在内部构造，调用方没有任何途径设置该标记；且版本机制决策将 `ignorable` 限定于"丢失不影响重建"的纯信息性记录——外部构建静默跳过模型可见输入的审计，恰恰是 required 默认要防止的失败。代价是有意的：挂载词汇中缺少 `request/input` 的构建会大声拒绝解读日志，而不是盲恢复会话。

**Session 格式版本：保持 2。** 新增一种事件类型属于词汇增长；等版本恢复会应用已安装的已知事件集，因此不创建 `session-format-v2-to-v3` 边。`KNOWN_SESSION_EVENT_TYPES` 经持久化 catalog 脚本再生成，两个 SDK 的预期输出在同一 PR3 更新——事件类型、所有读取消费方与两个 SDK 原子落地。

**基底预设 revision：独立增强，不在本笔记中决策。** 会话照旧在 header 与 `agent-preset/selected` 中记录 `agentPreset` id；P0 与核心 P1 只记录当前 preset id。内容哈希 revision 进 header（触发 v3）还是进选择事件载荷，将在存在真实消费方后作为独立增强重新论证——本笔记有意不决定其存放位置。

**带外 LLM 端点：排除在接管声明之外。** 两个 web-search provider 自行构造提示词并直连 LLM 端点，从不经过 `ctx.llm`，waterfall 在结构上无法看到它们。P0 将其登记为未覆盖并保持启用；P2 或者将其接入同一控制路径，或者显式禁用。外部 CLI 子代理在进程外，超出范围。

### PR 计划

1. **PR1** — 在注册点捕获提示词贡献元数据（owner 包、scope、动态标记、`complete`、原始 order）并以只读 catalog 暴露；将现有 `name` 身份品牌化为 `PromptContributionId`；最小 prompt-control Service Definition（先冻结 catalog）。Tool 注册来源不进 PR1。本笔记随 PR1 提交。
2. **PR2** — Profile 存储域、会话 Profile 选择、P0 规则解释器（system 贡献的 `enable`/`disable`/`replace`、历史尾部的 request-only `append`），全部为纯单元，确定性排序，冲突显式报错。
3. **PR3** — `llm/stream` 接管点的最终化、`llm/dispatch` 审计 seam、loop 写入的请求上下文、tool 注册来源 catalog，以及 `request/input` 事件及其原子消费方：再生成的已知事件目录、persistence/restore/fork/replay/export 读取路径、两个 SDK 类型输出、Web Conversation/Trajectory 的忽略或专用投影。Mock Adapter 集成测试证明审计一致性与零 I/O 失败。
4. **PR4** — 一个同时演练 Profile 切换、request-only 注入与历史隔离的无密钥 `session.v2.jsonl` 快照，加文档同步与 P0 验收矩阵收尾。PR4 不再承担事件消费方修复。

### 上游接入点清单（初稿）

基线：upstream `d347e703908d0406b7a7ef80e3a0e594d86b2215`（0.1.3-alpha.1）。清单按符号与行为记录，不依赖行号。

| 上游符号 | 所属包 | 本项目接入 | 同步后必须成立的行为 | 验证 |
| --- | --- | --- | --- | --- |
| `SystemPrompt.assemble` | core/system-prompt | catalog 的来源/scope/动态/`complete` 元数据 | prompt-control 缺席时组装结果不变；catalog 与组装条目一致 | catalog 单元测试 |
| `system-prompt/assemble` waterfall | core/system-prompt | prompt-control 位于原生组装与 `complete` 处理之后 | 无规则时原生行为保持；规则在其后应用 | shadow/`complete` 单元测试 |
| `llm/stream` waterfall | llm/llm | 最终化监听器（仅 conversation purpose） | prompt-control 缺席时直通；失败抛插件错误 | Mock Adapter 集成测试 |
| `LlmRuntime.adapterStream` | llm/llm | 投影后新增 `llm/dispatch` 审计 seam | 投影顺序不变；审计看到 Adapter 的确切输入 | 审计一致性集成测试 |
| `PreparedLlmCall` | llm/llm | 原样消费（一次性、config 冻结） | 单次分派与 config 冻结错误保持 | 既有 llm 套件 |
| `SessionEventMap` | core/session | 经模块合并声明 `request/input` | catalog 再生成将其收录为 required | 持久化 catalog 门 |
| `MessageSourceMap` | llm/llm | 经模块合并新增 `prompt-control` 来源 kind | 来源 kind 可区分 user/Skill/AGENTS.md/prompt-control | 来源 kind 单元测试 |
| `request/header` fold | core/session | 不变；与 `request/input` 互补 | header 仍记录分派前 config/system/tools | 既有 session 套件 |
| `agent-preset/selected` | preset/agent-presets | 不变（revision 延后） | 空白会话重选继续可用 | 既有 preset 套件 |

## Alternatives considered

- **Agent loop 显式调用 finalize。** 无需附加字段即可获得完整 turn/step/attempt 上下文，但会重构 loop 的分派顺序，迫使每个辅助调用方（compaction、标题）分别接入，并为了一个监听器能集中完成的事情修改架构文档。按"插件而非 loop 改动"的惯例拒绝；最终只有附加上下文字段接触 loop。
- **将 `request/input` 标记为 ignorable。** 缺少该事件的构建会跳过它并继续恢复——但 `Session.append` 无法设置该标记，版本机制决策将其保留给丢失无影响的信息性记录，而跳过模型可见输入的审计正是 required 默认所要防止的静默损坏。
- **让 `request/input` 成为重建真源（升级 v3）。** 把一次审计增强变成一套迁移工程；为满足 P0 目标，`deriveMessages()` 无需改变。只有当后续阶段需要逐字节重放分派时才重新评估。
- **只记录投影前的 Controlled request。** 违反"审计记录等于 Adapter 实际输入"的 P0 决策门；投影依赖模型能力，归 LlmRuntime 所有。
- **在 prompt-control 内复刻投影逻辑。** 复制 llm 内部实现，并随每次 Adapter 能力变化漂移；`llm/dispatch` seam 观察的是真实边界。
- **把投影前移到 `llm/stream` waterfall 之前。** 为服务审计而重构所有消费方的分派顺序；边界应当留在运行时已拥有的位置。
- **现在就把基底预设 revision 放入 header。** 在没有 P0 消费方的情况下强制产生 v3 迁移边。
- **现在禁用带外搜索插件。** 在没有替代物的情况下移除用户可见能力；记录排除事实并安排 P2 接入是更小且诚实的一步。

## Acceptance criteria

- catalog 能区分静态与动态、global 与 scoped shadow、`complete` 语义以及每个模型可见贡献的 owner 包，默认只返回生效条目（system-prompt 聚焦套件）。
- `MessageSourceMap` 能以 `source.kind` 区分 Skill、AGENTS.md、普通用户与 prompt-control 来源。
- Tool 注册来源能关联到 Adapter 收到的最终 tool schema（PR3 catalog 加审计一致性测试）。
- 规则解释器对 `enable`/`disable`/`replace`/`append` 产生确定性结果，拒绝无效目标与非法角色，对同一字段的冲突 replace 报错。
- Mock Adapter 集成测试证明 Adapter 收到的正是所记录的 `request/input`，且最终化或审计失败时 Adapter 的 I/O 为零。
- request-only 追加的消息不出现在下一次 `deriveMessages()` 中；恢复后的会话仍可读取历史审计记录。
- 一个无密钥 `session.v2.jsonl` 快照同时演练 Profile 切换、request-only 注入与历史隔离。
- `SESSION_FORMAT_VERSION` 保持 2 且不新增迁移边；持久化 catalog 门与两个 SDK 预期输出通过。
- 聚焦 vitest 套件通过且触及源码每文件 100% 覆盖；`verify-agent-note-format` 与翻译配对通过；PR3/PR4 落地后本笔记转入 `implemented/`。

## Risks

- **日志增长。** `request/input` 按次存储完整投影后请求（system、messages、tools）；重度工具会话增长更快。P0 为可审计性接受此代价；体积上限或采样策略将是由后续笔记拥有的 Config schema 变更。
- **Fork 可移植性。** 携带 `request/input` 的会话在缺少 prompt-control 词汇的构建上拒绝加载（未知 required 事件）。这是有意的响亮拒绝而非静默退化，在此写明以免被误判为缺陷。
- **接管宽度。** `llm/stream` 监听器也会看到 compaction 与标题流量；P0 必须将非对话 purpose 原样放行，并以 purpose 门控测试覆盖，使保证范围与已证明的范围一致。
- **Loop 接触。** 写入请求上下文是唯一的 agent-loop 改动；必须保持分派顺序不动，并在同一 PR 中更新 `docs/architecture.md`。
- **上游同步摩擦。** 接入点集中在 `llm/llm` 与 session 类型；接入点清单加上行为测试（审计一致性、零 I/O、来源 kind、历史隔离）承担同步监视，本地已启用 rerere。

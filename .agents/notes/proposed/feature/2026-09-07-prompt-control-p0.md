# Agent Note: Prompt Control P0 — waterfall takeover, post-projection audit, and the request/input vocabulary

Status: proposed

English | [中文](2026-09-07-prompt-control-p0.zh.md)

## Problem

DSH dispatches every model request without a managed final-control stage. Prompt sections, dynamic contexts, tool schemas, and user-role injections (Skills, AGENTS.md) reach the adapter as rendered text: no structural source identity survives assembly, no per-session rule layer can disable or replace a contribution, no request-only instruction can be appended without entering durable history, and no durable record captures the exact request the adapter received. The model-visible ⟺ logged invariant is satisfied today only by the `request/header` append and the `request/context` fold, which describe the assembled config, system text, and tool list before dispatch — not the dispatched request, and not any rule application.

A first deliverable must prove the core path is reliably takeable before any editor is built: one read-only catalog of prompt contributions, one persisted rule layer, one finalization point, one audit record, and a demonstrable no-I/O guarantee on failure. Anything broader (front ends, tool editing, relative placement) would fix interfaces against an unproven takeover.

## Proposal

P0 delivers one verifiable closed loop on the main conversation (`conversation` purpose), split into four PRs: source metadata and a read-only catalog (PR1), Prompt Profile storage plus the P0 rule interpreter (PR2), finalization with post-projection audit, the `request/input` event, the tool source catalog, and the atomic read/SDK consumers (PR3), and one keyless session snapshot with the documentation and acceptance-matrix closeout (PR4). Compaction, session title, tool editing, relative placement, global/base/session rule layers, the Host API, the front end, and out-of-band endpoints stay outside P0 and are revisited per stage.

### Decision gates

**Finalization takeover point: the `llm/stream` waterfall.** A prompt-control global listener (the same registration shape as the stream invariant listener) intercepts `llm/stream`, which is the single funnel for both dispatch paths — direct `stream()` and the one-shot `PreparedLlmCall.stream`. The waterfall payload already carries `sessionId` and `purpose` (compaction and session-title set it; ordinary conversation leaves it unset); `turn`/`step`/`attempt` are stamped by the agent loop into an additive, adapter-ignored `GenerateOptions` field (adapters build provider payloads from known fields only), so the loop keeps its dispatch order untouched and the listener gains full request context. Non-conversation purposes pass through the listener unchanged in P0.

**Post-projection audit: a new `llm/dispatch` waterfall inside `adapterStream`.** The exact adapter input exists only after `adapterStream` resolves the config, projects files to text, projects images for text-only models, and strips foreign-adapter replay state — immediately before `dispatch(...)`. A second waterfall at that boundary hands the final frozen request to prompt-control, which appends `request/input` and then calls `next()` into the adapter. A throw before the adapter iterable is created prevents every byte of Provider I/O and surfaces as a terminal error finish chunk (the existing adapter-boundary convention); a finalization failure in the `llm/stream` listener remains a thrown plugin error, which the retry waterfall already distinguishes from adapter failures.

**`request/input` semantics: a first-party required event, log-only, not a reconstruction source.** The audit record stores purpose, turn, step, attempt, base preset id, profile id/revision, the post-projection `system`/`messages`/`tools`, and applied rule ids, and it never re-enters `deriveMessages()`. It is NOT marked `ignorable`: the `Session.append` envelope is constructed internally and offers the caller no way to set the marker, and the versioning decision restricts `ignorable` to informational records whose loss cannot affect reconstruction — an external build silently skipping the audit of model-visible input is exactly the failure the required default prevents. The cost is deliberate: a build whose mounted vocabulary lacks `request/input` refuses to interpret the log loudly instead of resuming a blind session.

**Session format version: stays 2.** Adding one event type is vocabulary growth; equal-version restoration applies the installed known-event set, so no `session-format-v2-to-v3` edge is created. `KNOWN_SESSION_EVENT_TYPES` regenerates through the persistence catalog script, and both SDKs' expected outputs update in the same PR3 — the event type, every read consumer, and both SDKs land atomically.

**Base preset revision: an independent enhancement, not decided here.** Sessions keep recording the `agentPreset` id in the header and `agent-preset/selected` exactly as shipped; P0 and core P1 record only the current preset id. Whether a content-hash revision enters the header (a v3 event) or the selection payload is re-argued as an independent enhancement once an actual consumer exists — this note deliberately leaves that location undecided.

**Out-of-band LLM endpoints: excluded from the takeover claim.** The two web-search providers construct their prompts and call LLM endpoints directly, never through `ctx.llm`, so the waterfall structurally cannot see them. P0 records them as uncounted and leaves them enabled; P2 either routes them through the same control path or disables them explicitly. External CLI subagents are out of process and out of scope.

### PR plan

1. **PR1** — prompt contribution metadata (owner package, scope, dynamic flag, `complete`, original order) captured at registration and exposed as a read-only catalog; `PromptContributionId` branding of the existing `name` identity; the minimal prompt-control Service Definition (catalog first). Tool registration sources stay out of PR1. This note ships in PR1.
2. **PR2** — profile storage domain, session profile selection, and the P0 rule interpreter (`enable`/`disable`/`replace` on system contributions, request-only `append` at history tail) as pure units with deterministic ordering and explicit conflict errors.
3. **PR3** — finalization at the `llm/stream` takeover point, the `llm/dispatch` audit seam, the loop-stamped request context, the tool registration source catalog, and the `request/input` event with its atomic consumers: the regenerated known-event catalog, persistence/restore/fork/replay/export reads, both SDK type outputs, and the Web Conversation/Trajectory ignore-or-projection. Mock Adapter integration tests prove audit parity and no-I/O failure.
4. **PR4** — one keyless `session.v2.jsonl` snapshot exercising profile switch, request-only injection, and history isolation, plus the documentation sync and the P0 acceptance-matrix closeout. PR4 carries no event-consumer fixes.

### Upstream integration points (initial list)

Baseline: upstream `d347e703908d0406b7a7ef80e3a0e594d86b2215` (0.1.3-alpha.1). The list records symbols and behavior, never line numbers.

| Upstream symbol | Owning package | Local extension | Expected behavior after a sync | Verification |
| --- | --- | --- | --- | --- |
| `SystemPrompt.assemble` | core/system-prompt | catalog source/scope/dynamic/`complete` metadata | assembly result unchanged when prompt-control is absent; catalog matches assembled entries | catalog unit tests |
| `system-prompt/assemble` waterfall | core/system-prompt | prompt-control stays after native assembly and `complete` handling | native behavior preserved without rules; rules apply after | shadow/`complete` unit tests |
| `llm/stream` waterfall | llm/llm | finalization listener (conversation purpose only) | pass-through when prompt-control absent; failure throws plugin error | Mock Adapter integration tests |
| `LlmRuntime.adapterStream` | llm/llm | new `llm/dispatch` audit seam after projection | projection order unchanged; audit sees the adapter's exact input | audit parity integration test |
| `PreparedLlmCall` | llm/llm | consumed unchanged (one-shot, frozen config) | single-dispatch and frozen-config errors intact | existing llm suites |
| `SessionEventMap` | core/session | `request/input` declaration via module merge | catalog regeneration picks it up as required | persistence catalog gate |
| `MessageSourceMap` | llm/llm | `prompt-control` source kind via module merge | source kinds distinguish user/Skill/AGENTS.md/prompt-control | source-kind unit tests |
| `request/header` fold | core/session | unchanged; complements `request/input` | header still logs pre-dispatch config/system/tools | existing session suites |
| `agent-preset/selected` | preset/agent-presets | unchanged (revision deferred) | blank-session reselection keeps working | existing preset suites |

## Alternatives considered

- **Agent-loop explicit finalization.** Full turn/step/attempt context without a stamped field, but it restructures the loop's dispatch order, obligates every auxiliary caller (compaction, title) to integrate separately, and requires architecture-doc changes for what a listener does centrally. Rejected per the plugins-not-loop-changes convention; only the additive context field touches the loop.
- **Mark `request/input` ignorable.** A build lacking the event would skip it and resume — but `Session.append` cannot set the marker, the versioning decision reserves it for loss-safe informational records, and skipping the audit of model-visible input is the silent-corruption failure the required default exists to prevent.
- **Make `request/input` the reconstruction truth source (bump to v3).** Turns an audit addition into a migration program; `deriveMessages()` need not change to satisfy the P0 goal. Revisit only if a later stage needs replay-exact dispatch reconstruction.
- **Record only the pre-projection Controlled request.** Violates the P0 gate that the audit record equals the adapter's actual input; projection is model-capability-dependent and owned by the runtime.
- **Replicate the projection inside prompt-control.** Duplicates llm internals and drifts on every adapter capability change; the `llm/dispatch` seam observes the real boundary instead.
- **Move projection before the `llm/stream` waterfall.** Restructures dispatch for every consumer to serve auditing; the boundary belongs where the runtime already owns it.
- **Put the base-preset revision in the header now.** Forces a v3 edge with no P0 consumer of the revision.
- **Disable the out-of-band search plugins now.** Removes user-visible capability with no replacement; recording the exclusion and scheduling P2 integration is the smaller, honest step.

## Acceptance criteria

- The catalog distinguishes static vs dynamic, global vs scoped-shadow, `complete` semantics, and the owner package of every model-visible contribution, and returns effective entries by default (focused system-prompt suites).
- `MessageSourceMap` distinguishes Skill, AGENTS.md, ordinary user, and prompt-control sources by `source.kind`.
- Tool registration sources resolve to the final tool schemas the adapter receives (PR3 catalog plus the audit-parity test).
- The rule interpreter produces deterministic results for `enable`/`disable`/`replace`/`append`, rejects invalid targets and roles, and errors on conflicting replaces of the same field.
- A Mock Adapter integration test proves the adapter received exactly the recorded `request/input`, and that a finalization or audit failure leaves the adapter with zero I/O.
- Request-only appended messages never appear in the next `deriveMessages()`; a resumed session still reads past audit records.
- One keyless `session.v2.jsonl` snapshot exercises profile switch, request-only injection, and history isolation together.
- `SESSION_FORMAT_VERSION` remains 2 with no new migration edge; the persistence catalog gate and both SDK expected outputs pass.
- Focused vitest suites pass with per-file 100% coverage on touched sources; `verify-agent-note-format` and translation pairing pass; this note moves to `implemented/` once PR3/PR4 land.

## Risks

- **Log growth.** `request/input` stores the full post-projection request per attempt (system, messages, tools); heavy tool-using sessions grow faster. P0 accepts this for auditability; a size ceiling or sampling policy would be a Config-schema change owned by a later note.
- **Fork portability.** Sessions carrying `request/input` refuse to load on builds without the prompt-control vocabulary (unknown required event). This is the intended loud refusal, not silent degradation, and is called out here so it is never mistaken for a bug.
- **Takeover breadth.** The `llm/stream` listener sees compaction and title traffic; P0 must pass non-conversation purposes through unchanged, covered by purpose-gating tests, so the guarantee stays scoped to what is proven.
- **Loop contact.** Stamping the request context is the only agent-loop change; it must keep the dispatch order untouched and update `docs/architecture.md` in the same PR.
- **Upstream sync friction.** The seams concentrate in `llm/llm` and session types; the integration-point table plus the behavior tests (audit parity, no-I/O, source kinds, history isolation) own the sync watch, with rerere enabled locally.

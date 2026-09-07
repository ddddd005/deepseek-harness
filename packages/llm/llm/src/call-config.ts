/**
 * Conversation call configuration and freeze utilities. Provider routing,
 * model, reasoning effort, and sampling values are request-header state that
 * can affect cache reuse; request waterfalls replace them and the loop logs
 * changed snapshots instead of allowing silent per-call drift.
 * @module dsh-llm/call-config
 */

import type { GenerateOptions } from './types.ts'
import type { ReasoningEffortId } from './brand.ts'

/** Process-local identities of request objects assembled by dsh-agent-loop. */
const AGENT_LOOP_REQUESTS = new WeakSet<GenerateOptions>()
/** Process-local assembly facts paired with one exact loop request. */
const AGENT_LOOP_CONTEXTS = new WeakMap<GenerateOptions, AgentLoopRequestContext>()

/** The evaluated system-prompt facts needed by a post-assembly request controller. */
export interface AgentLoopPromptAssemblyContext {
  /** Scope key used when the loop assembled the prompt. */
  readonly scope: object
  /** Post-waterfall system sections, before they are rendered to one string. */
  readonly sections: readonly { readonly name: string; readonly text: string }[]
  /** Values used while rendering sections. */
  readonly variables: Readonly<Record<string, string | undefined>>
}

/** Process-local turn facts paired with an exact request assembled by the agent loop. */
export interface AgentLoopRequestContext {
  /** Durable turn number that owns this request. */
  readonly turn: number
  /** Durable step number that owns this request. */
  readonly step: number
  /** The prompt assembly that produced the request's system text. */
  readonly prompt: AgentLoopPromptAssemblyContext
  /** Assistant-stream attempt number, stamped immediately before dispatch. */
  readonly attempt?: number
}

// TODO(call-config-shape): Revisit which fields are epoch-level for cache reuse
// and where provider-specific request options belong.
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/**
 * Effective config fields supplied by exact-model adapter resolution rather
 * than by the caller's request proposal.
 */
export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/**
 * Field-wise equality over {@link LlmCallConfig} — the comparison a caller
 * runs to decide whether a proposed configuration is a real change (worth a
 * logged header snapshot) or the held one restated.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field (including the `stop` list, element-wise) matches.
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/**
 * Mark one exact request object as assembled by dsh-agent-loop.
 * @param request - loop-owned request envelope before LLM dispatch.
 * @returns the same request object marked as created by the process-local agent loop.
 */
export function markAgentLoopRequest<T extends GenerateOptions>(request: T, context?: AgentLoopRequestContext): T {
  AGENT_LOOP_REQUESTS.add(request)
  if (context !== undefined) AGENT_LOOP_CONTEXTS.set(request, context)
  return request
}

/**
 * Test whether the exact request object was assembled by dsh-agent-loop.
 * @param request - request envelope observed at the LLM waterfall.
 * @returns whether {@link markAgentLoopRequest} recorded this object.
 */
export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}

/**
 * Read the process-local context paired with a loop-built request.
 * @param request - Request observed at a LLM waterfall.
 * @returns its loop context, or `undefined` for direct and legacy loop requests.
 */
export function agentLoopRequestContext(request: GenerateOptions): AgentLoopRequestContext | undefined {
  return AGENT_LOOP_CONTEXTS.get(request)
}

/**
 * Stamp the assistant-stream attempt after the loop has constructed it and
 * before the request reaches the LLM waterfall.
 * @param request - Exact loop-built request.
 * @param attempt - Positive assistant-stream attempt number.
 */
export function stampAgentLoopRequestAttempt(request: GenerateOptions, attempt: number): void {
  const context = AGENT_LOOP_CONTEXTS.get(request)
  if (context === undefined) throw new Error('cannot stamp an agent-loop attempt without request context')
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError(`agent-loop attempt must be a positive safe integer, got ${String(attempt)}`)
  }
  if (context.attempt !== undefined) throw new Error('agent-loop request attempt is already stamped')
  AGENT_LOOP_CONTEXTS.set(request, Object.freeze({ ...context, attempt }))
}

/**
 * Public Prompt Control data model: brand types, the P0 rule union, and the
 * persisted profile / session-selection shapes.
 *
 * @module @deepseek-ai/dsh-prompt-control/model
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PromptContributionId } from './index.ts'

/** Stable branded identity of one user-managed prompt profile. */
export type PromptProfileId = Branded<'PromptProfileId'>

/** Stable branded identity of one prompt override action. */
export type PromptRuleId = Branded<'PromptRuleId'>

/**
 * Brand a string as a {@link PromptProfileId}.
 * @param id - the profile identity string admitted by the profile store.
 * @returns the same string with the compile-time profile brand.
 */
export function PromptProfileId(id: string): PromptProfileId {
  return brandString<PromptProfileId>(id)
}

/**
 * Brand a string as a {@link PromptRuleId}.
 * @param id - the rule identity string admitted by the profile store.
 * @returns the same string with the compile-time rule brand.
 */
export function PromptRuleId(id: string): PromptRuleId {
  return brandString<PromptRuleId>(id)
}

/** Fields shared by every P0 rule variant. */
export interface PromptRuleBase {
  /** Unique action identity within its owning collection. */
  readonly id: PromptRuleId
  /** Disabled rules are retained but skipped, so a toggle is reversible without a rewrite. */
  readonly enabled: boolean
  /** Ascending application order inside one layer; equal orders use code-unit id order. */
  readonly order: number
}

/** Make one effective system contribution active again. */
export interface EnablePromptRule extends PromptRuleBase {
  readonly action: 'enable'
  /** The system contribution to enable; must name an effective catalog section. */
  readonly target: PromptContributionId
}

/** Remove one effective system contribution from the request. */
export interface DisablePromptRule extends PromptRuleBase {
  readonly action: 'disable'
  /** The system contribution to disable; must name an effective catalog section. */
  readonly target: PromptContributionId
}

/** Substitute the evaluated text of one effective system contribution. */
export interface ReplacePromptRule extends PromptRuleBase {
  readonly action: 'replace'
  /** The system contribution whose evaluated text is replaced. */
  readonly target: PromptContributionId
  /** The replacement text; `{{variable}}` references are interpolated like native text. */
  readonly text: string
}

/** Append one request-only prompt at the complete persistent-history tail. */
export interface AppendRequestPromptRule extends PromptRuleBase {
  readonly action: 'append-request'
  /** Request-only prompts may speak as `system` or `user`; other roles are rejected. */
  readonly role: 'system' | 'user'
  /** The appended text; `{{variable}}` references are interpolated like native text. */
  readonly text: string
}

/** The P0 rule union: `enable`, `disable`, `replace`, and request-tail `append-request`. */
export type PromptRule = EnablePromptRule | DisablePromptRule | ReplacePromptRule | AppendRequestPromptRule

/** The action discriminant of every P0 rule variant. */
export type PromptRuleAction = PromptRule['action']

/** One user-managed profile: a named, revisioned collection of prompt rules. */
export interface PromptProfile {
  /** Stable profile identity. */
  readonly id: PromptProfileId
  /** Human-facing name; uniqueness is a management concern, not an identity constraint. */
  readonly name: string
  /** Optional human-facing description. */
  readonly description?: string
  /** Monotonic revision, incremented by every successful write. */
  readonly revision: number
  /** Creation time in epoch milliseconds. */
  readonly createdAt: number
  /** Last successful write in epoch milliseconds. */
  readonly updatedAt: number
  /** The profile's rules in no inherent order; application order comes from `order` then id. */
  readonly rules: readonly PromptRule[]
}

/** List-view summary of one profile (doc 06 §6). */
export interface PromptProfileSummary {
  readonly id: PromptProfileId
  readonly name: string
  readonly description?: string
  readonly revision: number
  readonly ruleCount: number
  readonly updatedAt: number
}

/** The user-supplied fields used to create one profile. */
export interface PromptProfileCreate {
  /** Human-facing name. */
  readonly name: string
  /** Optional human-facing description. */
  readonly description?: string
  /** Initial rule collection; defaults to empty. */
  readonly rules?: readonly PromptRule[]
}

/** Fields an optimistic profile write may replace. */
export interface PromptProfileUpdate {
  /** New human-facing name, when changed. */
  readonly name?: string
  /** New description; `null` removes it. */
  readonly description?: string | null
  /** Entire replacement rule collection, when changed. */
  readonly rules?: readonly PromptRule[]
}

/** One session's durable prompt-profile selection. */
export interface SessionPromptSelection {
  /** The selected session. */
  readonly sessionId: SessionId
  /** The selected profile, or `undefined` while the session uses no profile. */
  readonly profileId?: PromptProfileId
}

/**
 * Deterministic P0 evaluation of profile and request-only prompt rules.
 *
 * @module @deepseek-ai/dsh-prompt-control/rules
 */

import type { CatalogSection, PromptContributionId } from '@deepseek-ai/dsh-system-prompt'
import type { AppendRequestPromptRule, PromptRule } from './model.ts'

/** One enabled system contribution after P0 rules have been applied. */
export interface EffectivePromptSection {
  /** Stable contribution identity from the native prompt catalog. */
  readonly id: PromptContributionId
  /** Evaluated text, possibly replaced by a rule. */
  readonly text: string
}

/** One request-only prompt appended after the persistent conversation history. */
export interface RequestPromptAppend {
  /** The rule that produced this request-only prompt. */
  readonly ruleId: AppendRequestPromptRule['id']
  /** The role used when PR3 creates the transient request message. */
  readonly role: AppendRequestPromptRule['role']
  /** Non-blank prompt text. */
  readonly text: string
}

/** Result of evaluating the native system catalog through the two P0 rule layers. */
export interface PromptRuleEvaluation {
  /** Enabled native system sections, in deterministic native placement order. */
  readonly sections: readonly EffectivePromptSection[]
  /** Request-tail additions in deterministic layer and rule order. */
  readonly appendedRequests: readonly RequestPromptAppend[]
}

/** A malformed or internally conflicting P0 rule collection. */
export class PromptRuleValidationError extends Error {}

/** A rule named no effective system contribution in the supplied catalog. */
export class UnknownPromptContributionError extends Error {}

/** Validate one rule layer independently of any catalog. */
export function validatePromptRuleLayer(rules: readonly PromptRule[]): void {
  const ids = new Set<string>()
  const replacements = new Set<string>()
  for (const rule of rules) {
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new PromptRuleValidationError('prompt rule id must be a non-empty string')
    }
    if (ids.has(rule.id)) {
      throw new PromptRuleValidationError(`prompt rule id '${rule.id}' is duplicated in one layer`)
    }
    ids.add(rule.id)
    if (!Number.isFinite(rule.order)) {
      throw new PromptRuleValidationError(`prompt rule '${rule.id}' order must be finite`)
    }
    if (typeof rule.enabled !== 'boolean') {
      throw new PromptRuleValidationError(`prompt rule '${rule.id}' enabled must be boolean`)
    }
    switch (rule.action) {
      case 'enable':
      case 'disable':
        validateTarget(rule.id, rule.target)
        break
      case 'replace':
        validateTarget(rule.id, rule.target)
        if (rule.enabled && replacements.has(rule.target)) {
          throw new PromptRuleValidationError(
            `prompt rule layer has multiple enabled replacements for '${rule.target}'`,
          )
        }
        if (rule.enabled) replacements.add(rule.target)
        if (typeof rule.text !== 'string') {
          throw new PromptRuleValidationError(`replacement rule '${rule.id}' text must be a string`)
        }
        break
      case 'append-request':
        if (!isRequestRole(rule.role)) {
          throw new PromptRuleValidationError(`append rule '${rule.id}' role must be 'system' or 'user'`)
        }
        if (typeof rule.text !== 'string' || rule.text.trim().length === 0) {
          throw new PromptRuleValidationError(`append rule '${rule.id}' text must not be blank`)
        }
        break
      default:
        throw new PromptRuleValidationError('prompt rule has an unknown action')
    }
  }
}

/**
 * Evaluate the P0 rule layers. Native contributions form the base; the
 * profile layer runs next, followed by the request-only layer. Rules within a
 * layer run by ascending `order`, then code-unit rule id.
 * @param sections - System catalog entries from the native prompt registry.
 * @param profileRules - Durable profile rules.
 * @param requestRules - Rules supplied for this one request only.
 * @returns The controlled system sections and request-tail additions.
 */
export function evaluatePromptRules(
  sections: readonly CatalogSection[],
  profileRules: readonly PromptRule[] = [],
  requestRules: readonly PromptRule[] = [],
): PromptRuleEvaluation {
  validatePromptRuleLayer(profileRules)
  validatePromptRuleLayer(requestRules)

  const effective = sections
    .filter(section => section.effective)
    .slice()
    .sort(compareCatalogSections)
  const entries = new Map(effective.map(section => [section.id, { text: section.text, enabled: true }]))
  const appendedRequests: RequestPromptAppend[] = []
  applyLayer(entries, appendedRequests, profileRules)
  applyLayer(entries, appendedRequests, requestRules)

  return {
    sections: effective
      .flatMap((section) => {
        const entry = entries.get(section.id)
        return entry?.enabled === true ? [{ id: section.id, text: entry.text }] : []
      }),
    appendedRequests,
  }
}

function applyLayer(
  entries: Map<PromptContributionId, { text: string; enabled: boolean }>,
  appendedRequests: RequestPromptAppend[],
  rules: readonly PromptRule[],
): void {
  for (const rule of rules.slice().sort(compareRules)) {
    if (!rule.enabled) continue
    switch (rule.action) {
      case 'enable':
        requireEntry(entries, rule.target, rule.id).enabled = true
        break
      case 'disable':
        requireEntry(entries, rule.target, rule.id).enabled = false
        break
      case 'replace':
        requireEntry(entries, rule.target, rule.id).text = rule.text
        break
      case 'append-request':
        appendedRequests.push({ ruleId: rule.id, role: rule.role, text: rule.text })
        break
      default:
        throw new PromptRuleValidationError('prompt rule has an unknown action')
    }
  }
}

function requireEntry(
  entries: Map<PromptContributionId, { text: string; enabled: boolean }>,
  target: PromptContributionId,
  ruleId: string,
): { text: string; enabled: boolean } {
  const entry = entries.get(target)
  if (entry === undefined) {
    throw new UnknownPromptContributionError(`prompt rule '${ruleId}' names unknown contribution '${target}'`)
  }
  return entry
}

function validateTarget(ruleId: string, target: PromptContributionId): void {
  if (typeof target !== 'string' || target.length === 0) {
    throw new PromptRuleValidationError(`prompt rule '${ruleId}' target must be a non-empty contribution id`)
  }
}

function isRequestRole(role: unknown): role is AppendRequestPromptRule['role'] {
  return role === 'system' || role === 'user'
}

function compareRules(left: PromptRule, right: PromptRule): number {
  return left.order - right.order || left.id.localeCompare(right.id)
}

function compareCatalogSections(left: CatalogSection, right: CatalogSection): number {
  return left.order - right.order || left.id.localeCompare(right.id)
}

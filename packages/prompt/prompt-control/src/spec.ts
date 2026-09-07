/** Durable Prompt Control profile and session-selection records. @module @deepseek-ai/dsh-prompt-control/spec */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PromptContributionId } from '@deepseek-ai/dsh-system-prompt'
import { PromptProfileId, PromptRuleId } from './model.ts'
import type { PromptProfileId as PromptProfileIdType, PromptRuleId as PromptRuleIdType } from './model.ts'

const profileId = z.string().min(1).transform(PromptProfileId)
const ruleId = z.string().min(1).transform(PromptRuleId)
const sessionId = z.string().min(1).transform(value => value as SessionId)
const contributionId = z.string().min(1).transform(value => value as PromptContributionId)

const promptRuleBase = {
  id: ruleId,
  enabled: z.boolean(),
  order: z.number(),
}

const promptRule = z.discriminatedUnion('action', [
  z.object({ ...promptRuleBase, action: z.literal('enable'), target: contributionId }),
  z.object({ ...promptRuleBase, action: z.literal('disable'), target: contributionId }),
  z.object({ ...promptRuleBase, action: z.literal('replace'), target: contributionId, text: z.string() }),
  z.object({
    ...promptRuleBase,
    action: z.literal('append-request'),
    role: z.union([z.literal('system'), z.literal('user')]),
    text: z.string().refine(text => text.trim().length > 0),
  }),
])

/** Durable profile header; rules reside in the `profile_rules` table. */
export const promptProfileRecord = z.object({
  id: profileId,
  name: z.string().min(1),
  description: z.string().optional(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

/** One rule attached to one committed profile revision. */
export const promptProfileRuleRecord = z.object({
  profileId,
  revision: z.number().int().nonnegative(),
  rule: promptRule,
})

/** The selected profile for a durable session. */
export const sessionPromptSelectionRecord = z.object({ profileId: profileId })

/** Prompt Control's storage-domain declaration. */
export const promptControlDomainSpec = defineDomain({
  name: 'prompt_control',
  version: 1,
  tables: {
    profiles: domainTable<PromptProfileIdType, PromptProfileRecord>(promptProfileRecord),
    profile_rules: domainTable<string, PromptProfileRuleRecord>(promptProfileRuleRecord),
    session_selections: domainTable<z.infer<typeof sessionId>, SessionPromptSelectionRecord>(sessionPromptSelectionRecord),
  },
})

/** Stored profile header inferred from {@link promptProfileRecord}. */
export type PromptProfileRecord = z.infer<typeof promptProfileRecord>
/** Stored profile-rule row inferred from {@link promptProfileRuleRecord}. */
export type PromptProfileRuleRecord = z.infer<typeof promptProfileRuleRecord>
/** Stored session selection inferred from {@link sessionPromptSelectionRecord}. */
export type SessionPromptSelectionRecord = z.infer<typeof sessionPromptSelectionRecord>

/** Make a stable storage key for one rule revision. */
export function promptProfileRuleKey(profileId: PromptProfileIdType, revision: number, ruleId: PromptRuleIdType): string {
  return `${profileId}:${revision}:${ruleId}`
}

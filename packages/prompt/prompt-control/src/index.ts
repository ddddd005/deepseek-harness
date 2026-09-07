/**
 * Prompt Control service: session-scoped management of prompt contributions.
 *
 * This increment owns the read-only catalog, durable profile and selection
 * state, and pure P0 rule evaluation. Request finalization lands later behind
 * the same service.
 *
 * @module @deepseek-ai/dsh-prompt-control
 */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AssembleContext, CatalogOptions, PromptCatalog } from '@deepseek-ai/dsh-system-prompt'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { promptControlDomainSpec, promptProfileRuleKey } from './spec.ts'
import type { PromptProfileRecord, PromptProfileRuleRecord, SessionPromptSelectionRecord } from './spec.ts'
import { validatePromptRuleLayer } from './rules.ts'
import { PromptProfileId } from './model.ts'
import type {
  PromptProfile,
  PromptProfileCreate,
  PromptProfileId as PromptProfileIdType,
  PromptProfileSummary,
  PromptProfileUpdate,
  PromptRule,
  SessionPromptSelection,
} from './model.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    promptControl: PromptControl
  }
}

/**
 * Session-scoped prompt management.
 *
 * The service exposes the system-prompt registry's evaluated read-only catalog
 * and owns durable Profile / Session selection state. It deliberately does not
 * alter model requests; PR3 consumes this state at the request boundary.
 */
export class PromptControl extends Service {
  static inject = ['systemPrompt', 'storageDomain']

  static Config: z<PromptControlConfig> = z.object({
    maxProfileCount: z.natural().min(1).default(100),
    maxRulesPerProfile: z.natural().min(1).default(100),
  })

  private profiles?: KvTable<PromptProfileIdType, PromptProfileRecord>
  private rules?: KvTable<string, PromptProfileRuleRecord>
  private selections?: KvTable<SessionPromptSelection['sessionId'], SessionPromptSelectionRecord>
  private operations: Promise<void> = Promise.resolve()

  constructor(ctx: Context, private readonly config: PromptControlConfig = {}) {
    super(ctx, 'promptControl')
  }

  /** Open the Prompt Control storage domain and retain it for this service's lifecycle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(promptControlDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'prompt-control.domainClose')
    this.profiles = domain.table('profiles')
    this.rules = domain.table('profile_rules')
    this.selections = domain.table('session_selections')
  }

  /**
   * The evaluated, read-only view of the prompt contributions behind one
   * assembly of the requested scope. Delegates to `SystemPrompt.catalog`,
   * which owns the contract: per-contribution provenance, placement order,
   * dynamic flag, and `complete` claim; effective entries only unless
   * `includeShadowed` is requested; resolver functions never escape.
   * @param context - the scope and plugin-defined fields used to evaluate resolvers.
   * @param options - view options, such as including shadowed contributions.
   * @returns the frozen evaluated catalog for the requested scope.
   */
  catalog(context?: AssembleContext, options?: CatalogOptions): PromptCatalog {
    return this.ctx.systemPrompt.catalog(context, options)
  }

  /** List compact profile summaries without reading their prompt text. */
  listProfiles(): readonly PromptProfileSummary[] {
    return [...this.requireProfiles().entries()]
      .map(([, record]) => toSummary(record, this.ruleCount(record)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  }

  /**
   * Read one complete profile, including the rules committed at its revision.
   * @param id - Profile identity.
   * @returns the profile, or `undefined` when no profile has that identity.
   */
  getProfile(id: PromptProfileIdType): PromptProfile | undefined {
    const record = this.requireProfiles().get(id)
    return record === undefined ? undefined : this.profileFromRecord(record)
  }

  /**
   * Create an independent profile with a generated stable identity.
   * @param input - Initial display data and rules.
   * @returns the durably created profile at revision zero.
   */
  createProfile(input: PromptProfileCreate): Promise<PromptProfile> {
    return this.enqueue(async () => {
      const profiles = this.requireProfiles()
      const rules = input.rules ?? []
      validateProfileInput(input.name, input.description, rules, this.maxRulesPerProfile)
      if (profiles.size >= this.maxProfileCount) {
        throw new PromptProfileLimitError(`prompt profile limit (${this.maxProfileCount}) reached`)
      }
      const now = Date.now()
      const record: PromptProfileRecord = {
        id: PromptProfileId(randomUUID()),
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      }
      await this.writeRules(record.id, record.revision, rules)
      await profiles.put(record.id, record)
      return this.profileFromRecord(record)
    })
  }

  /**
   * Replace selected profile fields when the caller's revision is current.
   * @param id - Profile identity.
   * @param expectedRevision - Revision observed by the caller.
   * @param patch - Replacement fields.
   * @returns the committed profile.
   */
  updateProfile(id: PromptProfileIdType, expectedRevision: number, patch: PromptProfileUpdate): Promise<PromptProfile> {
    return this.enqueue(async () => {
      const profiles = this.requireProfiles()
      const current = profiles.get(id)
      if (current === undefined) throw new UnknownPromptProfileError(id)
      if (current.revision !== expectedRevision) {
        throw new PromptProfileConflictError(id, expectedRevision, current.revision)
      }
      const nextRules = patch.rules ?? this.rulesFor(current)
      const nextName = patch.name ?? current.name
      const nextDescription = patch.description === undefined
        ? current.description
        : patch.description === null ? undefined : patch.description
      validateProfileInput(nextName, nextDescription, nextRules, this.maxRulesPerProfile)
      const nextRevision = current.revision + 1
      const { description: _, ...base } = current
      const record: PromptProfileRecord = {
        ...base,
        name: nextName,
        ...(nextDescription === undefined ? {} : { description: nextDescription }),
        revision: nextRevision,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      }
      await this.writeRules(id, nextRevision, nextRules)
      await profiles.put(id, record)
      return this.profileFromRecord(record)
    })
  }

  /**
   * Delete an unreferenced profile at the caller's observed revision.
   * @param id - Profile identity.
   * @param expectedRevision - Revision observed by the caller.
   * @returns resolution once the profile header has been removed.
   */
  deleteProfile(id: PromptProfileIdType, expectedRevision: number): Promise<void> {
    return this.enqueue(async () => {
      const record = this.requireProfiles().get(id)
      if (record === undefined) throw new UnknownPromptProfileError(id)
      if (record.revision !== expectedRevision) {
        throw new PromptProfileConflictError(id, expectedRevision, record.revision)
      }
      const selection = [...this.requireSelections().entries()].find(([, value]) => value.profileId === id)
      if (selection !== undefined) throw new PromptProfileInUseError(id, selection[0])
      await this.requireProfiles().delete(id)
    })
  }

  /**
   * Read one session's profile selection.
   * @param sessionId - Durable session identity.
   * @returns the selection, or `undefined` while the session has no selection.
   */
  getSessionProfile(sessionId: SessionPromptSelection['sessionId']): SessionPromptSelection | undefined {
    const selection = this.requireSelections().get(sessionId)
    return selection === undefined ? undefined : { sessionId, profileId: selection.profileId }
  }

  /**
   * Select a profile for a session, or clear the selection with `undefined`.
   * @param sessionId - Durable session identity.
   * @param profileId - Existing profile identity, or `undefined` to clear.
   * @returns resolution after the selection is durable.
   */
  selectSessionProfile(sessionId: SessionPromptSelection['sessionId'], profileId?: PromptProfileIdType): Promise<void> {
    return this.enqueue(async () => {
      if (profileId === undefined) {
        await this.requireSelections().delete(sessionId)
        return
      }
      if (this.requireProfiles().get(profileId) === undefined) throw new UnknownPromptProfileError(profileId)
      await this.requireSelections().put(sessionId, { profileId })
    })
  }

  private get maxProfileCount(): number {
    return this.config.maxProfileCount ?? 100
  }

  private get maxRulesPerProfile(): number {
    return this.config.maxRulesPerProfile ?? 100
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.catch(() => undefined).then(operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private profileFromRecord(record: PromptProfileRecord): PromptProfile {
    return {
      id: record.id,
      name: record.name,
      ...(record.description === undefined ? {} : { description: record.description }),
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      rules: this.rulesFor(record),
    }
  }

  private rulesFor(record: PromptProfileRecord): readonly PromptRule[] {
    return [...this.requireRules().entries()]
      .filter(([, value]) => value.profileId === record.id && value.revision === record.revision)
      .map(([, value]) => value.rule)
  }

  private ruleCount(record: PromptProfileRecord): number {
    return this.rulesFor(record).length
  }

  private async writeRules(profileId: PromptProfileIdType, revision: number, rules: readonly PromptRule[]): Promise<void> {
    for (const rule of rules) {
      await this.requireRules().put(promptProfileRuleKey(profileId, revision, rule.id), { profileId, revision, rule })
    }
  }

  private requireProfiles(): KvTable<PromptProfileIdType, PromptProfileRecord> {
    if (this.profiles === undefined) throw new Error('prompt-control service is not started')
    return this.profiles
  }

  private requireRules(): KvTable<string, PromptProfileRuleRecord> {
    if (this.rules === undefined) throw new Error('prompt-control service is not started')
    return this.rules
  }

  private requireSelections(): KvTable<SessionPromptSelection['sessionId'], SessionPromptSelectionRecord> {
    if (this.selections === undefined) throw new Error('prompt-control service is not started')
    return this.selections
  }
}

/** Deployment limits for one Prompt Control provider. */
export interface PromptControlConfig {
  /** Maximum durable profiles admitted by this provider. */
  readonly maxProfileCount?: number
  /** Maximum rules admitted by one profile. */
  readonly maxRulesPerProfile?: number
}

/** A profile id not present in the durable profile table. */
export class UnknownPromptProfileError extends Error {
  constructor(readonly profileId: PromptProfileIdType) {
    super(`prompt profile '${profileId}' does not exist`)
  }
}

/** A profile write based on a stale revision. */
export class PromptProfileConflictError extends Error {
  constructor(readonly profileId: PromptProfileIdType, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`prompt profile '${profileId}' expected revision ${expectedRevision}, found ${actualRevision}`)
  }
}

/** A configured profile or rule collection limit was reached. */
export class PromptProfileLimitError extends Error {}

/** A session selection still refers to the profile proposed for deletion. */
export class PromptProfileInUseError extends Error {
  constructor(readonly profileId: PromptProfileIdType, readonly sessionId: SessionPromptSelection['sessionId']) {
    super(`prompt profile '${profileId}' is selected by session '${sessionId}'`)
  }
}

function validateProfileInput(
  name: string,
  description: string | undefined,
  rules: readonly PromptRule[],
  maxRules: number,
): void {
  if (name.trim().length === 0) throw new TypeError('prompt profile name must not be blank')
  if (description !== undefined && typeof description !== 'string') throw new TypeError('prompt profile description must be a string')
  if (rules.length > maxRules) throw new PromptProfileLimitError(`prompt profile rule limit (${maxRules}) exceeded`)
  validatePromptRuleLayer(rules)
}

function toSummary(record: PromptProfileRecord, ruleCount: number): PromptProfileSummary {
  return {
    id: record.id,
    name: record.name,
    ...(record.description === undefined ? {} : { description: record.description }),
    revision: record.revision,
    ruleCount,
    updatedAt: record.updatedAt,
  }
}

export default PromptControl

export type {
  AssembleContext,
  CatalogContext,
  CatalogOptions,
  CatalogSection,
  CatalogVariable,
  PromptCatalog,
  PromptContributionId,
  PromptContributionLifetime,
  PromptContributionSource,
} from '@deepseek-ai/dsh-system-prompt'

export {
  PromptProfileId,
  PromptRuleId,
} from './model.ts'
export type {
  AppendRequestPromptRule,
  DisablePromptRule,
  EnablePromptRule,
  PromptProfile,
  PromptProfileCreate,
  PromptProfileSummary,
  PromptProfileUpdate,
  PromptRule,
  PromptRuleAction,
  PromptRuleBase,
  ReplacePromptRule,
  SessionPromptSelection,
} from './model.ts'
export {
  evaluatePromptRules,
  PromptRuleValidationError,
  UnknownPromptContributionError,
  validatePromptRuleLayer,
} from './rules.ts'
export type { EffectivePromptSection, PromptRuleEvaluation, RequestPromptAppend } from './rules.ts'

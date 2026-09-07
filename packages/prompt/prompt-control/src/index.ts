/**
 * Prompt Control service: session-scoped management of prompt contributions.
 *
 * This service owns the read-only catalog, durable profile and selection
 * state, P0 rule evaluation, and conversation-request finalization.
 *
 * @module @deepseek-ai/dsh-prompt-control
 */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  agentLoopRequestContext,
  freezeMessage,
  MessageId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, MessageSourceMap, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, CatalogOptions, PromptCatalog, PromptContributionId } from '@deepseek-ai/dsh-system-prompt'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { PromptControlController } from './controller.ts'
import {
  PromptProfileConflictError,
  PromptProfileInUseError,
  PromptProfileLimitError,
  UnknownPromptProfileError,
} from './errors.ts'
import { promptControlDomainSpec, promptProfileRuleKey } from './spec.ts'
import type { PromptProfileRecord, PromptProfileRuleRecord, SessionPromptSelectionRecord } from './spec.ts'
import { evaluatePromptRules, validatePromptRuleLayer } from './rules.ts'
import type { PromptRuleSection } from './rules.ts'
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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Transient request-tail instruction inserted by Prompt Control. */
    'prompt-control': {
      readonly kind: 'prompt-control'
      readonly profileId: PromptProfileIdType
      readonly profileRevision: number
      readonly ruleId: string
    }
  }
}

/** The exact post-projection input accepted by an Adapter for one controlled conversation request. */
export interface PromptControlRequestInput {
  /** P0 records only ordinary Agent Loop conversation requests. */
  readonly purpose: 'conversation'
  /** Durable loop coordinates for this model attempt. */
  readonly turn: number
  readonly step: number
  readonly attempt: number
  /** The session's selected base preset, when the session was preset-composed. */
  readonly basePresetId?: string
  /** Profile that finalized this request. */
  readonly profileId: PromptProfileIdType
  /** Immutable profile revision used for this request. */
  readonly profileRevision: number
  /** Effective P0 profile rules, in deterministic application order. */
  readonly ruleIds: readonly string[]
  /** Adapter route and model after finalization. */
  readonly provider: string
  readonly model: string
  /** Projected system slot, absent when the request has none. */
  readonly system?: string
  /** Exact projected message list accepted by the Adapter. */
  readonly messages: readonly Message[]
  /** Exact tool schema list accepted by the Adapter, absent when none was sent. */
  readonly tools?: readonly ToolSchema[]
}

/** Read-only finalization result for one loop-built conversation request draft. */
export interface PromptControlRequestPreview {
  /** Selected profile when one applied to this draft. */
  readonly profileId?: PromptProfileIdType
  /** Selected profile revision when one applied to this draft. */
  readonly profileRevision?: number
  /** Effective P0 rule ids in deterministic application order. */
  readonly ruleIds: readonly string[]
  /** Final system slot after Prompt Control rules. */
  readonly system?: string
  /** Final conversation messages after request-only append rules. */
  readonly messages: readonly Message[]
  /** The loop-assembled tools, unchanged by P0 rules. */
  readonly tools?: readonly ToolSchema[]
}

/** Combined read-only source view for prompt contributions and registered tools. */
export interface PromptControlCatalog extends PromptCatalog {
  /** Tool registrations visible to the assembly scope, when the tool runtime is mounted. */
  readonly tools: PromptControlToolCatalog
}

const EMPTY_TOOL_CATALOG: PromptControlToolCatalog = Object.freeze({ tools: Object.freeze([]) })

/** Minimal optional runtime contract; Prompt Control must not depend on the tool implementation. */
interface ToolCatalogRuntime {
  catalog(scope?: AssembleContext['scope'], options?: CatalogOptions): PromptControlToolCatalog
}

/** Tool catalog provenance, kept structural so the tools integration remains optional. */
export interface PromptControlToolRegistrationSource {
  readonly ownerPackage: string
  readonly scope?: AssembleContext['scope']
}

/** One detached tool schema with its registration provenance. */
export interface PromptControlToolCatalogEntry {
  readonly name: string
  readonly source: PromptControlToolRegistrationSource
  readonly schema: ToolSchema
  readonly effective: boolean
  readonly shadowedBy?: AssembleContext['scope']
}

/** Tool registrations attached to the Prompt Control source view when mounted. */
export interface PromptControlToolCatalog {
  readonly tools: readonly PromptControlToolCatalogEntry[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required post-projection audit record for one Prompt-Controlled conversation request. */
    'request/input': PromptControlRequestInput
  }
}

/**
 * Session-scoped prompt management.
 *
 * The service exposes the system-prompt registry's evaluated read-only catalog
 * and owns durable Profile / Session selection state. For loop-built
 * conversation requests, it applies the selected Profile at `llm/stream`
 * using the loop's retained post-assembly sections and variables.
 */
export class PromptControl extends Service {
  static inject = ['systemPrompt', 'storageDomain', 'llm', 'sessions']

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
    this.ctx.on('llm/stream', (options, next) => this.finalizeConversationRequest(options, next))
    this.ctx.plugin(PromptControlController)
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
  catalog(context?: AssembleContext, options?: CatalogOptions): PromptControlCatalog {
    const prompt = this.ctx.systemPrompt.catalog(context, options)
    const tools = (this.ctx.get('tools') as ToolCatalogRuntime | undefined)?.catalog(context?.scope, options) ?? EMPTY_TOOL_CATALOG
    return Object.freeze({ ...prompt, tools })
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

  /**
   * Finalize a loop-prepared conversation draft without entering `llm/stream`
   * or writing any Session state.
   * @param request - a read-only draft returned by `AgentLoop.prepareConversationRequest`.
   * @returns the system, messages, tools, and rules that a matching real request uses.
   */
  previewConversationRequest(request: GenerateOptions): PromptControlRequestPreview {
    if (request.purpose !== undefined || request.sessionId === undefined) {
      throw new Error('prompt-control preview requires a loop-built conversation request')
    }
    if (agentLoopRequestContext(request) === undefined) {
      throw new Error('prompt-control preview requires a loop-built request context')
    }
    const selection = this.getSessionProfile(request.sessionId)
    if (selection?.profileId === undefined) return previewUncontrolledRequest(request)
    const profile = this.getProfile(selection.profileId)
    if (profile === undefined) throw new UnknownPromptProfileError(selection.profileId)
    return finalizePromptControlRequest(request, profile)
  }

  /** Apply one selected Profile to a loop-built conversation request. */
  private finalizeConversationRequest(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined || options.sessionId === undefined) return next()
    const context = agentLoopRequestContext(options)
    if (context === undefined) return next()
    const preview = this.previewConversationRequest(options)
    const finalization = finalizedPreview(preview)
    if (finalization === undefined) return next()
    const { system: _system, ...withoutSystem } = options
    this.ctx.llm.replaceStreamRequest(options, {
      ...withoutSystem,
      messages: [...preview.messages],
      ...preview.system === undefined ? {} : { system: preview.system },
    })
    if (context.attempt !== undefined) {
      const session = this.ctx.sessions.get(options.sessionId)
      if (session === undefined) throw new Error(`prompt-control cannot audit missing session '${String(options.sessionId)}'`)
      this.ctx.llm.registerStreamDispatchAudit(options, (adapterOptions) => {
        this.appendRequestInput(session, context, finalization, adapterOptions)
      })
    }
    return next()
  }

  /** Persist the exact projected adapter input before Provider I/O begins. */
  private appendRequestInput(
    session: Session,
    context: NonNullable<ReturnType<typeof agentLoopRequestContext>>,
    finalization: PromptControlFinalizedRequest,
    options: GenerateOptions,
  ): void {
    if (context.attempt === undefined) throw new Error('prompt-control finalization lacks a stamped loop request context')
    const basePresetId = currentBasePresetId(session)
    session.append('request/input', {
      purpose: 'conversation',
      turn: context.turn,
      step: context.step,
      attempt: context.attempt,
      ...basePresetId === undefined ? {} : { basePresetId },
      profileId: finalization.profileId,
      profileRevision: finalization.profileRevision,
      ruleIds: finalization.ruleIds,
      provider: options.provider,
      model: options.model,
      ...options.system === undefined ? {} : { system: options.system },
      messages: options.messages,
      ...options.tools === undefined ? {} : { tools: options.tools },
    } satisfies SessionEventMap['request/input'])
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

/** Return the unchanged loop draft when no Profile is selected. */
function previewUncontrolledRequest(request: GenerateOptions): PromptControlRequestPreview {
  return Object.freeze({
    ruleIds: Object.freeze([]),
    ...request.system === undefined ? {} : { system: request.system },
    messages: Object.freeze([...request.messages]),
    ...request.tools === undefined ? {} : { tools: Object.freeze([...request.tools]) },
  })
}

interface PromptControlFinalizedRequest extends PromptControlRequestPreview {
  readonly profileId: PromptProfileIdType
  readonly profileRevision: number
}

/** Narrow a preview result to one that applied a selected Profile. */
function finalizedPreview(preview: PromptControlRequestPreview): PromptControlFinalizedRequest | undefined {
  if (preview.profileId === undefined || preview.profileRevision === undefined) return undefined
  return preview as PromptControlFinalizedRequest
}

/**
 * Apply one Profile to a loop-built request without registering a replacement,
 * audit, or other LLM lifecycle state.
 */
function finalizePromptControlRequest(request: GenerateOptions, profile: PromptProfile): PromptControlFinalizedRequest {
  const context = agentLoopRequestContext(request)
  if (context === undefined) throw new Error('prompt-control finalization requires a loop-built request context')
  const evaluation = evaluatePromptRules(
    context.prompt.sections.map((section, order): PromptRuleSection => ({
      id: section.name as PromptContributionId,
      order,
      text: section.text,
      effective: true,
    })),
    profile.rules,
  )
  const system = renderPrompt({
    sections: evaluation.sections.map(section => ({ name: section.id, text: section.text })),
    contexts: [],
    tools: [],
    variables: { ...context.prompt.variables },
  })
  const appended = evaluation.appendedRequests.flatMap((append) => {
    const text = renderPrompt({
      sections: [{ name: `prompt-control:${append.ruleId}`, text: append.text }],
      contexts: [],
      tools: [],
      variables: { ...context.prompt.variables },
    })
    if (text.length === 0) return []
    const source: MessageSourceMap['prompt-control'] = {
      kind: 'prompt-control',
      profileId: profile.id,
      profileRevision: profile.revision,
      ruleId: append.ruleId,
    }
    return [freezeMessage({
      id: MessageId(`prompt-control:${profile.id}:${profile.revision}:${append.ruleId}`),
      role: append.role,
      content: [{ type: 'text', text }],
      source,
    })]
  })
  return Object.freeze({
    profileId: profile.id,
    profileRevision: profile.revision,
    ruleIds: Object.freeze([...evaluationRuleIds(profile.rules)]),
    ...system.length === 0 ? {} : { system },
    messages: Object.freeze([...request.messages, ...appended]),
    ...request.tools === undefined ? {} : { tools: Object.freeze([...request.tools]) },
  })
}

function evaluationRuleIds(rules: readonly PromptRule[]): readonly string[] {
  return rules
    .filter(rule => rule.enabled)
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(rule => rule.id)
}

/** Fold the same current preset state as the preset projection without importing its optional runtime. */
function currentBasePresetId(session: Session): string | undefined {
  const events = session.snapshotEvents() as readonly { readonly type: string; readonly data: unknown }[]
  const selected = events.findLast(event => event.type === 'agent-preset/selected')
  if (selected !== undefined
    && typeof selected.data === 'object'
    && selected.data !== null
    && typeof (selected.data as { agentPreset?: unknown }).agentPreset === 'string') {
    return (selected.data as { agentPreset: string }).agentPreset
  }
  return session.header.agentPreset
}

/** Deployment limits for one Prompt Control provider. */
export interface PromptControlConfig {
  /** Maximum durable profiles admitted by this provider. */
  readonly maxProfileCount?: number
  /** Maximum rules admitted by one profile. */
  readonly maxRulesPerProfile?: number
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
export {
  PromptProfileConflictError,
  PromptProfileInUseError,
  PromptProfileLimitError,
  UnknownPromptProfileError,
} from './errors.ts'
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

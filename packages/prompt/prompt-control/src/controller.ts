/** Typert Remote owner for the private Prompt Control management surface. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PromptControlCatalogView,
  PromptControlDeleteProfileRequest,
  PromptControlPreviewView,
  PromptControlSelectSessionProfileRequest,
  PromptControlSessionView,
  PromptControlUpdateProfileRequest,
} from './api.ts'
import type { PromptProfile, PromptProfileCreate, PromptProfileId, PromptProfileSummary } from './model.ts'
import {
  PromptProfileConflictError,
  PromptProfileInUseError,
  PromptProfileLimitError,
  UnknownPromptProfileError,
} from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the private `promptControl` Remote namespace. */
    promptControlController: PromptControlController
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A profile mutation used a stale revision. */
    'prompt-control/conflict': { readonly profileId: PromptProfileId; readonly expectedRevision: number; readonly actualRevision: number }
    /** A referenced profile or live Session was unavailable. */
    'prompt-control/not-found': { readonly id: string; readonly kind: 'profile' | 'session' }
    /** A valid mutation was refused by Prompt Control's domain rules. */
    'prompt-control/rejected': { readonly operation: string; readonly sessionId?: string }
  }
}

/** Host service backing the generated `ctx.remote.promptControl` namespace. */
export class PromptControlController extends TypertRemoteService {
  static inject = ['promptControl', 'agentLoop', 'agents', 'sessions', 'typert']

  /** @param ctx - Host context containing live Prompt Control and Agent Loop services. */
  constructor(ctx: Context) {
    super(ctx, 'promptControlController', { namespace: 'promptControl' })
  }

  /** List profile summaries for the management view. */
  @Remote
  listProfiles(): readonly PromptProfileSummary[] {
    return this.ctx.promptControl.listProfiles()
  }

  /** Read one complete profile. */
  @Remote
  getProfile(id: PromptProfileId): PromptProfile | undefined {
    return this.ctx.promptControl.getProfile(id)
  }

  /** Create one Profile from the editor's initial draft. */
  @Remote
  async createProfile(input: PromptProfileCreate): Promise<PromptProfile> {
    return this.write('createProfile', () => this.ctx.promptControl.createProfile(input))
  }

  /** Commit one revision-guarded Profile edit. */
  @Remote
  async updateProfile(request: PromptControlUpdateProfileRequest): Promise<PromptProfile> {
    return this.write('updateProfile', () =>
      this.ctx.promptControl.updateProfile(request.id, request.expectedRevision, request.patch))
  }

  /** Delete one unselected Profile at the caller's observed revision. */
  @Remote
  async deleteProfile(request: PromptControlDeleteProfileRequest): Promise<{ readonly deleted: true }> {
    await this.write('deleteProfile', () => this.ctx.promptControl.deleteProfile(request.id, request.expectedRevision))
    return { deleted: true }
  }

  /** Read the current Profile selection for one live Session. */
  @Remote
  getSessionProfile(sessionId: string): PromptControlSessionView {
    this.requireLiveSession(sessionId)
    const selection = this.ctx.promptControl.getSessionProfile(SessionId(sessionId))
    return selection === undefined ? {} : { selection }
  }

  /** Select or clear one live Session's Profile. */
  @Remote
  async selectSessionProfile(request: PromptControlSelectSessionProfileRequest): Promise<PromptControlSessionView> {
    this.requireLiveSession(request.sessionId)
    await this.write('selectSessionProfile', () =>
      this.ctx.promptControl.selectSessionProfile(SessionId(request.sessionId), request.profileId))
    const selection = this.ctx.promptControl.getSessionProfile(SessionId(request.sessionId))
    return selection === undefined ? {} : { selection }
  }

  /** Read the current live Session's evaluated source catalog. */
  @Remote
  catalog(sessionId: string): PromptControlCatalogView {
    const agent = this.requireLiveSession(sessionId)
    const scope = scopeOf(agent.ctx)
    const catalog = scope === undefined
      ? this.ctx.promptControl.catalog()
      : this.ctx.promptControl.catalog({ scope })
    return {
      sections: catalog.sections.map(section => ({
        id: section.id,
        name: section.name,
        lane: section.lane,
        source: { ownerPackage: section.source.ownerPackage },
        order: section.order,
        text: section.text,
        dynamic: section.dynamic,
        effective: section.effective,
        ...(section.complete ? { complete: true } : {}),
      })),
      contexts: catalog.contexts.map(context => ({
        id: context.id,
        name: context.name,
        lane: context.lane,
        source: { ownerPackage: context.source.ownerPackage },
        order: context.order,
        text: context.text,
        dynamic: context.dynamic,
        effective: context.effective,
      })),
      variables: catalog.variables.map(variable => ({
        id: variable.id,
        name: variable.name,
        source: { ownerPackage: variable.source.ownerPackage },
        ...(variable.value === undefined ? {} : { value: variable.value }),
        effective: variable.effective,
      })),
      tools: catalog.tools.tools.map(tool => ({
        name: tool.name,
        source: { ownerPackage: tool.source.ownerPackage },
        description: tool.schema.description,
        parameters: jsonView(tool.schema.parameters),
        effective: tool.effective,
      })),
    }
  }

  /** Assemble and finalize the current committed Session state without Provider I/O. */
  @Remote
  async previewRequest(sessionId: string): Promise<PromptControlPreviewView> {
    this.requireLiveSession(sessionId)
    const draft = await this.ctx.agentLoop.prepareConversationRequest(SessionId(sessionId))
    const preview = this.ctx.promptControl.previewConversationRequest(draft)
    return {
      ...preview.profileId === undefined ? {} : { profileId: preview.profileId },
      ...preview.profileRevision === undefined ? {} : { profileRevision: preview.profileRevision },
      ruleIds: preview.ruleIds,
      ...preview.system === undefined ? {} : { system: preview.system },
      messages: preview.messages.map(message => ({
        id: message.id,
        role: message.role,
        sourceKind: message.source.kind,
        content: jsonView(message.content),
      })),
      ...preview.tools === undefined ? {} : { tools: preview.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: jsonView(tool.parameters),
      })) },
    }
  }

  private requireLiveSession(sessionId: string) {
    const id = SessionId(sessionId)
    const agent = this.ctx.agents.get(id)
    if (agent === undefined || this.ctx.sessions.get(id) === undefined) {
      throw new RemoteError('prompt-control/not-found', `prompt-control cannot find live session '${sessionId}'`, {
        id: sessionId,
        kind: 'session',
      })
    }
    return agent
  }

  private async write<T>(operation: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write()
    } catch (error: unknown) {
      if (error instanceof PromptProfileConflictError) {
        throw new RemoteError('prompt-control/conflict', error.message, {
          profileId: error.profileId,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        }, { cause: error })
      }
      if (error instanceof UnknownPromptProfileError) {
        throw new RemoteError('prompt-control/not-found', error.message, {
          id: error.profileId,
          kind: 'profile',
        }, { cause: error })
      }
      if (error instanceof PromptProfileInUseError) {
        throw new RemoteError('prompt-control/rejected', error.message, {
          operation,
          sessionId: error.sessionId,
        }, { cause: error })
      }
      if (error instanceof PromptProfileLimitError || error instanceof TypeError) {
        throw new RemoteError('prompt-control/rejected', error.message, { operation }, { cause: error })
      }
      throw error
    }
  }
}

/** Render JSON-shaped values before they cross the private browser boundary. */
function jsonView(value: unknown): string {
  return JSON.stringify(value)
}

export default PromptControlController

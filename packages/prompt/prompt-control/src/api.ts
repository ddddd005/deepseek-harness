/** Browser-safe Host API vocabulary for the private Prompt Control surface. */

import type { PromptProfileId, PromptProfileUpdate, SessionPromptSelection } from './model.ts'

export type {
  PromptProfile,
  PromptProfileCreate,
  PromptProfileId,
  PromptProfileSummary,
  PromptProfileUpdate,
  PromptRule,
  SessionPromptSelection,
} from './model.ts'

/** A display-safe source reference for a catalog contribution. */
export interface PromptControlSourceView {
  readonly ownerPackage: string
}

/** One display-safe prompt catalog item. */
export interface PromptControlCatalogEntryView {
  readonly id: string
  readonly name: string
  readonly lane: 'system' | 'context'
  readonly source: PromptControlSourceView
  readonly order: number
  readonly text: string
  readonly dynamic: boolean
  readonly effective: boolean
  readonly complete?: boolean
}

/** One display-safe prompt variable. */
export interface PromptControlVariableView {
  readonly id: string
  readonly name: string
  readonly source: PromptControlSourceView
  readonly value?: string
  readonly effective: boolean
}

/** One display-safe tool schema and its registered source. */
export interface PromptControlToolView {
  readonly name: string
  readonly source: PromptControlSourceView
  readonly description: string
  /** JSON-formatted parameters, kept out of the Remote `unknown` boundary. */
  readonly parameters: string
  readonly effective: boolean
}

/** The current session's source catalog, stripped of process-local scope keys. */
export interface PromptControlCatalogView {
  readonly sections: readonly PromptControlCatalogEntryView[]
  readonly contexts: readonly PromptControlCatalogEntryView[]
  readonly variables: readonly PromptControlVariableView[]
  readonly tools: readonly PromptControlToolView[]
}

/** Current profile selection for the requested Session. */
export interface PromptControlSessionView {
  readonly selection?: SessionPromptSelection
}

/** One finalized message rendered for inspection, not a Provider wire message. */
export interface PromptControlPreviewMessageView {
  readonly id: string
  readonly role: string
  readonly sourceKind: string
  readonly content: string
}

/** One finalized tool schema rendered for inspection, not a Provider wire schema. */
export interface PromptControlPreviewToolView {
  readonly name: string
  readonly description: string
  readonly parameters: string
}

/** Basic request preview after the selected Profile's P0 finalization. */
export interface PromptControlPreviewView {
  readonly profileId?: PromptProfileId
  readonly profileRevision?: number
  readonly ruleIds: readonly string[]
  readonly system?: string
  readonly messages: readonly PromptControlPreviewMessageView[]
  readonly tools?: readonly PromptControlPreviewToolView[]
}

/** Replace a selected Session Profile, or clear it by omitting `profileId`. */
export interface PromptControlSelectSessionProfileRequest {
  readonly sessionId: string
  readonly profileId?: PromptProfileId
}

/** Profile update guarded by the revision the editor last read. */
export interface PromptControlUpdateProfileRequest {
  readonly id: PromptProfileId
  readonly expectedRevision: number
  readonly patch: PromptProfileUpdate
}

/** Profile deletion guarded by the revision the editor last read. */
export interface PromptControlDeleteProfileRequest {
  readonly id: PromptProfileId
  readonly expectedRevision: number
}

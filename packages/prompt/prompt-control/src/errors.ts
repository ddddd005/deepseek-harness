/** Prompt Control domain errors shared by the Host API and service. */

import type { PromptProfileId, SessionPromptSelection } from './model.ts'

/** A profile id not present in the durable profile table. */
export class UnknownPromptProfileError extends Error {
  constructor(readonly profileId: PromptProfileId) {
    super(`prompt profile '${profileId}' does not exist`)
  }
}

/** A profile write based on a stale revision. */
export class PromptProfileConflictError extends Error {
  constructor(readonly profileId: PromptProfileId, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`prompt profile '${profileId}' expected revision ${expectedRevision}, found ${actualRevision}`)
  }
}

/** A configured profile or rule collection limit was reached. */
export class PromptProfileLimitError extends Error {}

/** A session selection still refers to the profile proposed for deletion. */
export class PromptProfileInUseError extends Error {
  constructor(readonly profileId: PromptProfileId, readonly sessionId: SessionPromptSelection['sessionId']) {
    super(`prompt profile '${profileId}' is selected by session '${sessionId}'`)
  }
}

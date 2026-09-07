/**
 * Prompt Control service: session-scoped management of prompt contributions.
 *
 * This increment freezes the read-only catalog surface and the public brand
 * types. Prompt profiles, the rule interpreter, and request finalization land
 * in later increments behind the same service.
 *
 * @module @deepseek-ai/dsh-prompt-control
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, CatalogOptions, PromptCatalog } from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    promptControl: PromptControl
  }
}

/**
 * Session-scoped prompt management.
 *
 * The service owns no prompt state in this increment: it exposes the
 * system-prompt registry's evaluated read-only catalog under a frozen
 * signature that profile storage, the rule interpreter, and request
 * finalization build on.
 */
export class PromptControl extends Service {
  static inject = ['systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'promptControl')
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
  PromptProfileSummary,
  PromptRule,
  PromptRuleAction,
  PromptRuleBase,
  ReplacePromptRule,
  SessionPromptSelection,
} from './model.ts'

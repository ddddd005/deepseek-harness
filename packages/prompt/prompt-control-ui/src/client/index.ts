/** Private browser entry for Prompt Control. */

import promptControlRemote from '@deepseek-ai/dsh-prompt-control/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PromptControlSettings } from './PromptControlSettings.tsx'
import type { PromptControlSettingsInjected, PromptControlSettingsProps } from './PromptControlSettings.tsx'
import { en, zh, type PromptControlUiKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.promptControl': PromptControlUiKey
  }
}

export const inject = ['slots', 'locale', 'remote', 'sessions']

/** Mount the generated Host contract, then contribute the settings section. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register('settings.promptControl', { zh, en }), 'prompt-control-ui: dictionaries')
  const disposeRemote = await ctx.remote.$mount(promptControlRemote)
  const t = ctx.locale.bind('settings.promptControl') as PromptControlSettingsProps['t']
  const injected = (): PromptControlSettingsInjected => ({
    t,
    currentSession: ctx.sessions.list,
    api: {
      listProfiles: async () => unwrap(await ctx.remote.promptControl.listProfiles()),
      getProfile: async id => unwrap(await ctx.remote.promptControl.getProfile(id)),
      createProfile: async input => unwrap(await ctx.remote.promptControl.createProfile(input)),
      updateProfile: async request => unwrap(await ctx.remote.promptControl.updateProfile(request)),
      deleteProfile: async request => unwrap(await ctx.remote.promptControl.deleteProfile(request)),
      getSessionProfile: async sessionId => unwrap(await ctx.remote.promptControl.getSessionProfile(sessionId)),
      selectSessionProfile: async request => unwrap(await ctx.remote.promptControl.selectSessionProfile(request)),
      catalog: async sessionId => unwrap(await ctx.remote.promptControl.catalog(sessionId)),
      previewRequest: async sessionId => unwrap(await ctx.remote.promptControl.previewRequest(sessionId)),
    },
  })
  const disposeSlot = ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'prompt-control', order: 30,
    label: () => t('nav'), locale: 'settings.promptControl', inject: injected,
  }, PromptControlSettings))
  return async () => { disposeSlot(); await disposeRemote() }
}

function unwrap<T>(
  result: { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value
  throw Object.assign(new Error(result.error.message), { code: result.error.code })
}

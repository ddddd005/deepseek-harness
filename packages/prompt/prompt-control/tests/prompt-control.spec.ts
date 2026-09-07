import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import PromptControl, {
  PromptProfileConflictError,
  PromptProfileInUseError,
  PromptProfileLimitError,
  PromptRuleId,
} from '@deepseek-ai/dsh-prompt-control'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

async function mountControl(
  config: { persona?: string; maxProfileCount?: number; maxRulesPerProfile?: number } = {},
  pool = new MemoryMediaPool(),
): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> }; facility: DomainFacility; pool: MemoryMediaPool }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SystemPrompt, config)
  const fiber = await ctx.plugin(PromptControl, config)
  return { ctx, fiber, facility, pool }
}

async function mintScope(ctx: Context): Promise<Scope> {
  let scope!: Scope
  // The scoped context resolves services through the MINTING plugin's
  // dependency chain — the minter must inject what scope holders will reach.
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { holder: true }) },
    { inject: ['systemPrompt', 'promptControl'] }))
  return scope
}

describe('PromptControl service', () => {
  it('delegates the catalog read to the system-prompt registry', async () => {
    const { ctx } = await mountControl()
    ctx.systemPrompt.section({ name: 'delegated', order: 10, text: 'delegated text' })
    const viaControl = ctx.promptControl.catalog()
    const direct = ctx.systemPrompt.catalog()
    expect(viaControl).toEqual(direct)
    expect(viaControl.sections.map(section => section.name)).toContain('delegated')
  })

  it('passes the scope and shadow option through to the registry', async () => {
    const { ctx } = await mountControl()
    const scope = await mintScope(ctx)
    scope.ctx.systemPrompt.section({ name: 'dup', order: 10, text: 'scoped text' })
    ctx.systemPrompt.section({ name: 'dup', order: 10, text: 'global text' })
    const key = scopeOf(scope.ctx)!

    const effective = ctx.promptControl.catalog({ scope: key })
    expect(effective.sections.filter(section => section.name === 'dup')).toHaveLength(1)
    expect(effective.sections.find(section => section.name === 'dup')!.text).toBe('scoped text')
    const full = ctx.promptControl.catalog({ scope: key }, { includeShadowed: true })
    expect(full.sections.filter(section => section.name === 'dup')).toHaveLength(2)
  })

  it('leaves assembly identical whether prompt-control is mounted', async () => {
    const plain = new Context()
    await plain.plugin(SystemPrompt, { persona: 'Persona.' })
    const { ctx: managed } = await mountControl({ persona: 'Persona.' })
    plain.systemPrompt.section({ name: 'shared', order: 10, text: 'shared text' })
    managed.systemPrompt.section({ name: 'shared', order: 10, text: 'shared text' })
    const withoutControl = renderPrompt(await plain.systemPrompt.assemble())
    const withControl = renderPrompt(await managed.systemPrompt.assemble())
    expect(withControl).toBe(withoutControl)
    expect(withControl).toContain('shared text')
  })

  it('persists profiles, revisions, and session selections across a provider restart', async () => {
    const first = await mountControl()
    const profile = await first.ctx.promptControl.createProfile({
      name: 'Focused',
      description: 'Initial',
      rules: [{ id: PromptRuleId('append'), enabled: true, order: 0, action: 'append-request', role: 'system', text: 'Stay focused.' }],
    })
    const updated = await first.ctx.promptControl.updateProfile(profile.id, profile.revision, {
      name: 'Revised',
      description: null,
    })
    await first.ctx.promptControl.selectSessionProfile(SessionId('session-a'), updated.id)
    await first.fiber.dispose()

    const second = await mountControl({}, first.pool)
    expect(second.ctx.promptControl.listProfiles()).toEqual([{
      id: updated.id,
      name: 'Revised',
      revision: 1,
      ruleCount: 1,
      updatedAt: updated.updatedAt,
    }])
    expect(second.ctx.promptControl.getProfile(updated.id)).toEqual(updated)
    expect(second.ctx.promptControl.getSessionProfile(SessionId('session-a'))).toEqual({
      sessionId: SessionId('session-a'), profileId: updated.id,
    })
  })

  it('uses revision CAS, limits, selection clearing, and referenced-profile deletion rules', async () => {
    const { ctx } = await mountControl({ maxProfileCount: 1, maxRulesPerProfile: 1 })
    const profile = await ctx.promptControl.createProfile({ name: 'Only' })
    await expect(ctx.promptControl.createProfile({ name: 'Overflow' })).rejects.toBeInstanceOf(PromptProfileLimitError)
    await expect(ctx.promptControl.updateProfile(profile.id, 1, { name: 'Stale' }))
      .rejects.toBeInstanceOf(PromptProfileConflictError)
    await expect(ctx.promptControl.updateProfile(profile.id, 0, {
      rules: [
        { id: PromptRuleId('one'), enabled: true, order: 0, action: 'append-request', role: 'system', text: 'one' },
        { id: PromptRuleId('two'), enabled: true, order: 1, action: 'append-request', role: 'system', text: 'two' },
      ],
    })).rejects.toBeInstanceOf(PromptProfileLimitError)

    await ctx.promptControl.selectSessionProfile(SessionId('session-b'), profile.id)
    await expect(ctx.promptControl.deleteProfile(profile.id, 0)).rejects.toBeInstanceOf(PromptProfileInUseError)
    await ctx.promptControl.selectSessionProfile(SessionId('session-b'))
    expect(ctx.promptControl.getSessionProfile(SessionId('session-b'))).toBeUndefined()
    await ctx.promptControl.deleteProfile(profile.id, 0)
    expect(ctx.promptControl.getProfile(profile.id)).toBeUndefined()
  })

  it('opens its domain through the real storage facility and closes it on dispose', async () => {
    const { ctx, fiber, facility } = await mountControl()
    expect(facility.get('prompt_control')).toBeDefined()
    await fiber.dispose()
    expect(facility.get('prompt_control')).toBeUndefined()
    expect(ctx.get('promptControl')).toBeUndefined()
  })
})

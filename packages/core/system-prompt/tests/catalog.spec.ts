import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, Config } from '@deepseek-ai/dsh-system-prompt'

async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, config)
  return ctx
}

async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  // The scoped context resolves services through the MINTING plugin's
  // dependency chain — the minter must inject what scope holders will reach.
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

/** The key a test scope was minted with (scopeOf over the scope's own ctx). */
function scopeKeyOf(scope: Scope): ScopeKey {
  // scopeOf never answers undefined for a context the scope itself minted.
  return scopeOf(scope.ctx)!
}

describe('catalog entries', () => {
  it('distinguishes static from dynamic sections and evaluates resolver text', async () => {
    const ctx = await mount({ persona: 'Static persona.' })
    ctx.systemPrompt.section({
      name: 'dyn',
      order: 10,
      text: context => `resolved:${(context as AssembleContext & { tag?: string }).tag ?? 'none'}`,
    })
    const catalog = ctx.systemPrompt.catalog({ tag: 't1' } as AssembleContext)
    const dynamic = catalog.sections.find(section => section.name === 'dyn')!
    expect(dynamic.dynamic).toBe(true)
    expect(dynamic.text).toBe('resolved:t1')
    expect(dynamic.source.lifetime).toBe('dynamic-snapshot')
    const persona = catalog.sections.find(section => section.name === 'deployment:persona')!
    expect(persona.dynamic).toBe(false)
    expect(persona.text).toBe('Static persona.')
    expect(persona.source.lifetime).toBe('durable')
  })

  it('defaults to effective entries and marks shadowed ones only on request', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    ctx.systemPrompt.section({ name: 'dup', order: 10, text: 'global text' })
    scope.ctx.systemPrompt.section({ name: 'dup', order: 10, text: 'scoped text' })
    const key = scopeKeyOf(scope)

    const catalog = ctx.systemPrompt.catalog({ scope: key })
    const effective = catalog.sections.filter(section => section.name === 'dup')
    expect(effective).toHaveLength(1)
    expect(effective[0]!.text).toBe('scoped text')
    expect(effective[0]!.effective).toBe(true)
    expect(effective[0]!.source.scope).toBe(key)
    expect(effective[0]!.shadowedBy).toBeUndefined()

    const full = ctx.systemPrompt.catalog({ scope: key }, { includeShadowed: true })
    const shadows = full.sections.filter(section => section.name === 'dup')
    expect(shadows).toHaveLength(2)
    const shadowed = shadows.filter(section => !section.effective)
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.text).toBe('global text')
    expect(shadowed[0]!.source.scope).toBeUndefined()
    expect(shadowed[0]!.shadowedBy).toBe(key)
  })

  it('reports the complete claim without enforcing it', async () => {
    const ctx = await mount({ includeHarnessIdentity: false })
    ctx.systemPrompt.section({ name: 'solo', order: 0, text: 'Only me.', complete: true })
    ctx.systemPrompt.section({ name: 'extra', order: 1, text: 'Extra.' })
    const catalog = ctx.systemPrompt.catalog()
    const byName = new Map(catalog.sections.map(section => [section.name, section]))
    expect(byName.get('solo')!.complete).toBe(true)
    expect(byName.get('extra')!.complete).toBe(false)
    // The catalog still lists every registered section; assembly enforces the restore.
    expect(catalog.sections.map(section => section.name)).toContain('extra')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('Only me.')
  })

  it('brands the registered name as the stable contribution id', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'branded', order: 10, text: 'x' })
    ctx.systemPrompt.variable('tester', () => 'v')
    const catalog = ctx.systemPrompt.catalog()
    const section = catalog.sections.find(entry => entry.name === 'branded')!
    expect(section.id).toBe(section.name)
    expect(section.source.contributionId).toBe(section.name)
    const variable = catalog.variables.find(entry => entry.name === 'tester')!
    expect(variable.id).toBe(variable.name)
    expect(variable.source.contributionId).toBe(variable.name)
    // The brand is compile-time only: ids stay plain strings at runtime.
    expect(typeof section.id).toBe('string')
  })

  it('attributes scope and owner package to the registering fiber', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    scope.ctx.systemPrompt.section({ name: 'scoped:entry', order: 10, text: 'scoped' })
    let ownerCtx!: Context
    await ctx.plugin(Object.assign(function testOwner(inner: Context) { ownerCtx = inner },
      { inject: ['systemPrompt'] }))
    ownerCtx.systemPrompt.section({ name: 'owned:entry', order: 11, text: 'owned' })
    const catalog = ctx.systemPrompt.catalog({ scope: scopeKeyOf(scope) })
    const scoped = catalog.sections.find(section => section.name === 'scoped:entry')!
    expect(scoped.source.scope).toBe(scopeKeyOf(scope))
    const owned = catalog.sections.find(section => section.name === 'owned:entry')!
    expect(owned.source.ownerPackage).toBe('testOwner')
    const global = catalog.sections.find(section => section.name === 'harness:identity')!
    expect(global.source.scope).toBeUndefined()
  })

  it('marks shadowed contexts only on request', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const key = scopeKeyOf(scope)
    ctx.systemPrompt.context({ name: 'dup', order: 20, text: 'global context' })
    scope.ctx.systemPrompt.context({ name: 'dup', order: 10, text: 'scoped context' })

    const catalog = ctx.systemPrompt.catalog({ scope: key })
    expect(catalog.contexts.map(entry => entry.name)).toEqual(['dup'])
    expect(catalog.contexts[0]!.text).toBe('scoped context')

    const full = ctx.systemPrompt.catalog({ scope: key }, { includeShadowed: true })
    const shadows = full.contexts.filter(entry => entry.name === 'dup')
    expect(shadows).toHaveLength(2)
    // Effective first: the scoped entry's order 10 sorts before the global 20.
    expect(shadows[0]!.effective).toBe(true)
    expect(shadows[1]!.text).toBe('global context')
    expect(shadows[1]!.effective).toBe(false)
    expect(shadows[1]!.source.scope).toBeUndefined()
    expect(shadows[1]!.shadowedBy).toBe(key)
  })

  it('drops contributions once their disposer runs', async () => {
    const ctx = await mount()
    const dispose = ctx.systemPrompt.section({ name: 'fleeting', order: 10, text: 'here' })
    expect(ctx.systemPrompt.catalog().sections.some(section => section.name === 'fleeting')).toBe(true)
    dispose()
    expect(ctx.systemPrompt.catalog().sections.some(section => section.name === 'fleeting')).toBe(false)
  })

  it('lists variables with evaluated values and shadowing', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const key = scopeKeyOf(scope)
    ctx.systemPrompt.variable('region', () => 'global-region')
    ctx.systemPrompt.variable('absent', () => undefined)
    scope.ctx.systemPrompt.variable('region', () => 'scoped-region')

    const catalog = ctx.systemPrompt.catalog({ scope: key })
    const region = catalog.variables.find(entry => entry.name === 'region')!
    expect(region.value).toBe('scoped-region')
    expect(region.effective).toBe(true)
    expect(region.source.scope).toBe(key)
    expect(catalog.variables.find(entry => entry.name === 'absent')!.value).toBeUndefined()

    const full = ctx.systemPrompt.catalog({ scope: key }, { includeShadowed: true })
    const regions = full.variables.filter(entry => entry.name === 'region')
    expect(regions).toHaveLength(2)
    const shadowed = regions.filter(entry => !entry.effective)
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.value).toBe('global-region')
    expect(shadowed[0]!.shadowedBy).toBe(key)
  })
})

describe('catalog assembly parity', () => {
  it('leaves assembly results untouched by catalog reads', async () => {
    const ctx = await mount({ persona: 'Persona text.' })
    const before = renderPrompt(await ctx.systemPrompt.assemble())
    ctx.systemPrompt.catalog()
    ctx.systemPrompt.catalog(undefined, { includeShadowed: true })
    const after = renderPrompt(await ctx.systemPrompt.assemble())
    expect(after).toBe(before)
  })

  it('orders default sections exactly like the assembly does', async () => {
    const ctx = await mount({ persona: 'Persona text.' })
    ctx.systemPrompt.section({ name: 'zeta', order: 10, text: 'zeta text' })
    ctx.systemPrompt.section({ name: 'alpha', order: 10, text: 'alpha text' })
    const catalog = ctx.systemPrompt.catalog()
    const assembled = (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
    expect(catalog.sections.map(section => section.name)).toEqual(assembled)
  })

  it('mirrors runtime-context suppression with an empty context view', async () => {
    const ctx = await mount({ includeRuntimeContext: false })
    ctx.systemPrompt.context({ name: 'policy', order: 10, text: 'policy text' })
    expect(ctx.systemPrompt.catalog().contexts).toHaveLength(0)
    const allowed = await mount()
    allowed.systemPrompt.context({ name: 'policy', order: 10, text: 'policy text' })
    expect(allowed.systemPrompt.catalog().contexts.map(entry => entry.text)).toContain('policy text')
  })

  it('mirrors scoped suppression only inside that scope', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    ctx.systemPrompt.context({ name: 'policy', order: 10, text: 'policy text' })
    scope.ctx.systemPrompt.suppressRuntimeContext()
    expect(ctx.systemPrompt.catalog({ scope: scopeKeyOf(scope) }).contexts).toHaveLength(0)
    expect(ctx.systemPrompt.catalog().contexts.map(entry => entry.name)).toContain('policy')
  })

  it('propagates resolver evaluation failures like assembly does', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({
      name: 'boom',
      order: 10,
      text: () => {
        throw new Error('resolver failed')
      },
    })
    expect(() => ctx.systemPrompt.catalog()).toThrow('resolver failed')
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow('resolver failed')
  })

  it('freezes the returned catalog structure', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'frozen', order: 10, text: 'x' })
    const catalog = ctx.systemPrompt.catalog()
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.sections)).toBe(true)
    const section = catalog.sections[0]!
    expect(Object.isFrozen(section)).toBe(true)
    expect(Object.isFrozen(section.source)).toBe(true)
  })
})

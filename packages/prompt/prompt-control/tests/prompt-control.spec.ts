import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import PromptControl from '@deepseek-ai/dsh-prompt-control'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

async function mountControl(config: { persona?: string } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, config)
  await ctx.plugin(PromptControl)
  return ctx
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
    const ctx = await mountControl()
    ctx.systemPrompt.section({ name: 'delegated', order: 10, text: 'delegated text' })
    const viaControl = ctx.promptControl.catalog()
    const direct = ctx.systemPrompt.catalog()
    expect(viaControl).toEqual(direct)
    expect(viaControl.sections.map(section => section.name)).toContain('delegated')
  })

  it('passes the scope and shadow option through to the registry', async () => {
    const ctx = await mountControl()
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
    const managed = await mountControl({ persona: 'Persona.' })
    plain.systemPrompt.section({ name: 'shared', order: 10, text: 'shared text' })
    managed.systemPrompt.section({ name: 'shared', order: 10, text: 'shared text' })
    const withoutControl = renderPrompt(await plain.systemPrompt.assemble())
    const withControl = renderPrompt(await managed.systemPrompt.assemble())
    expect(withControl).toBe(withoutControl)
    expect(withControl).toContain('shared text')
  })
})

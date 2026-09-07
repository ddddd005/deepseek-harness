import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import PromptControl, {
  PromptProfileConflictError,
  PromptProfileInUseError,
  PromptProfileLimitError,
  PromptRuleId,
  UnknownPromptContributionError,
} from '@deepseek-ai/dsh-prompt-control'
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  markAgentLoopRequest,
  stampAgentLoopRequestAttempt,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

class RecordingAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined
  requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

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
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
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

async function mountLoopControl() {
  const mounted = await mountControl()
  const { ctx } = mounted
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ...mounted, adapter }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('PromptControl service', () => {
  it('delegates the catalog read to the system-prompt registry', async () => {
    const { ctx } = await mountControl()
    ctx.systemPrompt.section({ name: 'delegated', order: 10, text: 'delegated text' })
    const viaControl = ctx.promptControl.catalog()
    const direct = ctx.systemPrompt.catalog()
    expect(viaControl.sections).toEqual(direct.sections)
    expect(viaControl.contexts).toEqual(direct.contexts)
    expect(viaControl.variables).toEqual(direct.variables)
    expect(viaControl.tools.tools).toEqual([])
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

  it('finalizes a selected Profile from the loop post-assembly context', async () => {
    const { ctx } = await mountControl()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['route'], adapter)
    const profile = await ctx.promptControl.createProfile({
      name: 'Controlled',
      rules: [
        { id: PromptRuleId('replace'), enabled: true, order: 0, action: 'replace', target: 'base' as never, text: 'Profile {{name}}' },
        { id: PromptRuleId('disable'), enabled: true, order: 1, action: 'disable', target: 'removed' as never },
        { id: PromptRuleId('system-tail'), enabled: true, order: 2, action: 'append-request', role: 'system', text: 'System {{name}}' },
        { id: PromptRuleId('user-tail'), enabled: true, order: 3, action: 'append-request', role: 'user', text: 'User {{name}}' },
      ],
    })
    const sessionId = SessionId('session-finalized')
    await ctx.promptControl.selectSessionProfile(sessionId, profile.id)
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'route',
      model: 'model',
      system: 'Base world\n\nRemoved',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'History' }], source: { kind: 'user' } })],
      sessionId,
    }), {
      turn: 1,
      step: 1,
      prompt: {
        scope: ctx,
        sections: [
          { name: 'base', text: 'Base {{name}}' },
          { name: 'removed', text: 'Removed' },
        ],
        variables: { name: 'world' },
      },
    })

    await collect(ctx.llm.stream(request))

    expect(adapter.lastOptions?.system).toBe('Profile world')
    expect(adapter.lastOptions?.messages.map(message => [message.role, message.content[0]?.type === 'text' ? message.content[0].text : undefined]))
      .toEqual([['user', 'History'], ['system', 'System world'], ['user', 'User world']])
    expect(adapter.lastOptions?.messages.slice(1).map(message => message.source.kind))
      .toEqual(['prompt-control', 'prompt-control'])
  })

  it('does not finalize auxiliary model calls', async () => {
    const { ctx } = await mountControl()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['route'], adapter)
    const profile = await ctx.promptControl.createProfile({
      name: 'Controlled',
      rules: [{ id: PromptRuleId('append'), enabled: true, order: 0, action: 'append-request', role: 'user', text: 'Ignored' }],
    })
    const sessionId = SessionId('session-auxiliary')
    await ctx.promptControl.selectSessionProfile(sessionId, profile.id)
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'route',
      model: 'model',
      system: 'Original',
      messages: [],
      sessionId,
      purpose: 'session-title' as const,
    }), {
      turn: 1,
      step: 1,
      prompt: { scope: ctx, sections: [{ name: 'base', text: 'Base' }], variables: {} },
    })

    await collect(ctx.llm.stream(request))

    expect(adapter.lastOptions).toBe(request)
  })

  it('uses AgentLoop post-waterfall sections and unregisters finalization on disposal', async () => {
    const { ctx, fiber, adapter } = await mountLoopControl()
    ctx.tools.register(defineContentToolFixture({
      name: 'cataloged-tool',
      description: 'A cataloged test tool.',
      parameters: { query: { type: 'string' } },
      async execute() { return [] },
    }))
    ctx.systemPrompt.variable('name', () => 'world')
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const resolved = await next()
      return { ...resolved, sections: [...assembly.sections, { name: 'waterfall', text: 'Waterfall {{name}}' }] }
    })
    const profile = await ctx.promptControl.createProfile({
      name: 'Controlled',
      rules: [
        { id: PromptRuleId('replace'), enabled: true, order: 0, action: 'replace', target: 'waterfall' as never, text: 'Profile {{name}}' },
        { id: PromptRuleId('tail'), enabled: true, order: 1, action: 'append-request', role: 'user', text: 'Tail {{name}}' },
      ],
    })
    const sessionId = SessionId('loop-finalized')
    await ctx.promptControl.selectSessionProfile(sessionId, profile.id)
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    expect(adapter.requests[0]?.system).toContain('Profile world')
    expect(adapter.requests[0]?.system).not.toContain('Waterfall world')
    expect(adapter.requests[0]?.messages.at(-1)?.source.kind).toBe('prompt-control')
    const audit = ctx.sessions.get(sessionId)?.snapshotEvents().find(event => event.type === 'request/input')
    expect(audit?.type).toBe('request/input')
    if (audit?.type !== 'request/input') throw new Error('expected request/input audit event')
    expect(audit.data).toMatchObject({
      purpose: 'conversation',
      turn: 1,
      step: 1,
      attempt: 1,
      profileId: profile.id,
      profileRevision: profile.revision,
      ruleIds: ['replace', 'tail'],
      provider: 'mock',
      model: 'mock',
    })
    expect({
      system: audit.data.system,
      messages: audit.data.messages,
      tools: audit.data.tools,
    }).toEqual({
      system: adapter.requests[0]?.system,
      messages: adapter.requests[0]?.messages,
      tools: adapter.requests[0]?.tools,
    })
    const catalogedTool = ctx.promptControl.catalog().tools.tools.find(tool => tool.name === 'cataloged-tool')
    expect(catalogedTool?.effective).toBe(true)
    expect(catalogedTool?.source.ownerPackage).toBeTruthy()
    expect(audit.data.tools?.find(tool => tool.name === 'cataloged-tool')).toEqual(catalogedTool?.schema)
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error('expected finalized loop session')
    const restored = Session.create(SessionId('loop-finalized-restored'), session.snapshotEvents())
    expect(restored.snapshotEvents().some(event => event.type === 'request/input')).toBe(true)
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
    const forked = ctx.sessions.fork(session, undefined, SessionId('loop-finalized-fork'))
    expect(forked.snapshotEvents().some(event => event.type === 'request/input')).toBe(true)
    expect(forked.deriveMessages()).toEqual(session.deriveMessages())
    await fiber.dispose()

    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests[1]?.system).toContain('Waterfall world')
    expect(adapter.requests[1]?.system).not.toContain('Profile world')
    expect(adapter.requests[1]?.messages.some(message => message.source.kind === 'prompt-control')).toBe(false)
  })

  it('prevents provider I/O when finalization or request auditing fails', async () => {
    const { ctx, adapter } = await mountLoopControl()
    const sessionId = SessionId('blocked-finalization')
    const session = ctx.sessions.create(sessionId)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const profile = await ctx.promptControl.createProfile({
      name: 'Broken',
      rules: [{ id: PromptRuleId('missing'), enabled: true, order: 0, action: 'disable', target: 'missing' as never }],
    })
    await ctx.promptControl.selectSessionProfile(sessionId, profile.id)
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock', model: 'mock', messages: [], sessionId,
    }), {
      turn: 1,
      step: 1,
      prompt: { scope: ctx, sections: [{ name: 'present', text: 'present' }], variables: {} },
    })

    expect(() => ctx.llm.stream(request)).toThrow(UnknownPromptContributionError)
    expect(adapter.requests).toHaveLength(0)

    const valid = await ctx.promptControl.updateProfile(profile.id, profile.revision, {
      rules: [{ id: PromptRuleId('tail'), enabled: true, order: 0, action: 'append-request', role: 'user', text: 'tail' }],
    })
    const audited = markAgentLoopRequest(Object.freeze({
      provider: 'mock', model: 'mock', messages: [], sessionId,
    }), {
      turn: 1,
      step: 1,
      prompt: { scope: ctx, sections: [{ name: 'present', text: 'present' }], variables: {} },
    })
    stampAgentLoopRequestAttempt(audited, 1)
    vi.spyOn(session, 'append').mockImplementation((type, ...args) => {
      if (type === 'request/input') throw new Error('audit storage failed')
      throw new Error(`unexpected session event with ${args.length} arguments`)
    })

    await collect(ctx.llm.stream(audited))
    expect(valid.revision).toBe(1)
    expect(adapter.requests).toHaveLength(0)
  })

  it('retains a finalized request audit after disposal and records the current preset selection', async () => {
    const { ctx, fiber, adapter } = await mountLoopControl()
    const sessionId = SessionId('retained-audit')
    const session = ctx.sessions.create(sessionId, { meta: { agentPreset: 'created-preset' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const appendExtensionEvent = session.append.bind(session) as unknown as (type: string, data: unknown) => unknown
    appendExtensionEvent('agent-preset/selected', { agentPreset: 'selected-preset' })
    const profile = await ctx.promptControl.createProfile({
      name: 'Controlled',
      rules: [{ id: PromptRuleId('tail'), enabled: true, order: 0, action: 'append-request', role: 'user', text: 'tail' }],
    })
    await ctx.promptControl.selectSessionProfile(sessionId, profile.id)
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock', model: 'mock', messages: [], sessionId,
    }), {
      turn: 1,
      step: 1,
      prompt: { scope: ctx, sections: [], variables: {} },
    })
    stampAgentLoopRequestAttempt(request, 1)

    const stream = ctx.llm.stream(request)
    await fiber.dispose()
    await collect(stream)

    const audit = session.snapshotEvents().findLast(event => event.type === 'request/input')
    expect(audit?.type).toBe('request/input')
    if (audit?.type !== 'request/input') throw new Error('expected retained request/input audit event')
    expect(audit.data.basePresetId).toBe('selected-preset')
    expect(adapter.requests).toHaveLength(1)
  })
})

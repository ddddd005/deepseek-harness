// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import PromptControl from '@deepseek-ai/dsh-prompt-control'
import type { PromptProfileId } from '@deepseek-ai/dsh-prompt-control/types'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { PromptControlSettings } from '../src/client/PromptControlSettings.tsx'
import type { PromptControlSettingsProps } from '../src/client/PromptControlSettings.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

class RecordingAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
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

async function boot() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(PromptControl)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

describe('Prompt Control browser critical flow', () => {
  it('creates and selects a Profile, previews it, then sends a finalized request', async () => {
    const { ctx, adapter } = await boot()
    const sessionId = SessionId('browser-critical-flow')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Committed history' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const sessions = createSnapshotStore({ current: sessionId })
    const controller = ctx.promptControlController
    const props = {
      currentSession: sessions,
      t: (key: keyof typeof en) => en[key],
      api: {
        listProfiles: async () => controller.listProfiles(),
        getProfile: async (id: PromptProfileId) => controller.getProfile(id),
        createProfile: async (input: Parameters<typeof controller.createProfile>[0]) => controller.createProfile(input),
        updateProfile: async (request: Parameters<typeof controller.updateProfile>[0]) => controller.updateProfile(request),
        deleteProfile: async (request: Parameters<typeof controller.deleteProfile>[0]) => controller.deleteProfile(request),
        getSessionProfile: async (id: string) => controller.getSessionProfile(id),
        selectSessionProfile: async (request: Parameters<typeof controller.selectSessionProfile>[0]) =>
          controller.selectSessionProfile(request),
        catalog: async (id: string) => controller.catalog(id),
        previewRequest: async (id: string) => controller.previewRequest(id),
      },
    } as unknown as PromptControlSettingsProps
    render(<PromptControlSettings {...props} />)

    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'Browser profile' } })
    fireEvent.click(screen.getByRole('button', { name: en.addAppend }))
    fireEvent.change(screen.getAllByRole('textbox').at(-1)!, { target: { value: 'Apply browser policy.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText('Browser profile')

    fireEvent.click(screen.getByRole('button', { name: en.select }))
    await screen.findByText(en.selected)
    fireEvent.click(screen.getByRole('button', { name: en.preview }))
    await screen.findByText(/Apply browser policy/)

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Send it' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.lastOptions?.messages.some(message => message.source.kind === 'prompt-control')).toBe(true)
  })
})

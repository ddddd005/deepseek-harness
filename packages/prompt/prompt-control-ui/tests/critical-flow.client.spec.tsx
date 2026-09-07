// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import PromptControl from '@deepseek-ai/dsh-prompt-control'
import type {
  PromptControlCatalogView, PromptControlPreviewView, PromptControlSessionView,
  PromptProfile, PromptProfileCreate, PromptProfileId, PromptProfileSummary, PromptProfileUpdate,
} from '@deepseek-ai/dsh-prompt-control/types'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyRemote, inject as remoteInject } from '@deepseek-ai/dsh-api-gateway/client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyPromptControlUi, inject as promptControlUiInject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) void ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

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

const storageDomain = (ctx: Context): void => {
  const tables = new Map<string, Map<unknown, unknown>>()
  ctx.provide('storageDomain', {
    open: async () => ({
      table: (name: string) => {
        const records = tables.get(name) ?? new Map<unknown, unknown>()
        tables.set(name, records)
        return {
          get: (key: unknown) => records.get(key),
          get size() { return records.size },
          entries: () => records.entries(),
          put: async (key: unknown, value: unknown) => { records.set(key, value) },
          delete: async (key: unknown) => { records.delete(key) },
        }
      },
      close: () => {},
    }),
  } as never)
}

const typert = (ctx: Context): void => {
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
}

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-control-web-overlay-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- id: storage-domain\n  name: '@test/prompt-control-storage-domain'",
    "- id: typert\n  name: '@test/prompt-control-typert'",
    "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'",
    "- id: llm\n  name: '@deepseek-ai/dsh-llm'",
    "- id: session\n  name: '@deepseek-ai/dsh-session'",
    "- id: session-projection\n  name: '@deepseek-ai/dsh-session-projection'",
    "- id: tools\n  name: '@deepseek-ai/dsh-tools'",
    "- id: agent\n  name: '@deepseek-ai/dsh-agent'",
    "- id: agent-loop\n  name: '@deepseek-ai/dsh-agent-loop'\n  config:\n    agents: []",
    '',
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const overlayPath = join(process.cwd(), 'packages/prompt/prompt-control-web-profile/cordis.patch.yml')
  const patches = yaml.load(await readFile(overlayPath, 'utf8'), { schema: entryListSchema }) as PatchOptions[]
  const modules = new Map<string, unknown>([
    ['@test/prompt-control-storage-domain', storageDomain],
    ['@test/prompt-control-typert', typert],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-prompt-control', PromptControl],
    ['@deepseek-ai/dsh-prompt-control-ui', await import('../src/index.ts')],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches },
  })
  await ctx.loader.await()
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

function declareSettingsSlot(slots: SlotRegistry): () => void {
  return slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
}

type RemoteInvocation = () => Promise<unknown>

interface HostController {
  listProfiles(): readonly PromptProfileSummary[]
  getProfile(id: PromptProfileId): PromptProfile | undefined
  createProfile(input: PromptProfileCreate): Promise<PromptProfile>
  updateProfile(request: {
    readonly id: PromptProfileId
    readonly expectedRevision: number
    readonly patch: PromptProfileUpdate
  }): Promise<PromptProfile>
  deleteProfile(request: { readonly id: PromptProfileId; readonly expectedRevision: number }): Promise<{ readonly deleted: true }>
  getSessionProfile(sessionId: string): PromptControlSessionView
  selectSessionProfile(request: { readonly sessionId: string; readonly profileId?: PromptProfileId }): Promise<PromptControlSessionView>
  catalog(sessionId: string): PromptControlCatalogView
  previewRequest(sessionId: string): Promise<PromptControlPreviewView>
}

function controllerOf(ctx: Context): HostController {
  const controller = ctx.get('promptControlController')
  if (controller === undefined) throw new Error('Prompt Control Host Controller is not mounted')
  return controller
}

async function bootClient(
  host: Context,
  current: string,
  intercept?: (endpoint: string, payload: { readonly args: Record<string, unknown> }, invoke: RemoteInvocation) => Promise<unknown>,
): Promise<{ ctx: Context; slots: SlotRegistry; sessions: SnapshotStore<{ readonly current: string }> }> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const controller = controllerOf(host)
  ctx.provide('connection', {
    rpc: {
      call: async (_channel: string, endpoint: string, payload: { readonly args: Record<string, unknown> }) => {
        const args = payload.args
        const invoke = async (): Promise<unknown> => {
          switch (endpoint) {
            case 'promptControl/listProfiles': return controller.listProfiles()
            case 'promptControl/getProfile': return controller.getProfile(args.id as PromptProfileId)
            case 'promptControl/createProfile': return controller.createProfile(args.input as PromptProfileCreate)
            case 'promptControl/updateProfile': return controller.updateProfile(args.request as Parameters<HostController['updateProfile']>[0])
            case 'promptControl/deleteProfile': return controller.deleteProfile(args.request as Parameters<HostController['deleteProfile']>[0])
            case 'promptControl/getSessionProfile': return controller.getSessionProfile(args.sessionId as string)
            case 'promptControl/selectSessionProfile': return controller.selectSessionProfile(args.request as Parameters<HostController['selectSessionProfile']>[0])
            case 'promptControl/catalog': return controller.catalog(args.sessionId as string)
            case 'promptControl/previewRequest': return controller.previewRequest(args.sessionId as string)
            default: throw new Error(`unexpected Prompt Control Remote endpoint: ${endpoint}`)
          }
        }
        return { ok: true as const, value: await (intercept?.(endpoint, payload, invoke) ?? invoke()) }
      },
    },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  } as never)
  await ctx.plugin({ inject: [...remoteInject], apply: applyRemote })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const sessions = createSnapshotStore({ current })
  ctx.provide('sessions', { list: sessions } as never)
  const slots = ctx.get('slots') as SlotRegistry
  declareSettingsSlot(slots)
  await ctx.plugin({ inject: [...promptControlUiInject], apply: applyPromptControlUi }).await()
  expect(ctx.get('remote.promptControl')).toBeDefined()
  return { ctx, slots, sessions }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Prompt Control browser critical flow', () => {
  it('creates and selects a Profile, previews it, then sends a finalized request', async () => {
    const { ctx, adapter } = await boot()
    const sessionId = SessionId('browser-critical-flow')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Committed history' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const { slots } = await bootClient(ctx, sessionId)
    const section = slots.entries('settings.section')[0]!
    render(createElement(section.component as never, (section.inject as () => object)()))

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

  it('ignores a previous session selection and Preview after switching conversations', async () => {
    const { ctx } = await boot()
    const firstSession = SessionId('browser-session-first')
    const secondSession = SessionId('browser-session-second')
    await ctx.agentLoop.create(firstSession, { provider: 'mock', model: 'mock' })
    await ctx.agentLoop.create(secondSession, { provider: 'mock', model: 'mock' })
    const controller = controllerOf(ctx)
    const profile = await controller.createProfile({ name: 'Race profile' })
    const selection = deferred<unknown>()
    const preview = deferred<unknown>()
    const { slots, sessions } = await bootClient(ctx, firstSession, async (endpoint, payload, invoke) => {
      if (payload.args.sessionId === firstSession && endpoint === 'promptControl/selectSessionProfile') return selection.promise
      if (payload.args.sessionId === firstSession && endpoint === 'promptControl/previewRequest') return preview.promise
      return invoke()
    })
    const section = slots.entries('settings.section')[0]!
    render(createElement(section.component as never, (section.inject as () => object)()))

    await screen.findByText('Race profile')
    fireEvent.click(screen.getByRole('button', { name: 'Race profile' }))
    await screen.findByDisplayValue('Race profile')
    fireEvent.click(screen.getByRole('button', { name: en.select }))
    fireEvent.click(screen.getByRole('button', { name: en.preview }))
    sessions.set({ current: secondSession })
    await waitFor(() => { expect(screen.getByText(secondSession)).toBeDefined() })

    selection.resolve(await controller.selectSessionProfile({ sessionId: firstSession, profileId: profile.id }))
    preview.reject(new Error('stale preview'))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByText(en.selected)).toBeNull()
    expect(screen.queryByText(/stale preview/)).toBeNull()
    expect(screen.queryByText(en.previewFailed)).toBeNull()
  })
})

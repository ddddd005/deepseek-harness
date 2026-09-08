/** The private Web overlay composes both Prompt Control faces through the real Loader. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import PromptControl from '../../prompt-control/src/index.ts'
import * as yaml from 'js-yaml'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const baseRuntime = (ctx: Context): void => {
  const records = new Map<string, unknown>()
  const table = {
    get: (key: string) => records.get(key),
    get size() { return records.size },
    entries: () => records.entries(),
    put: async (key: string, value: unknown) => { records.set(key, value) },
    delete: async (key: string) => { records.delete(key) },
  }
  ctx.provide('systemPrompt', {} as never)
  ctx.provide('storageDomain', {
    open: async () => ({ table: () => table, close: () => {} }),
  } as never)
  ctx.provide('llm', {} as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('agentLoop', {} as never)
  ctx.provide('agents', {} as never)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
}

describe('Prompt Control Web profile overlay', () => {
  it('resolves its declared packages and mounts both overlay rows through Loader', async () => {
    const packageRoot = join(process.cwd(), 'packages/prompt/prompt-control-web-profile')
    const require = createRequire(join(packageRoot, 'package.json'))
    expect(require.resolve('@deepseek-ai/dsh-prompt-control/package.json')).toBeTruthy()
    expect(require.resolve('@deepseek-ai/dsh-prompt-control-ui/package.json')).toBeTruthy()

    root = await mkdtemp(join(tmpdir(), 'dsh-prompt-control-profile-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, "- id: web-runtime\n  name: '@test/prompt-control-web-runtime'\n")
    const patchPath = join(packageRoot, 'cordis.patch.yml')
    const patches = yaml.load(await readFile(patchPath, 'utf8'), { schema: entryListSchema }) as PatchOptions[]

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    let uiMarkerApplied = false
    const promptControlUiMarker = {
      apply() {
        uiMarkerApplied = true
      },
    }
    const modules = new Map<string, unknown>([
      ['@test/prompt-control-web-runtime', baseRuntime],
      ['@deepseek-ai/dsh-prompt-control', PromptControl],
      ['@deepseek-ai/dsh-prompt-control-ui', promptControlUiMarker],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href, patches },
    })
    await context.loader.await()

    expect(context.get('promptControl')).toBeInstanceOf(PromptControl)
    expect(context.get('promptControlController')).toBeDefined()
    expect(uiMarkerApplied).toBe(true)
    expect([...context.loader.entries()].map(entry => entry.options.id)).toEqual(expect.arrayContaining([
      'web-runtime', 'prompt-control', 'ui-prompt-control',
    ]))
  })
})

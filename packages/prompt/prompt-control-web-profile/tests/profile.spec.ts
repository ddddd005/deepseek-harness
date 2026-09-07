/** The private Web overlay resolves both Prompt Control faces without changing shared Web composition. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('Prompt Control Web profile overlay', () => {
  it('declares private Host and Client dependencies and inserts both plugins', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBe(true)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-prompt-control': 'workspace:^',
      '@deepseek-ai/dsh-prompt-control-ui': 'workspace:^',
    })
    const patch = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'), {
      schema: entryListSchema,
    }) as { insert?: { id?: string; name?: string }[] }[]
    expect(patch.flatMap(entry => entry.insert ?? [])).toEqual([
      { id: 'prompt-control', name: '@deepseek-ai/dsh-prompt-control' },
      { id: 'ui-prompt-control', name: '@deepseek-ai/dsh-prompt-control-ui' },
    ])
  })
})

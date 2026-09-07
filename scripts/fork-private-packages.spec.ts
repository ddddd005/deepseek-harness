/** Fork-private package policy parsing and discovery. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  forkPrivatePackageDirs,
  isForkPrivatePolicyPath,
  parseForkPrivatePackages,
} from './fork-private-packages.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fork-private-packages-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'packages/prompt/first'), { recursive: true })
  mkdirSync(join(root, 'packages/prompt/second'), { recursive: true })
  mkdirSync(join(root, 'packages/core/official'), { recursive: true })
  writeFileSync(join(root, 'scripts/fork-private-packages.json'), '{"directoryPrefixes":["packages/prompt/"]}\n')
  for (const path of [
    'packages/prompt/first/package.json',
    'packages/prompt/second/package.json',
    'packages/core/official/package.json',
  ]) writeFileSync(join(root, path), '{}\n')
  return root
}

describe('fork-private package policy', () => {
  it('recognizes every package below a configured root without admitting sibling paths', () => {
    const policy = parseForkPrivatePackages('{"directoryPrefixes":["packages/prompt/"]}', 'fixture')

    expect(isForkPrivatePolicyPath(policy, 'packages/prompt/new-package/src/index.ts')).toBe(true)
    expect(isForkPrivatePolicyPath(policy, 'packages/prompt-control/src/index.ts')).toBe(false)
  })

  it('discovers every current package below each configured root', () => {
    expect(forkPrivatePackageDirs(fixture())).toEqual(new Set([
      'packages/prompt/first',
      'packages/prompt/second',
    ]))
  })

  it.each([
    '{}',
    '{"directoryPrefixes":[]}',
    '{"directoryPrefixes":["packages/prompt"]}',
    '{"directoryPrefixes":["packages/prompt/","packages/prompt/"]}',
  ])('rejects an invalid policy: %s', (source) => {
    expect(() => parseForkPrivatePackages(source, 'fixture')).toThrow(/directoryPrefixes|repeat/)
  })
})

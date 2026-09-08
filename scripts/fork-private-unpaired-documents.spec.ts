/**
 * Fork-local unpaired-document exemption: parsing rules plus the real pairing
 * gate against a fixture repository. The gate reads `import.meta.dirname` as
 * its root, so each fixture copies the verifier's import closure into a temp
 * root instead of adding a test-only root override.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isUnpairedDocument, parseForkPrivatePackages } from './fork-private-packages.ts'

const root = resolve(import.meta.dirname, '..')
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs')

/** The verifier's full local import closure, copied into every fixture root. */
const VERIFIER_CLOSURE = [
  'verify-translation-pairing',
  'fork-private-packages',
  'translation-pairing-git',
  'translation-pairing-record',
  'translation-pairing',
  'translation-links',
  'markdown',
] as const

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function blobHash(content: string): string {
  return spawnSync('git', ['hash-object', '--stdin'], { input: content, encoding: 'utf8' }).stdout.trim()
}

interface Fixture {
  root: string
  writePolicy: (unpairedDocuments: readonly string[]) => void
  writePair: (stem: string, english: string, chinese: string, record?: 'valid' | 'stale') => void
  run: (...args: string[]) => { status: number | null; output: string }
}

function fixture(): Fixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-unpaired-documents-'))
  fixtures.push(fixtureRoot)
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true })
  mkdirSync(join(fixtureRoot, 'docs'), { recursive: true })
  for (const name of VERIFIER_CLOSURE) {
    copyFileSync(join(root, 'scripts', `${name}.ts`), join(fixtureRoot, 'scripts', `${name}.ts`))
  }
  writeFileSync(join(fixtureRoot, 'scripts/translation-pairing.manifest.json'), '{"excluded":[]}\n')
  // The verifier imports the fixture's own closure, whose dependencies resolve
  // through the repository install; a junction avoids copying node_modules.
  symlinkSync(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'junction')
  // --cached reads the index plane, so the fixture is a real repository.
  spawnSync('git', ['init', '--quiet'], { cwd: fixtureRoot, encoding: 'utf8' })
  const writePolicy = (unpairedDocuments: readonly string[]): void => {
    writeFileSync(join(fixtureRoot, 'scripts/fork-private-packages.json'), `${JSON.stringify({
      directoryPrefixes: ['packages/prompt/'],
      unpairedDocuments,
    })}\n`)
  }
  writePolicy([])
  const writePair: Fixture['writePair'] = (stem, english, chinese, record = 'valid') => {
    writeFileSync(join(fixtureRoot, `docs/${stem}.md`), english)
    writeFileSync(join(fixtureRoot, `docs/${stem}.zh.md`), chinese)
    writeFileSync(join(fixtureRoot, `docs/${stem}.i18n.yaml`), [
      `${stem}.md: ${record === 'valid' ? blobHash(english) : '0'.repeat(40)}`,
      `${stem}.zh.md: ${record === 'valid' ? blobHash(chinese) : '1'.repeat(40)}`,
      '',
    ].join('\n'))
  }
  return {
    root: fixtureRoot,
    writePolicy,
    writePair,
    run: (...args) => {
      const result = spawnSync(process.execPath, [tsxCli, 'scripts/verify-translation-pairing.ts', ...args], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      })
      return { status: result.status, output: `${result.stdout}${result.stderr}` }
    },
  }
}

/** English source whose structure intentionally diverges from its Chinese side. */
const DIVERGENT_ENGLISH = '# Title\n\nBody.\n\n## One\n\nx\n'
const DIVERGENT_CHINESE = '# 标题\n\n正文。\n\n## One\n\nx\n\n## Two\n\ny\n'

describe('unpairedDocuments policy parsing', () => {
  it('defaults to an empty list when the field is absent', () => {
    const policy = parseForkPrivatePackages('{"directoryPrefixes":["packages/prompt/"]}', 'fixture')

    expect(policy.unpairedDocuments).toEqual([])
    expect(isUnpairedDocument(policy, 'docs/config-catalog.md')).toBe(false)
  })

  it('accepts exact English docs/*.md paths only, with no duplicates', () => {
    const policy = parseForkPrivatePackages(
      '{"directoryPrefixes":["packages/prompt/"],"unpairedDocuments":["docs/config-catalog.md"]}',
      'fixture',
    )

    expect(policy.unpairedDocuments).toEqual(['docs/config-catalog.md'])
    expect(isUnpairedDocument(policy, 'docs/config-catalog.md')).toBe(true)
    expect(isUnpairedDocument(policy, 'docs/config-catalog.zh.md')).toBe(false)
    expect(isUnpairedDocument(policy, 'docs/event-producer-consumer.md')).toBe(false)
  })

  it.each([
    'docs/',
    'docs/*.md',
    'docs/**/*.md',
    'docs/config-catalog.zh.md',
    'docs/config-catalog.i18n.yaml',
    'README.md',
    'packages/prompt/README.md',
    // Exact means one filename directly under docs/: nested paths, traversal,
    // and platform separators are not exact document identities.
    'docs/nested/deeper.md',
    'docs/../docs/config-catalog.md',
    'docs\\.\\config-catalog.md',
    'docs/.md',
    // Every glob metacharacter is rejected, not just `*`.
    'docs/?adoc.md',
    'docs/[ab].md',
    'docs/a].md',
    'docs/{a,b}.md',
    'docs/a{b.md',
    'docs/!a.md',
    'docs/+a.md',
    'docs/@a.md',
    'docs/a*.md',
    // Spaces and leading punctuation are not part of any real document name.
    'docs/a b.md',
    'docs/-a.md',
    'docs/.hidden.md',
    'docs/a..md',
    'docs/a.md.bak',
  ])('rejects a non-source, non-exact, or glob entry: %s', (entry) => {
    expect(() => parseForkPrivatePackages(
      `{"directoryPrefixes":["packages/prompt/"],"unpairedDocuments":[${JSON.stringify(entry)}]}`,
      'fixture',
    )).toThrow(/unpairedDocuments/)
  })

  it('accepts only the conservative document-name character set', () => {
    const policy = parseForkPrivatePackages(
      '{"directoryPrefixes":["packages/prompt/"],"unpairedDocuments":["docs/0001-postmortem.md","docs/a_b-c.d.md"]}',
      'fixture',
    )

    expect(policy.unpairedDocuments).toEqual(['docs/0001-postmortem.md', 'docs/a_b-c.d.md'])
  })

  it('rejects a repeated unpaired document', () => {
    expect(() => parseForkPrivatePackages(
      '{"directoryPrefixes":["packages/prompt/"],"unpairedDocuments":["docs/a.md","docs/a.md"]}',
      'fixture',
    )).toThrow(/repeat an unpaired document/)
  })

  it('marks a listed document skipped, never missing, under --list', () => {
    const f = fixture()
    f.writePolicy(['docs/unpaired.md'])
    f.writePair('unpaired', DIVERGENT_ENGLISH, DIVERGENT_CHINESE, 'stale')

    const { status, output } = f.run('--list')

    expect(status).toBe(0)
    expect(output).toContain('unpaired skipped docs/unpaired.md')
    expect(output).not.toMatch(/missing\s+docs\/unpaired\.md/)
  })
})

describe('unpaired document pairing gate', () => {
  it('passes a structurally divergent listed document and keeps its pair on disk', () => {
    const f = fixture()
    f.writePolicy(['docs/unpaired.md'])
    f.writePair('unpaired', DIVERGENT_ENGLISH, DIVERGENT_CHINESE, 'stale')

    const { status, output } = f.run()

    expect(output).toContain('unpaired skipped docs/unpaired.md')
    expect(output).toContain('1 unpaired skipped (not counted as checked)')
    expect(output).toContain('0 pair(s) checked')
    expect(status).toBe(0)
  })

  it('skips the listed document under --cached and rewrites no sidecar under --write --all', () => {
    const f = fixture()
    f.writePolicy(['docs/unpaired.md'])
    f.writePair('unpaired', DIVERGENT_ENGLISH, DIVERGENT_CHINESE, 'stale')
    // Scope the add to the fixture's own trees: `-A` would walk the
    // node_modules junction and is neither needed nor fast.
    spawnSync('git', ['add', 'scripts', 'docs'], { cwd: f.root, encoding: 'utf8' })

    const write = f.run('--write', '--all')
    expect(write.output).toContain('0 record(s) written')
    expect(write.status).toBe(0)
    expect(f.run('--cached', 'docs/unpaired.md').status).toBe(0)
  })

  it('still fails a structurally divergent document that is not listed', () => {
    const f = fixture()
    f.writePolicy([])
    f.writePair('divergent', DIVERGENT_ENGLISH, DIVERGENT_CHINESE)

    const { status, output } = f.run()

    expect(status).toBe(1)
    expect(output).toContain('diverges between the pair')
    expect(output).not.toContain('unpaired skipped')
  })

  it('keeps the original behavior when unpairedDocuments is absent', () => {
    const f = fixture()
    writeFileSync(
      join(f.root, 'scripts/fork-private-packages.json'),
      '{"directoryPrefixes":["packages/prompt/"]}\n',
    )
    f.writePair('divergent', DIVERGENT_ENGLISH, DIVERGENT_CHINESE)

    const { status, output } = f.run()

    expect(status).toBe(1)
    expect(output).toContain('diverges between the pair')
  })
})

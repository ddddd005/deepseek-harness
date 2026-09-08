/**
 * Fork-local private-package policy.
 *
 * `scripts/fork-private-packages.json` lists this fork's private capability
 * directory roots. Leaf documentation gates exempt packages beneath those roots (bilingual README
 * pairing, companion-omission README sentences, subsystem/catalog page
 * mapping, and the Model Experience README rule); TypeScript, lint, tests,
 * dependency graphs, and runtime service checks still apply in full. See the
 * fork-local policy section in the root `AGENTS.md`.
 *
 * @module scripts/fork-private-packages
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolve } from 'node:path'

/** Repository-relative directory prefixes containing fork-private packages. */
export interface ForkPrivatePackages {
  readonly directoryPrefixes: readonly string[]
  /**
   * Exact English Markdown documents exempt from bilingual pairing. These are
   * generated per fork, so their content cannot mirror an upstream translation;
   * the counterpart and sidecar may still exist and every other document keeps
   * the full pairing gate.
   */
  readonly unpairedDocuments: readonly string[]
}

/**
 * One exact English document directly under `docs/`; captures its stem.
 * The stem is a positive whitelist of the characters real top-level document
 * names use, which rejects every glob metacharacter (`*`, `?`, `[`, `]`, `{`,
 * `}`, `!`, `+`, `@`) along with spaces, separators, and traversal.
 */
const UNPAIRED_DOCUMENT = /^docs\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/

/**
 * Validate the `unpairedDocuments` list: exact English Markdown sources under
 * `docs/`, no duplicates, and no `.zh.md`/`.i18n.yaml`/directory/glob entries.
 * @param value - Raw JSON value, or undefined when the field is absent.
 * @param context - path or other diagnostic label for the source.
 * @returns The validated document list (empty when the field is absent).
 */
function unpairedDocumentsField(value: unknown, context: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${context} "unpairedDocuments" must be an array of exact docs/*.md paths`)
  }
  const entries = value as readonly string[]
  for (const entry of entries) {
    // The whitelist already rejects nested paths, globs, and separators; the
    // stem check additionally rejects paired artifacts and trailing dots.
    const stem = UNPAIRED_DOCUMENT.exec(entry)?.[1]
    if (stem === undefined || stem.endsWith('.zh') || stem.endsWith('.')) {
      throw new Error(`${context} "unpairedDocuments" accepts only exact English docs/*.md paths, received ${JSON.stringify(entry)}`)
    }
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${context} must not repeat an unpaired document`)
  }
  return entries
}

/**
 * Parse the fork-private package policy.
 * @param source - JSON policy source.
 * @param context - path or other diagnostic label for the source.
 * @returns The validated directory-prefix policy.
 */
export function parseForkPrivatePackages(source: string, context: string): ForkPrivatePackages {
  const raw: unknown = JSON.parse(source)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${context} must contain a JSON object`)
  }
  const directoryPrefixes = (raw as { directoryPrefixes?: unknown }).directoryPrefixes
  if (!Array.isArray(directoryPrefixes)
    || directoryPrefixes.length === 0
    || directoryPrefixes.some(prefix => typeof prefix !== 'string' || !/^packages\/[^/]+\/$/.test(prefix))) {
    throw new Error(`${context} must carry a non-empty "directoryPrefixes" array of packages/<group>/ paths`)
  }
  if (new Set(directoryPrefixes).size !== directoryPrefixes.length) {
    throw new Error(`${context} must not repeat a directory prefix`)
  }
  return {
    directoryPrefixes: directoryPrefixes as readonly string[],
    unpairedDocuments: unpairedDocumentsField((raw as { unpairedDocuments?: unknown }).unpairedDocuments, context),
  }
}

/**
 * Read and validate the private-package manifest at the given repository root.
 * @param root - repository root containing the policy file.
 * @returns The validated directory-prefix policy.
 */
export function loadForkPrivatePackages(root: string): ForkPrivatePackages {
  const path = resolve(root, 'scripts/fork-private-packages.json')
  return parseForkPrivatePackages(readFileSync(path, 'utf8'), 'scripts/fork-private-packages.json')
}

/**
 * Test whether a repository-relative file or directory belongs to a private package policy.
 * @param policy - validated fork-private package policy.
 * @param repositoryPath - repository-relative file or directory.
 * @returns True when the path is under one policy directory prefix.
 */
export function isForkPrivatePolicyPath(policy: ForkPrivatePackages, repositoryPath: string): boolean {
  const normalized = repositoryPath.split('\\').join('/')
  return policy.directoryPrefixes.some(prefix => normalized.startsWith(prefix))
}

/**
 * Test whether a repository-relative file or directory belongs to a private package.
 * @param root - repository root containing the policy file.
 * @param repositoryPath - repository-relative file or directory.
 * @returns True when the path is under one configured directory prefix.
 */
export function isForkPrivatePath(root: string, repositoryPath: string): boolean {
  return isForkPrivatePolicyPath(loadForkPrivatePackages(root), repositoryPath)
}

/**
 * Test whether an English document is exempt from bilingual pairing. Kept
 * separate from {@link isForkPrivatePolicyPath}: a private package path is
 * fully excluded from the pairing corpus, while an unpaired document keeps its
 * counterpart and sidecar on disk and is skipped only by the pairing gate.
 * @param policy - validated fork-private package policy.
 * @param repositoryPath - repository-relative path.
 * @returns True when the path is exactly one configured unpaired document.
 */
export function isUnpairedDocument(policy: ForkPrivatePackages, repositoryPath: string): boolean {
  const normalized = repositoryPath.split('\\').join('/')
  return policy.unpairedDocuments.includes(normalized)
}

/**
 * Discover every private package directory beneath the configured roots.
 * @param root - repository root.
 * @returns private package directories (slash-separated, no trailing slash).
 */
export function forkPrivatePackageDirs(root: string): ReadonlySet<string> {
  const policy = loadForkPrivatePackages(root)
  return new Set(globSync('packages/*/*/package.json', { cwd: root })
    .map(path => path.split('\\').join('/'))
    .filter(path => isForkPrivatePolicyPath(policy, path))
    .map(path => dirname(path).split('\\').join('/')))
}

/**
 * Return configured private source prefixes for source walkers.
 * @param root - repository root containing the policy file.
 * @returns directory prefixes in repository slash form.
 */
export function forkPrivateSourcePrefixes(root: string): readonly string[] {
  return loadForkPrivatePackages(root).directoryPrefixes
}

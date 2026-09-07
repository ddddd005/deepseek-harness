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
  return { directoryPrefixes: directoryPrefixes as readonly string[] }
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

/**
 * Fork-local private-package policy.
 *
 * `scripts/fork-private-packages.json` lists this fork's private capability
 * packages. Leaf documentation gates exempt those paths (bilingual README
 * pairing, companion-omission README sentences, subsystem/catalog page
 * mapping, and the Model Experience README rule); TypeScript, lint, tests,
 * dependency graphs, and runtime service checks still apply in full. See the
 * fork-local policy section in the root `AGENTS.md`.
 *
 * @module scripts/fork-private-packages
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The repository-relative directories of the fork's private packages. */
export interface ForkPrivatePackages {
  readonly packages: readonly string[]
}

/** Read and validate the private-package manifest at the given repository root. */
export function loadForkPrivatePackages(root: string): ForkPrivatePackages {
  const raw = JSON.parse(readFileSync(resolve(root, 'scripts/fork-private-packages.json'), 'utf8')) as {
    packages?: unknown
  }
  const packages = raw.packages
  if (!Array.isArray(packages) || packages.some(entry => typeof entry !== 'string')) {
    throw new Error('fork-private-packages.json must carry a "packages" array of repository-relative directory paths')
  }
  return { packages: packages as readonly string[] }
}

/** Test whether a repository-relative file or directory belongs to a private package. */
export function isForkPrivatePath(root: string, repositoryPath: string): boolean {
  const normalized = repositoryPath.split('\\').join('/')
  return loadForkPrivatePackages(root)
    .packages
    .some(packageDir => normalized === packageDir || normalized.startsWith(`${packageDir}/`))
}

/**
 * The normalized directory set of the private packages, for gates that glob
 * package manifests and must skip private members wholesale.
 * @param root - repository root.
 * @returns the private package directories (slash-separated, no trailing slash).
 */
export function forkPrivatePackageDirs(root: string): ReadonlySet<string> {
  return new Set(loadForkPrivatePackages(root).packages.map(dir => dir.split('\\').join('/')))
}

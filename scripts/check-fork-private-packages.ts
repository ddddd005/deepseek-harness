/** Run the focused quality checks for every fork-private package. */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  collectPackageInvariantViolations,
  formatPackageInvariantViolation,
} from './package-invariants.ts'
import { forkPrivatePackageDirs, isForkPrivatePath } from './fork-private-packages.ts'

const root = resolve(import.meta.dirname, '..')
const packageDirs = [...forkPrivatePackageDirs(root)].sort()

if (packageDirs.length === 0) {
  throw new Error('check-fork-private-packages: the private package policy selects no current packages')
}

function run(args: string[]): void {
  execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' })
}

run(['exec', 'tsc', '-b', ...packageDirs])
run(['exec', 'oxlint', ...packageDirs])
run(['exec', 'vitest', 'run', ...packageDirs])

const violations = collectPackageInvariantViolations(root)
  .filter(violation => isForkPrivatePath(root, violation.path))
if (violations.length > 0) {
  console.error('check-fork-private-packages: package invariant violations found:')
  for (const violation of violations) {
    console.error(`  ${formatPackageInvariantViolation(root, violation)}`)
  }
  process.exitCode = 1
} else {
  console.log(`check-fork-private-packages: ${String(packageDirs.length)} private package(s) passed focused checks.`)
}

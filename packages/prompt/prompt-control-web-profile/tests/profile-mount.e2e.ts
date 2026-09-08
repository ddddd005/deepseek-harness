/**
 * Real Profile mount smoke: a fresh Harness home installs the private
 * Prompt Control bundle through the public `dsh plugin` forwarder, boots the
 * real `dsh web` process, and proves both faces are live — the Host Remote
 * namespace answers over the authenticated `/api` route, and the browser boot
 * manifest carries the client entry.
 *
 * This replaces the Loader `internal.import` fixture: no injected module map
 * and no install anchors, only the resolution a user actually gets. The private
 * workspace package is delivered through `link:`, so no registry access is
 * involved. Skips when the required `lib/` artifacts are absent; run
 * `pnpm build:lib` first (the pre-push hook builds them).
 */

import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const DSH_SOURCE_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TSX_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
const WEB_PROFILE_PACKAGE = join(REPO_ROOT, 'packages/prompt/prompt-control-web-profile')
const BUNDLE_NAME = '@deepseek-ai/dsh-prompt-control-web-profile'

/** Built artifacts the source CLI resolves through the installed link. */
const requiredArtifacts = [
  'packages/prompt/prompt-control/lib/index.js',
  'packages/prompt/prompt-control-ui/lib/index.js',
  'packages/prompt/prompt-control-ui/lib/client.js',
  'packages/prompt/prompt-control-web-profile/lib/index.js',
].every(path => existsSync(join(REPO_ROOT, path)))

interface RunningWeb {
  readonly child: ChildProcess
  readonly launchUrl: string
  readonly output: () => string
}

function redact(output: string): string {
  return output.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
}

/** Reserve one concrete loopback port, then release it for the CLI process. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

function cleanEnvironment(root: string, dshHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  return {
    ...env,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    SSH_CONNECTION: '',
    SSH_TTY: '',
    TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
  }
}

/** Run the public plugin forwarder so the profile is created and reconciled. */
function installBundle(root: string, dshHome: string): void {
  const result = spawnSync(process.execPath, [
    '--import', TSX_LOADER,
    DSH_SOURCE_BIN,
    'plugin',
    '--profile', 'web',
    'add', `link:${WEB_PROFILE_PACKAGE}`,
  ], {
    cwd: root,
    env: cleanEnvironment(root, dshHome),
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    // spawnSync reports the timeout as ETIMEDOUT after killing the child.
    if (code === 'ETIMEDOUT') {
      throw new Error(`dsh plugin add timed out after 120s:\n${result.stdout}\n${result.stderr}`)
    }
    throw new Error(`dsh plugin add failed to start (${code ?? 'unknown'}): ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`dsh plugin add exited ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
  }
}

/** Start the real source CLI and wait for its authenticated readiness URL. */
async function startWeb(root: string, dshHome: string, port: number): Promise<RunningWeb> {
  const child = spawn(process.execPath, [
    '--import', TSX_LOADER,
    DSH_SOURCE_BIN,
    'web',
    '--no-open',
    '--port', String(port),
  ], {
    cwd: root,
    env: cleanEnvironment(root, dshHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const launchUrl = await new Promise<string>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`dsh web did not become ready:\n${redact(output)}`))
    }, 90_000)
    const append = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-100_000)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (settled || match?.[1] === undefined) return
      settled = true
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      fail(error)
    })
    child.once('exit', (code) => {
      fail(new Error(`dsh web exited before readiness (${String(code)}):\n${redact(output)}`))
    })
  })
  return { child, launchUrl, output: () => output }
}

async function stopWeb(running: RunningWeb): Promise<void> {
  if (running.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => { running.child.once('exit', () => { resolve() }) })
  running.child.kill('SIGTERM')
  const forced = setTimeout(() => { running.child.kill('SIGKILL') }, 10_000)
  forced.unref()
  await exited
  clearTimeout(forced)
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

/** POST one Remote envelope to the generated Host route. */
function listProfiles(port: number, host: string, cookie: string): Promise<HttpResult> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'prompt-control-profile-mount',
    method: 'promptControl/listProfiles',
    payload: { args: {} },
  })
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/promptControl/listProfiles',
      method: 'POST',
      headers: {
        host,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        cookie,
      },
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

let running: RunningWeb | undefined
let root: string | undefined

afterEach(async () => {
  if (running !== undefined) await stopWeb(running)
  running = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe.skipIf(!requiredArtifacts)('Prompt Control real Profile mount', () => {
  it('installs, mounts, and serves both faces from a fresh Harness home', { timeout: 180_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prompt-control-profile-mount-'))
    const dshHome = join(root, '.dsh')
    const profileDir = join(dshHome, 'profiles', 'web')
    const port = await freePort()

    // The public forwarder initializes the profile and reconciles the layer list.
    installBundle(root, dshHome)

    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.dependencies?.[BUNDLE_NAME]).toMatch(/^link:/u)
    expect(manifest.dsh?.profile?.bundles).toContain(BUNDLE_NAME)
    expect(existsSync(join(profileDir, 'node_modules', BUNDLE_NAME))).toBe(true)

    running = await startWeb(root, dshHome, port)
    const url = new URL(running.launchUrl)
    expect(url.origin).toBe(`http://127.0.0.1:${String(port)}`)

    // Exchange the launch token for the browser cookie the real client uses.
    const exchange = await fetch(running.launchUrl, { redirect: 'manual' })
    expect(exchange.status).toBe(303)
    const setCookie = exchange.headers.get('set-cookie')
    if (setCookie === null) throw new Error('real CLI token exchange omitted Set-Cookie')
    const cookie = setCookie.split(';', 1)[0]!

    // Host face: the private Remote namespace answers over the authenticated route.
    const hostCall = await listProfiles(port, url.host, cookie)
    expect(hostCall.status).toBe(200)
    expect(JSON.parse(hostCall.body) as unknown).toMatchObject({
      type: 'server-response',
      rpcId: 'prompt-control-profile-mount',
      result: { ok: true, value: [] },
    })

    // Client face: the boot manifest ships the private browser entry.
    const page = await fetch(url.origin, { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('__DSH_BOOT__')
    expect(html).toContain('@deepseek-ai/dsh-prompt-control-ui/client.js')
  })
})

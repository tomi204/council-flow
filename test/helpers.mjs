// Shared test helpers: toy repos in the OS temp dir and an offline env with dry-run defaults.
import { envFor } from '../src/env.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = path.join(ROOT, 'bin', 'council-flow.mjs')
export const FAKE_KEY = 'lyb-FAKE-0123456789abcdefTESTKEY'
export const GH_URL = 'https://github.com/example/toy.git'

export const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...envFor('git'), GIT_ALLOW_PROTOCOL: 'file' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// Temp dirs made here are removed when the test process exits (COUNCIL_KEEP_TEST_DIRS=1 keeps them for debugging).
const made = []
export const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d }
process.on('exit', () => { if (!process.env.COUNCIL_KEEP_TEST_DIRS) for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })

// A repo with a passing test command once hello.txt exists ("npm test" -> node check.mjs).
export function toyRepo({ remote = false } = {}) {
  const dir = tmp('council-toy-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'toy@example.invalid')
  git(dir, 'config', 'user.name', 'Toy')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'README.md'), '# toy\nA toy repo for council-flow tests.\n')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'toy', private: true, scripts: { test: 'node check.mjs' } }, null, 2))
  fs.writeFileSync(path.join(dir, 'check.mjs'), "import fs from 'node:fs'\nconst t = fs.readFileSync('hello.txt', 'utf8')\nif (!t.startsWith('hello council')) { console.error('bad greeting'); process.exit(1) }\nconsole.log('greeting ok')\n")
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  let bare = null
  if (remote) {
    bare = tmp('council-remote-')
    git(bare, 'init', '-q', '--bare')
    // A GitHub-looking origin (so the PR repo resolves to github.com/example/toy) that git maps to the local bare repo.
    git(dir, 'config', `url.${bare}.insteadOf`, GH_URL)
    git(dir, 'remote', 'add', 'origin', GH_URL)
    git(dir, 'push', '-q', 'origin', 'main')
  }
  return { dir, bare, head: git(dir, 'rev-parse', 'HEAD') }
}

// Offline env for dry runs: no real CLIs are ever started, fast timeouts, no knobs left over from the shell.
export function testEnv(extra = {}) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('COUNCIL_') || k === 'ORCA_TERMINAL_HANDLE' || k === 'LYBER_API_KEY') delete env[k]
  return { ...env, COUNCIL_TIMEOUT_MS: '15000', COUNCIL_IMPL_TIMEOUT_MS: '15000', ...extra }
}

export const quiet = () => {}

export function runDir(repo, runId) { return path.join(repo, '.council-flow', runId) }
export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

// Every file under dir (relative paths).
export function walk(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '.git') out.push(...walk(p, base)) } else out.push(path.relative(base, p))
  }
  return out
}

export function cli(args, env, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: 120000, ...opts })
}

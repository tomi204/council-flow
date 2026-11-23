import path from 'node:path'
import { git } from '../repo.mjs'
import { scrubAudit } from '../redact.mjs'
import { inTarget } from './context.mjs'
import { repoFile } from './findings.mjs'

export class ScopeError extends Error {}

export function changedPaths(result, env) {
  if (result.stdoutTruncated || (result.stdout && !result.stdout.endsWith('\0'))) throw new Error('incomplete candidate path listing')
  const paths = result.stdout ? result.stdout.slice(0, -1).split('\0') : []
  if (paths.some(p => !repoFile(p) || p.includes('\uFFFD') || scrubAudit(p, env) !== p)) throw new Error('unsupported or credential-bearing candidate path')
  return paths
}

const diffOptions = ['--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none']

export async function changesBetween(store, from, tree) {
  return changedPaths(await git(['diff', ...diffOptions, '--name-only', '-z', from, tree, '--'], store.repoRoot), store.env)
}

export async function auditDiff(store, from, tree) {
  const r = await git(['diff', ...diffOptions, '--no-color', from, tree, '--'], store.repoRoot)
  if (r.stdoutTruncated) throw new Error('incomplete audit diff')
  return r.stdout
}

// The base commit establishes the test convention. A model cannot authorize a new
// external test directory by editing package.json in its own candidate.
export function auditScope(store) {
  const { target, testTarget, worktree } = store.state
  const manifests = new Map()
  async function packageFor(file) {
    let dir = path.posix.dirname(file)
    while (true) {
      if (!manifests.has(dir)) {
        const manifest = path.posix.join(dir, 'package.json')
        const entry = await git(['--literal-pathspecs', 'ls-tree', '-lz', worktree.baseCommit, '--', manifest], store.repoRoot)
        const regular = /^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t/.exec(entry.stdout)
        let pkg = null
        if (regular && Number(regular[2]) <= 1024 * 1024) {
          const r = await git(['cat-file', 'blob', regular[1]], store.repoRoot)
          try { pkg = JSON.parse(r.stdout) } catch { /* no trusted convention */ }
        }
        manifests.set(dir, pkg)
      }
      if (manifests.get(dir)) return { dir, pkg: manifests.get(dir) }
      if (dir === '.') return {}
      dir = path.posix.dirname(dir)
    }
  }

  async function companion({ file, test }) {
    const ext = path.posix.extname(file)
    if (!/^\.[cm]?js$/.test(ext) || test !== file.slice(0, -ext.length) + '.test' + ext) return false
    const { pkg } = await packageFor(file)
    return typeof pkg?.scripts?.test === 'string' && pkg.scripts.test.trim() === 'node --test'
  }

  async function validate(changes, tree, fixes) {
    const tests = new Set()
    for (const fix of fixes) {
      if (!repoFile(fix.file) || !inTarget(fix.file, target)) throw new ScopeError('reported production file is outside the audit target')
      if (!repoFile(fix.test) || fix.test === fix.file) throw new ScopeError('invalid reported regression file')
      if (!inTarget(fix.test, target) && !(testTarget && inTarget(fix.test, testTarget)) && !await companion(fix)) {
        throw new ScopeError('reported test is outside the authorized regression scope')
      }
      tests.add(fix.test)
    }
    const external = changes.filter(file => !inTarget(file, target))
    if (external.some(file => !tests.has(file))) throw new ScopeError('candidate contains changes outside the target and its authorized regression tests')
    if (tests.size) {
      const result = await git(['--literal-pathspecs', 'ls-tree', '-z', tree, '--', ...tests], store.repoRoot)
      const regular = new Set(result.stdout.split('\0').filter(l => /^100(?:644|755) blob /.test(l)).map(l => l.slice(l.indexOf('\t') + 1)))
      if (result.stdoutTruncated) throw new Error('incomplete regression file listing')
      if ([...tests].some(p => !regular.has(p))) throw new ScopeError('regression files must remain regular files in the candidate')
    }
  }

  // A focused runner receives the verified file as an argv element, independently
  // of the model's suggested shell command. Unknown runners cannot certify a fix.
  async function focus(file) {
    if (!repoFile(file)) throw new Error('invalid regression file')
    const argument = './' + file
    if (/\.[cm]?[jt]sx?$/.test(file)) {
      const { dir, pkg } = await packageFor(file)
      const runner = /^(?:jest|vitest|mocha)\b/.exec(pkg?.scripts?.test || '')?.[0]
      if (runner) {
        const exe = './' + path.posix.join(dir, 'node_modules/.bin', runner)
        const options = { jest: ['--runTestsByPath', '--runInBand'], vitest: ['run'], mocha: [] }
        return { exe, args: [...options[runner], argument] }
      }
      if (/\.[cm]?js$/.test(file)) return { exe: process.execPath, args: ['--test', argument] }
    }
    if (file.endsWith('.py')) return { exe: 'python3', args: ['-m', 'pytest', '-q', argument] }
    if (file.endsWith('.rb')) return { exe: 'ruby', args: ['-Itest', argument] }
    const cargo = /^tests\/([\w-]+)\.rs$/.exec(file)
    if (cargo) return { exe: 'cargo', args: ['test', '--test', cargo[1]] }
    return null
  }
  return { validate, focus }
}

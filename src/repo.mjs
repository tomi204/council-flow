// repo.mjs: git helpers, the repo summary planners get, test-command detection, worktree + diff handling.
//
// Every git command council-flow runs gets a controlled environment (no inherited GIT_DIR / GIT_INDEX_FILE /
// GIT_CONFIG_* overrides, no secrets) and runs with hooks disabled (`-c core.hooksPath=/dev/null`) and no fsmonitor,
// so nothing configured in the target repo executes because council-flow touched git.
import fs from 'node:fs'
import path from 'node:path'
import { auditGit, offlineCommand } from './audit/offline.mjs'
import { run } from './proc.mjs'
import { envFor } from './env.mjs'

const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

export async function git(args, cwd, opts = {}) {
  const env = opts.env || envFor(opts.kind || 'git', opts.baseEnv || process.env)
  const audit = auditGit.getStore()
  const flags = [...SAFE]
  if (audit) {
    flags.push('-c', 'protocol.allow=never', '-c', 'submodule.recurse=false', '-c', 'gc.auto=0')
    // Includes may depend on the worktree or branch. Read only effective key names,
    // never helper command strings, in the same cwd immediately before conversion.
    const lookup = offlineCommand('git', 'git', ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'])
    const keys = await run(lookup.exe, lookup.args, { cwd, env })
    if (keys.stdoutTruncated || (!keys.ok && keys.exitCode !== 1)) throw new Error('cannot verify Git filter configuration')
    for (const key of new Set(keys.stdout.split('\0').filter(Boolean))) flags.push('-c', key + (key.endsWith('.required') ? '=false' : '='))
  }
  const command = audit ? offlineCommand('git', 'git', [...flags, ...args]) : { exe: 'git', args: [...flags, ...args] }
  const r = await run(command.exe, command.args, { cwd, timeoutMs: opts.timeoutMs || 120000, env, stdin: opts.stdin })
  if (!r.ok && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.error || '').trim().slice(0, 500)}`)
  return r
}
const out = async (args, cwd, opts) => (await git(args, cwd, opts)).stdout.trim()
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

export async function repoRoot(dir) {
  const r = await git(['rev-parse', '--show-toplevel'], dir, { allowFail: true })
  if (!r.ok) throw new Error(`${dir} is not inside a git repository`)
  return r.stdout.trim()
}
export async function gitCommonDir(dir) { return real(path.resolve(dir, await out(['rev-parse', '--git-common-dir'], dir))) }
export async function headCommit(dir) { return out(['rev-parse', 'HEAD'], dir) }
export async function currentBranch(dir) {
  const r = await git(['symbolic-ref', '--short', '-q', 'HEAD'], dir, { allowFail: true })
  return r.ok ? r.stdout.trim() : null
}
export async function branchExists(root, branch) {
  return (await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root, { allowFail: true })).ok
}
export async function resolveCommit(dir, ref) {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir, { allowFail: true })
  return r.ok ? r.stdout.trim() : null
}
export async function isAncestor(dir, a, b) { return (await git(['merge-base', '--is-ancestor', a, b], dir, { allowFail: true })).ok }
export async function remotes(dir) { return (await out(['remote'], dir)).split('\n').map(s => s.trim()).filter(Boolean) }

// HOST/OWNER/REPO from a remote URL (https://, ssh://, git@host:owner/repo), or null for anything else.
export function ghRepoFromUrl(url) {
  const u = String(url || '').trim()
  const m = u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
    || u.match(/^(?:[^@/]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null
}

// The push remote (origin, else the first) and the repository gh must open the PR in. `id` is what an approval
// binds to: HOST/OWNER/REPO, or remote:<name> for a non-GitHub remote. The configured URL is read (not insteadOf).
export async function remoteInfo(dir) {
  const rems = await remotes(dir)
  const remote = rems.includes('origin') ? 'origin' : rems[0]
  if (!remote) return null
  const url = (await git(['config', '--get', `remote.${remote}.url`], dir, { allowFail: true })).stdout.trim()
  const repo = ghRepoFromUrl(url)
  return { remote, repo, id: repo || `remote:${remote}` }
}

export async function remoteHead(dir, remote, branch) {
  const r = await git(['ls-remote', remote, `refs/heads/${branch}`], dir, { allowFail: true, kind: 'push', timeoutMs: 120000 })
  return r.ok ? (r.stdout.trim().split(/\s+/)[0] || null) : undefined           // null: branch absent; undefined: lookup failed
}

// ---------------------------------------------------------------- worktree identity
export async function worktreeList(root) {
  const text = (await git(['worktree', 'list', '--porcelain'], root)).stdout
  return text.split(/\n\n+/).map(block => {
    const e = {}
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(' ')
      if (k) e[k] = v.join(' ') || true
    }
    return e
  }).filter(e => e.worktree)
}

// Before any agent call, staging, reset, test or publish in a worktree: it must be a registered *linked* worktree of
// this repo (never the primary checkout), share the repo's git common dir, be on the expected branch and, in git
// mode, be exactly this run's own folder (not a symlink to somewhere else).
export async function verifyWorktree(root, wtPath, { branch = null, expectPath = null } = {}) {
  if (!wtPath || !fs.existsSync(wtPath)) throw new Error(`worktree ${wtPath} does not exist`)
  if (expectPath) {
    if (fs.lstatSync(expectPath).isSymbolicLink()) throw new Error(`worktree path ${expectPath} is a symlink`)
    if (real(wtPath) !== real(expectPath)) throw new Error(`worktree ${wtPath} is not this run's worktree ${expectPath}`)
  }
  const realWt = real(wtPath)
  if (realWt === real(root)) throw new Error(`refusing to use the primary checkout ${root} as a worktree`)
  const list = await worktreeList(root)
  if (list.length && real(list[0].worktree) === realWt) throw new Error(`refusing to use the primary checkout ${realWt}`)
  const entry = list.find(e => real(e.worktree) === realWt)
  if (!entry) throw new Error(`${realWt} is not a registered worktree of ${root}`)
  if (await gitCommonDir(realWt) !== await gitCommonDir(root)) throw new Error(`${realWt} belongs to another repository`)
  if (real(await out(['rev-parse', '--show-toplevel'], realWt)) !== realWt) throw new Error(`${realWt} is not a worktree root`)
  if (branch && entry.branch !== `refs/heads/${branch}`) throw new Error(`worktree ${realWt} is on ${entry.branch || 'a detached HEAD'}, expected ${branch}`)
  return { path: realWt, branch: typeof entry.branch === 'string' ? entry.branch.replace(/^refs\/heads\//, '') : null }
}

// ---------------------------------------------------------------- test command
const regular = (p) => { try { const st = fs.lstatSync(p); return st.isFile() && !st.isSymbolicLink() } catch { return false } }
function readBounded(p, max) {
  const fd = fs.openSync(p, 'r')
  try { const buf = Buffer.alloc(max); const n = fs.readSync(fd, buf, 0, max, 0); return buf.subarray(0, n).toString('utf8') } finally { fs.closeSync(fd) }
}

export function detectTestCommand(dir) {
  const has = (f) => regular(path.join(dir, f))
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readBounded(path.join(dir, 'package.json'), 1 << 20))
      const t = pkg.scripts && pkg.scripts.test
      if (t && !/no test specified/.test(t)) {
        if (has('pnpm-lock.yaml')) return 'pnpm test'
        if (has('yarn.lock')) return 'yarn test'
        if (has('bun.lockb') || has('bun.lock')) return 'bun test'
        return 'npm test'
      }
    } catch { /* unreadable package.json: try the others */ }
  }
  if (has('Makefile')) {
    try { if (/^test\s*:/m.test(readBounded(path.join(dir, 'Makefile'), 1 << 20))) return 'make test' } catch { /* ignore */ }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg') || has('tox.ini')) return 'python3 -m pytest -q'
  if (has('Cargo.toml')) return 'cargo test'
  if (has('go.mod')) return 'go test ./...'
  return null
}

// ---------------------------------------------------------------- repo summary (planner brief)
const KEY_FILES = ['README.md', 'README', 'readme.md', 'package.json', 'pyproject.toml', 'Makefile', 'Cargo.toml', 'go.mod', 'requirements.txt', 'CLAUDE.md', 'AGENTS.md']

function head(text, maxLines, maxChars) {
  const lines = text.split('\n')
  let s = lines.slice(0, maxLines).join('\n')
  if (s.length > maxChars) s = s.slice(0, maxChars)
  return s.length < text.length ? `${s}\n[... truncated]` : s
}

export async function repoSummary(root, { maxFiles = 300, testCmd = null } = {}) {
  const files = (await out(['ls-files'], root)).split('\n').filter(Boolean)
  let tree
  if (files.length <= maxFiles) tree = files.join('\n')
  else {
    const counts = {}
    for (const f of files) { const top = f.includes('/') ? f.split('/')[0] + '/' : f; counts[top] = (counts[top] || 0) + 1 }
    tree = `${files.length} tracked files. Top level:\n` + Object.entries(counts).map(([k, n]) => `${k}${n > 1 ? `  (${n} files)` : ''}`).join('\n')
  }
  const parts = [`Tracked files:\n${tree}`]
  for (const f of KEY_FILES) {
    const p = path.join(root, f)
    if (!files.includes(f) || !regular(p)) continue                      // symlinks and special files are skipped
    try { parts.push(`--- ${f} ---\n${head(readBounded(p, 64 * 1024), 80, 4000)}`) } catch { /* unreadable */ }
  }
  const t = testCmd || detectTestCommand(root)
  parts.push(`Test command: ${t || '(none detected)'}`)
  return { text: parts.join('\n\n'), testCmd: t, fileCount: files.length }
}

// ---------------------------------------------------------------- worktree + diffs
export async function addWorktree(root, wtPath, branch, base, { checkout = true } = {}) {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  await git(['worktree', 'add', ...(checkout ? [] : ['--no-checkout']), '-b', branch, wtPath, base], root)
}

// Stage everything the implementer changed (never commits). The tree id is what reviews, tests and the gate bind to.
export async function stageAll(wt) { await git(['add', '-A'], wt) }
export async function writeTree(wt) { await stageAll(wt); return out(['write-tree'], wt) }

export async function diffSince(wt, base) {
  const tree = await writeTree(wt)
  const patch = (await git(['diff', '--cached', '--binary', base], wt)).stdout
  const numstat = (await git(['diff', '--cached', '--numstat', base], wt)).stdout.trim()
  const stat = { files: 0, insertions: 0, deletions: 0, paths: [] }
  for (const l of numstat.split('\n').filter(Boolean)) {
    const [a, d, ...p] = l.split('\t')
    stat.files += 1; stat.insertions += Number(a) || 0; stat.deletions += Number(d) || 0; stat.paths.push(p.join('\t'))
  }
  return { patch, stat, tree }
}
export async function diffTrees(wt, a, b) { return (await git(['diff', '--binary', a, b], wt)).stdout }

// Put the worktree (index and files) back to `tree`: used when a fix fails or was interrupted.
export async function restoreTree(wt, tree) {
  await stageAll(wt)
  await git(['read-tree', '-u', '--reset', tree], wt)
}

// Changed files' content from the given tree, for reviewers that cannot read files. Only regular blobs (modes
// 100644/100755) are read, so a symlink in the diff never pulls in a file from outside the worktree. Capped.
export async function fileExcerpts(wt, tree, paths, { perFile = 6000, total = 24000 } = {}) {
  if (!paths.length) return ''
  const listing = (await git(['ls-tree', '-r', '-z', tree, '--', ...paths], wt)).stdout.split('\0').filter(Boolean)
  const parts = []
  let used = 0
  for (const entry of listing) {
    const [meta, file] = entry.split('\t')
    const [mode, type, sha] = meta.split(' ')
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) { parts.push(`--- ${file} (${mode === '120000' ? 'symlink' : 'not a regular file'}: not shown) ---`); continue }
    if (used >= total) { parts.push(`[... more files not shown]`); break }
    const text = (await git(['cat-file', 'blob', sha], wt)).stdout
    if (text.includes('\u0000')) continue                                                  // binary
    const cut = text.slice(0, Math.min(perFile, total - used))
    used += cut.length
    parts.push(`--- ${file} (current) ---\n${cut}${cut.length < text.length ? '\n[... truncated]' : ''}`)
  }
  return parts.join('\n\n')
}

export function cap(text, max, note = 'truncated') {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}\n[... ${note}: ${s.length - max} more characters]`
}

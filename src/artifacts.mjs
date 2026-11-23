// artifacts.mjs: the run folder <repo>/.council-flow/<run-id>/ and its run.json state.
// Every write is scrubbed for secrets and atomic (temp file + rename). No path component between the repo root and
// a written file may be a symlink, the run folder is reserved with an exclusive mkdir, and a lock file keeps two
// council-flow processes off the same run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { scrubSecrets, scrubAudit, scrubAuditData } from './redact.mjs'

export const ARTIFACT_DIR = '.council-flow'
const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i

export function validRunId(id) {
  return typeof id === 'string' && RUN_ID.test(id) && !id.includes('..') && !id.endsWith('.lock') && !id.endsWith('.') && id !== 'worktrees'
}

// Timestamp + randomness only: the task text never ends up in directory names, refs or argv.
export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`
}

// Throws if any existing component of `target` below `root` is a symlink (or not a directory, for parents).
export function assertNoSymlinks(root, target) {
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${target} is outside ${root}`)
  let cur = root
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part)
    let st
    try { st = fs.lstatSync(cur) } catch { return }          // does not exist yet: nothing below it can be a link
    if (st.isSymbolicLink()) throw new Error(`refusing to use ${cur}: it is a symlink`)
  }
}

function writeAtomic(root, file, data) {
  assertNoSymlinks(root, path.dirname(file))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  assertNoSymlinks(root, file)
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  fs.renameSync(tmp, file)
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

export class RunStore {
  constructor(repoRoot, runId, env = process.env) {
    if (!validRunId(runId)) throw new Error(`invalid run id "${runId}" (letters, digits, . _ -; max 80)`)
    this.repoRoot = repoRoot
    this.runId = runId
    this.base = path.join(repoRoot, ARTIFACT_DIR)
    this.dir = path.join(this.base, runId)
    this.env = env
    this.state = null
    this.locked = false
    this.lockNote = null
  }

  static create(repoRoot, runId, init, env) {
    const s = new RunStore(repoRoot, runId, env)
    assertNoSymlinks(repoRoot, s.dir)
    fs.mkdirSync(s.base, { recursive: true, mode: 0o700 })
    if (init?.mode === 'audit') {
      const ignore = path.join(s.base, '.gitignore')
      assertNoSymlinks(repoRoot, ignore)
      try { fs.writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 }) }
      catch (e) { if (e.code !== 'EEXIST') throw e }
    }
    assertNoSymlinks(repoRoot, s.dir)
    try { fs.mkdirSync(s.dir, { mode: 0o700 }) } catch (e) {
      if (e.code === 'EEXIST') throw new Error(`run ${runId} already exists; use --resume ${runId}`)
      throw e
    }
    s.lock()
    const now = new Date().toISOString()
    s.state = { version: 2, runId, createdAt: now, updatedAt: now, members: {}, stages: {}, worktree: null, outcome: null, warnings: [], ...init }
    s.save()
    return s
  }

  static open(repoRoot, runId, env) {
    const s = new RunStore(repoRoot, runId, env)
    assertNoSymlinks(repoRoot, path.join(s.dir, 'run.json'))
    const file = path.join(s.dir, 'run.json')
    if (!fs.existsSync(file)) throw new Error(`no run ${runId} under ${s.base}`)
    s.lock()
    s.state = JSON.parse(fs.readFileSync(file, 'utf8'))
    return s
  }

  // Exclusive per-run lock. A lock left by a dead process on this host is taken over (and noted).
  lock() {
    const file = path.join(this.dir, '.lock')
    const me = JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() })
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.writeFileSync(file, me, { flag: 'wx', mode: 0o600 }); this.locked = true; return } catch (e) { if (e.code !== 'EEXIST') throw e }
      let owner = null
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* unreadable: treat as stale */ }
      if (owner && owner.host === os.hostname() && pidAlive(owner.pid)) {
        throw new Error(`run ${this.runId} is in use by process ${owner.pid} (since ${owner.at}); wait for it or stop it`)
      }
      if (owner && owner.host !== os.hostname()) throw new Error(`run ${this.runId} is locked by host ${owner.host}; remove ${file} if that run is gone`)
      this.lockNote = `took over a stale lock${owner ? ` from process ${owner.pid}` : ''}`
      fs.rmSync(file, { force: true })
    }
    throw new Error(`could not lock run ${this.runId}`)
  }
  unlock() {
    if (!this.locked) return
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(this.dir, '.lock'), 'utf8'))
      if (owner.pid === process.pid) fs.rmSync(path.join(this.dir, '.lock'), { force: true })
    } catch { /* already gone */ }
    this.locked = false
  }

  path(rel) {
    const p = path.resolve(this.dir, rel)
    if (p !== this.dir && !p.startsWith(this.dir + path.sep)) throw new Error(`artifact path escapes the run folder: ${rel}`)
    return p
  }

  // Patches keep code intact (exact secret values and credential shapes only); everything else gets the full scrub.
  write(rel, content) {
    const mode = /\.patch$/.test(rel) ? 'code' : 'log'
    writeAtomic(this.repoRoot, this.path(rel), this.state?.mode === 'audit' ? scrubAudit(content, this.env) : scrubSecrets(content, { env: this.env, mode }))
    return this.path(rel)
  }
  writeJson(rel, obj) {
    if (this.state?.mode !== 'audit') return this.write(rel, JSON.stringify(obj, null, 2) + '\n')
    const file = this.path(rel)
    writeAtomic(this.repoRoot, file, JSON.stringify(scrubAuditData(obj, this.env), null, 2) + '\n')
    return file
  }
  // Redact event values before encoding. Scrubbing the serialized stream can
  // turn numeric usage counters or quoted strings into invalid JSON.
  writeAuditStream(name, records) {
    const lines = records.map(v => typeof v === 'string' ? scrubAudit(v, this.env) : JSON.stringify(scrubAuditData(v, this.env)))
    writeAtomic(this.repoRoot, this.path(`logs/${name}.stdout.txt`), lines.join('\n'))
  }
  append(rel, line) {
    const file = this.path(rel)
    assertNoSymlinks(this.repoRoot, file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, scrubSecrets(line, { env: this.env }) + '\n', { mode: 0o600 })
  }
  exists(rel) { return fs.existsSync(this.path(rel)) }
  read(rel) { assertNoSymlinks(this.repoRoot, this.path(rel)); return fs.readFileSync(this.path(rel), 'utf8') }
  readJson(rel) { return JSON.parse(this.read(rel)) }
  remove(rel) { assertNoSymlinks(this.repoRoot, this.path(rel)); fs.rmSync(this.path(rel), { recursive: true, force: true }) }

  save() {
    this.state.updatedAt = new Date().toISOString()
    if (this.state.mode === 'audit') return this.writeJson('run.json', this.state)
    writeAtomic(this.repoRoot, path.join(this.dir, 'run.json'), scrubSecrets(JSON.stringify(this.state, null, 2) + '\n', { env: this.env }))
  }

  // ---- stages
  stage(name) { return this.state.stages[name] || null }
  isDone(name) { return this.stage(name)?.status === 'done' }
  startStage(name) {
    this.state.stages[name] = { status: 'running', startedAt: new Date().toISOString() }
    this.save()
    return Date.now()
  }
  endStage(name, status, extra = {}) {
    const st = this.state.stages[name] || {}
    const endedAt = new Date().toISOString()
    st.durationMs = st.startedAt ? Date.parse(endedAt) - Date.parse(st.startedAt) : 0
    Object.assign(st, { status, endedAt }, extra)
    this.state.stages[name] = st
    this.save()
  }

  // ---- members
  member(id) { return (this.state.members[id] ||= { status: 'unknown', reason: null, usage: { inputTokens: 0, outputTokens: 0, calls: 0 } }) }
  setMember(id, status, reason = null) { Object.assign(this.member(id), { status, reason }); this.save() }
  addUsage(id, usage) {
    const u = this.member(id).usage
    u.calls += 1
    if (usage) { u.inputTokens += usage.inputTokens || 0; u.outputTokens += usage.outputTokens || 0 }
  }
  warn(msg) { if (!this.state.warnings.includes(msg)) this.state.warnings.push(msg); this.save() }

  // Raw child output, scrubbed. Name like "plan-codex".
  writeLogs(name, r, { stdout = true } = {}) {
    if (stdout && r.stdout) this.write(`logs/${name}.stdout.txt`, (r.stdoutTruncated ? `[council-flow: output truncated, ${r.stdoutBytes} characters in total; this is the end]\n` : '') + r.stdout)
    if (r.stderr) this.write(`logs/${name}.stderr.txt`, r.stderr)
  }
}

// Adds `.council-flow/` to the repo's info/exclude (shared by all worktrees) so artifacts are never committed.
export function ensureExcluded(gitCommonDir) {
  const file = path.join(gitCommonDir, 'info', 'exclude')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { /* no exclude file yet */ }
  if (text.split(/\r?\n/).some(l => l.trim() === `${ARTIFACT_DIR}/` || l.trim() === `/${ARTIFACT_DIR}/`)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# council-flow run artifacts\n${ARTIFACT_DIR}/\n`)
  return true
}

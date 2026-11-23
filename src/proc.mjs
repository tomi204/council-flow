// proc.mjs: start one child process with the prompt on stdin, collect its output, kill its whole process
// group at the deadline. Never throws: a missing binary or a crash comes back as {ok: false, error}.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { envFor, CLAUDE_HOST_ENV } from './env.mjs'

export { CLAUDE_HOST_ENV }
const live = new Set()
export const MAX_CAPTURE = 32 * 1024 * 1024

export function killTree(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
}
export function killAll() { for (const c of live) killTree(c, 'SIGKILL') }

// First match for `name` on PATH (or the path itself when it contains a slash).
export function which(name, env = process.env) {
  if (!name) return null
  if (name.includes('/')) return fs.existsSync(name) ? name : null
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name)
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p } catch { /* next */ }
  }
  return null
}

// Keeps the last `max` characters (terminal records like claude's result line are at the end) and counts the rest.
function capture(max) {
  const c = { text: '', total: 0, truncated: false }
  c.add = (chunk) => {
    c.total += chunk.length
    c.text += chunk
    if (c.text.length > max) { c.text = c.text.slice(c.text.length - max); c.truncated = true }
  }
  return c
}

// o: {exe, args, cwd, env, stdin, timeoutMs, killGraceMs, maxCapture}
// -> {ok, exitCode, signal, stdout, stderr, stdoutTruncated, timedOut, durationMs, error}
// env defaults to a copy of process.env with every secret and Claude host marker removed.
// On timeout the whole process group gets SIGTERM, then SIGKILL after killGraceMs, even when the leader has
// already exited (a descendant may have closed its pipes and ignored SIGTERM).
export function runProcess(o) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const max = o.maxCapture || MAX_CAPTURE
    const out = capture(max), err = capture(max)
    let timedOut = false, killed = false, closed = false, settled = false, startError = null, closeInfo = [null, null]
    let child
    try {
      child = spawn(o.exe, o.args || [], { cwd: o.cwd, env: o.env || envFor('plain'), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      resolve({ ok: false, exitCode: -1, stdout: '', stderr: '', timedOut: false, durationMs: 0, error: `could not start ${o.exe}: ${e.message}` })
      return
    }
    live.add(child)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', out.add); child.stderr.on('data', err.add)
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      live.delete(child)
      const [code, signal] = closeInfo
      const exitCode = code == null ? -1 : code
      const error = startError ? startError
        : timedOut ? `timed out after ${Math.round(o.timeoutMs / 1000)}s (process group killed)`
          : exitCode !== 0 ? `exit code ${exitCode}${signal ? ` (${signal})` : ''}` : null
      resolve({ ok: !error, exitCode, signal: signal || null, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated,
        stdoutBytes: out.total, timedOut, durationMs: Date.now() - t0, error })
    }
    const timer = o.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      setTimeout(() => { killTree(child, 'SIGKILL'); killed = true; if (closed) settle() }, o.killGraceMs ?? 3000)
    }, o.timeoutMs) : null
    child.on('error', (e) => {
      startError = e.code === 'ENOENT' ? `${o.exe} not found` : `could not start ${o.exe}: ${e.message}`
      closed = true; if (!timedOut || killed) settle()
    })
    // After a timeout, settle at once only if nothing in the process group survived SIGTERM; otherwise the SIGKILL
    // timer settles.
    const groupGone = () => { try { process.kill(-child.pid, 0); return false } catch (e) { return e.code === 'ESRCH' } }
    child.on('close', (code, signal) => { closed = true; closeInfo = [code, signal]; if (!timedOut || killed || groupGone()) settle() })
    child.stdin.on('error', () => { /* the child exited before reading all of stdin */ })
    child.stdin.end(o.stdin ? Buffer.from(String(o.stdin), 'utf8') : undefined)
  })
}

// Small helper for git/gh/orca calls: args array, returns the same shape as runProcess.
export function run(exe, args, { cwd, env, stdin, timeoutMs = 120000 } = {}) {
  return runProcess({ exe, args, cwd, env, stdin, timeoutMs })
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

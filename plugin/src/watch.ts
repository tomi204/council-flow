// watch.ts: tells the worker when council-flow writes to a run folder, without polling the disk.
//
// Node's fs.watch (inotify on Linux), non-recursive and read-only:
// - `<repo>/.council-flow/` itself (a new run folder appears), or the repository root while that
//   folder does not exist yet;
// - each live run folder `<repo>/.council-flow/<run-id>/`, where council-flow renames run.json,
//   summary.md, findings.md and gate.json into place and keeps its `.lock`.
// Never the run's `worktree/` or anything deeper. Symlinked folders are not watched. Events are
// debounced per repository and only say "this repository changed": the worker then re-reads it.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { validRunId } from './command'

export const MAX_WATCHED_REPOS = 10
export const MAX_WATCHED_RUNS = 24
export const DEBOUNCE_MS = 800

type Handle = { close(): void }
type RepoWatch = { base: Handle | null; baseIsRoot: boolean; runs: Map<string, Handle>; timer: ReturnType<typeof setTimeout> | null }

const unref = (t: unknown) => (t as { unref?: () => void } | null)?.unref?.()

function realDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

export class RunWatcher {
  private repos = new Map<string, RepoWatch>()
  private disposed = false

  constructor(private readonly onChange: (repo: string) => void, private readonly debounceMs: number = DEBOUNCE_MS) {}

  private open(dir: string, repo: string): Handle | null {
    if (!realDir(dir)) return null
    try {
      const w = fs.watch(dir, () => this.changed(repo))
      w.on('error', () => this.forget(repo, dir))
      unref(w)
      return w
    } catch {
      return null
    }
  }

  private forget(repo: string, dir: string): void {
    const r = this.repos.get(repo)
    if (!r) return
    const base = path.join(repo, '.council-flow')
    if (dir === base || dir === repo) {
      r.base?.close()
      r.base = null
    } else {
      const id = path.basename(dir)
      r.runs.get(id)?.close()
      r.runs.delete(id)
    }
    this.changed(repo)
  }

  private changed(repo: string): void {
    const r = this.repos.get(repo)
    if (!r || this.disposed || r.timer) return
    r.timer = setTimeout(() => {
      r.timer = null
      if (!this.disposed) this.onChange(repo)
    }, this.debounceMs)
    unref(r.timer)
  }

  private runCount(): number {
    let n = 0
    for (const r of this.repos.values()) n += r.runs.size
    return n
  }

  /** Watches `repo` and exactly the run folders `liveRunIds` (others are let go). */
  sync(repo: string, liveRunIds: readonly string[] = []): void {
    if (this.disposed) return
    let r = this.repos.get(repo)
    if (!r) {
      if (this.repos.size >= MAX_WATCHED_REPOS) return
      r = { base: null, baseIsRoot: false, runs: new Map(), timer: null }
      this.repos.set(repo, r)
    }
    const base = path.join(repo, '.council-flow')
    const hasBase = realDir(base)
    if (r.base && r.baseIsRoot === hasBase) {
      // .council-flow appeared (watch it instead of the root) or went away: switch.
      r.base.close()
      r.base = null
    }
    if (!r.base) {
      r.base = this.open(hasBase ? base : repo, repo)
      r.baseIsRoot = !hasBase
    }
    const wanted = new Set(hasBase ? liveRunIds.filter((id) => validRunId(id)) : [])
    for (const [id, w] of r.runs) {
      if (!wanted.has(id)) {
        w.close()
        r.runs.delete(id)
      }
    }
    for (const id of wanted) {
      if (r.runs.has(id) || this.runCount() >= MAX_WATCHED_RUNS) continue
      const w = this.open(path.join(base, id), repo)
      if (w) r.runs.set(id, w)
    }
  }

  /** Stops watching repositories that are not in `keep`. */
  retain(keep: readonly string[]): void {
    for (const repo of [...this.repos.keys()]) if (!keep.includes(repo)) this.drop(repo)
  }

  drop(repo: string): void {
    const r = this.repos.get(repo)
    if (!r) return
    r.base?.close()
    for (const w of r.runs.values()) w.close()
    if (r.timer) clearTimeout(r.timer)
    this.repos.delete(repo)
  }

  watched(): { repo: string; base: 'council-flow' | 'root' | null; runs: string[] }[] {
    return [...this.repos].map(([repo, r]) => ({ repo, base: r.base ? (r.baseIsRoot ? 'root' : 'council-flow') : null, runs: [...r.runs.keys()] }))
  }

  dispose(): void {
    this.disposed = true
    for (const repo of [...this.repos.keys()]) this.drop(repo)
  }
}

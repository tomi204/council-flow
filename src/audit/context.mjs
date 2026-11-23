import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertNoSymlinks, validRunId } from '../artifacts.mjs'
import { cap, git } from '../repo.mjs'
import { render } from '../prompts.mjs'
import { scrubAudit, scrubAuditData } from '../redact.mjs'
import { auditJson, MemberFailure } from './calls.mjs'
export { auditCall } from './calls.mjs'
import { invalid, repoFile, reportProse } from './findings.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const config = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:config|settings|credentials|secrets?|lock)[^/]*|Makefile|Dockerfile|go\.mod|requirements\.txt)$|\.(?:json5?|ya?ml|toml|ini|properties|xml|conf|cfg|lock)$/i
const source = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|c|cc|cpp|h|cs|swift|sh|sql|vue|svelte)$/i
const sections = ['architecture', 'attack_surface', 'trust_boundaries', 'auth_model', 'dependencies', 'config_secrets', 'data_flows', 'prior_findings', 'red_brief', 'blue_brief']

export const safeText = scrubAudit

function configSummary(file, text) {
  // Values (including arbitrary URLs, nested secrets and multiline scalars) never leave this collector.
  const keys = new Set()
  if (file.endsWith('.json')) {
    try {
      const visit = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 5 || keys.size >= 120) return
        for (const k of Object.keys(v)) {
          if (keys.size >= 120) break
          if (!Array.isArray(v) && /^[\w@./-]{1,100}$/.test(k)) keys.add(k)
          visit(v[k], depth + 1)
        }
      }
      const manifest = JSON.parse(text)
      if (file.endsWith('package.json')) for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(manifest?.[group] || {})) {
          if (keys.size < 120 && /^[@\w./-]{1,100}$/.test(name)) {
            keys.add(typeof version === 'string' && /^[~^=<>\d. *|-]{1,40}$/.test(version) ? name + ' ' + version : name)
          }
        }
      }
      visit(manifest, 0)
    } catch { return '' }
  }
  // Only accept a complete, single-line dotenv grammar. A malformed line could be
  // part of a quoted value. Unsupported formats (including YAML) contribute their name only.
  if (/(?:^|\/)\.env(?:\.|$)/.test(file)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"[^"\\]*"|'[^']*'|[^"'\\#\s]*)\s*(?:#.*)?$/.exec(line)
      if (!assignment) return ''
      if (keys.size < 120) keys.add(assignment[1])
    }
  }
  if (!keys.size) return ''
  return 'Configuration / dependency names only: ' + [...keys].join(', ')
}

// Earlier versions also persisted unchecked prose in Markdown. Preserve ordinary
// finding headings, locations and explanations. Never import an unsafe historical report.
function priorExcerpt(raw, env) {
  const text = safeText(raw, env)
  for (const line of text.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (line === '# Audit findings' || /^round \d+ (open|confirmed|rejected|fixed|reopened)( → round \d+ (open|confirmed|rejected|fixed|reopened))*$/.test(line)) continue
    const where = /^(\S+):(\d+)(?: CWE-\d+)?$/.exec(line)
    if (where && repoFile(where[1])) continue
    const prose = line.replace(/^## [\w-]+ · (?:low|medium|high|critical) · (?:open|confirmed|rejected|fixed|reopened) · /, '')
      .replace(/^(?:Fix direction|Impact): /, '').replace(/[\w.-]+\s*=\s*\[REDACTED\]/g, 'redacted')
    if (!reportProse(prose)) return ''
  }
  return text
}

function priorFindings(store) {
  const prior = []
  for (const id of fs.readdirSync(store.base, { withFileTypes: true })
    .filter(e => e.isDirectory() && validRunId(e.name) && e.name !== store.runId).map(e => e.name).sort().reverse()) {
    const f = path.join(store.base, id, 'findings.md')
    try {
      assertNoSymlinks(store.repoRoot, f)
      if (!fs.lstatSync(f).isFile()) continue
      const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const buf = Buffer.alloc(2000)
        const excerpt = priorExcerpt(buf.subarray(0, fs.readSync(fd, buf)).toString(), store.env)
        if (excerpt) prior.push(id + '\n' + excerpt)
      } finally { fs.closeSync(fd) }
    } catch { continue }
    if (prior.length === 3) break
  }
  return prior.join('\n')
}

export function inTarget(file, target) {
  return target.kind === 'loopback' || target.path === '.' || file === target.path || (target.directory !== false && file.startsWith(target.path + '/'))
}

export async function collect(ctx, tree) {
  const { store, repoRoot, env } = ctx
  const target = store.state.target
  const result = await git(['ls-tree', '-r', '-l', '-z', tree], repoRoot)
  if (result.stdoutTruncated) throw new Error('repository tree exceeds collection limit')
  const entries = result.stdout.split('\0').flatMap(e => {
    const m = /^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t([^\n]+)$/.exec(e)
    if (m && safeText(m[3], env) !== m[3]) throw new Error('tracked filename contains credential material')
    return m && repoFile(m[3]) ? [{ oid: m[1], size: +m[2], file: m[3] }] : []
  })
  const removedTarget = target.kind === 'path' && target.path !== '.' && !entries.some(e => inTarget(e.file, target))
  if (removedTarget) {
    const base = await git(['--literal-pathspecs', 'ls-tree', '-rz', store.state.worktree.baseCommit, '--', target.path], repoRoot)
    if (base.stdoutTruncated || !base.stdout.split('\0').some(line => /^100(?:644|755) blob /.test(line))) {
      throw new Error('target has no tracked regular files in the audit snapshot')
    }
  }
  const rank = p => (inTarget(p, target) ? 0 : 20) + (/auth|route|handler|parser|server|cli\.|index\.|main\./i.test(p) ? 0 : config.test(p) ? 1 : /test|spec/i.test(p) ? 2 : 3)
  const ordered = entries.sort((a, b) => rank(a.file) - rank(b.file))
  const scoped = ordered.filter(e => inTarget(e.file, target))
  // Reserve some of the excerpt budget for each kind of evidence in larger repos.
  const manifests = ordered.filter(e => config.test(e.file)).slice(0, 5)
  const tests = scoped.filter(e => /(?:test|spec)/i.test(e.file) && source.test(e.file)).slice(0, 2)
  const services = scoped.filter(e => source.test(e.file) && !config.test(e.file))
  const selected = new Set([...services.slice(0, 2), ...manifests, ...tests, ...services])
  const excerpts = []
  let used = 0
  for (const { file, size, oid } of selected) {
    if (used >= 24000 || excerpts.length >= 36) break
    if (!(config.test(file) || source.test(file)) || size > 512000 || /(?:^|\/)(?:vendor|node_modules|dist)\//.test(file)) continue
    const text = (await git(['cat-file', 'blob', oid], repoRoot)).stdout
    if (text.includes('\0')) continue
    const body = config.test(file) ? configSummary(file, text) : text.split('\n').slice(0, 100).map((l, i) => `${i + 1} ${l}`).join('\n')
    const excerpt = cap(safeText(body, env), Math.min(2800, 24000 - used))
    excerpts.push({ file, excerpt })
    used += excerpt.length
  }
  return { targetRemoved: removedTarget, tree: ordered.slice(0, 450).map(e => e.file), file_count: entries.length, excerpts, prior: safeText(priorFindings(store), env) }
}

export function safeDiff(patch, env) {
  let omit = false
  return safeText(patch.split('\n').map(line => {
    if (line.startsWith('diff --git ')) {
      // Omit config, binary and non-source hunks. Quoted/ambiguous paths are omitted conservatively.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      omit = !m || m.slice(1).some(p => config.test(p) || !source.test(p))
      return omit ? line + ' [contents omitted]' : line
    }
    return omit ? '' : line
  }).filter(Boolean).join('\n'), env)
}

export async function contextPack(ctx, tree, iteration, revision, full) {
  const { store } = ctx
  let meta = store.state.context
  if (!meta || meta.iteration !== iteration) {
    let version = meta ? meta.version + 1 : 1
    while (store.exists(`context/v${version}`)) version++
    const material = await collect(ctx, tree)
    let update = ''
    if (revision && !full) {
      const previous = store.read(`context/v${meta.version}/pack.json`)
      if (sha(previous) !== meta.hash) throw new Error('saved context hash mismatch')
      const data = { previousPack: JSON.parse(previous), previousHash: meta.hash, ...revision }
      update = render('audit-context-delta', { revision: JSON.stringify(scrubAuditData(data, ctx.env)) })
    } else if (revision) {
      update = 'Fresh rebuild. Current candidate and outstanding review evidence:\n' + JSON.stringify(scrubAuditData(revision, ctx.env))
    }
    const prompt = render('audit-context', { scope: ctx.scope, material: JSON.stringify(scrubAuditData(material, ctx.env)), revision: update })
    let pack, builder
    const builders = full ? ['codex', 'claude'] : ['codex']
    for (const id of builders) {
      try {
        const shape = 'One JSON object with nonempty string fields ' + sections.join(', ')
        pack = await auditJson(ctx, { id, role: 'audit-context', prompt, name: `context-v${version}-${id}`, shape }, answer => {
          for (const k of sections) if (typeof answer?.[k] !== 'string' || !answer[k].trim() || answer[k].length > 8000) {
            invalid(k, 'expected a nonempty context section up to 8000 characters')
          }
          return Object.fromEntries(sections.map(k => [k, safeText(answer[k], ctx.env)]))
        })
        builder = id
        break
      } catch (e) {
        if (!(e instanceof MemberFailure)) throw e
        store.warn(`Context v${version}: ${e.message}`)
        if (id === builders.at(-1)) throw e
      }
    }
    if (!pack) throw new Error('no valid audit context from ' + builders.join(' or '))
    Object.assign(pack, { iteration, scope: ctx.scope, material })
    const dir = `context/v${version}`
    store.writeJson(dir + '/pack.json', pack)
    meta = { iteration, version, previousHash: full ? null : meta.hash, mode: full ? 'full' : 'delta', hash: sha(store.read(dir + '/pack.json')), commit: store.state.worktree.baseCommit, tree, builder }
    store.write(dir + '/pack.md', sections.map(k => '## ' + k.replaceAll('_', ' ') + '\n\n' + pack[k]).join('\n\n'))
    store.write(dir + '/briefs/red.md', cap(pack.red_brief, 1200))
    store.write(dir + '/briefs/blue.md', pack.blue_brief)
    store.writeJson(dir + '/meta.json', meta)
    store.state.context = meta
    store.save()
  }
  if (meta.tree !== tree) throw new Error('saved context tree mismatch')
  const bytes = store.read(`context/v${meta.version}/pack.json`)
  if (sha(bytes) !== meta.hash) throw new Error('saved context hash mismatch')
  return { ...meta, pack: JSON.parse(bytes) }
}

// Council Flow sidebar panel (components UI, no build step).
// Starts council-flow in a new Orca terminal of the chosen workspace and shows its runs. The panel
// itself runs nothing: every action is a plugin.request to src/worker.ts, and the command shown
// below each form is built by the same src/command.ts the worker uses.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Markdown,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Tab,
  Table,
  Tabs,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import { buildAudit, buildCode, MAX_ROUNDS, precheckTarget, precheckTestTarget, type AuditForm, type CodeForm, type Implementer } from './command'
import type { ArtifactResult, ContextInfo, RunRow, RunsAnswer, StartResult, WorkspaceRow } from './protocol'

/** Characters of an artifact shown at once (Orca caps one text at 16 KiB). */
export const PAGE = 12000
const PREVIEW_RUN_ID = 'new-run-id'

const context = atom<ContextInfo | null>(null)
const contextError = atom<string | null>(null)
const workspaceId = atom<string | null>(null)
const repoInput = atom('')
const tab = atom('tab', 'audit', { persist: 'plugin' })
const audit = atom<AuditForm>('auditForm', { scope: '', target: '', testTarget: '', rounds: '', dryRun: true, refreshContext: false }, { persist: 'plugin' })
const code = atom<CodeForm>('codeForm', { task: '', implementer: '', rounds: '', dryRun: true }, { persist: 'plugin' })
const runs = atom<RunsAnswer | null>(null)
const runsLoading = atom(false)
const selected = atom<string | null>(null)
const artifact = atom<{ result: ArtifactResult; page: number } | null>(null)
const lastStart = atom<StartResult | null>(null)
const busy = atom(false)
const refreshOnResume = atom(false)
const cliDraft = atom('')

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function currentWorkspace(): WorkspaceRow | null {
  const ctx = read(context)
  if (!ctx) return null
  const id = read(workspaceId)
  return ctx.workspaces.find((w) => w.id === id) ?? null
}

const repoOf = (ws: WorkspaceRow | null) => read(repoInput).trim() || ws?.path || ''

async function loadRuns(): Promise<void> {
  const ws = currentWorkspace()
  if (!ws || !ws.usable) {
    set(runs, null)
    return
  }
  set(runsLoading, true)
  try {
    set(runs, await plugin.request('cf.runs', { repo: repoOf(ws) }))
  } catch (e) {
    set(runs, { repo: repoOf(ws), runs: [], truncated: false, error: errorText(e), started: [] })
  } finally {
    set(runsLoading, false)
  }
}

async function loadContext(): Promise<void> {
  try {
    const ctx = await plugin.request('cf.context')
    set(context, ctx)
    set(contextError, null)
    const keep = ctx.workspaces.find((w) => w.id === read(workspaceId) && w.usable)
    if (!keep) {
      const focused = ctx.workspaces.find((w) => w.id === ctx.focusedId && w.usable)
      set(workspaceId, (focused ?? ctx.workspaces.find((w) => w.usable))?.id ?? null)
    }
    await loadRuns()
  } catch (e) {
    set(contextError, errorText(e))
  }
}

async function chooseWorkspace(id: string): Promise<void> {
  set(workspaceId, id)
  set(repoInput, '')
  set(selected, null)
  set(artifact, null)
  await loadRuns()
}

async function startRun(kind: 'audit' | 'code' | 'doctor'): Promise<void> {
  const ws = currentWorkspace()
  if (!ws) return
  set(busy, true)
  try {
    const res = await plugin.request('cf.start', {
      kind,
      workspaceId: ws.id,
      repo: repoOf(ws),
      ...(kind === 'audit' ? { audit: read(audit) } : kind === 'code' ? { code: read(code) } : {})
    })
    set(lastStart, res)
    if (res.ok && res.runId) set(selected, res.runId)
    await loadRuns()
  } catch (e) {
    set(lastStart, { ok: false, error: errorText(e) })
  } finally {
    set(busy, false)
  }
}

async function resumeRun(row: RunRow): Promise<void> {
  const ws = currentWorkspace()
  if (!ws) return
  set(busy, true)
  try {
    const res = await plugin.request('cf.resume', { workspaceId: ws.id, repo: repoOf(ws), runId: row.runId, refreshContext: row.mode === 'audit' && read(refreshOnResume) })
    set(lastStart, res)
    await loadRuns()
  } catch (e) {
    set(lastStart, { ok: false, error: errorText(e) })
  } finally {
    set(busy, false)
  }
}

async function openArtifact(runId: string, name: string): Promise<void> {
  const ws = currentWorkspace()
  if (!ws) return
  try {
    set(artifact, { result: await plugin.request('cf.artifact', { repo: repoOf(ws), runId, name }), page: 0 })
  } catch (e) {
    set(artifact, { result: { ok: false, error: errorText(e) }, page: 0 })
  }
}

async function saveCli(path: string | null): Promise<void> {
  try {
    const cli = await plugin.request('cf.setCli', { path })
    const ctx = read(context)
    if (ctx) set(context, { ...ctx, cli })
    if (cli.ok) set(cliDraft, '')
  } catch (e) {
    set(contextError, errorText(e))
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('cf.started', () => void loadRuns()),
    on('workspace.changed', () => void loadContext())
  )
  void loadContext()
}

function preview(kind: 'audit' | 'code'): { ok: true; line: string } | { ok: false; error: string } {
  const ctx = read(context)
  const ws = currentWorkspace()
  const cli = ctx?.cli.ok ? ctx.cli.path : '/path/to/council-flow/bin/council-flow.mjs'
  const repo = repoOf(ws)
  if (!repo) return { ok: false, error: 'pick a workspace' }
  const built = kind === 'audit' ? buildAudit(cli, repo, read(audit), PREVIEW_RUN_ID) : buildCode(cli, repo, read(code), PREVIEW_RUN_ID)
  return built.ok ? { ok: true, line: built.line.replace(`--run-id ${PREVIEW_RUN_ID}`, '--run-id <new run id>') } : built
}

/** Orca's Select refuses an empty value, so "default" stands for a blank form field. */
const DEFAULT = 'default'
const fromSelect = (v: string) => (v === DEFAULT ? '' : v)
const toSelect = (v: string | undefined) => (v ? v : DEFAULT)

const roundOptions = (fallback: string) => [
  { value: DEFAULT, label: `Default (${fallback})` },
  ...Array.from({ length: MAX_ROUNDS + 1 }, (_, n) => ({ value: String(n), label: String(n) }))
]

function StartControls(props: { kind: 'audit' | 'code'; label: string }) {
  const p = preview(props.kind)
  const ctx = read(context)
  const blocked = !ctx?.cli.ok || !ctx?.canStart
  return (
    <Stack gap="sm">
      {p.ok ? <Code block>{p.line}</Code> : <Text tone="danger" size="xs">{p.error}</Text>}
      <Button icon="play" tone="accent" disabled={!p.ok || blocked || read(busy)} onPress={() => startRun(props.kind)}>
        {props.label}
      </Button>
    </Stack>
  )
}

function AuditTab() {
  const form = read(audit)
  const target = precheckTarget(form.target)
  const testTarget = precheckTestTarget(form.testTarget)
  const edit = (patch: Partial<AuditForm>) => update(audit, (f) => ({ ...f, ...patch }))
  return (
    <Stack gap="sm">
      <Callout tone="warning" icon="warning" title="Local only">
        <Text size="xs">
          council-flow audits code you own on this machine. A target is a path in the repository or localhost, 127.x.x.x or [::1] with a port, and no
          traffic is sent to it. council-flow refuses any other target before any model call. Only your exact answer "approve" in the run's terminal
          commits a tested fix, locally.
        </Text>
      </Callout>
      <Textarea label="Scope" rows={3} placeholder="What to review, e.g. authorization in the file reader" value={form.scope} onChange={(v) => edit({ scope: v })} />
      <Input label="Target" placeholder="blank = whole repository, src/reader.js or localhost:3000" value={form.target ?? ''} invalid={!target.ok} onChange={(v) => edit({ target: v })} />
      {!target.ok ? <Text tone="danger" size="xs">{target.error}</Text> : null}
      <Input label="Test target (optional)" placeholder="test/ or test/reader.test.mjs" value={form.testTarget ?? ''} invalid={!testTarget.ok} onChange={(v) => edit({ testTarget: v })} />
      {!testTarget.ok ? <Text tone="danger" size="xs">{testTarget.error}</Text> : null}
      <Select label="Iterations" options={roundOptions('3')} value={toSelect(form.rounds)} onChange={(v) => edit({ rounds: fromSelect(v) })} />
      <Checkbox label="Dry run" description="Fake models and a fake gate that denies: no tokens are spent" checked={form.dryRun === true} onChange={(v) => edit({ dryRun: v })} />
      <Checkbox label="Refresh context" description="Build a full new context pack" checked={form.refreshContext === true} onChange={(v) => edit({ refreshContext: v })} />
      <StartControls kind="audit" label="Start audit in a new terminal" />
    </Stack>
  )
}

function CodeTab() {
  const form = read(code)
  const edit = (patch: Partial<CodeForm>) => update(code, (f) => ({ ...f, ...patch }))
  return (
    <Stack gap="sm">
      <Textarea label="Task" rows={4} placeholder="e.g. Add a /health endpoint with a test" value={form.task} onChange={(v) => edit({ task: v })} />
      <Select
        label="Implementer"
        options={[
          { value: DEFAULT, label: 'Default (COUNCIL_IMPLEMENTER, else codex)' },
          { value: 'codex', label: 'codex' },
          { value: 'claude', label: 'claude' }
        ]}
        value={toSelect(form.implementer)}
        onChange={(v) => edit({ implementer: fromSelect(v) as Implementer })}
      />
      <Select label="Fix rounds" options={roundOptions('2')} value={toSelect(form.rounds)} onChange={(v) => edit({ rounds: fromSelect(v) })} />
      <Checkbox label="Dry run" description="Fake members, fake Orca and a fake gate that denies: no tokens are spent" checked={form.dryRun === true} onChange={(v) => edit({ dryRun: v })} />
      <Text muted size="xs">
        Nothing is committed, pushed or opened as a PR unless you answer the decision gate "approve" yourself. Started from an Orca terminal, the gate
        appears in Orca.
      </Text>
      <StartControls kind="code" label="Start coding run in a new terminal" />
    </Stack>
  )
}

function ArtifactView() {
  const a = read(artifact)
  if (!a) return null
  if (!a.result.ok) return <Callout tone="danger" title="Could not open">{a.result.error}</Callout>
  const { name, text, truncated, path } = a.result.artifact
  const pages = Math.max(1, Math.ceil(text.length / PAGE))
  const page = Math.min(a.page, pages - 1)
  const chunk = text.slice(page * PAGE, (page + 1) * PAGE)
  const turn = (by: number) => update(artifact, (cur) => (cur ? { ...cur, page: Math.min(pages - 1, Math.max(0, cur.page + by)) } : cur))
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Text weight="semibold">{name}</Text>
        <Row gap="xs">
          {pages > 1 ? <Badge>{`${page + 1}/${pages}`}</Badge> : null}
          {pages > 1 ? <IconButton icon="collapse" label="Previous page" size="xs" disabled={page === 0} onPress={() => turn(-1)} /> : null}
          {pages > 1 ? <IconButton icon="expand" label="Next page" size="xs" disabled={page >= pages - 1} onPress={() => turn(1)} /> : null}
          <IconButton icon="close" label="Close file" size="xs" onPress={() => set(artifact, null)} />
        </Row>
      </Row>
      {name === 'run.json' ? <CodeView code={chunk} language="json" maxHeight="lg" /> : <Markdown content={chunk} />}
      {truncated ? <Text muted size="xs">Showing the first 256 KiB.</Text> : null}
      <Code>{path}</Code>
    </Stack>
  )
}

function RunDetails(props: { row: RunRow }) {
  const r = props.row
  const busyNow = read(busy)
  return (
    <Card title={r.runId} description={r.title || undefined}>
      <Stack gap="sm">
        <KeyValue
          items={[
            { label: 'Mode', value: r.mode === 'audit' ? 'audit' : r.mode === 'code' ? 'coding' : 'unknown' },
            { label: 'Status', value: r.status, tone: r.tone },
            ...(r.target ? [{ label: 'Target', value: r.target, code: true }] : []),
            ...(r.stopReason ? [{ label: 'Stop reason', value: r.stopReason }] : []),
            ...(r.unresolved !== null ? [{ label: 'Unresolved', value: r.unresolved }] : []),
            { label: 'Dry run', value: r.dryRun },
            ...(r.updatedAt ? [{ label: 'Updated', value: new Date(r.updatedAt).toLocaleString() }] : [])
          ]}
        />
        <Row gap="xs" wrap>
          <Button size="sm" variant="outline" icon="file-text" disabled={!r.files.summary} onPress={() => openArtifact(r.runId, 'summary.md')}>
            summary.md
          </Button>
          <Button size="sm" variant="outline" icon="file-text" disabled={!r.files.findings} onPress={() => openArtifact(r.runId, 'findings.md')}>
            findings.md
          </Button>
          <Button size="sm" variant="outline" icon="code" disabled={!r.files.runJson} onPress={() => openArtifact(r.runId, 'run.json')}>
            run.json
          </Button>
        </Row>
        {r.mode === 'audit' ? (
          <Checkbox label="Refresh context on resume" checked={read(refreshOnResume)} onChange={(v) => set(refreshOnResume, v)} />
        ) : null}
        <Button size="sm" icon="play" disabled={!r.resumable || busyNow || !read(context)?.cli.ok} onPress={() => resumeRun(r)}>
          {r.running ? 'Running' : `Resume in a new terminal${r.dryRun ? ' (dry run)' : ''}`}
        </Button>
        <ArtifactView />
      </Stack>
    </Card>
  )
}

function RunsTab() {
  const data = read(runs)
  const ws = currentWorkspace()
  const sel = read(selected)
  const rows = data?.runs ?? []
  const pending = (data?.started ?? []).filter((s) => s.runId && !rows.some((r) => r.runId === s.runId)).slice(0, 5)
  const row = rows.find((r) => r.runId === sel) ?? null
  const choose = (key: string | undefined) => {
    set(selected, key ?? null)
    set(artifact, null)
  }
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Text muted size="xs" truncate>{`${repoOf(ws)}/.council-flow`}</Text>
        <Button size="xs" variant="ghost" icon="refresh" disabled={read(runsLoading)} onPress={loadRuns}>
          Refresh
        </Button>
      </Row>
      {data?.error ? <Callout tone="danger" title="Cannot read runs">{data.error}</Callout> : null}
      {pending.map((s) => (
        <Text key={s.runId ?? s.terminalId} size="xs" muted>{`${s.runId}: started in terminal "${s.title}", no run folder yet. If it stays missing, council-flow refused the command: see that terminal.`}</Text>
      ))}
      <Table
        label="Runs"
        columns={[
          { key: 'run', label: 'Run' },
          { key: 'mode', label: 'Mode', width: 'xs', hideBelow: 'sm' },
          { key: 'status', label: 'Status', width: 'sm' },
          { key: 'updated', label: 'Updated', width: 'sm', hideBelow: 'md' }
        ]}
        rows={rows.map((r) => ({
          key: r.runId,
          cells: {
            run: r.title ? `${r.runId}  ${r.title}` : r.runId,
            mode: r.mode === 'code' ? 'coding' : r.mode,
            status: r.dryRun ? `${r.status} (dry)` : r.status,
            updated: r.updatedAt ? { type: 'relative', at: r.updatedAt } : null
          }
        }))}
        selectionMode="single"
        selected={sel ? [sel] : []}
        onSelectionChange={({ keys }) => choose(keys[0])}
        onRowAction={({ key }) => choose(key)}
        loading={read(runsLoading)}
        emptyText="No council-flow runs in this repository yet"
        maxHeight="md"
      />
      {row ? <RunDetails row={row} /> : null}
    </Stack>
  )
}

function StartedCallout() {
  const res = read(lastStart)
  if (!res) return null
  if (!res.ok) return <Callout tone="danger" title="Not started">{res.error}</Callout>
  const gate =
    res.kind === 'audit'
      ? 'The audit ends at a gate in that terminal: only your exact "approve" there commits a tested fix locally.'
      : res.kind === 'code'
        ? 'The run ends at a decision gate in Orca (or that terminal): only your "approve" commits, pushes or opens a PR.'
        : res.kind === 'resume'
          ? 'The gate is asked again there: answer it yourself.'
          : 'Doctor only checks members and Orca.'
  return (
    <Callout tone="success" title={`Opened "${res.title}"`} icon="terminal">
      <Text size="xs">{`New terminal in ${res.workspaceName}. ${gate} The plugin never types into it.`}</Text>
    </Callout>
  )
}

function Setup() {
  const ctx = read(context)
  if (!ctx) return null
  const cli = ctx.cli
  return (
    <Collapsible title="Setup" description={cli.ok ? `council-flow ${cli.version ?? ''} (${cli.source})` : 'council-flow not found'} defaultOpen={!cli.ok}>
      <Stack gap="sm">
        {cli.ok ? <Code>{cli.path}</Code> : <Callout tone="danger">{cli.error}</Callout>}
        {!ctx.canStart ? <Callout tone="danger">This Orca cannot open terminals for plugins.</Callout> : null}
        <Input label="council-flow checkout" placeholder="/home/you/council-flow" value={read(cliDraft)} onChange={(v) => set(cliDraft, v)} onSubmit={(v) => saveCli(v.trim() || null)} />
        <Row gap="xs" wrap>
          <Button size="sm" disabled={!read(cliDraft).trim()} onPress={() => saveCli(read(cliDraft).trim())}>
            Use this checkout
          </Button>
          {cli.ok && cli.source === 'configured' ? (
            <Button size="sm" variant="ghost" onPress={() => saveCli(null)}>
              Use the bundled one
            </Button>
          ) : null}
          <Button size="sm" variant="outline" icon="wrench" disabled={!cli.ok || !ctx.canStart || read(busy)} onPress={() => startRun('doctor')}>
            Run doctor
          </Button>
        </Row>
        <Text muted size="xs">Runs use node from the terminal's PATH. LYBER_API_KEY stays in your shell: the plugin never reads it.</Text>
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const ctx = read(context)
  const err = read(contextError)
  const ws = currentWorkspace()
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading level={2}>Council Flow</Heading>
        <IconButton icon="refresh" label="Refresh" onPress={loadContext} />
      </Row>
      {err ? <Callout tone="danger" title="Orca did not answer">{err}</Callout> : null}
      {!ctx ? (
        err ? null : <Spinner label="Loading workspaces" />
      ) : !ctx.workspaces.some((w) => w.usable) ? (
        <EmptyState icon="folder" title="No Git workspace" description="Open a local Git checkout as an Orca workspace: council-flow runs against a repository on this host." />
      ) : (
        <Stack gap="md">
          <Select
            label="Workspace"
            value={ws?.id ?? ''}
            options={ctx.workspaces.map((w) => ({
              value: w.id,
              label: w.usable ? `${w.name}${w.branch ? ` (${w.branch})` : ''}` : `${w.name}: ${w.reason ?? 'unavailable'}`,
              disabled: !w.usable
            }))}
            onChange={(v) => chooseWorkspace(v)}
          />
          <Input label="Repository" placeholder={ws?.path ?? ''} value={read(repoInput)} onChange={(v) => set(repoInput, v)} onSubmit={() => loadRuns()} />
          <StartedCallout />
          <Tabs label="Mode" value={read(tab)} onChange={(v) => set(tab, v)}>
            <Tab value="audit" label="Audit" icon="bug">
              <AuditTab />
            </Tab>
            <Tab value="code" label="Code" icon="code">
              <CodeTab />
            </Tab>
            <Tab value="runs" label="Runs" icon="layers">
              <RunsTab />
            </Tab>
          </Tabs>
          <Setup />
        </Stack>
      )}
    </Stack>
  )
}

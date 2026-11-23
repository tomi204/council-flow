// Council Flow sidebar panel (components UI, no build step).
//
// One prompt and one Run button on top, the live Workflows list below, Setup behind the gear.
// The panel itself runs nothing: every action is a plugin.request to src/worker.ts, and the command
// preview under Options is built by the same src/command.ts the worker uses. The panel never types
// into a terminal and has no control that sends a gate answer: "Jump to terminal" only moves focus.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Markdown,
  on,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import { buildAudit, buildCode, MAX_ROUNDS, precheckTarget, precheckTestTarget, type AuditForm, type CodeForm, type Implementer } from './command'
import { effectiveMode, EXAMPLE_PROMPT, nextOverride, pick, type Mode, type Override } from './mode'
import { findingsText, formatDuration, type Phase, type Step } from './progress'
import type { ArtifactResult, ContextInfo, StartResult, Workflow, WorkflowsAnswer, WorkspaceRow } from './protocol'

/** Characters of an artifact shown at once (Orca caps one text at 16 KiB). */
export const PAGE = 12000
const PREVIEW_RUN_ID = 'new-run-id'
const LIVE: ReadonlySet<Phase> = new Set(['starting', 'running', 'waiting-approve', 'publishing'])

export type Options = {
  auditRounds: string
  codeRounds: string
  target: string
  testTarget: string
  refreshContext: boolean
  implementer: Implementer
}
export const DEFAULT_OPTIONS: Options = { auditRounds: '', codeRounds: '', target: '', testTarget: '', refreshContext: false, implementer: '' }

// Kept across panel runs: the draft prompt, a manual mode pick, dry run (on until turned off) and Options.
const prompt = atom('prompt', '', { persist: 'plugin' })
const override = atom<Override | null>('modeOverride', null, { persist: 'plugin' })
const dryRun = atom('dryRun', true, { persist: 'plugin' })
const options = atom<Options>('options', DEFAULT_OPTIONS, { persist: 'plugin' })

const view = atom<'home' | 'setup'>('home')
const context = atom<ContextInfo | null>(null)
const contextError = atom<string | null>(null)
/** A workspace picked in the Repo dropdown; null follows Orca's focused workspace. */
const picked = atom<string | null>(null)
const repoPath = atom('')
const flows = atom<WorkflowsAnswer | null>(null)
const artifact = atom<{ runId: string; result: ArtifactResult; page: number } | null>(null)
const lastStart = atom<StartResult | null>(null)
const notice = atom<{ tone: 'danger' | 'neutral'; text: string } | null>(null)
const busy = atom(false)
const cliDraft = atom('')

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function currentWorkspace(): WorkspaceRow | null {
  const ctx = read(context)
  if (!ctx) return null
  const usable = ctx.workspaces.filter((w) => w.usable)
  const id = read(picked)
  return usable.find((w) => w.id === id) ?? usable.find((w) => w.id === ctx.focusedId) ?? usable[0] ?? null
}

const repoOf = (ws: WorkspaceRow | null) => read(repoPath).trim() || ws?.path || ''
const mode = (): Mode => effectiveMode(read(prompt), read(override))

/** The workspace whose terminal a run of `repo` opens in: the one checked out there, else the current one. */
function workspaceFor(repo: string): WorkspaceRow | null {
  const ctx = read(context)
  return ctx?.workspaces.find((w) => w.usable && w.path === repo) ?? currentWorkspace()
}

// ---- loading, coalesced: a burst of events makes one request, plus one more if asked meanwhile

let flowsLoad: Promise<void> | null = null
let flowsAgain = false

async function loadFlows(): Promise<void> {
  if (flowsLoad) {
    flowsAgain = true
    return flowsLoad
  }
  flowsLoad = (async () => {
    do {
      flowsAgain = false
      const repo = repoOf(currentWorkspace())
      if (!repo) {
        set(flows, null)
        continue
      }
      try {
        set(flows, await plugin.request('cf.workflows', { repo }))
      } catch (e) {
        set(flows, { repos: [repo], workflows: [], errors: [{ repo, error: errorText(e) }], truncated: false })
      }
    } while (flowsAgain)
  })().finally(() => {
    flowsLoad = null
  })
  return flowsLoad
}

let contextLoad: Promise<void> | null = null
let contextAgain = false

async function loadContext(): Promise<void> {
  if (contextLoad) {
    contextAgain = true
    return contextLoad
  }
  contextLoad = (async () => {
    do {
      contextAgain = false
      try {
        set(context, await plugin.request('cf.context'))
        set(contextError, null)
      } catch (e) {
        set(contextError, errorText(e))
        return
      }
    } while (contextAgain)
    await loadFlows()
  })().finally(() => {
    contextLoad = null
  })
  return contextLoad
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    // The worker watches run folders and posts when one changes; the panel never polls.
    plugin.on('cf.workflows.changed', () => void loadFlows()),
    plugin.on('cf.started', () => void loadFlows()),
    // Focus moved, or a terminal opened, closed or was renamed.
    on('workspace.changed', () => void loadContext())
  )
  void loadContext()
}

// ---- actions

function editPrompt(text: string): void {
  set(prompt, text)
  update(override, (o) => nextOverride(o, text))
}

function forms(): { audit: AuditForm; code: CodeForm } {
  const o = read(options)
  const text = read(prompt)
  const dry = read(dryRun)
  return {
    audit: { scope: text, target: o.target, testTarget: o.testTarget, rounds: o.auditRounds, dryRun: dry, refreshContext: o.refreshContext },
    code: { task: text, implementer: o.implementer, rounds: o.codeRounds, dryRun: dry }
  }
}

type Plan = { ok: true; line: string } | { ok: false; error: string; quiet: boolean }

/** What Run would start, or why it cannot. Built by command.ts, exactly as the worker builds it. */
function plan(): Plan {
  const ctx = read(context)
  const repo = repoOf(currentWorkspace())
  if (!repo) return { ok: false, error: 'Pick a repository first.', quiet: false }
  if (!read(prompt).trim()) return { ok: false, error: 'Say what the council should do, then Run.', quiet: true }
  const cli = ctx?.cli.ok ? ctx.cli.path : '/path/to/council-flow/bin/council-flow.mjs'
  const f = forms()
  const built = mode() === 'audit' ? buildAudit(cli, repo, f.audit, PREVIEW_RUN_ID) : buildCode(cli, repo, f.code, PREVIEW_RUN_ID)
  return built.ok ? { ok: true, line: built.line.replace(`--run-id ${PREVIEW_RUN_ID}`, '--run-id <new run id>') } : { ok: false, error: built.error, quiet: false }
}

async function run(): Promise<void> {
  const ws = currentWorkspace()
  if (!ws || !plan().ok || read(busy)) return
  const m = mode()
  const f = forms()
  set(busy, true)
  set(notice, null)
  try {
    const res = await plugin.request('cf.start', { kind: m, workspaceId: ws.id, repo: repoOf(ws), ...(m === 'audit' ? { audit: f.audit } : { code: f.code }) })
    set(lastStart, res)
    if (res.ok) {
      set(prompt, '')
      set(override, null)
    }
  } catch (e) {
    set(lastStart, { ok: false, error: errorText(e) })
  } finally {
    set(busy, false)
  }
  await loadFlows()
}

async function doctor(): Promise<void> {
  const ws = currentWorkspace()
  if (!ws) return
  set(busy, true)
  try {
    set(lastStart, await plugin.request('cf.start', { kind: 'doctor', workspaceId: ws.id, repo: repoOf(ws) }))
  } catch (e) {
    set(lastStart, { ok: false, error: errorText(e) })
  } finally {
    set(busy, false)
  }
}

async function resumeRun(w: Workflow): Promise<void> {
  const ws = workspaceFor(w.repo)
  if (!ws) return
  set(busy, true)
  try {
    set(lastStart, await plugin.request('cf.resume', { workspaceId: ws.id, repo: w.repo, runId: w.runId }))
  } catch (e) {
    set(lastStart, { ok: false, error: errorText(e) })
  } finally {
    set(busy, false)
  }
  await loadFlows()
}

/** Shows the run's terminal. Moving focus is all it does: the answer is typed by the person. */
async function openTerminal(terminal: { id: string; title: string; workspaceName: string }): Promise<void> {
  try {
    const r = await plugin.request('cf.focus', { terminalId: terminal.id })
    if (!r.ok) set(notice, { tone: 'danger', text: r.error })
    else set(notice, r.focused ? null : { tone: 'neutral', text: `Orca did not move to "${terminal.title}": find it in ${terminal.workspaceName}.` })
  } catch (e) {
    set(notice, { tone: 'danger', text: errorText(e) })
  }
}

async function openArtifact(w: Workflow, name: 'summary.md' | 'findings.md'): Promise<void> {
  const open = read(artifact)
  if (open && open.runId === w.runId && open.result.ok && open.result.artifact.name === name) {
    set(artifact, null)
    return
  }
  try {
    set(artifact, { runId: w.runId, result: await plugin.request('cf.artifact', { repo: w.repo, runId: w.runId, name }), page: 0 })
  } catch (e) {
    set(artifact, { runId: w.runId, result: { ok: false, error: errorText(e) }, page: 0 })
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

// ---- the prompt

/** Orca's Select refuses an empty value, so "default" stands for a blank field. */
const DEFAULT = 'default'
const fromSelect = (v: string) => (v === DEFAULT ? '' : v)
const toSelect = (v: string | undefined) => (v ? v : DEFAULT)
const roundOptions = (fallback: string) => [
  { value: DEFAULT, label: `Default (${fallback})` },
  ...Array.from({ length: MAX_ROUNDS + 1 }, (_, n) => ({ value: String(n), label: String(n) }))
]

function OptionsSection(props: { mode: Mode; plan: Plan; ws: WorkspaceRow | null }) {
  const o = read(options)
  const edit = (patch: Partial<Options>) => update(options, (cur) => ({ ...cur, ...patch }))
  const target = precheckTarget(o.target)
  const testTarget = precheckTestTarget(o.testTarget)
  const summary =
    props.mode === 'audit'
      ? [o.target ? `target ${o.target}` : 'whole repository', o.auditRounds ? `${o.auditRounds} iterations` : null, o.refreshContext ? 'fresh context' : null]
      : [o.implementer ? `${o.implementer} implements` : 'default implementer', o.codeRounds ? `${o.codeRounds} fix rounds` : null]
  return (
    <Collapsible title="Options" description={summary.filter(Boolean).join(' · ')} defaultOpen={false}>
      <Stack gap="sm">
        {props.mode === 'audit' ? (
          <Stack gap="sm">
            <Input label="Target" placeholder="blank = whole repository, src/reader.js or localhost:3000" value={o.target} invalid={!target.ok} onChange={(v) => edit({ target: v })} />
            {!target.ok ? <Text tone="danger" size="xs">{target.error}</Text> : <Text muted size="xs">Local only: a path in the repository, or localhost, 127.x.x.x or [::1] with a port. No traffic is sent to it.</Text>}
            <Input label="Test target" placeholder="optional: test/ or test/reader.test.mjs" value={o.testTarget} invalid={!testTarget.ok} onChange={(v) => edit({ testTarget: v })} />
            {!testTarget.ok ? <Text tone="danger" size="xs">{testTarget.error}</Text> : null}
            <Select label="Iterations" options={roundOptions('3')} value={toSelect(o.auditRounds)} onChange={(v) => edit({ auditRounds: fromSelect(v) })} />
            <Checkbox label="Refresh context" description="Build a full new context pack" checked={o.refreshContext} onChange={(v) => edit({ refreshContext: v })} />
          </Stack>
        ) : (
          <Stack gap="sm">
            <Select
              label="Implementer"
              options={[
                { value: DEFAULT, label: 'Default (COUNCIL_IMPLEMENTER, else codex)' },
                { value: 'codex', label: 'codex' },
                { value: 'claude', label: 'claude' }
              ]}
              value={toSelect(o.implementer)}
              onChange={(v) => edit({ implementer: fromSelect(v) as Implementer })}
            />
            <Select label="Fix rounds" options={roundOptions('2')} value={toSelect(o.codeRounds)} onChange={(v) => edit({ codeRounds: fromSelect(v) })} />
          </Stack>
        )}
        <Input label="Repository folder" placeholder={props.ws?.path ?? '/path/to/repo'} value={read(repoPath)} onChange={(v) => set(repoPath, v)} onSubmit={() => loadFlows()} />
        {props.plan.ok ? (
          <Stack gap="xs">
            <Text muted size="xs">Run opens a new Orca terminal with:</Text>
            <Code block>{props.plan.line}</Code>
          </Stack>
        ) : null}
      </Stack>
    </Collapsible>
  )
}

function StartedCallout() {
  const res = read(lastStart)
  if (!res) return null
  if (!res.ok) return <Callout tone="danger" title="Not started">{res.error}</Callout>
  const gate =
    res.kind === 'audit'
      ? 'It ends at a gate in that terminal: only your exact "approve" there commits a tested fix locally.'
      : res.kind === 'code'
        ? 'It ends at a decision gate in Orca (or that terminal): only your approval commits, pushes or opens a PR.'
        : res.kind === 'resume'
          ? 'The gate is asked again there: answer it yourself.'
          : 'Doctor only checks the council members and Orca.'
  const canFocus = read(context)?.canFocus === true
  return (
    <Callout tone="success" icon="terminal" title={`Started "${res.title}"`}>
      <Stack gap="xs">
        <Text size="xs">{`New terminal in ${res.workspaceName}. ${gate} The plugin never types into it.`}</Text>
        {canFocus ? (
          <Row>
            <Button size="xs" variant="outline" icon="terminal" onPress={() => openTerminal({ id: res.terminalId, title: res.title, workspaceName: res.workspaceName })}>
              Open terminal
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  )
}

function Composer() {
  const ctx = read(context) as ContextInfo
  const ws = currentWorkspace()
  const m = mode()
  const p = plan()
  const blocked = !ctx.cli.ok || !ctx.canStart
  const dry = read(dryRun)
  return (
    <Stack gap="sm">
      <Textarea label="What should the council do?" placeholder={`e.g. ${EXAMPLE_PROMPT}`} rows={3} value={read(prompt)} onChange={editPrompt} onSubmit={() => void run()} />
      <Row gap="sm" wrap align="center" justify="between">
        <RadioGroup
          label="Mode"
          labelHidden
          orientation="horizontal"
          value={m}
          options={[
            { value: 'audit', label: 'Audit' },
            { value: 'code', label: 'Code' }
          ]}
          onChange={(v) => set(override, pick(read(prompt), v as Mode))}
        />
        <Switch label="Dry run" checked={dry} onChange={(v) => set(dryRun, v)} />
      </Row>
      <Text size="xs" muted>
        {`${read(override) ? 'Your pick' : read(prompt).trim() ? 'Picked from your prompt' : 'Audit until the prompt says otherwise'}: ${m === 'audit' ? 'audit reviews and hardens code locally' : 'code plans, implements and reviews a change'}.`}
      </Text>
      <Row gap="sm" wrap align="end">
        <Box grow>
          <Select
            label="Repo"
            value={ws?.id ?? ''}
            options={ctx.workspaces.map((w) => ({
              value: w.id,
              label: w.usable ? `${w.name}${w.branch ? ` (${w.branch})` : ''}` : `${w.name}: ${w.reason ?? 'unavailable'}`,
              disabled: !w.usable
            }))}
            onChange={(v) => {
              set(picked, v)
              set(repoPath, '')
              set(artifact, null)
              void loadFlows()
            }}
          />
        </Box>
        <Button tone="accent" icon="play" disabled={!p.ok || blocked || read(busy)} onPress={run}>
          Run
        </Button>
      </Row>
      {!p.ok ? (
        <Text size="xs" tone={p.quiet ? undefined : 'danger'} muted={p.quiet}>{p.error}</Text>
      ) : (
        <Text size="xs" tone={dry ? undefined : 'warning'} muted={dry}>
          {dry ? 'Dry run: fake models and a fake gate that says no. No tokens are spent.' : 'Real run: the council members are called and tokens are spent.'}
        </Text>
      )}
      {blocked ? (
        <Callout tone="danger" title={ctx.cli.ok ? 'This Orca cannot open terminals for plugins' : 'council-flow not found'}>
          <Stack gap="xs">
            <Text size="xs">{ctx.cli.ok ? 'Run needs Orca host API 1.3 or newer.' : ctx.cli.error}</Text>
            <Row>
              <Button size="xs" variant="outline" icon="settings" onPress={() => set(view, 'setup')}>
                Open setup
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      <OptionsSection mode={m} plan={p} ws={ws} />
      <StartedCallout />
    </Stack>
  )
}

// ---- the Workflows list

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
    <Box border radius="sm" padding="sm" background="muted">
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
        <Text muted size="xs" truncate>{path}</Text>
      </Stack>
    </Box>
  )
}

function stepTone(s: Step, waiting: boolean): 'success' | 'accent' | 'warning' | 'danger' | undefined {
  if (s.state === 'done') return 'success'
  if (s.state === 'current') return waiting ? 'warning' : 'accent'
  if (s.state === 'failed') return 'danger'
  return undefined
}

function StageTrail(props: { w: Workflow }) {
  const p = props.w.progress
  if (!p.steps.length) return p.stage ? <Text size="xs" muted>{p.stage}</Text> : null
  const waiting = p.phase === 'waiting-approve'
  const parts = p.steps.flatMap((s, i) => [
    ...(i ? [<Text key={`arrow-${i}`} size="xs" muted>→</Text>] : []),
    <Text key={`step-${i}`} size="xs" tone={stepTone(s, waiting)} muted={s.state === 'next'} weight={s.state === 'current' || s.state === 'failed' ? 'semibold' : 'regular'}>
      {s.label}
    </Text>
  ])
  return (
    <Row gap="xs" wrap align="center">
      {parts}
    </Row>
  )
}

function Elapsed(props: { w: Workflow }) {
  const w = props.w
  const p = w.progress
  if (p.phase === 'waiting-approve' && p.stageStartedAt) {
    return (
      <Text size="xs" tone="warning">
        {'waiting '}
        <RelativeTime at={p.stageStartedAt} format="duration" tone="warning" />
      </Text>
    )
  }
  if (LIVE.has(p.phase)) {
    const since = w.since ?? p.stageStartedAt ?? w.createdAt
    return since ? (
      <Text size="xs" muted>
        {'for '}
        <RelativeTime at={since} format="duration" muted />
      </Text>
    ) : null
  }
  if (!w.updatedAt) return null
  const took = w.createdAt && w.updatedAt > w.createdAt ? `took ${formatDuration(w.updatedAt - w.createdAt)} · ` : ''
  return (
    <Text size="xs" muted>
      {took}
      <RelativeTime at={w.updatedAt} format="short" muted />
    </Text>
  )
}

function WaitingCallout(props: { w: Workflow }) {
  const w = props.w
  const canFocus = read(context)?.canFocus === true
  const t = w.terminal
  const how =
    w.mode === 'audit'
      ? 'Read the summary, then type approve in the run\'s terminal yourself to commit the tested fix on its local council branch. Any other answer declines.'
      : 'Answer the gate yourself: resolve Orca\'s decision gate, or answer in the run\'s terminal if it asks there. Nothing is pushed without you.'
  return (
    <Callout tone="warning" icon="bell" title="Waiting for your approve">
      <Stack gap="xs">
        <Text size="sm">{how}</Text>
        <Text size="xs" muted>The plugin never answers the gate.</Text>
        {t ? (
          <Row>
            <Button tone="warning" icon="terminal" disabled={!canFocus || t.alive === false} tooltip={!canFocus ? 'Needs the workspace:write grant: see Setup' : undefined} onPress={() => openTerminal(t)}>
              Jump to terminal
            </Button>
          </Row>
        ) : (
          <Text size="xs" muted>Started outside the plugin: find its terminal yourself.</Text>
        )}
      </Stack>
    </Callout>
  )
}

function WorkflowCard(props: { w: Workflow }) {
  const w = props.w
  const p = w.progress
  const waiting = p.phase === 'waiting-approve'
  const canFocus = read(context)?.canFocus === true
  const a = read(artifact)
  const facts = [p.round, findingsText(w.mode, p), p.outcome].filter(Boolean).join(' · ')
  const t = w.terminal
  return (
    <Box border={waiting ? 'warning' : true} radius="md" padding="sm">
      <Stack gap="xs">
        <Row justify="between" align="center" wrap>
          <Row gap="xs" align="center" wrap>
            <Badge tone={p.tone}>{p.label}</Badge>
            <Badge>{w.mode === 'unknown' ? 'run' : w.mode}</Badge>
            {w.dryRun ? <Badge>dry run</Badge> : null}
          </Row>
          <Elapsed w={w} />
        </Row>
        <Text weight="semibold">{w.title || w.runId}</Text>
        <Text size="xs" muted truncate>{`${w.repoName} · ${w.runId}${w.target && w.target !== '.' ? ` · ${w.target}` : ''}`}</Text>
        <StageTrail w={w} />
        {facts ? <Text size="xs">{facts}</Text> : null}
        {waiting ? <WaitingCallout w={w} /> : null}
        <Row gap="xs" wrap>
          {t && !waiting && t.alive !== false ? (
            <Button size="xs" variant="outline" icon="terminal" disabled={!canFocus} tooltip={!canFocus ? 'Needs the workspace:write grant: see Setup' : undefined} onPress={() => openTerminal(t)}>
              Open terminal
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" icon="file-text" disabled={!w.files.summary} onPress={() => openArtifact(w, 'summary.md')}>
            Summary
          </Button>
          <Button size="xs" variant="ghost" icon="bug" disabled={!w.files.findings} onPress={() => openArtifact(w, 'findings.md')}>
            Findings
          </Button>
          {w.resumable ? (
            <Button size="xs" variant="outline" icon="play" disabled={read(busy) || !read(context)?.cli.ok} onPress={() => resumeRun(w)}>
              {w.dryRun ? 'Resume (dry run)' : 'Resume'}
            </Button>
          ) : null}
        </Row>
        {a && a.runId === w.runId ? <ArtifactView /> : null}
      </Stack>
    </Box>
  )
}

function FirstRun() {
  return (
    <EmptyState icon="bot" title="No workflows yet" description="A council of models (Claude, Codex and Kimi) plans, reviews and fixes code on this machine, then stops at a gate only you can answer.">
      <Stack gap="xs" align="center">
        <Text size="xs" muted>Audits are local-only: they read your repository and never send traffic to a target. Dry run is on until you turn it off.</Text>
        <Button size="sm" variant="outline" icon="lightbulb" onPress={() => editPrompt(EXAMPLE_PROMPT)}>
          {`Try: ${EXAMPLE_PROMPT}`}
        </Button>
      </Stack>
    </EmptyState>
  )
}

function Workflows() {
  const data = read(flows)
  const list = data?.workflows ?? []
  const n = read(notice)
  const live = list.filter((w) => LIVE.has(w.progress.phase)).length
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={3}>Workflows</Heading>
        {data ? <Text size="xs" muted>{live ? `${live} live` : list.length ? `${list.length} recent` : ''}</Text> : <Spinner label="Loading workflows" labelHidden />}
      </Row>
      {n ? <Callout tone={n.tone}>{n.text}</Callout> : null}
      {(data?.errors ?? []).map((e) => (
        <Callout key={`error-${e.repo}`} tone="danger" title="Cannot read runs">{`${e.repo}: ${e.error}`}</Callout>
      ))}
      {data && !list.length ? <FirstRun /> : null}
      {list.map((w) => (
        <WorkflowCard key={`${w.repo}:${w.runId}`} w={w} />
      ))}
      {data?.truncated ? <Text size="xs" muted>Older runs stay in each repository's .council-flow folder.</Text> : null}
    </Stack>
  )
}

// ---- setup, behind the gear

function SetupPage() {
  const ctx = read(context)
  if (!ctx) return null
  const cli = ctx.cli
  const ws = currentWorkspace()
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={3}>Setup</Heading>
        <Button size="sm" variant="ghost" icon="close" onPress={() => set(view, 'home')}>
          Done
        </Button>
      </Row>
      <Stack gap="xs">
        <Text weight="semibold">council-flow</Text>
        {cli.ok ? <Text size="xs" muted>{`${cli.version ?? ''} (${cli.source === 'bundled' ? 'the checkout this plugin was loaded from' : 'the folder you set'})`}</Text> : null}
        {cli.ok ? <Code>{cli.path}</Code> : <Callout tone="danger">{cli.error}</Callout>}
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
        </Row>
      </Stack>
      <Stack gap="xs">
        <Text weight="semibold">Health</Text>
        <Text size="xs" muted>Doctor checks the council members (claude, codex, fx) and Orca without any model call, in a new terminal.</Text>
        <Row>
          <Button size="sm" variant="outline" icon="wrench" disabled={!cli.ok || !ctx.canStart || !ws || read(busy)} onPress={doctor}>
            Run doctor
          </Button>
        </Row>
        <StartedCallout />
        {!ctx.canStart ? <Callout tone="danger">This Orca cannot open terminals for plugins (needs host API 1.3).</Callout> : null}
        {!ctx.canFocus ? (
          <Callout tone="warning" title="Jump to terminal is off">
            Showing a run's terminal needs the workspace:write grant (host API 1.7). Re-approve the plugin in Orca to turn it on; until then, find the terminal by its title.
          </Callout>
        ) : null}
        <Text size="xs" muted>Runs use node from the terminal's PATH. LYBER_API_KEY stays in your shell: the plugin never reads it.</Text>
      </Stack>
    </Stack>
  )
}

export default function Panel() {
  const ctx = read(context)
  const err = read(contextError)
  const setupOpen = read(view) === 'setup'
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Council Flow</Heading>
        <Row gap="xs">
          <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={loadContext} />
          <IconButton icon="settings" label="Setup and doctor" variant={setupOpen ? 'solid' : 'ghost'} onPress={() => set(view, setupOpen ? 'home' : 'setup')} />
        </Row>
      </Row>
      {err ? <Callout tone="danger" title="Orca did not answer">{err}</Callout> : null}
      {!ctx ? (
        err ? null : <Spinner label="Loading workspaces" />
      ) : setupOpen ? (
        <SetupPage />
      ) : !ctx.workspaces.some((w) => w.usable) ? (
        <EmptyState icon="folder" title="No Git workspace" description="Open a local Git checkout as an Orca workspace: council-flow runs against a repository on this host." />
      ) : (
        <Stack gap="md">
          <Composer />
          <Workflows />
        </Stack>
      )}
    </Stack>
  )
}

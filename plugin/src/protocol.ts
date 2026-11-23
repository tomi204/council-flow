// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Type-only imports: nothing here runs, so the panel never pulls in the worker's Node code.
import type { AuditForm, CodeForm, Mode } from './command'
import type { CliInfo } from './cli'
import type { Progress } from './progress'
import type { Artifact, RunRow, RunsResult } from './runs'

export type { AuditForm, CodeForm, CliInfo, Artifact, RunRow, RunsResult, Progress }

/** An Orca workspace as the panel offers it. Only local Git checkouts are usable. */
export type WorkspaceRow = {
  id: string
  name: string
  project: string | null
  path: string
  branch: string | null
  hostId: string | null
  usable: boolean
  reason: string | null
}

export type ContextInfo = {
  workspaces: WorkspaceRow[]
  /** The focused workspace, when it is one of `workspaces`. */
  focusedId: string | null
  cli: CliInfo
  /** False when this Orca cannot open terminals for plugins (host API older than 1.3). */
  canStart: boolean
  /** True when the plugin may focus a terminal it opened (`terminal.focus`, `workspace:write`). */
  canFocus: boolean
}

export type StartKind = 'audit' | 'code' | 'doctor'

/** What the plugin started: one new Orca terminal running one council-flow command. */
export type StartedRecord = {
  kind: StartKind | 'resume'
  runId: string | null
  repo: string
  workspaceId: string
  workspaceName: string
  terminalId: string
  title: string
  line: string
  at: number
  /** First line of the prompt, scrubbed, so a card can name a run before council-flow wrote it. */
  prompt?: string
}

/** One run as a card in the Workflows list. */
export type Workflow = {
  runId: string
  repo: string
  /** The repository folder's name, for the card. */
  repoName: string
  mode: Mode | 'unknown'
  /** First line of the prompt (task or audit scope), scrubbed. */
  title: string
  dryRun: boolean
  target: string | null
  createdAt: number | null
  updatedAt: number | null
  /** When the live council-flow process took the run, ms; null when none runs it. */
  since: number | null
  progress: Progress
  files: RunRow['files']
  resumable: boolean
  /** The Orca terminal the plugin opened for it, when it did; `alive` is null when Orca cannot tell. */
  terminal: { id: string; title: string; workspaceName: string; alive: boolean | null } | null
}

export type WorkflowsAnswer = {
  /** The repositories read, the asked one first. */
  repos: string[]
  workflows: Workflow[]
  errors: { repo: string; error: string }[]
  /** More finished runs exist than were listed. */
  truncated: boolean
}

export type StartResult = ({ ok: true } & StartedRecord) | { ok: false; error: string }
export type ArtifactResult = { ok: true; artifact: Artifact } | { ok: false; error: string }
export type FocusResult = { ok: true; focused: boolean } | { ok: false; error: string }

declare module 'orca' {
  interface PluginRequests {
    /** Workspaces, the focused one and which council-flow will run. */
    'cf.context': { output: ContextInfo }
    /** Workflow cards: runs of `repo`, plus runs this plugin started in other repositories. */
    'cf.workflows': { input: { repo: string }; output: WorkflowsAnswer }
    /** summary.md, findings.md or run.json of one run, scrubbed. */
    'cf.artifact': { input: { repo: string; runId: string; name: string }; output: ArtifactResult }
    /** Opens a terminal in the workspace running council-flow audit, a coding run or doctor. */
    'cf.start': {
      input: { kind: StartKind; workspaceId: string; repo: string; audit?: AuditForm; code?: CodeForm }
      output: StartResult
    }
    /** Opens a terminal resuming a run with its own subcommand and dry-run setting. */
    'cf.resume': {
      input: { workspaceId: string; repo: string; runId: string; refreshContext?: boolean }
      output: StartResult
    }
    /** Shows and focuses a terminal this plugin opened. Never types into it. */
    'cf.focus': { input: { terminalId: string }; output: FocusResult }
    /** Saves (or clears, with null) the council-flow checkout to run. */
    'cf.setCli': { input: { path: string | null }; output: CliInfo }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after a terminal was opened. */
    'cf.started': StartedRecord
    /** A watched run folder changed on disk (debounced): ask for `cf.workflows` again. */
    'cf.workflows.changed': { repos: string[] }
  }
}

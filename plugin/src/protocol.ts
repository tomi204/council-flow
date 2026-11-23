// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Type-only imports: nothing here runs, so the panel never pulls in the worker's Node code.
import type { AuditForm, CodeForm } from './command'
import type { CliInfo } from './cli'
import type { Artifact, RunRow, RunsResult } from './runs'

export type { AuditForm, CodeForm, CliInfo, Artifact, RunRow, RunsResult }

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
}

export type StartResult = ({ ok: true } & StartedRecord) | { ok: false; error: string }
export type ArtifactResult = { ok: true; artifact: Artifact } | { ok: false; error: string }
export type RunsAnswer = RunsResult & { started: StartedRecord[] }

declare module 'orca' {
  interface PluginRequests {
    /** Workspaces, the focused one and which council-flow will run. */
    'cf.context': { output: ContextInfo }
    /** Runs under <repo>/.council-flow, plus the ones this plugin started there. */
    'cf.runs': { input: { repo: string }; output: RunsAnswer }
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
    /** Saves (or clears, with null) the council-flow checkout to run. */
    'cf.setCli': { input: { path: string | null }; output: CliInfo }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after a terminal was opened. */
    'cf.started': StartedRecord
  }
}

// cli.ts: which council-flow the plugin runs.
//
// The plugin never reimplements the pipeline: it runs `node <checkout>/bin/council-flow.mjs`.
// That is the path saved in the panel's Setup section, or else the council-flow checkout this
// plugin was loaded from (the plugin lives in the same repository, so a dev load of
// ~/council-flow or an install of tomi204/council-flow carries its own CLI). A candidate counts
// only when its package.json says it is council-flow.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAbsolutePath } from './command'

export type CliInfo =
  | { ok: true; path: string; version: string | null; source: 'configured' | 'bundled' }
  | { ok: false; error: string; configured: string | null }

export const BIN = path.join('bin', 'council-flow.mjs')

/** Accepts a checkout folder or its bin/council-flow.mjs; answers the bin path and version. */
export function inspectCli(raw: unknown): { ok: true; path: string; version: string | null } | { ok: false; error: string } {
  let given: string
  try {
    given = checkAbsolutePath(raw, 'council-flow path')
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  let bin = given
  try {
    if (fs.statSync(given).isDirectory()) bin = path.join(given, BIN)
  } catch {
    return { ok: false, error: `nothing at ${given} on this Orca host` }
  }
  try {
    if (!fs.statSync(bin).isFile()) return { ok: false, error: `${bin} is not a file` }
  } catch {
    return { ok: false, error: `no ${BIN} in ${given}` }
  }
  if (path.basename(bin) !== 'council-flow.mjs') return { ok: false, error: 'point at a council-flow checkout or its bin/council-flow.mjs' }
  const root = path.dirname(path.dirname(bin))
  let pkg: { name?: unknown; version?: unknown }
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return { ok: false, error: `no readable package.json in ${root}` }
  }
  if (pkg.name !== 'council-flow') return { ok: false, error: `${root} is not a council-flow checkout` }
  return { ok: true, path: bin, version: typeof pkg.version === 'string' ? pkg.version : null }
}

/** The checkout this module was loaded from (<root>/plugin/src/cli.ts), if Orca loaded it in place. */
export function bundledRoot(moduleUrl: string): string | null {
  try {
    if (!moduleUrl.startsWith('file:')) return null
    return path.dirname(path.dirname(path.dirname(fileURLToPath(moduleUrl))))
  } catch {
    return null
  }
}

export function resolveCli(configured: string | null, moduleUrl: string = import.meta.url): CliInfo {
  if (configured) {
    const c = inspectCli(configured)
    return c.ok ? { ...c, source: 'configured' } : { ok: false, error: c.error, configured }
  }
  const root = bundledRoot(moduleUrl)
  const b = root ? inspectCli(root) : null
  if (b && b.ok) return { ...b, source: 'bundled' }
  return { ok: false, error: 'council-flow not found next to the plugin: set its checkout folder under Setup', configured: null }
}

// The few Node built-ins the worker and the tests use. Orca's typings have no Node types and the
// plugin ships no node_modules, so `npx tsc -p .` checks against these declarations instead.
// Only what is used here is declared; the real modules come from the Node that runs the worker.

declare module 'node:fs' {
  export interface Stats {
    size: number
    mtimeMs: number
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
  }
  export function lstatSync(path: string): Stats
  export function statSync(path: string): Stats
  export function existsSync(path: string): boolean
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function realpathSync(path: string): string
  export function openSync(path: string, flags: string): number
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number
  export function closeSync(fd: number): void
  export interface FSWatcher {
    close(): void
    on(event: 'error', listener: (error: Error) => void): this
    unref(): this
  }
  export function watch(path: string, listener: (event: string, filename: string | null) => void): FSWatcher
  // tests
  export function mkdtempSync(prefix: string): string
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function writeFileSync(path: string, data: string | Uint8Array): void
  export function symlinkSync(target: string, path: string): void
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
}

declare module 'node:path' {
  export const sep: string
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string): string
  export function relative(from: string, to: string): string
  export function isAbsolute(path: string): boolean
}

declare module 'node:os' {
  export function hostname(): string
  export function tmpdir(): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module 'node:child_process' {
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: { encoding?: 'utf8'; input?: string; env?: Record<string, string | undefined>; timeout?: number }
  ): { status: number | null; stdout: string; stderr: string }
}

declare const process: {
  readonly pid: number
  kill(pid: number, signal: number): true
}

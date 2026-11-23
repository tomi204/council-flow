import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'

export const auditGit = new AsyncLocalStorage()
const guard = fileURLToPath(new URL('./isolation.py', import.meta.url))
export function offlineCommand(kind, exe, args) {
  return { exe: '/usr/bin/python3', args: ['-I', guard, kind, exe, ...args] }
}

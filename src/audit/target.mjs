import fs from 'node:fs'
import path from 'node:path'
import { isIPv4 } from 'node:net'
import { assertNoSymlinks } from '../artifacts.mjs'

// Match the raw authority. URL parsers canonicalize integer, octal and hex hosts before validation.
export function validateTarget(root, raw = '.') {
  if (typeof raw !== 'string' || !raw || /[\x00-\x1f\\]/.test(raw) || raw !== raw.trim() || raw.startsWith('//')) throw new Error('invalid audit target')
  if (raw.includes(':')) {
    const match = /^(?:(https?):\/\/)?(localhost|127(?:\.\d{1,3}){3}|\[::1\]):(\d{1,5})\/?$/i.exec(raw)
    if (!match || (+match[3] < 1 || +match[3] > 65535) || (match[2].startsWith('127') && !isIPv4(match[2]))) throw new Error('audit requires a loopback host and an explicit port')
    const host = match[2].toLowerCase().replace(/^\[|\]$/g, '')
    return { kind: 'loopback', host, port: Number(match[3]), scheme: match[1]?.toLowerCase() || null }
  }
  if (/^(?:localhost|\d[\d.]*|0x[\da-f]+|(?:\d+\.){4}.+)$/i.test(raw)) throw new Error('audit requires a loopback host with port')
  if (raw.split('/').some(part => ['..', '.git', '.council-flow'].includes(part))) throw new Error('invalid audit repository path')
  const file = path.resolve(root, raw)
  assertNoSymlinks(root, file)
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file))
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || !(fs.statSync(file).isFile() || fs.statSync(file).isDirectory())) throw new Error('audit target is outside repository or not a regular path')
  return { kind: 'path', path: rel || '.' }
}

// An owner may reserve one new regression file. Its parent must already be a
// contained real directory. A new file does not grant a whole subtree.
export function validateTestTarget(root, raw) {
  let target
  try { target = validateTarget(root, raw) } catch (e) {
    if (e.code !== 'ENOENT' || raw.endsWith('/')) throw e
    const parent = validateTarget(root, path.dirname(raw))
    if (parent.kind !== 'path' || !fs.statSync(path.join(root, parent.path)).isDirectory()) throw new Error('invalid test parent')
    return { kind: 'path', path: path.join(parent.path, path.basename(raw)), directory: false }
  }
  if (target.kind !== 'path') throw new Error('test target must be a repository path')
  return { ...target, directory: fs.statSync(path.join(root, target.path)).isDirectory() }
}

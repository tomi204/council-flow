// prompts.mjs: prompts/*.md templates with {{name}} placeholders.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export function render(name, vars = {}) {
  const tpl = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8')
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (vars[k] == null ? '' : String(vars[k]))).trim() + '\n'
}

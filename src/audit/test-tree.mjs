import fs from 'node:fs'
import path from 'node:path'
import { assertNoSymlinks } from '../artifacts.mjs'
import { envFor } from '../env.mjs'
import { git } from '../repo.mjs'

// Discover installs beside tracked package manifests, including workspace packages.
export async function installedPackageDirs(ctx, wt, tree) {
  const listing = await git(['ls-tree', '-r', '-z', tree], wt.path)
  if (listing.stdoutTruncated) throw new Error('incomplete package directory listing')
  const trackedModules = new Set()
  const packages = []
  for (const entry of listing.stdout.split('\0')) {
    const file = entry.slice(entry.indexOf('\t') + 1)
    const parts = file.split('/')
    const index = parts.indexOf('node_modules')
    if (index >= 0) trackedModules.add(parts.slice(0, index + 1).join('/'))
    else if (path.basename(file) === 'package.json' && /^100(?:644|755) blob /.test(entry)) packages.push(path.dirname(file))
  }
  return packages.map(dir => path.join(dir, 'node_modules')).filter(modules => {
    if (trackedModules.has(modules)) return false
    const source = path.join(ctx.repoRoot, modules)
    assertNoSymlinks(ctx.repoRoot, source)
    return fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()
  })
}

// Git supplies every tracked file. Copy the local test inputs without following
// links or replacing anything from the candidate tree.
export async function prepareTestTree(ctx, wt, tree, cwd, installedModules) {
  const indexEnv = envFor('git', ctx.env, { set: { GIT_INDEX_FILE: cwd + '.index' } })
  await git(['read-tree', tree], wt.path, { env: indexEnv })
  await git(['checkout-index', '--all', '--prefix=' + cwd + path.sep], wt.path, { env: indexEnv })
  for (const modules of installedModules) {
    await fs.promises.cp(path.join(ctx.repoRoot, modules), path.join(cwd, modules), {
      recursive: true, dereference: false, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
      force: false, errorOnExist: true
    })
  }
}

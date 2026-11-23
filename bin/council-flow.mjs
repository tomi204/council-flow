#!/usr/bin/env node
import { main, shout } from '../src/cli.mjs'

main().then((code) => { process.exitCode = code }, (e) => { shout(`${e && e.stack || e}\n`); process.exitCode = 2 })

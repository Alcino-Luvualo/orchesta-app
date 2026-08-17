#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const canonical = path.join(repositoryRoot, 'skills', 'orchestra-canvas', 'SKILL.md')
const generatedTargets = [
  path.join(repositoryRoot, '.agents', 'plugins', 'plugins', 'orchestra', 'skills', 'orchestra-canvas', 'SKILL.md')
]
const checkOnly = process.argv.includes('--check')

if (!fs.existsSync(canonical)) {
  throw new Error(`Canonical Orchestra skill is missing: ${canonical}`)
}

const contents = fs.readFileSync(canonical)
const drifted = []
for (const target of generatedTargets) {
  if (checkOnly) {
    if (!fs.existsSync(target) || !contents.equals(fs.readFileSync(target))) drifted.push(target)
    continue
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

if (checkOnly && drifted.length > 0) {
  throw new Error(`Generated Orchestra skill copies drift from the canonical source:\n${drifted.join('\n')}`)
}

console.log(`${checkOnly ? 'checked' : 'synced'} Orchestra skill (${generatedTargets.length} generated copy)`)

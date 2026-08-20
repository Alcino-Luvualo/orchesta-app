#!/usr/bin/env node

// Fast, deterministic contract tests for the resources that are copied into
// an Electron package. The verifier itself remains the production gate; this
// test makes manifest and builder-path regressions visible in CI as a normal
// assertion failure instead of relying on a manual package inspection.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const verifyScript = path.join(repositoryRoot, 'scripts/verify-package-resources.mjs')
const verify = spawnSync(process.execPath, [verifyScript], {
  cwd: repositoryRoot,
  encoding: 'utf8'
})
assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`)

const builder = fs.readFileSync(path.join(repositoryRoot, 'apps/desktop/electron-builder.yml'), 'utf8')
for (const [from, to] of [
  ['resources/computer-use-linux.py', 'computer-use-linux.py'],
  ['../../target/release/orchestra-core', 'bin/orchestra-core'],
  ['../../target/release/orchestra', 'bin/orchestra'],
  ['../../skills/orchestra-canvas', 'skills/orchestra-canvas'],
  ['../../.agents/plugins/plugins/orchestra', 'plugins/orchestra'],
  ['../../.agents/plugins/marketplace.json', 'plugins/marketplace.json']
]) {
  const escapedFrom = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedTo = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(builder, new RegExp(`from:\\s*${escapedFrom}\\s*[\\r\\n]+\\s*to:\\s*${escapedTo}`))
}

const pluginPath = path.join(repositoryRoot, '.agents/plugins/plugins/orchestra/.codex-plugin/plugin.json')
const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'))
assert.equal(plugin.name, 'orchestra')
assert.equal(plugin.skills, './skills/')
assert.match(plugin.version, /^\d+\.\d+\.\d+(?:[-+].*)?$/)
assert.ok(fs.existsSync(path.join(path.dirname(pluginPath), '..', 'skills/orchestra-canvas/SKILL.md')))

const marketplace = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '.agents/plugins/marketplace.json'), 'utf8'))
const entry = marketplace.plugins.find((candidate) => candidate?.name === 'orchestra')
assert.deepEqual(entry?.source, { source: 'local', path: './plugins/orchestra' })
assert.equal(entry?.policy?.installation, 'AVAILABLE')
assert.equal(entry?.policy?.authentication, 'ON_INSTALL')
assert.equal(entry?.category, 'Developer Tools')

console.log('Package resource and plugin manifest tests passed')

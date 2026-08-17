#!/usr/bin/env node

/**
 * Verify the complete sidecar/resource contract before electron-builder runs.
 * Keeping this check in source control prevents a package from containing a
 * core binary without its CLI, or a CLI without the skill/plugin it bootstraps.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const requiredFiles = [
  'target/release/orchestra-core',
  'target/release/orchestra',
  'skills/orchestra-canvas/SKILL.md',
  '.agents/plugins/plugins/orchestra/.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json'
]

// These are the exact resource destinations used by the daemon's packaged
// resolver (ORCHESTRA_RESOURCES_DIR). Keep this contract next to the source
// checks so changing an electron-builder path cannot silently produce an app
// whose terminal starts without its skill/plugin context.
const packagedResourceMappings = [
  ['../../target/release/orchestra-core', 'bin/orchestra-core'],
  ['../../target/release/orchestra', 'bin/orchestra'],
  ['../../skills/orchestra-canvas', 'skills/orchestra-canvas'],
  ['../../.agents/plugins/plugins/orchestra', 'plugins/orchestra'],
  ['../../.agents/plugins/marketplace.json', 'plugins/marketplace.json']
]

const failures = []
for (const relativePath of requiredFiles) {
  const absolutePath = path.join(repositoryRoot, relativePath)
  try {
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile() || stat.size === 0) failures.push(`${relativePath} is empty or not a file`)
  } catch {
    failures.push(`${relativePath} is missing`)
  }
}

const canonicalSkill = path.join(repositoryRoot, 'skills/orchestra-canvas/SKILL.md')
const generatedSkill = path.join(repositoryRoot, '.agents/plugins/plugins/orchestra/skills/orchestra-canvas/SKILL.md')
try {
  if (!fs.readFileSync(canonicalSkill).equals(fs.readFileSync(generatedSkill))) {
    failures.push('generated Orchestra skill copy is out of sync (run npm run skill:sync)')
  }
} catch {
  // Missing files are already reported above; avoid duplicating the message.
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'))
  } catch (error) {
    failures.push(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function hasBuilderResourceMapping(builderContents, from, to) {
  // electron-builder accepts either a scalar entry or an object entry. The
  // object form is intentionally required here because every resource has a
  // stable destination in the packaged app.
  const escapedFrom = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedTo = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`from:\\s*${escapedFrom}\\s*[\\r\\n]+\\s*to:\\s*${escapedTo}`).test(builderContents)
}

const builderConfigPath = path.join(repositoryRoot, 'apps/desktop/electron-builder.yml')
try {
  const builderContents = fs.readFileSync(builderConfigPath, 'utf8')
  for (const [from, to] of packagedResourceMappings) {
    if (!hasBuilderResourceMapping(builderContents, from, to)) {
      failures.push(`electron-builder.yml is missing resource mapping ${from} -> ${to}`)
    }
  }
} catch (error) {
  failures.push(`apps/desktop/electron-builder.yml is not readable: ${error instanceof Error ? error.message : String(error)}`)
}

const pluginManifest = readJson('.agents/plugins/plugins/orchestra/.codex-plugin/plugin.json')
if (pluginManifest && (pluginManifest.name !== 'orchestra' || pluginManifest.skills !== './skills/')) {
  failures.push('plugin manifest must describe the local orchestra plugin and ./skills/ entrypoint')
}

const marketplace = readJson('.agents/plugins/marketplace.json')
const marketplacePlugin = marketplace?.plugins?.find((entry) => entry?.name === 'orchestra')
if (!marketplacePlugin || marketplacePlugin.source?.source !== 'local' || marketplacePlugin.source?.path !== './plugins/orchestra') {
  failures.push('marketplace must expose the local ./plugins/orchestra plugin')
}

for (const relativePath of ['target/release/orchestra-core', 'target/release/orchestra']) {
  try {
    if ((fs.statSync(path.join(repositoryRoot, relativePath)).mode & 0o111) === 0) {
      failures.push(`${relativePath} is not executable`)
    }
  } catch {
    // Already reported as missing above.
  }
}

if (failures.length) {
  console.error('Package resource verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Package resources verified (${requiredFiles.length} required files; skill/plugin/marketplace in sync)`)
}

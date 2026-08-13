const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function firstExecutable(candidates) {
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile() } catch { return false }
  })
}

const requested = process.env.ORCHESTRA_SHELL
const shells = [...new Set([
  requested,
  firstExecutable(['/usr/bin/zsh', '/bin/zsh']),
  firstExecutable(['/usr/bin/bash', '/bin/bash'])
].filter(Boolean))]

if (!shells.length) throw new Error('Phase J requires at least one supported shell (zsh or bash)')

for (const shell of shells) {
  console.log(`\n[terminal-v2-gate] running PTY regression with ${shell}`)
  const result = spawnSync(process.execPath, [path.join(__dirname, 'e2e.js')], {
    stdio: 'inherit',
    env: { ...process.env, ORCHESTRA_SHELL: shell }
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

console.log(JSON.stringify({ ok: true, suite: 'terminal-v2-e2e', shells }))

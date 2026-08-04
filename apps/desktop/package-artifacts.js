const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const releaseDir = path.join(__dirname, 'release')
const artifacts = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).filter((name) => /\.(deb|AppImage)$/i.test(name)).sort()
  : []

if (artifacts.length === 0) throw new Error('No desktop package artifacts found')

for (const name of artifacts) {
  const filePath = path.join(releaseDir, name)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  fs.writeFileSync(`${filePath}.sha256`, `${hash}  ${name}\n`)
}

console.log(`checksums written for ${artifacts.length} artifact(s)`)

// Regenerates the PWA icons and favicon into public/ from the team seal (never redrawn).
// The maskable icon sits the seal on the `ground` token inside the 80% safe zone.
import { readFileSync } from 'node:fs'
import sharp from 'sharp'

const tokens = JSON.parse(readFileSync('src/design/tokens.json', 'utf8'))
const ground = tokens.color.tokens.find((t) => t.name === 'ground').value
const patch = 'src/assets/logos/odz-logo-patch.png'

const plain = (size) => sharp(patch).resize(size, size)

await plain(192).png().toFile('public/pwa-192x192.png')
await plain(512).png().toFile('public/pwa-512x512.png')
await plain(64).png().toFile('public/favicon.png')

const inner = Math.round(512 * 0.7)
const seal = await plain(inner).png().toBuffer()
await sharp({ create: { width: 512, height: 512, channels: 4, background: ground } })
  .composite([{ input: seal, gravity: 'center' }])
  .png()
  .toFile('public/maskable-icon-512x512.png')

import sharp from 'sharp'
const svg = (size, pad) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0b0f0c"/><g transform="translate(256 256) scale(${pad}) translate(-256 -256)"><text x="256" y="320" font-family="monospace" font-size="190" font-weight="700" text-anchor="middle" fill="#7fb069">ODZ</text></g></svg>`)
const out = [['pwa-192x192.png', 192, 1], ['pwa-512x512.png', 512, 1], ['maskable-icon-512x512.png', 512, 0.7]]
for (const [name, size, pad] of out) await sharp(svg(size, pad)).png().toFile(`public/${name}`)

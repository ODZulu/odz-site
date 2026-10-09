import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Manifest colours come from the design tokens (ground), not a hard-coded hex.
const tokens = JSON.parse(readFileSync('./src/design/tokens.json', 'utf8'))
const ground: string = tokens.color.tokens.find((t: { name: string }) => t.name === 'ground').value

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      workbox: {
        // Cache fonts and images so the app works offline at a field site.
        globPatterns: ['**/*.{js,css,html,woff2,png}'],
      },
      manifest: {
        name: 'ODZ',
        short_name: 'ODZ',
        description: 'ODZ team platform',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: ground,
        theme_color: ground,
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
})

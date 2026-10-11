// Prints a new VAPID key pair to the terminal. Writes nothing to disk.
// Run it in a normal terminal outside Claude Code, once per Supabase project (dev and prod each get
// their own pair). The private key goes only into that project's Edge Function secrets
// (see docs/DEPLOY.md), never into chat, Linear, the repo or .env.local.
import webpush from 'web-push'

const { publicKey, privateKey } = webpush.generateVAPIDKeys()
console.log('')
console.log('VAPID public key (Vercel VITE_VAPID_PUBLIC_KEY and Supabase VAPID_PUBLIC_KEY):')
console.log(publicKey)
console.log('')
console.log('VAPID private key (Supabase Edge Function secret VAPID_PRIVATE_KEY only):')
console.log(privateKey)
console.log('')

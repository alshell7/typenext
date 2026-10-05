import { mkdirSync, writeFileSync } from 'node:fs'
if (process.platform !== 'win32')
  throw new Error('This native smoke runs on Windows.')
mkdirSync('artifacts/native-smoke', { recursive: true })
const identifier = `com.typenext.smoke.t${Date.now().toString(36)}`
writeFileSync(
  'artifacts/native-smoke/tauri.json',
  JSON.stringify({ identifier }, null, 2)
)
console.log('Prepared a fresh isolated native smoke profile.')

// Check what the system field actually contains on user messages.
// Usage: tsx scripts/check-system-message.ts <sessionId> [cwd]

import net from 'node:net'
import { spawn } from 'node:child_process'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

const sessionId = process.argv[2]
const cwd = process.argv[3] || process.cwd()

if (!sessionId) {
  console.error('Usage: tsx scripts/check-system-message.ts <sessionId> [cwd]')
  process.exit(1)
}

async function main() {
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const a = s.address() as net.AddressInfo
      s.close(() => resolve(a.port))
    })
    s.on('error', reject)
  })

  const proc = spawn('opencode', ['serve', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  })
  proc.stderr?.on('data', () => {})

  const start = Date.now()
  while (Date.now() - start < 15000) {
    const r = await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (r?.ok) break
    await new Promise((r) => setTimeout(r, 300))
  }

  const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })
  const result = await sdk.session.messages({ sessionID: sessionId })
  const messages = result.data!

  for (let i = 0; i < messages.length; i++) {
    const { info } = messages[i]!
    if (info.role !== 'user') continue
    const u = info as any

    console.log(`\n=== User message ${i} ===`)
    console.log(`Has system field: ${!!u.system}`)
    if (u.system) {
      console.log(`System field length: ${u.system.length}`)
      console.log(`System field type: ${typeof u.system}`)
      console.log(`First 200 chars: ${u.system.slice(0, 200)}`)
      console.log(`Last 100 chars: ...${u.system.slice(-100)}`)

      // Check if all user messages have the same system
      const firstUser = messages.find((m) => m.info.role === 'user')
      if (firstUser) {
        const firstSys = (firstUser.info as any).system
        console.log(`Same as first user: ${u.system === firstSys}`)
      }
    }
  }

  // Also check the info object keys
  const firstUser = messages.find((m) => m.info.role === 'user')
  if (firstUser) {
    console.log(`\nUser info keys: ${Object.keys(firstUser.info).join(', ')}`)
  }

  proc.kill()
}

main().catch((e) => { console.error(e); process.exit(1) })

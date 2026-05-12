// Compare session data from OpenCode HTTP SDK vs ACP session/load to
// understand what content is missing in ACP replay.
//
// Usage: tsx scripts/compare-session.ts <sessionId> [cwd]

import net from 'node:net'
import { spawn } from 'node:child_process'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

const sessionId = process.argv[2]
const cwd = process.argv[3] || process.cwd()

if (!sessionId) {
  console.error('Usage: tsx scripts/compare-session.ts <sessionId> [cwd]')
  process.exit(1)
}

async function findOpenPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') { server.close(); reject(new Error('no addr')); return }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForServer(port: number) {
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const r = await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (r?.ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Server did not start')
}

async function main() {
  console.log(`Session: ${sessionId}`)
  console.log(`CWD: ${cwd}`)
  console.log()

  // Start opencode serve
  const port = await findOpenPort()
  console.log(`Starting opencode serve on port ${port}...`)
  const proc = spawn('opencode', ['serve', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  })

  proc.stderr?.on('data', () => {})

  await waitForServer(port)
  console.log('Server ready')

  const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })

  // Fetch messages via SDK
  const result = await sdk.session.messages({ sessionID: sessionId })
  if (!result.data) {
    console.error('No data')
    proc.kill()
    return
  }

  const messages = result.data
  console.log(`\nMessages: ${messages.length}`)

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalCost = 0
  let totalChars = 0

  for (const msg of messages) {
    const { info, parts } = msg
    const role = info.role

    if (role === 'assistant') {
      const a = info as any
      if (a.tokens) {
        totalInputTokens += a.tokens.input || 0
        totalOutputTokens += a.tokens.output || 0
        totalCacheRead += a.tokens.cache?.read || 0
        totalCacheWrite += a.tokens.cache?.write || 0
      }
      totalCost += a.cost || 0
    }

    console.log(`\n--- Message ${role} ---`)
    console.log(`  Parts: ${parts.length}`)

    let msgChars = 0
    for (const part of parts) {
      const p = part as any
      if (p.type === 'text') {
        const len = (p.text || '').length
        msgChars += len
        console.log(`  text: ${len} chars`)
      }
      if (p.type === 'reasoning') {
        const len = (p.text || '').length
        msgChars += len
        console.log(`  reasoning: ${len} chars`)
      }
      if (p.type === 'tool') {
        const state = p.state || {}
        const inputStr = JSON.stringify(state.input || {})
        const outputStr = state.output || state.error || ''
        const toolChars = inputStr.length + outputStr.length
        msgChars += toolChars
        console.log(`  tool "${p.tool}": input=${inputStr.length} output=${outputStr.length} total=${toolChars} chars`)
      }
      if (p.type === 'step-finish') {
        const tokens = p.tokens || {}
        const cache = tokens.cache || {}
        console.log(`  step-finish: input=${tokens.input} output=${tokens.output} reasoning=${tokens.reasoning} cache.read=${cache.read} cache.write=${cache.write} cost=${p.cost}`)
      }
    }

    // System message on user messages
    if (role === 'user') {
      const u = info as any
      if (u.system) {
        const sysLen = u.system.length
        msgChars += sysLen
        console.log(`  system: ${sysLen} chars`)
      }
    }

    totalChars += msgChars
    console.log(`  Total: ${msgChars} chars (~${Math.round(msgChars / 4)} tokens)`)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`SUMMARY`)
  console.log(`${'='.repeat(60)}`)
  console.log(`Messages: ${messages.length}`)
  console.log(`Total chars: ${totalChars} (~${Math.round(totalChars / 4)} est tokens)`)
  console.log(`SDK tokens: input=${totalInputTokens} output=${totalOutputTokens}`)
  console.log(`SDK cache: read=${totalCacheRead} write=${totalCacheWrite}`)
  console.log(`SDK total prompt: ${totalInputTokens + totalCacheRead + totalCacheWrite}`)
  console.log(`SDK total all: ${totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheWrite}`)
  console.log(`SDK cost: $${totalCost.toFixed(4)}`)

  proc.kill()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

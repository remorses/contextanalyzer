// Debug what notifications ACP session/load actually sends for a session.
// Usage: tsx scripts/debug-acp-replay.ts <sessionId> [cwd]

import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'

const sessionId = process.argv[2]
const cwd = process.argv[3] || process.cwd()

if (!sessionId) {
  console.error('Usage: tsx scripts/debug-acp-replay.ts <sessionId> [cwd]')
  process.exit(1)
}

let notificationCount = 0

function createClient(): (agent: Agent) => Client {
  return (_agent: Agent) => ({
    async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return { outcome: { outcome: 'cancelled' } }
    },
    async sessionUpdate(params: SessionNotification): Promise<void> {
      notificationCount++
      const update = params.update
      const tag = update.sessionUpdate

      switch (tag) {
        case 'user_message_chunk': {
          const text = update.content.type === 'text' ? update.content.text : ''
          console.log(`[${notificationCount}] ${tag}: messageId=${update.messageId ?? 'none'} type=${update.content.type} len=${text.length}`)
          if (text.length < 200) console.log(`    text: ${text.slice(0, 200)}`)
          break
        }
        case 'agent_message_chunk': {
          const text = update.content.type === 'text' ? update.content.text : ''
          console.log(`[${notificationCount}] ${tag}: messageId=${update.messageId ?? 'none'} type=${update.content.type} len=${text.length}`)
          if (text.length < 200) console.log(`    text: ${text.slice(0, 200)}`)
          break
        }
        case 'agent_thought_chunk': {
          const text = update.content.type === 'text' ? update.content.text : ''
          console.log(`[${notificationCount}] ${tag}: type=${update.content.type} len=${text.length}`)
          break
        }
        case 'tool_call': {
          const meta = update._meta as Record<string, unknown> | null
          console.log(`[${notificationCount}] ${tag}: id=${update.toolCallId} title="${update.title}" kind=${update.kind} rawInput=${JSON.stringify(update.rawInput)?.length ?? 0} chars`)
          if (meta) console.log(`    _meta keys: ${Object.keys(meta).join(', ')}`)
          break
        }
        case 'tool_call_update': {
          const rawOut = update.rawOutput !== undefined ? JSON.stringify(update.rawOutput).length : 0
          const contentLen = update.content ? JSON.stringify(update.content).length : 0
          console.log(`[${notificationCount}] ${tag}: id=${update.toolCallId} status=${update.status} rawOutput=${rawOut} content=${contentLen}`)
          break
        }
        default:
          console.log(`[${notificationCount}] ${tag}`)
      }
    },
  })
}

async function main() {
  console.log(`Session: ${sessionId}`)
  console.log(`CWD: ${cwd}`)
  console.log()

  const proc = spawn('opencode', ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  })

  proc.stderr?.on('data', () => {})

  await new Promise((r) => setTimeout(r, 200))

  const input = Writable.toWeb(proc.stdin!)
  const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(input, output)
  const connection = new ClientSideConnection(createClient(), stream)

  const initResult = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })

  console.log('Initialized. Capabilities:', JSON.stringify(initResult.agentCapabilities?.sessionCapabilities))
  console.log()

  console.log('Loading session...')
  await connection.loadSession({
    sessionId,
    cwd,
    mcpServers: [],
  })

  console.log(`\nDone. Total notifications: ${notificationCount}`)

  proc.kill()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

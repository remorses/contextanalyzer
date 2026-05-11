// Spawns an opencode HTTP server (`opencode serve`) and provides typed wrappers
// around the SDK to list sessions and fetch messages for analysis.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  Session,
  Message,
  Part,
  AssistantMessage,
  UserMessage,
} from '@opencode-ai/sdk/v2'

export type { Session, Message, Part, AssistantMessage, UserMessage }

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

class OpencodeStartError extends Error {
  name = 'OpencodeStartError' as const
}

class OpencodeApiError extends Error {
  name = 'OpencodeApiError' as const
}

async function findOpenPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Could not get address'))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForServer({ port, timeout = 15_000 }: { port: number; timeout?: number }) {
  const start = Date.now()
  const url = `http://127.0.0.1:${port}/session`
  while (Date.now() - start < timeout) {
    const result = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(
      () => null,
    )
    if (result && result.ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  return new OpencodeStartError(`Server did not start within ${timeout}ms`)
}

export type OpencodeConnection = {
  sdk: ReturnType<typeof createOpencodeClient>
  process: ChildProcess
  port: number
  cleanup: () => void
}

export async function startOpencodeAcp({
  cwd,
}: {
  cwd: string
}): Promise<OpencodeStartError | OpencodeConnection> {
  const port = await findOpenPort()

  const child = spawn('opencode', ['serve', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env },
  })

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  // Race server readiness against spawn failure (e.g. opencode not on PATH)
  const spawnError = new Promise<OpencodeStartError>((resolve) => {
    child.once('error', (cause) => {
      resolve(new OpencodeStartError('Failed to spawn opencode', { cause }))
    })
  })

  const startError = await Promise.race([waitForServer({ port }), spawnError])
  if (startError instanceof Error) {
    child.kill()
    return new OpencodeStartError(`Failed to start opencode: ${startError.message}. ${stderr.slice(0, 500)}`)
  }

  const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })

  return {
    sdk,
    process: child,
    port,
    cleanup() {
      child.kill()
    },
  }
}

export async function listSessions({
  sdk,
  directory,
}: {
  sdk: ReturnType<typeof createOpencodeClient>
  directory?: string
}): Promise<OpencodeApiError | Session[]> {
  const result = await sdk.session
    .list({ directory })
    .catch((e: unknown) => new OpencodeApiError(`Failed to list sessions`, { cause: e }))
  if (result instanceof Error) return result
  if (!result.data) return new OpencodeApiError('No data in session list response')
  // Sort by most recently updated first
  const sessions = [...result.data].sort((a, b) => b.time.updated - a.time.updated)
  return sessions
}

export async function fetchSessionMessages({
  sdk,
  sessionId,
}: {
  sdk: ReturnType<typeof createOpencodeClient>
  sessionId: string
}): Promise<OpencodeApiError | MessageWithParts[]> {
  const result = await sdk.session
    .messages({ sessionID: sessionId })
    .catch((e: unknown) => new OpencodeApiError(`Failed to fetch messages`, { cause: e }))
  if (result instanceof Error) return result
  if (!result.data) return new OpencodeApiError('No data in messages response')
  return result.data
}

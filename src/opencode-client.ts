// OpenCode HTTP client. Spawns `opencode serve` as a subprocess, connects
// via @opencode-ai/sdk, and provides session listing and message fetching.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  Session,
  Message,
  Part,
  AssistantMessage,
  UserMessage,
  ToolPart,
  TextPart,
  ReasoningPart,
  StepFinishPart,
  ToolStateCompleted,
  ToolStateError,
} from '@opencode-ai/sdk/v2'

export type {
  OpencodeClient,
  Session,
  Message,
  Part,
  AssistantMessage,
  UserMessage,
  ToolPart,
  TextPart,
  ReasoningPart,
  StepFinishPart,
  ToolStateCompleted,
  ToolStateError,
}

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

export type OpencodeConnection = {
  client: OpencodeClient
  process: ChildProcess
  port: number
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function findOpenPort(): Promise<number> {
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

async function waitForServer({
  port,
  timeout = 15_000,
}: {
  port: number
  timeout?: number
}): Promise<Error | void> {
  const start = Date.now()
  const url = `http://127.0.0.1:${port}/session`
  while (Date.now() - start < timeout) {
    const result = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (result && result.ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  return new Error(`Server did not start within ${timeout}ms`)
}

export async function startOpencode({
  cwd,
}: {
  cwd: string
}): Promise<Error | OpencodeConnection> {
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

  // Race: wait briefly for spawn errors, then check server readiness
  const spawnResult = await new Promise<Error | void>((resolve) => {
    child.once('error', (cause) => {
      resolve(new Error('Failed to spawn opencode', { cause }))
    })
    setTimeout(() => resolve(), 100)
  })
  if (spawnResult instanceof Error) {
    child.kill()
    return spawnResult
  }

  const waitResult = await waitForServer({ port })
  if (waitResult instanceof Error) {
    child.kill()
    return new Error(`Failed to start opencode: ${waitResult.message}. ${stderr.slice(0, 500)}`)
  }

  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })
  return { client, process: child, port }
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

export async function listSessions(
  conn: OpencodeConnection,
  { directory }: { directory?: string } = {},
): Promise<Error | Session[]> {
  const result = await conn.client.session
    .list({ directory })
    .catch((e: unknown) => new Error('Failed to list sessions', { cause: e }))
  if (result instanceof Error) return result
  if (!result.data) return new Error('No data in session list response')
  return [...result.data].sort((a, b) => b.time.updated - a.time.updated)
}

export async function fetchMessages(
  conn: OpencodeConnection,
  { sessionId, directory }: { sessionId: string; directory?: string },
): Promise<Error | MessageWithParts[]> {
  const result = await conn.client.session
    .messages({ sessionID: sessionId, directory })
    .catch((e: unknown) => new Error('Failed to fetch messages', { cause: e }))
  if (result instanceof Error) return result
  if (!result.data) return new Error('No data in messages response')
  return result.data
}

export function disconnect(conn: OpencodeConnection) {
  conn.process.kill()
}

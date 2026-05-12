// OpenCode platform implementation. Spawns an opencode HTTP server
// (`opencode serve`) and provides typed wrappers around the SDK to list
// sessions and fetch messages. Messages are normalized into the common
// NormalizedMessage format for the analysis engine.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { Session, Message, Part, AssistantMessage, UserMessage } from '@opencode-ai/sdk/v2'
import type {
  Platform,
  SessionInfo,
  NormalizedMessage,
  NormalizedPart,
  NormalizedTokens,
} from './platform.ts'
import { extractBashCommand } from './bash-command.ts'

export type { Session, Message, Part, AssistantMessage, UserMessage }

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class OpencodeStartError extends Error {
  name = 'OpencodeStartError' as const
}

class OpencodeApiError extends Error {
  name = 'OpencodeApiError' as const
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      server.close(() => {
        resolve(port)
      })
    })
    server.on('error', reject)
  })
}

async function waitForServer({ port, timeout = 15_000 }: { port: number; timeout?: number }) {
  const start = Date.now()
  const url = `http://127.0.0.1:${port}/session`
  while (Date.now() - start < timeout) {
    const result = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (result && result.ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  return new OpencodeStartError(`Server did not start within ${timeout}ms`)
}

// ---------------------------------------------------------------------------
// Normalization: OpenCode SDK messages → NormalizedMessage[]
// ---------------------------------------------------------------------------

function normalizeMessages(
  rawMessages: { info: Message; parts: Part[] }[],
): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  let systemMessageSeen = false

  for (const msg of rawMessages) {
    const { info, parts } = msg

    if (info.role === 'user') {
      const userInfo = info as UserMessage
      const content: NormalizedPart[] = []

      for (const part of parts) {
        if (part.type === 'text' && !('synthetic' in part && part.synthetic)) {
          const textPart = part as { type: 'text'; text: string }
          content.push({ type: 'text', text: textPart.text })
        }
      }

      const normalized: NormalizedMessage = {
        role: 'user',
        timestamp: userInfo.time.created,
        content,
      }

      if (!systemMessageSeen && userInfo.system) {
        normalized.system = userInfo.system
        systemMessageSeen = true
      }

      result.push(normalized)
    }

    if (info.role === 'assistant') {
      const assistantInfo = info as AssistantMessage
      const content: NormalizedPart[] = []

      for (const part of parts) {
        if (part.type === 'text') {
          const textPart = part as { type: 'text'; text: string }
          content.push({ type: 'text', text: textPart.text })
        }

        if (part.type === 'reasoning') {
          const reasoningPart = part as { type: 'reasoning'; text: string }
          content.push({ type: 'reasoning', text: reasoningPart.text })
        }

        if (part.type === 'tool') {
          const toolPart = normalizeToolPart(part)
          if (toolPart) content.push(toolPart)
        }

        if (part.type === 'step-finish') {
          const sf = part as {
            type: 'step-finish'
            cost: number
            tokens: {
              input: number
              output: number
              reasoning: number
              cache: { read: number; write: number }
            }
          }
          content.push({
            type: 'step-finish',
            tokens: {
              input: sf.tokens.input,
              output: sf.tokens.output,
              reasoning: sf.tokens.reasoning,
              cacheRead: sf.tokens.cache.read,
              cacheWrite: sf.tokens.cache.write,
            },
            cost: sf.cost,
          })
        }
      }

      const tokens: NormalizedTokens = {
        input: assistantInfo.tokens.input,
        output: assistantInfo.tokens.output,
        reasoning: assistantInfo.tokens.reasoning,
        cacheRead: assistantInfo.tokens.cache.read,
        cacheWrite: assistantInfo.tokens.cache.write,
      }

      result.push({
        role: 'assistant',
        timestamp: assistantInfo.time.created,
        completedAt: assistantInfo.time.completed ?? undefined,
        model: assistantInfo.modelID || undefined,
        content,
        tokens,
        cost: assistantInfo.cost,
      })
    }
  }

  return result
}

function normalizeToolPart(
  part: { type: 'tool'; tool: string; state: unknown; [key: string]: unknown },
): NormalizedPart | null {
  const toolName = part.tool
  const state = part.state as {
    status: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    time?: { start: number; end: number }
  }

  if (state.status !== 'completed' && state.status !== 'error') return null

  const input = state.input ?? {}
  const output = state.status === 'error' ? (state.error || '') : (state.output || '')
  const durationMs =
    state.time && state.time.end && state.time.start ? state.time.end - state.time.start : 0

  // Determine the kind based on tool name for bash sub-categorization
  let name = toolName
  if (toolName === 'bash' || toolName === 'Bash') {
    const command = input.command
    if (typeof command === 'string') {
      const bashCmd = extractBashCommand(command)
      name = `bash (${bashCmd})`
    }
  }

  return {
    type: 'tool-call',
    name,
    input,
    output,
    durationMs,
    status: state.status === 'completed' ? 'completed' : 'error',
  }
}

// ---------------------------------------------------------------------------
// OpenCode Platform
// ---------------------------------------------------------------------------

export function createOpencodePlatform(): Platform {
  let child: ChildProcess | null = null
  let sdk: ReturnType<typeof createOpencodeClient> | null = null
  let port = 0

  return {
    id: 'opencode',
    name: 'OpenCode',

    async connect({ cwd }) {
      const p = await findOpenPort()
      port = p

      const proc = spawn('opencode', ['serve', '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env },
      })

      let stderr = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      // Race server readiness against spawn failure
      const spawnError = new Promise<OpencodeStartError>((resolve) => {
        proc.once('error', (cause) => {
          resolve(new OpencodeStartError('Failed to spawn opencode', { cause }))
        })
      })

      const startError = await Promise.race([waitForServer({ port }), spawnError])
      if (startError instanceof Error) {
        proc.kill()
        return new OpencodeStartError(
          `Failed to start opencode: ${startError.message}. ${stderr.slice(0, 500)}`,
        )
      }

      child = proc
      sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })
    },

    async listSessions({ cwd }) {
      if (!sdk) return new OpencodeApiError('Not connected')

      const result = await sdk.session
        .list({ directory: cwd })
        .catch((e: unknown) => new OpencodeApiError('Failed to list sessions', { cause: e }))
      if (result instanceof Error) return result
      if (!result.data) return new OpencodeApiError('No data in session list response')

      const sessions: SessionInfo[] = [...result.data]
        .sort((a, b) => b.time.updated - a.time.updated)
        .map((s) => ({
          id: s.id,
          title: s.title || undefined,
          updatedAt: s.time.updated,
        }))

      return sessions
    },

    async fetchMessages({ sessionId }) {
      if (!sdk) return new OpencodeApiError('Not connected')

      const result = await sdk.session
        .messages({ sessionID: sessionId })
        .catch((e: unknown) => new OpencodeApiError('Failed to fetch messages', { cause: e }))
      if (result instanceof Error) return result
      if (!result.data) return new OpencodeApiError('No data in messages response')

      return normalizeMessages(result.data)
    },

    cleanup() {
      if (child) {
        child.kill()
        child = null
      }
      sdk = null
    },
  }
}

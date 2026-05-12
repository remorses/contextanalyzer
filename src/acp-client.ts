// ACP client that works for all agents (OpenCode, Claude Code, Codex).
// Spawns the agent binary as a subprocess, connects via JSON-RPC/stdio
// using @agentclientprotocol/sdk, and provides session listing and
// message fetching through the standard ACP protocol.

import { spawn, type ChildProcess } from 'node:child_process'
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
import type {
  SessionInfo,
  NormalizedMessage,
  NormalizedPart,
} from './platform.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcpConnection = {
  connection: ClientSideConnection
  process: ChildProcess
}

export type SpawnConfig = {
  cmd: string
  args: string[]
}

// ---------------------------------------------------------------------------
// Notification collector
//
// During session/load the agent replays conversation history via
// session/update notifications. This collector accumulates them into
// NormalizedMessage[].
//
// Message boundaries are tracked via both role changes AND messageId
// changes. ContentChunk has an optional messageId; a change in messageId
// signals a new message even if the role stays the same.
// ---------------------------------------------------------------------------

type PendingToolCall = {
  name: string
  kind?: string
  input: Record<string, unknown>
}

class NotificationCollector {
  messages: NormalizedMessage[] = []
  private pendingTools = new Map<string, PendingToolCall>()
  private currentAssistantParts: NormalizedPart[] = []
  private currentUserParts: NormalizedPart[] = []
  private lastRole: 'user' | 'assistant' | null = null
  private currentMessageId: string | null = null
  private timestamp = Date.now()

  handleUpdate(notification: SessionNotification) {
    const update = notification.update

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const chunk = update as { messageId?: string | null; content: { type: string; text?: string } }
        this.startChunk('user', chunk.messageId)
        if (update.content.type === 'text') {
          this.currentUserParts.push({ type: 'text', text: update.content.text })
        }
        break
      }

      case 'agent_message_chunk': {
        const chunk = update as { messageId?: string | null; content: { type: string; text?: string } }
        this.startChunk('assistant', chunk.messageId)
        if (update.content.type === 'text') {
          this.currentAssistantParts.push({ type: 'text', text: update.content.text })
        }
        break
      }

      case 'agent_thought_chunk': {
        const chunk = update as { messageId?: string | null; content: { type: string; text?: string } }
        this.startChunk('assistant', chunk.messageId)
        if (update.content.type === 'text') {
          this.currentAssistantParts.push({ type: 'reasoning', text: update.content.text })
        }
        break
      }

      case 'tool_call': {
        this.startChunk('assistant', null)
        const meta = update._meta as { claudeCode?: { toolName?: string } } | undefined
        const toolName = meta?.claudeCode?.toolName || update.title || 'unknown'
        const rawInput = toRecord(update.rawInput)

        this.pendingTools.set(update.toolCallId, {
          name: toolName,
          kind: update.kind ?? undefined,
          input: rawInput,
        })
        break
      }

      case 'tool_call_update': {
        const pending = this.pendingTools.get(update.toolCallId)
        if (!pending) break

        // Merge update fields into pending state — updates can carry
        // rawInput, rawOutput, title, kind not present in initial tool_call
        if (update.rawInput !== undefined) pending.input = toRecord(update.rawInput)
        if (update.kind) pending.kind = update.kind
        const meta = update._meta as { claudeCode?: { toolName?: string } } | undefined
        if (meta?.claudeCode?.toolName) pending.name = meta.claudeCode.toolName
        else if (update.title) pending.name = update.title

        const isTerminal = update.status === 'completed' || update.status === 'failed'
        if (!isTerminal) break

        // Extract output from rawOutput or content
        let output = ''
        if (update.rawOutput !== undefined) {
          output = typeof update.rawOutput === 'string'
            ? update.rawOutput
            : JSON.stringify(update.rawOutput)
        } else if (update.content) {
          const textParts = update.content
            .filter((c): c is { type: 'content'; content: { type: 'text'; text: string } } =>
              c.type === 'content' && c.content.type === 'text',
            )
          output = textParts.map((c) => c.content.text).join('\n')
        }

        this.currentAssistantParts.push({
          type: 'tool-call',
          name: pending.name,
          kind: pending.kind,
          input: pending.input,
          output,
        })

        this.pendingTools.delete(update.toolCallId)
        break
      }

      default:
        break
    }
  }

  private startChunk(newRole: 'user' | 'assistant', messageId?: string | null) {
    const roleChanged = this.lastRole !== null && this.lastRole !== newRole
    const messageIdChanged = messageId != null
      && this.currentMessageId != null
      && this.currentMessageId !== messageId

    if (roleChanged || messageIdChanged) {
      this.flushCurrent()
    }

    this.lastRole = newRole
    if (messageId != null) this.currentMessageId = messageId
  }

  private flushCurrent() {
    if (this.lastRole === 'user' && this.currentUserParts.length > 0) {
      this.messages.push({
        role: 'user',
        timestamp: this.timestamp,
        content: this.currentUserParts,
      })
      this.currentUserParts = []
      this.timestamp = Date.now()
    }
    if (this.lastRole === 'assistant' && this.currentAssistantParts.length > 0) {
      this.messages.push({
        role: 'assistant',
        timestamp: this.timestamp,
        content: this.currentAssistantParts,
      })
      this.currentAssistantParts = []
      this.timestamp = Date.now()
    }
    this.currentMessageId = null
  }

  finalize(): NormalizedMessage[] {
    this.flushCurrent()
    return this.messages
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

// ---------------------------------------------------------------------------
// ACP client handler — uses a mutable holder so fetchMessages() can swap in
// a fresh collector per session load.
// ---------------------------------------------------------------------------

type ActiveCollector = { collector: NotificationCollector }

function createMinimalClient(active: ActiveCollector): (agent: Agent) => Client {
  return (_agent: Agent) => ({
    async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return { outcome: { outcome: 'cancelled' } }
    },
    async sessionUpdate(params: SessionNotification): Promise<void> {
      active.collector.handleUpdate(params)
    },
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function connectAcp({
  cmd,
  args,
  cwd,
}: SpawnConfig & { cwd: string }): Promise<Error | AcpConnection> {
  const proc = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env },
  })

  proc.stderr?.on('data', () => {
    // Drain stderr to prevent backpressure
  })

  const spawnResult = await new Promise<Error | void>((resolve) => {
    proc.once('error', (cause) => {
      resolve(new Error(`Failed to spawn ACP agent`, { cause }))
    })
    setTimeout(() => { resolve() }, 100)
  })
  if (spawnResult instanceof Error) {
    proc.kill()
    return spawnResult
  }

  const active: ActiveCollector = { collector: new NotificationCollector() }
  const input = Writable.toWeb(proc.stdin!)
  const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(input, output)
  const connection = new ClientSideConnection(createMinimalClient(active), stream)

  const initResult = await connection
    .initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    .catch((e: unknown) => new Error('ACP initialization failed', { cause: e }))

  if (initResult instanceof Error) {
    proc.kill()
    return initResult
  }

  const caps = initResult.agentCapabilities
  if (!caps?.sessionCapabilities?.list) {
    proc.kill()
    return new Error('Agent does not support session listing')
  }

  // Attach active collector to connection for fetchMessages to use
  ;(connection as any)._active = active

  return { connection, process: proc }
}

export async function listSessions(
  conn: AcpConnection,
  { cwd }: { cwd?: string },
): Promise<Error | SessionInfo[]> {
  const result = await conn.connection
    .listSessions({ cwd })
    .catch((e: unknown) => new Error('Failed to list sessions', { cause: e }))

  if (result instanceof Error) return result

  const sessions: SessionInfo[] = result.sessions.map((s) => ({
    id: s.sessionId,
    title: s.title ?? undefined,
    updatedAt: s.updatedAt ? new Date(s.updatedAt).getTime() : 0,
    cwd: s.cwd,
  }))

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

export async function fetchMessages(
  conn: AcpConnection,
  { sessionId, cwd }: { sessionId: string; cwd?: string },
): Promise<Error | NormalizedMessage[]> {
  const active = (conn.connection as any)._active as ActiveCollector
  active.collector = new NotificationCollector()

  const loadResult = await conn.connection
    .loadSession({
      sessionId,
      cwd: cwd || process.cwd(),
      mcpServers: [],
    })
    .catch((e: unknown) => new Error(`Failed to load session ${sessionId}`, { cause: e }))

  if (loadResult instanceof Error) return loadResult

  return active.collector.finalize()
}

export function disconnect(conn: AcpConnection) {
  conn.process.kill()
}

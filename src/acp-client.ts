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
  type SessionUpdate,
  type ContentChunk,
  type ToolCall,
  type ToolCallUpdate,
  type ToolCallContent,
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

export type SpawnConfig = {
  cmd: string
  args: string[]
}

export type AcpConnection = {
  connection: ClientSideConnection
  process: ChildProcess
  /** Mutable holder so fetchMessages() can swap in a fresh collector */
  active: ActiveCollector
}

type ActiveCollector = { collector: NotificationCollector }

// ---------------------------------------------------------------------------
// Notification collector
//
// During session/load the agent replays conversation history via
// session/update notifications. This collector accumulates them into
// NormalizedMessage[].
//
// Message boundaries are tracked via both role changes AND messageId
// changes (ContentChunk.messageId). A change in messageId signals a
// new message even if the role stays the same.
// ---------------------------------------------------------------------------

type PendingToolCall = {
  name: string
  kind?: string
  input: Record<string, unknown>
}

// Discriminated union helper: extract the variant where sessionUpdate === T
type UpdateVariant<T extends SessionUpdate['sessionUpdate']> =
  Extract<SessionUpdate, { sessionUpdate: T }>

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
        this.handleContentChunk('user', update)
        break
      }

      case 'agent_message_chunk': {
        this.handleContentChunk('assistant', update)
        break
      }

      case 'agent_thought_chunk': {
        this.startChunk('assistant', update.messageId)
        if (update.content.type === 'text') {
          this.currentAssistantParts.push({ type: 'reasoning', text: update.content.text })
        }
        break
      }

      case 'tool_call': {
        this.handleToolCall(update)
        break
      }

      case 'tool_call_update': {
        this.handleToolCallUpdate(update)
        break
      }

      default:
        break
    }
  }

  private handleContentChunk(
    role: 'user' | 'assistant',
    chunk: ContentChunk & { sessionUpdate: string },
  ) {
    this.startChunk(role, chunk.messageId)
    if (chunk.content.type === 'text') {
      const parts = role === 'user' ? this.currentUserParts : this.currentAssistantParts
      parts.push({ type: 'text', text: chunk.content.text })
    }
  }

  private handleToolCall(update: UpdateVariant<'tool_call'>) {
    this.startChunk('assistant', null)

    const meta = update._meta as { claudeCode?: { toolName?: string } } | null | undefined
    const toolName = meta?.claudeCode?.toolName || update.title || 'unknown'

    this.pendingTools.set(update.toolCallId, {
      name: toolName,
      kind: update.kind ?? undefined,
      input: toRecord(update.rawInput),
    })
  }

  private handleToolCallUpdate(update: UpdateVariant<'tool_call_update'>) {
    const pending = this.pendingTools.get(update.toolCallId)
    if (!pending) return

    // Merge update fields into pending state — updates can carry
    // rawInput, rawOutput, title, kind not present in initial tool_call
    if (update.rawInput !== undefined) pending.input = toRecord(update.rawInput)
    if (update.kind) pending.kind = update.kind

    const meta = update._meta as { claudeCode?: { toolName?: string } } | null | undefined
    if (meta?.claudeCode?.toolName) pending.name = meta.claudeCode.toolName
    else if (update.title) pending.name = update.title

    const isTerminal = update.status === 'completed' || update.status === 'failed'
    if (!isTerminal) return

    const output = extractToolOutput(update)

    this.currentAssistantParts.push({
      type: 'tool-call',
      name: pending.name,
      kind: pending.kind,
      input: pending.input,
      output,
    })

    this.pendingTools.delete(update.toolCallId)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function extractToolOutput(update: ToolCallUpdate): string {
  if (update.rawOutput !== undefined) {
    return typeof update.rawOutput === 'string'
      ? update.rawOutput
      : JSON.stringify(update.rawOutput)
  }

  if (update.content) {
    return update.content
      .filter((c): c is Extract<ToolCallContent, { type: 'content' }> =>
        c.type === 'content',
      )
      .filter((c) => c.content.type === 'text')
      .map((c) => {
        const block = c.content as { type: 'text'; text: string }
        return block.text
      })
      .join('\n')
  }

  return ''
}

// ---------------------------------------------------------------------------
// Minimal ACP client handler
// ---------------------------------------------------------------------------

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
      resolve(new Error('Failed to spawn ACP agent', { cause }))
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

  return { connection, process: proc, active }
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
  conn.active.collector = new NotificationCollector()

  const loadResult = await conn.connection
    .loadSession({
      sessionId,
      cwd: cwd || process.cwd(),
      mcpServers: [],
    })
    .catch((e: unknown) => new Error(`Failed to load session ${sessionId}`, { cause: e }))

  if (loadResult instanceof Error) return loadResult

  return conn.active.collector.finalize()
}

export function disconnect(conn: AcpConnection) {
  conn.process.kill()
}

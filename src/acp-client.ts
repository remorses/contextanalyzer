// ACP platform shared by Claude Code and Codex. Spawns the agent binary via
// stdio, uses @agentclientprotocol/sdk for session/list and session/load.
// Collects session/update notifications during replay into NormalizedMessage[].

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
  Platform,
  PlatformId,
  SessionInfo,
  NormalizedMessage,
  NormalizedPart,
} from './platform.ts'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class AcpConnectionError extends Error {
  name = 'AcpConnectionError' as const
}

class AcpApiError extends Error {
  name = 'AcpApiError' as const
}

// ---------------------------------------------------------------------------
// Notification collector
//
// During session/load the agent replays conversation history via
// session/update notifications. This collector accumulates them into
// NormalizedMessage[].
//
// Message boundaries are tracked via both role changes AND messageId changes.
// ContentChunk has an optional `messageId`; a change in messageId signals a
// new message even if the role stays the same.
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

        // Merge update fields into pending state (fix #6: updates can
        // carry rawInput, rawOutput, title, kind that weren't in the
        // initial tool_call notification)
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

        // Duration is 0 for ACP replay — we don't have original timing data.
        // Measuring Date.now() deltas would reflect replay speed, not real
        // tool execution time, which would be misleading.
        this.currentAssistantParts.push({
          type: 'tool-call',
          name: pending.name,
          kind: pending.kind,
          input: pending.input,
          output,
          durationMs: 0,
          status: update.status === 'completed' ? 'completed' : 'error',
        })

        this.pendingTools.delete(update.toolCallId)
        break
      }

      // usage_update may be sent during replay for some agents
      case 'usage_update': {
        // Currently no ACP agent sends usage during replay, but if one
        // does in the future we could create step-finish parts here.
        break
      }

      default:
        // plan, available_commands_update, config_option_update, etc.
        break
    }
  }

  /** Start a new content chunk. Flushes the current message if the role or
   *  messageId changed. */
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

  /** Flush any remaining parts after replay completes */
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
// Minimal ACP client — only implements callbacks needed for session/load
// replay. Uses an active-collector holder so fetchMessages() can swap in a
// fresh collector per load without rewiring the ClientSideConnection.
// ---------------------------------------------------------------------------

type ActiveCollector = { collector: NotificationCollector }

function createMinimalClient(active: ActiveCollector): (agent: Agent) => Client {
  return (_agent: Agent) => ({
    async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      // During session/load replay no permission requests should arrive.
      return { outcome: { outcome: 'cancelled' } }
    },

    async sessionUpdate(params: SessionNotification): Promise<void> {
      active.collector.handleUpdate(params)
    },
  })
}

// ---------------------------------------------------------------------------
// ACP Platform implementation
// ---------------------------------------------------------------------------

export function startAcpPlatform({
  id,
  name,
  resolveBin,
}: {
  id: PlatformId
  name: string
  /** Returns either a JS entry point (spawned with node) or a native binary path */
  resolveBin: () => { path: string; isNative: boolean }
}): Platform {
  let child: ChildProcess | null = null
  let connection: ClientSideConnection | null = null
  const active: ActiveCollector = { collector: new NotificationCollector() }

  return {
    id,
    name,

    async connect({ cwd }) {
      const binResult = (() => {
        try {
          return resolveBin()
        } catch (e) {
          return new AcpConnectionError(
            `Could not resolve ${name} binary. Is the package installed?`,
            { cause: e },
          )
        }
      })()
      if (binResult instanceof Error) return binResult

      // Spawn the ACP agent as a subprocess with stdio transport.
      // Native binaries run directly; JS entry points run under node.
      const cmd = binResult.isNative ? binResult.path : process.execPath
      const args = binResult.isNative ? [] : [binResult.path]

      const proc = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env },
      })

      proc.stderr?.on('data', () => {
        // Drain stderr to prevent backpressure
      })

      // Race spawn-error against a short init delay
      const spawnResult = await new Promise<Error | void>((resolve) => {
        proc.once('error', (cause) => {
          resolve(new AcpConnectionError(`Failed to spawn ${name}`, { cause }))
        })
        // ACP agents are ready once spawned (stdio transport)
        setTimeout(() => { resolve() }, 100)
      })
      if (spawnResult instanceof Error) {
        proc.kill()
        return spawnResult
      }

      child = proc

      // Create the ACP connection over stdio
      const input = Writable.toWeb(proc.stdin!)
      const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>
      const stream = ndJsonStream(input, output)
      connection = new ClientSideConnection(createMinimalClient(active), stream)

      // Initialize the ACP connection
      const initResult = await connection
        .initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        .catch((e: unknown) => new AcpConnectionError(`Failed to initialize ${name} ACP`, { cause: e }))

      if (initResult instanceof Error) {
        proc.kill()
        child = null
        connection = null
        return initResult
      }

      // Verify the agent supports session listing
      const caps = initResult.agentCapabilities
      if (!caps?.sessionCapabilities?.list) {
        proc.kill()
        child = null
        connection = null
        return new AcpConnectionError(`${name} does not support session listing`)
      }
    },

    async listSessions({ cwd }) {
      if (!connection) return new AcpApiError('Not connected')

      const result = await connection
        .listSessions({ cwd })
        .catch((e: unknown) => new AcpApiError(`Failed to list ${name} sessions`, { cause: e }))

      if (result instanceof Error) return result

      const sessions: SessionInfo[] = result.sessions.map((s) => ({
        id: s.sessionId,
        title: s.title ?? undefined,
        updatedAt: s.updatedAt ? new Date(s.updatedAt).getTime() : 0,
        cwd: s.cwd,
      }))

      // Sort by most recently updated first
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      return sessions
    },

    async fetchMessages({ sessionId, cwd }) {
      if (!connection) return new AcpApiError('Not connected')

      // Swap in a fresh collector for this load so no stale state leaks
      // between multiple fetchMessages() calls on the same platform.
      active.collector = new NotificationCollector()

      const loadResult = await connection
        .loadSession({
          sessionId,
          cwd: cwd || process.cwd(),
          mcpServers: [],
        })
        .catch((e: unknown) => new AcpApiError(`Failed to load session ${sessionId}`, { cause: e }))

      if (loadResult instanceof Error) return loadResult

      return active.collector.finalize()
    },

    cleanup() {
      if (child) {
        child.kill()
        child = null
      }
      connection = null
    },
  }
}

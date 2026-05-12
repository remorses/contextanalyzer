// Platform abstraction layer. Defines the common types and interface that
// all agent platforms (OpenCode, Claude Code, Codex) implement to provide
// session listing and message fetching for analysis.

// ---------------------------------------------------------------------------
// Platform identifiers
// ---------------------------------------------------------------------------

export const PLATFORM_IDS = ['opencode', 'claude-code', 'codex'] as const
export type PlatformId = (typeof PLATFORM_IDS)[number]

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

// ---------------------------------------------------------------------------
// Session info (returned by listSessions)
// ---------------------------------------------------------------------------

export type SessionInfo = {
  id: string
  title?: string
  /** Unix timestamp in ms */
  updatedAt: number
  cwd?: string
}

// ---------------------------------------------------------------------------
// Normalized message types (what analyze.ts consumes)
// ---------------------------------------------------------------------------

export type NormalizedTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type NormalizedPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      name: string
      kind?: string
      input: Record<string, unknown>
      output: string
      durationMs: number
      status: 'completed' | 'error'
    }
  | {
      type: 'step-finish'
      tokens: NormalizedTokens
      cost: number
    }

export type NormalizedMessage = {
  role: 'user' | 'assistant'
  /** Unix timestamp in ms */
  timestamp: number
  /** When the message processing completed (e.g. all tool calls finished).
   *  Only available from OpenCode. Used for more accurate session duration. */
  completedAt?: number
  model?: string
  /** System prompt text (only on the first user message that carries it) */
  system?: string
  content: NormalizedPart[]
  /** Per-message token counts. Absent for ACP-only agents where the replay
   *  does not include usage data. */
  tokens?: NormalizedTokens
  /** Per-message cost in USD. Absent for ACP-only agents. */
  cost?: number
}

// ---------------------------------------------------------------------------
// Platform interface
// ---------------------------------------------------------------------------

export interface Platform {
  id: PlatformId
  name: string
  /** Establish the connection (spawn server, connect to agent, etc.) */
  connect(opts: { cwd: string }): Promise<Error | void>
  /** List available sessions, optionally filtered by cwd */
  listSessions(opts: { cwd?: string }): Promise<Error | SessionInfo[]>
  /** Fetch and normalize messages for a session */
  fetchMessages(opts: { sessionId: string; cwd?: string }): Promise<Error | NormalizedMessage[]>
  /** Tear down the connection and any child processes */
  cleanup(): void
}

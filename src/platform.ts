// Common types shared by the ACP client and analysis engine.
// All agent platforms (OpenCode, Claude Code, Codex) produce NormalizedMessage[]
// through the same ACP protocol.

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
// Session info (returned by session/list)
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

export type NormalizedPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      name: string
      kind?: string
      input: Record<string, unknown>
      output: string
    }

export type NormalizedMessage = {
  role: 'user' | 'assistant'
  /** Unix timestamp in ms */
  timestamp: number
  model?: string
  /** System prompt text (only on the first user message that carries it) */
  system?: string
  content: NormalizedPart[]
}

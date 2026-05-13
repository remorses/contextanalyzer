// Core analysis engine. Takes MessageWithParts[] from the OpenCode SDK
// and produces structured analysis results for rendering.

import type { MessageWithParts, AssistantMessage } from './opencode-client.ts'
import { extractBashCommand } from './bash-command.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Total tokens from a snapshot (input is uncached only, so add cache) */
function getTokenTotal(tokens: AssistantMessage['tokens']): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ContextBreakdown = {
  systemMessageChars: number
  toolOutputChars: number
  toolInputChars: number
  assistantTextChars: number
  userTextChars: number
  reasoningChars: number
}

export type TokenUsage = {
  /** Non-cached input tokens (as reported by OpenCode) */
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  /** input + cache.read + cache.write */
  totalPromptTokens: number
  /** totalPromptTokens + outputTokens + reasoningTokens */
  totalTokens: number
  totalCost: number
}

export type ToolGroup = {
  label: string
  totalOutputChars: number
  totalInputChars: number
  totalDurationMs: number
  count: number
  maxDurationMs: number
}

export type IndividualToolCall = {
  label: string
  totalChars: number
  durationMs: number
}

export type StepInfo = {
  index: number
  /** Total prompt tokens: input + cache.read + cache.write */
  promptTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  cost: number
  cacheHitRate: number
}

export type AnalysisResult = {
  sessionId: string
  modelId: string
  contextBreakdown: ContextBreakdown
  tokenUsage: TokenUsage
  toolsByContextSize: ToolGroup[]
  toolsByDuration: ToolGroup[]
  individualCallsBySize: IndividualToolCall[]
  individualCallsByDuration: IndividualToolCall[]
  steps: StepInfo[]
  messageCount: { user: number; assistant: number }
  totalDurationMs: number
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyzeSession({
  sessionId,
  messages,
}: {
  sessionId: string
  messages: MessageWithParts[]
}): AnalysisResult {
  const contextBreakdown: ContextBreakdown = {
    systemMessageChars: 0,
    toolOutputChars: 0,
    toolInputChars: 0,
    assistantTextChars: 0,
    userTextChars: 0,
    reasoningChars: 0,
  }

  const tokenUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalPromptTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  }

  const toolGroupMap = new Map<string, ToolGroup>()
  const individualCalls: IndividualToolCall[] = []
  const steps: StepInfo[] = []
  let userCount = 0
  let assistantCount = 0
  let modelId = ''
  let earliestTime = Infinity
  let latestTime = 0
  let systemMessageSeen = false
  // AssistantMessage.tokens is a context snapshot (full window at that point),
  // NOT incremental per-message. We track the last non-zero snapshot and use
  // it as the session's token usage. Cost is the exception: it IS incremental.
  let lastTokenSnapshot: AssistantMessage | null = null

  for (const msg of messages) {
    const { info, parts } = msg

    if (info.role === 'user') {
      userCount++

      if (!systemMessageSeen && info.system) {
        contextBreakdown.systemMessageChars = info.system.length
        systemMessageSeen = true
      }

      if (info.time.created < earliestTime) earliestTime = info.time.created
      if (info.time.created > latestTime) latestTime = info.time.created

      for (const part of parts) {
        if (part.type === 'text' && !part.synthetic) {
          contextBreakdown.userTextChars += part.text.length
        }
      }
    }

    if (info.role === 'assistant') {
      assistantCount++
      if (!modelId && info.modelID) modelId = info.modelID

      // Cost is incremental per-message, so sum it
      tokenUsage.totalCost += info.cost

      // Tokens are a snapshot; keep the last one with non-zero data
      if (getTokenTotal(info.tokens) > 0) {
        lastTokenSnapshot = info
      }

      if (info.time.created < earliestTime) earliestTime = info.time.created
      if (info.time.completed && info.time.completed > latestTime) {
        latestTime = info.time.completed
      }

      for (const part of parts) {
        if (part.type === 'text') {
          contextBreakdown.assistantTextChars += part.text.length
        }

        if (part.type === 'reasoning') {
          contextBreakdown.reasoningChars += part.text.length
        }

        if (part.type === 'tool') {
          processToolPart(part, toolGroupMap, individualCalls, contextBreakdown)
        }

        if (part.type === 'step-finish') {
          const promptTokens = part.tokens.input + part.tokens.cache.read + part.tokens.cache.write
          const cacheHitRate = promptTokens > 0 ? part.tokens.cache.read / promptTokens : 0
          steps.push({
            index: steps.length + 1,
            promptTokens,
            outputTokens: part.tokens.output,
            reasoningTokens: part.tokens.reasoning,
            cacheRead: part.tokens.cache.read,
            cacheWrite: part.tokens.cache.write,
            cost: part.cost,
            cacheHitRate,
          })
        }
      }
    }
  }

  // Derive token totals from the last snapshot (not summed across messages)
  if (lastTokenSnapshot) {
    const { tokens } = lastTokenSnapshot
    tokenUsage.inputTokens = tokens.input
    tokenUsage.outputTokens = tokens.output
    tokenUsage.reasoningTokens = tokens.reasoning
    tokenUsage.cacheRead = tokens.cache.read
    tokenUsage.cacheWrite = tokens.cache.write
    tokenUsage.totalPromptTokens = tokens.input + tokens.cache.read + tokens.cache.write
    tokenUsage.totalTokens = getTokenTotal(tokens)
  }

  const toolGroups = [...toolGroupMap.values()]
  const toolsByContextSize = [...toolGroups].sort(
    (a, b) => b.totalOutputChars + b.totalInputChars - (a.totalOutputChars + a.totalInputChars),
  )
  const toolsByDuration = [...toolGroups].sort((a, b) => b.totalDurationMs - a.totalDurationMs)

  const individualCallsBySize = [...individualCalls]
    .sort((a, b) => b.totalChars - a.totalChars)
    .slice(0, 10)
  const individualCallsByDuration = [...individualCalls]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)

  const totalDurationMs =
    latestTime !== 0 && earliestTime !== Infinity ? latestTime - earliestTime : 0

  return {
    sessionId,
    modelId,
    contextBreakdown,
    tokenUsage,
    toolsByContextSize,
    toolsByDuration,
    individualCallsBySize,
    individualCallsByDuration,
    steps,
    messageCount: { user: userCount, assistant: assistantCount },
    totalDurationMs,
  }
}

// ---------------------------------------------------------------------------
// Tool processing
// ---------------------------------------------------------------------------

function processToolPart(
  part: Extract<import('@opencode-ai/sdk/v2').Part, { type: 'tool' }>,
  toolGroupMap: Map<string, ToolGroup>,
  individualCalls: IndividualToolCall[],
  contextBreakdown: ContextBreakdown,
) {
  const { state } = part
  if (state.status !== 'completed' && state.status !== 'error') return

  const inputStr = JSON.stringify(state.input)
  const outputStr = state.status === 'completed' ? state.output : state.error
  const durationMs = state.time.end - state.time.start

  contextBreakdown.toolOutputChars += outputStr.length
  contextBreakdown.toolInputChars += inputStr.length

  const totalChars = inputStr.length + outputStr.length
  const individualLabel = buildIndividualLabel(part.tool, state.input)
  individualCalls.push({ label: individualLabel, totalChars, durationMs })

  // Group key: tool name. Bash commands are sub-categorized by first command.
  let groupKey = part.tool
  const lower = part.tool.toLowerCase()
  if ((lower === 'bash' || lower === 'execute') && typeof state.input.command === 'string') {
    groupKey = `bash (${extractBashCommand(state.input.command)})`
  }
  if (lower === 'exec_command' && typeof state.input.cmd === 'string') {
    groupKey = `exec (${extractBashCommand(state.input.cmd)})`
  }

  const existing = toolGroupMap.get(groupKey)
  if (existing) {
    existing.totalOutputChars += outputStr.length
    existing.totalInputChars += inputStr.length
    existing.totalDurationMs += durationMs
    existing.count++
    if (durationMs > existing.maxDurationMs) existing.maxDurationMs = durationMs
  } else {
    toolGroupMap.set(groupKey, {
      label: groupKey,
      totalOutputChars: outputStr.length,
      totalInputChars: inputStr.length,
      totalDurationMs: durationMs,
      count: 1,
      maxDurationMs: durationMs,
    })
  }
}

// ---------------------------------------------------------------------------
// Label builders
// ---------------------------------------------------------------------------

function buildIndividualLabel(toolName: string, input: Record<string, unknown>): string {
  const lower = toolName.toLowerCase()

  if (lower.startsWith('bash') || lower === 'execute') {
    const cmd = typeof input.command === 'string' ? input.command.trim() : ''
    return `bash: ${cmd}`
  }

  if (lower === 'exec_command') {
    const cmd = typeof input.cmd === 'string' ? input.cmd.trim() : ''
    return `exec: ${cmd}`
  }

  if (lower === 'read') {
    const path = typeof input.filePath === 'string' ? input.filePath : typeof input.file_path === 'string' ? input.file_path : ''
    return `read: ${path}`
  }

  if (lower === 'write') {
    const path = typeof input.filePath === 'string' ? input.filePath : typeof input.file_path === 'string' ? input.file_path : ''
    return `write: ${path}`
  }

  if (lower === 'edit') {
    const path = typeof input.filePath === 'string' ? input.filePath : typeof input.file_path === 'string' ? input.file_path : ''
    return `edit: ${path}`
  }

  if (lower === 'glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    return `glob: ${pattern}`
  }

  if (lower === 'grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    return `grep: ${pattern}`
  }

  if (lower === 'webfetch') {
    const url = typeof input.url === 'string' ? input.url : ''
    return `webfetch: ${url}`
  }

  if (lower === 'websearch' || lower === 'googlesearch') {
    const query = typeof input.query === 'string' ? input.query : ''
    return `${lower}: ${query}`
  }

  if (lower === 'task') {
    const desc = typeof input.description === 'string' ? input.description : ''
    return `task: ${desc}`
  }

  if (lower === 'skill') {
    const name = typeof input.name === 'string' ? input.name : ''
    return `skill: ${name}`
  }

  const firstStr = Object.values(input).find((v) => typeof v === 'string')
  if (typeof firstStr === 'string') return `${toolName}: ${firstStr}`

  return toolName
}

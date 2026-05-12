// Core analysis engine. Takes NormalizedMessage[] from any platform
// (OpenCode, Claude Code, Codex) and produces structured analysis
// results for rendering.

import type { NormalizedMessage, NormalizedPart } from './platform.ts'
import { extractBashCommand } from './bash-command.ts'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type HistogramEntry = {
  label: string
  value: number
  count: number
  /** optional sub-label like "(12 calls)" */
  detail?: string
}

export type ContextBreakdown = {
  systemMessageChars: number
  toolOutputChars: number
  toolInputChars: number
  assistantTextChars: number
  userTextChars: number
  reasoningChars: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCost: number
}

export type ToolGroup = {
  label: string
  toolName: string
  bashCommand?: string
  totalOutputChars: number
  totalInputChars: number
  totalDurationMs: number
  count: number
  maxDurationMs: number
}

export type IndividualToolCall = {
  label: string
  toolName: string
  totalChars: number
  durationMs: number
}

export type StepInfo = {
  index: number
  inputTokens: number
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
  toolsByContextSize: ToolGroup[]
  toolsByDuration: ToolGroup[]
  individualCallsBySize: IndividualToolCall[]
  individualCallsByDuration: IndividualToolCall[]
  steps: StepInfo[]
  messageCount: { user: number; assistant: number }
  totalDurationMs: number
  /** True when per-message token data was available from the platform */
  hasTokenData: boolean
  /** True when tool call duration data reflects real execution time
   *  (not replay timing). ACP agents set duration to 0. */
  hasDurationData: boolean
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyzeSession({
  sessionId,
  messages,
}: {
  sessionId: string
  messages: NormalizedMessage[]
}): AnalysisResult {
  const contextBreakdown: ContextBreakdown = {
    systemMessageChars: 0,
    toolOutputChars: 0,
    toolInputChars: 0,
    assistantTextChars: 0,
    userTextChars: 0,
    reasoningChars: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
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
  let hasTokenData = false
  let hasDurationData = false

  for (const msg of messages) {
    if (msg.timestamp < earliestTime) earliestTime = msg.timestamp
    const endTime = msg.completedAt ?? msg.timestamp
    if (endTime > latestTime) latestTime = endTime

    if (msg.role === 'user') {
      userCount++

      // System message (only count once)
      if (!systemMessageSeen && msg.system) {
        contextBreakdown.systemMessageChars = msg.system.length
        systemMessageSeen = true
      }

      // User text parts
      for (const part of msg.content) {
        if (part.type === 'text') {
          contextBreakdown.userTextChars += part.text.length
        }
      }
    }

    if (msg.role === 'assistant') {
      assistantCount++
      if (!modelId && msg.model) modelId = msg.model

      // Accumulate per-message token data if available
      if (msg.tokens) {
        hasTokenData = true
        contextBreakdown.totalInputTokens += msg.tokens.input
        contextBreakdown.totalOutputTokens += msg.tokens.output
        contextBreakdown.totalReasoningTokens += msg.tokens.reasoning
        contextBreakdown.totalCacheRead += msg.tokens.cacheRead
        contextBreakdown.totalCacheWrite += msg.tokens.cacheWrite
      }
      if (msg.cost !== undefined) {
        contextBreakdown.totalCost += msg.cost
      }

      for (const part of msg.content) {
        if (part.type === 'text') {
          contextBreakdown.assistantTextChars += part.text.length
        }

        if (part.type === 'reasoning') {
          contextBreakdown.reasoningChars += part.text.length
        }

        if (part.type === 'tool-call') {
          if (part.durationMs > 0) hasDurationData = true
          processToolCall(part, toolGroupMap, individualCalls, contextBreakdown)
        }

        if (part.type === 'step-finish') {
          // OpenCode reports `input` as only non-cached tokens.
          // Total prompt tokens = input + cache.read + cache.write.
          const totalPrompt =
            part.tokens.input + part.tokens.cacheRead + part.tokens.cacheWrite
          const cacheHitRate = totalPrompt > 0 ? part.tokens.cacheRead / totalPrompt : 0
          steps.push({
            index: steps.length + 1,
            inputTokens: totalPrompt,
            outputTokens: part.tokens.output,
            reasoningTokens: part.tokens.reasoning,
            cacheRead: part.tokens.cacheRead,
            cacheWrite: part.tokens.cacheWrite,
            cost: part.cost,
            cacheHitRate,
          })
        }
      }
    }
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
    toolsByContextSize,
    toolsByDuration,
    individualCallsBySize,
    individualCallsByDuration,
    steps,
    messageCount: { user: userCount, assistant: assistantCount },
    totalDurationMs,
    hasTokenData,
    hasDurationData,
  }
}

function processToolCall(
  part: Extract<NormalizedPart, { type: 'tool-call' }>,
  toolGroupMap: Map<string, ToolGroup>,
  individualCalls: IndividualToolCall[],
  contextBreakdown: ContextBreakdown,
) {
  const inputStr = JSON.stringify(part.input)
  const outputStr = part.output

  contextBreakdown.toolOutputChars += outputStr.length
  contextBreakdown.toolInputChars += inputStr.length

  // Track individual call with a descriptive label
  const totalChars = inputStr.length + outputStr.length
  const individualLabel = buildIndividualLabel(part.name, part.input)
  individualCalls.push({
    label: individualLabel,
    toolName: part.name,
    totalChars,
    durationMs: part.durationMs,
  })

  // Group key: tool name (bash commands are already sub-categorized by the
  // platform normalization layer, e.g. "bash (git)")
  const groupKey = part.name

  const existing = toolGroupMap.get(groupKey)
  if (existing) {
    existing.totalOutputChars += outputStr.length
    existing.totalInputChars += inputStr.length
    existing.totalDurationMs += part.durationMs
    existing.count++
    if (part.durationMs > existing.maxDurationMs) existing.maxDurationMs = part.durationMs
  } else {
    toolGroupMap.set(groupKey, {
      label: groupKey,
      toolName: part.name,
      totalOutputChars: outputStr.length,
      totalInputChars: inputStr.length,
      totalDurationMs: part.durationMs,
      count: 1,
      maxDurationMs: part.durationMs,
    })
  }
}

// Build a descriptive label for an individual tool call. No truncation here;
// the renderer handles that based on available terminal width.
function buildIndividualLabel(toolName: string, input: Record<string, unknown>): string {
  const lower = toolName.toLowerCase()

  // Handle bash sub-categories like "bash (git)"
  if (lower.startsWith('bash')) {
    const cmd = typeof input.command === 'string' ? input.command.trim() : ''
    return `bash: ${cmd}`
  }

  if (lower === 'read') {
    const path = typeof input.filePath === 'string' ? input.filePath : ''
    return `read: ${path}`
  }

  if (lower === 'write') {
    const path = typeof input.filePath === 'string' ? input.filePath : ''
    return `write: ${path}`
  }

  if (lower === 'edit') {
    const path = typeof input.filePath === 'string' ? input.filePath : ''
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

  // Codex exec_command
  if (lower === 'exec_command') {
    const cmd = typeof input.cmd === 'string' ? input.cmd.trim() : ''
    return `exec: ${cmd}`
  }

  // Fallback: tool name + first string value from input
  const firstStr = Object.values(input).find((v) => typeof v === 'string')
  if (typeof firstStr === 'string') {
    return `${toolName}: ${firstStr}`
  }

  return toolName
}

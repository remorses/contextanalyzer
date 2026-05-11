// Core analysis engine. Takes message+parts arrays from the OpenCode SDK
// and produces structured analysis results for rendering.

import type { MessageWithParts, AssistantMessage, UserMessage } from './opencode-client.ts'
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

  // Track system message seen to avoid double counting across messages
  let systemMessageSeen = false

  for (const msg of messages) {
    const { info, parts } = msg

    if (info.role === 'user') {
      userCount++
      const userInfo = info as UserMessage

      // System message (only count once; it's roughly the same across turns)
      if (!systemMessageSeen && userInfo.system) {
        contextBreakdown.systemMessageChars = userInfo.system.length
        systemMessageSeen = true
      }

      if (userInfo.time.created < earliestTime) earliestTime = userInfo.time.created
      if (userInfo.time.created > latestTime) latestTime = userInfo.time.created

      // User text parts
      for (const part of parts) {
        if (part.type === 'text' && !('synthetic' in part && part.synthetic)) {
          const textPart = part as { type: 'text'; text: string }
          contextBreakdown.userTextChars += textPart.text.length
        }
      }
    }

    if (info.role === 'assistant') {
      assistantCount++
      const assistantInfo = info as AssistantMessage
      if (!modelId && assistantInfo.modelID) modelId = assistantInfo.modelID

      contextBreakdown.totalInputTokens += assistantInfo.tokens.input
      contextBreakdown.totalOutputTokens += assistantInfo.tokens.output
      contextBreakdown.totalReasoningTokens += assistantInfo.tokens.reasoning
      contextBreakdown.totalCacheRead += assistantInfo.tokens.cache.read
      contextBreakdown.totalCacheWrite += assistantInfo.tokens.cache.write
      contextBreakdown.totalCost += assistantInfo.cost

      if (assistantInfo.time.created < earliestTime) earliestTime = assistantInfo.time.created
      if (assistantInfo.time.completed && assistantInfo.time.completed > latestTime) {
        latestTime = assistantInfo.time.completed
      }

      for (const part of parts) {
        if (part.type === 'text') {
          const textPart = part as { type: 'text'; text: string }
          contextBreakdown.assistantTextChars += textPart.text.length
        }

        if (part.type === 'reasoning') {
          const reasoningPart = part as { type: 'reasoning'; text: string }
          contextBreakdown.reasoningChars += reasoningPart.text.length
        }

        if (part.type === 'tool') {
          processToolPart(part, toolGroupMap, individualCalls, contextBreakdown)
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
          // OpenCode reports `input` as only non-cached tokens.
          // Total prompt tokens = input + cache.read + cache.write.
          const totalPrompt = sf.tokens.input + sf.tokens.cache.read + sf.tokens.cache.write
          const cacheHitRate = totalPrompt > 0 ? sf.tokens.cache.read / totalPrompt : 0
          steps.push({
            index: steps.length + 1,
            inputTokens: totalPrompt,
            outputTokens: sf.tokens.output,
            reasoningTokens: sf.tokens.reasoning,
            cacheRead: sf.tokens.cache.read,
            cacheWrite: sf.tokens.cache.write,
            cost: sf.cost,
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
  }
}

function processToolPart(
  part: { type: 'tool'; tool: string; state: unknown; [key: string]: unknown },
  toolGroupMap: Map<string, ToolGroup>,
  individualCalls: IndividualToolCall[],
  contextBreakdown: ContextBreakdown,
) {
  const toolName = (part as { tool: string }).tool
  const state = part.state as {
    status: string
    input?: Record<string, unknown>
    output?: string
    time?: { start: number; end: number }
  }

  if (state.status !== 'completed' && state.status !== 'error') return

  const inputStr = state.input ? JSON.stringify(state.input) : ''
  // Error parts store their text in `error`, not `output`
  const outputStr = state.status === 'error'
    ? (state as { error?: string }).error || ''
    : state.output || ''
  const durationMs =
    state.time && state.time.end && state.time.start ? state.time.end - state.time.start : 0

  contextBreakdown.toolOutputChars += outputStr.length
  contextBreakdown.toolInputChars += inputStr.length

  // Track individual call with a descriptive label
  const totalChars = inputStr.length + outputStr.length
  const individualLabel = buildIndividualLabel(toolName, state.input)
  individualCalls.push({ label: individualLabel, toolName, totalChars, durationMs })

  // Determine group key: for bash, sub-categorize by first command
  let groupKey = toolName
  let bashCommand: string | undefined
  if (toolName === 'bash' || toolName === 'Bash') {
    const command = (state.input as Record<string, unknown>)?.command
    if (typeof command === 'string') {
      bashCommand = extractBashCommand(command)
      groupKey = `bash (${bashCommand})`
    }
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
      toolName,
      bashCommand,
      totalOutputChars: outputStr.length,
      totalInputChars: inputStr.length,
      totalDurationMs: durationMs,
      count: 1,
      maxDurationMs: durationMs,
    })
  }
}

const MAX_LABEL_LEN = 50

function truncate(s: string, max: number) {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function buildIndividualLabel(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return toolName

  const lower = toolName.toLowerCase()

  if (lower === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command.trim() : ''
    return truncate(`bash: ${cmd}`, MAX_LABEL_LEN)
  }

  if (lower === 'read') {
    const path = typeof input.filePath === 'string' ? input.filePath : ''
    const short = path.split('/').slice(-2).join('/')
    return truncate(`read: ${short}`, MAX_LABEL_LEN)
  }

  if (lower === 'write') {
    const path = typeof input.filePath === 'string' ? input.filePath : ''
    const short = path.split('/').slice(-2).join('/')
    return truncate(`write: ${short}`, MAX_LABEL_LEN)
  }

  if (lower === 'edit') {
    const path = typeof input.filePath === 'string' ? input.filePath : ''
    const short = path.split('/').slice(-2).join('/')
    return truncate(`edit: ${short}`, MAX_LABEL_LEN)
  }

  if (lower === 'glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    return truncate(`glob: ${pattern}`, MAX_LABEL_LEN)
  }

  if (lower === 'grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    return truncate(`grep: ${pattern}`, MAX_LABEL_LEN)
  }

  if (lower === 'webfetch') {
    const url = typeof input.url === 'string' ? input.url : ''
    return truncate(`webfetch: ${url}`, MAX_LABEL_LEN)
  }

  if (lower === 'websearch' || lower === 'googlesearch') {
    const query = typeof input.query === 'string' ? input.query : ''
    return truncate(`${lower}: ${query}`, MAX_LABEL_LEN)
  }

  if (lower === 'task') {
    const desc = typeof input.description === 'string' ? input.description : ''
    return truncate(`task: ${desc}`, MAX_LABEL_LEN)
  }

  if (lower === 'skill') {
    const name = typeof input.name === 'string' ? input.name : ''
    return truncate(`skill: ${name}`, MAX_LABEL_LEN)
  }

  // Fallback: tool name + first string value from input
  const firstStr = Object.values(input).find((v) => typeof v === 'string')
  if (typeof firstStr === 'string') {
    return truncate(`${toolName}: ${firstStr}`, MAX_LABEL_LEN)
  }

  return toolName
}

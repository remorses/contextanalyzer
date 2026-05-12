// Core analysis engine. Takes NormalizedMessage[] from any agent
// (OpenCode, Claude Code, Codex) and produces structured analysis
// results for rendering.

import type { NormalizedMessage, NormalizedPart } from './platform.ts'
import { extractBashCommand } from './bash-command.ts'

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

export type ToolGroup = {
  label: string
  totalOutputChars: number
  totalInputChars: number
  count: number
}

export type IndividualToolCall = {
  label: string
  totalChars: number
}

export type AnalysisResult = {
  sessionId: string
  modelId: string
  contextBreakdown: ContextBreakdown
  toolsByContextSize: ToolGroup[]
  individualCallsBySize: IndividualToolCall[]
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
  messages: NormalizedMessage[]
}): AnalysisResult {
  const contextBreakdown: ContextBreakdown = {
    systemMessageChars: 0,
    toolOutputChars: 0,
    toolInputChars: 0,
    assistantTextChars: 0,
    userTextChars: 0,
    reasoningChars: 0,
  }

  const toolGroupMap = new Map<string, ToolGroup>()
  const individualCalls: IndividualToolCall[] = []
  let userCount = 0
  let assistantCount = 0
  let modelId = ''
  let earliestTime = Infinity
  let latestTime = 0
  let systemMessageSeen = false

  for (const msg of messages) {
    if (msg.timestamp < earliestTime) earliestTime = msg.timestamp
    if (msg.timestamp > latestTime) latestTime = msg.timestamp

    if (msg.role === 'user') {
      userCount++

      if (!systemMessageSeen && msg.system) {
        contextBreakdown.systemMessageChars = msg.system.length
        systemMessageSeen = true
      }

      for (const part of msg.content) {
        if (part.type === 'text') {
          contextBreakdown.userTextChars += part.text.length
        }
      }
    }

    if (msg.role === 'assistant') {
      assistantCount++
      if (!modelId && msg.model) modelId = msg.model

      for (const part of msg.content) {
        if (part.type === 'text') {
          contextBreakdown.assistantTextChars += part.text.length
        }

        if (part.type === 'reasoning') {
          contextBreakdown.reasoningChars += part.text.length
        }

        if (part.type === 'tool-call') {
          processToolCall(part, toolGroupMap, individualCalls, contextBreakdown)
        }
      }
    }
  }

  const toolGroups = [...toolGroupMap.values()]
  const toolsByContextSize = [...toolGroups].sort(
    (a, b) => b.totalOutputChars + b.totalInputChars - (a.totalOutputChars + a.totalInputChars),
  )

  const individualCallsBySize = [...individualCalls]
    .sort((a, b) => b.totalChars - a.totalChars)
    .slice(0, 10)

  const totalDurationMs =
    latestTime !== 0 && earliestTime !== Infinity ? latestTime - earliestTime : 0

  return {
    sessionId,
    modelId,
    contextBreakdown,
    toolsByContextSize,
    individualCallsBySize,
    messageCount: { user: userCount, assistant: assistantCount },
    totalDurationMs,
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

  const totalChars = inputStr.length + outputStr.length
  const individualLabel = buildIndividualLabel(part.name, part.input)
  individualCalls.push({ label: individualLabel, totalChars })

  // Group key: tool name. Bash commands are sub-categorized.
  let groupKey = part.name
  const lower = part.name.toLowerCase()
  if ((lower === 'bash' || lower === 'execute') && typeof part.input.command === 'string') {
    const bashCmd = extractBashCommand(part.input.command)
    groupKey = `bash (${bashCmd})`
  }
  if (lower === 'exec_command' && typeof part.input.cmd === 'string') {
    const bashCmd = extractBashCommand(part.input.cmd)
    groupKey = `exec (${bashCmd})`
  }

  const existing = toolGroupMap.get(groupKey)
  if (existing) {
    existing.totalOutputChars += outputStr.length
    existing.totalInputChars += inputStr.length
    existing.count++
  } else {
    toolGroupMap.set(groupKey, {
      label: groupKey,
      totalOutputChars: outputStr.length,
      totalInputChars: inputStr.length,
      count: 1,
    })
  }
}

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

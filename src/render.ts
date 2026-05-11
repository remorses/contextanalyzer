// ASCII histogram and summary rendering for terminal output.

import { colors } from 'goke'
import type { AnalysisResult, ToolGroup, StepInfo, ContextBreakdown, IndividualToolCall } from './analyze.ts'

const BAR_WIDTH = 35
const BLOCK_CHARS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

function renderBar(value: number, maxValue: number, width = BAR_WIDTH): string {
  if (maxValue === 0) return ''
  const ratio = value / maxValue
  const fullBlocks = Math.floor(ratio * width)
  const remainder = (ratio * width - fullBlocks) * 8
  const partialChar = remainder > 0 ? BLOCK_CHARS[Math.floor(remainder)] || '' : ''
  return '█'.repeat(fullBlocks) + partialChar
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

function padRight(s: string, len: number) {
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}

function heading(title: string) {
  const line = '━'.repeat(70)
  return `\n${colors.bold(colors.cyan(title))}\n${colors.dim(line)}`
}

// ---------------------------------------------------------------------------
// Public render functions
// ---------------------------------------------------------------------------

export function renderAnalysis(result: AnalysisResult, { top = 15, showSteps = false }: { top?: number; showSteps?: boolean } = {}) {
  const lines: string[] = []

  lines.push(renderOverview(result))
  lines.push(renderContextBreakdown(result.contextBreakdown))
  lines.push(renderToolContextHistogram(result.toolsByContextSize, top))
  lines.push(renderToolDurationHistogram(result.toolsByDuration, top))
  if (result.individualCallsBySize.length > 0) {
    lines.push(renderIndividualCallsHistogram(result.individualCallsBySize, 'Biggest Individual Tool Calls (by context size)', 'chars', colors.yellow))
  }
  if (result.individualCallsByDuration.length > 0) {
    lines.push(renderIndividualCallsHistogram(result.individualCallsByDuration, 'Slowest Individual Tool Calls (by duration)', 'duration', colors.magenta))
  }
  if (showSteps && result.steps.length > 0) {
    lines.push(renderStepsTable(result.steps))
  }

  return lines.join('\n')
}

function renderOverview(result: AnalysisResult): string {
  const lines: string[] = []
  lines.push(heading('Session Overview'))

  const ctx = result.contextBreakdown
  // OpenCode reports `input` as non-cached tokens only.
  // Total prompt = input + cache.read + cache.write.
  const totalPromptTokens = ctx.totalInputTokens + ctx.totalCacheRead + ctx.totalCacheWrite

  const rows: [string, string][] = [
    ['Session', result.sessionId],
    ['Model', result.modelId || 'unknown'],
    ['Messages', `${result.messageCount.user} user, ${result.messageCount.assistant} assistant`],
    ['Duration', formatDuration(result.totalDurationMs)],
    ['Steps', String(result.steps.length)],
  ]

  if (ctx.totalCost > 0) {
    rows.push(['Total Cost', formatCost(ctx.totalCost)])
  }

  rows.push(
    ['Prompt Tokens', `${formatNumber(totalPromptTokens)} (${formatNumber(ctx.totalCacheRead)} cached, ${formatNumber(ctx.totalInputTokens)} uncached)`],
    ['Output Tokens', formatNumber(ctx.totalOutputTokens)],
  )

  if (ctx.totalReasoningTokens > 0) {
    rows.push(['Reasoning Tokens', formatNumber(ctx.totalReasoningTokens)])
  }

  rows.push(['Cache Write', formatNumber(ctx.totalCacheWrite)])

  for (const [label, value] of rows) {
    lines.push(`  ${colors.dim(padRight(label, 20))} ${value}`)
  }

  return lines.join('\n')
}

function renderContextBreakdown(ctx: ContextBreakdown): string {
  const lines: string[] = []
  lines.push(heading('Context Breakdown (by character size)'))

  const entries = [
    { label: 'System message', value: ctx.systemMessageChars },
    { label: 'Tool outputs', value: ctx.toolOutputChars },
    { label: 'Tool inputs', value: ctx.toolInputChars },
    { label: 'Assistant text', value: ctx.assistantTextChars },
    { label: 'User text', value: ctx.userTextChars },
    { label: 'Reasoning', value: ctx.reasoningChars },
  ].sort((a, b) => b.value - a.value)

  const totalChars = entries.reduce((s, e) => s + e.value, 0)
  const maxValue = entries[0]?.value || 1

  for (const entry of entries) {
    const pct = totalChars > 0 ? ((entry.value / totalChars) * 100).toFixed(1) : '0.0'
    const bar = renderBar(entry.value, maxValue)
    lines.push(
      `  ${padRight(entry.label, 18)} ${colors.green(padRight(bar, BAR_WIDTH + 1))} ${padRight(formatNumber(entry.value), 8)} ${colors.dim(`${pct}%`)}`,
    )
  }

  lines.push(
    `  ${colors.dim(padRight('Total', 18))} ${' '.repeat(BAR_WIDTH + 1)} ${padRight(formatNumber(totalChars), 8)} ${colors.dim('~' + formatNumber(Math.round(totalChars / 4)) + ' tokens')}`,
  )

  return lines.join('\n')
}

function renderToolContextHistogram(groups: ToolGroup[], top: number): string {
  const lines: string[] = []
  lines.push(heading('Tool Context Usage (output + input chars)'))

  const displayed = groups.slice(0, top)
  if (displayed.length === 0) {
    lines.push('  No tool calls found')
    return lines.join('\n')
  }

  const grandTotal = groups.reduce((s, g) => s + g.totalOutputChars + g.totalInputChars, 0)
  const maxValue = Math.max(...displayed.map((g) => g.totalOutputChars + g.totalInputChars))

  for (const group of displayed) {
    const total = group.totalOutputChars + group.totalInputChars
    const bar = renderBar(total, maxValue)
    const pct = grandTotal > 0 ? ((total / grandTotal) * 100).toFixed(1) : '0.0'
    const detail = `(${group.count} calls)`
    lines.push(
      `  ${padRight(group.label, 18)} ${colors.yellow(padRight(bar, BAR_WIDTH + 1))} ${padRight(formatNumber(total), 8)} ${colors.dim(padRight(`${pct}%`, 7))} ${colors.dim(detail)}`,
    )
  }

  if (groups.length > top) {
    lines.push(colors.dim(`  ... and ${groups.length - top} more`))
  }

  return lines.join('\n')
}

function renderToolDurationHistogram(groups: ToolGroup[], top: number): string {
  const lines: string[] = []
  lines.push(heading('Tool Calls by Duration'))

  const displayed = groups.slice(0, top)
  if (displayed.length === 0) {
    lines.push('  No tool calls with timing data')
    return lines.join('\n')
  }

  const grandTotal = groups.reduce((s, g) => s + g.totalDurationMs, 0)
  const maxValue = Math.max(...displayed.map((g) => g.totalDurationMs))

  for (const group of displayed) {
    const bar = renderBar(group.totalDurationMs, maxValue)
    const pct = grandTotal > 0 ? ((group.totalDurationMs / grandTotal) * 100).toFixed(1) : '0.0'
    const avg = group.count > 0 ? group.totalDurationMs / group.count : 0
    const detail = `(${group.count} calls, avg ${formatDuration(avg)}, max ${formatDuration(group.maxDurationMs)})`
    lines.push(
      `  ${padRight(group.label, 18)} ${colors.magenta(padRight(bar, BAR_WIDTH + 1))} ${padRight(formatDuration(group.totalDurationMs), 8)} ${colors.dim(padRight(`${pct}%`, 7))} ${colors.dim(detail)}`,
    )
  }

  if (groups.length > top) {
    lines.push(colors.dim(`  ... and ${groups.length - top} more`))
  }

  return lines.join('\n')
}

function renderIndividualCallsHistogram(
  calls: IndividualToolCall[],
  title: string,
  mode: 'chars' | 'duration',
  colorFn: (s: string) => string,
): string {
  const lines: string[] = []
  lines.push(heading(title))

  if (calls.length === 0) {
    lines.push('  No tool calls found')
    return lines.join('\n')
  }

  // Total line budget ~110 chars. Bar(16) + value(8) + pct(6) + spacing(6) = 36.
  // Rest goes to the label.
  const termWidth = process.stdout.columns || 120
  const INDIVIDUAL_BAR_WIDTH = 16
  const INDIVIDUAL_LABEL_WIDTH = Math.max(40, termWidth - 2 - INDIVIDUAL_BAR_WIDTH - 1 - 8 - 1 - 6)
  const getValue = (c: IndividualToolCall) => mode === 'chars' ? c.totalChars : c.durationMs
  const formatValue = (v: number) => mode === 'chars' ? formatNumber(v) : formatDuration(v)
  const maxValue = Math.max(...calls.map(getValue))
  const grandTotal = calls.reduce((s, c) => s + getValue(c), 0)

  for (const call of calls) {
    const value = getValue(call)
    const bar = renderBar(value, maxValue, INDIVIDUAL_BAR_WIDTH)
    const pct = grandTotal > 0 ? ((value / grandTotal) * 100).toFixed(1) : '0.0'
    const label = call.label.length > INDIVIDUAL_LABEL_WIDTH
      ? call.label.slice(0, INDIVIDUAL_LABEL_WIDTH - 1) + '…'
      : call.label
    lines.push(
      `  ${padRight(label, INDIVIDUAL_LABEL_WIDTH)} ${colorFn(padRight(bar, INDIVIDUAL_BAR_WIDTH + 1))} ${padRight(formatValue(value), 8)} ${colors.dim(`${pct}%`)}`,
    )
  }

  return lines.join('\n')
}

function renderStepsTable(steps: StepInfo[]): string {
  const lines: string[] = []
  lines.push(heading('Per-Step Token Breakdown'))

  const hasCost = steps.some((s) => s.cost > 0)
  const hasReasoning = steps.some((s) => s.reasoningTokens > 0)

  let header = `  ${colors.dim(padRight('#', 4))} ${colors.dim(padRight('Input', 10))} ${colors.dim(padRight('Output', 10))}`
  if (hasReasoning) header += ` ${colors.dim(padRight('Reasoning', 10))}`
  header += ` ${colors.dim(padRight('Cache%', 8))}`
  if (hasCost) header += ` ${colors.dim(padRight('Cost', 8))}`
  lines.push(header)

  for (const step of steps) {
    const cachePercent = (step.cacheHitRate * 100).toFixed(0) + '%'
    let row = `  ${padRight(String(step.index), 4)} ${padRight(formatNumber(step.inputTokens), 10)} ${padRight(formatNumber(step.outputTokens), 10)}`
    if (hasReasoning) row += ` ${padRight(formatNumber(step.reasoningTokens), 10)}`
    row += ` ${padRight(cachePercent, 8)}`
    if (hasCost) row += ` ${padRight(formatCost(step.cost), 8)}`
    lines.push(row)
  }

  return lines.join('\n')
}

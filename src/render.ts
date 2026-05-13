// ASCII histogram and summary rendering for terminal output.
// All histogram sections share a single `renderHistogram` renderer
// to keep layout consistent and avoid duplicated padding/bar logic.

import { colors } from 'goke'
import type { AnalysisResult, ContextBreakdown, TokenUsage, ToolGroup, IndividualToolCall, StepInfo } from './analyze.ts'

// Only use █ (full block) and ▌ (left half block). The eighth-width
// partial characters (▏▎▍▋▊▉) show visible gaps in most terminal fonts
// because they don't fill the full cell height.
function renderBar(value: number, maxValue: number, width: number): string {
  if (maxValue === 0) return ''
  const ratio = value / maxValue
  const totalHalves = Math.round(ratio * width * 2)
  const fullBlocks = Math.floor(totalHalves / 2)
  const hasHalf = totalHalves % 2 === 1
  return '█'.repeat(fullBlocks) + (hasHalf ? '▌' : '')
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

function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function truncateLabel(s: string, width: number): string {
  const text = singleLine(s)
  if (text.length <= width) return text
  if (width <= 1) return '…'
  return text.slice(0, width - 1) + '…'
}

// ---------------------------------------------------------------------------
// Reusable histogram renderer
// ---------------------------------------------------------------------------

type HistogramRow = {
  label: string
  value: number
  detail?: string
}

type HistogramConfig = {
  title: string
  rows: HistogramRow[]
  grandTotal?: number
  barColor: (s: string) => string
  formatValue: (value: number) => string
  labelWidth: number
  barWidth: number
  headers?: [string, string]
  emptyMessage?: string
  moreCount?: number
}

function renderHistogram({
  title,
  rows,
  grandTotal,
  barColor,
  formatValue,
  labelWidth,
  barWidth,
  headers,
  emptyMessage = 'No data found',
  moreCount = 0,
}: HistogramConfig): string {
  const lines: string[] = []
  lines.push(heading(title))

  if (rows.length === 0) {
    lines.push(`  ${emptyMessage}`)
    return lines.join('\n')
  }

  if (headers) {
    const [labelHeader, valueHeader] = headers
    lines.push(
      `  ${colors.dim(padRight(labelHeader, labelWidth))} ${colors.dim(padRight('', barWidth))} ${colors.dim(padRight(valueHeader, 8))} ${colors.dim(padRight('%', 7))}`,
    )
  }

  const total = grandTotal ?? rows.reduce((sum, row) => sum + row.value, 0)
  const maxValue = rows.reduce((max, row) => Math.max(max, row.value), 0)

  for (const row of rows) {
    const label = truncateLabel(row.label, labelWidth)
    const bar = renderBar(row.value, maxValue, barWidth)
    const pct = total > 0 ? ((row.value / total) * 100).toFixed(1) : '0.0'
    const detail = row.detail ? ` ${colors.dim(singleLine(row.detail))}` : ''

    lines.push(
      `  ${padRight(label, labelWidth)} ${barColor(padRight(bar, barWidth))} ${padRight(formatValue(row.value), 8)} ${colors.dim(padRight(`${pct}%`, 7))}${detail}`,
    )
  }

  if (moreCount > 0) {
    lines.push(colors.dim(`  ... and ${moreCount} more`))
  }

  return lines.join('\n')
}

function autoLabelWidth(labels: string[], min: number, max: number): number {
  const longest = labels.reduce((m, l) => Math.max(m, singleLine(l).length), 0)
  return Math.min(max, Math.max(min, longest + 2))
}

// ---------------------------------------------------------------------------
// Public render
// ---------------------------------------------------------------------------

export function renderAnalysis(result: AnalysisResult, { top = 15, showSteps = false }: { top?: number; showSteps?: boolean } = {}) {
  const lines: string[] = []

  lines.push(renderOverview(result))
  lines.push(renderContextBreakdown(result.contextBreakdown))
  lines.push(renderToolContextHistogram(result.toolsByContextSize, top))
  lines.push(renderToolDurationHistogram(result.toolsByDuration, top))

  if (result.individualCallsBySize.length > 0) {
    lines.push(renderIndividualCallsHistogram(result.individualCallsBySize, 'Biggest Individual Tool Calls', 'chars', top))
  }

  if (result.individualCallsByDuration.length > 0) {
    lines.push(renderIndividualCallsHistogram(result.individualCallsByDuration, 'Slowest Individual Tool Calls', 'duration', top))
  }

  if (showSteps && result.steps.length > 0) {
    lines.push(renderStepsTable(result.steps))
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderOverview(result: AnalysisResult): string {
  const lines: string[] = []
  lines.push(heading('Session Overview'))

  const t = result.tokenUsage

  const rows: [string, string][] = [
    ['Session', result.sessionId],
    ['Model', result.modelId || 'unknown'],
    ['Messages', `${result.messageCount.user} user, ${result.messageCount.assistant} assistant`],
    ['Duration', formatDuration(result.totalDurationMs)],
    ['Steps', String(result.steps.length)],
  ]

  if (t.totalCost > 0) {
    rows.push(['Total Cost', formatCost(t.totalCost)])
  }

  rows.push(
    ['Prompt Tokens', `${formatNumber(t.totalPromptTokens)} (${formatNumber(t.cacheRead)} cached, ${formatNumber(t.inputTokens)} uncached)`],
    ['Output Tokens', formatNumber(t.outputTokens)],
  )

  if (t.reasoningTokens > 0) {
    rows.push(['Reasoning Tokens', formatNumber(t.reasoningTokens)])
  }

  rows.push(
    ['Cache Write', formatNumber(t.cacheWrite)],
    ['Total Tokens', colors.bold(formatNumber(t.totalTokens))],
  )

  for (const [label, value] of rows) {
    lines.push(`  ${colors.dim(padRight(label, 20))} ${value}`)
  }

  return lines.join('\n')
}

function renderContextBreakdown(ctx: ContextBreakdown): string {
  const charsToTokens = (chars: number) => Math.round(chars / 4)

  const entries = [
    { label: 'System message', value: charsToTokens(ctx.systemMessageChars) },
    { label: 'Tool outputs', value: charsToTokens(ctx.toolOutputChars) },
    { label: 'Tool inputs', value: charsToTokens(ctx.toolInputChars) },
    { label: 'Assistant text', value: charsToTokens(ctx.assistantTextChars) },
    { label: 'User text', value: charsToTokens(ctx.userTextChars) },
    { label: 'Reasoning', value: charsToTokens(ctx.reasoningChars) },
  ].sort((a, b) => b.value - a.value)

  const totalTokens = entries.reduce((s, e) => s + e.value, 0)

  const result = renderHistogram({
    title: 'Context Breakdown (estimated tokens from chars)',
    rows: entries,
    barColor: colors.green,
    formatValue: formatNumber,
    labelWidth: 18,
    barWidth: 35,
    headers: ['Category', 'Tokens'],
  })

  const totalLine = `  ${colors.dim(padRight('Total', 18))} ${' '.repeat(35)} ${padRight(formatNumber(totalTokens), 8)}`
  return result + '\n' + totalLine
}

function renderToolContextHistogram(groups: ToolGroup[], top: number): string {
  const charsToTokens = (chars: number) => Math.round(chars / 4)
  const displayed = groups.slice(0, top)
  const grandTotal = charsToTokens(groups.reduce((s, g) => s + g.totalOutputChars + g.totalInputChars, 0))
  const labelW = autoLabelWidth(displayed.map((g) => g.label), 18, 30)

  return renderHistogram({
    title: 'Tool Context Usage (output + input tokens)',
    rows: displayed.map((g) => ({
      label: g.label,
      value: charsToTokens(g.totalOutputChars + g.totalInputChars),
      detail: `(${g.count} calls)`,
    })),
    grandTotal,
    barColor: colors.yellow,
    formatValue: formatNumber,
    labelWidth: labelW,
    barWidth: 35,
    headers: ['Tool', 'Tokens'],
    emptyMessage: 'No tool calls found',
    moreCount: Math.max(0, groups.length - top),
  })
}

function renderToolDurationHistogram(groups: ToolGroup[], top: number): string {
  const displayed = groups.slice(0, top)
  const grandTotal = groups.reduce((s, g) => s + g.totalDurationMs, 0)
  const labelW = autoLabelWidth(displayed.map((g) => g.label), 18, 30)

  return renderHistogram({
    title: 'Tool Calls by Duration',
    rows: displayed.map((g) => {
      const avg = g.count > 0 ? g.totalDurationMs / g.count : 0
      return {
        label: g.label,
        value: g.totalDurationMs,
        detail: `(${g.count} calls, avg ${formatDuration(avg)}, max ${formatDuration(g.maxDurationMs)})`,
      }
    }),
    grandTotal,
    barColor: colors.magenta,
    formatValue: formatDuration,
    labelWidth: labelW,
    barWidth: 35,
    headers: ['Tool', 'Duration'],
    emptyMessage: 'No tool calls with timing data',
    moreCount: Math.max(0, groups.length - top),
  })
}

function renderIndividualCallsHistogram(
  calls: IndividualToolCall[],
  title: string,
  mode: 'chars' | 'duration',
  top: number,
): string {
  const charsToTokens = (chars: number) => Math.round(chars / 4)
  const displayed = calls.slice(0, top)
  const termWidth = process.stdout.columns || 120
  const labelW = Math.min(70, Math.floor(termWidth * 0.55))
  const barW = Math.min(20, Math.max(8, termWidth - 2 - labelW - 1 - 8 - 1 - 7))

  const getValue = (c: IndividualToolCall) => mode === 'chars' ? charsToTokens(c.totalChars) : c.durationMs
  const fmtValue = (v: number) => mode === 'chars' ? formatNumber(v) : formatDuration(v)
  const barClr = mode === 'chars' ? colors.yellow : colors.magenta

  return renderHistogram({
    title,
    rows: displayed.map((c) => ({
      label: c.label,
      value: getValue(c),
    })),
    barColor: barClr,
    formatValue: fmtValue,
    labelWidth: labelW,
    barWidth: barW,
    headers: ['Call', mode === 'chars' ? 'Tokens' : 'Duration'],
    emptyMessage: 'No tool calls found',
  })
}

function renderStepsTable(steps: StepInfo[]): string {
  const lines: string[] = []
  lines.push(heading('Per-Step Token Breakdown'))

  const hasCost = steps.some((s) => s.cost > 0)
  const hasReasoning = steps.some((s) => s.reasoningTokens > 0)

  let header = `  ${colors.dim(padRight('#', 4))} ${colors.dim(padRight('Prompt', 10))} ${colors.dim(padRight('Output', 10))}`
  if (hasReasoning) header += ` ${colors.dim(padRight('Reasoning', 10))}`
  header += ` ${colors.dim(padRight('Cache%', 8))}`
  if (hasCost) header += ` ${colors.dim(padRight('Cost', 8))}`
  lines.push(header)

  for (const step of steps) {
    const cachePercent = (step.cacheHitRate * 100).toFixed(0) + '%'
    let row = `  ${padRight(String(step.index), 4)} ${padRight(formatNumber(step.promptTokens), 10)} ${padRight(formatNumber(step.outputTokens), 10)}`
    if (hasReasoning) row += ` ${padRight(formatNumber(step.reasoningTokens), 10)}`
    row += ` ${padRight(cachePercent, 8)}`
    if (hasCost) row += ` ${padRight(formatCost(step.cost), 8)}`
    lines.push(row)
  }

  return lines.join('\n')
}

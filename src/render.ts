// ASCII histogram and summary rendering for terminal output.
// All histogram sections share a single `renderHistogram` renderer
// to keep layout consistent and avoid duplicated padding/bar logic.

import { colors } from 'goke'
import type { AnalysisResult, ContextBreakdown, ToolGroup, IndividualToolCall } from './analyze.ts'

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

export function renderAnalysis(result: AnalysisResult, { top = 15 }: { top?: number } = {}) {
  const lines: string[] = []

  lines.push(renderOverview(result))
  lines.push(renderContextBreakdown(result.contextBreakdown))
  lines.push(renderToolContextHistogram(result.toolsByContextSize, top))

  if (result.individualCallsBySize.length > 0) {
    lines.push(renderIndividualCallsHistogram(result.individualCallsBySize, top))
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderOverview(result: AnalysisResult): string {
  const lines: string[] = []
  lines.push(heading('Session Overview'))

  const rows: [string, string][] = [
    ['Session', result.sessionId],
    ['Model', result.modelId || 'unknown'],
    ['Messages', `${result.messageCount.user} user, ${result.messageCount.assistant} assistant`],
    ['Duration', formatDuration(result.totalDurationMs)],
  ]

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
    title: 'Context Breakdown (estimated tokens)',
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

function renderIndividualCallsHistogram(calls: IndividualToolCall[], top: number): string {
  const charsToTokens = (chars: number) => Math.round(chars / 4)
  const displayed = calls.slice(0, top)
  const termWidth = process.stdout.columns || 120
  const labelW = Math.min(70, Math.floor(termWidth * 0.55))
  const barW = Math.min(20, Math.max(8, termWidth - 2 - labelW - 1 - 8 - 1 - 7))

  return renderHistogram({
    title: 'Biggest Individual Tool Calls',
    rows: displayed.map((c) => ({
      label: c.label,
      value: charsToTokens(c.totalChars),
    })),
    barColor: colors.yellow,
    formatValue: formatNumber,
    labelWidth: labelW,
    barWidth: barW,
    headers: ['Call', 'Tokens'],
    emptyMessage: 'No tool calls found',
  })
}

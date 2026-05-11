// ASCII histogram and summary rendering for terminal output.
// All histogram sections share a single `renderHistogram` renderer
// to keep layout consistent and avoid duplicated padding/bar logic.

import { colors } from 'goke'
import type { AnalysisResult, ToolGroup, StepInfo, ContextBreakdown, IndividualToolCall } from './analyze.ts'

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

/** Collapse newlines and excess whitespace into a single space. */
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
  /** Total for percentage calculation. Defaults to sum of displayed rows. */
  grandTotal?: number
  barColor: (s: string) => string
  formatValue: (value: number) => string
  labelWidth: number
  barWidth: number
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
  emptyMessage = 'No data found',
  moreCount = 0,
}: HistogramConfig): string {
  const lines: string[] = []
  lines.push(heading(title))

  if (rows.length === 0) {
    lines.push(`  ${emptyMessage}`)
    return lines.join('\n')
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

/** Auto-size label width from displayed data, clamped between min and max. */
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

// ---------------------------------------------------------------------------
// Section renderers (all delegate to renderHistogram)
// ---------------------------------------------------------------------------

function renderOverview(result: AnalysisResult): string {
  const lines: string[] = []
  lines.push(heading('Session Overview'))

  const ctx = result.contextBreakdown
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
  const entries = [
    { label: 'System message', value: ctx.systemMessageChars },
    { label: 'Tool outputs', value: ctx.toolOutputChars },
    { label: 'Tool inputs', value: ctx.toolInputChars },
    { label: 'Assistant text', value: ctx.assistantTextChars },
    { label: 'User text', value: ctx.userTextChars },
    { label: 'Reasoning', value: ctx.reasoningChars },
  ].sort((a, b) => b.value - a.value)

  const totalChars = entries.reduce((s, e) => s + e.value, 0)

  const result = renderHistogram({
    title: 'Context Breakdown (by character size)',
    rows: entries,
    barColor: colors.green,
    formatValue: formatNumber,
    labelWidth: 18,
    barWidth: 35,
  })

  // Append total line
  const totalLine = `  ${colors.dim(padRight('Total', 18))} ${' '.repeat(35)} ${padRight(formatNumber(totalChars), 8)} ${colors.dim('~' + formatNumber(Math.round(totalChars / 4)) + ' tokens')}`
  return result + '\n' + totalLine
}

function renderToolContextHistogram(groups: ToolGroup[], top: number): string {
  const displayed = groups.slice(0, top)
  const grandTotal = groups.reduce((s, g) => s + g.totalOutputChars + g.totalInputChars, 0)
  const labelW = autoLabelWidth(displayed.map((g) => g.label), 18, 30)

  return renderHistogram({
    title: 'Tool Context Usage (output + input chars)',
    rows: displayed.map((g) => ({
      label: g.label,
      value: g.totalOutputChars + g.totalInputChars,
      detail: `(${g.count} calls)`,
    })),
    grandTotal,
    barColor: colors.yellow,
    formatValue: formatNumber,
    labelWidth: labelW,
    barWidth: 35,
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
    emptyMessage: 'No tool calls with timing data',
    moreCount: Math.max(0, groups.length - top),
  })
}

function renderIndividualCallsHistogram(
  calls: IndividualToolCall[],
  title: string,
  mode: 'chars' | 'duration',
  colorFn: (s: string) => string,
): string {
  const termWidth = process.stdout.columns || 120
  const labelW = Math.min(70, Math.floor(termWidth * 0.55))
  const barW = Math.min(20, Math.max(8, termWidth - 2 - labelW - 1 - 8 - 1 - 7))

  return renderHistogram({
    title,
    rows: calls.map((c) => ({
      label: c.label,
      value: mode === 'chars' ? c.totalChars : c.durationMs,
    })),
    barColor: colorFn,
    formatValue: mode === 'chars' ? formatNumber : formatDuration,
    labelWidth: labelW,
    barWidth: barW,
    emptyMessage: 'No tool calls found',
  })
}

// ---------------------------------------------------------------------------
// Steps table (not a histogram, kept separate)
// ---------------------------------------------------------------------------

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

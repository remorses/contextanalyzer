// Extract the first command name from a bash command string using just-bash parser.
// Falls back to simple word splitting if parsing fails.

import { parse } from 'just-bash'

export function extractBashCommand(command: string): string {
  // Try parsing with just-bash first
  const parsed = (() => {
    try {
      return parse(command)
    } catch {
      return null
    }
  })()

  const firstCommand = parsed?.statements[0]?.pipelines[0]?.commands[0]
  if (firstCommand?.type === 'SimpleCommand' && firstCommand.name) {
    const name = extractWordText(firstCommand.name)
    if (name) return name
  }

  // Fallback: extract first word, skipping env var assignments (VAR=value)
  return extractFirstWordFallback(command)
}

function extractWordText(word: { parts: Array<{ type: string; value?: string }> }): string {
  return word.parts
    .map((p) => {
      if (p.type === 'Literal' && p.value) return p.value
      return ''
    })
    .join('')
}

function extractFirstWordFallback(command: string): string {
  const trimmed = command.trim()
  const words = trimmed.split(/\s+/)
  for (const word of words) {
    // Skip env var assignments like VAR=value
    if (word.includes('=') && !word.startsWith('=')) continue
    // Skip common shell prefixes
    if (word === 'sudo' || word === 'env' || word === 'nice' || word === 'time') continue
    return word
  }
  return words[0] || 'unknown'
}

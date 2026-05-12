#!/usr/bin/env node
// contextanalyzer - Analyze session context usage and tool call performance
// for OpenCode, Claude Code, and Codex. All agents connect via the ACP
// protocol (Agent Client Protocol) over stdio.

import { goke, isAgent } from 'goke'
import { z } from 'zod'
import module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import * as clack from '@clack/prompts'
import { PLATFORM_IDS, PLATFORM_LABELS, type PlatformId } from './platform.ts'
import { connectAcp, listSessions, fetchMessages, disconnect, type SpawnConfig } from './acp-client.ts'
import { analyzeSession } from './analyze.ts'
import { renderAnalysis } from './render.ts'

// ---------------------------------------------------------------------------
// Agent spawn configs — the only thing that differs between agents
// ---------------------------------------------------------------------------

function getSpawnConfig(id: PlatformId): SpawnConfig {
  switch (id) {
    case 'opencode':
      // OpenCode has a built-in ACP server: `opencode acp`
      return { cmd: 'opencode', args: ['acp'] }

    case 'claude-code': {
      // claude-agent-acp is a Node.js entry point
      const req = module.createRequire(import.meta.url)
      const bin = req.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')
      return { cmd: process.execPath, args: [bin] }
    }

    case 'codex': {
      // codex-acp ships a native Rust binary. Resolve it directly instead
      // of going through the JS wrapper (which uses spawnSync and hangs).
      const req = module.createRequire(import.meta.url)
      const wrapperPath = req.resolve('@zed-industries/codex-acp/bin/codex-acp.js')

      const platform = process.platform
      const arch = process.arch
      const platformMap: Record<string, Record<string, string>> = {
        darwin: { arm64: 'codex-acp-darwin-arm64', x64: 'codex-acp-darwin-x64' },
        linux: { arm64: 'codex-acp-linux-arm64', x64: 'codex-acp-linux-x64' },
        win32: { arm64: 'codex-acp-win32-arm64', x64: 'codex-acp-win32-x64' },
      }

      const packages = platformMap[platform]
      if (!packages) throw new Error(`Unsupported platform: ${platform}`)
      const pkgName = packages[arch]
      if (!pkgName) throw new Error(`Unsupported arch: ${arch} on ${platform}`)

      const binaryName = platform === 'win32' ? 'codex-acp.exe' : 'codex-acp'
      const realWrapper = fs.realpathSync(wrapperPath)
      const nativeReq = module.createRequire(realWrapper)
      const nativeBin = nativeReq.resolve(`@zed-industries/${pkgName}/bin/${binaryName}`)

      return { cmd: nativeBin, args: [] }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cli = goke('contextanalyzer')

cli
  .command('[sessionId]', 'Analyze context usage for a coding agent session')
  .option('--cwd [cwd]', z.string().optional().describe('Working directory'))
  .option('--agent [agent]', z.enum(PLATFORM_IDS).optional().describe('Agent: opencode, claude-code, codex'))
  .option('--top [top]', z.number().default(15).describe('Max items in histograms'))
  .option('--json', 'Output raw analysis as JSON')
  .action(async (sessionId, options) => {
    const cwd = path.resolve(options.cwd || process.cwd())
    const useStderr = options.json

    const log = {
      intro: (msg: string) => { if (!useStderr) clack.intro(msg) },
      error: (msg: string) => { useStderr ? process.stderr.write(msg + '\n') : clack.log.error(msg) },
      warn: (msg: string) => { useStderr ? process.stderr.write(msg + '\n') : clack.log.warn(msg) },
      info: (msg: string) => { useStderr ? process.stderr.write(msg + '\n') : clack.log.info(msg) },
      message: (msg: string) => { useStderr ? process.stderr.write(msg + '\n') : clack.log.message(msg) },
      outro: (msg: string) => { if (!useStderr) clack.outro(msg) },
    }

    const spinner = useStderr
      ? { start(_msg: string) {}, stop(_msg: string) {} }
      : clack.spinner()

    log.intro('contextanalyzer')

    // --------------- Agent selection ---------------

    let agentId = options.agent as PlatformId | undefined

    if (!agentId) {
      if (isAgent || !process.stdin.isTTY) {
        log.error('No --agent provided. Pass --agent opencode, --agent claude-code, or --agent codex')
        process.exitCode = 1
        return
      }

      const choice = await clack.select({
        message: 'Which agent do you want to analyze?',
        options: PLATFORM_IDS.map((id) => ({ value: id, label: PLATFORM_LABELS[id] })),
      })

      if (clack.isCancel(choice)) { clack.cancel('Cancelled'); return }
      agentId = choice
    }

    const spawnConfig = getSpawnConfig(agentId)
    const agentName = PLATFORM_LABELS[agentId]

    // --------------- Connect ---------------

    spinner.start(`Connecting to ${agentName}...`)

    const conn = await connectAcp({ ...spawnConfig, cwd })
    if (conn instanceof Error) {
      spinner.stop('Failed to connect')
      log.error(conn.message)
      process.exitCode = 1
      return
    }

    try {
      spinner.stop(`Connected to ${agentName}`)

      // --------------- Session selection ---------------

      let selectedSessionId = sessionId as string | undefined
      if (!selectedSessionId) {
        spinner.start('Fetching sessions...')
        const sessions = await listSessions(conn, { cwd })
        if (sessions instanceof Error) {
          spinner.stop('Failed')
          log.error(sessions.message)
          process.exitCode = 1
          return
        }

        if (sessions.length === 0) {
          spinner.stop('No sessions found')
          log.warn('No sessions found. Try passing --cwd.')
          process.exitCode = 1
          return
        }

        spinner.stop(`Found ${sessions.length} sessions`)

        if (isAgent || !process.stdin.isTTY) {
          log.error('No session ID provided. Pass it as an argument.')
          log.info('Available sessions:')
          for (const s of sessions.slice(0, 20)) {
            const date = new Date(s.updatedAt).toLocaleString()
            log.message(`  ${s.id}  ${s.title || '(untitled)'}  ${date}`)
          }
          process.exitCode = 1
          return
        }

        const sessionOptions = sessions.slice(0, 30).map((s) => {
          const date = new Date(s.updatedAt).toLocaleString()
          const title = s.title || '(untitled)'
          return { value: s.id, label: `${title}  ${s.id.slice(0, 16)}...  ${date}` }
        })

        const choice = await clack.select({ message: 'Select a session', options: sessionOptions })
        if (clack.isCancel(choice)) { clack.cancel('Cancelled'); return }
        selectedSessionId = choice
      }

      // --------------- Fetch and analyze ---------------

      spinner.start(`Loading session ${selectedSessionId}...`)
      const messages = await fetchMessages(conn, { sessionId: selectedSessionId, cwd })
      if (messages instanceof Error) {
        spinner.stop('Failed')
        log.error(messages.message)
        process.exitCode = 1
        return
      }

      spinner.stop(`Loaded ${messages.length} messages`)

      const result = analyzeSession({ sessionId: selectedSessionId, messages })

      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(renderAnalysis(result, { top: options.top }))
      }

      log.outro('Done')
    } finally {
      disconnect(conn)
    }
  })

cli.help()
cli.version('0.1.0')
cli.parse()

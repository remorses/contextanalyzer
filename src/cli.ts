#!/usr/bin/env node
// contextanalyzer - Analyze session context usage and tool call performance
// for OpenCode, Claude Code, and Codex. Connects to each agent via its
// native protocol, lists sessions, and renders terminal histograms showing
// where context tokens and wall-clock time are spent.

import { goke, isAgent } from 'goke'
import { z } from 'zod'
import * as clack from '@clack/prompts'
import module from 'node:module'
import { PLATFORM_IDS, PLATFORM_LABELS, type Platform, type PlatformId } from './platform.ts'
import { createOpencodePlatform } from './opencode-client.ts'
import { startAcpPlatform } from './acp-client.ts'
import { analyzeSession } from './analyze.ts'
import { renderAnalysis } from './render.ts'

// ---------------------------------------------------------------------------
// Platform factory
// ---------------------------------------------------------------------------

function createPlatform(id: PlatformId): Platform {
  switch (id) {
    case 'opencode':
      return createOpencodePlatform()

    case 'claude-code':
      return startAcpPlatform({
        id: 'claude-code',
        name: 'Claude Code',
        resolveBin() {
          // claude-agent-acp is a Node.js entry point, spawned with node
          const req = module.createRequire(import.meta.url)
          return {
            path: req.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'),
            isNative: false,
          }
        },
      })

    case 'codex':
      return startAcpPlatform({
        id: 'codex',
        name: 'Codex',
        resolveBin() {
          // codex-acp ships a native Rust binary. The JS wrapper uses
          // spawnSync(stdio:'inherit') which hangs when used as a child
          // process, so we resolve the native binary directly.
          const req = module.createRequire(import.meta.url)
          const wrapperPath = req.resolve('@zed-industries/codex-acp/bin/codex-acp.js')

          const fs = require('node:fs') as typeof import('node:fs')
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

          return { path: nativeBin, isNative: true }
        },
      })
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cli = goke('contextanalyzer')

cli
  .command('[sessionId]', 'Analyze context usage for a coding agent session')
  .option(
    '--cwd [cwd]',
    z.string().optional().describe('Working directory for agent server'),
  )
  .option(
    '--agent [agent]',
    z
      .enum(PLATFORM_IDS)
      .optional()
      .describe('Which agent to analyze: opencode, claude-code, codex'),
  )
  .option('--top [top]', z.number().default(15).describe('Max items in histograms'))
  .option('--json', 'Output raw analysis as JSON')
  .option('--steps', 'Show per-step token breakdown table')
  .action(async (sessionId, options) => {
    let platform: Platform | null = null

    try {
      const cwd = options.cwd || process.cwd()

      // In JSON mode, redirect clack UI to stderr so stdout is clean JSON
      const useStderr = options.json

      const log = {
        intro(msg: string) {
          if (!useStderr) clack.intro(msg)
        },
        error(msg: string) {
          if (useStderr) process.stderr.write(msg + '\n')
          else clack.log.error(msg)
        },
        warn(msg: string) {
          if (useStderr) process.stderr.write(msg + '\n')
          else clack.log.warn(msg)
        },
        info(msg: string) {
          if (useStderr) process.stderr.write(msg + '\n')
          else clack.log.info(msg)
        },
        message(msg: string) {
          if (useStderr) process.stderr.write(msg + '\n')
          else clack.log.message(msg)
        },
        outro(msg: string) {
          if (!useStderr) clack.outro(msg)
        },
      }

      const spinner = useStderr
        ? { start(_msg: string) {}, stop(_msg: string) {} }
        : clack.spinner()

      log.intro('contextanalyzer')

      // --------------- Platform selection ---------------

      let agentId = options.agent as PlatformId | undefined

      if (!agentId) {
        if (isAgent || !process.stdin.isTTY) {
          log.error(
            'No --agent provided. Pass --agent opencode, --agent claude-code, or --agent codex',
          )
          process.exitCode = 1
          return
        }

        const choice = await clack.select({
          message: 'Which agent do you want to analyze?',
          options: PLATFORM_IDS.map((id) => ({
            value: id,
            label: PLATFORM_LABELS[id],
          })),
        })

        if (clack.isCancel(choice)) {
          clack.cancel('Cancelled')
          return
        }

        agentId = choice
      }

      platform = createPlatform(agentId)

      // --------------- Connect ---------------

      spinner.start(`Connecting to ${platform.name}...`)

      const connectResult = await platform.connect({ cwd })
      if (connectResult instanceof Error) {
        spinner.stop('Failed to connect')
        log.error(connectResult.message)
        process.exitCode = 1
        return
      }
      spinner.stop(`Connected to ${platform.name}`)

      // --------------- Session selection ---------------

      let selectedSessionId = sessionId as string | undefined
      if (!selectedSessionId) {
        spinner.start('Fetching sessions...')
        const sessions = await platform.listSessions({ cwd })
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

        // In agent mode or non-TTY, require session ID as argument
        if (isAgent || !process.stdin.isTTY) {
          log.error(
            'No session ID provided. Pass it as an argument: contextanalyzer <sessionId>',
          )
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
          return {
            value: s.id,
            label: `${title}  ${s.id.slice(0, 16)}...  ${date}`,
          }
        })

        const choice = await clack.select({
          message: 'Select a session to analyze',
          options: sessionOptions,
        })

        if (clack.isCancel(choice)) {
          clack.cancel('Cancelled')
          return
        }

        selectedSessionId = choice
      }

      // --------------- Fetch and analyze ---------------

      spinner.start(`Fetching messages for ${selectedSessionId}...`)
      const messages = await platform.fetchMessages({
        sessionId: selectedSessionId,
        cwd,
      })
      if (messages instanceof Error) {
        spinner.stop('Failed')
        log.error(messages.message)
        process.exitCode = 1
        return
      }

      spinner.stop(`Loaded ${messages.length} messages`)

      const result = analyzeSession({
        sessionId: selectedSessionId,
        messages,
      })

      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(
          renderAnalysis(result, { top: options.top, showSteps: options.steps }),
        )
      }

      log.outro('Done')
    } finally {
      platform?.cleanup()
    }
  })

cli.help()
cli.version('0.1.0')
cli.parse()

#!/usr/bin/env node
// contextanalyzer - Analyze OpenCode session context usage and tool call performance.
// Spawns an opencode serve process, lists sessions, and renders analysis histograms.

import { goke, isAgent } from 'goke'
import { z } from 'zod'
import * as clack from '@clack/prompts'
import {
  startOpencodeAcp,
  listSessions,
  fetchSessionMessages,
  type OpencodeConnection,
} from './opencode-client.ts'
import { analyzeSession } from './analyze.ts'
import { renderAnalysis } from './render.ts'

const cli = goke('contextanalyzer')

cli
  .command('[sessionId]', 'Analyze context usage for an OpenCode session')
  .option(
    '--cwd [cwd]',
    z.string().optional().describe('Working directory for opencode ACP server'),
  )
  .option('--top [top]', z.number().default(15).describe('Max items in histograms'))
  .option('--json', 'Output raw analysis as JSON')
  .option('--steps', 'Show per-step token breakdown table')
  .action(async (sessionId, options) => {
    let connection: OpencodeConnection | null = null

    try {
      const cwd = options.cwd || process.cwd()

      // In JSON mode, redirect clack UI to stderr so stdout is clean JSON
      const useStderr = options.json

      const log = {
        intro(msg: string) { if (!useStderr) clack.intro(msg) },
        error(msg: string) { if (useStderr) process.stderr.write(msg + '\n'); else clack.log.error(msg) },
        warn(msg: string) { if (useStderr) process.stderr.write(msg + '\n'); else clack.log.warn(msg) },
        info(msg: string) { if (useStderr) process.stderr.write(msg + '\n'); else clack.log.info(msg) },
        message(msg: string) { if (useStderr) process.stderr.write(msg + '\n'); else clack.log.message(msg) },
        outro(msg: string) { if (!useStderr) clack.outro(msg) },
      }

      const spinner = useStderr
        ? { start(_msg: string) {}, stop(_msg: string) {} }
        : clack.spinner()

      log.intro('contextanalyzer')
      spinner.start('Starting opencode serve...')

      const conn = await startOpencodeAcp({ cwd })
      if (conn instanceof Error) {
        spinner.stop('Failed to start server')
        log.error(conn.message)
        process.exitCode = 1
        return
      }
      connection = conn
      spinner.stop(`Connected to opencode on port ${conn.port}`)

      // If no session ID provided, let user pick one
      let selectedSessionId = sessionId as string | undefined
      if (!selectedSessionId) {
        spinner.start('Fetching sessions...')
        const sessions = await listSessions({ sdk: conn.sdk })
        if (sessions instanceof Error) {
          spinner.stop('Failed')
          log.error(sessions.message)
          process.exitCode = 1
          return
        }

        if (sessions.length === 0) {
          spinner.stop('No sessions found')
          log.warn('No sessions found in this directory. Try passing --cwd.')
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
            const date = new Date(s.time.updated).toLocaleString()
            log.message(`  ${s.id}  ${s.title || '(untitled)'}  ${date}`)
          }
          process.exitCode = 1
          return
        }

        const sessionOptions = sessions.slice(0, 30).map((s) => {
          const date = new Date(s.time.updated).toLocaleString()
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

      // Fetch messages
      spinner.start(`Fetching messages for ${selectedSessionId}...`)
      const messages = await fetchSessionMessages({
        sdk: conn.sdk,
        sessionId: selectedSessionId,
      })
      if (messages instanceof Error) {
        spinner.stop('Failed')
        log.error(messages.message)
        process.exitCode = 1
        return
      }

      spinner.stop(`Loaded ${messages.length} messages`)

      // Run analysis
      const result = analyzeSession({
        sessionId: selectedSessionId,
        messages,
      })

      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(renderAnalysis(result, { top: options.top, showSteps: options.steps }))
      }

      log.outro('Done')
    } finally {
      connection?.cleanup()
    }
  })

cli.help()
cli.version('0.1.0')
cli.parse()

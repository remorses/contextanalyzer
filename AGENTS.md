# contextanalyzer

CLI tool that connects to coding agents (OpenCode, Claude Code, Codex), reads session history, and renders terminal histograms showing where context tokens and wall-clock time are spent. Helps debug which tool calls consume the most context and which are slowest.

## Before starting

Load these skills first:

- **goke**: this project uses `goke` for CLI argument parsing with Zod schemas
- **errore**: errors are returned as values (`Error | T` unions), not thrown. Check `instanceof Error` before using results
- **changesets**: add a `.changeset/*.md` file for every user-facing change or fix

## Architecture

- `src/cli.ts`: entry point, goke CLI definition, platform selection, orchestrates connection → session selection → analysis → render
- `src/platform.ts`: common types (`NormalizedMessage`, `SessionInfo`, `Platform` interface) shared by all agent platforms
- `src/opencode-client.ts`: OpenCode platform. Spawns `opencode serve`, uses `@opencode-ai/sdk` for full session data with token counts
- `src/acp-client.ts`: ACP platform shared by Claude Code and Codex. Spawns the agent binary via stdio, uses `@agentclientprotocol/sdk` for session/list and session/load
- `src/analyze.ts`: core analysis engine, processes `NormalizedMessage[]` into `AnalysisResult`
- `src/render.ts`: ASCII histogram and summary rendering for terminal output (gracefully handles missing token data from ACP agents)
- `src/bash-command.ts`: extracts first command name from bash strings for grouping

## Stack

- TypeScript ESM, built with `tsc`
- **pnpm** for package management
- `goke` for CLI, `zod` for option schemas, `@clack/prompts` for interactive session picker
- `@opencode-ai/sdk` for OpenCode HTTP API
- `@agentclientprotocol/sdk` for ACP protocol (Claude Code, Codex)
- `@agentclientprotocol/claude-agent-acp` and `@zed-industries/codex-acp` as agent binaries
- `just-bash` for bash command parsing

## Build and run

```bash
pnpm build        # tsc + chmod
pnpm dev          # tsx src/cli.ts
```

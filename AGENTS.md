# contextanalyzer

CLI tool that connects to a local OpenCode server, reads session history, and renders terminal histograms showing where context tokens and wall-clock time are spent. Helps debug which tool calls consume the most context and which are slowest.

## Before starting

Load these skills first:

- **goke**: this project uses `goke` for CLI argument parsing with Zod schemas
- **errore**: errors are returned as values (`Error | T` unions), not thrown. Check `instanceof Error` before using results
- **changesets**: add a `.changeset/*.md` file for every user-facing change or fix

## Architecture

- `src/cli.ts`: entry point, goke CLI definition, orchestrates connection → session selection → analysis → render
- `src/opencode-client.ts`: spawns `opencode serve`, typed SDK wrappers for listing sessions and fetching messages
- `src/analyze.ts`: core analysis engine, processes messages+parts into `AnalysisResult`
- `src/render.ts`: ASCII histogram and summary rendering for terminal output
- `src/bash-command.ts`: extracts first command name from bash strings for grouping

## Stack

- TypeScript ESM, built with `tsc`
- **pnpm** for package management
- `goke` for CLI, `zod` for option schemas, `@clack/prompts` for interactive session picker
- `@opencode-ai/sdk` for OpenCode ACP protocol
- `just-bash` for bash command parsing

## Build and run

```bash
pnpm build        # tsc + chmod
pnpm dev          # tsx src/cli.ts
```

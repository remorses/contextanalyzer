<div align='center'>
    <br/>
    <br/>
    <h3>contextanalyzer</h3>
    <p>See where your AI coding sessions spend tokens and time</p>
    <br/>
    <br/>
</div>

## Install

```bash
npx contextanalyzer
```

Or install globally:

```bash
npm i -g contextanalyzer
```

## Install skill for AI agents

```bash
npx -y skills add remorses/contextanalyzer
```

This installs the contextanalyzer skill for AI coding agents. Load it when debugging OpenCode sessions to find which tools spent the most tokens or time.

## How it works

contextanalyzer connects to a local [OpenCode](https://opencode.ai) server, reads your session history, and renders terminal histograms showing exactly where context tokens and wall-clock time are spent.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   opencode serve                    contextanalyzer                      │
│   ┌───────────────┐                ┌──────────────────┐                  │
│   │ Sessions DB   │ ──── HTTP ──▶  │ Fetch messages   │                  │
│   │ Messages      │                │ Analyze parts    │                  │
│   │ Tool parts    │                │ Render histograms│                  │
│   └───────────────┘                └──────────────────┘                  │
│                                            │                             │
│                                            ▼                             │
│                                    Terminal output:                      │
│                                    - Context breakdown                   │
│                                    - Tool usage by size                  │
│                                    - Tool calls by duration              │
│                                    - Individual biggest calls            │
│                                    - Individual slowest calls            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The CLI spawns `opencode serve` automatically on a random port, fetches the session data, and kills it when done. No setup needed beyond having `opencode` installed.

## Usage

**Interactive mode** (pick a session from a list):

```bash
contextanalyzer
```

**Analyze a specific session**:

```bash
contextanalyzer ses_abc123def456
```

**Point to a different project directory**:

```bash
contextanalyzer --cwd /path/to/project
```

**JSON output** (pipe to `jq`, save to file):

```bash
contextanalyzer ses_abc123 --json | jq '.toolsByDuration[:3]'
```

**Show per-step token table**:

```bash
contextanalyzer ses_abc123 --steps
```

## Example output

### Session overview

Shows model, message counts, real token usage from the API, cost, and cache stats.

```
Session Overview
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Session              ses_1e36dd4e2ffeFb3I7nov1HFh04
  Model                claude-opus-4-6
  Messages             24 user, 306 assistant
  Duration             1133.3m
  Steps                297
  Total Cost           $31.38
  Prompt Tokens        214.3K (214.2K cached, 1 uncached)
  Output Tokens        2
  Cache Write          115
  Total Tokens         214.3K
```

### Context breakdown

Where do your input tokens come from? Tool outputs usually dominate. Token estimates here are based on character length (~4 chars per token).

```
Context Breakdown (estimated tokens from chars)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Tool outputs       ███████████████████████████████████ 76.7K    59.4%
  Tool inputs        ███████████████                     33.4K    25.8%
  Assistant text     ████                                9.1K     7.0%
  System message     ████                                9.0K     7.0%
  User text                                              483      0.4%
  Reasoning                                              408      0.3%
  Total                                                  129.1K
```

### Tool usage by type

Which **categories** of tool calls consume the most context? Bash calls are sub-categorized by command (parsed with [just-bash](https://github.com/vercel-labs/just-bash)).

```
Tool Context Usage (output + input tokens)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  read               ███████████████████████████████████ 28.2K    25.6%  (50 calls)
  edit               ████████████████████████▌           19.7K    17.9%  (45 calls)
  websearch          ██████████████████                  14.4K    13.1%  (3 calls)
  bash (git)         ██████████▌                         8.4K     7.6%   (35 calls)
  bash (pnpm)        ████████▌                           6.8K     6.2%   (31 calls)
  task               ███████▌                            6.0K     5.4%   (5 calls)
  bash (tuistory)    ██████▌                             5.3K     4.8%   (46 calls)
  grep               █████                               4.2K     3.8%   (17 calls)
```

### Biggest individual calls

Which **specific** tool invocations used the most context? Labels show the command, file path, URL, or description so you know exactly what happened.

```
Biggest Individual Tool Calls
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  websearch: pnpm onlyBuiltDependencies postinstall blocked global …  ████████████████████ 5.8K  19.2%
  websearch: pnpm dlx pnpm install global postinstall scripts disab…  ████████████████     4.7K  15.4%
  websearch: bunx bun install global postinstall lifecycle scripts … █████████████         3.9K  12.7%
  read: .../cli/src/opencode.ts                                       ███████████          3.3K  10.7%
  bash: git diff -- ':!pnpm-lock.yaml'                                ██████████           2.9K  9.5%
```

### Slowest individual calls

Which tool calls took the most wall-clock time?

```
Slowest Individual Tool Calls
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  task: Oracle re-review after fixes                    ████████████████████ 6.1m   32.5%
  task: Oracle review pinned opencode                   █████████████████▌   5.4m   28.9%
  task: Oracle review bundled opencode                  ████████████████▌    5.1m   27.1%
  task: Explore opencode binary resolution              ██▌                  45.5s  4.0%
  googlesearch: does bunx or bun install -g disable…    █▌                   31.9s  2.8%
```

## Use cases

### Optimize tools to reduce context usage

Tool outputs are usually **60-70% of total context**. A single `curl` or `webfetch` call can burn 50K+ chars. Use contextanalyzer to find which tools are the biggest offenders, then:

- **Replace large file reads** with targeted `grep` or partial reads
- **Avoid fetching full web pages** when you only need a section
- **Reduce bash output verbosity** by filtering or piping through `head`/`tail`
- **Split large skill files** so only relevant content is loaded

### Optimize tools to reduce session time

Subagent `task` calls and network operations dominate wall-clock time. Identify the slowest calls, then:

- **Parallelize independent tasks** instead of running them sequentially
- **Cache results** that don't change between runs
- **Use faster alternatives** (e.g. `grep` instead of full file reads)

### Understand cache efficiency

The per-step token table (with `--steps`) shows how cache hit rates evolve. Low cache rates mean the model re-reads content on every step. High rates (95-100%) mean prompt caching is working well.

### Compare sessions

Run contextanalyzer with `--json` on multiple sessions and compare the outputs to track how prompt engineering or tool configuration changes affect token usage over time.

```bash
contextanalyzer ses_before --json > before.json
contextanalyzer ses_after --json > after.json
diff <(jq '.contextBreakdown' before.json) <(jq '.contextBreakdown' after.json)
```

## Options

| Flag | Description |
|---|---|
| `[sessionId]` | Session ID to analyze (interactive picker if omitted) |
| `--cwd <path>` | Working directory for opencode server |
| `--top <n>` | Max items in grouped histograms (default: 15) |
| `--steps` | Show per-step token breakdown table |
| `--json` | Output raw analysis as JSON |

## How context is measured

The **session overview** shows exact token counts from the OpenCode API. `AssistantMessage.tokens` is a **context window snapshot** at each turn (not incremental). contextanalyzer reads the last assistant message's snapshot to get the current context size. Total prompt tokens = `input + cache.read + cache.write`, where `input` represents only non-cached tokens.

**Cost** is the exception: it is incremental per-message, so it is summed across all assistant messages for the session total.

The **context breakdown** and **tool histograms** estimate token contribution by measuring **character length** of tool inputs and outputs (~4 chars per token). This is a rough approximation for comparing relative sizes, not an exact count.

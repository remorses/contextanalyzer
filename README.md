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

Shows model, message counts, total tokens, and cache efficiency at a glance.

```
Session Overview
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Session              ses_1e8089b59ffeBxY02rHAW1U0hz
  Model                claude-opus-4-6
  Messages             16 user, 178 assistant
  Duration             58.4m
  Steps                176
  Prompt Tokens        26.8M (26.1M cached, 198 uncached)
  Output Tokens        53.9K
  Cache Write          735.3K
```

### Context breakdown

Where do your input tokens come from? Tool outputs usually dominate.

```
Context Breakdown (by character size)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Tool outputs       ███████████████████████████████████  342.3K   66.0%
  Tool inputs        ███████████▍                         111.0K   21.4%
  System message     ███▊                                 36.0K    6.9%
  Assistant text     ██▎                                  21.0K    4.0%
  Reasoning          ▋                                    5.6K     1.1%
  User text          ▍                                    2.8K     0.5%
  Total                                                   518.6K   ~129.7K tokens
```

### Tool usage by type

Which **categories** of tool calls consume the most context? Bash calls are sub-categorized by command (parsed with [just-bash](https://github.com/vercel-labs/just-bash)).

```
Tool Context Usage (output + input chars)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  read               ███████████████████████████████████  83.3K    18.4%  (35 calls)
  bash (curl)        ██████████████████████▍              53.0K    11.7%  (2 calls)
  skill              ████████████████████▎                48.0K    10.6%  (3 calls)
  bash (cd)          ██████████████████▉                  44.7K    9.9%   (10 calls)
  webfetch           █████████████████▎                   41.0K    9.0%   (1 calls)
  write              █████████████████▎                   40.9K    9.0%   (15 calls)
  edit               ████████████████▉                    40.0K    8.8%   (39 calls)
  task               ██████████████▊                      35.1K    7.7%   (6 calls)
  bash (pnpm)        ███████▍                             17.5K    3.9%   (20 calls)
```

### Biggest individual calls

Which **specific** tool invocations used the most context? Labels show the command, file path, URL, or description so you know exactly what happened.

```
Biggest Individual Tool Calls (by context size)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  bash: curl -L https://raw.githubusercontent.com/remorses/goke/main/R…  ████████████████  51.3K  26.2%
  webfetch: https://github.com/vercel-labs/just-bash/blob/main/package…  ████████████▉     41.0K  20.9%
  skill: errore                                                          ████████▎         26.3K  13.4%
  skill: npm-package                                                     ██████▌           20.5K  10.5%
  task: Read openplexer ACP usage                                        ███▍              10.8K  5.5%
```

### Slowest individual calls

Which tool calls took the most wall-clock time?

```
Slowest Individual Tool Calls (by duration)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  task: Read openplexer ACP usage                                        ████████████████  7.2m   31.3%
  task: Explore ACP spec in opencode                                     ███████████████▎  6.8m   29.6%
  task: Oracle review contextanalyzer                                    █████████▍        4.2m   18.1%
  task: Read just-bash parser                                            ██████▍           2.8m   12.3%
  bash: pkill -f 'opencode serve' 2>/dev/null; sleep 1                   ██▎               57.9s  4.2%
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

OpenCode reports **per-message token counts** but not per-tool-call token counts. contextanalyzer estimates tool context contribution by measuring **character length** of tool inputs and outputs (~4 chars per token for English text). This is a close approximation, not an exact count.

The **prompt tokens** shown in the overview are exact values from the API: `input + cache.read + cache.write`. The `input` field from OpenCode represents only non-cached tokens, so the full prompt size includes all three.

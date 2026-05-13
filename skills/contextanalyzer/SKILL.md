---
name: contextanalyzer
repo: https://github.com/remorses/contextanalyzer
description: >
  OpenCode session analyzer for breaking down context usage per tool and
  debugging the largest tool calls that wasted the most tokens. Load this skill
  when you need to inspect OpenCode token usage, identify oversized tool calls,
  or compare duration breakdowns for slow tools and subagents.
---

<!-- Skill instructions for agents using the contextanalyzer CLI. -->

# contextanalyzer

contextanalyzer reads OpenCode session history and prints terminal histograms for context tokens and wall-clock duration.

Every time you use contextanalyzer, run the full help first:

```bash
npx -y contextanalyzer --help
```

Never pipe the help output through `head`, `tail`, `sed`, `awk`, or any other truncation command.

Also fetch and read the latest README in full:

```bash
curl -L https://raw.githubusercontent.com/remorses/contextanalyzer/main/README.md
```

Never truncate the README output. It is the canonical documentation for examples, options, and how token estimates are computed.

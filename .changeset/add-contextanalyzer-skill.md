---
'contextanalyzer': patch
---

Add an installable AI agent skill for contextanalyzer.

Agents can now install the project skill with:

```bash
npx -y skills add remorses/contextanalyzer
```

The skill tells agents to read `contextanalyzer --help` and the canonical README before using the CLI to debug OpenCode token and duration breakdowns.

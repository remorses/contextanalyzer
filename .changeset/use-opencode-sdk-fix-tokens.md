---
'contextanalyzer': minor
---

Switch from ACP protocol to OpenCode HTTP SDK for accurate token usage data.

Previously used `@agentclientprotocol/sdk` which doesn't provide token counts,
so tokens were estimated as `chars / 4`. Now uses `@opencode-ai/sdk` with
`opencode serve`, which gives real per-message token breakdowns:

- **Prompt tokens** = uncached input + cache read + cache write
- **Output tokens** and **reasoning tokens** from the model
- **Cache hit rates** per step
- **Session cost** summed across all assistant messages

Also restores features from the initial release that were lost during ACP migration:
- Tool call duration histograms (using `ToolState.time.start/end`)
- Slowest individual tool calls ranking
- Per-step token breakdown table (`--steps` flag)

Removes support for Claude Code and Codex (only OpenCode is supported).

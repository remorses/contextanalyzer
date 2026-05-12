---
'contextanalyzer': minor
---

Add support for Claude Code and Codex alongside OpenCode.

The CLI now asks which agent to analyze via an interactive select, or accepts `--agent opencode`, `--agent claude-code`, or `--agent codex` in non-TTY mode.

Claude Code and Codex connect through the standard ACP protocol (Agent Client Protocol) using `@agentclientprotocol/sdk`. The agent binaries (`@agentclientprotocol/claude-agent-acp` and `@zed-industries/codex-acp`) are resolved from `node_modules` and spawned as stdio subprocesses. Session listing uses `session/list` and conversation replay uses `session/load`.

OpenCode keeps its existing HTTP API approach via `@opencode-ai/sdk`, which provides full per-turn token counts, costs, and cache data.

ACP-based agents (Claude Code, Codex) provide tool call context sizes and message content but not per-turn token breakdowns, since ACP session replay does not include usage data. The render layer gracefully handles this by showing a note when token data is absent.

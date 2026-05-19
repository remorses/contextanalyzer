# contextanalyzer

## 0.2.1

1. **Added installable AI agent skill** — agents can now install the contextanalyzer skill to understand how to debug OpenCode sessions:
   ```bash
   npx -y skills add remorses/contextanalyzer
   ```
   The skill tells agents to run `contextanalyzer --help` and read the README before analyzing token and duration breakdowns.

## 0.2.0

1. **Fixed token computation to use snapshot-based tracking** — OpenCode reports token counts as cumulative context snapshots, not per-message increments. The analyzer now correctly reads the last non-zero snapshot for session totals and sums cost incrementally across assistant messages. Previously token totals could be inflated or incorrect.

2. **Improved histogram rendering** — all histogram sections now share a single unified `renderHistogram` function with consistent layout, auto-sized label columns, and half/full block bar characters (`█▌`) that render cleanly in most terminal fonts. No more visible gaps from partial-width Unicode characters.

3. **Separated token usage from context breakdown** — the overview now shows a clean `TokenUsage` section with prompt tokens (uncached + cache read + cache write), output tokens, reasoning tokens, cache write, total cost, and total tokens. This is separate from the character-based context breakdown.

4. **Updated `@opencode-ai/sdk` to v1.14.48** — picks up latest OpenCode API compatibility and type improvements.

## 0.1.0

Initial release.

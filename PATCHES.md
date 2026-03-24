# Local Patches & Custom Changes

This file documents local commits and patches applied to Lettabot and its
dependencies by contributors outside the upstream PR flow.

---

## Lettabot (this repo)

### Joash Mathew

| Commit | Description |
|--------|-------------|
| `03289d5` | **fix: strip leading spaces before markdown conversion** — Prevents accidental code blocks when outbound messages have leading whitespace. |
| `01a75e9` | **feat: add 'models' command to COMMANDS array** — Registers `/models` and updates help text to distinguish `/model` (current + recommended) from `/models` (all available). |
| `0ea8fbe` | **feat: implement /models command handler** — Adds `case 'models'` to `handleCommand` in `bot.ts`, calls `listModels()` and returns a formatted list. |
| `2d819fe` | **feat: add 'lettabot model list' subcommand** — Implements `modelList()` displaying all available models grouped by provider with full handles. |
| `ff59577` | **docs: add subagent delegation skill** — Comprehensive skill doc covering when to use subagents, available types, model selection, parallel execution patterns. |

---

## Letta Server (local Docker fork at `../letta`)

These patches are applied to the local Letta server and must be present in
the Docker image for Lettabot to work correctly with Synthetic.new.

### Joash Mathew

| Commit | Description |
|--------|-------------|
| `110e8b54` | **fix: remove redis_client param from GitOperations init** — Fixes constructor mismatch after upstream refactor. |
| `8cc0201a` | **feat: add Kimi-K2.5 context window (131072) and LLM_MAX_TOKENS alias** — Adds context window config for Kimi-K2.5 model. |
| `cc0eba7c` | **fix: strip null tools/tool_choice for Synthetic.new** — Synthetic.new rejects `null` values for `tools` and `tool_choice` fields; this patch removes them before sending. Located in `letta/llm_api/openai_client.py`. |
| `7a33b70a` | **fix: strip invalid control characters from request strings** — Extends `sanitize_unicode_surrogates()` in `letta/helpers/json_helpers.py` to also strip control chars (ord < 0x20, except `\t\n\r`) for API compatibility. |
| `0525b521` | **fix: use API-reported context_length in OpenAIProvider model sync** — Uses the provider's reported context length instead of hardcoded defaults. |

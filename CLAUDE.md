# CLAUDE.md

## Project Overview

Lettabot is a multi-channel messaging bot (Telegram, Slack, Discord, WhatsApp, Signal)
powered by Letta agents. It bridges user messages to a Letta server (cloud or self-hosted
Docker) and streams responses back.

## Key Architecture

- **Channels** (`src/channels/`) — Adapters for each messaging platform
- **Core** (`src/core/`) — Bot logic, session management, state persistence
- **Tools** (`src/tools/letta-api.ts`) — Letta REST API client using `@letta-ai/letta-client`
- **State** — `lettabot-agent.json` (multi-agent V2 format, keyed by agent name)
- **Sessions** — `@letta-ai/letta-code-sdk` manages CLI subprocesses per conversation

## Development

```bash
npm run build        # TypeScript compilation
npx tsc --noEmit     # Type-check only
npm start            # Run the bot
```

## Important Conventions

- Commands are registered in `src/core/commands.ts` (COMMANDS array) AND in each
  channel adapter's known commands set
- Telegram commands use underscores (`break_glass`), but internal command names use
  hyphens (`break-glass`)
- Dynamic imports for `letta-api.ts` functions in command handlers (avoids circular deps)
- Store uses file locking for multi-process safety (atomic write via tmp+rename)

## Local Patches

See [PATCHES.md](./PATCHES.md) for documentation of local commits and patches to both
this repo and the companion Letta server fork.

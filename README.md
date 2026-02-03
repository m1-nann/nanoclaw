# NanoClaw

Personal Claude assistant via WhatsApp. Agents run isolated in Apple Containers.

## Quick Start

```bash
git clone https://github.com/anthropics/nanoclaw.git
cd nanoclaw
claude
```

Then run `/setup`.

## Architecture

```
WhatsApp (Baileys) → SQLite → Poll Loop → Apple Container (Claude Agent SDK) → Response
```

Single Bun process. Each message spawns an ephemeral container that's destroyed after responding. Session continuity comes from per-group `.claude/` directories mounted into containers.

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | WhatsApp connection, message routing, IPC |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory |

### Message Flow

1. Baileys receives WhatsApp message
2. Stored in SQLite (`store/messages.db`)
3. Poll loop detects new message matching trigger pattern
4. `runContainerAgent()` spawns Apple Container with:
   - Group folder mounted at `/app/group`
   - Claude credentials from `.env`
   - IPC directory for outbound messages/tasks
5. Claude Agent SDK processes prompt
6. Response sent back via WhatsApp

### IPC

Containers communicate with host via filesystem:
- `data/ipc/{group}/messages/*.json` - Outbound messages
- `data/ipc/{group}/tasks/*.json` - Task scheduling commands
- `data/snapshots/{group}/tasks.json` - Read-only task list
- `data/snapshots/{group}/groups.json` - Available groups (main only)

### Security Model

- Agents run in Apple Container (Linux VM), not host process
- Each group folder isolated; no cross-group access
- Main group has elevated privileges (register groups, see all tasks)
- Mount allowlist controls external directory access (`~/.config/nanoclaw/mount-allowlist.json`)
- Sensitive paths (`.ssh`, `.aws`, credentials) always blocked

## Requirements

- macOS Tahoe (26)+
- [Bun](https://bun.sh)
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container)

## Usage

```
@Andy summarize my emails from today
@Andy every Monday at 9am, send me a weekly review
@Andy list scheduled tasks
```

## Development

```bash
bun run dev      # Run with watch mode
bun run auth     # WhatsApp authentication
./container/build.sh  # Rebuild agent container
```

## License

MIT

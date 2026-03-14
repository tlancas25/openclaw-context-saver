# OpenClaw Context Saver

> Reduce OpenClaw token consumption by 70-98% through sandboxed execution, intent filtering, and session continuity

## The Problem

Multi-agent systems like OpenClaw orchestrate dozens of skills -- trading APIs, analytics engines, search tools, notification routers. Each skill call can return 3-50 KB of raw JSON. In a typical day of operation, an OpenClaw instance consumes **750K+ tokens** just feeding API responses into the context window.

Most of that data is noise. When you ask "what's my buying power?", the full account response includes 40+ fields. You needed one. The other 39 fields consumed tokens for nothing.

Multiply this across positions, options chains, order history, market movers, and session resumptions, and you have a system that spends more tokens *reading data* than *thinking about it*.

## The Solution

Context Saver introduces three mechanisms that work together to cut token waste:

### 1. Sandboxed Execution

Skill commands run in subprocesses. The full output never enters the context window. Instead, a compact summary (100-500 bytes) is returned while the full output is indexed in SQLite FTS5 for on-demand retrieval.

### 2. Intent-Driven Filtering

When you specify an intent like `"find losing positions"`, Context Saver extracts only the fields that match. An 8-position portfolio (5 KB) becomes a 300-byte summary of just the losers.

### 3. Session Continuity

Critical events (trades, alerts, decisions) are logged to a SQLite database with priority levels. Before conversation compaction, a 2 KB snapshot captures everything that matters. On resume, the snapshot restores context without re-fetching.

## Quick Start

### Installation

```bash
# Clone or copy into your OpenClaw workspace
cp -r openclaw-context-saver ~/.openclaw/workspace/skills/context-saver

# Verify
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_stats.py
```

### Environment

Context Saver uses the `OPENCLAW_HOME` environment variable to locate your OpenClaw installation. It defaults to `~/.openclaw` if not set.

```bash
# Optional: set if your OpenClaw home is non-standard
export OPENCLAW_HOME=~/.openclaw
```

## Usage

### Run a Skill Command (Sandboxed)

```bash
# Basic: run a skill command and get a compact summary
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "account"

# With intent filtering: only return fields relevant to your question
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "positions" --intent "find losing positions"

# With explicit field selection
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "account" --fields "equity,buying_power,day_pnl"

# Options chain with intent (biggest savings)
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "chain AAPL" --intent "high IV puts expiring this week"
```

### Batch Execution (Multiple Skills, One Call)

```bash
python3 scripts/ctx_batch.py --commands '[
  {"skill": "alpaca-trader", "cmd": "account", "fields": ["equity", "buying_power"]},
  {"skill": "alpaca-trader", "cmd": "positions", "intent": "summary"},
  {"skill": "alpaca-trader", "cmd": "movers", "intent": "top 5"}
]'
```

### Session Event Tracking

```bash
# Log a critical event
python3 scripts/ctx_session.py log --type "trade" --priority critical \
  --data '{"action":"buy","symbol":"AAPL","qty":100}'

# Build snapshot before compaction
python3 scripts/ctx_session.py snapshot

# Restore context on resume
python3 scripts/ctx_session.py restore

# View session statistics
python3 scripts/ctx_session.py stats
```

### Search Indexed Data

```bash
# Full-text search across all indexed outputs
python3 scripts/ctx_search.py "high IV options"

# Scoped to a specific skill
python3 scripts/ctx_search.py "losing positions" --source alpaca-trader
```

### View Stats

```bash
python3 scripts/ctx_stats.py
# Output: total bytes saved, calls made, avg compression ratio, session events
```

## Benchmarks

| Operation | Raw Size | Context Saver | Savings |
|-----------|----------|---------------|---------|
| Account query | 3 KB | 120 B | **96%** |
| Positions (8 stocks) | 5 KB | 300 B | **94%** |
| Options chain (AAPL) | 20-50 KB | 500 B | **97%** |
| Morning brief pipeline | 23 KB (4 calls) | 2 KB (1 batch) | **91%** |
| Session cold start | 20 KB workspace | 2 KB snapshot | **90%** |
| Full day operation | ~750K tokens | ~200K tokens | **73%** |

See [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for methodology and detailed scenarios.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Claude Context Window              │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ 120 B       │  │ 300 B        │  │ 2 KB       │ │
│  │ account     │  │ positions    │  │ session    │ │
│  │ summary     │  │ summary      │  │ snapshot   │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
│         │               │               │          │
└─────────┼───────────────┼───────────────┼──────────┘
          │               │               │
    ┌─────┴───────────────┴───────────────┴─────┐
    │            Context Saver Layer             │
    │                                            │
    │  ┌──────────┐ ┌───────────┐ ┌───────────┐ │
    │  │ Sandbox  │ │  Intent   │ │  Session  │ │
    │  │ Runner   │ │  Filter   │ │  Tracker  │ │
    │  └────┬─────┘ └─────┬─────┘ └─────┬─────┘ │
    │       │             │             │        │
    │  ┌────┴─────────────┴─────────────┴────┐   │
    │  │     SQLite FTS5 Index + Stats       │   │
    │  │     (~/.openclaw/context/*.db)      │   │
    │  └─────────────────────────────────────┘   │
    └────────────────────────────────────────────┘
          │               │               │
    ┌─────┴──────┐  ┌─────┴──────┐  ┌────┴───────┐
    │ 3 KB       │  │ 5 KB       │  │ 20-50 KB   │
    │ account    │  │ positions  │  │ options    │
    │ raw JSON   │  │ raw JSON   │  │ chain JSON │
    └────────────┘  └────────────┘  └────────────┘
         Skill Subprocesses (never enter context)
```

## How It Works

### Sandboxed Execution

When you call `ctx_run.py`, it:

1. Locates the target skill in `$OPENCLAW_HOME/workspace/skills/`
2. Spawns a subprocess to execute the skill command
3. Captures stdout/stderr completely
4. Parses the JSON output
5. If `--fields` is specified, extracts only those fields
6. If `--intent` is specified, applies intent-driven filtering
7. Indexes the full output in SQLite FTS5 for later search
8. Records byte savings in the stats database
9. Returns a compact JSON summary to stdout

The full output never touches the context window. If Claude needs more detail later, it can use `ctx_search.py` to query the indexed data.

### Intent-Driven Filtering

The intent filter uses keyword matching against JSON keys and values:

- `"find losing positions"` matches position entries where `unrealized_pl < 0`
- `"high IV puts"` matches options where `implied_volatility` is above threshold and `option_type == "put"`
- `"check balance"` matches `equity`, `buying_power`, `cash` fields

This is deliberately simple -- no ML, no embeddings, just fast keyword matching that works reliably.

### Session Continuity

Events are stored with four priority levels:

| Priority | Label | Budget | Examples |
|----------|-------|--------|----------|
| P1 | Critical | 40% | Trades executed, stop losses triggered |
| P2 | High | 30% | Price alerts, large P&L changes |
| P3 | Medium | 20% | Analysis results, routine checks |
| P4 | Low | 10% | Informational queries, minor updates |

The snapshot builder allocates a 2 KB budget across priorities, ensuring critical events are always preserved. On restore, Claude gets a complete operational picture without re-running any commands.

## Comparison with context-mode

Context Saver is inspired by [context-mode](https://github.com/AnswerDotAI/context-mode), which provides FTS5 indexing and search for Claude conversations. Key differences:

| Feature | context-mode | Context Saver |
|---------|-------------|---------------|
| Scope | General conversation context | OpenClaw skill execution |
| Execution | External indexing tool | Integrated skill wrapper |
| Filtering | Query-based retrieval | Intent-driven pre-filtering |
| Sessions | Not supported | Priority-based event tracking |
| Batching | Not supported | Multi-skill batch execution |
| Target | Any Claude user | OpenClaw multi-agent systems |

Context Saver builds on the FTS5 indexing concept and extends it with sandboxed execution, intent filtering, and session continuity -- features specific to multi-agent orchestration.

## Configuration

All paths are derived from `OPENCLAW_HOME` (default: `~/.openclaw`):

| Path | Purpose |
|------|---------|
| `$OPENCLAW_HOME/workspace/skills/` | Skill directories |
| `$OPENCLAW_HOME/context/stats.db` | Execution stats and FTS5 index |
| `$OPENCLAW_HOME/context/sessions.db` | Session event log and snapshots |
| `$OPENCLAW_HOME/.env` | Environment variables for skill execution |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_HOME` | `~/.openclaw` | Root directory for OpenClaw |
| `CTX_SNAPSHOT_BUDGET` | `2048` | Max bytes for session snapshots |
| `CTX_FTS_ENABLED` | `1` | Enable/disable FTS5 indexing |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Write tests for new functionality
4. Ensure all scripts remain stdlib-only (no pip dependencies)
5. All scripts must output valid JSON
6. Submit a pull request

### Development Guidelines

- Python 3.8+ compatible
- Standard library only -- no external dependencies
- All output must be valid JSON (parseable by any consumer)
- Errors return JSON with `{"success": false, "error": "message"}`
- Scripts must be individually executable with `--help`

## License

MIT License. See [LICENSE](LICENSE) for details.

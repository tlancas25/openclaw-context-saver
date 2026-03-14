---
name: context-saver
description: "Token-saving execution layer for OpenClaw. Runs skill commands in sandboxed subprocesses where only compact summaries enter the context window. Provides session continuity via SQLite event tracking that survives conversation compaction. Supports intent-driven filtering, batched multi-skill execution, and progressive memory loading. Use this skill to wrap any data-heavy operation to reduce token consumption by 70-98%."
metadata: {"openclaw":{"emoji":"🪶","requires":{"bins":["python3"],"env":[]}}}
---

# Context Saver — Token Optimization for OpenClaw

Reduces token consumption by 70-98% through sandboxed execution, intent filtering, and session continuity.

## Core Concept

Instead of dumping raw API responses (3-50 KB) into context, Context Saver:
1. Runs skill commands in subprocesses
2. Captures full output
3. Extracts only relevant fields based on intent
4. Returns compact summaries (100-500 bytes)
5. Indexes full output in FTS5 for on-demand retrieval

## Commands

### Sandboxed Skill Execution
```bash
# Run any skill command with automatic summarization
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "account" [--intent "check balance"]
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "positions" [--intent "find losing positions"]
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "chain AAPL" --intent "high IV puts expiring this week"

# Run with explicit summary fields
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "account" --fields "equity,buying_power,day_pnl"
```

### Batch Execution (Multiple Skills in One Call)
```bash
python3 scripts/ctx_batch.py --commands '[
  {"skill": "alpaca-trader", "cmd": "account", "fields": ["equity","buying_power"]},
  {"skill": "alpaca-trader", "cmd": "positions", "intent": "summary"},
  {"skill": "alpaca-trader", "cmd": "movers", "intent": "top 5"}
]'
```

### Session Event Tracking
```bash
# Log a session event
python3 scripts/ctx_session.py log --type "trade" --priority critical --data '{"action":"buy","symbol":"AAPL","qty":100}'

# Build compaction snapshot (called before conversation compacts)
python3 scripts/ctx_session.py snapshot

# Restore from snapshot (called on session resume)
python3 scripts/ctx_session.py restore

# View session stats
python3 scripts/ctx_session.py stats
```

### Context Search (Query Indexed Data)
```bash
python3 scripts/ctx_search.py "high IV options" [--source alpaca-trader]
python3 scripts/ctx_search.py "losing positions" --source last-run
```

### Context Stats
```bash
python3 scripts/ctx_stats.py
# Shows: total bytes saved, calls made, avg compression ratio, session events
```

## How It Saves Tokens

| Operation | Without Context Saver | With Context Saver | Savings |
|-----------|----------------------|-------------------|---------|
| Account summary | 3 KB JSON | 120 B summary | 96% |
| Positions (8 stocks) | 5 KB JSON | 300 B summary | 94% |
| Options chain (AAPL) | 20-50 KB | 500 B filtered | 97% |
| Morning brief pipeline | 23 KB (4 calls) | 2 KB (1 batch) | 91% |
| Session cold start | 20 KB workspace files | 2 KB snapshot | 90% |

## When to Use
- Any data-heavy skill command (trading, analytics, search)
- Multi-step pipelines (morning briefs, EOD analysis)
- Session resumption after compaction
- When context window is running low
- Don't use for small operations (<500 bytes output)
- Don't use when you need full raw data for editing/modification

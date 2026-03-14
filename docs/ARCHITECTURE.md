# Architecture

## Overview

Context Saver is a three-layer token optimization system for OpenClaw. It sits between the Claude context window and skill subprocesses, ensuring that only compact, relevant data enters the conversation.

## Three-Layer Approach

### Layer 1: Sandbox Runner

The sandbox runner (`ctx_run.py`) executes skill commands in subprocesses. The full output is captured but never returned directly to the context window.

```
┌──────────────────────────────────────────┐
│           Claude Context Window           │
│                                          │
│  Input:  "What's my buying power?"       │
│  Output: {"buying_power": "45231.50"}    │  ← 35 bytes
│                                          │
└──────────────────┬───────────────────────┘
                   │
            ┌──────┴──────┐
            │  ctx_run.py │
            │  (sandbox)  │
            └──────┬──────┘
                   │
            ┌──────┴──────┐
            │ alpaca_cli  │
            │  account    │
            └──────┬──────┘
                   │
            ┌──────┴──────┐
            │  3,072 B    │  ← Full response (never enters context)
            │  raw JSON   │
            └─────────────┘
```

**How it works:**

1. `ctx_run.py` receives `--skill` and `--cmd` arguments
2. Locates the skill's main script in `$OPENCLAW_HOME/workspace/skills/<name>/scripts/`
3. Spawns a subprocess with `subprocess.run()` (30-second timeout)
4. Environment variables loaded from `$OPENCLAW_HOME/.env`
5. Captures stdout/stderr completely
6. Passes output to Layer 2 (filtering)
7. Passes full output to FTS5 index (Layer 3)

### Layer 2: Intent Filter

The intent filter reduces captured output to only the fields relevant to the user's question.

**Three filtering modes:**

| Mode | Trigger | Mechanism |
|------|---------|-----------|
| Field selection | `--fields "equity,buying_power"` | Direct key extraction |
| Intent filtering | `--intent "find losing positions"` | Keyword scoring |
| Default | Neither flag | Scalar fields only |

**Intent-driven filtering algorithm:**

```
For each field/item in data:
  score = 0
  For each keyword in intent:
    If keyword matches field name: score += 2
    If keyword matches field value: score += 1

  Special handlers:
    "losing/loss" intent → boost items where PnL < 0 (score += 5)
    "top/best" intent → boost items by absolute change value

Sort by score descending
Return top N items (N extracted from intent or default 5/10)
```

This is deliberately simple. No ML, no embeddings, no external dependencies. Fast keyword matching handles 90%+ of real-world intents correctly.

### Layer 3: Session Continuity

The session tracker (`ctx_session.py`) maintains an event log that survives conversation compaction.

```
┌─────────────────────────────────────────┐
│          Conversation Lifecycle          │
│                                         │
│  Start → Events accumulate → Compaction │
│                    │              │      │
│                    ▼              ▼      │
│              ┌─────────┐  ┌──────────┐  │
│              │ events   │  │ snapshot │  │
│              │ table    │→ │ 2 KB     │  │
│              │ (SQLite) │  │ budget   │  │
│              └─────────┘  └────┬─────┘  │
│                                │        │
│  Resume ← Restore snapshot ←──┘        │
└─────────────────────────────────────────┘
```

## SQLite Schemas

### Stats Database (`context/stats.db`)

**runs table** -- Tracks every sandboxed execution:

```sql
CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,         -- ISO 8601 UTC
    skill TEXT NOT NULL,             -- e.g., "alpaca-trader"
    command TEXT NOT NULL,           -- e.g., "account"
    intent TEXT,                     -- e.g., "check balance" (nullable)
    raw_bytes INTEGER NOT NULL,      -- Size of full output
    summary_bytes INTEGER NOT NULL,  -- Size of filtered summary
    savings_pct REAL NOT NULL        -- Compression percentage
);
```

**fts_index table** -- FTS5 virtual table for full-text search:

```sql
CREATE VIRTUAL TABLE fts_index USING fts5(
    skill,      -- Skill name (filterable column)
    command,    -- Command that produced this output
    content,    -- Full raw output text
    timestamp   -- When indexed
);
```

### Sessions Database (`context/sessions.db`)

**events table** -- Priority-tagged session events:

```sql
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,       -- e.g., "trade", "alert", "decision"
    priority TEXT NOT NULL,          -- critical, high, medium, low
    priority_level INTEGER NOT NULL, -- 1-4 (for sorting)
    data TEXT NOT NULL,              -- JSON payload
    byte_size INTEGER NOT NULL       -- Size of data field
);
```

**snapshots table** -- Compaction survival snapshots:

```sql
CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    session_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,   -- JSON snapshot content
    byte_size INTEGER NOT NULL
);
```

## FTS5 Indexing

SQLite FTS5 (Full-Text Search 5) provides fast, ranked text search without external dependencies.

**How it works:**

1. Every `ctx_run.py` execution indexes the full raw output
2. Content is tokenized by FTS5's default tokenizer (unicode61)
3. Queries use FTS5 match syntax: `"high IV" AND puts`
4. Results are ranked by BM25 (built into FTS5)
5. `ctx_search.py` provides the query interface

**Why FTS5:**
- Built into Python's sqlite3 module (no pip install)
- Handles 100K+ documents efficiently
- BM25 ranking out of the box
- Supports prefix queries, phrase matching, boolean operators

## Snapshot Budget Allocation

The snapshot builder operates within a strict 2 KB budget (configurable via `CTX_SNAPSHOT_BUDGET`).

```
Total Budget: 2,048 bytes
├── P1 Critical (40%): 819 bytes
│   └── Trades, stop losses, system alerts
├── P2 High (30%):     614 bytes
│   └── Price alerts, large PnL changes
├── P3 Medium (20%):   410 bytes
│   └── Analysis results, routine checks
└── P4 Low (10%):      205 bytes
    └── Informational queries, minor updates
```

**Allocation algorithm:**

1. Calculate byte budget for each priority tier
2. For each tier, fetch events ordered by timestamp (newest first)
3. Add events until the tier budget is exhausted
4. Serialize the complete snapshot as compact JSON (no whitespace)
5. Store in the snapshots table for later retrieval

This ensures that even in a busy session with hundreds of events, the snapshot never exceeds 2 KB, and critical events are always preserved.

## Event Priority System

| Priority | Level | Label | Budget | Retention | Examples |
|----------|-------|-------|--------|-----------|----------|
| Critical | 1 | P1 | 40% | Always kept | Trades executed, stop losses triggered, system errors |
| High | 2 | P2 | 30% | Kept if space | Price alerts, large PnL swings, position changes |
| Medium | 3 | P3 | 20% | Best effort | Analysis results, market summaries, routine checks |
| Low | 4 | P4 | 10% | Space permitting | Info queries, status checks, minor updates |

## Data Flow

### Single Command Flow

```
User asks question
       │
       ▼
Claude invokes ctx_run.py
       │
       ├──→ Load .env variables
       ├──→ Locate skill script
       ├──→ subprocess.run(skill_cmd)
       │         │
       │         ▼
       │    Raw output (3-50 KB)
       │         │
       │         ├──→ Index in FTS5
       │         │
       │         ├──→ Apply filter (intent/fields/default)
       │         │         │
       │         │         ▼
       │         │    Filtered summary (100-500 B)
       │         │
       │         └──→ Record stats (runs table)
       │
       ▼
Return JSON to Claude context
  {success, summary, bytes_saved, savings_pct}
```

### Batch Flow

```
Claude invokes ctx_batch.py
       │
       ├──→ Parse command specs (JSON array)
       │
       ├──→ For each spec:
       │       └──→ subprocess.run(ctx_run.py ...)
       │                 │
       │                 └──→ (Single command flow above)
       │
       ▼
Return combined JSON
  {commands_run, total_bytes_saved, results[]}
```

### Session Lifecycle

```
Session Start
       │
       ├──→ Generate session_id (YYYYMMDD-HHMMSS)
       │
       ├──→ Events logged throughout session
       │       ctx_session.py log --type X --priority Y --data Z
       │
       ├──→ Before compaction:
       │       ctx_session.py snapshot
       │       (builds 2 KB snapshot from events)
       │
       ├──→ After compaction:
       │       ctx_session.py restore
       │       (loads most recent snapshot into context)
       │
       └──→ Stats available:
               ctx_session.py stats
```

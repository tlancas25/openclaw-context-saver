# Integration Guide

## Overview

This guide explains how to integrate Context Saver with existing OpenClaw skills, pipelines, and session management.

## Adding --summary Flags to Skill Scripts

The simplest integration is adding a `--summary` flag to your skill scripts that outputs a compact version of the response.

### Before (full output only)

```python
# my_skill/scripts/my_script.py
def handle_query():
    result = api_call()
    print(json.dumps(result))  # 5 KB output
```

### After (summary-aware)

```python
# my_skill/scripts/my_script.py
import argparse

def summarize(data, fields=None):
    """Extract only key fields for context-saving."""
    if fields:
        return {k: v for k, v in data.items() if k in fields}
    # Default: scalar values only
    return {k: v for k, v in data.items() if not isinstance(v, (dict, list))}

def handle_query(summary=False, fields=None):
    result = api_call()
    if summary:
        result = summarize(result, fields)
    print(json.dumps(result))

parser = argparse.ArgumentParser()
parser.add_argument("--summary", action="store_true", help="Output compact summary")
parser.add_argument("--fields", help="Comma-separated fields to include")
args = parser.parse_args()
handle_query(summary=args.summary, fields=args.fields.split(",") if args.fields else None)
```

This approach lets `ctx_run.py` work with your skill even without the `--summary` flag (it applies its own filtering), but skills that natively support `--summary` produce better, domain-aware summaries.

## Using ctx_run.py as a Wrapper

Instead of calling skill scripts directly, wrap them with `ctx_run.py`:

### Direct call (full output enters context)

```bash
python3 ~/.openclaw/workspace/skills/alpaca-trader/scripts/alpaca_cli.py account
# Returns: 3 KB JSON (all 40+ fields)
```

### Wrapped call (filtered output enters context)

```bash
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "account" --intent "check balance"
# Returns: 120 B JSON (3 relevant fields)
```

### In SKILL.md documentation

Update your skill's SKILL.md to recommend Context Saver for data-heavy operations:

```markdown
## Commands

### Account Info
```bash
# Full output (use when you need all fields)
python3 scripts/alpaca_cli.py account

# Token-saving (recommended for routine checks)
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_run.py \
  --skill alpaca-trader --cmd "account" --intent "check balance"
```
```

## Setting Up Session Tracking Hooks

### Manual Event Logging

Log significant events as they happen:

```bash
# After executing a trade
python3 scripts/ctx_session.py log \
  --type "trade" \
  --priority critical \
  --data '{"action":"buy","symbol":"AAPL","qty":100,"price":"225.50"}'

# After an alert triggers
python3 scripts/ctx_session.py log \
  --type "alert" \
  --priority high \
  --data '{"symbol":"TSLA","condition":"price_below","threshold":"180.00"}'

# After analysis completes
python3 scripts/ctx_session.py log \
  --type "analysis" \
  --priority medium \
  --data '{"result":"bullish","confidence":"0.75","timeframe":"1W"}'
```

### Automated Event Logging in Skill Scripts

Add session logging directly to your skill scripts:

```python
import subprocess
import json

def log_event(event_type, priority, data):
    """Log an event to the context-saver session tracker."""
    ctx_session = os.path.expanduser(
        "~/.openclaw/workspace/skills/context-saver/scripts/ctx_session.py"
    )
    subprocess.run([
        "python3", ctx_session, "log",
        "--type", event_type,
        "--priority", priority,
        "--data", json.dumps(data),
    ], capture_output=True)

# In your trade execution function:
def execute_trade(symbol, qty, side):
    result = alpaca_api.submit_order(symbol=symbol, qty=qty, side=side)
    log_event("trade", "critical", {
        "action": side,
        "symbol": symbol,
        "qty": qty,
        "order_id": result["id"],
    })
    return result
```

## Configuring HEARTBEAT.md for Snapshot Triggers

OpenClaw's HEARTBEAT.md system can trigger context snapshots before compaction.

### Add to HEARTBEAT.md

```markdown
## Pre-Compaction Hook

Before conversation compaction, run:
```bash
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_session.py snapshot
```

## Post-Compaction Hook

After conversation resumes, run:
```bash
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_session.py restore
```
```

### Automatic Snapshot Trigger

If your OpenClaw instance monitors context window usage, trigger snapshots when usage exceeds a threshold:

```python
# In your context monitor
if context_usage_pct > 80:
    subprocess.run([
        "python3",
        os.path.expanduser(
            "~/.openclaw/workspace/skills/context-saver/scripts/ctx_session.py"
        ),
        "snapshot",
    ])
```

## Pipeline Integration with workflow-engine

### Converting Existing Pipelines

Transform workflow-engine pipelines to use Context Saver's batch execution.

**Before (workflow-engine pipeline):**

```json
{
  "name": "morning-brief",
  "steps": [
    {
      "id": "get_account",
      "skill": "alpaca-trader",
      "command": "python3 scripts/alpaca_cli.py account",
      "output": "$account"
    },
    {
      "id": "get_positions",
      "skill": "alpaca-trader",
      "command": "python3 scripts/alpaca_cli.py positions",
      "output": "$positions"
    }
  ]
}
```

**After (Context Saver batch pipeline):**

```json
{
  "name": "morning-brief-ctx",
  "description": "Morning brief with context-saving batch execution",
  "steps": [
    {
      "id": "batch_data",
      "skill": "context-saver",
      "cmd": "batch",
      "commands": [
        {"skill": "alpaca-trader", "cmd": "account", "fields": ["equity", "buying_power", "day_pnl"]},
        {"skill": "alpaca-trader", "cmd": "positions", "intent": "summary with PnL"},
        {"skill": "alpaca-trader", "cmd": "movers", "intent": "top 5 by volume"}
      ]
    }
  ]
}
```

### Hybrid Approach

Use Context Saver for data-heavy steps and direct execution for lightweight ones:

```json
{
  "steps": [
    {
      "id": "get_data",
      "comment": "Heavy data -- use context-saver",
      "skill": "context-saver",
      "command": "python3 scripts/ctx_batch.py --commands '[...]'"
    },
    {
      "id": "notify",
      "comment": "Lightweight -- direct execution is fine",
      "skill": "notification-router",
      "command": "python3 scripts/notify.py send --to user --subject 'Brief'"
    }
  ]
}
```

## Environment Configuration

### Required Setup

```bash
# Ensure OPENCLAW_HOME is set (defaults to ~/.openclaw)
export OPENCLAW_HOME=~/.openclaw

# Create the context directory
mkdir -p $OPENCLAW_HOME/context

# Verify the skill is accessible
python3 $OPENCLAW_HOME/workspace/skills/context-saver/scripts/ctx_stats.py
```

### Custom Snapshot Budget

```bash
# Default is 2048 bytes (2 KB)
# Increase for sessions with many critical events
export CTX_SNAPSHOT_BUDGET=4096

# Decrease for extremely token-constrained environments
export CTX_SNAPSHOT_BUDGET=1024
```

### Disabling FTS5 Indexing

If disk space is a concern or you don't need search:

```bash
export CTX_FTS_ENABLED=0
```

## Troubleshooting

### "Skill not found" Error

Ensure the skill directory exists at `$OPENCLAW_HOME/workspace/skills/<name>/` and contains a `scripts/` subdirectory with at least one `.py` file.

### Empty Summaries

If summaries are empty, the intent filter may not be matching any fields. Try:
1. Using `--fields` for explicit field selection
2. Using `--raw` to see the full output
3. Adjusting intent keywords to match actual field names

### Large FTS Index

The FTS index grows with each `ctx_run.py` execution. To clean old entries:

```sql
-- Connect to stats.db
DELETE FROM fts_index WHERE timestamp < datetime('now', '-7 days');
```

### Session ID Issues

Session IDs are stored in `$OPENCLAW_HOME/context/.session_id`. To start a fresh session:

```bash
rm $OPENCLAW_HOME/context/.session_id
```

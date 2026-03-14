#!/usr/bin/env python3
"""Sandboxed skill execution with intent filtering and FTS5 indexing.

Runs an OpenClaw skill command in a subprocess, captures the full output,
applies intent-driven filtering or field selection, indexes the result in
SQLite FTS5, and returns a compact summary to stdout.

The full output never enters the context window. Use ctx_search.py to
query indexed data on demand.
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

OPENCLAW_HOME = os.environ.get("OPENCLAW_HOME", os.path.expanduser("~/.openclaw"))
SKILLS_DIR = os.path.join(OPENCLAW_HOME, "workspace/skills")
ENV_FILE = os.path.join(OPENCLAW_HOME, ".env")
DB_PATH = os.path.join(OPENCLAW_HOME, "context/stats.db")


def ensure_db():
    """Create stats database and tables if they don't exist."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            skill TEXT NOT NULL,
            command TEXT NOT NULL,
            intent TEXT,
            raw_bytes INTEGER NOT NULL,
            summary_bytes INTEGER NOT NULL,
            savings_pct REAL NOT NULL
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
            skill, command, content, timestamp
        )
    """)
    conn.commit()
    return conn


def load_env():
    """Load environment variables from .env file."""
    env = os.environ.copy()
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env[key.strip()] = value.strip().strip("\"'")
    return env


def find_skill_script(skill_name):
    """Locate the main script for a skill."""
    skill_dir = os.path.join(SKILLS_DIR, skill_name)
    if not os.path.isdir(skill_dir):
        return None
    scripts_dir = os.path.join(skill_dir, "scripts")
    if os.path.isdir(scripts_dir):
        for f in os.listdir(scripts_dir):
            if f.endswith(".py") and not f.startswith("_"):
                return os.path.join(scripts_dir, f)
    return None


def run_skill(skill_name, command, env):
    """Execute a skill command in a subprocess and capture output."""
    script = find_skill_script(skill_name)
    if not script:
        return None, f"Skill '{skill_name}' not found in {SKILLS_DIR}"

    full_cmd = f"python3 {script} {command}"
    try:
        result = subprocess.run(
            full_cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
            cwd=os.path.join(SKILLS_DIR, skill_name),
        )
        if result.returncode != 0:
            return None, result.stderr.strip() or f"Command exited with code {result.returncode}"
        return result.stdout.strip(), None
    except subprocess.TimeoutExpired:
        return None, "Command timed out after 30 seconds"
    except Exception as e:
        return None, str(e)


def filter_by_fields(data, fields):
    """Extract only specified fields from a JSON object."""
    if isinstance(data, dict):
        return {k: v for k, v in data.items() if k in fields}
    if isinstance(data, list):
        return [filter_by_fields(item, fields) for item in data]
    return data


def filter_by_intent(data, intent):
    """Apply intent-driven filtering to extract relevant data.

    Uses keyword matching against JSON keys and values. Deliberately
    simple -- no ML, no embeddings, just fast keyword matching.
    """
    intent_lower = intent.lower()
    keywords = intent_lower.split()

    if isinstance(data, dict):
        scored = {}
        for key, value in data.items():
            score = 0
            key_lower = key.lower()
            val_str = str(value).lower()
            for kw in keywords:
                if kw in key_lower:
                    score += 2
                if kw in val_str:
                    score += 1
            if score > 0:
                scored[key] = (value, score)

        if scored:
            sorted_fields = sorted(scored.items(), key=lambda x: x[1][1], reverse=True)
            return {k: v[0] for k, v in sorted_fields[:10]}
        return {k: v for i, (k, v) in enumerate(data.items()) if i < 5}

    if isinstance(data, list):
        scored_items = []
        for item in data:
            score = 0
            item_str = json.dumps(item).lower()
            for kw in keywords:
                if kw in item_str:
                    score += 1
            # Special handling for common intents
            if isinstance(item, dict):
                if "losing" in intent_lower or "loss" in intent_lower:
                    for k in ("unrealized_pl", "pnl", "profit_loss", "pl"):
                        if k in item:
                            try:
                                if float(item[k]) < 0:
                                    score += 5
                            except (ValueError, TypeError):
                                pass
                if "top" in intent_lower or "best" in intent_lower:
                    for k in ("change_pct", "percent_change", "change"):
                        if k in item:
                            try:
                                score += abs(float(item[k]))
                            except (ValueError, TypeError):
                                pass
            scored_items.append((item, score))

        scored_items.sort(key=lambda x: x[1], reverse=True)

        # Try to extract a count from intent (e.g., "top 5")
        limit = 5
        for kw in keywords:
            try:
                limit = int(kw)
                break
            except ValueError:
                pass

        return [item for item, score in scored_items[:limit] if score > 0] or \
               [item for item, _ in scored_items[:limit]]

    return data


def index_output(conn, skill, command, content, timestamp):
    """Index the full output in FTS5 for later search."""
    try:
        conn.execute(
            "INSERT INTO fts_index (skill, command, content, timestamp) VALUES (?, ?, ?, ?)",
            (skill, command, content, timestamp),
        )
        conn.commit()
    except Exception:
        pass  # FTS indexing is best-effort


def record_stats(conn, skill, command, intent, raw_bytes, summary_bytes, timestamp):
    """Record execution stats."""
    savings = ((raw_bytes - summary_bytes) / raw_bytes * 100) if raw_bytes > 0 else 0
    conn.execute(
        "INSERT INTO runs (timestamp, skill, command, intent, raw_bytes, summary_bytes, savings_pct) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (timestamp, skill, command, intent, raw_bytes, summary_bytes, savings),
    )
    conn.commit()
    return savings


def main():
    parser = argparse.ArgumentParser(
        description="Run an OpenClaw skill command in a sandbox with automatic summarization.",
        epilog="Example: ctx_run.py --skill alpaca-trader --cmd 'account' --intent 'check balance'",
    )
    parser.add_argument("--skill", required=True, help="Name of the skill to execute")
    parser.add_argument("--cmd", required=True, help="Command to pass to the skill script")
    parser.add_argument("--intent", help="Intent string for filtering (e.g., 'find losing positions')")
    parser.add_argument("--fields", help="Comma-separated list of fields to extract")
    parser.add_argument("--raw", action="store_true", help="Return full output without filtering")
    args = parser.parse_args()

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    env = load_env()
    conn = ensure_db()

    try:
        raw_output, error = run_skill(args.skill, args.cmd, env)
        if error:
            result = {"success": False, "error": error, "skill": args.skill, "command": args.cmd}
            print(json.dumps(result))
            sys.exit(1)

        raw_bytes = len(raw_output.encode("utf-8"))

        # Index full output
        index_output(conn, args.skill, args.cmd, raw_output, timestamp)

        if args.raw:
            print(raw_output)
            record_stats(conn, args.skill, args.cmd, args.intent, raw_bytes, raw_bytes, timestamp)
            return

        # Parse and filter
        try:
            data = json.loads(raw_output)
        except json.JSONDecodeError:
            # Non-JSON output: return as-is but truncated
            summary = raw_output[:500]
            summary_bytes = len(summary.encode("utf-8"))
            savings = record_stats(conn, args.skill, args.cmd, args.intent, raw_bytes, summary_bytes, timestamp)
            result = {
                "success": True,
                "summary": summary,
                "bytes_saved": raw_bytes - summary_bytes,
                "savings_pct": round(savings, 1),
            }
            print(json.dumps(result))
            return

        # Apply filtering
        if args.fields:
            fields = [f.strip() for f in args.fields.split(",")]
            filtered = filter_by_fields(data, fields)
        elif args.intent:
            filtered = filter_by_intent(data, args.intent)
        else:
            # Default: extract top-level keys with scalar values
            if isinstance(data, dict):
                filtered = {k: v for k, v in data.items() if not isinstance(v, (dict, list))}
                if not filtered:
                    filtered = {k: v for i, (k, v) in enumerate(data.items()) if i < 5}
            elif isinstance(data, list):
                filtered = data[:5]
            else:
                filtered = data

        summary = json.dumps(filtered, separators=(",", ":"))
        summary_bytes = len(summary.encode("utf-8"))
        savings = record_stats(conn, args.skill, args.cmd, args.intent, raw_bytes, summary_bytes, timestamp)

        result = {
            "success": True,
            "skill": args.skill,
            "command": args.cmd,
            "summary": filtered,
            "raw_bytes": raw_bytes,
            "summary_bytes": summary_bytes,
            "bytes_saved": raw_bytes - summary_bytes,
            "savings_pct": round(savings, 1),
        }
        print(json.dumps(result))

    finally:
        conn.close()


if __name__ == "__main__":
    main()

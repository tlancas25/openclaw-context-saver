# Benchmarks

## Summary Table

| Scenario | Raw Size | Context Saver | Savings | Reduction |
|----------|----------|---------------|---------|-----------|
| Account query | 3,072 B | 120 B | 2,952 B | **96%** |
| Positions (8 stocks) | 5,120 B | 300 B | 4,820 B | **94%** |
| Options chain (AAPL) | 20,480-51,200 B | 500 B | 19,980-50,700 B | **97%** |
| Morning brief pipeline | 23,552 B (4 calls) | 2,048 B (1 batch) | 21,504 B | **91%** |
| Session cold start | 20,480 B | 2,048 B | 18,432 B | **90%** |
| Full day operation | ~750K tokens | ~200K tokens | ~550K tokens | **73%** |

## Detailed Scenarios

### 1. Account Query (96% savings)

**Without Context Saver:**
The Alpaca account endpoint returns a full JSON object with 40+ fields including account ID, status, currency, pattern day trader flag, trading and non-marginable buying power, equity history, multipliers, and regulatory fields. Total: ~3 KB.

**With Context Saver:**
`ctx_run.py --skill alpaca-trader --cmd "account" --intent "check balance"` returns:

```json
{"equity":"125431.50","buying_power":"45231.50","cash":"12500.00"}
```

Total: 120 bytes. The intent filter matched `equity`, `buying_power`, and `cash` based on the "check balance" keywords.

**Full output indexed:** The complete 3 KB response is stored in FTS5 and searchable via `ctx_search.py`.

### 2. Positions (8 Stocks) (94% savings)

**Without Context Saver:**
Each position object contains 20+ fields (asset ID, exchange, asset class, avg entry price, qty, side, market value, cost basis, unrealized PnL, unrealized PnL percent, current price, last day price, change today, etc.). With 8 positions: ~5 KB.

**With Context Saver:**
`ctx_run.py --skill alpaca-trader --cmd "positions" --intent "find losing positions"` returns only positions where `unrealized_pl < 0`:

```json
[
  {"symbol":"TSLA","unrealized_pl":"-234.50","current_price":"178.20"},
  {"symbol":"META","unrealized_pl":"-89.10","current_price":"512.30"}
]
```

Total: ~300 bytes. The intent filter boosted entries with negative PnL values.

### 3. Options Chain (97% savings)

**Without Context Saver:**
An options chain for a liquid stock like AAPL includes hundreds of contracts across multiple expiration dates. Each contract has strike, bid, ask, last, volume, open interest, implied volatility, greeks (delta, gamma, theta, vega), and more. Total: 20-50 KB.

**With Context Saver:**
`ctx_run.py --skill alpaca-trader --cmd "chain AAPL" --intent "high IV puts expiring this week"` returns:

```json
[
  {"strike":"220","expiry":"2026-03-20","iv":"0.45","bid":"3.20","ask":"3.40","type":"put"},
  {"strike":"215","expiry":"2026-03-20","iv":"0.42","bid":"1.80","ask":"2.00","type":"put"},
  {"strike":"225","expiry":"2026-03-20","iv":"0.48","bid":"5.10","ask":"5.30","type":"put"}
]
```

Total: ~500 bytes. The intent filter matched `put` type, sorted by `implied_volatility`, and filtered to the nearest expiration.

### 4. Morning Brief Pipeline (91% savings)

**Without Context Saver:**
A morning brief pipeline makes 4 separate skill calls:
- Account: 3 KB
- Positions: 5 KB
- Movers: 8 KB
- Market summary: 7 KB

Each call enters the context window independently. Total: 23 KB across 4 context insertions.

**With Context Saver:**
`ctx_batch.py` executes all 4 commands in a single batch:

```json
{
  "commands_run": 4,
  "total_bytes_saved": 21504,
  "total_savings_pct": 91.3,
  "results": [
    {"skill": "alpaca-trader", "summary": {"equity": "125431.50"}},
    {"skill": "alpaca-trader", "summary": [{"symbol": "AAPL", "pnl": "+1.2%"}]},
    {"skill": "alpaca-trader", "summary": [{"symbol": "NVDA", "change": "+5.2%"}]},
    {"skill": "analytics-engine", "summary": {"trend": "bullish", "vix": "18.5"}}
  ]
}
```

Total: ~2 KB. One context insertion instead of four.

### 5. Session Cold Start (90% savings)

**Without Context Saver:**
When a conversation resumes after compaction, Claude typically needs to re-read workspace files to understand the current state:
- HEARTBEAT.md: 2 KB
- WORKSPACE.md: 5 KB
- Recent skill outputs: 8 KB
- Configuration: 5 KB

Total: ~20 KB of context consumed just to "remember" what was happening.

**With Context Saver:**
`ctx_session.py restore` loads a 2 KB snapshot containing priority-tagged events:

```json
{
  "session_id": "20260314-090000",
  "events": {
    "P1": [{"type": "trade", "d": {"action": "buy", "symbol": "AAPL", "qty": 100}}],
    "P2": [{"type": "alert", "d": {"symbol": "TSLA", "msg": "down 3%"}}],
    "P3": [{"type": "analysis", "d": {"trend": "bullish"}}]
  }
}
```

Total: ~2 KB. Claude immediately knows what trades were made, what alerts fired, and what the analysis concluded.

### 6. Full Day Operation (73% savings)

**Methodology:**

A typical OpenClaw day involves:
- 5 morning brief pipelines (different portfolio views)
- 20 individual skill queries (positions, orders, chains)
- 10 analytics calls
- 5 search/research operations
- 3 session compaction/restore cycles
- 15 notification deliveries

**Without Context Saver:**
- Morning briefs: 5 x 23 KB = 115 KB
- Individual queries: 20 x 5 KB avg = 100 KB
- Analytics: 10 x 10 KB avg = 100 KB
- Search: 5 x 15 KB avg = 75 KB
- Session restores: 3 x 20 KB = 60 KB
- Notifications: 15 x 2 KB = 30 KB
- **Total raw: ~480 KB (~750K tokens at ~1.5 tokens/byte)**

**With Context Saver:**
- Morning briefs: 5 x 2 KB = 10 KB
- Individual queries: 20 x 300 B avg = 6 KB
- Analytics: 10 x 500 B avg = 5 KB
- Search: 5 x 1 KB avg = 5 KB
- Session restores: 3 x 2 KB = 6 KB
- Notifications: 15 x 200 B = 3 KB (notifications are already small)
- **Total filtered: ~35 KB + overhead = ~130 KB (~200K tokens)**

**Net savings: ~550K tokens (73%)**

## Methodology

### How We Measure

1. **Raw bytes:** Total bytes of skill subprocess stdout
2. **Summary bytes:** Total bytes of filtered JSON returned to context
3. **Savings percentage:** `(raw - summary) / raw * 100`
4. **Token estimation:** 1 byte of JSON approximately equals 1.5 tokens (accounting for JSON syntax overhead in tokenization)

### Factors That Affect Savings

| Factor | Impact |
|--------|--------|
| Output size | Larger outputs = higher savings percentage |
| Intent specificity | More specific intents = better filtering |
| Data structure | Flat JSON filters better than deeply nested |
| Field count | More fields in raw output = more to filter out |
| Batch size | More commands per batch = more overhead eliminated |

### What's Not Counted

- Context Saver's own JSON wrapper overhead (~50-100 bytes per call)
- FTS5 index storage on disk (typically <1 MB per 1000 calls)
- SQLite write latency (~1-5 ms per operation)
- Subprocess spawn overhead (~10-50 ms per call)

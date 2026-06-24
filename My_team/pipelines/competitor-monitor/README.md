# Competitor Monitor

Fetches pricing pages from 5 competitors every Monday, extracts pricing with Claude, detects changes, and sends a weekly summary.

## Schedule

Every **Monday at 10am Melbourne time (AEST)**.

## Competitors tracked

- Smith.ai
- Goodcall
- Synthflow
- Ruby
- Tidio

## How it works

1. **Page fetch** — Downloads each competitor's pricing page (10s timeout), strips HTML to plain text.
2. **Pricing extraction** — Claude parses the text and returns structured JSON: plans, prices, features.
3. **History check** — Reads last week's prices from "Competitor Prices" sheet.
4. **Change detection** — Compares current vs previous. If any price changed, sends an immediate alert.
5. **Sheet update** — Appends a new row with all current prices.
6. **Weekly summary** — Emails a complete pricing table to ahmadusama200@gmail.com regardless of changes.

## Google Sheets tab

**Competitor Prices** — Date, Smith.ai, Goodcall, Synthflow, Ruby, Tidio, Changes Detected

## Run

```bash
node systems/competitor-monitor/index.js --test
npm run competitor-monitor:test

node systems/competitor-monitor/index.js
npm run competitor-monitor
```

## Logs

- `logs/competitor-monitor.log`
- `logs/competitor-monitor-errors.log`

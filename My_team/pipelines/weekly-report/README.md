# Weekly Performance Report

Compiles outreach data from Apollo, Gmail, and Google Sheets, runs it through Claude for analysis, and emails a formatted report every Monday morning.

## Schedule

Every **Monday at 8am Melbourne time (AEST)** — report lands in your inbox before the work week starts.

## How it works

1. **Apollo stats** — Fetches active sequences and 7-day analytics (sent, delivered, opened, replied, bounced) from the Apollo API.
2. **Gmail stats** — Counts total inbox replies from the last 7 days.
3. **Sheets data** — Reads "Hot Leads" and "Replies" tabs, counts leads and classifies reply types (interested, not interested, question, OOO, other).
4. **Claude analysis** — Sends all data to Claude for a brief report: what worked, what needs fixing, one action item, and the overall trend.
5. **Email delivery** — Sends the formatted report to ahmadusama200@gmail.com.

## Google Sheets tabs used

- **Hot Leads** — reads Timestamp (col A), Name, Email, Company, Status
- **Replies** — reads Timestamp (col A), Classification (col D)

## Run

```bash
# Test mode — run once and exit
node systems/weekly-report/index.js --test
npm run weekly-report:test

# Production — starts cron (Monday 8am AEST)
node systems/weekly-report/index.js
npm run weekly-report
```

## Environment variables

All standard variables plus:

- `APOLLO_API_KEY` — Apollo.io API key (optional — report still works without it, just skips Apollo data)

## Logs

- `logs/weekly-report.log` — all activity
- `logs/weekly-report-errors.log` — errors only

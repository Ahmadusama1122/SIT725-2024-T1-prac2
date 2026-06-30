# CLAUDE.md — My Team AI

> Last updated: 2026-06-30

## What This Project Is

A 24/7 multi-agent AI marketing system for ReceptFlow (www.receptflow.com). Runs on Railway, orchestrated via Discord bot (`My Team AI#4406`). 15 AI agents execute 24 automated pipelines for prospecting, outreach, SEO, content, and system monitoring.

## Tech Stack

- **Runtime**: Node.js 20, PM2, Express (port 3000)
- **AI**: Anthropic Claude API (Haiku for scheduled, Sonnet for on-demand)
- **Database**: SQLite (better-sqlite3) at `/data/team.db`
- **APIs**: Gmail (3 inboxes), Apollo.io, LinkedIn, Google Sheets, GitHub, Discord, Twilio, Buffer
- **Browser**: Playwright Chromium (SERP scraping, LinkedIn automation)
- **Deploy**: Railway via Dockerfile, auto-deploy on push to `main`

## Project Structure

```
/agents/              15 AI agents (each has index.js + persona.md)
/pipelines/           24 marketing automation pipelines
/orchestrator/        Task routing, scheduling, priority engine
/shared/              23 reusable modules (Gmail, Sheets, Claude, etc.)
/data/                SQLite database
/projects/            Project-specific configs
/schedules/           Cron schedules (default.json)
/logs/                Execution logs + apollo-credits.json
/blog-posts/          Generated SEO content
/assets/              Generated images
/scripts/             Utility scripts
```

## Agents (15)

| Agent | Discord Channel | Role |
|-------|----------------|------|
| sales-prospector | #sales | Apollo searches, lead gen, ICP targeting |
| prospect-sender | #sales | On-demand email sending (CLI: `--count N --source auto\|apollo\|web`) |
| outreach-manager | #sales | LinkedIn outreach, follow-ups, closing |
| customer-support | #support | Reply monitoring, demo followup, onboarding |
| content-creator | #marketing | Blog posts, landing pages, email sequences |
| social-media-manager | #marketing | LinkedIn posts, Buffer scheduling |
| seo-analyst | #marketing | SEO strategy, keyword research, SERP analysis |
| marketing-auditor | #marketing | Full website audits with PDF reports |
| data-analyst | #reports | KPI tracking, weekly reports, intelligence |
| devops-engineer | #engineering | Health checks, Railway infrastructure |
| fullstack-developer | #engineering | Feature development, bug fixes |
| qa-engineer | #engineering | Testing, deployment validation |
| security-engineer | #security | Vulnerability scanning, dependency audits |
| product-strategist | #general | Market research, PRDs, roadmaps |
| cost-guardian | #alerts | API cost monitoring, budget enforcement |

## Pipelines (24)

| # | Pipeline | Agent | Schedule |
|---|----------|-------|----------|
| 1 | prospect-finder | sales-prospector | Weekdays 7am AEST |
| 2 | prospect-sender | prospect-sender | CLI only (no cron) |
| 3 | review-monitor | sales-prospector | On schedule |
| 4 | apollo-monitor | sales-prospector | Weekdays 7:30am AEST |
| 5 | follow-up | outreach-manager | On schedule |
| 6 | linkedin-outreach | outreach-manager | Weekdays 8:30am AEST |
| 7 | voice-caller | outreach-manager | On schedule |
| 8 | reply-monitor | customer-support | Every 6 hours |
| 9 | demo-followup | customer-support | On schedule |
| 10 | onboarding-sequence | customer-support | On schedule |
| 11 | seo-generator | seo-analyst | Mon + Thu 9am AEST |
| 12 | competitor-monitor | seo-analyst | Monday 10am AEST |
| 13 | gmb-poster | seo-analyst | Wednesday 9am AEST |
| 14 | review-engine | seo-analyst | Tue + Fri 10am AEST |
| 15 | serp-analyzer | seo-analyst | Sunday 8pm AEST |
| 16 | cluster-builder | seo-analyst | Tuesday 11am AEST |
| 17 | internal-linker | seo-analyst | Wednesday 11am AEST |
| 18 | linkedin-generator | social-media-manager | Monday 9am AEST (1/week) |
| 19 | content-repurposer | social-media-manager | Friday 11am AEST |
| 20 | reddit-monitor | social-media-manager | Mon + Wed 11am AEST |
| 21 | intelligence | data-analyst | Weekdays 7am AEST |
| 22 | weekly-report | data-analyst | On schedule |
| 23 | health-check | devops-engineer | Daily 6am AEST |
| 24 | guardian | devops-engineer | Every 6 hours |

## Email System

### 3 Gmail Inboxes
- **Primary**: hello@receptflow.com (100/day limit)
- **Secondary**: outreach@receptflow.com (100/day limit)
- **Tertiary**: contact@receptflow.com (100/day limit)
- **Total**: 300 emails/day, round-robin assignment
- **Signature**: `\n\nwww.receptflow.com` (all inboxes)
- **Alert email**: ahmadusama200@gmail.com

### Deduplication
Never re-emails the same person. Checks:
- Daily Prospects sheet (all-time)
- Replies sheet
- Hot Leads sheet

## Prospecting System

### Country Rotation (Weekdays)
| Day | Country | City |
|-----|---------|------|
| Mon | Australia | Sydney, NSW |
| Tue | Australia | Brisbane, QLD |
| Wed | United Kingdom | London |
| Thu | Australia | Melbourne, VIC |
| Fri | Australia | Perth, WA |

### 9 Niches (6 per day, rotating)
consulting, wellness clinic, medical clinic, dental, law, physio, trades, real estate, IT services

### Target: 50 prospects per niche, 300 total/day

### Source Selection (auto mode)
- Apollo credits >= 100 remaining: Use Apollo (`/mixed_people/api_search` + `/people/match` enrichment)
- Apollo credits < 100: Auto-switch to web scraper (Google search + website email extraction)
- Can be forced via `--source apollo|web`
- Apollo budget: 80 API calls per niche max

### Quality Scoring (0-10, min threshold: 6)
- Employees 1-5: +2, 6-10: +1
- Has website: +2
- Owner/Founder title: +2, Principal/Director: +1
- Verified email: +2, web-scraped with website: +1
- Has LinkedIn: +1

### Prospect Sender CLI
```bash
node pipelines/prospect-sender/index.js --count 300 --run-now
node pipelines/prospect-sender/index.js --count 50 --source web --run-now
node pipelines/prospect-sender/index.js --niche dental,law --city Sydney --run-now
node pipelines/prospect-sender/index.js --count 10 --test
```

## SEO System
- Competitor-aware: targets 110% of competitor word count
- Covers all competitor topics + PAA questions
- Publishes to GitHub via API
- Pings IndexNow for Bing/Yandex indexing
- 100+ keywords rotating through list

## LinkedIn Posts
- 1 post per week (Monday 9am AEST)
- Auto-appends `www.receptflow.com` to every post
- Topics rotate: pain-point posts + build-in-public posts

## Orchestrator
- Runs every 30 minutes
- Task sources: Discord commands, Notion, GitHub Issues, SQLite queue
- Routing: keyword matching first (free), Claude Haiku fallback
- 7 agent chains for complex tasks (launch-project, marketing-campaign, lead-generation, etc.)
- Priority engine: P1 (critical) to P5 (low)
- Auto-disables agents after 3 consecutive failures

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point — Express server + Discord bot + orchestrator + pipelines |
| `pipelines/runner.js` | Starts all 24 pipelines |
| `orchestrator/task-router.js` | Agent registry + keyword routing + Claude fallback |
| `agents/base-agent.js` | Agent factory + 30 tools + per-agent whitelists |
| `shared/pipeline-config.js` | Env var adapter (UPPER_CASE to camelCase) |
| `shared/pipeline-constants.js` | ALERT_EMAIL, SHEETS tab names, APOLLO_BASE URL |
| `shared/pipeline-gmail.js` | Gmail send/search/draft with 3-inbox support |
| `shared/pipeline-sheets.js` | Google Sheets read/write |
| `shared/pipeline-claude.js` | Claude wrapper for pipelines |
| `shared/discord-notifier.js` | Discord bot + 10 channel message routing |
| `pipelines/prospect-finder/niche-config.js` | Niches, country rotation, inbox limits, titles |
| `pipelines/prospect-finder/apollo-search.js` | Apollo search + enrichment + web scraper routing |
| `pipelines/prospect-finder/web-scraper.js` | Google search + website email extraction fallback |
| `pipelines/prospect-sender/index.js` | CLI agent for on-demand email sending |

## Google Sheets Tabs
- **Daily Prospects** — all outreach emails sent
- **Replies** — prospect replies
- **Hot Leads** — qualified leads
- **Follow-Ups** — follow-up tracking
- **Review Prospects** — prospects needing review
- **Apollo Credits** — daily credit snapshots

## Country Pricing
| Country | Currency | Price |
|---------|----------|-------|
| Australia | AUD | $49/month |
| New Zealand | NZD | $55/month |
| United Kingdom | GBP | £35/month |

## Deployment
```bash
# Deploy to Railway
railway up --detach

# Manual pipeline runs
node pipelines/prospect-finder/index.js --run-now
node pipelines/prospect-finder/index.js --test
node pipelines/seo-generator/index.js --test

# Check credits
node check-credits.js

# Check send counts
node check-sends.js
```

## Session Rules
- At the end of every session, update this CLAUDE.md with any new agents, pipelines, config changes, or important decisions made during the session.

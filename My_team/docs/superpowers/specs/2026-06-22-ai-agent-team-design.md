# AI Agent Team for SaaS Projects — Design Spec

**Date:** 2026-06-22
**Status:** Approved
**Approach:** Monolithic Orchestrator (Approach A)

---

## 1. Overview

A single Node.js application deployed on Railway 24/7 that operates as a fully autonomous AI team capable of handling any SaaS project end-to-end. One orchestrator manages 12 specialized agent modules, each with its own role definition (persona), skills, and tool access. Tasks come in from Notion, GitHub Issues, or Discord. Results go to the right destination automatically.

### Core Principles

- **Project-agnostic:** Works with any SaaS project by loading project-specific config and context
- **Fully autonomous:** Agents decide and execute independently. No human approval required for routine tasks
- **Stack-agnostic:** Development agents can work with any tech stack
- **Self-healing:** Guardian monitors all agents, auto-restarts on failure, dead letter queue for failed tasks
- **Extensible:** New agents and new projects added via folder + config, no code restructuring

### Tools & Infrastructure

- **Claude API (Anthropic)** — Core reasoning engine for all agents. User has Claude Max subscription; API key obtained from console.anthropic.com. All agents call the Anthropic Messages API directly
- **Railway** — 24/7 deployment, single service + persistent volume
- **Apollo** — Lead generation and contact enrichment
- **GitHub** — Code repos, Issues, PRs
- **Notion** — Task board and project wiki
- **Discord** — Notifications, reports, human commands
- **SQLite** — Task history, agent memory, execution logs
- **PM2** — Process management inside Docker container

---

## 2. Team Structure — 12 Agents

### LEADERSHIP

| # | Agent | Role | Responsibilities |
|---|-------|------|-----------------|
| 1 | **Chief Orchestrator** | CEO/PM | Reads task boards (Notion + GitHub Issues), prioritizes work, routes tasks to the right agent, tracks progress, handles agent-to-agent chains, posts status updates to Discord |

### PRODUCT & ENGINEERING

| # | Agent | Role | Responsibilities |
|---|-------|------|-----------------|
| 2 | **Product Strategist** | Product Manager | Market research, competitive analysis, feature prioritization, writes PRDs, defines user stories. Uses web search + Exa for deep research |
| 3 | **Full-Stack Developer** | Lead Engineer | Writes code (any stack), builds APIs, creates databases, implements features. Generates code files pushed to GitHub repos |
| 4 | **QA Engineer** | Testing/QA | Writes and runs tests, reviews code for bugs, validates deployments, generates test reports. Screenshots everything |
| 5 | **DevOps Engineer** | Infrastructure | Manages Railway deployments, Dockerfiles, CI/CD, monitoring, health checks, environment configs |

### MARKETING & CONTENT

| # | Agent | Role | Responsibilities |
|---|-------|------|-----------------|
| 6 | **Content Creator** | Writer | Blog posts, landing pages, email sequences, lead magnets, documentation. SEO-optimized |
| 7 | **Social Media Manager** | Social | Creates social posts, schedules via Buffer/Notion, designs carousels, manages posting calendar |
| 8 | **SEO Analyst** | SEO/Growth | Keyword research, content strategy, competitor analysis, on-page optimization, tracks rankings |

### SALES & OUTREACH

| # | Agent | Role | Responsibilities |
|---|-------|------|-----------------|
| 9 | **Sales Prospector** | Lead Gen | Uses Apollo + Clay to find prospects, enriches data, scores leads, builds target lists by ICP |
| 10 | **Outreach Manager** | Sales Outreach | LinkedIn automation, cold email sequences, follow-ups, personalized messaging at scale |

### SUPPORT & ANALYTICS

| # | Agent | Role | Responsibilities |
|---|-------|------|-----------------|
| 11 | **Customer Support** | Support | Monitors support channels, drafts responses, escalates complex issues, maintains FAQ/knowledge base |
| 12 | **Data Analyst** | Analytics | Tracks KPIs across all departments, generates daily/weekly reports, identifies trends, alerts on anomalies |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────┐
│                   RAILWAY (24/7)                     │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │           CHIEF ORCHESTRATOR                   │   │
│  │  - Cron scheduler (runs every 5-15 min)       │   │
│  │  - Task router (reads Notion + GitHub Issues) │   │
│  │  - Agent dispatcher                           │   │
│  │  - Discord notifier                           │   │
│  └──────────┬────────────────────────────────────┘   │
│             │ routes tasks to                        │
│  ┌──────────▼────────────────────────────────────┐   │
│  │              AGENT MODULES                     │   │
│  │  (12 agents, each with persona + skills)      │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │           SHARED LAYER                         │   │
│  │  - Claude API client (Claude Max)             │   │
│  │  - Project registry (multi-project config)    │   │
│  │  - Skill library (reusable prompts/templates) │   │
│  │  - Tool connectors (Apollo, GitHub, etc.)     │   │
│  │  - SQLite database (task history, memory)     │   │
│  └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
          │              │              │
          ▼              ▼              ▼
    ┌──────────┐  ┌───────────┐  ┌──────────┐
    │  Notion  │  │  GitHub   │  │  Discord │
    │  (Tasks) │  │  (Code +  │  │  (Alerts │
    │          │  │   Issues) │  │  + Logs) │
    └──────────┘  └───────────┘  └──────────┘
```

---

## 4. File Structure

```
My_team/
├── index.js                     ← Main entry point + orchestrator loop
├── package.json
├── Dockerfile
├── .env                         ← API keys
├── .env.example
├── .gitignore
│
├── orchestrator/
│   ├── index.js                 ← Chief Orchestrator logic
│   ├── task-router.js           ← Analyzes task → picks agent
│   ├── scheduler.js             ← Cron jobs (which agents run when)
│   └── priority-engine.js       ← Task prioritization logic
│
├── agents/
│   ├── product-strategist/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── market-research.md
│   │       ├── competitive-analysis.md
│   │       ├── prd-writer.md
│   │       └── feature-prioritizer.md
│   │
│   ├── fullstack-developer/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── api-builder.md
│   │       ├── frontend-builder.md
│   │       ├── database-designer.md
│   │       └── code-reviewer.md
│   │
│   ├── qa-engineer/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── test-writer.md
│   │       ├── bug-reporter.md
│   │       └── deployment-validator.md
│   │
│   ├── devops-engineer/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── docker-manager.md
│   │       ├── railway-deployer.md
│   │       ├── ci-cd-pipeline.md
│   │       └── health-monitor.md
│   │
│   ├── content-creator/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── blog-writer.md
│   │       ├── landing-page-builder.md
│   │       ├── email-sequence-writer.md
│   │       └── lead-magnet-creator.md
│   │
│   ├── social-media-manager/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── post-creator.md
│   │       ├── carousel-designer.md
│   │       ├── posting-scheduler.md
│   │       └── engagement-tracker.md
│   │
│   ├── seo-analyst/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── keyword-researcher.md
│   │       ├── content-strategist.md
│   │       ├── on-page-optimizer.md
│   │       └── rank-tracker.md
│   │
│   ├── sales-prospector/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── apollo-searcher.md
│   │       ├── clay-enricher.md
│   │       ├── lead-scorer.md
│   │       └── icp-builder.md
│   │
│   ├── outreach-manager/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── linkedin-automator.md
│   │       ├── cold-email-writer.md
│   │       ├── follow-up-sequencer.md
│   │       └── personalization-engine.md
│   │
│   ├── customer-support/
│   │   ├── index.js
│   │   ├── persona.md
│   │   └── skills/
│   │       ├── ticket-responder.md
│   │       ├── faq-maintainer.md
│   │       └── escalation-handler.md
│   │
│   └── data-analyst/
│       ├── index.js
│       ├── persona.md
│       └── skills/
│           ├── kpi-tracker.md
│           ├── daily-report.md
│           ├── weekly-report.md
│           └── anomaly-detector.md
│
├── shared/
│   ├── claude-client.js         ← Claude API wrapper
│   ├── config.js                ← Loads project configs + env vars
│   ├── database.js              ← SQLite for task history + agent memory
│   ├── discord-notifier.js      ← Posts to Discord channels
│   ├── notion-client.js         ← Reads/writes Notion task boards
│   ├── github-client.js         ← Creates issues, PRs, pushes code
│   ├── apollo-client.js         ← Apollo API for prospecting
│   ├── tools.js                 ← Web search, Exa, scraping utilities
│   └── skill-loader.js          ← Loads .md skill files into prompts
│
├── projects/
│   ├── receptflow/
│   │   ├── config.json
│   │   └── context/
│   │       ├── brand-voice.md
│   │       ├── product-overview.md
│   │       ├── target-audience.md
│   │       └── competitors.md
│   └── _template/
│       ├── config.json
│       └── context/
│           └── README.md
│
├── schedules/
│   └── default.json
│
└── docs/
    └── superpowers/
        └── specs/
```

---

## 5. Agent Persona Format

Each agent has a `persona.md` that defines its identity, rules, tools, and output format:

```markdown
# [Agent Name]

## Identity
One paragraph describing who this agent is and what it does.

## Core Rules
- Bullet list of non-negotiable behaviors
- What to always do, what to never do
- How to handle edge cases

## Tools Available
- List of APIs and tools this agent can use

## Skills
- List of skill .md files this agent loads

## Output Format
- Where to send results (Discord channel, GitHub, file, etc.)
- What format the output should be in
```

---

## 6. Task Lifecycle

```
Task Intake (Notion / GitHub Issues / Discord)
    ↓
Orchestrator parses task, identifies project, picks agent
    ↓
Agent loads persona + skills + project context
    ↓
Agent calls Claude API with full prompt
    ↓
Agent executes (uses tools, generates output)
    ↓
Output routed to destination (GitHub / Discord / Notion / files)
    ↓
Task marked complete, logged to SQLite
```

---

## 7. Agent-to-Agent Chains

| Trigger | Chain |
|---------|-------|
| Launch new SaaS project | Product Strategist → Full-Stack Dev → QA → DevOps |
| Run marketing campaign | SEO Analyst → Content Creator → Social Manager → Data Analyst |
| Find and contact leads | Sales Prospector → Outreach Manager → Data Analyst |
| New feature request | Product Strategist → Full-Stack Dev → QA → Content Creator (docs) |
| Customer reported bug | Customer Support → QA Engineer → Full-Stack Dev → DevOps |
| Weekly growth report | Data Analyst pulls from all agents → Discord #reports |

---

## 8. Integration Map

| Service | Used By | Purpose |
|---------|---------|---------|
| Claude API (Anthropic) | All agents | Core reasoning engine via Anthropic Messages API |
| GitHub | Developer, QA, DevOps | Code repos, Issues, PRs, CI/CD triggers |
| Notion | Orchestrator, all agents | Task board, project wiki, content calendar |
| Discord | All agents | Notifications, reports, human commands |
| Apollo | Sales Prospector | Contact/company search, lead enrichment |
| Clay | Sales Prospector | Advanced enrichment, waterfall data |
| Railway | DevOps | Deployment, hosting, env management |
| Google Search API | SEO Analyst, Product Strategist | Keyword research, market research |
| Exa | Product Strategist, Content Creator | Deep neural web search |
| LinkedIn | Outreach Manager | Connection requests, messaging |
| Gmail/SMTP | Outreach Manager, Support | Cold emails, support replies |
| Buffer | Social Media Manager | Schedule social posts (optional) |

---

## 9. Discord Channel Structure

```
#general          ← Team-wide announcements
#orchestrator     ← Task routing logs, system status
#engineering      ← Dev, QA, DevOps updates
#marketing        ← Content, SEO, Social updates
#sales            ← Prospector + Outreach updates, lead lists
#support          ← Customer issues, escalations
#reports          ← Daily/weekly analytics dashboards
#alerts           ← Errors, anomalies, urgent items
#commands         ← You type commands here to trigger agents
```

---

## 10. Database Schema (SQLite)

```sql
-- Task history
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,           -- 'notion', 'github', 'discord', 'scheduled', 'chain'
    project TEXT NOT NULL,
    agent TEXT NOT NULL,
    status TEXT DEFAULT 'pending',  -- 'pending', 'in_progress', 'completed', 'failed'
    input TEXT,
    output TEXT,
    parent_task_id INTEGER,        -- for chain tasks
    retry_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

-- Agent memory (learnings across runs)
CREATE TABLE agent_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Execution logs
CREATE TABLE execution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    result TEXT,
    tokens_used INTEGER,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- Project registry
CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    config_path TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 11. Schedule Configuration

```json
{
  "every_15_minutes": ["orchestrator"],
  "every_hour": ["data-analyst"],
  "every_4_hours": ["seo-analyst", "customer-support"],
  "daily_9am": ["sales-prospector", "content-creator"],
  "daily_10am": ["outreach-manager", "social-media-manager"],
  "weekly_monday": ["product-strategist", "weekly-report"]
}
```

---

## 12. Deployment

### Railway Configuration

- **Service:** Single Node.js container
- **Dockerfile:** Node.js 20 + PM2
- **Volume:** `/data` for SQLite persistence
- **Health check:** `/health` endpoint
- **Resources:** 1GB RAM, 1 vCPU (scale as needed)
- **Restart policy:** Always

### PM2 Configuration

```json
{
  "apps": [
    {
      "name": "orchestrator",
      "script": "index.js",
      "cron_restart": "0 */6 * * *",
      "max_memory_restart": "800M",
      "error_file": "logs/error.log",
      "out_file": "logs/output.log"
    }
  ]
}
```

### Self-Healing

| Mechanism | Description |
|-----------|-------------|
| Health Check | `/health` pinged by Railway every 60s. Returns agent statuses, last run times, error counts |
| Guardian | Built into orchestrator. If an agent fails 3x in a row, disables it and alerts Discord #alerts |
| Auto-restart | PM2 restarts on crash. Cron restarts every 6 hours to clear memory |
| Daily Digest | Data Analyst posts system health summary to Discord every morning |
| Dead Letter Queue | Failed tasks stored in `tasks` table with status `failed`. Auto-retry next cycle or manual retry |

---

## 13. Adding New Projects

1. Copy `projects/_template/` → `projects/my-new-saas/`
2. Fill in `config.json` (name, ICP, brand voice, stack, URLs)
3. Add context docs (product overview, competitors, etc.)
4. Tag tasks on Notion with project name
5. Agents automatically load the right context per task

---

## 14. Adding New Agents

1. Create `agents/new-agent/` folder
2. Write `persona.md` (role, rules, tools, output format)
3. Add skill `.md` files
4. Create `index.js` (copy from existing agent, modify)
5. Register in `orchestrator/task-router.js`
6. Add to `schedules/default.json`
7. Deploy — orchestrator picks it up automatically

---

## 15. Cost Estimate

| Item | Cost |
|------|------|
| Claude Max | Already owned |
| Railway (1 service + volume) | ~$5-10/mo |
| Apollo | Already owned |
| Discord bot | Free |
| Notion API | Free (with existing plan) |
| GitHub | Free |
| Exa API | ~$10-20/mo (optional) |
| **Total additional** | **~$15-30/mo** |

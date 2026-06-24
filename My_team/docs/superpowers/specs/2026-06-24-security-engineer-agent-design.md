# Security Engineer Agent — Design Spec

**Date:** 2026-06-24
**Approach:** Single agent with 6 skills (Approach A)
**Agent name:** `security-engineer`
**Discord channel:** `#security` (new)

---

## Identity & Persona

The Security Engineer is a defensive security specialist that scans code, dependencies, infrastructure, and APIs for vulnerabilities. It thinks like an attacker but reports like a professional auditor.

### Core Rules

- Every finding must include: severity (Critical/High/Medium/Low), location, description, remediation steps
- Never dismiss a finding — report everything, let humans prioritize
- Check code against OWASP Top 10 on every scan
- Treat all user inputs as untrusted, all secrets as potentially exposed
- When unsure about severity, escalate up (Medium becomes High)
- Always output a security score (0-100) for the scanned project

### Output Routing

- All findings → Discord `#security`
- Critical findings → also Discord `#alerts` + GitHub Issue (labeled `security`, `critical`)
- Scorecards → Discord `#security` + `#reports`

---

## Skills (6)

### 1. code-scanner

Static analysis of source code for OWASP Top 10 vulnerabilities:

- SQL/NoSQL injection, XSS, CSRF
- Broken authentication & session management
- Insecure direct object references
- Security misconfigurations (CORS, headers, debug mode)
- Output: list of findings with file path, line number, severity, and fix

### 2. dependency-auditor

Scans dependency files (package.json, requirements.txt, Gemfile, etc.) for known CVEs:

- Checks outdated packages with known vulnerabilities
- Flags unmaintained dependencies (no updates in 12+ months)
- Identifies packages with critical CVE scores (CVSS 7+)
- Output: CVE list with package name, version, CVE ID, severity, and upgrade path

### 3. secrets-detector

Finds hardcoded secrets across the entire codebase:

- API keys, tokens, passwords, connection strings
- .env files committed to git, secrets in Docker configs
- Private keys, certificates in repos
- Checks .gitignore for missing sensitive patterns
- Output: list of exposed secrets with location and remediation (rotate + add to .gitignore)

### 4. infra-hardener

Audits infrastructure and deployment configs:

- Dockerfile: running as root, unnecessary privileges, exposed ports
- Railway/environment: missing env vars, insecure defaults
- SSL/TLS certificate expiry and configuration
- HTTP security headers (HSTS, CSP, X-Frame-Options)
- CORS policy review
- Output: hardening checklist with current state vs recommended state

### 5. penetration-tester

Simulates attack vectors against APIs and endpoints:

- Tests authentication bypass scenarios
- Checks rate limiting on login/signup endpoints
- Tests for privilege escalation (accessing other users' data)
- Input validation testing (malformed payloads, oversized inputs)
- Output: attack report with method, endpoint, result, and risk level

### 6. security-reporter

Generates overall security scorecards:

- Aggregates findings from all other skills
- Calculates security score (0-100) across categories
- Tracks score trends over time (using agent memory)
- Generates actionable summary: top 5 things to fix now
- Output: formatted scorecard posted to Discord #security and #reports

---

## Scheduling

- **Daily at 6am** — full security scan (code + dependencies + secrets + infra)
- Posts morning security scorecard to `#security` before the team starts
- **On-demand** — triggered via Discord commands, Notion tasks, or GitHub issues

---

## Chain Integration

### Modified existing chains

| Chain | Current Flow | New Flow |
|---|---|---|
| `launch-project` | Strategist → Dev → QA → DevOps | Strategist → Dev → QA → **Security** → DevOps |
| `new-feature` | Strategist → Dev → QA → Content | Strategist → Dev → QA → **Security** → Content |
| `bug-fix` | Support → QA → Dev → DevOps | Support → QA → Dev → **Security** → DevOps |

Security sits after QA but before deployment/content — acts as a security gate.

### New dedicated chain

```
security-audit: security-engineer → devops-engineer → data-analyst
```

Triggered by keywords: "security audit", "pen test", "vulnerability scan".

### Task router keywords

`security`, `vulnerability`, `cve`, `hack`, `breach`, `ssl`, `owasp`, `pentest`, `secrets`, `scan code`, `audit security`

---

## Memory (per project)

| Key | Purpose |
|---|---|
| `previous_findings` | Last scan results — diff against to identify new vs recurring issues |
| `security_scores` | Historical scores to track trends (improving/declining) |
| `rotated_secrets` | Secrets flagged and confirmed rotated — avoid re-flagging |
| `suppressed_findings` | False positives marked by humans — skip in future scans |

---

## Reporting Flow

1. Daily scan runs at 6am
2. Compare findings against `previous_findings` in memory
3. New findings → posted to `#security` with **NEW** tag
4. Recurring unfixed findings → re-posted weekly with **UNFIXED** escalation
5. Critical findings → also posted to `#alerts` + GitHub issue created
6. Security scorecard posted to `#security` and `#reports`

---

## Score Calculation

Score starts at 100. Deductions per finding.

| Category | Weight |
|---|---|
| Code vulnerabilities (OWASP) | 30% |
| Dependency CVEs | 20% |
| Exposed secrets | 20% |
| Infrastructure hardening | 15% |
| API security | 15% |

| Severity | Deduction |
|---|---|
| Critical | -15 |
| High | -10 |
| Medium | -5 |
| Low | -2 |

Floor is 0.

---

## Files to Create

```
agents/security-engineer/
├── persona.md
├── index.js
└── skills/
    ├── code-scanner.md
    ├── dependency-auditor.md
    ├── secrets-detector.md
    ├── infra-hardener.md
    ├── penetration-tester.md
    └── security-reporter.md
```

## Files to Modify

- `orchestrator/task-router.js` — add to AGENT_REGISTRY, AGENT_CHAINS, CHAIN_KEYWORDS
- `schedules/default.json` — add daily_6am entry

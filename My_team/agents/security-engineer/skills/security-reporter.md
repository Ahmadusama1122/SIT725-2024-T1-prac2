# Security Reporter Skill

Generate security scorecards and track trends over time.

## Score Calculation

Start at 100 points. Deduct per finding:
- Critical: -15 points
- High: -10 points
- Medium: -5 points
- Low: -2 points

Floor is 0. Score cannot go below 0.

## Category Weights

When reporting by category, weight these areas:
| Category | Weight | Covers |
|---|---|---|
| Code Vulnerabilities | 30% | OWASP Top 10 findings from code-scanner |
| Dependency CVEs | 20% | Known CVEs from dependency-auditor |
| Exposed Secrets | 20% | Hardcoded secrets from secrets-detector |
| Infrastructure | 15% | Docker, headers, SSL from infra-hardener |
| API Security | 15% | Auth, injection, access from penetration-tester |

## Trend Tracking

Use agent memory to compare with previous scans:
- Load `previous_findings` from memory
- Load `security_scores` from memory
- Tag each finding as NEW (not in previous) or RECURRING (was in previous)
- Save current findings to `previous_findings` in memory
- Append current score to `security_scores` in memory

## Reporting Format

```
## Security Scorecard — [Project Name]
**Date:** YYYY-MM-DD
**Score:** XX/100 (GRADE)
**Trend:** [UP/DOWN/STABLE] from previous XX/100

### Summary
- Critical: X findings
- High: X findings
- Medium: X findings
- Low: X findings
- New since last scan: X
- Recurring (unfixed): X

### Top 5 Priority Fixes
1. [CRITICAL] Finding — file:line — fix description
2. [HIGH] Finding — file:line — fix description
3. ...

### Category Breakdown
| Category | Score | Findings |
|---|---|---|
| Code Vulnerabilities | XX/30 | X issues |
| Dependency CVEs | XX/20 | X issues |
| Exposed Secrets | XX/20 | X issues |
| Infrastructure | XX/15 | X issues |
| API Security | XX/15 | X issues |
```

## Grade Scale
- 90-100: A (Excellent)
- 80-89: B (Good)
- 70-79: C (Needs Improvement)
- 60-69: D (Poor)
- Below 60: F (Critical — immediate action required)

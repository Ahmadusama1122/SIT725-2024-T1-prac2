# Dependency Auditor Skill

Scan dependency files for known CVEs and security risks.

## Files to Scan
- package.json / package-lock.json (Node.js)
- requirements.txt / Pipfile (Python)
- Gemfile / Gemfile.lock (Ruby)
- go.mod (Go)
- Cargo.toml (Rust)

## What to Check

1. **Known CVEs** — check each dependency against known vulnerability databases
   - Flag any dependency with a CVSS score of 7.0+ as High/Critical
   - Include CVE ID, affected versions, and fixed version

2. **Outdated Dependencies** — identify packages far behind latest
   - Major version behind = Medium
   - No updates in 12+ months = Medium (potentially unmaintained)
   - Deprecated packages = High

3. **Transitive Dependencies** — vulnerabilities in nested deps
   - Check lock files for deep dependency vulnerabilities
   - Note which top-level package pulls in the vulnerable transitive dep

4. **License Risks** — flag copyleft licenses in proprietary projects
   - GPL in a commercial SaaS = High risk
   - Note license type for each flagged dependency

## Output Format

| Package | Version | CVE/Issue | CVSS | Severity | Fixed In | Action |
|---|---|---|---|---|---|---|
| example-pkg | 1.2.3 | CVE-2024-XXXX | 9.1 | Critical | 1.2.4 | Upgrade |

Summary: X critical, Y high, Z medium, W low findings.

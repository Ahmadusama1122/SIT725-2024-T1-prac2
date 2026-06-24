# Infrastructure Hardener Skill

Audit infrastructure configs, deployment settings, and server hardening.

## Docker Security

1. **Base Image** — use slim/distroless, pin versions, no latest tag
2. **User** — never run as root, use USER directive
3. **Secrets** — no secrets in Dockerfile, use build secrets or runtime env
4. **Ports** — only expose necessary ports
5. **COPY** — use .dockerignore, avoid copying .env, .git, node_modules
6. **Healthcheck** — HEALTHCHECK instruction present

## HTTP Security Headers

Check all endpoints return these headers:
| Header | Expected Value | Severity if Missing |
|---|---|---|
| Strict-Transport-Security | max-age=31536000; includeSubDomains | High |
| Content-Security-Policy | Restrictive policy, no unsafe-inline | High |
| X-Content-Type-Options | nosniff | Medium |
| X-Frame-Options | DENY or SAMEORIGIN | Medium |
| X-XSS-Protection | 0 (rely on CSP instead) | Low |
| Referrer-Policy | strict-origin-when-cross-origin | Low |
| Permissions-Policy | Restrictive camera/microphone/geolocation | Low |

## CORS Policy

- Origin should be explicitly listed, never wildcard (*) in production
- Credentials: true requires explicit origins (not *)
- Methods: only allow needed methods (not *)
- Headers: only allow needed headers

## SSL/TLS

- Certificate expiry: flag if expiring within 30 days
- TLS version: minimum TLS 1.2, prefer 1.3
- No self-signed certificates in production

## Environment Configuration

- All secrets via environment variables, not config files
- No debug/development mode in production
- Database connections use SSL
- Rate limiting configured on public endpoints

## Output Format

Hardening checklist:
| Check | Status | Current | Recommended | Severity |
|---|---|---|---|---|
| Docker runs as non-root | FAIL | root | USER node | High |

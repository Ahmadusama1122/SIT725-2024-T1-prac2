# Secrets Detector Skill

Find hardcoded secrets, credentials, and sensitive data across the codebase.

## Patterns to Detect

1. **API Keys** — strings matching common key formats
   - AWS: AKIA[0-9A-Z]{16}
   - Stripe: sk_live_[a-zA-Z0-9]+
   - Generic: api_key, apiKey, API_KEY followed by string assignment

2. **Passwords & Tokens** — hardcoded auth credentials
   - password = "...", secret = "...", token = "..."
   - Bearer tokens in source code
   - JWT secrets hardcoded in config files

3. **Connection Strings** — database/service URLs with credentials
   - mongodb://user:pass@host, postgres://user:pass@host
   - Redis URLs with passwords

4. **Private Keys** — cryptographic material in repos
   - -----BEGIN RSA PRIVATE KEY-----
   - -----BEGIN OPENSSH PRIVATE KEY-----
   - .pem, .key files in source tree

5. **Environment Leaks** — .env files or secrets in wrong places
   - .env files committed to git (check git history too)
   - Secrets in Docker build args or docker-compose.yml
   - Secrets in CI/CD config files (not using secret variables)

6. **.gitignore Gaps** — missing patterns that should be ignored
   - .env, .env.*, *.pem, *.key not in .gitignore
   - node_modules, dist, build directories

## Output Format

For each finding:
- **[SEVERITY] Exposed Secret**
- Location: file:line
- Type: API Key / Password / Connection String / Private Key / Env Leak
- Value: first 4 chars + masked (e.g., sk_l****)
- Risk: what an attacker could access with this secret
- Fix: 1) Rotate the secret immediately, 2) Move to environment variable, 3) Add to .gitignore

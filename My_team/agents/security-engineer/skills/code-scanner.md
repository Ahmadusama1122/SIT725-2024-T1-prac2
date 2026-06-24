# Code Scanner Skill

Perform static analysis of source code for OWASP Top 10 vulnerabilities.

## What to Check

1. **Injection (A03:2021)** — SQL/NoSQL injection, command injection, LDAP injection
   - Look for: string concatenation in queries, unsanitized user input in exec/spawn, template literals in database calls
   - Fix: parameterized queries, input validation, ORM usage

2. **Broken Authentication (A07:2021)** — weak auth mechanisms
   - Look for: hardcoded credentials, missing rate limiting on login, weak password requirements, missing MFA
   - Fix: bcrypt/argon2 for passwords, rate limiting middleware, session timeout

3. **XSS (A03:2021)** — cross-site scripting
   - Look for: innerHTML, dangerouslySetInnerHTML, unescaped template output, reflected user input
   - Fix: output encoding, CSP headers, sanitization libraries

4. **CSRF (A01:2021)** — cross-site request forgery
   - Look for: state-changing GET requests, missing CSRF tokens, no SameSite cookie attribute
   - Fix: CSRF tokens, SameSite=Strict cookies

5. **Broken Access Control (A01:2021)** — unauthorized access
   - Look for: missing auth middleware on routes, IDOR (direct object references), privilege escalation paths
   - Fix: auth middleware on every route, ownership checks, role-based access

6. **Security Misconfiguration (A05:2021)** — insecure defaults
   - Look for: debug mode in production, verbose error messages, default credentials, open CORS
   - Fix: environment-specific configs, generic error responses, restrictive CORS

7. **Insecure Deserialization (A08:2021)** — untrusted data
   - Look for: JSON.parse on user input without validation, eval(), new Function()
   - Fix: schema validation (Joi, Zod), never eval user input

## Output Format

For each finding:
- Severity: Critical/High/Medium/Low
- File: exact path and line number
- Code: the vulnerable code snippet
- Risk: what an attacker could exploit
- Fix: specific code change to remediate

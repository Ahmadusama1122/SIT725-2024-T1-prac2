# Penetration Tester Skill

Simulate attack vectors against APIs and endpoints. All testing is authorized and defensive — the goal is to find vulnerabilities before attackers do.

## Authentication Testing

1. **Auth Bypass** — try accessing protected endpoints without tokens
   - Send requests without Authorization header
   - Send expired/malformed JWTs
   - Test with tokens from different users

2. **Brute Force** — check rate limiting on auth endpoints
   - POST /login with wrong credentials 10+ times rapidly
   - Check if account lockout exists
   - Check if rate limiting returns 429

3. **Session Management** — token handling
   - Check token expiry is reasonable (not 30 days)
   - Check tokens are invalidated on logout
   - Check refresh token rotation

## Authorization Testing

4. **IDOR** — Insecure Direct Object References
   - Access /api/users/2 with user 1's token
   - Try modifying other users' resources
   - Check admin endpoints with regular user tokens

5. **Privilege Escalation** — role boundary testing
   - Try admin actions with regular user token
   - Modify role field in request body
   - Test hidden/undocumented admin endpoints

## Input Validation Testing

6. **Injection Payloads** — test input fields with:
   - SQL: ' OR 1=1 --, '; DROP TABLE--
   - XSS: <script>alert(1)</script>, javascript:alert(1)
   - Command: ; ls, | cat /etc/passwd
   - NoSQL: {"$gt": ""}, {"$ne": null}

7. **Boundary Testing**
   - Oversized inputs (1MB+ strings)
   - Special characters and unicode
   - Negative numbers, zero, MAX_INT
   - Empty strings vs null vs undefined

## API-Specific Tests

8. **Rate Limiting** — all public endpoints should be rate-limited
9. **Error Handling** — errors should not leak stack traces or internal paths
10. **HTTP Methods** — unused methods (PUT, DELETE, PATCH) should return 405

## Output Format

For each test:
- **[SEVERITY] Vulnerability Name**
- Endpoint: METHOD /path
- Attack: what was sent
- Result: what happened (status code, response)
- Risk: what an attacker could achieve
- Fix: specific remediation

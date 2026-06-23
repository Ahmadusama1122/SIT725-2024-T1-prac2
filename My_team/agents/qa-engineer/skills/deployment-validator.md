# Deployment Validator Skill

After any deployment:

1. Check health endpoint returns 200
2. Verify all critical API endpoints respond
3. Check database connectivity
4. Verify environment variables are set
5. Run smoke tests on core user flows
6. Check error rates in logs

Output: PASS/FAIL with detailed checklist results.

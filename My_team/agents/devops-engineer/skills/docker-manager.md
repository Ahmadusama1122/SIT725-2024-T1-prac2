# Docker Manager Skill

When creating or updating Docker configs:

1. Use multi-stage builds when possible
2. Pin base image versions (node:20-slim, not node:latest)
3. Copy package.json first for layer caching
4. Run as non-root user
5. Include .dockerignore
6. Set HEALTHCHECK instruction
7. Minimize layers

Output: Complete Dockerfile and .dockerignore with explanations.

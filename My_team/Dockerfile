FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ curl && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g pm2

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p /data logs

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["pm2-runtime", "ecosystem.config.js"]

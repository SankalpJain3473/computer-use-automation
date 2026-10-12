# Runs the stand-in bank app and the capability server (control center + agent API) in one container.
# Only the server's port is published; the bank app is reached by the server's browser over localhost.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN chown -R 1000:1000 /app
USER 1000

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    TARGET_APP_PORT=4173 \
    TARGET_APP_URL=http://localhost:4173 \
    MAX_ACTIVE_RUNS=2 \
    HEADLESS=true

EXPOSE 7860
CMD ["sh", "docker/start.sh"]

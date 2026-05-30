# Codex Mobile Review server — repo-agnostic, runs in OrbStack on the mini.
FROM oven/bun:1

WORKDIR /app

# Only the server needs to ship: source + UI + manifest. No runtime deps.
COPY package.json tsconfig.json ./
COPY src ./src
COPY web ./web

ENV CODEX_REVIEW_DB=/data/sessions.db
ENV CODEX_REVIEW_WEB_DIR=/app/web
ENV PORT=7799

EXPOSE 7799
VOLUME ["/data"]

CMD ["bun", "run", "src/server.ts"]

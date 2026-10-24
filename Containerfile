# Images from one file (one stage each):
#   podman build --target engine -t agent-engine-core .  # API server: apps/server on packages/*, model via Ollama
#   podman build --target ui     -t agent-engine-ui .    # apps/ui, static build + proxy server
# Kept as a single root file because podman-compose on Windows drops `dockerfile:` paths.

# --- engine build: workspace libraries in packages/* plus the server app ---
FROM docker.io/library/node:24-slim AS engine-build
RUN npm install -g pnpm@11.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/provider-ollama/package.json packages/provider-ollama/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @agent-engine/server...
COPY packages/engine packages/engine
COPY packages/provider-ollama packages/provider-ollama
RUN pnpm --filter "@agent-engine/server^..." -r build
COPY apps/server apps/server

# --- engine: runtime image serving the API on :3000 ---
# Env: API_KEYS (required), MODEL=ollama|simulated, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_NUM_CTX, PORT.
FROM docker.io/library/node:24-slim AS engine
ENV NODE_ENV=production
COPY --from=engine-build /app /app
USER node
EXPOSE 3000
WORKDIR /app/apps/server
CMD ["node", "src/index.ts"]

# --- ui build: Vite bundle (no engine code needed, it only talks HTTP) ---
FROM docker.io/library/node:24-slim AS ui-build
RUN npm install -g pnpm@11.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps/ui/package.json apps/ui/
RUN pnpm install --frozen-lockfile --filter @agent-engine/ui
COPY apps/ui apps/ui
RUN pnpm --filter @agent-engine/ui build

# --- ui: runtime image, dependency-free static server that proxies /services to the engine ---
FROM docker.io/library/node:24-slim AS ui
ENV NODE_ENV=production PORT=8080 API_URL=http://localhost:3000
WORKDIR /app
COPY --from=ui-build /app/apps/ui/package.json /app/apps/ui/server.ts ./
COPY --from=ui-build /app/apps/ui/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "server.ts"]

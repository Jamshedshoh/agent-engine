# Two images from one file (one stage each):
#   podman build --target engine  -t agent-engine-core .     # packages/* (core + provider-anthropic)
#   podman build --target example -t agent-engine-example .  # apps/example, layered on the engine stage
# Kept as a single root file because podman-compose on Windows drops `dockerfile:` paths.

# --- engine: workspace libraries in packages/* ---
FROM docker.io/library/node:24-slim AS engine
RUN npm install -g pnpm@11.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/provider-anthropic/package.json packages/provider-anthropic/
RUN pnpm install --frozen-lockfile --filter "./packages/**"
COPY packages/engine packages/engine
COPY packages/provider-anthropic packages/provider-anthropic
RUN pnpm --filter "./packages/**" -r build

# --- example app build, on top of the engine ---
FROM engine AS example-build
COPY apps/example/package.json apps/example/
RUN pnpm install --frozen-lockfile --filter @agent-engine/example...
COPY apps/example apps/example

# --- example: runtime image ---
FROM docker.io/library/node:24-slim AS example
ENV NODE_ENV=production
COPY --from=example-build /app /app
USER node
EXPOSE 3000
WORKDIR /app/apps/example
# MODEL=anthropic + ANTHROPIC_API_KEY switches from the offline SimulatedModel to Claude.
CMD ["node", "src/index.ts"]

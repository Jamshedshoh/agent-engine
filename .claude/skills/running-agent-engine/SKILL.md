---
name: running-agent-engine
description: Use when asked to run, start, restart, stop, rebuild, smoke-test or screenshot the agent-engine API server or web UI, locally or on podman; or when podman compose fails with "internal libpod error", a container still runs old code after a rebuild, the UI returns "Engine unreachable", or requests return 401/400/502 unexpectedly.
---

# Running agent-engine

## Overview

Two runnable units: **engine** (API server, `apps/server` on `packages/*`, port 3000) and **ui** (`apps/ui`, port 8080 in podman, 5173 in dev).

Keys come from `API_KEYS` (`key=userId:role1,role2;...`; roles are admin, builder and viewer). When it's unset, the dev keys are `dev-admin-key` (everything) and `dev-viewer-key` (read/run, cannot create agents). Every route needs `Authorization: Bearer <key>`. A browser address bar can't send it, so a 401 there is expected.

## Podman (default)

```bash
podman compose --profile ollama up -d ollama      # model server first; model must be pulled (docs/ollama-podman.md)
podman compose up --build -d --force-recreate   # always --force-recreate: without it the old container keeps running old code
podman ps -a --filter name=agent-engine --format '{{.Names}}  {{.Status}}'   # engine + ui "Up"
podman logs agent-engine_engine_1 | tail -1      # "agent engine on :3000 (model provider: ollama qwen2.5:0.5b @ ...)"
podman compose down                              # stop
```

Config comes from `.env` (git- and container-ignored; see `.env.example`): `MODEL=ollama|simulated`, `OLLAMA_URL`, `OLLAMA_MODEL`, `API_KEYS`. After editing it, run `podman compose up -d`. Never print `.env` raw; redact values.

## Local (no containers)

```bash
pnpm server    # API on :3000 (run in background; needs API_KEYS in the environment)
pnpm ui        # Vite on :5173, proxies /services to :3000
```

Stopping the background task leaves turbo's node child holding the port. Free it explicitly: in PowerShell, `Get-NetTCPConnection -LocalPort 3000 -State Listen` gives the PID, then `Stop-Process -Id <pid> -Force`. Do the same for 5173.

## Smoke-test the API

```bash
A='Authorization: Bearer dev-admin-key'; J='Content-Type: application/json'; B=localhost:3000/services/agents
ID=$(curl -s -X POST -H "$A" -H "$J" -d '{"name":"t","tools":["add"]}' $B | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -sN -H "$A" $B/$ID/events > events.txt &                      # listen (SSE)
curl -s -X POST -H "$A" -H "$J" -d '{"prompt":"add 2 and 3"}' $B/$ID/messages
curl -s -H "$A" $B/$ID/messages; curl -s -X DELETE -H "$A" $B/$ID
```

Bodies are strict: the run route takes `{"prompt": "..."}`. A key like `"input"` returns a 400. Send the same requests to `localhost:8080/services/...` to test the UI's proxy.

## Drive the UI

There's no chromium-cli on this machine, so use `playwright-core` with the installed Edge (no browser download):

```bash
D=<scratchpad>/drive; mkdir -p "$D"; cp .claude/skills/running-agent-engine/scripts/drive-ui.mjs "$D/"
cd "$D" && npm init -y >/dev/null && npm i playwright-core --silent && node drive-ui.mjs http://localhost:8080 "$D/shots"
```

Then **Read the PNGs**. The only acceptable console errors are one 401 and one 403, both triggered on purpose.

## Gotchas

| Symptom | Cause / fix |
|---|---|
| `internal libpod error` starting `ui` | podman starts dependencies transitively, which breaks when a dependency has exited. Keep `ui` free of `depends_on` and `network_mode: service:...`. |
| UI → `Engine unreachable` (502) | Under pasta, `host.containers.internal` times out here. Use `API_URL=http://169.254.1.2:3000`. |
| Rebuilt, but behavior unchanged | Add `--force-recreate`. Confirm with `podman exec agent-engine_engine_1 grep -c <new-symbol> src/index.ts`. |
| 502 `upstream_error` | Read `podman logs agent-engine_engine_1`; it prints Ollama's reason. "unreachable": start the ollama service. "model ... not found": `podman exec agent-engine_ollama_1 ollama pull <model>`. |
| `External volume [ollama] does not exist` | `podman volume create ollama`, then pull the model again. |
| engine exits at start with `API_KEYS ...` | Fix the `API_KEYS` format in `.env` (`key=userId:role,...;...`). The error names the bad entry by position. |
| `curl` in PowerShell ignores `-H` | It's an alias for `Invoke-WebRequest`. Use `curl.exe` or the Bash tool. |
| `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` | `allowBuilds: esbuild: true` must stay in `pnpm-workspace.yaml`. |

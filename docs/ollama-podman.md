# Running a local model with Ollama on Podman

Runs [Ollama](https://ollama.com) in a podman container and serves open-weight models on
`http://localhost:11434`, entirely offline once the model is downloaded.

Verified on Windows 11 + podman 6.1.4 (WSL machine, pasta networking), Ollama 0.40.10, `qwen2.5:0.5b`.

> **In agent-engine:** this is the engine's model server. `packages/provider-ollama` talks to it, and
> `podman compose` points the `engine` service at `http://169.254.1.2:11434` with `qwen2.5:0.5b`.
> Override this with `MODEL`, `OLLAMA_URL`, `OLLAMA_MODEL` and `OLLAMA_NUM_CTX` in `.env`. Start Ollama
> and pull the model before starting the engine (steps 2 and 3).

## 1. Check resources

Ollama on podman runs on **CPU** unless the podman machine can see an NVIDIA GPU. Integrated AMD
graphics (as on this machine) is not usable from WSL. Budget RAM for the model plus ~1 GB:

| Model | Download | RAM in use | Notes |
|---|---|---|---|
| `qwen2.5:0.5b` | 397 MB | ~0.5 GB | **Default.** Very fast on CPU, supports tool calls. Small: follows wording loosely and is weak at reasoning. |
| `qwen3:1.7b` | 1.4 GB | ~2 GB | Noticeably smarter and still quick. Supports tool calls. Pass `"think": false` to skip its reasoning output. |
| `llama3.2:3b` | 2.0 GB | ~3 GB | Supports tool calls. |
| `qwen3:8b` | 5.2 GB | ~6 GB | Better quality, slow on CPU. Needs a bigger podman machine. |

```bash
podman info --format '{{.Host.MemTotal}} {{.Host.CPUs}}'    # memory (bytes) and CPUs podman can use
```

## 2. Start Ollama

Use **one** of these. Both store models in the same named volume `ollama`, so a model is downloaded
once.

**A. Standalone container**

```bash
podman volume create ollama
podman run -d --name ollama --network pasta -p 11434:11434 \
  -v ollama:/root/.ollama -e OLLAMA_KEEP_ALIVE=30m \
  --restart unless-stopped docker.io/ollama/ollama:0.40.10
```

**B. With this repo's compose file** (an opt-in `ollama` profile, so a plain `up` never starts it)

```bash
podman volume create ollama                     # once; the compose file uses it as an external volume
podman compose --profile ollama up -d ollama
```

Check that it's up:

```bash
curl -s localhost:11434/api/version             # {"version":"0.40.10"}
podman logs ollama 2>&1 | grep "inference compute"   # library=cpu, or a GPU entry
```

With compose, the container is named `agent-engine_ollama_1`. Use that name in place of `ollama` in
the commands below.

## 3. Download a model

```bash
podman exec ollama ollama pull qwen2.5:0.5b
podman exec ollama ollama list
podman exec ollama ollama ps        # loaded models: size, CPU/GPU, how long they stay loaded
```

## 4. Try it

The first request loads the model into memory (~1 s here). After that, a short reply takes ~0.2 s,
and the model stays loaded for `OLLAMA_KEEP_ALIVE` (30 minutes).

```bash
# Native chat API
curl -s localhost:11434/api/chat -d '{"model":"qwen2.5:0.5b","stream":false,
  "messages":[{"role":"user","content":"Reply with exactly: pong"}]}'

# Tool calling
curl -s localhost:11434/api/chat -d '{"model":"qwen2.5:0.5b","stream":false,
  "messages":[{"role":"user","content":"Add 2 and 3 using the tool."}],
  "tools":[{"type":"function","function":{"name":"add","description":"Add two numbers",
    "parameters":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}}}]}'
# -> "tool_calls":[{"function":{"name":"add","arguments":{"a":2,"b":3}}}]

# OpenAI-compatible API, for clients that speak that format
curl -s localhost:11434/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"Say hi in one word."}]}'

# Interactive chat in the terminal
podman exec -it ollama ollama run qwen2.5:0.5b
```

In **PowerShell**, use `curl.exe` (plain `curl` is an alias for `Invoke-WebRequest`) or:

```powershell
Invoke-RestMethod http://localhost:11434/api/chat -Method Post -ContentType application/json `
  -Body '{"model":"qwen2.5:0.5b","stream":false,"messages":[{"role":"user","content":"hi"}]}'
```

## 5. Reach it from other containers

On pasta networking, another container reaches the host's published ports at **`169.254.1.2`**, so
Ollama is `http://169.254.1.2:11434`. Don't use `host.containers.internal`: on this WSL setup it
resolves to an address that pasta doesn't route, and connections time out.

```bash
podman run --rm --network pasta docker.io/library/node:24-slim \
  node -e "fetch('http://169.254.1.2:11434/api/tags').then(r=>r.json()).then(j=>console.log(j.models.map(m=>m.name)))"
```

## 6. Stop, update, clean up

```bash
podman stop ollama && podman rm ollama               # A: stop; models stay in the volume
podman compose --profile ollama down                 # B: stop (plain `down` leaves ollama running)
podman exec ollama ollama rm qwen2.5:0.5b            # delete one model
podman volume rm ollama                              # delete all models (container must be removed first)
```

Pin the image to a version tag rather than `latest`, so a re-pull can't silently change the server.
To update, change the tag (`0.40.10`), recreate the container, then remove the old image with
`podman rmi docker.io/ollama/ollama:<old-tag>`. The models in the volume carry over.

## GPU (not verified on this machine)

- **NVIDIA:** install the NVIDIA Container Toolkit in the podman machine, generate a CDI spec
  (`nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`), then add `--device nvidia.com/gpu=all`
  to `podman run`. `podman logs` should then show a CUDA device in "inference compute".
- **AMD:** needs the `ollama/ollama:<version>-rocm` image and `--device /dev/kfd --device /dev/dri`
  on a native Linux host with a ROCm-supported GPU. This doesn't work for integrated Radeon graphics
  under WSL.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl localhost:11434` fails, `podman ps` shows the container | Check `podman logs ollama`. Port 11434 may already be taken by Ollama installed on Windows: quit that app, or publish `-p 11435:11434`. |
| Model fails to load / container restarts | Not enough memory. Use a smaller model or give the podman machine more RAM. |
| Very slow replies | Expected on CPU for models above ~3B parameters. Use `qwen2.5:0.5b`, or keep the model loaded with `OLLAMA_KEEP_ALIVE`. |
| Answers ignore instructions or tool calls are wrong | `qwen2.5:0.5b` is tiny. Try `qwen3:1.7b` (with `"think": false`). |
| `not all containers could be removed from pod` on plain `podman compose down` | Harmless: ollama is still running in the project's pod. Use `--profile ollama down` to stop everything. |
| `volume ollama not found` with compose | Run `podman volume create ollama` once (the compose file uses it as an external volume). |

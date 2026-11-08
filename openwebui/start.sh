#!/usr/bin/env bash
# Start a reproducible, fully local Open WebUI test stack (no Docker needed):
#
#   MCP feature-test server   http://127.0.0.1:3600/mcp   (node dist/http.js)
#   fake OpenAI-compatible LLM http://127.0.0.1:3601/v1   (openwebui/fake-llm.mjs)
#   Open WebUI                 http://127.0.0.1:3602       (pip package in a uv venv)
#   trace proxy (modern)       http://127.0.0.1:3603/mcp → 3600, logs JSON-RPC to $WORK/trace.log
#   trace proxy (legacy)       http://127.0.0.1:3604/mcp → 3600, FORCE_LEGACY=1 → $WORK/trace-legacy.log
#
# Open WebUI gets two MCP connections: "featuretest" (via 3603, negotiates 2026-07-28)
# and "featuretest-legacy" (via 3604, discover is refused → 2025-11-25 initialize handshake).
# setup.mjs then creates the models "mcp-tester" and "mcp-tester-legacy".
#
# Env: WORK (state dir, default /tmp/owui-mcp-test), OWUI_VERSION (default 0.13.2),
#      OWUI_VENV (default $WORK/venv), OWUI_PYTHON (default 3.12).
# Stop with openwebui/stop.sh. Logs: $WORK/*.log
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
WORK="${WORK:-/tmp/owui-mcp-test}"
OWUI_VERSION="${OWUI_VERSION:-0.13.2}"
OWUI_VENV="${OWUI_VENV:-$WORK/venv}"
OWUI_PYTHON="${OWUI_PYTHON:-3.12}"
mkdir -p "$WORK/data"
pids="$WORK/pids"; : > "$pids"

if [ ! -x "$OWUI_VENV/bin/open-webui" ]; then
  echo "Installing open-webui==$OWUI_VERSION into $OWUI_VENV (Python $OWUI_PYTHON; takes a few minutes)…"
  uv venv --python "$OWUI_PYTHON" "$OWUI_VENV"
  VIRTUAL_ENV="$OWUI_VENV" uv pip install "open-webui==$OWUI_VERSION"
fi

[ -f "$repo/dist/http.js" ] || (cd "$repo" && npm run build)

start() { # name, logfile, command...
  local name="$1" log="$2"; shift 2
  "$@" > "$log" 2>&1 &
  echo "$! $name" >> "$pids"
}

start mcp          "$WORK/mcp.log"          env PORT=3600 node "$repo/dist/http.js"
start fake-llm     "$WORK/llm.log"          env PORT=3601 node "$here/fake-llm.mjs"
start proxy        "$WORK/trace.log"        env PORT=3603 TARGET=http://127.0.0.1:3600 node "$here/mcp-trace-proxy.mjs"
start proxy-legacy "$WORK/trace-legacy.log" env PORT=3604 TARGET=http://127.0.0.1:3600 FORCE_LEGACY=1 node "$here/mcp-trace-proxy.mjs"

TOOL_SERVER_CONNECTIONS='[
 {"type":"mcp","url":"http://127.0.0.1:3603/mcp","path":"","auth_type":"none","key":"","info":{"id":"featuretest","name":"MCP Feature Test"},"config":{"enable":true}},
 {"type":"mcp","url":"http://127.0.0.1:3604/mcp","path":"","auth_type":"none","key":"","info":{"id":"featuretest-legacy","name":"MCP Feature Test (legacy handshake)"},"config":{"enable":true}}
]'

(cd "$WORK/data" && start open-webui "$WORK/owui.log" env \
  DATA_DIR="$WORK/data" \
  WEBUI_AUTH=False \
  WEBUI_SECRET_KEY=mcp-feature-test-not-a-secret \
  ENABLE_PERSISTENT_CONFIG=False \
  ENABLE_OLLAMA_API=False \
  OPENAI_API_BASE_URLS=http://127.0.0.1:3601/v1 \
  OPENAI_API_KEYS=dummy \
  TOOL_SERVER_CONNECTIONS="$TOOL_SERVER_CONNECTIONS" \
  ENABLE_TITLE_GENERATION=False ENABLE_TAGS_GENERATION=False ENABLE_FOLLOW_UP_GENERATION=False \
  ENABLE_VERSION_UPDATE_CHECK=False ANONYMIZED_TELEMETRY=False \
  HF_HUB_OFFLINE=1 RAG_EMBEDDING_MODEL_AUTO_UPDATE=False \
  "$OWUI_VENV/bin/open-webui" serve --host 127.0.0.1 --port 3602)

echo -n "Waiting for Open WebUI on :3602 "
for _ in $(seq 1 300); do
  curl -sf http://127.0.0.1:3602/health >/dev/null && break
  echo -n .; sleep 1
done
echo
curl -sf http://127.0.0.1:3602/health >/dev/null || { echo "Open WebUI did not start; see $WORK/owui.log"; exit 1; }

OWUI_URL=http://127.0.0.1:3602 node "$here/setup.mjs" > /dev/null
echo "Ready: http://127.0.0.1:3602  (models: mcp-tester, mcp-tester-legacy)"
echo "Run:   node openwebui/drive.mjs     |  stop: openwebui/stop.sh"

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Fact Checker — one-command launcher (macOS / Linux)
#
#    ./run.sh            production build + start (fastest for demos)
#    ./run.sh --dev      Next.js dev server with hot reload
#    PORT=3020 ./run.sh  choose a port (default from app.config.ts; next free one if busy)
#    FACTCHECK_NO_OPEN=1 don't open the browser automatically
#
#  Language-model work runs locally through Ollama. Live checks also need the internet
#  (news feeds, Wikipedia, GDELT, and any search keys you add). This script never
#  downloads a model without asking first, and never starts a cloud service.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

MODE="prod"
[[ "${1:-}" == "--dev" ]] && MODE="dev"

# Load optional local settings (FACTCHECK_MODEL, OLLAMA_HOST, keys…) without printing them.
if [[ -f .env.local ]]; then set -a; # shellcheck disable=SC1091
  source .env.local; set +a; fi

OLLAMA_URL="${OLLAMA_HOST:-http://127.0.0.1:11434}"
[[ "$OLLAMA_URL" != http* ]] && OLLAMA_URL="http://$OLLAMA_URL"
PORT="${PORT:-$(grep -Eo 'port:[[:space:]]*[0-9]+' app.config.ts | grep -Eo '[0-9]+' | head -1)}"
PORT="${PORT:-3016}"
MODEL="${FACTCHECK_MODEL:-$(grep -Eo 'defaultModel:[[:space:]]*"[^"]+"' app.config.ts | grep -Eo '"[^"]+"' | tr -d '"')}"
RUN_DIR=".fact-checker-run"
DIST="${NEXT_DIST_DIR:-.next}"
mkdir -p "$RUN_DIR"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
info() { printf "\033[36m›\033[0m %s\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "\033[33m!\033[0m %s\n" "$1"; }
err()  { printf "\033[31m✗ %s\033[0m\n" "$1" >&2; }
ask()  { [[ -t 0 ]] || return 1; local a; read -r -p "$(printf "\033[35m?\033[0m %s [y/N] " "$1")" a || return 1; [[ "$a" =~ ^[Yy] ]]; }

bold "Fact Checker — Before you believe it."
echo  "The Sunday Builds — Free AI. Real Problems. Every Sunday."
echo

# 1) Node.js + npm -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then err "Node.js is not installed. Install the LTS version (20.9 or newer) from https://nodejs.org"; exit 1; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 20 || (NODE_MAJOR == 20 && NODE_MINOR < 9) )); then err "Node.js $(node --version) is too old. Next.js 16 needs 20.9 or newer."; exit 1; fi
command -v npm >/dev/null 2>&1 || { err "npm is missing (it ships with Node.js)."; exit 1; }
ok "Node.js $(node --version), npm $(npm --version)"

# 2) Dependencies (reproducible, from the lockfile) ----------------------------
if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  info "Installing dependencies from package-lock.json (first run needs internet)…"
  npm ci --no-fund --no-audit
fi
ok "Dependencies installed"

# 3) Ollama + model --------------------------------------------------------------
OWN_OLLAMA=""
ollama_up() { curl -fsS --max-time 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
if ollama_up; then
  ok "Ollama is running at $OLLAMA_URL"
elif command -v ollama >/dev/null 2>&1; then
  info "Starting 'ollama serve' in the background (log: $RUN_DIR/ollama.log)…"
  nohup ollama serve >"$RUN_DIR/ollama.log" 2>&1 &
  OWN_OLLAMA=$!
  for _ in $(seq 1 20); do ollama_up && break; sleep 0.5; done
  if ollama_up; then ok "Ollama started"; else warn "Ollama did not start. Assessments will be unavailable; retrieved sources still show."; fi
else
  warn "Ollama is not installed. Install it from https://ollama.com/download — without it, Fact Checker can retrieve sources but cannot assess them."
fi

if ollama_up; then
  TAGS="$(curl -fsS --max-time 4 "$OLLAMA_URL/api/tags" || echo '{}')"
  if printf "%s" "$TAGS" | grep -q "\"name\":\"$MODEL\""; then
    ok "Model '$MODEL' is installed"
  else
    warn "Model '$MODEL' is not installed (needed for assessments)."
    echo "    Install it with:  ollama pull $MODEL"
    if ask "Download $MODEL now? (≈2.5 GB for qwen3:4b, one-time)"; then ollama pull "$MODEL"; else info "Skipped. The app will show the setup step until the model is installed."; fi
  fi
fi

# 4) Port (loopback only) ------------------------------------------------------
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
is_ours() { curl -fsS --max-time 2 "http://127.0.0.1:$1/api/health" 2>/dev/null | grep -q '"app":"Fact Checker"'; }
if port_busy "$PORT"; then
  if is_ours "$PORT"; then
    ok "Fact Checker is already running → http://127.0.0.1:$PORT"
    [[ -z "${FACTCHECK_NO_OPEN:-}" ]] && command -v open >/dev/null 2>&1 && open "http://127.0.0.1:$PORT"
    exit 0
  fi
  warn "Port $PORT is used by another program."
  for p in $(seq $((PORT + 1)) $((PORT + 20))); do if ! port_busy "$p"; then PORT="$p"; break; fi; done
  info "Using port $PORT instead."
fi
export PORT

# 5) Clean up what this script started ------------------------------------------
APP_PID=""
cleanup() {
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null || true
  [[ -n "$OWN_OLLAMA" ]] && kill "$OWN_OLLAMA" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

open_when_ready() {
  for _ in $(seq 1 120); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo; ok "Fact Checker is ready → http://127.0.0.1:$PORT"
      [[ -z "${FACTCHECK_NO_OPEN:-}" ]] && command -v open >/dev/null 2>&1 && open "http://127.0.0.1:$PORT"
      return
    fi
    sleep 0.5
  done
}

echo
if [[ "$MODE" == "dev" ]]; then
  bold "Starting dev server on http://127.0.0.1:$PORT (loopback only)"
  open_when_ready &
  npx next dev -H 127.0.0.1 -p "$PORT" &
else
  if [[ ! -f "$DIST/BUILD_ID" ]] || [[ -n "$(find app components lib fixtures public app.config.ts -newer "$DIST/BUILD_ID" -print -quit 2>/dev/null)" ]]; then
    info "Building the app (first run, ~30 s)…"
    npx next build
  fi
  bold "Starting Fact Checker on http://127.0.0.1:$PORT (loopback only)"
  open_when_ready &
  npx next start -H 127.0.0.1 -p "$PORT" &
fi
APP_PID=$!
wait "$APP_PID"

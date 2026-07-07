#!/usr/bin/env bash
#
# check_ollama.sh — verify the Ollama models this project depends on are
# pulled (spec T0.5: "驗證 Ollama 模型已就緒（未就緒則輸出安裝指令請 FSC
# 執行）"). Required models (spec 3.2 [DEFAULT]):
#   - qwen2.5:7b-instruct  (L0/L1 chat)
#   - mxbai-embed-large    (L0 embeddings, 1024-dim per spec section 4)
#
# This script does not install anything itself — it only detects and
# prints the `ollama pull` command(s) needed, per the project instruction
# that Ollama itself is never installed/managed by automation here.

set -euo pipefail

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
REQUIRED_MODELS=("qwen2.5:7b-instruct" "mxbai-embed-large")

echo "== check_ollama.sh: probing ${OLLAMA_BASE_URL} =="

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl not found; cannot probe Ollama." >&2
  exit 1
fi

if ! TAGS_JSON=$(curl -fsS -m 5 "${OLLAMA_BASE_URL%/}/api/tags" 2>/dev/null); then
  echo "SKIP(Ollama unreachable at ${OLLAMA_BASE_URL} — is it running on the host?)"
  echo ""
  echo "To install Ollama itself, see https://ollama.com/download"
  echo "Once running, pull the required models:"
  for model in "${REQUIRED_MODELS[@]}"; do
    echo "  ollama pull ${model}"
  done
  exit 0
fi

MISSING=()
for model in "${REQUIRED_MODELS[@]}"; do
  # Ollama's /api/tags returns {"models":[{"name":"qwen2.5:7b-instruct", ...}, ...]}.
  # Match by exact "name" field value using python3 for robust JSON parsing
  # (avoids fragile grep against a tag that may contain regex metachars
  # like the colon in "qwen2.5:7b-instruct").
  if command -v python3 >/dev/null 2>&1; then
    found=$(printf '%s' "$TAGS_JSON" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    names = {m.get('name') for m in data.get('models', [])}
    names |= {m.get('model') for m in data.get('models', [])}
    print('yes' if '$model' in names else 'no')
except Exception:
    print('no')
")
  else
    # Fallback: plain substring match (less precise, but python3 is
    # expected to be present per the stated dev environment).
    if printf '%s' "$TAGS_JSON" | grep -qF "\"$model\""; then
      found="yes"
    else
      found="no"
    fi
  fi

  if [ "$found" = "yes" ]; then
    echo "OK    ${model}"
  else
    echo "MISSING ${model}"
    MISSING+=("$model")
  fi
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  echo ""
  echo "check_ollama.sh: all required models present."
  exit 0
else
  echo ""
  echo "check_ollama.sh: ${#MISSING[@]} model(s) missing. Run:"
  for model in "${MISSING[@]}"; do
    echo "  ollama pull ${model}"
  done
  exit 1
fi

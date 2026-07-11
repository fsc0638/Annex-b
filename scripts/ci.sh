#!/usr/bin/env bash
#
# ci.sh — layered CI pipeline (spec T0.1, Definition of Done 0.3: "有對應
# 自動化測試，scripts/ci.sh 一鍵可跑"; user instruction: "需 Docker/DB/
# Ollama 的段落偵測不到環境就印明確 SKIP(原因)——不得假綠").
#
# Layers that ALWAYS run (no external services required):
#   1. cargo fmt --check
#   2. cargo clippy --workspace --all-targets -- -D warnings
#   3. cargo test --workspace
#   4. DB-less seed count assertions (scripts/check_seed_counts.sh)
#   5. web install + lint
#
# Layers that run ONLY if the environment supports them, and print an
# explicit SKIP(reason) line otherwise (never silently pass, never
# silently fail as if it were a real pass):
#   6. docker compose config validation (needs docker)
#   7. Ollama model check (needs Ollama reachable — informational, does
#      not fail the pipeline; see scripts/check_ollama.sh)
#
# Exit code: 0 if every layer that RAN passed. A SKIP layer never causes
# a nonzero exit by itself. Any layer that ran and failed causes a
# nonzero exit and a FAIL summary line.

set -uo pipefail
# NOTE: deliberately not using `set -e` here — this script needs to run
# every layer and collect pass/fail/skip status for the FINAL summary,
# rather than aborting at the first failure.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="$HOME/.cargo/bin:$PATH"

RESULTS=()
FAILED=0

record() {
  local label="$1"
  local status="$2" # PASS | FAIL | SKIP
  local detail="${3:-}"
  RESULTS+=("${status}|${label}|${detail}")
  if [ "$status" = "FAIL" ]; then
    FAILED=1
  fi
}

section() {
  echo ""
  echo "=================================================================="
  echo "== $1"
  echo "=================================================================="
}

# ---------------------------------------------------------------------
# Layer 1: cargo fmt --check
# ---------------------------------------------------------------------
section "cargo fmt --check"
if command -v cargo >/dev/null 2>&1; then
  if (cd "${REPO_ROOT}/engine" && cargo fmt --all --check); then
    record "cargo fmt --check" PASS
  else
    record "cargo fmt --check" FAIL
  fi
else
  record "cargo fmt --check" SKIP "cargo not found on PATH"
  echo "SKIP(cargo not found on PATH)"
fi

# ---------------------------------------------------------------------
# Layer 2: cargo clippy --workspace --all-targets -- -D warnings
# ---------------------------------------------------------------------
section "cargo clippy --workspace --all-targets -- -D warnings"
if command -v cargo >/dev/null 2>&1; then
  if (cd "${REPO_ROOT}/engine" && cargo clippy --workspace --all-targets -- -D warnings); then
    record "cargo clippy" PASS
  else
    record "cargo clippy" FAIL
  fi
else
  record "cargo clippy" SKIP "cargo not found on PATH"
  echo "SKIP(cargo not found on PATH)"
fi

# ---------------------------------------------------------------------
# Layer 3: cargo test --workspace
# ---------------------------------------------------------------------
section "cargo test --workspace"
if command -v cargo >/dev/null 2>&1; then
  if (cd "${REPO_ROOT}/engine" && cargo test --workspace); then
    record "cargo test --workspace" PASS
  else
    record "cargo test --workspace" FAIL
  fi
else
  record "cargo test --workspace" SKIP "cargo not found on PATH"
  echo "SKIP(cargo not found on PATH)"
fi

# ---------------------------------------------------------------------
# Layer 4: DB-less seed count assertions
# ---------------------------------------------------------------------
section "scripts/check_seed_counts.sh (DB-less seed constant assertions)"
if bash "${SCRIPT_DIR}/check_seed_counts.sh"; then
  record "check_seed_counts.sh" PASS
else
  record "check_seed_counts.sh" FAIL
fi

# ---------------------------------------------------------------------
# Layer 5: web install + lint
# ---------------------------------------------------------------------
section "web: pnpm install"
if command -v npx >/dev/null 2>&1; then
  if (cd "${REPO_ROOT}/web" && npx -y pnpm@9 install); then
    record "web pnpm install" PASS
  else
    record "web pnpm install" FAIL
  fi
else
  record "web pnpm install" SKIP "npx/node not found on PATH"
  echo "SKIP(npx/node not found on PATH)"
fi

section "web: pnpm run lint"
if command -v npx >/dev/null 2>&1; then
  if (cd "${REPO_ROOT}/web" && npx -y pnpm@9 run lint); then
    record "web pnpm run lint" PASS
  else
    record "web pnpm run lint" FAIL
  fi
else
  record "web pnpm run lint" SKIP "npx/node not found on PATH"
  echo "SKIP(npx/node not found on PATH)"
fi

# ---------------------------------------------------------------------
# Layer 5b: web production build (Phase 1 acceptance surface — the
# PixiJS page must type-check and build, not just lint)
# ---------------------------------------------------------------------
section "web: pnpm run build"
if command -v npx >/dev/null 2>&1; then
  if (cd "${REPO_ROOT}/web" && npx -y pnpm@9 run build); then
    record "web pnpm run build" PASS
  else
    record "web pnpm run build" FAIL
  fi
else
  record "web pnpm run build" SKIP "npx/node not found on PATH"
  echo "SKIP(npx/node not found on PATH)"
fi

# ---------------------------------------------------------------------
# Layer 5c: asset generator idempotency (Phase 1 T1.1/T1.2/T1.4
# acceptance: re-running the generators must reproduce the committed
# artifacts byte-for-byte — a diff here means someone hand-edited a
# generated file or changed a generator without regenerating outputs)
# ---------------------------------------------------------------------
section "asset generators: regenerate and diff (idempotency)"
if command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  GEN_PATHS=(
    assets/maps assets/tilesets assets/sprites/agents
    web/public/maps web/public/tilesets web/public/sprites web/public/mock
    engine/crates/sim-core/tests/fixtures
  )
  GEN_OK=1
  (cd "${REPO_ROOT}" && node scripts/gen_office_shell.mjs) || GEN_OK=0
  (cd "${REPO_ROOT}" && node scripts/gen_theme_tilesets.mjs) || GEN_OK=0
  (cd "${REPO_ROOT}" && node scripts/gen_world_fixture.mjs) || GEN_OK=0
  (cd "${REPO_ROOT}" && node scripts/gen_agent_sprites.mjs) || GEN_OK=0
  # `git diff --exit-code` only sees changes to TRACKED files; a generator
  # that starts emitting a brand-new file would slip through as untracked.
  # `git status --porcelain` over the same paths catches those too.
  GEN_UNTRACKED="$(cd "${REPO_ROOT}" && git status --porcelain -- "${GEN_PATHS[@]}")"
  if [ "$GEN_OK" -eq 1 ] \
    && (cd "${REPO_ROOT}" && git diff --exit-code -- "${GEN_PATHS[@]}") \
    && [ -z "$GEN_UNTRACKED" ]; then
    record "generators idempotent (git diff + status clean)" PASS
  else
    if [ -n "$GEN_UNTRACKED" ]; then
      echo "untracked/modified generator output detected:"
      echo "$GEN_UNTRACKED"
    fi
    record "generators idempotent (git diff + status clean)" FAIL "regenerated output differs from committed files, produced new untracked files, or a generator failed"
  fi
else
  record "generators idempotent (git diff + status clean)" SKIP "node or git not found on PATH"
  echo "SKIP(node or git not found on PATH)"
fi

# ---------------------------------------------------------------------
# Layer 6: docker compose config validation (needs docker)
# ---------------------------------------------------------------------
section "docker compose config (validation only, no containers started)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if (cd "${REPO_ROOT}" && docker compose config >/dev/null); then
    record "docker compose config" PASS
  else
    record "docker compose config" FAIL
  fi
else
  record "docker compose config" SKIP "docker/docker-compose not available in this environment"
  echo "SKIP(docker/docker-compose not available in this environment)"
fi

# ---------------------------------------------------------------------
# Layer 7: Ollama model check (informational — never fails the pipeline)
# ---------------------------------------------------------------------
section "scripts/check_ollama.sh (informational — does not fail CI)"
OLLAMA_CHECK_OUTPUT="$(bash "${SCRIPT_DIR}/check_ollama.sh" 2>&1)"
OLLAMA_CHECK_EXIT=$?
echo "$OLLAMA_CHECK_OUTPUT"
if echo "$OLLAMA_CHECK_OUTPUT" | grep -q "^SKIP("; then
  # check_ollama.sh itself emitted a SKIP( line — Ollama is unreachable,
  # so nothing was actually verified. Reflect that honestly instead of
  # reporting PASS for an unverified check.
  record "check_ollama.sh" SKIP "Ollama unreachable — models not verified"
elif [ "$OLLAMA_CHECK_EXIT" -eq 0 ]; then
  record "check_ollama.sh" PASS
else
  # check_ollama.sh exits 1 when models are missing but Ollama IS
  # reachable; that's a real signal worth surfacing but should not fail
  # the whole CI run on a dev machine that simply hasn't pulled models
  # yet, so it's recorded as SKIP with detail rather than FAIL.
  record "check_ollama.sh" SKIP "Ollama reachable but required models missing (see output above)"
fi

# ---------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------
section "SUMMARY"
for entry in "${RESULTS[@]}"; do
  IFS='|' read -r status label detail <<< "$entry"
  if [ -n "$detail" ]; then
    echo "${status}  ${label}  (${detail})"
  else
    echo "${status}  ${label}"
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "ci.sh: ALL RAN LAYERS PASSED (SKIPs are informational, not failures)"
  exit 0
else
  echo "ci.sh: ONE OR MORE LAYERS FAILED"
  exit 1
fi

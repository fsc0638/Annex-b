# justfile — cross-platform task runner (spec 0.2: "指令提供跨平台版本
# （以 justfile 統一）"). Every recipe here is a thin wrapper that calls
# into scripts/ so the actual logic lives in one place and is testable
# outside `just` too.
#
# Install: https://github.com/casey/just (not required to read this
# file — recipes are documented below for manual invocation too).

set shell := ["bash", "-uc"]

# List available recipes (default target).
default:
    @just --list

# Start the full stack via docker compose (postgres + engine + web).
up:
    docker compose up --build

# Stop and remove the docker compose stack.
down:
    docker compose down

# Seed a fresh world (agents, layout, work_items, knowledge). Requires
# DATABASE_URL to be set and reachable (compose environment).
seed:
    bash scripts/seed_world.sh

# Re-seed only the knowledge memories for the most recent world.
seed-knowledge-only:
    bash scripts/seed_world.sh --knowledge-only

# Run the full test suite: Rust workspace tests + DB-less seed count
# assertions. (Web has no test suite yet in Phase 0 — lint stands in for
# it via `just lint`.)
test:
    cd engine && cargo test --workspace
    bash scripts/check_seed_counts.sh

# Run all linters: rustfmt check, clippy (deny warnings), web lint.
lint:
    cd engine && cargo fmt --all --check
    cd engine && cargo clippy --workspace --all-targets -- -D warnings
    cd web && npx -y pnpm@9 run lint

# Run the full CI pipeline (same checks as scripts/ci.sh, layered with
# SKIP reporting for anything requiring Docker/DB/Ollama that isn't
# available in the current environment).
ci:
    bash scripts/ci.sh

# Check whether the required Ollama models are pulled; prints install
# instructions if not.
check-ollama:
    bash scripts/check_ollama.sh

# Phase 1 Adversarial Acceptance Review

- Reviewed: branch `phase/1-world`, HEAD `fdef745` (13 commits atop `main`@`2c2eb3b`/p0-accepted)
- Date: 2026-07-08
- Verdict: **PASS** — merged to `main`, tagged `p1-accepted`

## Method

Multi-agent adversarial review, three rounds, each verified independently (never trusting the
builder's or a prior round's self-claim):

1. **Acceptance review** — evidence independently re-run + 4 parallel dimensions
   (sim-core vs spec, WebSocket protocol vs §7.4, frontend + asset licensing, test quality),
   every non-minor finding re-checked by two independent refuters. Result: 1 major + 12 minor,
   0 findings refuted (no false positives).
2. **Fix batch** (`1c2d769`..`60b437d`, 6 commits) — all 13 addressed; tests 119→124.
   Re-verified: evidence green + regression sweep clean; a regression sweep surfaced
   2 new minors introduced by the fix batch itself.
3. **Finalization** (`fdef745`) — the 2 regressions cleared; then a full re-verification of all
   15 items (13 original + 2 regression fixes) plus evidence re-run and a fresh regression sweep.
   Result below.

## Final state (all independently confirmed)

- `cargo fmt --check` clean; `cargo clippy --workspace --all-targets -- -D warnings` clean
  (only the pre-existing sqlx-postgres future-incompat upstream note); `cargo test --workspace`
  = **124 passed / 0 failed**.
- web `pnpm lint` clean; `pnpm build` succeeds; `scripts/ci.sh` — 8 layers PASS, 2 SKIP
  (docker/ollama, unavailable locally — never silently passed).
- **15/15 review items verdict = fixed**; 0 failed; regression sweep `clean`.

### The one major (fixed)

`OfficeCanvas.tsx` `ensureVisual` was check-then-await: a second concurrent `syncAgents`
(agent_moved replaying right after world_snapshot on a mid-walk page reload) built a second
sprite for the same agent, leaving a frozen "ghost" — directly failing the P1 acceptance item
"reload restores snapshot correctly". Fixed by registering the in-flight `Promise<AgentVisual>`
in the visuals map *synchronously before any await*, so concurrent calls share one promise and a
duplicate `addChild` is structurally impossible (not timing-dependent).

## Known follow-ups (below merge bar — recorded, not blocking)

- **[minor] silent per-agent visual-load catch** — `syncAgents`' per-agent `catch { continue; }`
  and `ensureVisual`'s reject handler both self-heal on transient failures but emit no log, so a
  *persistent* sprite-atlas load failure would leave an agent invisible with zero console output.
  Cannot occur in practice (the atlas is a repo-committed local file), but a throttled
  `console.warn` should be added. → P2/backlog.
- **[trivial] stale doc comments** — `ws.rs:4` module doc and `world.rs` comments still say
  `stuck_in_place` (the wire/type name is now `agent_stuck`/`AgentStuck`). Illustrative comments,
  not contract. → P2/backlog.

## Environment-gated (SKIP, not scored) — same as P0

`docker compose up` full-stack boot and live-DB behavior require Docker/Ollama, unavailable on the
dev Mac; verified statically only, deferred to the Mac Mini deploy target.

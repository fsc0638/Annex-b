# Phase 0 Adversarial Acceptance Review

- Reviewer: fresh-context adversarial acceptance pass (Claude, no authorship stake in the reviewed commits)
- Reviewed: branch `phase/0-bootstrap`, 8 commits, HEAD `23fe210`
- Date: 2026-07-07
- Verdict: **放行（附條件）— 0 blocker / 6 major / 4 minor**

All mandatory evidence commands were actually executed in this environment (not assumed). See "Evidence command output" at the end of this document for full tails. Summary: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (53/53 tests), `pnpm lint`, and `scripts/ci.sh` (all runnable layers PASS, Docker/Ollama layers SKIP as expected) all passed cleanly, independently re-run by the reviewer. `grep -rn "桃機"` (excluding spec source docs) returned empty — the forbidden reference does not leak into implementation files. Git history is 8 commits, all Conventional Commits format, English messages, working tree clean.

This review was conducted by directly reading the DDL, seed script, LLM gateway source, prompts, and docs myself, plus two delegated adversarial sub-reviews whose claims were spot-checked and, in two cases, downgraded from the sub-reviewer's stated severity based on my own follow-up verification (see Major #1/#2 below for the reasoning).

---

## Why 0 blockers (revised down from an initial 1 blocker / 2 "blocker" claims)

One issue initially assessed as blocker — 阮曉青's dual reporting line (沈書萍 functional/dotted-line vs 高子軒 formal line) being silently collapsed to a single FK with no structured trace of the dotted line — is downgraded to **major** on reflection: it is a genuine information-loss bug, but it is a *seed-data modeling* gap that affects one relationship's structured queryability, not a schema or pipeline defect that corrupts data or blocks Phase 1+ from proceeding. It belongs in the same class as the other seed-data majors below. Two other candidate blockers (hardcoded per-provider timeouts not matching the spec's per-tier table; retry-count policy entirely unimplemented) are also downgraded to major — see Major #1 for why.

Nothing found in this review would, if left unfixed, corrupt data, silently produce wrong simulation results, or structurally block Phase 1 work from starting. Everything below is either a real spec deviation worth fixing before those areas of code see heavier reuse, or a documentation/precision gap.

---

## MAJOR

### Major 1 — Timeout is hardcoded per-provider, not per-tier; retry-count policy (spec 6.1's table) is entirely unimplemented

- Files: `engine/crates/llm-gateway/src/providers/anthropic.rs:78` (90s), `openai.rs:69` (60s), `gemini.rs:81` (60s), `ollama.rs:86` (30s, chat), `ollama.rs:138` (15s, embed); `engine/crates/llm-gateway/src/tier.rs:45-47`.
- Spec §6.1 tier table assigns timeout+retry as a **tier-level** property: L0=15s/2 retries, L1=30s/2 retries, L2=60s/2 retries, L3=90s/1 retry.
- Actual: timeout lives on each provider's HTTP client call, not on the tier. Since L2 and L3 both default to the Anthropic provider (`tier.rs:94-97`), and `AnthropicProvider::chat()` has exactly one hardcoded timeout (90s), an L2 call (daily_plan/decompose/re-plan) silently gets L3's 90s timeout instead of the spec's 60s. Separately, L0 covers two operations per spec ("embedding、importance") — `Ollama::embed()` correctly uses 15s, but L0's *importance* scoring (per `prompts/importance.md`, a JSON-chat-shaped prompt, not an embedding call) would route through `Ollama::chat()`, which is hardcoded to 30s (L1's spec value), not L0's 15s.
- Retry: independently grepped the full crate for `retry|retries|attempt` — the only hits are doc comments describing where retry *should* go (`tier.rs:46`, `json_guard.rs:9-10`). No counter, no loop, no backoff exists anywhere, for any tier. `ChatProvider::chat()` and `EmbeddingProvider::embed()` (`provider.rs:109,116`) take no timeout/retry parameter at all, so no caller could wire this in without a trait signature change.
- Severity reasoning: initially flagged as blocker by one sub-review. I downgrade to major because (a) the mismatch is in the safe direction — calls wait *longer* than spec before erroring, not shorter, so nothing times out prematurely; (b) `tier.rs:46`'s comment explicitly (if tersely) documents this as a deferred-to-caller concern rather than a silent accident; (c) T0.4's own acceptance bar is "llm-gateway 最小可用...最小 chat 通路" (minimal viable chat pathway), and full tier-level operational policy (timeout/retry precision) is reasonably adjacent to the explicitly-Phase-0-excluded "concurrency limiting... queueing under load" (`lib.rs:9-11`). Still a real, confirmed gap against an explicit spec table, so not dropping it to minor.
- Suggested fix: move timeout+retry-count into `TierTarget`/`TierDefaults` so they travel with tier resolution; change `ChatProvider::chat()`/`EmbeddingProvider::embed()` to accept a caller-supplied `Duration`, and implement the retry loop at the gateway (`lib.rs`) call site, not inside individual providers.

### Major 2 — `阮曉青`'s dual reporting line (業務指導 to 沈書萍) exists only as prose, not structured data

- File: `scripts/seed_world.sh:243-253` (agent insert), `:176-177` (沈書萍's mirrored prose).
- Spec Appendix A.1: `reports_to=沈書萍(業務指導)/高子軒` — an explicitly dual line.
- Actual: `agents.reports_to` is set to 高子軒 only. The 沈書萍 functional relationship is mentioned solely inside free-text `core_identity` narrative fields on both agents ("業務指導約聘同仁阮曉青的標案行政工作" / "業務上則由高級專員沈書萍指導"). It is not in `relationships`, not a second FK, not in any queryable column. The generic `rel_ins` CTE will assign 阮曉青→沈書萍 the same fallback descriptor (`'同部門同事'`) as any other peer pair, actively mislabeling a supervisory/functional relationship as an ordinary peer one.
- Consequence: any Phase 1+ logic reasoning over org structure via `reports_to` or `relationships.descriptor` (e.g. "who reviews X's work," "who mentors X") will not see this line at all — it's only recoverable by an LLM re-reading prose, which is fragile. There is no code comment anywhere acknowledging this was a deliberate simplification of a spec-flagged ambiguity; `docs/CLAUDE.md:95-99` does document the *reports_to* choice but doesn't mention the relationships-table mislabeling side effect.
- Suggested fix: add an explicit `relationships` row for `(阮曉青→沈書萍)` with a distinguishing descriptor (e.g. `'業務指導'`) inserted outside the generic peer-relationship loop, so the dotted line is queryable.

### Major 3 — `agents.desk_id` has no FK constraint to `layout_items(id)`, and no `world_id` cross-check either

- File: `db/migrations/001_init.sql:40` — `desk_id uuid, -- ★ 指派座位（layout_items.id），可為 null`.
- Confirmed: bare `uuid` column, no `references layout_items(id)`. Nothing in the DB prevents `desk_id` from pointing at a nonexistent row, a row of the wrong `kind` (e.g. a `plant`), or — since there's also no `world_id` match enforced — a `layout_items` row belonging to a *different world* entirely. The seed script itself is internally consistent (joins within one `new_world` CTE), but this invariant has no enforcement once Phase 1+ code (layout editor deletes/moves items, multi-world experiments per §11) starts mutating these tables independently.
- Suggested fix: add `references layout_items(id)` at minimum; consider a composite constraint or trigger enforcing same-`world_id` between `agents` and their assigned `layout_items`, since layout is world-scoped.

### Major 4 — `GET /api/v1/healthz`'s `providers` array conflates 3 cloud providers with 1 local provider under one undifferentiated `enabled` field, and excludes `mock` without documenting why

- Files: `engine/crates/llm-gateway/src/lib.rs:126-142` (`provider_statuses()`), `engine/crates/api-server/src/healthz.rs:9-15`.
- Spec language ties "enabled/disabled" specifically to the three cloud providers' API-key presence ("未設金鑰的供應商停用並於 healthz 註記"). Actual: `provider_statuses()` returns `[anthropic, gemini, openai, ollama]` — Ollama has no API-key concept, so its `enabled` field means something structurally different (base-URL-configured, not key-presence) from the other three, under the same field name with no discriminator. Meanwhile `mock` (a real 5th `ProviderId` variant) is silently excluded from this array with only a test (`lib.rs:194`, `statuses.len() == 4`) making the omission legible — no comment in `provider_statuses()` itself explains either exclusion or the semantic split.
- This is not a functional bug (tests pass, behavior is reasonable), but it's a spec-drift risk: a future consumer of this endpoint (admin UI, monitoring) reading `providers[].enabled` uniformly across all 4 entries will misinterpret Ollama's status.
- Suggested fix: either drop `ollama` from `providers` (it already has its own top-level `ollama: ComponentHealth` field, avoiding duplication) so `providers` strictly matches the three-cloud-provider spec language, or add a `kind: "cloud" | "local"` discriminator; add a one-line comment explaining the `mock` exclusion at the call site itself, not just in a test.

### Major 5 — `--knowledge-only` is delete-then-reinsert, not upsert; row identity (id/created_at/last_access) churns on every re-run

- File: `scripts/seed_world.sh:516-529`.
- The integration note (draft v2) and commit message both say "upsert." Confirmed via code read: no `ON CONFLICT` anywhere in the knowledge insert path — it's `delete ... where kind='knowledge' and agent_id in (...)` followed by plain `insert`. The code comment at the deletion site is honest about *why* (`memories` has no natural upsert key, DDL can't be altered), and the outer goal ("don't touch non-knowledge data") is genuinely met. But every re-run discards and regenerates all knowledge rows' `id`, `created_at`, and `last_access` — anything that referenced a knowledge memory's `id` (e.g. another memory's `ref_ids`, or an `event_log` payload) would silently dangle after a re-run. This is a real behavioral difference from what "upsert" implies to an operator running the flag expecting row identity to survive.
- Suggested fix: rename flag help-text/log output from "upsert" to "reseed"/"replace" to set correct expectations, or document the id-churn caveat in the script's usage header (currently just says "only upsert knowledge memories").

### Major 6 — Mock provider's determinism doc comment overclaims stability ("same output... in every process, forever") against an unpinned Rust toolchain

- File: `engine/crates/llm-gateway/src/providers/mock.rs:1-8`, uses `std::collections::hash_map::DefaultHasher`.
- Confirmed: no `rust-toolchain.toml`/`rust-toolchain` file anywhere in the repo. `DefaultHasher`'s specific algorithm is not contractually guaranteed stable across Rust std versions by the language (informational point, not a claim of imminent breakage — historically very stable in practice). Within one build, this is genuinely deterministic — confirmed by the passing test `chat_is_reproducible_given_same_seed_input` and by tracing the function: no wall-clock reads, no un-seeded randomness, no `HashMap` iteration affecting output (checked explicitly since that's a classic hidden-nondeterminism source; `mock_reply` doesn't iterate any map).
- Why this matters enough to flag as major rather than minor: it bears directly on spec success criterion **S6** ("同 seed + mock LLM 下模擬 100% 可重現"), a named, numbered, measurable acceptance criterion — not an implementation detail. If golden-replay fixtures are captured under one toolchain and replayed after an upgrade, a silent hash-value drift would be a worse failure mode (silently-wrong golden diff) than a crash.
- Suggested fix: pin `rust-toolchain.toml`, and/or replace `DefaultHasher` with an explicitly algorithm-pinned hash (inline FNV-1a, or a documented crate), and/or soften the doc comment's "forever" claim to scope it to "within a fixed toolchain."

---

## MINOR

### Minor 1 — No enum-like column has a DB-level CHECK constraint
`worlds.status`, `agents.grade`, `layout_items.kind`/`zone`, `work_items.kind`/`status`, `memories.kind`, `conversations.kind` are all bare `text` with comments listing allowed values, no `check (... in (...))` anywhere. Applied uniformly across the whole schema (looks like a deliberate simplicity choice, not an oversight in one spot), so not elevating — but means zero enum invariants are DB-enforced; a future bug or manual edit can write anything.

### Minor 2 — `docs/CLAUDE.md`'s "Known Gaps" section doesn't mention the timeout/retry-not-tier-wired gap (Major #1)
The section is otherwise a genuinely strong, honest account of five other real gaps (missing v1 prompts, missing embeddings without Ollama, unverified Docker, initdb.d migration fragility, etc.) — this omission reads as incomplete rather than misleading, since the code-level comment (`tier.rs:46`) does disclose the gap, just tersely and not in the cross-session memory doc where a future reader would look first.

### Minor 3 — `company_context_full.md` contains ~7 unresolved `[FSC-請校對]` editorial markers that would be injected verbatim into `daily_plan.md`/`meeting.md` prompts in real (non-mock) mode before FSC reviews them
Honestly disclosed in the file's own header comment, so this is a "don't forget before going to real mode" note rather than a hidden defect.

### Minor 4 — `pricing.toml` has no entry for several plausible override models (e.g. `openai:gpt-4.1-mini`); missing-price calls silently cost-account as $0 with no warning
Consistent with the codebase's general "fail toward default" posture and covered by a passing test (`missing_price_is_zero_cost`), but there's no log/warning on a pricing-table miss, so a misconfigured `llm_profile` override pointing at an unpriced model would silently undercount spend against `DAILY_BUDGET_USD`.

---

## Checklist of items verified with no issues found

**Build/lint/test infrastructure:**
- `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (53 tests: 3 agent-core + 1+0+0 api-server + 47 llm-gateway + 2 sim-core) — all pass, re-run independently by reviewer, not just trusted from commit messages.
- `pnpm install` + `pnpm run lint` (web) — clean, zero warnings.
- `scripts/ci.sh` — all 6 always-run layers PASS; 2 environment-gated layers (docker compose config, Ollama model check) correctly SKIP with explicit reasons, never silently pass or fail.
- `scripts/check_seed_counts.sh` — a genuine DB-less assertion parsing `seed_world.sh`'s literal SQL (not a hand-duplicated table, so it can't silently drift from the real seed data) — all 13 counts PASS.
- `grep -rn "桃機"` (excluding spec docs) — empty, confirmed clean.
- Git log: 8 commits, Conventional Commits format (`feat(scope):`/`docs:`), English messages, detailed bodies; `git status` clean.

**DB schema (`001_init.sql`) vs spec §4** — read in full personally, byte-compared against spec text: all 11 tables present with `created_at`; `agents.llm_profile jsonb not null default '{}'` exact match including comment; `memories.kind` comment correctly includes `knowledge ★★v2.1`; `layout_items` unique index on `(world_id, key)` present; both `memories` indexes (hnsw + `agent_id,sim_day`) present; `llm_calls` columns exact match; `plans.work_item_id` FK present; all enum-like comments match spec's allowed-value lists exactly.

**Seed data (`seed_world.sh`) vs Appendix A** — read in full, cross-verified independently (not just trusted from delegated sub-review):
- All 9 agents' names/grades/titles/desk assignments match Appendix A.1 exactly.
- `reports_to` chain resolves correctly (VP=null, everyone else correctly chained).
- Layout counts (desk=32, exec_desk=2, chair=42, meeting_table=1, cabinet=4, plant=4, printer=1, pantry_counter=1, whiteboard=1, partition=6) all verified both via the automated script and via direct reading.
- Partition geometry genuinely wraps 3 sides of each exec desk (verified via coordinates, not just count).
- `open_b`'s 16 desks exist as layout_items but zero agents assigned there — personally verified by reading the `seat_map` CTE directly (only references `exec.vp`, `exec.mgr`, `deskA-01..06,08`, never any `deskB-*` key).
- The critical 桃機→北原機場 correction is applied exactly as the integration note specifies: `title='北原機場貴賓室經營權投標案—服務建議書'`, `client='機場當局'`, with an explanatory code comment citing the erratum.
- 阮曉青 and 方以寧 correctly wired as collaborators on both `tender` work_items.
- All 20 knowledge slices (K-01..K-20) present with `sim_day=0, sim_clock_sec=0`; sample fan-out recipients spot-checked correct (K-01→ALL, K-02→3 named agents only, K-19→ALL).

**LLM Gateway (`llm-gateway` crate) vs spec §6** — read in full personally:
- Exactly 5 `ProviderId` variants (`anthropic|openai|gemini|ollama|mock`).
- L0 non-overridability is structurally guaranteed, not just tested: `Tier::is_overridable()` returns `false` for L0 and `resolve_tier_target` gates the override branch behind it — L0 literally cannot reach override code, verified by reading the control flow, not just running the test.
- Missing API key → provider disabled at construction (`Option<String>` filtered on empty/whitespace), confirmed symmetric across anthropic/openai/gemini; `chat()` on a disabled provider returns `Err(Disabled)` rather than silently no-op-ing.
- `LLM_MODE=mock` always wins over tier routing, checked before tier resolution.
- Mock provider determinism mechanism traced line-by-line: pure hash of `(model, last_user_content)`, no wall-clock, no unseeded randomness, no HashMap-iteration-order dependency (see Major #6 for the toolchain-pinning caveat on the "forever" framing).
- `pricing.toml` parses cleanly (independently verified with Python's `tomllib`, not just trusted), field names match `ModelPrice` struct exactly, keyed `"provider:model"` matching both `llm_profile` override format and `llm_calls` columns.
- `budget.rs`'s `classify_budget_state` is a genuinely pure function — no IO, no global state, confirmed by reading the full function body.
- Concurrency limiting confirmed absent (no semaphore anywhere) — acceptable for Phase 0 per T0.4's own "最小可用" bar, not counted as an issue.
- `json_guard.rs` fence-stripping + parse confirmed correct for both tagged and bare fences plus whitespace; retry-once/degrade orchestration confirmed absent from the whole gateway but this is explicitly, correctly deferred to Phase 2 (T2.8) per spec's own phase breakdown — not a Phase 0 gap.
- Env var cross-reference: every var read by code (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL`, `OLLAMA_BASE_URL`, `LLM_MODE`, `DAILY_BUDGET_USD`, `LLM_L{0,1,2,3}_MODEL`, `LLM_L{2,3}_PROVIDER`, `PORT`, `RUST_LOG` via tracing's implicit convention) is documented in `.env.example`; no drift either direction (checked via grep both ways personally, not just trusted).

**Prompts (`prompts/*.md`) vs spec §5.11 + draft v2:**
- `company_context_core.md`/`company_context_full.md` content-faithful to the draft's layers 1/2.
- The 4-file `{{company_context_core}}` vs `{{company_context_full}}` variable split is wired correctly: `daily_plan.md`/`meeting.md` use `_full`; `converse.md`/`work_progress.md` use `_core` — matches integration note item 1 exactly, verified by reading each file directly.
- `react.md` has the required `【職級關係】{{rank_relation}}` line plus the "do not hardcode deference" framing, personally read and confirmed.
- All 6 "carried over from v1" placeholder prompts are honestly headed `TODO: v1 全文待 FSC 提供` with clear explanatory HTML comments — personally verified two of these (`react.md`, `importance.md`) directly; none silently pass off placeholder text as real v1 content.

**Docs:**
- `docs/CLAUDE.md` — personally read in full: substantive, records real decisions (阮曉青 reports_to tradeoff, relationships descriptor directionality, sqlx runtime-query rule, api-server lib+bin split, Next.js version bump rationale), a genuinely honest Known Gaps section (five gaps disclosed, see Minor #2 for the one omission), and concrete next-steps. This is good-quality cross-session memory, not a rubber-stamp file.
- `docs/decisions/ADR-001-multi-provider-gateway.md` — personally read in full: correctly documents the 2026-07-07 direct-connect decision, 5-provider trait design, per-agent `llm_profile` mechanism, L0 non-overridability rationale, cross-provider cumulative budget, and honestly lists negative trade-offs (3x credentials, pricing.toml drift risk) rather than only positives.
- `docs/domain/ground_handling.md` — confirmed genuinely an empty shell explicitly headed "待 FSC 填寫," not fabricated content pretending to be FSC's real-world domain expertise.
- `docker-compose.yml` — personally read: `pgvector/pgvector:pg16` image, `host.docker.internal:host-gateway` extra_hosts present, 3 services (postgres/engine/web), migration auto-applies via `docker-entrypoint-initdb.d` mount. YAML validity independently re-verified with Python's `yaml.safe_load` (not just trusted from the commit message's claim).
- `GET /api/v1/healthz` — route path is exactly `/api/v1/healthz` (not just `/healthz`); response reports `db`, `ollama`, and `providers` fields (see Major #4 for a shape nuance); integration test asserts response *shape* (status/db.reachable/all 4 provider names present), not just HTTP 200 — a real test, not a smoke test.

**Not found / actively ruled out (per adversarial mandate to hunt, not just confirm):**
- No dead/hidden retry middleware in the `reqwest` dependency tree or client construction (checked `Cargo.toml` features and `Client::new()` call sites directly).
- No `HashMap`-iteration-order nondeterminism in the mock provider's output path.
- No test-isolation *failure* observed (`cargo test --workspace` passed clean), but flagging as a latent risk, not a current bug: `lib.rs`'s `gateway_from_env_disables_providers_without_keys` test mutates `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` via `std::env::remove_var` without holding the `ENV_MUTEX` that the same file's own comment (`lib.rs:150-157`) says is required for any test mutating env vars read by `from_env()`. Doesn't manifest today only because no other test currently mutates those specific three var names — worth a one-line fix (wrap in the mutex) before someone adds a test that does race it.

---

## Environment-gated SKIPs (not scored as pass or fail)

Per the acceptance brief, the following require Docker/DB/Ollama, unavailable in this review environment, and are correctly SKIP, not silently assumed passing:
- `docker compose up` end-to-end boot and `GET /api/v1/healthz` reporting real DB+Ollama reachability (spec §8 Phase 0 acceptance item 1).
- `llm_calls` actually recording one real call per provider (Ollama + Anthropic/OpenAI/Gemini or mock substitutes) into a live Postgres table (spec §8 Phase 0 acceptance item 2, second clause) — the recorder trait and in-memory/no-op implementations exist and are tested, but no DB-backed writer exists yet (explicitly, honestly Phase 1+ scope per `recorder.rs`'s own doc comment), so this specific acceptance clause is architecturally plausible but not demonstrated.
- Ollama model availability check (`scripts/check_ollama.sh`) — correctly reports SKIP with install instructions rather than a false pass.

## Phase 0 acceptance checklist (spec §8) — final verdict

| # | Item | Verdict | Reason |
|---|---|---|---|
| 1 | `docker compose up` → healthz reports DB+Ollama ok | SKIP (environment) | No Docker locally; compose YAML validity and healthz code logic verified statically, never run end-to-end |
| 2 | `just test` passes; `llm_calls` records one call per of Ollama+3 clouds | PARTIAL | `just test` fully passes (verified). Live `llm_calls` DB recording not wired yet (Phase 1+ scope, honestly disclosed) — not demonstrated, not falsified |
| 3 | Seeded `layout_items` counts match §7.2 exactly | PASS | Verified via `check_seed_counts.sh` output AND independent direct reading of `seed_world.sh`'s geometry (partition placement, meeting table footprint, chair counts) |

---

## Evidence command output (tails)

### `cargo fmt --check` (engine/)
```
(no output — clean)
```

### `cargo clippy --workspace --all-targets -- -D warnings` (engine/)
```
    Finished `dev` profile [unoptimized] target(s) in 0.67s
warning: the following packages contain code that will be rejected by a future version of Rust: sqlx-postgres v0.7.4
note: to see what the problems were, use the option `--future-incompat-report`, or run `cargo report future-incompatibilities --id 1`
```
(future-incompat note is informational upstream-dependency notice, not a clippy warning/failure — 0 warnings-as-errors triggered)

### `cargo test --workspace` (engine/)
```
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (agent-core)
test result: ok. 0 passed; 0 failed ...                                      (api-server unit)
test result: ok. 1 passed; 0 failed ...                                      (api-server tests/healthz.rs)
test result: ok. 47 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out  (llm-gateway)
test result: ok. 2 passed; 0 failed ...                                      (sim-core)
```
Total: 53 passed, 0 failed.

### web: `pnpm install` + `pnpm run lint`
```
Already up to date. Done in 434ms using pnpm v9.15.9
> annex-b-web@0.1.0 lint
> next lint
✔ No ESLint warnings or errors
```

### `bash scripts/ci.sh` (full run)
```
PASS  cargo fmt --check
PASS  cargo clippy
PASS  cargo test --workspace
PASS  check_seed_counts.sh
PASS  web pnpm install
PASS  web pnpm run lint
SKIP  docker compose config  (docker/docker-compose not available in this environment)
SKIP  check_ollama.sh  (Ollama unreachable — models not verified)

ci.sh: ALL RAN LAYERS PASSED (SKIPs are informational, not failures)
```

### `grep -rn "桃機" . --exclude-dir=.git --exclude-dir=99-backups --exclude-dir=node_modules --exclude-dir=target --exclude="AI辦公室*" --exclude="prompts-company_context*"`
```
(no output — clean, forbidden reference does not leak into implementation)
```

### `git log --oneline --all` / `git status`
```
23fe210 docs: add docs/CLAUDE.md, ADR-001, ground_handling.md shell, assets scaffolding
2df05bb feat(scripts): add justfile, ci.sh, check_ollama.sh
4e931d9 feat(prompts): add prompt templates per spec 5.11 and company_context draft v2
f9fb513 feat(web): scaffold Next.js App Router + TypeScript + Tailwind skeleton
7c2d64e feat(compose): add docker-compose.yml and .env.example
e1e49a4 feat(db): add 001_init.sql migration and seed_world.sh
fe270b7 feat(engine): scaffold Rust workspace with 4 crates and multi-provider LLM gateway
6aa1b12 docs: add authoritative v2.1 spec documents

位於分支 phase/0-bootstrap
您的分支與上游分支 'origin/phase/0-bootstrap' 一致。
沒有要提交的檔案，工作區為乾淨狀態
```

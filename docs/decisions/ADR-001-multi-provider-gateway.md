# ADR-001: Multi-Provider LLM Gateway (Anthropic / OpenAI / Gemini Direct Connect + Per-Agent llm_profile)

- Status: Accepted
- Date: 2026-07-07
- Deciders: FSC (范書愷)

## Context

The v2.0 spec's original open question (Q1, section 12) was whether cloud
LLM calls should route through a company proxy endpoint or connect
directly to each provider's official API. Separately, the spec's tier
routing table (section 6.1) originally assumed a single cloud provider
(Anthropic) for tiers L2/L3.

FSC's 2026-07-07 instruction settled both questions together, producing
spec v2.1:

1. Q1 is resolved: **no company proxy** — all three cloud providers
   (Anthropic, OpenAI, Google Gemini) connect directly to their official
   REST endpoints. API keys live in environment variables; a provider
   with no key set is disabled and reported as such in `GET
   /api/v1/healthz`, rather than the gateway erroring or silently
   falling back.
2. Support for **per-agent model assignment** via a new `agents.llm_profile`
   JSONB column (spec section 4), allowing different simulated agents to
   run on different models/providers for tiers L1-L3 — enabling
   cross-model behavioral comparison experiments (spec section 11) without
   forking the whole simulation per model.

## Decision

- `llm-gateway` defines one `ChatProvider` trait implemented by five
  backends: `anthropic`, `openai`, `gemini`, `ollama`, `mock`.
- The three cloud providers use official REST APIs directly:
  - Anthropic: Messages API (`https://api.anthropic.com/v1/messages`)
  - OpenAI: Chat Completions API (`https://api.openai.com/v1/chat/completions`)
  - Gemini: `generateContent`
    (`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`)
- Each cloud provider is constructed with `Option<String>` for its API
  key; `None` or an empty/whitespace-only string means "disabled." This
  is a construction-time gate, independent of runtime reachability
  (network errors are a separate failure mode surfaced per-call).
- Tier defaults (L0-L3) are read from environment variables (model IDs
  only, per project convention "模型 ID 全放 env" — no model IDs are
  hardcoded in source).
- `agents.llm_profile` is a JSONB map like
  `{"L1": "openai:gpt-4o-mini", "L3": "gemini:gemini-2.5-pro"}`. At
  resolution time (`tier::resolve_tier_target`), L1/L2/L3 may be
  overridden per-agent; **L0 (embedding/importance) can never be
  overridden** — it always routes to local Ollama, keeping the vector
  space and per-day cost baseline consistent across all agents
  regardless of their L1-L3 assignments. Malformed override strings
  (wrong format, unknown provider, empty model) fall back to the tier
  default rather than erroring, logging a `tracing::warn!` for
  visibility.
- Metering (`llm_calls` table) and budget enforcement
  (`DAILY_BUDGET_USD`, 80%/100% thresholds) are **cross-provider
  cumulative** — a single daily budget covers all providers combined,
  not one budget per provider.
- `pricing.toml` at the repo root holds a snapshot per-provider,
  per-model price table (USD per million tokens), keyed
  `"provider:model"` to match both the `llm_profile` override format and
  `llm_calls.provider`/`llm_calls.model`. It is explicitly documented as
  an estimation aid, not a billing source of truth, since provider list
  prices change independently of this repo.

## Consequences

- **Positive**: No dependency on a company-run proxy; each provider's
  latency/availability is independent, and adding a fourth provider
  later only requires implementing one more `ChatProvider` impl plus a
  `ProviderId` variant.
- **Positive**: Per-agent model assignment turns "does model choice
  change simulated workplace behavior" from a hypothesis into a runnable
  experiment (spec section 11) without needing N parallel simulation
  runs.
- **Negative / accepted trade-off**: Three sets of API credentials to
  manage instead of one; three slightly different request/response JSON
  shapes to maintain (mitigated by each provider being a self-contained
  module under `engine/crates/llm-gateway/src/providers/`).
- **Negative / accepted trade-off**: `pricing.toml` will drift from
  actual provider pricing over time and requires manual updates; this
  was accepted as lower-risk than trying to fetch live pricing (extra
  external dependency, extra failure mode) for a simulation-cost
  *estimate*, not a real invoice.
- **Follow-up**: Provider request/response parsing in Phase 0 targets
  the documented API shapes as of this ADR's date; if any provider
  changes its response envelope, the corresponding
  `engine/crates/llm-gateway/src/providers/*.rs` module needs a matching
  update — there is no schema-version negotiation.

## Related

- Spec section 6 (LLM Gateway), section 4 (`agents.llm_profile` column
  definition), section 12 Q1 (now closed).

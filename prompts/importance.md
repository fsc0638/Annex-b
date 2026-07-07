<!--
TODO: v1 全文待 FSC 提供

Per spec line 400, this file's authoritative content is v1's
prompts/importance.md, carried over unchanged into v2. That v1 spec
document is not present in this repo (only the v2.1 spec and the
company_context draft v2 are), so the exact v1 wording could not be
transcribed. Below is a minimal, spec-consistent placeholder derived
from spec 5.1 ("每筆感知 → memories(kind='observation') → 非同步
importance（L0）＋ embedding（L0）") and the memories.importance column
(spec section 4: "real not null", used by the retrieval score formula in
5.2 as importance/10). This placeholder is enough to unblock Phase 0/1
wiring (L0 tier, JSON-out contract) but its actual scoring guidance
should be replaced with FSC's v1 wording before Phase 2 relies on it for
real (non-mock) importance scoring quality.
-->
{{company_context_core}}
你是「{{agent_name}}」（{{title}}）。以下是你剛剛觀察到的一件事：
「{{observation_content}}」
請評估這件事對你而言的重要程度（1 到 10 的整數；1 = 日常瑣事如「有人走過」，
10 = 重大事件如「合約破局」「主管震怒」）。
輸出 JSON：{"importance": 1到10的整數}
只輸出 JSON。

<!--
TODO: v1 全文待 FSC 提供

Per spec line 400, this file's authoritative content is v1's
prompts/decompose.md, carried over unchanged into v2. That v1 spec
document is not present in this repo. Below is a minimal, spec-consistent
placeholder derived from spec 5.6 step 2 ("lazy 細化（prompts/decompose.md，
未來 2 小時內節點，15–30 分鐘粒度）") — i.e. it takes one top-level
daily_plan entry and breaks it into finer-grained sub-steps only for the
near-term (next 2 hours) window. Replace with FSC's v1 wording before
Phase 2 relies on it for real decomposition quality.
-->
{{company_context_core}}
你是「{{agent_name}}」（{{grade}}，{{title}}）。
你今天的日程中，接下來 2 小時內有這一條待辦：
「{{plan_item}}」（預計 {{dur_min}} 分鐘，地點：{{location}}）
請將它細分為 15 到 30 分鐘一段的具體步驟。
輸出 JSON 陣列：
[{"time":"HH:MM","dur_min":整數,"what":"...","where":"位置鍵"}]
只輸出 JSON。

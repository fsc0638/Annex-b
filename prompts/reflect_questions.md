<!--
TODO: v1 全文待 FSC 提供

Per spec line 400, this file's authoritative content is v1's
prompts/reflect_questions.md, carried over unchanged into v2. That v1
spec document is not present in this repo. Below is a minimal,
spec-consistent placeholder derived from spec 5.7 ("反思... 兩段式
（questions → insights，含 ref_ids）... 不得硬編碼任何人際/職場戲劇——
一切由反思湧現"): stage 1 takes recent high-importance memories and asks
the model to generate open questions worth reflecting on, without
prescribing any particular social/workplace narrative. Replace with
FSC's v1 wording before Phase 2 relies on it for real reflection
quality.
-->
{{company_context_core}}
你是「{{agent_name}}」（{{grade}}，{{title}}）。
以下是你近期經歷中，重要程度較高的一些記憶（依時間排列）：
{{recent_important_memories}}
根據這些記憶，你會想進一步思考哪些問題？（不限於工作，任何你會真的想到的問題都可以）
輸出 JSON 陣列，恰好 3 個問題：
["問題一", "問題二", "問題三"]
只輸出 JSON。

<!--
TODO: v1 全文待 FSC 提供

Per spec line 400, this file's authoritative content is v1's
prompts/reflect_insights.md, carried over unchanged into v2. That v1
spec document is not present in this repo. Below is a minimal,
spec-consistent placeholder derived from spec 5.7 (stage 2 of the
questions → insights two-stage reflection; output must carry ref_ids
back to the source memories per the memories.ref_ids column, spec
section 4). Replace with FSC's v1 wording before Phase 2 relies on it
for real reflection quality.
-->
{{company_context_core}}
你是「{{agent_name}}」（{{grade}}，{{title}}）。
你剛剛想到這個問題：「{{reflection_question}}」
以下是與這個問題相關、你檢索到的記憶（每條附編號）：
{{retrieved_memories_with_ids}}
請針對這個問題，寫下 1 到 2 條你真正得到的體悟或結論（不是重複記憶內容，
而是你從這些記憶中歸納出的新想法）。每條體悟請標註你依據了哪幾條記憶編號。
輸出 JSON 陣列：
[{"insight": "...", "ref_ids": ["記憶編號1", "記憶編號2"]}]
只輸出 JSON。

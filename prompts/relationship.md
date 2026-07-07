<!--
TODO: v1 全文待 FSC 提供

Per spec line 400, this file's authoritative content is v1's
prompts/relationship.md, carried over unchanged into v2. That v1 spec
document is not present in this repo. Below is a minimal, spec-consistent
placeholder derived from spec 5.8 ("關係更新... 輸出 affinity_delta 與
descriptor") and the relationships table (spec section 4: affinity real,
descriptor text). Replace with FSC's v1 wording before Phase 2 relies on
it for real relationship-update quality.
-->
{{company_context_core}}
你是「{{agent_name}}」（{{grade}}，{{title}}）。
你剛剛跟「{{partner_name}}」（{{partner_title}}）結束了一段互動：
{{interaction_summary}}
【互動前的關係】好感度 {{affinity}}/100，{{rel_descriptor}}
根據剛才的互動，你對這個人的感覺有沒有變化？
輸出 JSON：{"affinity_delta": -10到10的整數, "descriptor": "一句話描述你們現在的關係"}
只輸出 JSON。

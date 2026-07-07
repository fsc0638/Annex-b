# docs/CLAUDE.md — 專案記憶（跨 session）

> 本檔記錄重大決策、已知問題、下一步——依規格書 §0.1 規則 7，這是 AI 開發者
> 跨 session 的記憶。每個 Phase 結束後更新。

## 目前狀態

Phase 0（環境與骨架）已實作完成，於分支 `phase/0-bootstrap`。

## 重大決策

- **ADR-001**（`docs/decisions/ADR-001-multi-provider-gateway.md`）：
  三家雲端 LLM（Anthropic/OpenAI/Gemini）官方端點直連，不經公司代理；
  新增 `agents.llm_profile` 支援按 agent 指派模型。2026-07-07 FSC 定案，
  對應規格書 v2.1、規格 §12 Q1 已結案。
- **sqlx 使用 runtime query（非 `query!` 編譯期巨集）**：本機開發環境無
  DB，`query!` 系列巨集需要編譯期連線核對 schema 會直接編譯失敗。Phase 0
  尚未寫任何實際 DB 存取程式碼（healthz 的 `select 1` 用的是
  `sqlx::query(...).execute()`，屬 runtime query），但這是**所有後續
  Phase 都必須遵守的鐵則**，寫 Phase 1+ 的 DB 存取程式碼時務必留意。
- **api-server 同時輸出 lib 與 bin**：`engine/crates/api-server` 除了
  `main.rs` 二進位外，也以 `lib.rs` 匯出 `router`/`state`/`healthz`
  modules，讓整合測試（`tests/healthz.rs`）可以直接用 `tower::ServiceExt`
  的 `oneshot` 打路由，不必真的啟動一個 process。
- **`--knowledge-only` 用 delete-then-reinsert 實作「upsert」**：
  `memories` 表沒有適合當 `ON CONFLICT` 對象的唯一鍵（且規格禁止改動
  DDL 語意），所以 `scripts/seed_world.sh --knowledge-only` 對目標
  world 的 `kind='knowledge'` 記憶先整批 delete 再 insert，達到「重跑
  不會累積重複」的 upsert 效果，且不觸碰其他資料。
- **web Docker image 用 dev mode，非 production standalone build**：
  Phase 0 只有一個佔位首頁，先求簡單／快速迭代；等頁面內容多起來、
  值得做 production 優化時再換多階段 build。
- **Next.js 版本從規格未指定的預設值上調到 14.2.35**：安裝時
  `next@14.2.18` 被 npm 標為已知安全漏洞（deprecated 警告直接附連結），
  同一 major/minor line 內已有 patched 版本（14.2.35），故採用後者，
  API 面幾乎無風險但補上安全修補。

## 已知缺口（Known Gaps）

- **v1 六份 prompt（importance/decompose/react/reflect_questions/
  reflect_insights/relationship）沒有全文可抄**：規格書明說這六份
  「沿用 v1 全文不變」，但 v1 規格文件不在本 repo 內。已建立佔位檔
  （標頭 `TODO: v1 全文待 FSC 提供`），內容依規格 §5.1/5.3/5.7/5.8
  描述的輸入輸出契約寫最小可用版本，可讓 Phase 2 的管線先接得起來，
  但**實際反思/重要性評分品質未達 v1 原版水準**，正式跑真實模式前
  應換成 FSC 提供的 v1 原文。
- **`react.md` 的 rank_relation 行**：規格明確要求這六份中的 react.md
  在 v1 基礎上額外加一行 `【職級關係】{{rank_relation}}`
  （§5.3、§5.11 行400）。因為沒有 v1 原文，佔位版本直接把這個要求
  和「不得硬編碼服從」的限制寫進了佔位內容本身；換成 FSC 的 v1 原文
  時，務必保留這一行與這個限制。
- **知識切片 embedding 未實際生成**：本機開發環境沒有 Ollama，
  `seed_world.sh` 在無法連上 Ollama 時會把 20 條 knowledge 切片
  （fan-out 後共 98 筆 `memories` row）的 `embedding` 欄位留 NULL 並印
  WARN。要補上真正的 embedding，需在裝有 Ollama（含
  `mxbai-embed-large`）的環境下執行
  `scripts/seed_world.sh --knowledge-only`。
- **`office_shell.tmj` 底圖尚未製作**：Phase 0 的 `assets/maps/` 只有
  `.gitkeep` 佔位；Tiled 底圖是 Phase 1 T1.1 的工作。`seed_world.sh`
  裡的 layout_items 座標已經先依 48×32 地圖規劃好（見下方「佈局座標
  設計」），Phase 1 做底圖時牆體/門/窗要跟這個座標系一致。
- **`docker compose config` 未實機驗證**：本機沒有 Docker，
  `docker-compose.yml` 語法用 Python YAML parser 驗證過格式正確，
  三個 service（postgres/engine/web）與 volume 都在，但沒有實際跑過
  `docker compose up`。Phase 1 開始接觸真正的 tick loop 時，第一件事
  應該是在有 Docker 的環境（如 Mac Mini 部署機）跑一次完整驗證。
- **`docker-compose.yml` 用 bind-mount migration 而非 sqlx migrate**：
  `db/migrations/001_init.sql` 掛進 postgres image 的
  `/docker-entrypoint-initdb.d/`，靠 Postgres 官方 image 的「空資料夾
  首次啟動自動跑 initdb.d 底下腳本」機制套用 migration，不是用
  `sqlx migrate run`。這對 Phase 0（只有一份 migration）夠用，但
  Phase 1+ 如果要加第二份 migration，這個機制不會自動套用「新增的」
  migration 到已經初始化過的資料庫（它只在資料夾全空、首次 initdb
  時執行）——屆時建議換成 `sqlx migrate run`（或等價工具）在 engine
  啟動時跑，而不是繼續依賴 initdb.d。

## 佈局座標設計（供 Phase 1 底圖對齊）

`scripts/seed_world.sh` 的 `layout_items` 座標系是 48(寬)×32(高) tile，
以下區塊邊界供 Phase 1 製作 `office_shell.tmj` 時參考（確保牆體不會切到
家具、走道對齊）：

- `exec` 區（副總+經理大位＋隔屏）：x=1..12, y=1..5
- `open_a`（開放座位區 A，16 桌）：x=2..9, y=7..19
- `open_b`（開放座位區 B，16 桌，全空未指派）：x=26..33, y=7..19
- `meeting` 區（會議桌+8椅+白板）：x=2..7, y=21..26
- `pantry`／`common`（茶水間、影印機、檔案櫃）：x=12..19, y=22..25
- 4 盆栽分散在四角落（x=1/44/46, y=1/2/30）
- 門（規格：「下緣中央」）與窗（「上緣」）由 Phase 1 Tiled 底圖決定，
  座標系本身在 Phase 0 未預留特定門/窗位置的家具淨空——Phase 1 製圖時
  請確認大門到各 zone 的 flood-fill 連通性（規格 7.3 驗證規則 2）。

## 與規格的已知偏離／需留意的模糊處

- **阮曉青 `reports_to`**：附錄 A.1 寫「沈書萍(業務指導)/高子軒」，是
  雙線（業務指導 vs 正式回報）但 DB schema `agents.reports_to` 只有
  單一 FK。已採用 `reports_to = 高子軒`（正式回報線），業務指導關係
  寫進 `core_identity` 敘述文字裡，未建第二條 FK。此為 `[DEFAULT]`
  下的合理取捨，非規格衝突，但記在此供 FSC 檢視是否認同。
- **`relationships` 表的初始 descriptor 方向性**：規格只明確說「對直屬
  主管 descriptor='我的主管'」（下屬視角）；反方向（主管看下屬）規格
  未明講，`seed_world.sh` 預設也填 `'同部門同事'`。

## 下一步（Phase 1 起）

1. Docker 環境驗證：在有 Docker 的機器上跑 `docker compose up`，確認
   三個 service 都能起來、`GET /api/v1/healthz` 回報正確。
2. 在有 Ollama 的環境跑 `scripts/check_ollama.sh` 確認模型已拉取，
   再跑 `scripts/seed_world.sh` 完整 seed 一個 world（含真正的
   embedding）。
3. Phase 1 T1.1 起：Tiled 製作 `office_shell.tmj`，對齊上方「佈局座標
   設計」的區塊邊界。
4. 待 FSC 提供 v1 六份 prompt 全文後，覆蓋現有佔位檔（熱重載機制已就
   緒，不需改程式碼）。

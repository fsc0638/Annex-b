# docs/CLAUDE.md — 專案記憶（跨 session）

> 本檔記錄重大決策、已知問題、下一步——依規格書 §0.1 規則 7，這是 AI 開發者
> 跨 session 的記憶。每個 Phase 結束後更新。

## 目前狀態

Phase 1（辦公室世界與渲染，T1.1–T1.5）已實作完成，於分支
`phase/1-world`（基於 P0 驗收後修復批次的 `phase/0-bootstrap` tip）。
9 名 agent 依附錄 A.2 於 07:00–09:00 從大門進場走到自己座位坐下；
前端 PixiJS 即時渲染＋時間控制；workspace 測試 120 個全綠（P0 基準 70）。
Phase 0（環境與骨架）見 `phase/0-bootstrap`。

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
- **`--knowledge-only` 是 delete-then-reinsert（replace/reseed），不是
  upsert**（2026-07-07 驗收後修正措辭，見 Major #5）：`memories` 表沒有
  適合當 `ON CONFLICT` 對象的唯一鍵（且規格禁止改動 DDL 語意），所以
  `scripts/seed_world.sh --knowledge-only` 對目標 world 的
  `kind='knowledge'` 記憶先整批 delete 再 insert。這達到「重跑不會累積
  重複」且不觸碰其他資料，但**每次重跑都會讓所有 knowledge row 的
  `id`/`created_at`/`last_access` 換新**——任何引用舊 knowledge id 的
  資料（例如別筆 memory 的 `ref_ids`，或 `event_log` payload）重跑後會
  懸空。這不是 upsert 語意下使用者會預期的行為，腳本 usage header 與
  程式內註解已補上明確警語。
- **web Docker image 用 dev mode，非 production standalone build**：
  Phase 0 只有一個佔位首頁，先求簡單／快速迭代；等頁面內容多起來、
  值得做 production 優化時再換多階段 build。
- **Next.js 版本從規格未指定的預設值上調到 14.2.35**：安裝時
  `next@14.2.18` 被 npm 標為已知安全漏洞（deprecated 警告直接附連結），
  同一 major/minor line 內已有 patched 版本（14.2.35），故採用後者，
  API 面幾乎無風險但補上安全修補。

## 2026-07-07 驗收後修復

P0 對抗驗收（`docs/eval/p0-review.md`，0 blocker／6 major／4 minor）後、
疊 Phase 1 之前的修復批次，逐項對應驗收報告的編號：

- **Major #1 — tier 級 timeout/retry**：`tier::Tier` 新增
  `timeout()`/`max_retries()`（規格 §6.1 表：L0=15s/2、L1=30s/2、
  L2=60s/2、L3=90s/1），掛到 `TierTarget` 隨 tier 解析結果傳遞（含
  `llm_profile` 覆寫路徑——覆寫只換 provider:model，timeout/retry 仍跟
  tier 走）。`ChatProvider::chat`／`EmbeddingProvider::embed` 簽名改為
  接受呼叫方傳入的 `Duration`，5 個 provider 內原本寫死的
  `.timeout(...)` 全部改吃傳入值。重試迴圈實作在 gateway 呼叫端
  （`lib.rs` 的 `chat_with_retry`／`Gateway::chat_for_tier`），不在各
  provider 內。
- **Major #2 — 阮曉青雙線**：`seed_world.sh` 的通用 `rel_ins` CTE 排除
  `(阮曉青→沈書萍)` 這個 pair，改由獨立的 `ruanxiaoqing_shenshuping_rel`
  CTE 插入 `descriptor='業務指導'`；反向（沈→阮）維持
  `'同部門同事'`不變。
- **Major #3 — `desk_id` FK**：`001_init.sql` 表尾以 `alter table`（因
  `layout_items` 宣告在 `agents` 之後，需前向引用解法）補上
  `agents.desk_id references layout_items(id) on delete set null`，並
  註記同 world 一致性由應用層（佈局編輯器）維護。
- **Major #4 — healthz `providers` 形狀**：`provider_statuses()` 只留三家
  雲端（anthropic/openai/gemini）；`ollama` 已有頂層 `ComponentHealth`
  欄位不重複列，`mock` 本來就不列，兩者排除理由都補了註解。
- **Major #5 — `--knowledge-only` 措辭**：程式與文件裡「upsert」全部
  改稱 replace/reseed，usage header 補上 id-churn 警語（重跑會換掉
  knowledge rows 的 id/created_at/last_access）。
- **Major #6 — 決定性雜湊**：repo 根新增 `rust-toolchain.toml`
  （pin `1.96.1`）；`mock.rs` 的 `DefaultHasher` 換成內嵌 FNV-1a，
  doc comment 的「forever」改為「同一演算法下穩定」。
- **Minor #4 — 計價缺項警告**：`PricingTable::get` 查無
  `"provider:model"` 時仍維持 $0 記帳（行為不變），但加一行
  `tracing::warn`（含 provider/model 名）。
- **測試競態**：`lib.rs` 的 `gateway_from_env_disables_providers_without_keys`
  改為持有 `ENV_MUTEX` 再動 env（符合該檔自己的既有規範）。

## Phase 1 重大決策（2026-07-08）

- **不開 Tiled GUI，底圖用產生器**：`scripts/gen_office_shell.mjs` 直接輸出
  合法 Tiled JSON（48×32、embedded tileset、牆/窗 tile 帶 `collides=true`
  自訂屬性、大門＝下緣中央 x=23..24 兩格開口）。**家具座標不是第二份副本
  ——由 `scripts/lib/seed_layout.mjs` 解析 `seed_world.sh` 的 SQL 字面值**
  （與 `check_seed_counts.sh` 同策略），產生器寫檔前先做 flood-fill 連通
  驗證（不過就 exit 1 不寫檔）。同一解析器供 `gen_world_fixture.mjs`
  （sim-core fixture＋web mock snapshot）與 `gen_agent_sprites.mjs` 使用。
  三個產生器輸出全部決定性（重跑 byte-identical），ci.sh 有專層驗證。
- **sim-core 的 DB 載入路徑 feature-gate（`db`）**：保持 sim-core 預設
  build 無 I/O 依賴（P0 驗收認可的純資料 crate 形狀）；api-server 以
  `features=["db"]` 啟用，workspace build 仍會編譯到它。一律 sqlx
  runtime query（鐵則不變）。
- **speed 語意**：x1/x2/x5 只縮短**牆鐘** tick 間隔
  （`tick_interval_ms = tick_ms / speed`）；`sec_per_tick`（遊戲秒/tick）
  與每 tick 移動格數不變——加速＝同樣的世界行為更快播放。speed 是
  runtime 屬性不落 DB；snapshot 的 `world.speed` 由 server 注入。
  有測試斷言 x1 與 x5 的逐 tick 行為完全一致。
- **A* 決定性 tie-break**：min-heap key `(f, h, row-major idx)`、鄰居展開
  順序固定 N/E/S/W、g 嚴格變小才更新 parent。實圖 golden：門→deskA-01
  椅的路徑形狀是「沿 x=23 直上到 y=8 再向西」（L 形）。改演算法必須
  同時改 golden 並在 PR 說明。
- **通勤時刻（A.2 的工程化）**：副總 08:20、經理＋約聘 08:30、高專
  08:40、5 名專員 08:43/08:46/08:49/08:52/08:55——按**姓名 byte 序**
  錯開，與載入來源的 row 順序無關（fixture 與 DB 載入結果一致）。
  Phase 2 起這只作 day-1 daily_plan 的 prompt 先驗（A.2：非硬性）。
- **動態避讓＝等待再繞路**：A* 只吃靜態碰撞；撞到別的 agent 先等
  4 tick，還堵著就帶上「其他 agent 當前位置」重跑 A*。agent 處理順序
  ＝姓名排序（決定性）。headless 測試斷言全程無同格、無卡死 >60 tick。
- **WS lag policy**：broadcast channel 落後的 client 直接斷線，靠前端
  自動重連拿全新 snapshot 恢復一致性（snapshot 全量取代 store 狀態，
  這也同時實作了「重整頁面正確還原」驗收項）。
- **佔位素材全自製 CC0**：tileset 與 9 個 spritesheet（4 向×3 幀）由
  stdlib-only PNG encoder（`scripts/lib/png.mjs`）程式生成，登記於
  `assets/CREDITS.md`；`.gitignore` 只白名單放行這些自製檔，付費素材
  禁令不變。日後換 LimeZu/LPC 素材時整組替換並補署名。
- **世界開機為 paused**：與 seed 的 `status='paused'` 一致，按 UI 播放
  鍵才開始跑；`WORLD_SOURCE=db|fixture` 決定世界來源（fixture＝本機
  無 DB 的 demo 模式，`FIXTURE_PATH`/`TMJ_PATH` 可覆寫路徑）。

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
- ~~**`office_shell.tmj` 底圖尚未製作**~~：Phase 1 T1.1 已完成（產生器
  `scripts/gen_office_shell.mjs`，見上方 Phase 1 決策），底圖與「佈局
  座標設計」座標系已對齊並有連通性測試。
- **視覺素材是自製佔位**：tileset 4 色格、家具是 kind 上色色塊、小人是
  程式畫的像素人。功能完整但美術品質低；換正式素材（LimeZu 付費層或
  LPC 產生器）時需替換 PNG＋前端家具 Graphics 改 sprite，並更新
  CREDITS.md 的授權義務。
- **DB 載入路徑（`sim-core::db` / `WORLD_SOURCE=db`）未對真實 DB 驗證**：
  本機無 psql/Docker，只保證編譯過＋與 fixture 共用 `from_parts`。
  第一次在 compose 環境跑時要驗證：`order by created_at` 的世界挑選、
  affords（text[]）/llm_profile（jsonb）欄位的 try_get 型別對應。
- **通勤只避讓、不排隊禮讓**：兩 agent 同 tick 同時要進同一格時由姓名
  排序先到先得，後者等待/繞路。9 人錯開時刻下實測無卡死；若 Phase 2+
  出現高密度動線（晨會全員同時移動）可能需要更聰明的協商（保留觀察）。
- **`08:30` 經理與約聘同刻進場**：大門寬 2 格，兩人同 tick 各佔一格
  進場；若未來門縮成 1 格，後到者會延後 1 tick（有 spawn 容忍測試，
  斷言 ≤60 秒 slip）。
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
  單一 FK。採用 `reports_to = 高子軒`（正式回報線）；業務指導關係
  除了寫在 `core_identity` 敘述文字裡，**2026-07-07 驗收後修復
  （Major #2）額外在 `relationships` 表補了一筆
  `(阮曉青→沈書萍, descriptor='業務指導')` 的結構化 row**（該筆從通用
  `rel_ins` CTE 中排除、單獨插入，避免被通用 CTE 覆蓋成
  `'同部門同事'`），使這條 dotted line 現在可被查詢，不必只靠 LLM
  重讀敘述文字才能取得。反向（沈書萍→阮曉青）仍是 `'同部門同事'`
  （見下一條）。`reports_to` 本身仍只有單一 FK 這點未變，此為
  `[DEFAULT]` 下的合理取捨，非規格衝突，記在此供 FSC 檢視是否認同。
- **`relationships` 表的初始 descriptor 方向性**：規格只明確說「對直屬
  主管 descriptor='我的主管'」（下屬視角）；反方向（主管看下屬）規格
  未明講，`seed_world.sh` 預設也填 `'同部門同事'`。

## 下一步（Phase 2 起）

1. **Phase 2 認知核心與工作模型（T2.1–T2.8）**：記憶管線（perceive→
   去重→importance→embedding→入庫）、檢索純函數＋pgvector、daily_plan
   ＋lazy 細化、react/對話迴圈、晨會機制（5.9）、work_progress（5.10）、
   反思＋關係更新、prompts 熱重載＋JSON 防護。plans 執行將取代 Phase 1
   的硬編碼通勤（A.2 降級為 day-1 prompt 先驗）。
2. **P0 復核遺留（P2 必辦）：gateway retry 不分錯誤類別（4xx/Disabled
   也重試）——P2 接真實呼叫時改為僅 Timeout/5xx/網路錯誤重試**（來源：
   `docs/eval/p0-review.md` minor；現行 `chat_with_retry` 對所有錯誤
   一視同仁）。
3. Docker 環境驗證：在有 Docker 的機器跑 `docker compose up`（三
   service＋healthz＋`WORLD_SOURCE=db` 載入 seed world＋前端連 ws 看
   通勤）。engine 容器已掛 `./assets` 只讀卷供 tmj。
4. 在有 Ollama 的環境跑 `scripts/check_ollama.sh`＋`scripts/seed_world.sh`
   完整 seed（含真 embedding）。
5. 待 FSC 提供 v1 六份 prompt 全文後，覆蓋現有佔位檔（熱重載已就緒）。
6. Phase 2 起 event_log 需要落 DB（golden replay 的雜湊對象）；屆時
   migration 機制要照上方「initdb.d 只跑一次」的備忘改用
   `sqlx migrate run`（或等價）。

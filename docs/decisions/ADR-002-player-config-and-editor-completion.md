# ADR-002 — 玩家配置系統與佈局編輯器補完（Phase 3 前置）

> 狀態：Accepted（2026-07-11，制度 session 裁決）
> 背景：使用者三項需求——(1) 素材資產完整呈現＋背景可配置；(2) 房間大小可設定；
> (3) 角色個別客製化（名稱／個性／風格／回覆方式）。加上遠端 commit 071330d
> 留下的半成品（LayoutEditorPanel 未掛載且引用三個不存在的模組）需要收尾。

## 現況事實（2026-07-11 五路偵察結論）

- `web/src/panels/LayoutEditorPanel.tsx`（1313 行）未被任何頁面 import；
  引用不存在的 `@/api/client`、`LayoutValidation` 型別、store 的
  `layoutValidation` 欄位。main 的 `next build` 預期紅燈（待基線驗證輸出）。
- LimeZu 素材包全機不存在（`assets/tilesets/limezu-modern-office/` 零命中），
  sync 腳本靜默跳過（scripts/sync_limezu_assets.mjs:163-165），編輯器素材清單
  退化成 10 個無圖色塊（LayoutEditorPanel.tsx:151-162）。
- 「背景」（地板/牆）非可編輯概念：烤死在 office_shell.tmj 靜態圖層。
- 引擎已尺寸無關（tilemap.rs:30-32 動態讀 TMJ width/height）；寫死 48×32 的只有：
  產生器常數（gen_office_shell.mjs:37-39）、OfficeCanvas.tsx:28-30、
  LayoutEditorPanel.tsx:40-41、兩個 golden 測試（fixture.rs:65-66、
  tests/office_map.rs）。DB schema 完全沒有地圖尺寸欄位。
- agents 表欄位齊全但零編輯途徑：router 只有 /api/v1/healthz 與 /ws。
- 本機無 Docker/psql/Ollama：驗收證據只能來自 fixture 模式引擎＋web dev＋
  cargo test＋ci.sh 1–5c 層。

## 決策

### D1. 單一產生器、客戶端產圖、引擎收圖驗證
地圖產生核心抽成純函數模組 **`web/src/lib/office_shell_core.mjs`**（無 fs、無
Node API，輸出 TMJ 物件）；`scripts/gen_office_shell.mjs` 改為 import 該模組＋
寫檔外殼。web 前端 import 同一模組在瀏覽器產圖。**禁止第二份產圖邏輯。**
預設參數（48×32、default 主題）輸出必須與現有檔案 **byte-identical**
（ci.sh 決定性層是驗收關卡）。

### D2. 引擎新增世界配置 REST API（含驗證與廣播）
`api-server` 新增：
- `GET /api/v1/world/map` → 現行 TMJ JSON ＋ `map_rev`。
- `PUT /api/v1/world/map`，body `{"tmj": <TMJ JSON>}` → 以 `TileMap::from_tmj`
  重建＋額外驗證（尺寸 20..=96、至少一個 door tile、flood-fill 連通、現有
  layout items 全部在界內且不壓牆）。通過→替換地圖、世界重置為 day-start
  paused（等同重啟語意，簡單且決定性）、`map_rev += 1`、廣播全量
  world_snapshot（world payload 加 `map_rev` 欄位）。
- `PUT /api/v1/world/layout`，body `{"items":[LayoutItemRow…]}` → 沿用
  from_parts 同級驗證（界內、chair 一對一、不壓牆）→ 替換、重置 paused、廣播。
- `PATCH /api/v1/agents/:id`，body 任選 `{name, seed_traits, core_identity,
  reply_style, llm_profile}` → 驗證（name 非空且同世界唯一；llm_profile 只允許
  L1/L2/L3 鍵，格式 "provider:model"；L0 不可覆寫）→ 更新→廣播全量 snapshot
  （不重置、不動位置）。
- 錯誤格式統一 `{"error":{"code":"...","message":"..."}}`，400/404/422。

### D3. 持久化：fixture 模式存檔檔案；db 模式寫 DB
- fixture 模式：任何成功變更後原子寫入（tmp+rename）`WORLD_SAVE_PATH`
  （預設 `{repo}/data/world_save.json`，gitignore）。啟動時存在且通過驗證→
  優先載入；損壞→WARN 忽略並照舊走 fixture（不 crash）。
- db 模式：layout/agents 走 SQL UPDATE（runtime query 鐵則不變）；地圖存
  `worlds.map_tmj jsonb`（新欄位）。**001_init.sql 直接修改**（判斷依據：
  compose 從未在任何機器跑過、不存在已初始化的 DB；initdb.d 一次性限制
  記錄在案不變）。本機無 DB，db 路徑以編譯＋單元測試保證，實機驗證留給
  部署機（docs/CLAUDE.md 既有缺口條目延續）。

### D4. 背景（＝使用者口中的「倍鏡」，同音誤植）成為一等公民
- 佔位 tileset 擴為 **4 個主題**（default／warm／cool／dark），由 png.mjs
  程式生成（CC0 自製，CREDITS.md 登記），同步至 web/public/tilesets/。
  default 主題必須與現行 office_shell_placeholder.png byte-identical。
- 編輯器新增「世界設定」區：背景主題選擇器＋房間寬高（20..96）輸入，
  套用＝前端用 office_shell_core 產 TMJ → PUT /world/map。
- LimeZu 缺包時：編輯器顯示明確安裝指引橫幅（來源路徑＋sync 指令），
  取代現在的靜默退化；素材 manifest 存在時調色盤顯示真實圖像。
  補 `assets/tilesets/limezu-modern-office/manifest.example.json`。
- OfficeCanvas 增加攝影機縮放/平移（滾輪縮放、拖曳平移、fit/reset 按鈕）
  ——若使用者「倍鏡」真意為縮放鏡頭，此項同時覆蓋。

### D5. 角色客製化四欄位映射
名稱=`agents.name`；個性=`seed_traits`；風格（人設全文）=`core_identity`；
回覆方式=**新欄位 `agents.reply_style text`**（001_init.sql＋seed_world.sh 給
9 名角色合理預設值；prompts/converse.md 補 `{{reply_style}}` 佔位符行）。
`llm_profile` 提供 L1/L2/L3 逐層模型覆寫 UI（掛既有 tier.rs:153-175 邏輯）。
**紅線（規格書 §5.3/附錄A）**：只開放人設文字編輯，不得提供任何「服從/敵對
關係」的硬編碼開關；rank_relation 注入行與「不得硬編碼服從」限制保持原樣。

### D6. 前端資訊架構
page.tsx 改為三分頁：**監控**（現有畫布＋時間控制）／**佈局編輯器**（含世界
設定）／**角色設定**（新 AgentPanel）。補 `web/src/api/client.ts`（apiJson，
base=NEXT_PUBLIC_API_BASE_URL 預設 http://localhost:8080）、`LayoutValidation`
型別、store `layoutValidation` 欄位與 map 狀態。MAP_W/MAP_H 硬編碼全部改由
載入的 TMJ 動態取得。mock 模式：編輯/角色分頁顯示唯讀＋提示（無引擎可寫）。

### D7. Golden 測試策略
既有 48×32 golden（office_map.rs、fixture.rs）**不動**——它們釘的是預設
fixture，預設輸出 byte-identical 所以必然續綠。新增參數化測試（如 60×40）
驗證產生器與引擎在非預設尺寸下的正確性（連通、界檢、A* 可達）。

## 里程碑與驗收證據

| # | 內容 | 證據 |
|---|---|---|
| M0 | 基線：main 的 web build 紅燈確認 | build 輸出 |
| M1 | Rust API＋持久化＋測試 | `cargo test --workspace` 全綠輸出 |
| M2 | 產生器參數化＋主題＋決定性 | 產生器重跑 `git diff --exit-code` 通過；預設輸出 byte-identical |
| M3 | web 核心（api client/store/動態尺寸/縮放） | `pnpm build` 綠 |
| M4 | 編輯器補完＋世界設定＋角色面板 | `pnpm build` 綠＋實跑截圖 |
| M5 | 端到端：fixture 引擎＋web，改房間大小/背景/角色並重啟仍在 | 瀏覽器操作紀錄＋存檔檔案內容 |
| M6 | 遊戲視角審查（視覺/操作/維護）＋修復 | 審查報告＋修復 diff＋複驗 |

## 不做（本輪）
- LimeZu 素材實際購買/放置（使用者的實體動作；管線與指引已就緒）。
- 縮小房間時自動重排家具（驗證擋下＋UI 指引玩家自行移動；縮到裝不下
  現有家具的尺寸會被驗證拒絕，訊息含最小可行尺寸）。
- Phase 2 認知管線（reply_style 欄位先落地，待管線實作時自然生效——
  佔位符已進 converse.md）。

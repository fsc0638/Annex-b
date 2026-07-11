# ADR-003 — 真實素材接入與角色外觀客製化

> 狀態：Accepted（2026-07-12，使用者定調兩項範圍抉擇）
> 背景：使用者把購買的 LimeZu 素材包（5 個資料夾、約 5.5 萬張 PNG）解壓進
> `assets/tilesets/limezu-modern-office/`，要求「讓前端認識所有素材資產」，
> 並定調「連角色外觀一起做」。承接 ADR-002 的素材管線與角色客製化基礎。

## 素材庫實況（2026-07-12 掃描）

- **Modern_Office_Revamped_v1.2**：`4_Modern_Office_singles/32x32/` 339 件辦公室
  家具單品（`Modern_Office_Singles_32x32_N.png`，數字命名）。ADR-002 的 sync
  腳本已認得這批。
- **moderninteriors-win**（5 萬張主體）：`1_Interiors/32x32/
  Theme_Sorter_Singles_32x32/<主題>/` 底下 **26 個主題**分類單品（會議廳、客廳、
  廚房、浴室、教室圖書館、藝術、地下室、博物館、臥室、日式…等）。同素材另有
  16/48 尺寸與 Black_Shadow/Shadowless 兩種陰影變體（**重複，本輪不納入**）。
  另有 `2_Characters/Character_Generator/` 角色部件（與下方 Character Generator
  包重複）。
- **Character Generator 2.0 Linux Build**：`Character Pieces/` 分層部件——
  Bodies(10)/Eyes(7)/Hairstyles(200)/Outfits(132)/Accessories(84)＋各 _kids 變體。
  **每個部件是 1792×1280 的大張分層動畫表**（56×40 格 ×32px，含 idle/走路/睡覺/
  推車等全動畫）。另有 `0_Premade_Characters/32x32/` 20 個預組角色（1792×1312）。
- **Modern_Interiors_Free_v2.2**（win 版子集，重複）、**Modern_Interiors_RPG_Maker_
  Version**（RPG Maker 切片格式，非單品）：**本輪略過**。
- 現有 agent 走路 sprite 格式：**96×128**（3 幀 ×4 向，`gen_agent_sprites.mjs`
  產生，引擎/OfficeCanvas AnimatedSprite 消費）。

## 決策

### D1. 家具素材：Office ＋ 26 主題單品，分類編目（32×32 標準陰影一份）
- `sync_limezu_assets.mjs` 重寫為**多來源掃描器**：
  (a) Modern Office singles/32x32 → category `office`；
  (b) moderninteriors-win 的 `Theme_Sorter_Singles_32x32/<N_主題名>/` → 26 個
      category（由資料夾名解析，繁中 label 對照表）。
- 只納入 **32×32、標準陰影**一份（排除 16/48 尺寸與 black-shadow/shadowless 變體
  的 ~10× 重複，零視覺損失）。
- 產出 `manifest.json`：
  - `catalog: [{id, file, image(public url), kind(啟發式推斷), category, label}]`
    （數千件，供調色盤分類瀏覽）；
  - `sprites: {<10 個既有 kind>: {image}}`（每個 kind 挑一張代表圖，讓現有佈局
    的桌椅櫃等**直接顯示真實圖**取代色塊）。
- 複製選定子集 PNG 到 `web/public/tilesets/limezu-modern-office/`（保留相對路徑）。
  付費素材：來源與 public 複本**皆 gitignored**（.gitignore 既有規則已涵蓋整個
  `limezu-modern-office/`，只白名單 manifest.example.json）。
- 缺包指引橫幅（ADR-002 D4）維持：偵測不到來源時顯示安裝步驟。

### D2. 前端家具庫：分類瀏覽 ＋ 搜尋 ＋ 視窗化網格
- LayoutEditorPanel 素材庫改造以承載數千件：**主題分類選擇器**（下拉/tab）＋
  **關鍵字搜尋**（比對 label/kind/category）＋**縮圖網格**（分頁或視窗化，避免一次
  渲染數千 `<img>`）。無 manifest 時維持既有 10 色塊 fallback ＋缺包橫幅。
- 每件家具可指定 material（catalog item）→ 存進 layout item 的 meta；OfficeCanvas
  家具層優先用該 item 的 material image，其次 `sprites[kind]`，最後色塊。

### D3. 角色外觀：瀏覽器 Canvas 分層疊合（不寫 Node PNG 解碼器）
- **不在 Node 端解碼/切幀**（專案僅有 png 編碼器；避免引入解碼器）。改為
  **全在瀏覽器合成**：
  - sync 複製成人 32×32 分層部件表（Bodies/Eyes/Hairstyles/Outfits/Accessories，
    _kids 不納入）到 `web/public/character/<layer>/<piece>.png`，並產
    `web/public/character/manifest.json`（各層可選 piece 清單＋繁中 label）。
  - 新 agent 欄位 **`appearance jsonb`**（001_init.sql）：
    `{body, eyes, hairstyle, outfit, accessory}`（各為 piece id，可空）。
    null＝沿用現有程式產生的佔位 sprite（永不回退失敗）。
  - AgentPanel 新增「外觀」區：逐層下拉 ＋ **即時預覽 canvas**（疊合選定層的走路
    朝下首幀）。也提供「預組角色」快速套用（20 個 premade，一鍵填入近似分層或
    直接當單層 body 用——實作時擇一，記錄於交付）。
  - OfficeCanvas：agent 有 appearance 時，於瀏覽器把各層的**走路幀**（3×4）疊合到
    離屏 canvas → `Pixi.Texture`，**依 appearance 內容快取**（同外觀只合成一次）；
    無 appearance 時用既有 `agent_<name>.png`。
  - 持久化：PATCH `/api/v1/agents/:id` 擴充接受 `appearance`（沿用 ADR-002 的
    reply_style 貫通路徑：DB/seed 預設 null/fixture/broadcast）。
- **走路幀座標**：LimeZu 大表的 3幀×4向 走路幀在表中的 (col,row) 由專責 agent
  **實測釘定並寫進共用常數＋註解**（zoom 進實際 PNG 驗證朝向正確），不臆測。

### D4. 授權與決定性
- 所有 LimeZu 付費素材（來源＋public 複本＋character/）一律 gitignored，永不進
  版控；CREDITS.md 註記「使用者本機自有授權，程式生成的佔位素材才進 repo」。
- sync/character 產生器對檔案系統迭代**排序**確保穩定；產出在 public（gitignored）
  故不列 ci.sh 決定性層（該層只管進版控的自製素材）。

## 不做（本輪）
- 16×16 / 48×48 尺寸、black-shadow / shadowless 陰影變體、_kids 角色、RPG Maker 與
  Free 包（全屬重複或格式不符）。
- 角色的非走路動畫（推車/睡覺/跑步等）——只切走路幀，維持既有 sprite 契約。
- 家具的多格佔用自動推斷（維持現有 footprint 機制；material 只換貼圖不改碰撞）。

## 里程碑
| # | 內容 | 證據 |
|---|---|---|
| A1 | 家具多來源分類 sync ＋ manifest | node 實跑：catalog 數、複製數、manifest 形狀 |
| A2 | 角色走路幀座標釘定 ＋ 一個合成角色 POC | 合成 96×128 走路圖視覺驗證朝向正確 |
| B1 | 前端家具分類瀏覽器 ＋ 真實圖渲染 | build 綠＋瀏覽器實測分類/搜尋/擺放 |
| B2 | 角色外觀 UI ＋ 渲染 ＋ 持久化 | PATCH 200＋重啟留存＋畫布顯示客製外觀 |
| C | 對抗審查＋修復＋CI＋docs＋push | 審查清零＋ci.sh 全綠＋端到端 |

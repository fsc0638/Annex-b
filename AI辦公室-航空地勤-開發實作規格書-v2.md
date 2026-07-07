# AI 辦公室 — 航空地勤合約與招商部門 生成式智能體模擬系統
## 開發實作規格書 (Development Handoff Spec) v2.0

| 欄位 | 內容 |
|---|---|
| 文件版本 | v2.1 (2026-07-07) — v2.0＋多供應商 LLM（Anthropic/OpenAI/Gemini 皆直連）與按 agent 指派模型（FSC 指示，ADR-001）；v2.0 取代 v1.0（合租公寓版），方向變更：辦公室情境 + 佈局編輯器 |
| 專案擁有者 | FSC (范書愷) — 專案副理／軟體工程師 |
| 目標讀者 | **Claude Opus / Claude Sonnet**（作為後續開發的 AI coding agent），以及人類協作者 |
| 專案代號 | `annex-b`（專案名 **Annex B／附錄B**，2026-07-07 FSC 定名；原代號 `ai-office`） |
| 情境來源 | FSC 本人的航空地勤業實務經驗（地勤服務合約、規範、招商投標）；技術架構源自 Stanford *Generative Agents* (UIST '23) |
| 參照實作 | `joonspk-research/generative_agents`、`a16z-infra/ai-town`、`pixel-agents-hq/pixel-agents` |

> **虛構聲明（強制）**：公司名、人物名、航空公司名一律虛構。本模擬以真實**產業情境**為本，但**不得**使用或影射任何真實公司、真實同事、真實航司之名稱與可辨識特徵。AI 開發者在產生任何 seed 資料或測試資料時皆須遵守此條。

---

## 0. 給 AI 開發者的指示（READ FIRST — Opus / Sonnet 必讀）

你（Claude Opus 或 Claude Sonnet）是本專案的主力開發者。請嚴格遵守以下工作方式：

### 0.1 工作守則

1. **先讀完整份文件再動工。** 本文件是唯一權威規格（single source of truth）。與你的先驗知識衝突時，以本文件為準；發現文件內部矛盾時，停下來向 FSC 回報，不要自行猜測。
2. **按 Phase 順序實作**（見第 8 章）。每個 Phase 結束時逐項核對驗收標準，全數通過才能進入下一個 Phase。
3. **標記 `[DECISION-需FSC確認]`**：實作前必須向 FSC 提問並取得決定，不可自行拍板。
4. **標記 `[DEFAULT]`**：預設值可直接採用；若你有更好做法，先實作預設值，再另行提案。
5. **不要擅自擴充範圍。** 第 2 章 Non-Goals 明列本版不做的事；任何「順手加上」都算 scope creep。
6. **每個可運行里程碑就 commit**，Conventional Commits（`feat:`/`fix:`/`chore:`/`docs:`/`test:`），commit message 英文。
7. **維護 `docs/CLAUDE.md`**：記錄重大決策、已知問題、下一步——這是你跨 session 的記憶。
8. **程式碼註解與 log 用英文；UI 文字用繁體中文（zh-TW）**（i18n key 先行，日文為 Phase 3 待決項）。
9. **Secret 只放環境變數**；`.env` 進 `.gitignore`，提供 `.env.example`。
10. **成本意識**：所有雲端 LLM 呼叫一律經 LLM Gateway（第 6 章）路由與計量，不允許繞道。
11. **領域知識分離**：航空地勤的產業描述集中放在 `prompts/company_context.md`（由 FSC 以真實經驗撰寫/修訂），程式碼不得散落硬編碼的產業敘述——這讓 FSC 能持續用實務經驗校準模擬真實度而不動程式。

### 0.2 開發環境假設

- 部署目標：FSC 的 **Mac Mini（Apple Silicon）**，Docker Compose 編排；開發可能在 Windows/PowerShell 進行，指令提供跨平台版本（以 `justfile` 統一）。
- 本地推論：**Ollama**；雲端：**Anthropic／OpenAI／Google Gemini 三家一級支援**（皆官方端點直連，金鑰放 env，未設金鑰的供應商自動停用；2026-07-07 FSC 指示），並支援**按 agent 指派模型**（`agents.llm_profile`，見第 4、6 章）。

### 0.3 完成的定義（Definition of Done）

- 可編譯、`cargo clippy -- -D warnings` 與 `pnpm lint` 通過。
- 有對應自動化測試，`scripts/ci.sh` 一鍵可跑。
- 對外行為（API、WS、DB schema）與本文件一致；必須偏離時，先改本文件並在 PR 說明標註。
- `docs/CLAUDE.md` 已更新。

---

## 1. 專案概述

### 1.1 一句話目標

在一張 2D 像素風**辦公室**地圖上，模擬一個 **9 人的航空地勤「合約與招商部門」**：每位 agent 具有職級與職掌，依日程上班、處理合約與標案工作項、開晨會、彼此討論，並透過記憶→反思→規劃的認知循環長出非腳本化的協作與人際動態；**辦公室佈局可在畫面上直接手動調整**（拖放桌椅與隔間），agent 即時適應新動線。

### 1.2 背景（為什麼做）

v1 的合租公寓驗證了社會湧現；v2 把場景換成 FSC 熟悉的真實職場——航空地勤業的合約/規範/招商投標辦公室——讓模擬產生**可對照現實的組織行為觀察**：

1. **空間 × 行為**：開放座位區與主管隱私區的配置如何影響資訊流動與互動頻率（佈局編輯器就是實驗旋鈕）。
2. **層級 × 溝通**：約聘/專員/高級專員/經理/副總的層級結構下，訊息如何往上與往下傳。
3. **工作負載模擬**：合約續約、投標截止等壓力事件下的協作模式。
4. 延續 v1 的工程目標：記憶/檢索/反思架構驗證、本地小模型 vs 雲端模型的品質-成本曲線、multi-agent 可觀測性 UI 打樣（可回饋 KWAY 內部 AI 平台）。

### 1.3 公司與部門設定（模擬世界觀）

- 虛構公司：**「晨翔航勤股份有限公司」**（Morningsoar Aviation Services，虛構）——機場地勤代理業者。
- 模擬部門：**合約與招商部（Contracts & Business Development）**，職掌：
  - 與航空公司客戶的**地勤服務合約**（依 IATA SGHA 架構：機坪作業、行李、貨運郵件、旅客服務、載重平衡、航機清艙等附錄服務項目）之議約、續約、修約。
  - **服務規範/SLA** 制定與稽核追蹤。
  - **招商與投標**：機場當局或航司釋出之標案（貴賓室經營、櫃檯代理、GSE 外包等）的標書撰寫、報價、廠商評選。
- 部門編制 9 人：副總 ×1、經理 ×1、高級專員 ×1、專員 ×5、約聘 ×1（人設見附錄 A）。
- 作息 `[DEFAULT]`：模擬時鐘 07:00 開局；09:00–18:00 為核心工時；09:10 晨會（世界規則，見 5.9）；12:00–13:00 午休。加班行為由 agent 依工作壓力自行湧現，不硬編碼。

### 1.4 成功標準（可量測）

| # | 標準 | 量測方式 |
|---|---|---|
| S1 | 9 個 agent 無人工介入連續模擬 ≥ 3 個遊戲工作日（不崩潰、不卡死） | 引擎 uptime log |
| S2 | 每 agent 每日自主日程與其**職級/職掌**一致率，人工抽查 ≥ 80% | 抽 10 份日程評分 |
| S3 | Reflection 產生 ≥ 1 條未寫於初始人設的認知，且可觀察到後續行為影響 | 事件日誌人工標註 |
| S4 | UI 可即時看到：agent 位置/行動/對話、記憶流、關係圖、**工作看板（work items 進度）** | UI 驗收 |
| S5 | 單一遊戲日雲端成本 ≤ 預算上限（`[DEFAULT]` USD $2/遊戲日），有逐日報表 | 成本計量表 |
| S6 | 同 seed + mock LLM 下模擬 100% 可重現 | golden replay 測試 |
| S7 | **佈局編輯往返**：編輯模式拖放家具→儲存→世界恢復後，agent 依新碰撞圖重新尋路、不穿牆不卡死 | 佈局編輯整合測試 |

---

## 2. Goals / Non-Goals

### 2.1 Goals（v2 範圍）

- G1. 單一辦公室地圖，9 個具職級的 agent；預設佈局＝**開放空間 4×4 座位區 ×2 區塊 + 主管隱私區 2 個大位**（詳 7.2）。
- G2. 完整認知循環：perceive → retrieve → plan → act/converse → reflect（承襲 v1，第 5 章）。
- G3. **工作模型**：`work_items`（合約案/標案/稽核案）驅動 agent 的日常規劃與協作；晨會為固定世界規則。
- G4. PostgreSQL + pgvector 記憶流與「近期性×重要性×相關性」檢索。
- G5. LLM Gateway：本地/雲端分層路由、佇列、預算熔斷、計量。
- G6. Next.js + PixiJS 前端：即時渲染、agent/工作看板/關係圖面板、時間控制。
- G7. **佈局編輯器**：編輯模式下於畫面拖放/旋轉/刪除家具與座位、指派座位給 agent、驗證可達性、存檔後引擎重建碰撞圖與動線。
- G8. 一鍵部署：`docker compose up` 於 Mac Mini 跑起全套。

### 2.2 Non-Goals（v2 明確不做）

- N1. **不做**多人連線／玩家角色（僅保留「訪客留言/派工」單向注入）。
- N2. **不做** tile 底圖（牆體、樓層）的編輯器——佈局編輯僅限**家具/座位/隔屏層**；牆體仍由 Tiled 底圖決定。理由：控制編輯器複雜度。
- N3. **不做**真實文件產出（不生成真的合約書/標書內容；work item 只有標題、狀態與一句話進度）。
- N4. **不做**對真實人員的績效模擬或評價；人物一律虛構（見卷首虛構聲明）。
- N5. **不做**語音、音樂、多樓層、電梯。
- N6. **不做** agent 微調（fine-tuning）；人格＝prompt＋記憶。
- N7. **不做**超過 12 名 agent 的擴展性優化（架構不阻擋即可）。

---

## 3. 系統架構

### 3.1 元件圖

```
┌─────────────────────────────── Mac Mini (Docker Compose) ───────────────────────────────┐
│                                                                                          │
│  ┌────────────┐   REST/WS    ┌──────────────────────────────┐        ┌───────────────┐  │
│  │  web       │◄────────────►│  engine (Rust workspace)     │  SQL   │  postgres:16  │  │
│  │  Next.js   │              │  ┌───────────┐ ┌───────────┐ │◄──────►│  + pgvector   │  │
│  │  + PixiJS  │              │  │ sim-core  │ │agent-core │ │        └───────────────┘  │
│  │  +佈局編輯 │              │  │ tick/尋路 │ │ 認知管線  │ │                            │
│  └────────────┘              │  │ +layout   │ └─────┬─────┘ │                            │
│                              │  └─────┬─────┘       │       │                            │
│                              │        └──────┬──────┘       │                            │
│                              │        ┌──────▼──────┐       │                            │
│                              │        │ llm-gateway │       │                            │
│                              │        └──┬───────┬──┘       │                            │
│                              └───────────┼───────┼──────────┘                            │
└──────────────────────────────────────────┼───────┼───────────────────────────────────────┘
                                 host.docker.internal   HTTPS
                                    ┌──────▼──┐ ┌──▼────────────────┐
                                    │ Ollama  │ │ Cloud LLM APIs    │
                                    └─────────┘ └───────────────────┘
```

### 3.2 技術棧（同 v1，最低要求）

| 層 | 技術 |
|---|---|
| 模擬引擎 | Rust (stable), tokio, axum, sqlx, serde, pgvector crate；workspace 多 crate |
| 資料庫 | PostgreSQL 16 + pgvector 0.7+ |
| 本地 LLM | Ollama：`qwen2.5:7b-instruct` `[DEFAULT]` ＋ `mxbai-embed-large`（1024 維） |
| 雲端 LLM | Anthropic Messages API `[DEFAULT]`＋OpenAI Chat Completions＋Google Gemini generateContent；全部型號 ID 放 env，未設金鑰的供應商停用 |
| 前端 | Next.js (App Router) + TypeScript + PixiJS v8 + Zustand + Tailwind |
| 地圖 | Tiled `.tmj` 底圖（牆/地板）＋ **DB 動態家具層**（佈局編輯的對象） |
| 編排 | Docker Compose；Ollama 於宿主機 |

### 3.3 目錄結構（Phase 0 建立）

```
annex-b/
├── docker-compose.yml
├── .env.example
├── justfile
├── docs/
│   ├── CLAUDE.md
│   ├── decisions/
│   └── domain/ground_handling.md     # FSC 以真實經驗撰寫的產業備忘（供校準，不入 prompt 者除外）
├── db/migrations/
├── engine/crates/
│   ├── sim-core/        # 世界狀態、tick、A*、layout 碰撞重建、事件匯流排
│   ├── agent-core/      # 認知管線
│   ├── llm-gateway/     # 路由、佇列、計量、mock
│   └── api-server/      # axum REST + WS
├── web/src/
│   ├── game/            # PixiJS 場景、sprite
│   ├── editor/          # 佈局編輯模式（palette、拖放、驗證提示）
│   ├── panels/          # 記憶流、關係圖、工作看板、成本
│   └── ws/
├── assets/
│   ├── maps/office_shell.tmj         # 只有牆/地板/門的殼
│   ├── tilesets/                     # LimeZu Modern Office 等（授權見第 9 章）
│   └── sprites/agents/               # 9 個角色 spritesheet
├── prompts/
│   ├── company_context_core.md       # 公司/部門世界觀·核心層（FSC 可改，熱重載）
│   ├── company_context_full.md       # 世界觀·完整層＝core+擴充（草稿v2 三層注入設計）
│   ├── importance.md  daily_plan.md  decompose.md  react.md
│   ├── converse.md    meeting.md     work_progress.md
│   ├── reflect_questions.md  reflect_insights.md  relationship.md
└── scripts/  (ci.sh, seed_world.sh, eval_day.sh)
```

---

## 4. 資料模型（PostgreSQL DDL — `001_init.sql` 規格）

> 規則同 v1：sqlx migrate；所有表含 `created_at timestamptz not null default now()`；可補索引/trigger，**不得刪改欄位語意**。相較 v1 的差異以「★」標示。

```sql
create extension if not exists vector;

create table worlds (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  seed          bigint not null,
  sim_day       int  not null default 1,
  sim_clock_sec int  not null default 25200,   -- ★ 07:00 開局
  tick_ms       int  not null default 1000,
  sec_per_tick  int  not null default 10,
  status        text not null default 'paused' -- paused | running | editing ★ | archived
);

create table agents (
  id             uuid primary key default gen_random_uuid(),
  world_id       uuid not null references worlds(id),
  name           text not null,
  sprite_key     text not null,
  grade          text not null,      -- ★ 約聘 | 專員 | 高級專員 | 經理 | 副總
  title          text not null,      -- ★ 職稱，如 '合約專員（機坪作業）'
  reports_to     uuid references agents(id),   -- ★ 回報線（副總為 null）
  core_identity  text not null,
  seed_traits    text not null,
  current_status text not null default 'commuting',
  pos_x          int  not null,
  pos_y          int  not null,
  desk_id        uuid,               -- ★ 指派座位（layout_items.id），可為 null
  llm_profile    jsonb not null default '{}'   -- ★★v2.1 按角色指派模型，如 {"L1":"openai:gpt-4o-mini","L3":"gemini:gemini-2.5-pro"}；空物件＝走第6章 tier 預設
);

-- ★ 動態佈局層（佈局編輯器的資料來源；碰撞由此重建）
create table layout_items (
  id         uuid primary key default gen_random_uuid(),
  world_id   uuid not null references worlds(id),
  kind       text not null,   -- desk | exec_desk | chair | partition | meeting_table
                              -- | cabinet | printer | plant | pantry_counter | whiteboard
  key        text not null,   -- 語意鍵，如 'deskA-07'、'exec.vp'、'meeting.table'
  name       text not null,   -- 顯示名，如 '影印機'
  pos_x      int not null,    -- tile 座標（左上角）
  pos_y      int not null,
  w          int not null default 1,   -- footprint（tile 數）
  h          int not null default 1,
  rotation   int not null default 0,   -- 0|90|180|270
  zone       text not null,            -- open_a | open_b | exec | meeting | pantry | common
  walkable   boolean not null default false, -- 椅子=true，桌/櫃=false
  affords    text[] not null default '{}',   -- {'work','print','discuss','coffee'}
  meta       jsonb not null default '{}'     -- 例：desk 的朝向、槽位編號
);
create unique index on layout_items (world_id, key);

-- ★ 工作項（合約/標案/稽核）：驅動日常規劃與協作
create table work_items (
  id            uuid primary key default gen_random_uuid(),
  world_id      uuid not null references worlds(id),
  kind          text not null,  -- contract_renewal | tender | sla_audit | quotation | complaint
  title         text not null,  -- 例：'星海航空 台北站地勤服務合約續約'
  client        text not null,  -- 虛構航司/機場當局名
  owner_id      uuid references agents(id),      -- 主辦
  collaborators uuid[] not null default '{}',    -- 協辦
  status        text not null default 'open',    -- open | in_progress | review | done | overdue
  priority      int  not null default 3,         -- 1(急)..5(緩)
  due_day       int,                             -- 遊戲日
  progress      int  not null default 0,         -- 0..100
  last_note     text                             -- 最近一句進度（LLM 生成）
);

create table memories (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references agents(id),
  kind         text not null,   -- observation | dialogue | plan | reflection | event | work ★ | knowledge ★★v2.1（領域知識切片，見草稿v2整合說明）
  content      text not null,
  importance   real not null,
  embedding    vector(1024),
  sim_day      int not null,
  sim_clock_sec int not null,
  last_access  timestamptz not null default now(),
  ref_ids      uuid[] default '{}'
);
create index on memories using hnsw (embedding vector_cosine_ops);
create index on memories (agent_id, sim_day);

create table plans (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references agents(id),
  sim_day     int not null,
  parent_id   uuid references plans(id),
  seq         int not null,
  description text not null,
  location    text,                 -- layout_items.key 或 zone 名
  work_item_id uuid references work_items(id),  -- ★ 綁定工作項（可 null）
  start_sec   int not null,
  dur_sec     int not null,
  status      text not null default 'pending'
);

create table conversations (
  id        uuid primary key default gen_random_uuid(),
  world_id  uuid not null references worlds(id),
  kind      text not null default 'chat',   -- ★ chat | meeting
  sim_day   int not null,
  started_sec int not null,
  ended_sec   int,
  location  text
);
create table conversation_turns (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  speaker_id      uuid not null references agents(id),
  seq             int not null,
  content         text not null
);

create table relationships (
  agent_id    uuid not null references agents(id),
  target_id   uuid not null references agents(id),
  affinity    real not null default 0,
  descriptor  text not null default '同部門同事',
  updated_day int not null default 1,
  primary key (agent_id, target_id)
);

create table event_log (
  id        bigserial primary key,
  world_id  uuid not null references worlds(id),
  sim_day   int not null,
  sim_clock_sec int not null,
  kind      text not null,   -- tick_error | conversation | meeting | reflection | emergent
                             -- | layout_saved ★ | work_update ★ | budget_degraded | llm_call
  payload   jsonb not null
);

create table llm_calls (
  id          bigserial primary key,
  world_id    uuid, agent_id uuid,
  tier        text not null, provider text not null, model text not null,
  purpose     text not null,
  input_tokens int, output_tokens int,
  cost_usd    numeric(10,6) default 0,
  latency_ms  int, ok boolean not null
);
```

---

## 5. Agent 認知循環規格（agent-core）

每 tick（= 遊戲內 10 秒）對每個在場 agent 執行管線。**管線決定性，僅 LLM 呼叫為非決定性來源**（mock 模式除外）。

```
tick ─► 5.1 perceive ─► 5.2 retrieve ─► 5.3 should_react? ─┬─ 否 ─► 依 plan 續行(act)
                                                            └─ 是 ─► 5.4 react/converse ─► 5.5 re-plan
每遊戲日到班時       ─► 5.6 daily_plan（含 work_items 分派結果）
09:10（世界規則）    ─► 5.9 晨會（meeting）
在座位執行工作節點時 ─► 5.10 work_progress（進度推進）
累積importance≥閾值  ─► 5.7 reflect
對話/會議結束        ─► 5.8 relationship 更新
```

### 5.1 感知（Perceive）
- 視野：曼哈頓距離 `R = 6` tile `[DEFAULT]`；感知其他 agent 的 `(name, title, current_status)`、`layout_items` 中 affords 非空的物件狀態、以及**自己名下 due_day 逼近的 work_items**（每日到班掃描一次）。
- 去重：同對象同狀態 `N = 12` tick 內不重複寫入 `[DEFAULT]`。
- 每筆感知 → `memories(kind='observation')` → 非同步 importance（L0）＋ embedding（L0）。

### 5.2 記憶檢索（Retrieve）— 公式同 v1

```
score(m) = w_recency * 0.995^(遊戲小時差) + w_importance * (importance/10)
         + w_relevance * (cosine+1)/2
[DEFAULT] 三權重皆 1.0（env 可調，為實驗變因）；Top-K=12；取用即更新 last_access。
```
必須有純函數版本供單元測試。

### 5.3 反應判斷（Should React?）
感知到新事件（他人靠近搭話／物件狀態變化／主管指示）→ L1 + `prompts/react.md` 判斷 `continue | converse | adjust`。被搭話強制 converse。**prompt 中必須注入雙方職級關係**（對方是你的主管/下屬/平級），但不得硬編碼「必須服從」——尊卑互動風格交給模型與記憶湧現。

### 5.4 對話（Converse）
- 觸發：距離 ≤ 2 tile、任一方 converse、雙方非 meeting 中。
- 輪流以 `prompts/converse.md` 生成，`<end/>` 或 12 輪上限 `[DEFAULT]` 結束；逐輪寫 `conversation_turns`，摘要句寫雙方 `memories(kind='dialogue')`。

### 5.5 重規劃（Re-plan）
對話/會議結束或 adjust 時，以 L2 檢視「剩餘日程＋剛發生的事＋名下 work_items」，僅重寫當前時段之後的節點。

### 5.6 每日規劃（Daily Plan）
到班時（`[DEFAULT]` 08:30–09:00 間依人設早晚）：
1. L2/L3 + `prompts/daily_plan.md` 生成 5–8 條日程；**輸入包含**：company_context、自身 grade/title/回報線、名下與協辦 work_items（含 due_day、progress）、昨日摘要、檢索記憶。
2. lazy 細化（`prompts/decompose.md`，未來 2 小時內節點，15–30 分鐘粒度）。
3. 頂層摘要入 `memories(kind='plan')`。

### 5.7 反思（Reflect）— 同 v1
- 觸發 `[DEFAULT]`：新記憶 importance 總和 ≥ 100，或每日 18:30 強制一次。
- 兩段式（questions → insights，含 ref_ids）。**不得硬編碼任何人際/職場戲劇**；一切由反思湧現。

### 5.8 關係更新 — 同 v1（`prompts/relationship.md`，輸出 affinity_delta 與 descriptor）。

### 5.9 晨會（Meeting，世界規則）★
- 09:10 引擎廣播 `meeting_call`：所有在場 agent 的當前計畫被暫停，插入「前往 meeting.table 開晨會」節點（這是**組織制度**，屬世界規則，允許引擎排程；請假/遲到由 agent 狀態自然發生）。
- 會議 = `conversations(kind='meeting')`：主持人 `[DEFAULT]` 經理（經理缺席則副總，再缺席則高級專員）先發言（`prompts/meeting.md`，輸入含所有 open/in_progress work_items 摘要），之後 round-robin 每人一輪簡短匯報，主持人可指定 2 名 follow-up 發言，總輪數上限 = 人數 + 4 `[DEFAULT]`。
- 會中若主持人輸出結構化派工標記 `<assign work_item="…" to="…"/>`，引擎更新 `work_items.owner/collaborators` 並記 `event_log(kind='work_update')`。
- 會議逐字寫 turns；每人各自寫一句摘要記憶。

### 5.10 工作進度（Work Progress）★
- 當 agent 執行綁定 work_item 的計畫節點且人在自己座位（或 meeting/cabinet 等 affords='work' 位置）時，每完成一個節點觸發一次 L1 + `prompts/work_progress.md`：輸出 `{progress_delta: 0..25, note: '一句話進度'}`。
- 引擎更新 `work_items.progress/last_note`；progress≥100 → status='review'（owner 為專員時）→ 經理下次晨會或路過時可湧現「核可」對話 → done。逾 due_day 未完 → status='overdue' 並廣播事件（觀察壓力反應）。
- 防作弊：單一 work_item 每遊戲日 progress 增幅上限 `[DEFAULT]` 40。

### 5.11 Prompt 模板（prompts/*.md 完整初版）

> `{{variable}}` 置換、熱重載。v1 的 importance / decompose / react / reflect_questions / reflect_insights / relationship 六份**沿用 v1 全文不變**（react 增加一行變數 `【職級關係】{{rank_relation}}`）。以下為新增/改版三份與 company_context：

**prompts/company_context.md**（會被前置於 daily_plan / converse / meeting / work_progress）
```
【公司背景】你任職於「晨翔航勤股份有限公司」（虛構）——機場地勤代理業者。
你所在的部門是「合約與招商部」，負責：與航空公司客戶之地勤服務合約
（依 SGHA 架構：機坪、行李、貨運郵件、旅客服務、載重平衡等附錄項目）的
議約/續約/修約；服務規範與 SLA 之制定與稽核；機場當局與航司釋出標案
（貴賓室、櫃檯代理、GSE 外包等）之標書、報價與廠商評選。
部門步調受航班季節（冬夏班表換季）、航司開航/撤站、標案截止日影響。
（本段可由 FSC 依實務經驗持續修訂。）
```

**prompts/daily_plan.md**（改版）
```
{{company_context}}
你是「{{agent_name}}」，{{grade}}，職稱：{{title}}。你的直屬主管是 {{manager_name}}。
【核心人設】{{core_identity}}
【性格特質】{{seed_traits}}
【你名下與協辦的工作項】
{{work_items_block}}   ← 每行：[W-編號|kind|title|client|priority|due第幾天|progress%]
【昨天的日程摘要】{{yesterday_summary}}
【相關記憶】
{{retrieved_memories}}
今天是模擬第 {{sim_day}} 天。請以第一人稱規劃今天日程（09:10 固定晨會已由公司安排，勿重複）。
輸出 5 到 8 條 JSON 陣列：
[{"time":"HH:MM","dur_min":整數,"what":"...","where":"位置鍵","work_item":"W-編號或null"}]
可用位置鍵：{{location_keys}}
只輸出 JSON。日程需符合你的職級職掌、工作項優先序與記憶中的約定。
```

**prompts/meeting.md**（主持人開場與各輪發言共用；以 `{{speaking_role}}` 區分）
```
{{company_context}}
你是「{{agent_name}}」（{{grade}}，{{title}}），正在 09:10 部門晨會中，角色：{{speaking_role}}。
【部門工作項現況】
{{dept_work_items_block}}
【相關記憶】
{{retrieved_memories}}
【會議目前逐字】
{{meeting_transcript}}
請說出你這一輪的發言（繁體中文、口語、30–80 字、符合職級口吻）。
主持人若要派工，於句末可加：<assign work_item="W-編號" to="姓名"/>（可多個）。
只輸出發言本身（與可選的 assign 標記）。
```

**prompts/work_progress.md**
```
{{company_context}}
你是「{{agent_name}}」（{{title}}），剛花了 {{dur_min}} 分鐘處理工作項：
[{{work_item_kind}}]{{work_item_title}}（客戶：{{client}}，目前進度 {{progress}}%）。
【相關記憶】
{{retrieved_memories}}
請輸出 JSON：{"progress_delta": 0到25的整數, "note": "一句話描述你剛完成了什麼（具體、符合地勤合約/標案實務）"}
只輸出 JSON。
```

**prompts/converse.md**（改版：加入職場語境）
```
{{company_context}}
你是「{{agent_name}}」（{{grade}}，{{title}}）。
【核心人設】{{core_identity}}
【性格特質】{{seed_traits}}
【你與 {{partner_name}}（{{partner_title}}）的關係】{{rank_relation}}；好感度 {{affinity}}/100，{{rel_descriptor}}
【相關記憶】
{{retrieved_memories}}
【目前對話】
{{dialogue_history}}
請以第一人稱說出下一句話（繁體中文、口語、簡短、符合人設與職場分寸）。
對話該自然結束時，句末加 <end/>。只輸出你要說的話。
```

---

## 6. LLM Gateway 規格（llm-gateway crate）— 承襲 v1，差異以★標示

### 6.1 分層路由表

| Tier | 用途 | `[DEFAULT]` 供應商/模型 | 逾時 | 重試 |
|---|---|---|---|---|
| L0 | embedding、importance | Ollama `mxbai-embed-large` / `qwen2.5:7b-instruct` | 15s | 2 |
| L1 | react、日常對話、work_progress ★、關係更新 | Ollama `qwen2.5:7b-instruct` | 30s | 2 |
| L2 | 每日規劃、細化、re-plan | Anthropic Haiku 級 | 60s | 2 |
| L3 | 反思、**晨會發言 ★**、關鍵對話升級 | Anthropic Sonnet 級 | 90s | 1 |

- ★★v2.1 多供應商：provider 統一抽象 `anthropic | openai | gemini | ollama | mock`，各走官方 API 直連；`pricing.toml` 收錄三家模型單價；計量與預算熔斷**跨供應商合計**。
- ★★v2.1 按 agent 指派模型：`agents.llm_profile` 可對 L1/L2/L3 逐層覆寫 tier 預設（值格式 `provider:model`）；覆寫只換供應商/型號，逾時、重試、併發、預算規則不變。L0（embedding/importance）不可覆寫——統一走本地，保成本與向量空間一致。用途：不同角色掛不同腦，做跨模型行為對照（第 11 章）。
- 關鍵對話升級 `[DEFAULT]`：對話任一方為經理/副總 ★、|affinity| ≥ 50、或檢索到 importance ≥ 8 記憶。
- 其餘行為要求同 v1：全域併發上限（雲端 ≤ 4、Ollama ≤ 2）、`DAILY_BUDGET_USD`（`[DEFAULT]` 2.0）80% 降級/100% 暫停、`llm_calls` 計量與 `pricing.toml`、`LLM_MODE=mock` 決定性回應、JSON 輸出統一防護（剝 fence → serde → 失敗重試一次 → 再失敗降級 continue）。
- ~~[DECISION-需FSC確認] 雲端是否經公司代理端點~~ → **已決（2026-07-07 FSC）：三家雲端皆官方端點直連**；未設金鑰的供應商停用並於 healthz 註記。

---

## 7. 前端與通訊協定（web + api-server）

### 7.1 畫面組成

1. **主畫布（PixiJS）**：office_shell 底圖 + DB 家具層 + 9 個 agent（4 向動畫、頭頂狀態）+ 對話/會議泡泡。
2. **時間控制列**：暫停/播放、x1/x2/x5、遊戲日與時鐘、**編輯模式切換鈕**。
3. **Agent 檢視面板**：人設、職級與回報線、**使用模型（llm_profile 覆寫與 tier 預設）★v2.1**、今日日程樹、記憶流、反思清單、名下 work_items。
4. **工作看板（Kanban）★**：work_items 按 status 分欄（open/in_progress/review/done/overdue），卡片顯示 owner、client、due、progress、last_note；即時 WS 更新。
5. **關係圖**：9 節點有向圖 + affinity；`[DEFAULT]` 依組織階層分層佈局（副總最上）。
6. **成本儀表**：同 v1。
7. **訪客留言/派工**：對指定 agent 注入一則事件（kind='event'）；或建立一筆 work_item 指派給某 owner（模擬「上頭交辦」）。

### 7.2 預設佈局（seed 規格 — `seed_world.sh` 依此寫入 layout_items）

底圖 `office_shell.tmj`：約 **48×32 tiles（32px/tile）**，含外牆、一扇大門（下緣中央）、窗（上緣）。動態層預設內容：

| 區域(zone) | 內容 | 規格 |
|---|---|---|
| `open_a` | 開放座位區 A | **4×4 = 16 個 desk 槽位**（desk 1×1 + chair walkable），排成 4 排 × 4 列，排間走道 1 tile；key `deskA-01`…`deskA-16` |
| `open_b` | 開放座位區 B | 同上 4×4 = 16 槽位；key `deskB-01`…`deskB-16` |
| `exec` | 主管隱私區 | **2 個大位**：`exec.vp`（副總）與 `exec.mgr`（經理），各為 exec_desk 2×2 + chair，三面 partition 圍出半封閉空間，位於地圖上緣 |
| `meeting` | 會議區 | meeting_table 3×2 + 8 chairs + whiteboard（晨會地點） |
| `pantry` | 茶水間 | pantry_counter 2×1（affords: coffee）——非正式互動熱點 |
| `common` | 公共 | printer 1×1（affords: print）、cabinet ×4（合約檔案櫃，affords: work）、plant ×4 |

預設座位指派：高級專員與 5 名專員坐 `open_a` 前兩排（deskA-01…06）、約聘坐 `deskA-08` `[DEFAULT]`；`open_b` 全空（供佈局實驗與擴編）。經理 `exec.mgr`、副總 `exec.vp`。

### 7.3 佈局編輯器（editor/）★ — 本版核心新功能

**進入/離開**
- 點「編輯模式」→ world.status='editing'，模擬暫停 `[DEFAULT]`，畫布覆蓋網格線。
- 「儲存」→ `PUT /api/v1/worlds/:id/layout`（整批 layout_items upsert/delete）→ 引擎重建碰撞格與尋路圖 → 所有 agent 目前路徑作廢並就地重新尋路 → status 還原 → WS 廣播 `layout_updated`。
- 「取消」→ 丟棄本地變更。

**編輯操作**
- 左側 palette：desk / exec_desk / chair / partition / meeting_table / cabinet / printer / plant / pantry_counter / whiteboard。
- 拖放置格、拖移既有物件、`R` 旋轉 90°、`Del` 刪除、框選多物件搬移。
- **座位指派**：把 agent 頭像拖到 desk/exec_desk 上 → 更新 `agents.desk_id`；一桌一人，重複指派時前者變未指派。

**驗證（不通過不得儲存，違規物件紅框提示）**
1. 物件 footprint 不得重疊、不得壓牆/門。
2. 連通性：自大門起 flood-fill，所有 chair、meeting 區、pantry、printer、cabinet 必須可達。
3. 每位 agent 必須有 desk_id（未指派者黃色警示，允許儲存但列入警告 `[DEFAULT]`）。

**歷史**：儲存時將整份佈局 JSON 快照寫入 `event_log(kind='layout_saved', payload=快照)`，供比對「佈局 × 行為」實驗（第 11 章）。

### 7.4 WebSocket 協定（`/ws`，JSON，snake_case）

Server → Client（v1 全部保留，新增★）：
```jsonc
{ "type": "world_snapshot", "world": {...}, "agents": [...], "layout": [...], "work_items": [...] }
{ "type": "tick", ... }  { "type": "agent_moved", ... }  { "type": "agent_status", ... }
{ "type": "dialogue_line", ... }  { "type": "reflection_created", ... }
{ "type": "relationship_updated", ... }  { "type": "budget", ... }  { "type": "world_paused", ... }
{ "type": "meeting_started", "conversation_id": "...", "attendees": [...] }        // ★
{ "type": "work_item_updated", "work_item": {...} }                                 // ★
{ "type": "layout_updated", "layout": [...] }                                       // ★
```

Client → Server：
```jsonc
{ "type": "control", "action": "pause"|"resume"|"set_speed"|"enter_edit"|"exit_edit" }  // ★ 編輯模式
{ "type": "inspect", "agent_id": "..." }
{ "type": "visitor_message", "agent_id": "...", "content": "..." }
{ "type": "create_work_item", "title": "...", "kind": "...", "client": "...", "owner_id": "...", "due_day": 5 } // ★
```

REST（`/api/v1`）：v1 全部保留；新增 `GET/PUT /worlds/:id/layout`、`GET /worlds/:id/work_items`、`POST /worlds`（實驗參數含佈局快照選用）。

---

## 8. 實作階段（Phase 0–4：任務與驗收標準）

> 一個 Phase 一個分支（`phase/0-bootstrap` …），完成後自我核對驗收清單並記入 `docs/CLAUDE.md` 再合併。

### Phase 0 — 環境與骨架（約 0.5–1 人週）

任務：
- T0.1 目錄骨架、Rust workspace、Next.js、`justfile`、`scripts/ci.sh`。
- T0.2 docker-compose：postgres(+pgvector)/engine/web；engine 經 `host.docker.internal` 連 Ollama。
- T0.3 migration `001_init.sql`（第 4 章）＋ `seed_world.sh`：灌入附錄 A 的 9 名 agent、7.2 預設佈局、附錄 A.3 的 6 筆種子 work_items。
- T0.4 llm-gateway 最小可用（含 mock、計量；anthropic/openai/gemini/ollama 四 provider 最小 chat 通路＋llm_profile 覆寫掛點）。
- T0.5 驗證 Ollama 模型已就緒（未就緒則輸出安裝指令請 FSC 執行）。

驗收：
- [ ] `docker compose up` 後 `GET /api/v1/healthz` 回報 DB 與 Ollama 皆 ok。
- [ ] `just test` 通過；`llm_calls` 可記錄一次 Ollama 與雲端三家（Anthropic/OpenAI/Gemini，未設金鑰者以 mock 代）各一次呼叫。
- [ ] seed 後 `layout_items` 恰有：desk×32、exec_desk×2、chair 對應數、meeting_table×1、其餘如 7.2 表。

### Phase 1 — 辦公室世界與渲染（約 1 人週）

任務：
- T1.1 Tiled 製作 `office_shell.tmj`（僅牆/地板/門/窗，48×32）。
- T1.2 sim-core：底圖 + layout_items 合成碰撞格 → A*（4 向）→ tick loop（pause/resume/speed）。
- T1.3 api-server：`/ws` 廣播 snapshot/tick/agent_moved/agent_status。
- T1.4 web：渲染底圖＋動態家具層＋9 角色動畫；時間控制列。
- T1.5 通勤腳本：07:00–09:00 依人設時間從大門進場、走到自己座位坐下（尚無 LLM 認知）。

驗收：
- [ ] 9 名角色能從大門走到各自座位，不穿家具、不互卡。
- [ ] 暫停/加速即時生效；重整頁面 snapshot 正確還原（含家具層）。
- [ ] 尋路 golden test 通過（固定佈局＋起訖點 → 固定路徑）。

### Phase 2 — 認知核心與工作模型（約 2–3 人週，最關鍵）

任務：
- T2.1 記憶管線（perceive→去重→importance→embedding→入庫）。
- T2.2 檢索模組（5.2 純函數 + pgvector 組合）。
- T2.3 每日規劃 + lazy 細化（含 work_items 注入）；plans 執行驅動移動與狀態。
- T2.4 react + 對話迴圈；conversation 落庫；WS dialogue_line。
- T2.5 **晨會機制（5.9）**：meeting_call、round-robin、`<assign/>` 解析與派工落庫。
- T2.6 **work_progress（5.10）**：進度推進、review/done/overdue 狀態機、日增幅上限。
- T2.7 反思（5.7）＋ 關係更新（5.8）。
- T2.8 prompts 熱重載；JSON 防護統一流程。

驗收：
- [ ] mock + 同 seed 跑 3 遊戲日兩次，event_log 雜湊一致（S6）。
- [ ] 真實模式 1 遊戲日：每 agent 有日程；晨會發生且逐字入庫；至少 1 筆 work_item progress 前進；至少 1 場自發對話；至少 1 條 reflection。
- [ ] 抽查 3 名 agent 日程與職級職掌一致（S2 抽樣，記錄於 CLAUDE.md）。
- [ ] `<assign/>` 派工後，被指派者**下一次** daily_plan/re-plan 中出現對應工作節點。

### Phase 3 — 佈局編輯器與觀測面板（約 1.5–2 人週）

任務：
- T3.1 **佈局編輯器（7.3 全功能）**：palette、拖放/旋轉/刪除/框選、座位指派、三項驗證、儲存/取消、layout_saved 快照。
- T3.2 引擎側：`PUT /layout` 後碰撞重建 + 全員重新尋路（S7）。
- T3.3 Agent 檢視面板、關係圖（階層佈局）、**工作看板 Kanban**。
- T3.4 成本儀表＋預算熔斷 UI；事件日誌檢視器＋湧現事件人工標記。
- T3.5 訪客留言/派工注入（7.1-7）。
- T3.6 `[DECISION-需FSC確認]`：UI 是否加日文切換（Groovenauts demo）——i18n key 已備妥，此任務僅補譯文。

驗收：
- [ ] S7 整合測試：程式化執行「搬移 open_b 一排桌到走道上（製造阻斷）→ 驗證拒絕儲存」與「合法搬移 → 儲存 → 行走中 agent 重新尋路到達目的地」。
- [ ] 座位指派拖放後 agents.desk_id 正確、原座位釋放。
- [ ] S4 全數可於 UI 完成；成本報表與 llm_calls 加總一致（S5）。

### Phase 4 — 實驗化與調參（持續迭代）

任務：
- T4.1 `POST /worlds` 實驗參數：seed、檢索權重、反思閾值、tier 模型組合、**各 agent llm_profile ★v2.1**、**初始佈局快照**。
- T4.2 `docs/experiments.md`：至少 3 組對照實驗（見第 11 章表格挑選）。
- T4.3 匯出工具：world 全事件時間軸 + 佈局快照 JSON 一鍵匯出。

驗收：
- [ ] 兩個不同佈局/參數的 world 可並存輪流執行；報表可跨 world 比較互動頻率、work 完成量、成本。

---

## 9. 素材資產與授權（法遵注意）

| 資產 | 來源 | 授權 | 用途 | 注意 |
|---|---|---|---|---|
| **Modern Office**（首選）/ Modern Interiors | LimeZu（itch.io） | 免費層可測試；完整版付費，**素材原檔不得再散布** | 辦公桌椅、隔屏、影印機、會議桌、茶水間 tileset | repo 不含付費原檔；`assets/README.md` 說明購買與放置路徑 |
| Ninja Adventure Asset Pack | Pixel-Boy & AAA（itch.io） | CC0 | 備用角色/物件 | 可直接入 repo |
| Kenney 各系列 | kenney.nl | CC0 | UI icon、補充家具 | 可直接入 repo |
| Universal LPC Spritesheet Generator | GitHub 開源工具 | 產出多為 CC-BY-SA 3.0 / GPL 3.0 | 產 9 個角色 4 向行走圖（含西裝/制服風格） | 署名+相同方式分享義務：`assets/CREDITS.md` 逐項登記 |
| Tiled Map Editor | mapeditor.org | GPL（工具） | office_shell 底圖 | 不影響輸出檔 |

規則：新素材加入前先登記 `assets/CREDITS.md`（名稱/作者/連結/授權/義務）。`[DEFAULT]` v2 用 CC0 + LimeZu 免費層。

---

## 10. 測試計畫

### 10.1 單元測試
- 檢索評分純函數；A* golden path；prompt 置換 fail-fast；JSON 防護（剝 fence、重試路徑）；
- ★ 佈局驗證器：重疊偵測、flood-fill 連通性、座位指派唯一性。
- ★ `<assign/>` 解析器：合法/非法標記、多重標記。
- ★ work_items 狀態機：progress 上限、review→done、overdue 轉換。

### 10.2 決定性回放（golden replay）
`LLM_MODE=mock` + 固定 seed 跑 3 遊戲日 → event_log 雜湊比對 golden；引擎變更導致雜湊改變須在 PR 說明並更新 golden。

### 10.3 整合測試
compose 起全套 → 健康檢查 → mock 跑 300 tick（涵蓋一次晨會）→ 斷言：無 error 事件、每 agent 記憶>0、meeting_started 出現、WS 收到 work_item_updated；★ 佈局往返測試（Phase 3 驗收第一項自動化）。

### 10.4 品質評估（半自動）
`scripts/eval_day.sh`：抽指定 world/day 的日程、晨會逐字、work notes → 產人工評分表；FSC 依 S2/S3 與**產業真實度**（用語、流程是否像真的地勤合約部門）評分，回填 `docs/eval/`。真實度不足時優先修 `prompts/company_context.md` 與人設，而非改程式。

---

## 11. 觀測與實驗設計（以真實職場問題為導向）

| 研究問題 | 操作變因 | 觀測指標 |
|---|---|---|
| **佈局如何影響互動？**（本版主打） | 同 seed 下比較：預設佈局 vs 加高隔屏 vs 兩區合併 vs 茶水間移位 | 自發對話次數/日、跨區對話比例、pantry 停留時間、work 完成量 |
| 層級如何影響資訊流？ | 開/關晨會；副總座位移入開放區 | 訊息從專員→副總的傳遞跳數與延遲（以「訪客留言注入一則消息」追蹤擴散） |
| 截止日壓力下的協作 | 注入一筆 due_day=+2、priority=1 的大標案 | 加班湧現率、主動求援對話、overdue 率、reflection 內容變化 |
| 約聘與正職的融入動態 | 約聘座位靠近 vs 遠離團隊 | 約聘的對話參與度、affinity 成長曲線（僅作組織行為觀察，禁止延伸為對真實個人的評價） |
| Reflection 必要性 / 檢索權重掃描 / 本地 vs 雲端 | 同 v1 三組 | 同 v1 指標 + 產業真實度評分 |

結果沉澱 `docs/experiments.md`：假設 → 設定 → 數據 → 結論 → **對真實辦公室/對 KWAY 內部平台的啟示**。

---

## 12. 風險與開放問題

| # | 風險/問題 | 等級 | 對策 |
|---|---|---|---|
| R1 | 9 agent + 晨會集中呼叫使 Mac Mini/預算吃緊 | 中 | 晨會序列化處理（round-robin 本身即序列）；6 章併發上限；tick 降速 |
| R2 | LLM JSON/標記輸出不穩 | 高 | 統一防護＋失敗降級 continue；`<assign/>` 解析失敗僅記 log 不派工 |
| R3 | 雲端成本失控 | 中 | 預算熔斷＋逐日報表（S5） |
| R4 | 素材授權踩雷 | 中 | 第 9 章規則；repo 不含付費素材 |
| R5 | 內容影射真實公司/同事 | 高 | 卷首虛構聲明；seed 與測試資料審查（人名/航司名一律虛構）；eval 流程檢核 |
| R6 | 佈局編輯造成引擎狀態不一致（編輯中 tick 續跑） | 中 | 編輯模式強制暫停 `[DEFAULT]`；儲存為單一交易；失敗回滾 |
| Q1 | ~~雲端是否經公司代理端點？~~ **已決（2026-07-07 FSC）**：Anthropic/OpenAI/Gemini 三家皆官方端點直連 | — | 已結案（第 6 章 ★★v2.1、ADR-001） |
| Q2 | `[DECISION-需FSC確認]` UI 日文切換（Groovenauts demo）？ | — | Phase 3 前確認 |
| Q3 | `[DECISION-需FSC確認]` `docs/domain/ground_handling.md` 由 FSC 撰寫的實務備忘，是否允許節錄進 company_context？ | — | Phase 2 前確認（涉及真實度 vs 資訊揭露的取捨） |

---

## 附錄 A — Seed 資料

### A.1 九位 Agent 初始人設（全數虛構）

> 寫入 `agents`。**不得**硬編碼任何人際事件；社會動態必須由認知循環湧現。姓名/性格為虛構，職掌設計參考航空地勤合約部門的真實分工。

| 名字 | grade | title（職稱） | reports_to | 預設座位 | seed_traits（節錄） |
|---|---|---|---|---|---|
| 方以寧 | 副總 | 合約與招商部 副總經理 | — | exec.vp | 決斷、重視客戶關係、慣於抓大放小、對數字敏銳 |
| 高子軒 | 經理 | 部門經理 | 方以寧 | exec.mgr | 溫和但要求交期、晨會控場者、習慣走動管理 |
| 沈書萍 | 高級專員 | 資深合約專員（SGHA/SLA 規範） | 高子軒 | deskA-01 | 嚴謹、部門活字典、樂於帶新人、討厭格式錯誤 |
| 郭立衡 | 專員 | 合約專員（機坪與行李作業） | 高子軒 | deskA-02 | 務實、外場出身、說話直接、午休固定散步 |
| 曾若彤 | 專員 | 合約專員（貨運與郵件） | 高子軒 | deskA-03 | 細心、報表控、下午效率最高、容易加班 |
| 韓致遠 | 專員 | 合約專員（旅客服務與貴賓室） | 高子軒 | deskA-04 | 外向、擅簡報、標案提案的門面、偶爾拖交期 |
| 廖苡安 | 專員 | 合約專員（GSE 與外包管理） | 高子軒 | deskA-05 | 冷靜、談判型、對供應商條款錙銖必較 |
| 江秉倫 | 專員 | 合約專員（報價與法遵檢核） | 高子軒 | deskA-06 | 內向、數字精準、怕開會、茶水間咖啡重度使用者 |
| 阮曉青 | 約聘 | 標案行政支援（文件管理） | 沈書萍(業務指導)/高子軒 | deskA-08 | 新到職、學習快、對制度不熟、渴望轉正 |

初始 relationships：同事間 affinity=0、descriptor='同部門同事'；對直屬主管 descriptor='我的主管'。

### A.2 通勤與作息 seed（daily_plan 的先驗，非硬性）
副總 08:20 到、經理 08:30、高級專員 08:40、專員 08:40–08:55 錯開、約聘 08:30（新人早到）。此僅作為第 1 日 prompt 提示，之後由各自規劃湧現。

### A.3 六筆種子 work_items（客戶名全虛構）

| kind | title | client | owner | priority | due(第幾天) |
|---|---|---|---|---|---|
| contract_renewal | 星海航空 台北站地勤服務合約續約（SGHA 附錄B更新） | 星海航空 | 沈書萍 | 2 | 6 |
| tender | 桃機貴賓室經營權投標案—服務建議書 | 機場當局 | 韓致遠 | 1 | 4 |
| quotation | 北風航空 冬季班表新增航班保障報價 | 北風航空 | 江秉倫 | 2 | 3 |
| sla_audit | 年度 SLA 稽核—行李運送 KPI 追蹤 | 內部 | 郭立衡 | 3 | 8 |
| contract_renewal | 貨站郵件處理外包合約修約 | 雲嶺物流 | 曾若彤 | 3 | 7 |
| tender | GSE 維護外包廠商評選—評分表建置 | 內部 | 廖苡安 | 2 | 5 |

（阮曉青為 tender 兩案之 collaborator；方以寧為所有 tender 之 collaborator。）

## 附錄 B — 參考資料

1. Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*, UIST '23（記憶流/反思/規劃架構原典）。
2. GitHub: `joonspk-research/generative_agents`｜`a16z-infra/ai-town`（Docker/Ollama 自架參照）｜`google-deepmind/concordia`。
3. GitHub: `pixel-agents-hq/pixel-agents` — 像素辦公室視覺化 dev agent 的直接參照（座位=工作指派的互動隱喻）。
4. GitHub: `danielrosehill/AI-Synthetic-Society-Experiments` — 合成社會實驗索引。
5. IATA SGHA（Standard Ground Handling Agreement）公開架構——僅作 work_items 命名與 company_context 之背景參考，不重製其條文內容。
6. 林亦LYi《我讓六個AI合租，居然出了個海王？》— 專案敘事原型。

---
*本文件由 FSC 與 Claude 共同制定（v2.0 取代 v1.0）。規格變更請以 PR 修改本文件並於 `docs/decisions/` 留存 ADR。*

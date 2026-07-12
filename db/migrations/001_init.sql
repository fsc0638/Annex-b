-- 001_init.sql
--
-- Initial schema per spec section 4 (AI辦公室-航空地勤-開發實作規格書-v2.md).
-- Rule (spec): every table gets `created_at timestamptz not null default
-- now()` even where not explicitly listed in the DDL block; table/column
-- semantics from the spec must not be altered, only appended to.
--
-- Differences from v1 are marked with the spec's own "★" annotations in
-- comments, carried over verbatim from the spec text where present.

create extension if not exists vector;
-- Note: gen_random_uuid() is a PostgreSQL core builtin since PG13 (no
-- pgcrypto extension required); target is pgvector/pgvector:pg16.

create table worlds (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  seed          bigint not null,
  sim_day       int  not null default 1,
  sim_clock_sec int  not null default 25200,   -- ★ 07:00 開局
  tick_ms       int  not null default 1000,
  sec_per_tick  int  not null default 10,
  status        text not null default 'paused', -- paused | running | editing ★ | archived
  map_tmj       jsonb,              -- ★★ADR-002 D2：編輯器 PUT 過的地圖 TMJ，nullable（null＝沿用檔案系統的 office_shell.tmj）
  created_at    timestamptz not null default now()
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
  reply_style    text,               -- ★★ADR-002 D5：回覆方式（語氣/口吻），nullable
  current_status text not null default 'commuting',
  pos_x          int  not null,
  pos_y          int  not null,
  desk_id        uuid,               -- ★ 指派座位（layout_items.id），可為 null
  llm_profile    jsonb not null default '{}', -- ★★v2.1 按角色指派模型，如 {"L1":"openai:gpt-4o-mini","L3":"gemini:gemini-2.5-pro"}；空物件＝走第6章 tier 預設
  appearance     jsonb,              -- ★★ADR-003 D3：角色外觀分層選擇，如 {"body":"body-01","eyes":"eyes-03","hairstyle":"hairstyle-01-01","outfit":"outfit-05-02","accessory":null}；nullable，null＝沿用程式產生的佔位 sprite
  created_at     timestamptz not null default now()
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
  meta       jsonb not null default '{}',    -- 例：desk 的朝向、槽位編號
  created_at timestamptz not null default now()
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
  last_note     text,                            -- 最近一句進度（LLM 生成）
  created_at    timestamptz not null default now()
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
  ref_ids      uuid[] default '{}',
  created_at   timestamptz not null default now()
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
  status      text not null default 'pending',
  created_at  timestamptz not null default now()
);

create table conversations (
  id        uuid primary key default gen_random_uuid(),
  world_id  uuid not null references worlds(id),
  kind      text not null default 'chat',   -- ★ chat | meeting
  sim_day   int not null,
  started_sec int not null,
  ended_sec   int,
  location  text,
  created_at timestamptz not null default now()
);
create table conversation_turns (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  speaker_id      uuid not null references agents(id),
  seq             int not null,
  content         text not null,
  created_at      timestamptz not null default now()
);

create table relationships (
  agent_id    uuid not null references agents(id),
  target_id   uuid not null references agents(id),
  affinity    real not null default 0,
  descriptor  text not null default '同部門同事',
  updated_day int not null default 1,
  created_at  timestamptz not null default now(),
  primary key (agent_id, target_id)
);

create table event_log (
  id        bigserial primary key,
  world_id  uuid not null references worlds(id),
  sim_day   int not null,
  sim_clock_sec int not null,
  kind      text not null,   -- tick_error | conversation | meeting | reflection | emergent
                             -- | layout_saved ★ | work_update ★ | budget_degraded | llm_call
  payload   jsonb not null,
  created_at timestamptz not null default now()
);

create table llm_calls (
  id          bigserial primary key,
  world_id    uuid, agent_id uuid,
  tier        text not null, provider text not null, model text not null,
  purpose     text not null,
  input_tokens int, output_tokens int,
  cost_usd    numeric(10,6) default 0,
  latency_ms  int, ok boolean not null,
  created_at  timestamptz not null default now()
);

-- Major #3 fix (docs/eval/p0-review.md): agents.desk_id had no FK to
-- layout_items(id) — nothing prevented it from pointing at a nonexistent
-- row or a row of the wrong kind. Declared here via alter table (not
-- inline on the `agents` column above) because layout_items is defined
-- *after* agents in this file and Postgres requires the referenced table
-- to exist first; `on delete set null` means a deleted seat automatically
-- un-assigns its occupant rather than leaving a dangling id, matching the
-- spec 7.3 "重複指派時前者變未指派" un-assignment spirit for the deletion
-- case. Note: this constraint only enforces that desk_id points at *some*
-- real layout_items row — it does NOT enforce that the referenced
-- layout_items row belongs to the same world_id as the agent (Postgres
-- has no native cross-row-same-table-different-column FK for that
-- without a trigger); same-world consistency between an agent and its
-- assigned desk is maintained by the application layer (the layout
-- editor, spec 7.3) rather than the DB schema.
alter table agents
  add constraint agents_desk_id_fkey
  foreign key (desk_id) references layout_items(id) on delete set null;

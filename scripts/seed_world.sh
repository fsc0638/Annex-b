#!/usr/bin/env bash
#
# seed_world.sh — populate a world with the Appendix A seed data:
#   - 1 world
#   - 9 agents (Appendix A.1)
#   - 7.2 default layout (94 layout_items: desk x32, exec_desk x2,
#     chair x42, partition x6, meeting_table x1, whiteboard x1,
#     pantry_counter x1, printer x1, cabinet x4, plant x4)
#   - agents.desk_id seat assignment (7.2 default assignment)
#   - 6 work_items (Appendix A.3) with collaborators
#   - 20 knowledge memories (company_context draft v2, layer 3), with
#     Ollama-generated embeddings when available (NULL + WARN otherwise)
#
# Usage:
#   scripts/seed_world.sh                # full seed (idempotent-ish via
#                                         # unique world name; re-running
#                                         # creates a NEW world row)
#   scripts/seed_world.sh --knowledge-only
#                                         # replace (delete + reseed) all
#                                         # knowledge memories for the most
#                                         # recently seeded world; does not
#                                         # touch agents, layout, or
#                                         # work_items
#
# WARNING (id-churn on --knowledge-only): this is delete-then-reinsert,
# NOT an upsert — every re-run assigns brand-new `id`/`created_at`/
# `last_access` values to every knowledge memory row, even ones whose
# content didn't change. Anything that referenced a knowledge memory's old
# `id` (e.g. another memory's `ref_ids`, or an `event_log` payload) will
# silently dangle after a re-run. Do not run this flag against a world
# with data that references specific knowledge-memory ids by value.
#
# Requires: psql reachable via $DATABASE_URL (compose environment is the
# reference target per project instructions; this script is not expected
# to run on a machine without psql/DB access).
#
# Env:
#   DATABASE_URL   postgres connection string (required)
#   OLLAMA_BASE_URL  default http://localhost:11434 (used for embeddings)
#   EMBED_MODEL      default mxbai-embed-large

set -euo pipefail

KNOWLEDGE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --knowledge-only)
      KNOWLEDGE_ONLY=1
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "Usage: $0 [--knowledge-only]" >&2
      exit 1
      ;;
  esac
done

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set. This script must run where the DB is reachable (compose environment)." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found on PATH. Run this script inside the compose environment (engine container) where psql is available." >&2
  exit 1
fi

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
EMBED_MODEL="${EMBED_MODEL:-mxbai-embed-large}"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)

echo "== seed_world.sh starting (knowledge_only=${KNOWLEDGE_ONLY}) =="

# ---------------------------------------------------------------------
# Ollama reachability probe (for embeddings). Not fatal if unreachable —
# knowledge rows are written with embedding=NULL and a WARN is printed,
# per project instruction ("embedding 需 Ollama，偵測不到就留 NULL 並印 WARN").
# ---------------------------------------------------------------------
OLLAMA_AVAILABLE=0
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 3 "${OLLAMA_BASE_URL%/}/api/tags" >/dev/null 2>&1; then
    OLLAMA_AVAILABLE=1
  fi
else
  echo "WARN: curl not found; cannot probe Ollama. Embeddings will be NULL." >&2
fi

if [ "$OLLAMA_AVAILABLE" -eq 0 ]; then
  echo "WARN: Ollama not reachable at ${OLLAMA_BASE_URL} (or curl missing) — knowledge memories will be seeded with embedding=NULL." >&2
fi

# Fetches an embedding vector for the given text from Ollama, printing it
# as a Postgres vector literal e.g. "[0.1,0.2,...]" on stdout. Prints
# nothing (empty string) and returns nonzero if unavailable/failed — the
# caller falls back to NULL.
fetch_embedding() {
  local text="$1"
  if [ "$OLLAMA_AVAILABLE" -eq 0 ]; then
    return 1
  fi
  local payload
  payload=$(python3 -c '
import json, sys
print(json.dumps({"model": sys.argv[1], "prompt": sys.argv[2]}))
' "$EMBED_MODEL" "$text")
  local response
  if ! response=$(curl -fsS -m 15 -X POST "${OLLAMA_BASE_URL%/}/api/embeddings" \
        -H "Content-Type: application/json" -d "$payload" 2>/dev/null); then
    return 1
  fi
  python3 -c '
import json, sys
try:
    data = json.loads(sys.argv[1])
    vec = data["embedding"]
    print("[" + ",".join(repr(float(x)) for x in vec) + "]")
except Exception:
    sys.exit(1)
' "$response"
}

# ---------------------------------------------------------------------
# Knowledge-only mode: locate the most recently created world, then only
# run the knowledge replace/reseed block against it.
# ---------------------------------------------------------------------
if [ "$KNOWLEDGE_ONLY" -eq 1 ]; then
  WORLD_ID=$("${PSQL[@]}" -t -A -c "select id from worlds order by created_at desc limit 1;")
  WORLD_ID="$(echo "$WORLD_ID" | tr -d '[:space:]')"
  if [ -z "$WORLD_ID" ]; then
    echo "ERROR: --knowledge-only requires an existing world; none found. Run a full seed first." >&2
    exit 1
  fi
  echo "== --knowledge-only: targeting most recent world $WORLD_ID =="
else
  echo "== full seed: creating world + agents + layout + work_items =="

  # World + 9 agents + desk assignment + initial relationships.
  # Agent UUIDs are resolved via CTEs (agents_ins) so reports_to and
  # relationships can reference each other without round-tripping through
  # bash — this keeps the whole agent graph in one transaction.
  "${PSQL[@]}" <<'SQL'
begin;

with new_world as (
  insert into worlds (name, seed, sim_day, sim_clock_sec, status)
  values ('晨翔航勤 — 合約與招商部（seed）', 20260707, 1, 25200, 'paused')
  returning id
),
-- Insert the 5 agents with no reports_to dependency issue first is not
-- possible in plain SQL without staging, since reports_to is intra-table
-- self-referencing. Strategy: insert VP first (reports_to=null), then
-- each subsequent tier referencing the previous tier's id via a scalar
-- subquery on agents.name (name is unique within this seed by
-- construction — Appendix A.1 has 9 distinct Chinese names).
vp as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select id, '方以寧', 'agent_fangyining', '副總', '合約與招商部 副總經理', null,
    '我是方以寧，合約與招商部副總經理。我在晨翔航勤股份有限公司服務多年，一手帶起這個部門與主要航司客戶的長期關係。我做事決斷、重視客戶關係，習慣抓大放小、把細節放手給經理與專員，但對數字始終敏銳——報價底線、年度總量、成本結構，我心裡都有一把尺。我通常08:20到公司。',
    '決斷、重視客戶關係、慣於抓大放小、對數字敏銳',
    'commuting', 0, 0, '{}'::jsonb
  from new_world
  returning id, name
),
mgr as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '高子軒', 'agent_gaozixuan', '經理', '部門經理', vp.id,
    '我是高子軒，合約與招商部經理，直屬主管是副總方以寧。我個性溫和但要求交期，習慣走動管理，常在座位區之間走動了解進度。部門的09:10晨會由我主持——除非我請假或臨時外出，才會由副總或資深專員代為主持。我通常08:30到公司。',
    '溫和但要求交期、晨會控場者、習慣走動管理',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, vp
  returning id, name
),
specialist_senior as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '沈書萍', 'agent_shenshuping', '高級專員', '資深合約專員（SGHA/SLA 規範）', mgr.id,
    '我是沈書萍，高級專員，負責SGHA架構與SLA規範相關的合約事務，直屬主管是經理高子軒。同事都說我是部門活字典——條款來龍去脈、歷年版本異動，我大多記得。我做事嚴謹，討厭格式錯誤，也樂於帶新人，包括業務指導約聘同仁阮曉青的標案行政工作。我通常08:40到公司。',
    '嚴謹、部門活字典、樂於帶新人、討厭格式錯誤',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, mgr
  returning id, name
),
specialist_02 as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '郭立衡', 'agent_guolihang', '專員', '合約專員（機坪與行李作業）', mgr.id,
    '我是郭立衡，專員，負責機坪與行李作業相關的合約事務，直屬主管是經理高子軒。我外場出身，做事務實、說話直接，不喜歡拐彎抹角。午休我習慣固定出去散步透透氣。我通常08:40到08:55之間到公司，跟其他專員錯開。',
    '務實、外場出身、說話直接、午休固定散步',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, mgr
  returning id, name
),
specialist_03 as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '曾若彤', 'agent_zengruotong', '專員', '合約專員（貨運與郵件）', mgr.id,
    '我是曾若彤，專員，負責貨運與郵件相關的合約事務，直屬主管是經理高子軒。我個性細心，是不折不扣的報表控，下午通常是我效率最高的時段，也因此容易不小心加班。我通常08:40到08:55之間到公司，跟其他專員錯開。',
    '細心、報表控、下午效率最高、容易加班',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, mgr
  returning id, name
),
specialist_04 as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '韓致遠', 'agent_hanzhiyuan', '專員', '合約專員（旅客服務與貴賓室）', mgr.id,
    '我是韓致遠，專員，負責旅客服務與貴賓室相關的合約事務，直屬主管是經理高子軒。我個性外向、擅長簡報，常是標案提案的門面人物，不過偶爾會拖到交期，得提醒自己。我通常08:40到08:55之間到公司，跟其他專員錯開。',
    '外向、擅簡報、標案提案的門面、偶爾拖交期',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, mgr
  returning id, name
),
specialist_05 as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '廖苡安', 'agent_liaoyian', '專員', '合約專員（GSE 與外包管理）', mgr.id,
    '我是廖苡安，專員，負責GSE（地面支援設備）與外包管理相關的合約事務，直屬主管是經理高子軒。我個性冷靜，是談判型的人，對供應商條款錙銖必較，不輕易讓步。我通常08:40到08:55之間到公司，跟其他專員錯開。',
    '冷靜、談判型、對供應商條款錙銖必較',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, mgr
  returning id, name
),
specialist_06 as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '江秉倫', 'agent_jiangbinglun', '專員', '合約專員（報價與法遵檢核）', mgr.id,
    '我是江秉倫，專員，負責報價與法遵檢核相關的合約事務，直屬主管是經理高子軒。我個性內向，數字精準，最怕開會，是茶水間咖啡的重度使用者。部門慣例，報價單一律先經我法遵檢核，再由經理複核。我通常08:40到08:55之間到公司，跟其他專員錯開。',
    '內向、數字精準、怕開會、茶水間咖啡重度使用者',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, mgr
  returning id, name
),
temp_staff as (
  insert into agents (
    world_id, name, sprite_key, grade, title, reports_to,
    core_identity, seed_traits, current_status, pos_x, pos_y, llm_profile
  )
  select w.id, '阮曉青', 'agent_ruanxiaoqing', '約聘', '標案行政支援（文件管理）', mgr.id,
    '我是阮曉青，約聘人員，負責標案行政支援與文件管理，正式回報線是經理高子軒，業務上則由高級專員沈書萍指導。我剛到職不久，學習很快，但對部門制度還不算熟，也渴望有一天能轉正。我通常08:30到公司——新人早到準備。',
    '新到職、學習快、對制度不熟、渴望轉正',
    'commuting', 0, 0, '{}'::jsonb
  from new_world w, mgr
  returning id, name
),
all_agents as (
  select id, name, '副總'::text as grade from vp
  union all select id, name, '經理' from mgr
  union all select id, name, '高級專員' from specialist_senior
  union all select id, name, '專員' from specialist_02
  union all select id, name, '專員' from specialist_03
  union all select id, name, '專員' from specialist_04
  union all select id, name, '專員' from specialist_05
  union all select id, name, '專員' from specialist_06
  union all select id, name, '約聘' from temp_staff
),
-- Layout items (7.2 default layout — 94 rows: desk x32, exec_desk x2,
-- chair x42, partition x6, meeting_table x1, whiteboard x1,
-- pantry_counter x1, printer x1, cabinet x4, plant x4).
layout_ins as (
  insert into layout_items (world_id, kind, key, name, pos_x, pos_y, w, h, rotation, zone, walkable, affords)
  select w.id, v.kind, v.key, v.name, v.pos_x, v.pos_y, v.w, v.h, v.rotation, v.zone, v.walkable, v.affords
  from new_world w, (values
    ('exec_desk', 'exec.vp', '副總辦公桌', 2, 2, 2, 2, 0, 'exec', false, ARRAY['work']),
    ('chair', 'exec.vp-chair', '副總座椅', 2, 4, 1, 1, 0, 'exec', true, '{}'),
    ('partition', 'exec.vp-partition-left', '副總隔屏(左)', 1, 2, 1, 3, 0, 'exec', false, '{}'),
    ('partition', 'exec.vp-partition-top', '副總隔屏(上)', 1, 1, 4, 1, 0, 'exec', false, '{}'),
    ('partition', 'exec.vp-partition-right', '副總隔屏(右)', 4, 2, 1, 3, 0, 'exec', false, '{}'),
    ('exec_desk', 'exec.mgr', '經理辦公桌', 9, 2, 2, 2, 0, 'exec', false, ARRAY['work']),
    ('chair', 'exec.mgr-chair', '經理座椅', 9, 4, 1, 1, 0, 'exec', true, '{}'),
    ('partition', 'exec.mgr-partition-left', '經理隔屏(左)', 8, 2, 1, 3, 0, 'exec', false, '{}'),
    ('partition', 'exec.mgr-partition-top', '經理隔屏(上)', 8, 1, 4, 1, 0, 'exec', false, '{}'),
    ('partition', 'exec.mgr-partition-right', '經理隔屏(右)', 11, 2, 1, 3, 0, 'exec', false, '{}'),
    ('desk', 'deskA-01', '辦公桌 A-01', 2, 7, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-01-chair', '座椅 A-01', 2, 8, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-02', '辦公桌 A-02', 4, 7, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-02-chair', '座椅 A-02', 4, 8, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-03', '辦公桌 A-03', 6, 7, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-03-chair', '座椅 A-03', 6, 8, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-04', '辦公桌 A-04', 8, 7, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-04-chair', '座椅 A-04', 8, 8, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-05', '辦公桌 A-05', 2, 10, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-05-chair', '座椅 A-05', 2, 11, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-06', '辦公桌 A-06', 4, 10, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-06-chair', '座椅 A-06', 4, 11, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-07', '辦公桌 A-07', 6, 10, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-07-chair', '座椅 A-07', 6, 11, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-08', '辦公桌 A-08', 8, 10, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-08-chair', '座椅 A-08', 8, 11, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-09', '辦公桌 A-09', 2, 13, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-09-chair', '座椅 A-09', 2, 14, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-10', '辦公桌 A-10', 4, 13, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-10-chair', '座椅 A-10', 4, 14, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-11', '辦公桌 A-11', 6, 13, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-11-chair', '座椅 A-11', 6, 14, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-12', '辦公桌 A-12', 8, 13, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-12-chair', '座椅 A-12', 8, 14, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-13', '辦公桌 A-13', 2, 16, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-13-chair', '座椅 A-13', 2, 17, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-14', '辦公桌 A-14', 4, 16, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-14-chair', '座椅 A-14', 4, 17, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-15', '辦公桌 A-15', 6, 16, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-15-chair', '座椅 A-15', 6, 17, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskA-16', '辦公桌 A-16', 8, 16, 1, 1, 0, 'open_a', false, ARRAY['work']),
    ('chair', 'deskA-16-chair', '座椅 A-16', 8, 17, 1, 1, 0, 'open_a', true, '{}'),
    ('desk', 'deskB-01', '辦公桌 B-01', 26, 7, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-01-chair', '座椅 B-01', 26, 8, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-02', '辦公桌 B-02', 28, 7, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-02-chair', '座椅 B-02', 28, 8, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-03', '辦公桌 B-03', 30, 7, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-03-chair', '座椅 B-03', 30, 8, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-04', '辦公桌 B-04', 32, 7, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-04-chair', '座椅 B-04', 32, 8, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-05', '辦公桌 B-05', 26, 10, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-05-chair', '座椅 B-05', 26, 11, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-06', '辦公桌 B-06', 28, 10, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-06-chair', '座椅 B-06', 28, 11, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-07', '辦公桌 B-07', 30, 10, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-07-chair', '座椅 B-07', 30, 11, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-08', '辦公桌 B-08', 32, 10, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-08-chair', '座椅 B-08', 32, 11, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-09', '辦公桌 B-09', 26, 13, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-09-chair', '座椅 B-09', 26, 14, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-10', '辦公桌 B-10', 28, 13, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-10-chair', '座椅 B-10', 28, 14, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-11', '辦公桌 B-11', 30, 13, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-11-chair', '座椅 B-11', 30, 14, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-12', '辦公桌 B-12', 32, 13, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-12-chair', '座椅 B-12', 32, 14, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-13', '辦公桌 B-13', 26, 16, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-13-chair', '座椅 B-13', 26, 17, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-14', '辦公桌 B-14', 28, 16, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-14-chair', '座椅 B-14', 28, 17, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-15', '辦公桌 B-15', 30, 16, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-15-chair', '座椅 B-15', 30, 17, 1, 1, 0, 'open_b', true, '{}'),
    ('desk', 'deskB-16', '辦公桌 B-16', 32, 16, 1, 1, 0, 'open_b', false, ARRAY['work']),
    ('chair', 'deskB-16-chair', '座椅 B-16', 32, 17, 1, 1, 0, 'open_b', true, '{}'),
    ('whiteboard', 'meeting.whiteboard', '白板', 3, 21, 3, 1, 0, 'meeting', false, '{}'),
    ('meeting_table', 'meeting.table', '會議桌', 3, 23, 3, 2, 0, 'meeting', false, ARRAY['discuss']),
    ('chair', 'meeting.chair-01', '會議椅-01', 3, 22, 1, 1, 0, 'meeting', true, '{}'),
    ('chair', 'meeting.chair-02', '會議椅-02', 4, 22, 1, 1, 0, 'meeting', true, '{}'),
    ('chair', 'meeting.chair-03', '會議椅-03', 5, 22, 1, 1, 0, 'meeting', true, '{}'),
    ('chair', 'meeting.chair-04', '會議椅-04', 3, 25, 1, 1, 0, 'meeting', true, '{}'),
    ('chair', 'meeting.chair-05', '會議椅-05', 4, 25, 1, 1, 0, 'meeting', true, '{}'),
    ('chair', 'meeting.chair-06', '會議椅-06', 5, 25, 1, 1, 0, 'meeting', true, '{}'),
    ('chair', 'meeting.chair-07', '會議椅-07', 2, 23, 1, 1, 0, 'meeting', true, '{}'),
    ('chair', 'meeting.chair-08', '會議椅-08', 6, 23, 1, 1, 0, 'meeting', true, '{}'),
    ('pantry_counter', 'pantry.counter', '茶水間吧台', 12, 23, 2, 1, 0, 'pantry', false, ARRAY['coffee']),
    ('printer', 'common.printer', '影印機', 16, 23, 1, 1, 0, 'common', false, ARRAY['print']),
    ('cabinet', 'common.cabinet-01', '檔案櫃-01', 18, 22, 1, 1, 0, 'common', false, ARRAY['work']),
    ('cabinet', 'common.cabinet-02', '檔案櫃-02', 19, 22, 1, 1, 0, 'common', false, ARRAY['work']),
    ('cabinet', 'common.cabinet-03', '檔案櫃-03', 18, 24, 1, 1, 0, 'common', false, ARRAY['work']),
    ('cabinet', 'common.cabinet-04', '檔案櫃-04', 19, 24, 1, 1, 0, 'common', false, ARRAY['work']),
    ('plant', 'common.plant-01', '盆栽-01', 44, 2, 1, 1, 0, 'common', false, '{}'),
    ('plant', 'common.plant-02', '盆栽-02', 46, 2, 1, 1, 0, 'common', false, '{}'),
    ('plant', 'common.plant-03', '盆栽-03', 1, 30, 1, 1, 0, 'common', false, '{}'),
    ('plant', 'common.plant-04', '盆栽-04', 46, 30, 1, 1, 0, 'common', false, '{}')
  ) as v(kind, key, name, pos_x, pos_y, w, h, rotation, zone, walkable, affords)
  returning id, key
),
-- Seat assignment (7.2 default): high-level specialist + 5 specialists on
-- deskA-01..06, temp staff on deskA-08; manager on exec.mgr, VP on exec.vp.
-- open_b left fully unassigned (spec: "供佈局實驗與擴編").
seat_map(agent_name, desk_key) as (
  values
    ('方以寧', 'exec.vp'),
    ('高子軒', 'exec.mgr'),
    ('沈書萍', 'deskA-01'),
    ('郭立衡', 'deskA-02'),
    ('曾若彤', 'deskA-03'),
    ('韓致遠', 'deskA-04'),
    ('廖苡安', 'deskA-05'),
    ('江秉倫', 'deskA-06'),
    ('阮曉青', 'deskA-08')
),
seat_update as (
  update agents a
  set desk_id = li.id,
      pos_x = li.pos_x,
      pos_y = li.pos_y,
      current_status = 'commuting'
  from seat_map sm
  join layout_ins li on li.key = sm.desk_key
  where a.name = sm.agent_name
  returning a.id
),
-- Initial relationships: same-department affinity=0; direct reports_to
-- pairs get descriptor='我的主管' from the subordinate's row (agent_id =
-- subordinate, target_id = their manager). Reverse direction (manager ->
-- subordinate) defaults to '同部門同事' since the spec only specifies the
-- subordinate's-eye-view descriptor explicitly. `reports_to_map` re-reads
-- the just-inserted agents rows by name (safe: within one WITH statement,
-- a plain table read sees rows written by earlier CTEs once those CTEs
-- have been pulled into the execution graph by all_agents above).
reports_to_map as (
  select ag.id as agent_id, ag.reports_to as manager_id
  from agents ag
  join all_agents aa on aa.id = ag.id
),
-- Major #2 fix (docs/eval/p0-review.md): Appendix A.1 gives 阮曉青 a dual
-- reporting line — reports_to=高子軒 (formal, already captured by
-- reports_to_map above) plus 業務指導 from 沈書萍 (functional/dotted-line,
-- not representable by the single reports_to FK). The generic rel_ins CTE
-- below would otherwise mislabel (阮曉青→沈書萍) as an ordinary
-- '同部門同事' peer pair, same as any other non-manager pair — so that one
-- ordered pair is excluded from rel_ins's cross join here and given its
-- own explicit row with descriptor='業務指導' immediately after. Reverse
-- direction (沈書萍→阮曉青) intentionally stays '同部門同事' via the
-- generic CTE (spec doesn't define a manager-eye-view descriptor for a
-- dotted-line report; unchanged from before this fix).
rel_ins as (
  insert into relationships (agent_id, target_id, affinity, descriptor, updated_day)
  select a1.id, a2.id, 0,
    case when rtm.manager_id = a2.id then '我的主管' else '同部門同事' end,
    1
  from all_agents a1
  cross join all_agents a2
  join reports_to_map rtm on rtm.agent_id = a1.id
  where a1.id <> a2.id
    and not (a1.name = '阮曉青' and a2.name = '沈書萍')
  returning agent_id
),
ruanxiaoqing_shenshuping_rel as (
  insert into relationships (agent_id, target_id, affinity, descriptor, updated_day)
  select temp_staff.id, specialist_senior.id, 0, '業務指導', 1
  from temp_staff, specialist_senior
  returning agent_id
),
-- 6 seed work_items (Appendix A.3). Item #2's title uses the fictional
-- airport name from company_context per the draft v2 integration note
-- (item 5), replacing the real-airport reference that appeared in the
-- original spec text; client stays "機場當局" (a role label, not a real
-- authority's name) per the fictionalization declared at the top of the
-- spec.
work_items_ins as (
  insert into work_items (world_id, kind, title, client, owner_id, collaborators, status, priority, due_day, progress)
  select w.id, v.kind, v.title, v.client, owner.id,
    array_remove(ARRAY[collab1.id, collab2.id], null),
    'open', v.priority, v.due_day, 0
  from new_world w
  join (values
    ('contract_renewal', '星海航空 台北站地勤服務合約續約（SGHA 附錄B更新）', '星海航空', '沈書萍', 2, 6),
    ('tender', '北原機場貴賓室經營權投標案—服務建議書', '機場當局', '韓致遠', 1, 4),
    ('quotation', '北風航空 冬季班表新增航班保障報價', '北風航空', '江秉倫', 2, 3),
    ('sla_audit', '年度 SLA 稽核—行李運送 KPI 追蹤', '內部', '郭立衡', 3, 8),
    ('contract_renewal', '貨站郵件處理外包合約修約', '雲嶺物流', '曾若彤', 3, 7),
    ('tender', 'GSE 維護外包廠商評選—評分表建置', '內部', '廖苡安', 2, 5)
  ) as v(kind, title, client, owner_name, priority, due_day)
    on true
  join all_agents owner on owner.name = v.owner_name
  left join all_agents collab1 on v.kind = 'tender' and collab1.name = '阮曉青'
  left join all_agents collab2 on v.kind = 'tender' and collab2.name = '方以寧'
  returning id, kind
)
-- IMPORTANT: PostgreSQL only executes CTEs that are reachable from the
-- final query's FROM/JOIN graph. seat_update, rel_ins,
-- ruanxiaoqing_shenshuping_rel, and work_items_ins are data-modifying
-- CTEs with no other CTE depending on them, so without being referenced
-- here they would silently never run (layout_ins/all_agents/new_world
-- *are* transitively referenced by rel_ins/work_items_ins, so this final
-- select is what pulls the whole graph — including seat_update, rel_ins,
-- ruanxiaoqing_shenshuping_rel, and work_items_ins themselves — into
-- execution).
select
  (select count(*) from new_world) as worlds_created,
  (select count(*) from all_agents) as agents_created,
  (select count(*) from layout_ins) as layout_items_created,
  (select count(*) from seat_update) as seats_assigned,
  (select count(*) from rel_ins) + (select count(*) from ruanxiaoqing_shenshuping_rel)
    as relationships_created,
  (select count(*) from work_items_ins) as work_items_created;

commit;
SQL

  echo "== agents, layout, work_items seeded =="

  WORLD_ID=$("${PSQL[@]}" -t -A -c "select id from worlds order by created_at desc limit 1;")
  WORLD_ID="$(echo "$WORLD_ID" | tr -d '[:space:]')"
  echo "== world id: $WORLD_ID =="
fi

# ---------------------------------------------------------------------
# Knowledge slices (company_context draft v2, layer 3 table, 20 rows).
# kind='knowledge', importance 3-5, sim_day=0, sim_clock_sec=0.
# Delivered per-agent per the [發給] column; "全員" fans out to all 9.
# Embedding generated via Ollama when reachable; NULL + WARN otherwise.
# ---------------------------------------------------------------------
echo "== seeding 20 knowledge memories for world $WORLD_ID =="

# id | content | recipients (comma-separated agent names, or ALL) | importance
KNOWLEDGE_ROWS=(
"K-01|星海航空的續約要在到期前 6 個月啟動，對方採購部門換了新窗口，風格比前任強硬。|ALL|4"
"K-02|羽澤航空的月度品質會（MQM）固定在每月第二週，會前兩天要交中日文對照的 KPI 報告。|沈書萍,韓致遠,高子軒|4"
"K-03|藍鵲航空過站僅 35 分鐘，任何新增服務先想「來不來得及」再談價格。|郭立衡,江秉倫|3"
"K-04|附錄B 的年度調價談判，我方慣例以工資調幅與物價指數擇優主張。|沈書萍,江秉倫,方以寧|4"
"K-05|颱風 IROPS 的臨時加派工時要在 48 小時內完成站上簽認，否則航司常拒付。|ALL|5"
"K-06|貴賓室標案採最有利標，評選簡報 15 分鐘、答詢 10 分鐘，簡報檔需三日前送達。|韓致遠,阮曉青,方以寧|4"
"K-07|押標金用銀行本票，開標次日辦理退還申請；履約保證金比率依招標文件。|阮曉青,江秉倫|3"
"K-08|服務建議書的裝訂規格（份數、彌封、騎縫章）任何一項出錯就是廢標，送標前要雙人覆核。|阮曉青,韓致遠|5"
"K-09|GSE 外包合約的關鍵是妥善率條款與備援車輛數，維修回應時間分「航班保障」與「一般」兩級。|廖苡安|4"
"K-10|貨站郵件合約的計費以重量帶距分級，郵政端的稽核重點是袋牌掃描率。|曾若彤|3"
"K-11|行李 KPI 的申復要附行李條碼掃描時間軸，站上系統匯出要提前一天申請。|郭立衡,沈書萍|4"
"K-12|換季前第 8 週要發函請各航司確認班表與機型，第 4 週鎖定附錄B修訂版。|ALL|4"
"K-13|新航司開航前置：合約簽署→保險確認→系統與通行證申請→試營運演練，至少抓 10 週。|沈書萍,高子軒,方以寧|4"
"K-14|對機場當局的公文往返一律用正式函文並留發文字號，電話講好的事也要補書面。|ALL|4"
"K-15|部門慣例：報價單一律經江秉倫法遵檢核、經理複核，百萬以上案件加會副總。|ALL|4"
"K-16|春節加班機的報價有旺季加成，但老客戶會拿年度總量來壓，底線由副總持有。|江秉倫,方以寧|4"
"K-17|約聘同仁的通行證權限較窄，需要進管制區核對文件時要有正職陪同。|阮曉青,ALL|3"
"K-18|站上最討厭合約部「答應了才問做不做得到」，重大承諾前先找站上主管口頭確認。|ALL|5"
"K-19|同場另兩家同業最近在價格上殺得兇，副總指示：守服務品質敘事，不打純價格戰。|ALL|4"
"K-20|ISAGO/航司稽核的缺失改善單（CAP）逾期未結會直接影響續約談判籌碼。|沈書萍,郭立衡|5"
)

# Fetch the full agent name -> id map once.
AGENT_MAP_FILE=$(mktemp)
trap 'rm -f "$AGENT_MAP_FILE"' EXIT
"${PSQL[@]}" -t -A -F'|' -c "select name, id from agents where world_id = '${WORLD_ID}';" > "$AGENT_MAP_FILE"

agent_id_for() {
  local target_name="$1"
  awk -F'|' -v n="$target_name" '$1 == n { print $2; exit }' "$AGENT_MAP_FILE"
}

ALL_AGENT_NAMES=$(awk -F'|' '{print $1}' "$AGENT_MAP_FILE")

# Replace/reseed semantics for knowledge (per project instruction:
# "--knowledge-only ... 只動 knowledge、不動其他資料"): the `memories`
# table (spec section 4) has no unique key suitable as an ON CONFLICT
# arbiter for a knowledge slice, and the DDL must not be altered beyond
# the created_at addition. So this is implemented as delete-then-reinsert
# of this world's kind='knowledge' rows — NOT an upsert: every row gets a
# brand-new id/created_at/last_access on every run (see the id-churn
# warning in this script's usage header). What IS preserved across
# repeated --knowledge-only runs is content-level idempotency (no
# duplicate/accumulating rows) and that no other memory kind or
# non-memories table is touched.
echo "== clearing existing knowledge memories for world $WORLD_ID before reseeding =="
"${PSQL[@]}" -v ON_ERROR_STOP=1 -c "
  delete from memories
  where kind = 'knowledge'
    and agent_id in (select id from agents where world_id = '${WORLD_ID}');
" >/dev/null

# Expands a recipients spec (comma-separated agent names, where the
# literal token ALL means "every seeded agent") into a de-duplicated,
# newline-separated list of agent names. Written without associative
# arrays for compatibility with bash 3.2 (macOS default /bin/bash has no
# `declare -A`); relies only on POSIX-ish bash builtins plus sort -u.
expand_recipients() {
  local recipients="$1"
  local IFS=','
  local -a tokens=($recipients)
  local tok
  {
    for tok in "${tokens[@]}"; do
      if [ "$tok" = "ALL" ]; then
        printf '%s\n' "$ALL_AGENT_NAMES"
      else
        printf '%s\n' "$tok"
      fi
    done
  } | awk 'NF' | sort -u
}

KNOWLEDGE_INSERTED=0
KNOWLEDGE_NULL_EMBED=0

for row in "${KNOWLEDGE_ROWS[@]}"; do
  IFS='|' read -r know_id content recipients importance <<< "$row"

  embedding_literal=""
  if fetched=$(fetch_embedding "$content"); then
    embedding_literal="$fetched"
  else
    KNOWLEDGE_NULL_EMBED=$((KNOWLEDGE_NULL_EMBED + 1))
  fi

  escaped_content="$(printf '%s' "$content" | sed "s/'/''/g")"

  while IFS= read -r recipient_name; do
    [ -z "$recipient_name" ] && continue
    agent_id=$(agent_id_for "$recipient_name")
    if [ -z "$agent_id" ]; then
      echo "WARN: knowledge $know_id — recipient '$recipient_name' not found among seeded agents; skipping." >&2
      continue
    fi

    if [ -n "$embedding_literal" ]; then
      "${PSQL[@]}" -v ON_ERROR_STOP=1 -c "
        insert into memories (agent_id, kind, content, importance, embedding, sim_day, sim_clock_sec)
        values ('${agent_id}', 'knowledge', '${escaped_content}', ${importance}, '${embedding_literal}'::vector, 0, 0);
      " >/dev/null
    else
      "${PSQL[@]}" -v ON_ERROR_STOP=1 -c "
        insert into memories (agent_id, kind, content, importance, embedding, sim_day, sim_clock_sec)
        values ('${agent_id}', 'knowledge', '${escaped_content}', ${importance}, NULL, 0, 0);
      " >/dev/null
    fi
    KNOWLEDGE_INSERTED=$((KNOWLEDGE_INSERTED + 1))
  done <<< "$(expand_recipients "$recipients")"
done

echo "== knowledge memories inserted: ${KNOWLEDGE_INSERTED} (embedding=NULL for ${KNOWLEDGE_NULL_EMBED} distinct slices due to Ollama unavailability) =="
if [ "$OLLAMA_AVAILABLE" -eq 0 ]; then
  echo "WARN: all knowledge embeddings are NULL because Ollama was unreachable at ${OLLAMA_BASE_URL}. Re-run with --knowledge-only once Ollama + ${EMBED_MODEL} are available to backfill." >&2
fi

echo "== seed_world.sh done =="

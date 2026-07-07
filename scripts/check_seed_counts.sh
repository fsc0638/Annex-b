#!/usr/bin/env bash
#
# check_seed_counts.sh — DB-less assertion of seed constants (spec
# acceptance criterion: "數量自查：為 seed 常數寫一個不連 DB 的測試或腳本
# 斷言"). Parses scripts/seed_world.sh's literal SQL text directly (the
# actual source of truth for what gets seeded) rather than a hand-copied
# duplicate table, so this check cannot silently drift from the real seed
# script.
#
# Expected counts (spec section 7.2, Appendix A.1/A.3, company_context
# draft v2 knowledge table):
#   desk=32 exec_desk=2 chair=42 meeting_table=1 cabinet=4 plant=4
#   printer=1 pantry_counter=1 whiteboard=1 partition=6
#   agents=9 work_items=6 knowledge_slices=20
#
# Exit code 0 = all counts match; nonzero = mismatch (prints details).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_SCRIPT="${SCRIPT_DIR}/seed_world.sh"

if [ ! -f "$SEED_SCRIPT" ]; then
  echo "ERROR: $SEED_SCRIPT not found." >&2
  exit 1
fi

FAILURES=0

# check_count <label> <actual> <expected>
check_count() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  if [ "$actual" -eq "$expected" ]; then
    echo "PASS  ${label}: ${actual} (expected ${expected})"
  else
    echo "FAIL  ${label}: ${actual} (expected ${expected})"
    FAILURES=$((FAILURES + 1))
  fi
}

# --- layout_items kind counts: parse the literal VALUES rows inside the
# layout_ins CTE. Each row looks like: ('kind', 'key', 'name', ...
# We grep for the specific quoted kind tokens that open each VALUES row.
count_kind() {
  local kind="$1"
  grep -c "^    ('${kind}'," "$SEED_SCRIPT" || true
}

DESK_COUNT=$(count_kind "desk")
EXEC_DESK_COUNT=$(count_kind "exec_desk")
CHAIR_COUNT=$(count_kind "chair")
MEETING_TABLE_COUNT=$(count_kind "meeting_table")
CABINET_COUNT=$(count_kind "cabinet")
PLANT_COUNT=$(count_kind "plant")
PRINTER_COUNT=$(count_kind "printer")
PANTRY_COUNTER_COUNT=$(count_kind "pantry_counter")
WHITEBOARD_COUNT=$(count_kind "whiteboard")
PARTITION_COUNT=$(count_kind "partition")

check_count "layout_items.desk" "$DESK_COUNT" 32
check_count "layout_items.exec_desk" "$EXEC_DESK_COUNT" 2
check_count "layout_items.chair" "$CHAIR_COUNT" 42
check_count "layout_items.meeting_table" "$MEETING_TABLE_COUNT" 1
check_count "layout_items.cabinet" "$CABINET_COUNT" 4
check_count "layout_items.plant" "$PLANT_COUNT" 4
check_count "layout_items.printer" "$PRINTER_COUNT" 1
check_count "layout_items.pantry_counter" "$PANTRY_COUNTER_COUNT" 1
check_count "layout_items.whiteboard" "$WHITEBOARD_COUNT" 1
check_count "layout_items.partition" "$PARTITION_COUNT" 6

# --- agents: count distinct "insert into agents (" CTE blocks (vp, mgr,
# specialist_senior, specialist_02..06, temp_staff = 9 agent inserts).
AGENT_INSERT_COUNT=$(grep -c "insert into agents ($" "$SEED_SCRIPT" || true)
check_count "agents (insert blocks)" "$AGENT_INSERT_COUNT" 9

# --- work_items: count rows in the work_items_ins VALUES block. Each row
# starts with a quoted work_item kind (contract_renewal/tender/quotation/
# sla_audit) followed by a comma; count lines matching that shape inside
# the known VALUES block markers.
WORK_ITEMS_COUNT=$(awk '
  /join \(values/ { in_block=1; next }
  in_block && /\) as v\(kind, title, client/ { in_block=0 }
  in_block && /^    \(.(contract_renewal|tender|quotation|sla_audit|complaint)./ { count++ }
  END { print count+0 }
' "$SEED_SCRIPT")
check_count "work_items" "$WORK_ITEMS_COUNT" 6

# --- knowledge slices: count KNOWLEDGE_ROWS array entries (K-01..K-20).
KNOWLEDGE_COUNT=$(grep -cE '^"K-[0-9]+\|' "$SEED_SCRIPT" || true)
check_count "knowledge slices (distinct K-* entries)" "$KNOWLEDGE_COUNT" 20

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "check_seed_counts.sh: ALL PASS"
  exit 0
else
  echo "check_seed_counts.sh: ${FAILURES} FAILURE(S)"
  exit 1
fi

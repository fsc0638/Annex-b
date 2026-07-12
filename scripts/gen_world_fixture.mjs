#!/usr/bin/env node
// gen_world_fixture.mjs — generates the DB-less world fixture (Phase 1
// T1.2 testability requirement) by parsing scripts/seed_world.sh, the
// single source of truth for seed data:
//
//   engine/crates/sim-core/tests/fixtures/world_fixture.json
//     { world, agents[9], layout[94], work_items[6] } with deterministic
//     UUIDs, used by sim-core tests and by api-server WORLD_SOURCE=fixture.
//
//   web/public/mock/world_snapshot.json
//     The same data wrapped as a 7.4 `world_snapshot` WS message, used by
//     the frontend's NEXT_PUBLIC_MOCK_SNAPSHOT=1 mode (static render
//     without any engine running).
//
// Determinism: UUIDs are fixed-format counters (not random), key order is
// construction order, no timestamps — rerunning produces byte-identical
// files. A sim-core test asserts these fixture counts against
// scripts/check_seed_counts.sh's expected numbers, so fixture and seed
// script cannot silently drift apart.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  parseAgents,
  parseLayoutItems,
  parseSeatMap,
  parseWorkItems,
  readSeedScript,
} from "./lib/seed_layout.mjs";

// Deterministic fixture UUIDs: version/variant nibbles are valid (4xxx /
// 8xxx) so any UUID parser accepts them; the trailing counter encodes
// entity class (0x001 world, 0x1xx agents, 0x2xx layout, 0x3xx work).
function fixtureUuid(counter) {
  const hex = counter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function parseWorldRow(script) {
  const m = script.match(
    /insert into worlds \(name, seed, sim_day, sim_clock_sec, status\)\n\s*values \('([^']+)', (\d+), (\d+), (\d+), '([^']+)'\)/
  );
  if (!m) throw new Error("gen_world_fixture: worlds insert not found in seed_world.sh");
  return {
    name: m[1],
    seed: Number(m[2]),
    sim_day: Number(m[3]),
    sim_clock_sec: Number(m[4]),
    status: m[5],
  };
}

function main() {
  const script = readSeedScript();
  const worldRow = parseWorldRow(script);
  const agentRows = parseAgents(script);
  const layoutRows = parseLayoutItems(script);
  const seatMap = parseSeatMap(script);
  const workRows = parseWorkItems(script);

  const worldId = fixtureUuid(0x001);

  // worlds: tick_ms / sec_per_tick fall through to schema defaults in the
  // seed script, so mirror 001_init.sql's defaults here (1000 / 10).
  const world = {
    id: worldId,
    name: worldRow.name,
    seed: worldRow.seed,
    sim_day: worldRow.sim_day,
    sim_clock_sec: worldRow.sim_clock_sec,
    tick_ms: 1000,
    sec_per_tick: 10,
    status: worldRow.status,
  };

  const layout = layoutRows.map((row, i) => ({
    id: fixtureUuid(0x200 + i + 1),
    world_id: worldId,
    kind: row.kind,
    key: row.key,
    name: row.name,
    pos_x: row.pos_x,
    pos_y: row.pos_y,
    w: row.w,
    h: row.h,
    rotation: row.rotation,
    zone: row.zone,
    walkable: row.walkable,
    affords: row.affords,
    meta: {},
  }));
  const layoutByKey = new Map(layout.map((l) => [l.key, l]));

  const agentIdByName = new Map(
    agentRows.map((a, i) => [a.name, fixtureUuid(0x100 + i + 1)])
  );

  const agents = agentRows.map((row) => {
    const deskKey = seatMap.get(row.name);
    const desk = layoutByKey.get(deskKey);
    if (!desk) {
      throw new Error(
        `gen_world_fixture: seat_map desk key '${deskKey}' for ${row.name} not found in layout`
      );
    }
    return {
      id: agentIdByName.get(row.name),
      world_id: worldId,
      name: row.name,
      sprite_key: row.sprite_key,
      grade: row.grade,
      title: row.title,
      reports_to: row.reports_to_name
        ? agentIdByName.get(row.reports_to_name)
        : null,
      core_identity: row.core_identity,
      seed_traits: row.seed_traits,
      reply_style: row.reply_style,
      // seat_update semantics in seed_world.sh: agent pos = its desk's
      // top-left tile; current_status stays 'commuting' (spec: 07:00
      // kickoff has nobody on the floor yet).
      current_status: "commuting",
      pos_x: desk.pos_x,
      pos_y: desk.pos_y,
      desk_id: desk.id,
      llm_profile: {},
      // ADR-003 D3: seed agents ship with no appearance override — null
      // means "use the existing generated placeholder sprite" (seed_world.sh
      // seeds all 9 agents' `appearance` column as `null` too; this is not
      // parsed out of the seed script since the value is always the same
      // constant for every seed agent — see seed_layout.mjs's parseAgents
      // doc comment for what IS parsed).
      appearance: null,
    };
  });

  const work_items = workRows.map((row, i) => ({
    id: fixtureUuid(0x300 + i + 1),
    world_id: worldId,
    kind: row.kind,
    title: row.title,
    client: row.client,
    owner_id: agentIdByName.get(row.owner_name) ?? null,
    collaborators: row.collaborator_names.map((n) => agentIdByName.get(n)),
    status: "open",
    priority: row.priority,
    due_day: row.due_day,
    progress: 0,
    last_note: null,
  }));

  const fixture = {
    _comment:
      "Generated by scripts/gen_world_fixture.mjs from scripts/seed_world.sh — do not hand-edit.",
    world,
    agents,
    layout,
    work_items,
  };

  const fixtureDir = join(
    REPO_ROOT,
    "engine",
    "crates",
    "sim-core",
    "tests",
    "fixtures"
  );
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "world_fixture.json"),
    JSON.stringify(fixture, null, 2) + "\n"
  );

  // Frontend mock snapshot: identical to the api-server's first WS message
  // (7.4 world_snapshot, snake_case), with the runtime `speed` field the
  // server injects into `world`.
  const snapshot = {
    type: "world_snapshot",
    world: { ...world, speed: 1 },
    agents,
    layout,
    work_items,
  };
  const mockDir = join(REPO_ROOT, "web", "public", "mock");
  mkdirSync(mockDir, { recursive: true });
  writeFileSync(
    join(mockDir, "world_snapshot.json"),
    JSON.stringify(snapshot, null, 2) + "\n"
  );

  console.log(
    `gen_world_fixture: OK — world + ${agents.length} agents + ${layout.length} layout + ${work_items.length} work_items; wrote sim-core fixture and web mock snapshot.`
  );
}

main();

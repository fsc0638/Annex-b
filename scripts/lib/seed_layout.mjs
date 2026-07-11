// seed_layout.mjs — parses scripts/seed_world.sh's literal SQL text into JS
// data structures.
//
// Why parse the shell script instead of keeping a second copy of the layout
// constants: scripts/seed_world.sh is the single source of truth for what
// gets seeded into the DB (spec 7.2 / Appendix A), and
// scripts/check_seed_counts.sh already asserts against its literal text.
// The tmj generator and the fixture generator read the same text, so map
// geometry, fixtures, and DB seed can never silently drift apart — any
// format change in seed_world.sh breaks these parsers loudly (they throw on
// unexpected shapes / row counts).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
const SEED_SCRIPT_PATH = join(REPO_ROOT, "scripts", "seed_world.sh");

export function readSeedScript() {
  return readFileSync(SEED_SCRIPT_PATH, "utf8");
}

const LAYOUT_ROW_RE =
  /^ {4}\('(desk|exec_desk|chair|partition|meeting_table|cabinet|printer|plant|pantry_counter|whiteboard)', '([^']+)', '([^']+)', (\d+), (\d+), (\d+), (\d+), (\d+), '([^']+)', (true|false), (ARRAY\[[^\]]*\]|'\{\}')\),?$/;

function parseAffords(sqlLiteral) {
  if (sqlLiteral === "'{}'") return [];
  // ARRAY['work'] / ARRAY['work','print'] ...
  const inner = sqlLiteral.slice("ARRAY[".length, -1);
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^'/, "").replace(/'$/, ""));
}

/**
 * @returns {Array<{kind, key, name, pos_x, pos_y, w, h, rotation, zone, walkable, affords}>}
 */
export function parseLayoutItems(script = readSeedScript()) {
  const items = [];
  for (const line of script.split("\n")) {
    const m = line.match(LAYOUT_ROW_RE);
    if (!m) continue;
    items.push({
      kind: m[1],
      key: m[2],
      name: m[3],
      pos_x: Number(m[4]),
      pos_y: Number(m[5]),
      w: Number(m[6]),
      h: Number(m[7]),
      rotation: Number(m[8]),
      zone: m[9],
      walkable: m[10] === "true",
      affords: parseAffords(m[11]),
    });
  }
  if (items.length !== 94) {
    throw new Error(
      `parseLayoutItems: expected 94 layout rows in seed_world.sh, got ${items.length} — seed script format changed?`
    );
  }
  return items;
}

const AGENT_BLOCK_RE =
  /select (?:w\.)?id, '([^']+)', '([^']+)', '([^']+)', '([^']+)', (null|vp\.id|mgr\.id),\n\s*'([^']+)',\n\s*'([^']+)',\n\s*'([^']+)',\n\s*'commuting', 0, 0, '\{\}'::jsonb/g;

/**
 * @returns {Array<{name, sprite_key, grade, title, reports_to_name, reply_style}>}
 *   reports_to_name is null (VP), or the referenced agent's name.
 */
export function parseAgents(script = readSeedScript()) {
  const agents = [];
  let m;
  while ((m = AGENT_BLOCK_RE.exec(script)) !== null) {
    agents.push({
      name: m[1],
      sprite_key: m[2],
      grade: m[3],
      title: m[4],
      reports_to_ref: m[5], // 'null' | 'vp.id' | 'mgr.id'
      core_identity: m[6],
      seed_traits: m[7],
      reply_style: m[8],
    });
  }
  if (agents.length !== 9) {
    throw new Error(
      `parseAgents: expected 9 agent blocks in seed_world.sh, got ${agents.length} — seed script format changed?`
    );
  }
  const vp = agents.find((a) => a.grade === "副總");
  const mgr = agents.find((a) => a.grade === "經理");
  if (!vp || !mgr) {
    throw new Error("parseAgents: could not identify VP/manager rows");
  }
  for (const a of agents) {
    a.reports_to_name =
      a.reports_to_ref === "null"
        ? null
        : a.reports_to_ref === "vp.id"
          ? vp.name
          : mgr.name;
    delete a.reports_to_ref;
  }
  return agents;
}

const SEAT_ROW_RE = /^ {4}\('([^']+)', '([^']+)'\),?$/;

/**
 * @returns {Map<agentName, deskKey>} parsed from the seat_map CTE.
 */
export function parseSeatMap(script = readSeedScript()) {
  const start = script.indexOf("seat_map(agent_name, desk_key) as (");
  const end = script.indexOf("seat_update as (");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("parseSeatMap: seat_map CTE not found in seed_world.sh");
  }
  const block = script.slice(start, end);
  const map = new Map();
  for (const line of block.split("\n")) {
    const m = line.match(SEAT_ROW_RE);
    if (m) map.set(m[1], m[2]);
  }
  if (map.size !== 9) {
    throw new Error(
      `parseSeatMap: expected 9 seat assignments, got ${map.size}`
    );
  }
  return map;
}

const WORK_ITEM_ROW_RE =
  /^ {4}\('(contract_renewal|tender|quotation|sla_audit|complaint)', '([^']+)', '([^']+)', '([^']+)', (\d+), (\d+)\),?$/;

/**
 * @returns {Array<{kind, title, client, owner_name, priority, due_day, collaborator_names}>}
 *   Collaborator rule mirrors seed_world.sh's work_items_ins CTE: only
 *   kind='tender' rows get (阮曉青, 方以寧) as collaborators.
 */
export function parseWorkItems(script = readSeedScript()) {
  const items = [];
  for (const line of script.split("\n")) {
    const m = line.match(WORK_ITEM_ROW_RE);
    if (!m) continue;
    items.push({
      kind: m[1],
      title: m[2],
      client: m[3],
      owner_name: m[4],
      priority: Number(m[5]),
      due_day: Number(m[6]),
      collaborator_names: m[1] === "tender" ? ["阮曉青", "方以寧"] : [],
    });
  }
  if (items.length !== 6) {
    throw new Error(
      `parseWorkItems: expected 6 work_items rows, got ${items.length}`
    );
  }
  return items;
}

/**
 * Effective footprint of a layout item on the tile grid, accounting for
 * rotation: 90/270 swap w and h (same rule sim-core uses).
 * @returns {{x, y, w, h}}
 */
export function footprint(item) {
  const swap = item.rotation === 90 || item.rotation === 270;
  return {
    x: item.pos_x,
    y: item.pos_y,
    w: swap ? item.h : item.w,
    h: swap ? item.w : item.h,
  };
}

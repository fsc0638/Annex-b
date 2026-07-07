// WebSocket protocol types (spec 7.4, snake_case on the wire).
// Field names mirror the DB schema / sim-core serialization exactly.

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  sim_day: number;
  sim_clock_sec: number;
  tick_ms: number;
  sec_per_tick: number;
  status: "paused" | "running" | "editing" | "archived";
  /** Runtime speed multiplier injected by the server (1|2|5). */
  speed?: number;
}

export interface AgentRow {
  id: string;
  world_id: string;
  name: string;
  sprite_key: string;
  grade: string;
  title: string;
  reports_to: string | null;
  core_identity: string;
  seed_traits: string;
  current_status: string;
  pos_x: number;
  pos_y: number;
  desk_id: string | null;
  llm_profile: Record<string, string>;
}

export interface LayoutItemRow {
  id: string;
  world_id: string;
  kind:
    | "desk"
    | "exec_desk"
    | "chair"
    | "partition"
    | "meeting_table"
    | "cabinet"
    | "printer"
    | "plant"
    | "pantry_counter"
    | "whiteboard";
  key: string;
  name: string;
  pos_x: number;
  pos_y: number;
  w: number;
  h: number;
  rotation: number;
  zone: string;
  walkable: boolean;
  affords: string[];
  meta: unknown;
}

export interface WorkItemRow {
  id: string;
  world_id: string;
  kind: string;
  title: string;
  client: string;
  owner_id: string | null;
  collaborators: string[];
  status: string;
  priority: number;
  due_day: number | null;
  progress: number;
  last_note: string | null;
}

export interface WorldSnapshotMsg {
  type: "world_snapshot";
  world: WorldMeta;
  agents: AgentRow[];
  layout: LayoutItemRow[];
  work_items: WorkItemRow[];
}

export interface TickMsg {
  type: "tick";
  sim_day: number;
  sim_clock_sec: number;
  speed: number;
}

export interface AgentMovedMsg {
  type: "agent_moved";
  agent_id: string;
  x: number;
  y: number;
}

export interface AgentStatusMsg {
  type: "agent_status";
  agent_id: string;
  status: string;
}

export interface WorldPausedMsg {
  type: "world_paused";
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

export type ServerMsg =
  | WorldSnapshotMsg
  | TickMsg
  | AgentMovedMsg
  | AgentStatusMsg
  | WorldPausedMsg
  | ErrorMsg;

/** Formats a game clock (seconds since 00:00) as "HH:MM". */
export function formatClock(simClockSec: number): string {
  const s = ((simClockSec % 86400) + 86400) % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Effective footprint after rotation (90/270 swap w/h) — same rule as
 * sim-core's grid::footprint. */
export function footprintOf(item: LayoutItemRow): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const swap = item.rotation === 90 || item.rotation === 270;
  return {
    x: item.pos_x,
    y: item.pos_y,
    w: swap ? item.h : item.w,
    h: swap ? item.w : item.h,
  };
}

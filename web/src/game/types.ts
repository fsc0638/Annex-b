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
  /** ADR-002 D2: increments on every successful map replace. Optional
   * because pre-D2 mock snapshots don't carry it — treat a missing value
   * as `1` (sim-core's own initial value). */
  map_rev?: number;
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
  /** ADR-002 D5: free-text "how this agent replies" customization.
   * Nullable/optional — pre-migration rows and mock snapshots may omit it. */
  reply_style?: string | null;
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

/** Result of a layout save/preview round-trip (LayoutEditorPanel). Not a
 * wire message from the engine's REST/WS contract today (the real
 * PUT /world/layout replies with a full world_snapshot, no `validation`
 * field) — this is the editor's own local-preview/save-result shape,
 * shuttled through the store via `LayoutUpdatedMsg` below. Left as-is for
 * Phase 3 wave 2 (see notes_for_wave3); wave 3 reconciles it with the
 * real engine response shape when it wires the editor's save button to
 * apiJson("/api/v1/world/layout", ...). */
export interface LayoutValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Client-local pseudo-message the layout editor feeds back into the
 * store after a local-preview apply or a (currently editor-only, not yet
 * engine-matching — see notes_for_wave3) save round-trip. Not sent by the
 * engine's `/ws`; added to `ServerMsg` purely so
 * `useGameStore.getState().applyServerMsg({ type: "layout_updated", ... })`
 * type-checks and updates `layout`/`agents`/`layoutValidation` together. */
export interface LayoutUpdatedMsg {
  type: "layout_updated";
  layout: LayoutItemRow[];
  agents: AgentRow[];
  validation: LayoutValidation;
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

/** Loud, status-free "this walker has been failing to reroute" signal.
 * It carries NO status: server-side current_status stays "walking". The
 * client treats it as an observability warning only and must NOT mutate any
 * rendered agent state from it. */
export interface AgentStuckMsg {
  type: "agent_stuck";
  agent_id: string;
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
  | AgentStuckMsg
  | WorldPausedMsg
  | ErrorMsg
  | LayoutUpdatedMsg;

/** Formats a game clock (seconds since 00:00) as "HH:MM". */
export function formatClock(simClockSec: number): string {
  const s = ((simClockSec % 86400) + 86400) % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Effective footprint after rotation (90/270 swap w/h) — same rule as
 * sim-core's grid::footprint, including the rem_euclid(360) normalization
 * so out-of-range values (450, -90, ...) resolve identically on both
 * sides instead of the two disagreeing about a footprint. */
export function footprintOf(item: LayoutItemRow): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const rotation = ((item.rotation % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  return {
    x: item.pos_x,
    y: item.pos_y,
    w: swap ? item.h : item.w,
    h: swap ? item.w : item.h,
  };
}

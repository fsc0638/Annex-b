"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { apiJson, ApiError } from "@/api/client";
import { useGameStore } from "@/game/store";
import {
  footprintOf,
  type AgentRow,
  type LayoutItemRow,
  type LayoutValidation,
  type WorldMeta,
  type WorldSnapshotMsg,
} from "@/game/types";
import {
  generateOfficeShell,
  MIN_SIZE as WORLD_MIN_SIZE,
  MAX_SIZE as WORLD_MAX_SIZE,
  THEME_IDS,
  tilesetImageForTheme,
} from "@/lib/office_shell_core.mjs";

export interface LayoutEditorPanelProps {
  send: ((payload: unknown) => void) | null;
}

type LayoutKind = LayoutItemRow["kind"];

const KINDS: LayoutKind[] = [
  "desk",
  "exec_desk",
  "chair",
  "partition",
  "meeting_table",
  "cabinet",
  "printer",
  "plant",
  "pantry_counter",
  "whiteboard",
];

// ADR-002 D2/D6: the map's real size now comes from the store's loaded
// `mapTmj` (GET /api/v1/world/map). These are only the fallback used
// before the first map fetch resolves (mock mode's static fixture is also
// 48x32, so the fallback doubles as its effective value).
const FALLBACK_MAP_W = 48;
const FALLBACK_MAP_H = 32;
const VIEW_PADDING = 2;
const MIN_VIEW_W = 12;
const MIN_VIEW_H = 8;
const LAYOUT_MATERIAL_MIME = "application/x-annex-b-layout-material";
const FURNITURE_MANIFEST_URL = "/tilesets/limezu-modern-office/manifest.json";
const THEMES_URL = "/tilesets/themes.json";
const WORLD_RESET_CONFIRM_MESSAGE =
  "套用後模擬將重置至當日 07:00（暫停），所有角色回到通勤起點。確定要套用嗎？";

// Fallback labels if /tilesets/themes.json can't be fetched (offline dev,
// stale build, etc.) — keeps the theme selector usable even then.
const FALLBACK_THEME_LABELS: Record<string, string> = {
  default: "預設",
  warm: "暖色調",
  cool: "冷色調",
  dark: "深色",
};

interface ThemeOption {
  id: string;
  label: string;
  file: string;
}

const KIND_LABELS: Record<LayoutKind, string> = {
  desk: "辦公桌",
  exec_desk: "主管桌",
  chair: "椅子",
  partition: "隔板",
  meeting_table: "會議桌",
  cabinet: "檔案櫃",
  printer: "印表機",
  plant: "盆栽",
  pantry_counter: "吧台",
  whiteboard: "白板",
};

interface Assignment {
  agent_id: string;
  desk_id: string | null;
}

interface ViewBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FurnitureSpriteManifestEntry {
  id?: string;
  label?: string;
  file?: string;
  image?: string;
  fit?: "contain" | "cover" | "stretch";
  scale?: number;
  offsetX?: number;
  offsetY?: number;
}

interface FurnitureMaterial extends FurnitureSpriteManifestEntry {
  id: string;
  label: string;
  kind?: LayoutKind;
}

interface FurnitureSpriteManifest {
  sprites?: Record<string, FurnitureSpriteManifestEntry>;
  catalog?: FurnitureMaterial[];
}

type FurnitureSpriteCatalog = Partial<
  Record<LayoutKind, FurnitureSpriteManifestEntry>
>;

type BoardInteraction =
  | { mode: "move"; itemId: string; offsetX: number; offsetY: number }
  | { mode: "resize"; itemId: string };

export default function LayoutEditorPanel({ send }: LayoutEditorPanelProps) {
  const world = useGameStore((state) => state.world);
  const layout = useGameStore((state) => state.layout);
  const agents = useGameStore((state) => state.agents);
  const validation = useGameStore((state) => state.layoutValidation);
  const running = useGameStore((state) => state.running);
  const mapTmj = useGameStore((state) => state.mapTmj);

  const [localLayout, setLocalLayout] = useState<LayoutItemRow[] | null>(null);
  // Desk assignments (the "座位指派" section below): the real engine has
  // no endpoint that accepts these — `PUT /world/layout` resolves each
  // agent's desk from the agent's own persisted `desk_id`
  // (world.rs::build_agent_sims), and `PATCH /agents/:id` doesn't expose
  // `desk_id` (ADR-002 D5's editable fields are name/seed_traits/
  // core_identity/reply_style/llm_profile only). So this stays a
  // local-only preview (see `save()`'s `localOnly` branch) until a future
  // wave adds real desk-assignment persistence.
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [kind, setKind] = useState<LayoutKind>("desk");
  const [selectedMaterialId, setSelectedMaterialId] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [autoView, setAutoView] = useState(true);
  const [lockedViewBounds, setLockedViewBounds] = useState<ViewBounds | null>(null);
  const [localEditing, setLocalEditing] = useState(false);
  const [furnitureSprites, setFurnitureSprites] =
    useState<FurnitureSpriteCatalog | null>(null);
  const [furnitureMaterials, setFurnitureMaterials] = useState<FurnitureMaterial[]>([]);
  const [manifestStatus, setManifestStatus] = useState<"loading" | "ok" | "missing">(
    "loading"
  );
  const [themeOptions, setThemeOptions] = useState<ThemeOption[]>([]);
  const [worldWidthInput, setWorldWidthInput] = useState(FALLBACK_MAP_W);
  const [worldHeightInput, setWorldHeightInput] = useState(FALLBACK_MAP_H);
  const [worldThemeInput, setWorldThemeInput] = useState<string>("default");
  const [worldSettingsBusy, setWorldSettingsBusy] = useState(false);
  const [worldSettingsMessage, setWorldSettingsMessage] = useState<string | null>(null);
  const [worldSettingsError, setWorldSettingsError] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<BoardInteraction | null>(null);
  const draftBaseLayoutRef = useRef<LayoutItemRow[] | null>(null);
  const draftBaseAgentsRef = useRef<Record<string, AgentRow> | null>(null);
  const draftBaseWorldStatusRef = useRef<WorldMeta["status"] | null>(null);
  const draftBaseRunningRef = useRef<boolean | null>(null);

  const editing = world?.status === "editing" || localEditing;
  const localOnly = localEditing || send === null;
  // send === null covers both mock mode and "not connected yet" — either
  // way there is no engine to PUT world settings to.
  const mockMode = send === null;
  const rows = localLayout ?? layout;
  const agentsList = useMemo(
    () => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    [agents]
  );
  const desks = rows.filter((item) => item.kind === "desk" || item.kind === "exec_desk");
  const selected = rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;
  // ADR-002 D6: the real map size, derived from the store's loaded TMJ
  // (falls back to the legacy 48x32 shell before the first fetch resolves).
  const mapDims = useMemo(() => mapDimsFromTmj(mapTmj), [mapTmj]);
  const activeThemeId = useMemo(() => themeIdFromTmj(mapTmj), [mapTmj]);
  const fullBounds = useMemo(
    () => ({ x: 0, y: 0, w: mapDims.w, h: mapDims.h }),
    [mapDims]
  );
  const viewBounds = useMemo(
    () => (autoView ? autoBoundsForRows(rows, mapDims.w, mapDims.h) : fullBounds),
    [autoView, rows, mapDims, fullBounds]
  );
  const activeViewBounds = lockedViewBounds ?? viewBounds;
  const materialOptions = useMemo(
    () =>
      furnitureMaterials.length > 0
        ? furnitureMaterials
        : KINDS.map((value) => ({
            id: `kind:${value}`,
            label: labelForKind(value),
            kind: value,
            ...furnitureSprites?.[value],
          })),
    [furnitureMaterials, furnitureSprites]
  );
  const selectedMaterial =
    materialOptions.find((material) => material.id === selectedMaterialId) ??
    materialOptions.find((material) => material.kind === kind) ??
    null;

  const rememberDraftBase = useCallback(() => {
    if (draftBaseLayoutRef.current) return;
    draftBaseLayoutRef.current = cloneLayout(layout);
    draftBaseAgentsRef.current = cloneAgents(agents);
    draftBaseWorldStatusRef.current = world?.status ?? null;
    draftBaseRunningRef.current = running;
  }, [agents, layout, running, world?.status]);

  useEffect(() => {
    let cancelled = false;
    fetch(FURNITURE_MANIFEST_URL, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          // 404 (package not synced) or any other non-2xx: degrade to the
          // generated placeholders and surface the install-guidance banner
          // instead of failing silently (ADR-002 D4).
          if (!cancelled) setManifestStatus("missing");
          return null;
        }
        return response.json();
      })
      .then((manifest: FurnitureSpriteManifest | null) => {
        if (cancelled || !manifest?.sprites) return;
        const catalog: FurnitureSpriteCatalog = {};
        for (const [value, sprite] of Object.entries(manifest.sprites)) {
          if (isLayoutKind(value) && sprite.image) {
            catalog[value] = sprite;
          }
        }
        setFurnitureSprites(catalog);
        setFurnitureMaterials(
          (manifest.catalog ?? [])
            .filter((material) => material.id && material.label && material.image)
            .map((material) => ({
              ...material,
              kind: material.kind && isLayoutKind(material.kind) ? material.kind : undefined,
            }))
        );
        setManifestStatus("ok");
      })
      .catch(() => {
        if (!cancelled) {
          setFurnitureSprites(null);
          setFurnitureMaterials([]);
          setManifestStatus("missing");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(THEMES_URL, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((list: ThemeOption[] | null) => {
        if (cancelled || !Array.isArray(list)) return;
        setThemeOptions(
          list.filter(
            (item) =>
              item && typeof item.id === "string" && typeof item.label === "string"
          )
        );
      })
      .catch(() => {
        /* fall back to THEME_IDS + FALLBACK_THEME_LABELS below */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keeps the "世界設定" inputs showing the *current* map's values as their
  // baseline. Only re-syncs when the underlying TMJ object actually changes
  // (initial GET /world/map, or a later successful PUT /world/map) — layout
  // edits don't touch mapTmj, so this never clobbers in-progress typing.
  useEffect(() => {
    setWorldWidthInput(mapDims.w);
    setWorldHeightInput(mapDims.h);
    setWorldThemeInput(activeThemeId);
  }, [mapTmj, mapDims, activeThemeId]);

  useEffect(() => {
    if (editing && localLayout === null) {
      const draft = cloneLayout(layout);
      rememberDraftBase();
      setLocalLayout(draft);
      publishDraftLayout(draft);
      setAssignments(
        Object.values(agents).map((agent) => ({
          agent_id: agent.id,
          desk_id: agent.desk_id,
        }))
      );
    }
    if (!editing && localLayout !== null) {
      setLocalLayout(null);
      setSelectedId("");
    }
  }, [agents, editing, layout, localLayout, rememberDraftBase]);

  function publishDraftLayout(nextLayout: LayoutItemRow[]) {
    useGameStore.setState((state) => ({
      layout: nextLayout,
      world: state.world ? { ...state.world, status: "editing" } : state.world,
      running: false,
    }));
  }

  function updateDraftLayout(
    updater: (current: LayoutItemRow[]) => LayoutItemRow[]
  ) {
    setLocalLayout((current) => {
      if (!current) return current;
      const next = updater(current);
      publishDraftLayout(next);
      return next;
    });
  }

  function restoreDraftBase() {
    const baseLayout = draftBaseLayoutRef.current;
    const baseAgents = draftBaseAgentsRef.current;
    const baseStatus = draftBaseWorldStatusRef.current;
    const baseRunning = draftBaseRunningRef.current;
    if (baseLayout) {
      useGameStore.setState((state) => ({
        layout: baseLayout,
        agents: baseAgents ?? state.agents,
        world:
          state.world && baseStatus
            ? { ...state.world, status: baseStatus }
            : state.world,
        running: baseRunning ?? state.running,
      }));
    }
    draftBaseLayoutRef.current = null;
    draftBaseAgentsRef.current = null;
    draftBaseWorldStatusRef.current = null;
    draftBaseRunningRef.current = null;
  }

  function commitDraftBase(nextLayout: LayoutItemRow[], nextAgents: AgentRow[]) {
    draftBaseLayoutRef.current = cloneLayout(nextLayout);
    draftBaseAgentsRef.current = Object.fromEntries(
      nextAgents.map((agent) => [agent.id, { ...agent }])
    );
  }

  const disabled = !world;

  function enterEdit() {
    if (!world) return;
    setMessage(null);
    rememberDraftBase();
    const draft = cloneLayout(layout);
    setLocalLayout(draft);
    publishDraftLayout(draft);
    setAssignments(
      Object.values(agents).map((agent) => ({
        agent_id: agent.id,
        desk_id: agent.desk_id,
      }))
    );
    if (send) {
      send({ type: "control", action: "enter_edit" });
    } else {
      setLocalEditing(true);
    }
  }

  function cancelEdit() {
    setMessage(null);
    setLocalLayout(null);
    setSelectedId("");
    setLocalEditing(false);
    restoreDraftBase();
    if (send) send({ type: "control", action: "exit_edit" });
  }

  function updateSelected(patch: Partial<LayoutItemRow>) {
    if (!selected || !localLayout) return;
    updateDraftLayout((current) =>
      current.map((item) =>
        item.id === selected.id
          ? clampItemToMap({ ...item, ...patch }, mapDims.w, mapDims.h)
          : item
      )
    );
  }

  function addItem(
    nextKind: LayoutKind = kind,
    tile?: { x: number; y: number },
    material: FurnitureMaterial | null = selectedMaterial
  ) {
    if (!world || !localLayout) return;
    const spec = defaultForKind(nextKind);
    const pos = tile ?? {
      x: Math.floor(activeViewBounds.x + activeViewBounds.w / 2),
      y: Math.floor(activeViewBounds.y + activeViewBounds.h / 2),
    };
    const id = crypto.randomUUID();
    const item = clampItemToMap(
      {
        id,
        world_id: world.id,
        kind: nextKind,
        key: `custom.${nextKind}.${material?.id ?? Date.now()}`,
        name: material
          ? `${labelForKind(nextKind)} ${material.label}`
          : labelForKind(nextKind),
        pos_x: pos.x,
        pos_y: pos.y,
        w: spec.w,
        h: spec.h,
        rotation: 0,
        zone: "common",
        walkable: nextKind === "chair",
        affords: spec.affords,
        meta: material ? { sprite: spriteMetaForMaterial(material) } : {},
      },
      mapDims.w,
      mapDims.h
    );
    updateDraftLayout((current) => [...current, item]);
    setSelectedId(id);
  }

  function startMaterialDrag(
    material: FurnitureMaterial,
    event: DragEvent<HTMLButtonElement>
  ) {
    event.dataTransfer.setData(LAYOUT_MATERIAL_MIME, material.id);
    event.dataTransfer.effectAllowed = "copy";
  }

  function materialFromDrag(
    event: DragEvent<HTMLElement>
  ): FurnitureMaterial | null {
    const materialId = event.dataTransfer.getData(LAYOUT_MATERIAL_MIME);
    if (!materialId) return null;
    return materialOptions.find((material) => material.id === materialId) ?? null;
  }

  function dropMaterial(event: DragEvent<HTMLDivElement>) {
    const material = materialFromDrag(event) ?? selectedMaterial;
    if (!editing || !localLayout || !material) return;
    event.preventDefault();
    const tile = pointerToTile(event.clientX, event.clientY);
    if (!tile) return;
    const nextKind = kindForMaterial(material, kind);
    const spec = defaultForKind(nextKind);
    addItem(nextKind, {
      x: clamp(tile.x - Math.floor(spec.w / 2), 0, mapDims.w - spec.w),
      y: clamp(tile.y - Math.floor(spec.h / 2), 0, mapDims.h - spec.h),
    }, material);
  }

  function dropMaterialOnItem(
    itemId: string,
    event: DragEvent<HTMLButtonElement>
  ) {
    const material = materialFromDrag(event);
    if (!editing || !localLayout || !material) return;
    event.preventDefault();
    event.stopPropagation();
    replaceItemMaterial(itemId, material);
  }

  function replaceItemMaterial(itemId: string, material: FurnitureMaterial) {
    updateDraftLayout((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        const nextKind = kindForMaterial(material, item.kind);
        const spec = defaultForKind(nextKind);
        const kindChanged = nextKind !== item.kind;
        return clampItemToMap(
          {
            ...item,
            kind: nextKind,
            name: `${labelForKind(nextKind)} ${material.label}`,
            w: kindChanged ? spec.w : item.w,
            h: kindChanged ? spec.h : item.h,
            walkable: kindChanged ? nextKind === "chair" : item.walkable,
            affords: kindChanged ? spec.affords : item.affords,
            meta: mergeSpriteMeta(item.meta, material),
          },
          mapDims.w,
          mapDims.h
        );
      })
    );
    setKind(kindForMaterial(material, kind));
    setSelectedMaterialId(material.id);
    setSelectedId(itemId);
  }

  function placeSelectedMaterial(event: MouseEvent<HTMLDivElement>) {
    if (!editing || !localLayout || !selectedMaterial) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-layout-item-id]")) return;
    const tile = pointerToTile(event.clientX, event.clientY);
    if (!tile) return;
    const nextKind = kindForMaterial(selectedMaterial, kind);
    const spec = defaultForKind(nextKind);
    addItem(nextKind, {
      x: clamp(tile.x - Math.floor(spec.w / 2), 0, mapDims.w - spec.w),
      y: clamp(tile.y - Math.floor(spec.h / 2), 0, mapDims.h - spec.h),
    }, selectedMaterial);
  }

  function deleteSelected() {
    if (!selected || !localLayout) return;
    updateDraftLayout((current) => current.filter((item) => item.id !== selected.id));
    setSelectedId("");
  }

  function rotateSelected() {
    if (!selected) return;
    updateSelected({ rotation: (selected.rotation + 90) % 360 });
  }

  function pointerToTile(clientX: number, clientY: number) {
    if (!boardRef.current) return null;
    const rect = boardRef.current.getBoundingClientRect();
    return {
      x: clamp(
        Math.floor(
          ((clientX - rect.left) / rect.width) * activeViewBounds.w +
            activeViewBounds.x
        ),
        0,
        mapDims.w - 1
      ),
      y: clamp(
        Math.floor(
          ((clientY - rect.top) / rect.height) * activeViewBounds.h +
            activeViewBounds.y
        ),
        0,
        mapDims.h - 1
      ),
    };
  }

  function beginMove(
    item: LayoutItemRow,
    event: PointerEvent<HTMLButtonElement>
  ) {
    if (!editing || !localLayout) return;
    const tile = pointerToTile(event.clientX, event.clientY);
    if (!tile) return;
    event.preventDefault();
    boardRef.current?.setPointerCapture(event.pointerId);
    const fp = footprintOf(item);
    interactionRef.current = {
      mode: "move",
      itemId: item.id,
      offsetX: tile.x - fp.x,
      offsetY: tile.y - fp.y,
    };
    setSelectedId(item.id);
  }

  function beginResize(
    item: LayoutItemRow,
    event: PointerEvent<HTMLSpanElement>
  ) {
    if (!editing || !localLayout) return;
    event.preventDefault();
    event.stopPropagation();
    boardRef.current?.setPointerCapture(event.pointerId);
    interactionRef.current = { mode: "resize", itemId: item.id };
    setSelectedId(item.id);
  }

  function handleBoardPointerMove(event: PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction || !localLayout) return;
    const tile = pointerToTile(event.clientX, event.clientY);
    if (!tile) return;

    updateDraftLayout((current) =>
      current.map((item) => {
        if (item.id !== interaction.itemId) return item;
        const fp = footprintOf(item);
        if (interaction.mode === "move") {
          return {
            ...item,
            pos_x: clamp(tile.x - interaction.offsetX, 0, mapDims.w - fp.w),
            pos_y: clamp(tile.y - interaction.offsetY, 0, mapDims.h - fp.h),
          };
        }

        const nextFootW = clamp(tile.x - fp.x + 1, 1, mapDims.w - fp.x);
        const nextFootH = clamp(tile.y - fp.y + 1, 1, mapDims.h - fp.y);
        return isQuarterTurn(item.rotation)
          ? { ...item, w: nextFootH, h: nextFootW }
          : { ...item, w: nextFootW, h: nextFootH };
      })
    );
  }

  function endBoardInteraction(event: PointerEvent<HTMLDivElement>) {
    if (!interactionRef.current) return;
    interactionRef.current = null;
    setLockedViewBounds(null);
    if (boardRef.current?.hasPointerCapture(event.pointerId)) {
      boardRef.current.releasePointerCapture(event.pointerId);
    }
  }

  function assignDesk(agentId: string, deskId: string | null) {
    setAssignments((prev) => {
      const withoutSameDesk = deskId
        ? prev.map((row) =>
            row.desk_id === deskId ? { ...row, desk_id: null } : row
          )
        : prev;
      const idx = withoutSameDesk.findIndex((row) => row.agent_id === agentId);
      if (idx === -1) return [...withoutSameDesk, { agent_id: agentId, desk_id: deskId }];
      const next = withoutSameDesk.slice();
      next[idx] = { agent_id: agentId, desk_id: deskId };
      return next;
    });
  }

  async function save() {
    if (!world || !localLayout) return;
    const localValidation = validateLocalLayout(localLayout, mapTmj, mapDims.w, mapDims.h);
    useGameStore.setState({ layoutValidation: localValidation });
    if (!localValidation.ok) {
      setMessage("本地校驗發現錯誤，請先修正下方標紅項目再套用/儲存");
      return;
    }

    if (localOnly) {
      // Mock mode / manually-entered local edit: no engine to PUT to, so
      // this only ever updates the client-side store (desk assignments
      // included — see the note on `assignments` above the JSX section).
      const assignmentByAgent = new Map(
        assignments.map((row) => [row.agent_id, row.desk_id])
      );
      const nextAgents = Object.values(agents).map((agent) => ({
        ...agent,
        desk_id: assignmentByAgent.has(agent.id)
          ? assignmentByAgent.get(agent.id) ?? null
          : agent.desk_id,
      }));
      useGameStore.getState().applyServerMsg({
        type: "layout_updated",
        layout: localLayout,
        agents: nextAgents,
        validation: localValidation,
      });
      commitDraftBase(localLayout, nextAgents);
      setMessage("本地預覽已套用");
      return;
    }

    if (!window.confirm(WORLD_RESET_CONFIRM_MESSAGE)) return;

    setMessage("儲存中…");
    try {
      // ADR-002 D2 real contract: PUT /api/v1/world/layout body
      // {"items":[...]}. There is no way to send desk `assignments` here —
      // the engine resolves each agent's desk/chair from the agent's own
      // (already-persisted) `desk_id`, not from this payload (see
      // world.rs::build_agent_sims), and PATCH /agents/:id doesn't expose
      // `desk_id` either. So live saves persist furniture placement only;
      // the "座位指派" section below stays local-preview-only until a
      // future wave adds a real desk-assignment endpoint.
      const response = await apiJson<WorldSnapshotMsg>("/api/v1/world/layout", {
        method: "PUT",
        body: JSON.stringify({ items: localLayout }),
      });
      useGameStore.getState().applyServerMsg(response);
      commitDraftBase(response.layout, response.agents);
      useGameStore.setState((state) => ({
        layoutValidation: {
          ok: true,
          errors: [],
          warnings: state.layoutValidation?.warnings ?? [],
        },
      }));
      setMessage("佈局已儲存（模擬已重置至 07:00 暫停）");
    } catch (error) {
      setMessage(null);
      const text =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "佈局儲存失敗";
      useGameStore.setState((state) => ({
        layoutValidation: {
          ok: false,
          errors: [text],
          warnings: state.layoutValidation?.warnings ?? [],
        },
      }));
    }
  }

  async function applyWorldSettings() {
    if (!world) return;
    setWorldSettingsError(null);
    let tmj: unknown;
    try {
      tmj = generateOfficeShell({
        width: worldWidthInput,
        height: worldHeightInput,
        theme: worldThemeInput,
      });
    } catch (err) {
      setWorldSettingsError(err instanceof Error ? err.message : "地圖產生失敗");
      return;
    }

    if (mockMode) {
      setWorldSettingsError("MOCK 模式無引擎連線，世界設定僅能在連上引擎後套用");
      return;
    }

    if (!window.confirm(WORLD_RESET_CONFIRM_MESSAGE)) return;

    setWorldSettingsBusy(true);
    setWorldSettingsMessage("套用中…");
    try {
      const response = await apiJson<WorldSnapshotMsg>("/api/v1/world/map", {
        method: "PUT",
        body: JSON.stringify({ tmj }),
      });
      // OfficeCanvas refetches the map itself once it sees world.map_rev
      // move past its cached mapRev (ADR-002 D2) — applying the snapshot
      // here is enough to trigger that, no direct setMap() call needed.
      useGameStore.getState().applyServerMsg(response);
      setWorldSettingsMessage("世界設定已套用（模擬已重置至 07:00 暫停）");
    } catch (err) {
      setWorldSettingsMessage(null);
      setWorldSettingsError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "世界設定套用失敗"
      );
    } finally {
      setWorldSettingsBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold text-slate-100">佈局編輯器</h2>
        {!editing ? (
          <button
            type="button"
            disabled={disabled}
            onClick={enterEdit}
            className="rounded-md bg-cyan-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-40"
          >
            編輯模式
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
            >
              {localOnly ? "套用預覽" : "儲存"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600"
            >
              取消
            </button>
          </>
        )}
      </div>

      <section className="mt-3 rounded-md border border-slate-800 bg-slate-950/60 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">世界設定</h3>
          <span className="text-xs text-slate-500">
            目前 {mapDims.w}x{mapDims.h} ·{" "}
            {themeLabel(activeThemeId, themeOptions)}
          </span>
        </div>
        {mockMode && (
          <p className="mb-2 rounded-md border border-sky-900 bg-sky-950/40 px-2 py-1.5 text-xs text-sky-300">
            MOCK / 無引擎連線：世界設定僅能檢視，套用需先連上引擎。
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-[auto_auto_1fr]">
          <Field label={`寬 (${WORLD_MIN_SIZE}-${WORLD_MAX_SIZE})`}>
            <NumberInput
              disabled={disabled || mockMode || worldSettingsBusy}
              value={worldWidthInput}
              min={WORLD_MIN_SIZE}
              max={WORLD_MAX_SIZE}
              onChange={(value) =>
                setWorldWidthInput(clamp(Math.round(value), WORLD_MIN_SIZE, WORLD_MAX_SIZE))
              }
            />
          </Field>
          <Field label={`高 (${WORLD_MIN_SIZE}-${WORLD_MAX_SIZE})`}>
            <NumberInput
              disabled={disabled || mockMode || worldSettingsBusy}
              value={worldHeightInput}
              min={WORLD_MIN_SIZE}
              max={WORLD_MAX_SIZE}
              onChange={(value) =>
                setWorldHeightInput(clamp(Math.round(value), WORLD_MIN_SIZE, WORLD_MAX_SIZE))
              }
            />
          </Field>
          <div>
            <span className="mb-1 block text-xs text-slate-400">背景主題</span>
            <div className="flex flex-wrap gap-1.5">
              {(themeOptions.length > 0
                ? themeOptions
                : THEME_IDS.map((id) => ({
                    id,
                    label: FALLBACK_THEME_LABELS[id] ?? id,
                    file: "",
                  }))
              ).map((theme) => {
                const isTarget = worldThemeInput === theme.id;
                const isActive = activeThemeId === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    disabled={disabled || mockMode || worldSettingsBusy}
                    onClick={() => setWorldThemeInput(theme.id)}
                    title={theme.label}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-40 ${
                      isTarget
                        ? "border-cyan-300 text-cyan-100"
                        : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    <span
                      className="h-3 w-3 rounded-sm border border-black/30"
                      style={themeSwatchStyle(theme.id)}
                    />
                    {theme.label}
                    {isActive && <span className="text-slate-500">(使用中)</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={disabled || mockMode || worldSettingsBusy}
            onClick={applyWorldSettings}
            className="rounded-md bg-cyan-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-40"
          >
            套用世界設定
          </button>
          {worldSettingsMessage && (
            <span className="text-xs text-slate-400">{worldSettingsMessage}</span>
          )}
        </div>
        {worldSettingsError && (
          <p className="mt-2 whitespace-pre-wrap rounded-md border border-rose-900 bg-rose-950/40 px-2 py-1.5 text-xs text-rose-300">
            {worldSettingsError}
          </p>
        )}
      </section>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.2fr_1fr]">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>素材庫</span>
            <span>{materialOptions.length} 張</span>
          </div>
          {manifestStatus === "missing" && (
            <div className="rounded-md border border-sky-900 bg-sky-950/40 px-2 py-1.5 text-[11px] leading-snug text-sky-300">
              偵測不到 LimeZu 素材包——把素材放到
              assets/tilesets/limezu-modern-office/（參考同目錄
              manifest.example.json），執行 node
              scripts/sync_limezu_assets.mjs 後重新整理。目前顯示為產生的色塊佔位圖。
            </div>
          )}
          <div className="grid max-h-80 grid-cols-3 gap-2 overflow-auto pr-1">
            {materialOptions.map((material) => {
              const materialKind = kindForMaterial(material, kind);
              const pressed = selectedMaterial?.id === material.id;
              return (
              <button
                key={material.id}
                type="button"
                disabled={!editing}
                draggable={editing}
                onClick={() => {
                  setKind(materialKind);
                  setSelectedMaterialId(material.id);
                }}
                onDoubleClick={() => addItem(materialKind, undefined, material)}
                onDragStart={(event) => startMaterialDrag(material, event)}
                aria-pressed={pressed}
                className={`min-h-20 rounded-md border bg-slate-950 p-2 text-left text-xs disabled:opacity-45 ${
                  pressed
                    ? "border-cyan-300 text-cyan-100"
                    : "border-slate-700 text-slate-300 hover:border-slate-500"
                }`}
              >
                <span className="mb-1 block h-12 rounded border border-slate-800 bg-slate-900 p-1">
                  <MaterialPreview
                    kind={materialKind}
                    sprite={material}
                  />
                </span>
                <span className="block truncate">{material.label}</span>
                <span className="block truncate text-[10px] text-slate-500">
                  {labelForKind(materialKind)}
                </span>
              </button>
            );
            })}
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              value={kind}
              disabled={!editing}
              onChange={(event) => {
                setKind(event.target.value as LayoutKind);
                setSelectedMaterialId("");
              }}
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {labelForKind(value)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!editing}
              onClick={() => {
                if (selectedMaterial) {
                  addItem(kindForMaterial(selectedMaterial, kind), undefined, selectedMaterial);
                } else {
                  addItem();
                }
              }}
              className="rounded-md bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              新增
            </button>
          </div>
          <button
            type="button"
            disabled={!editing || !selected || !selectedMaterial}
            onClick={() => {
              if (selected && selectedMaterial) replaceItemMaterial(selected.id, selectedMaterial);
            }}
            className="w-full rounded-md bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            套用素材到選取
          </button>
          <select
            value={selected?.id ?? ""}
            disabled={!editing}
            onChange={(event) => setSelectedId(event.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
          >
            {rows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.key}
              </option>
            ))}
          </select>
          <div className="max-h-52 overflow-auto rounded-md border border-slate-800">
            {rows.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={!editing}
                onClick={() => setSelectedId(item.id)}
                className={`block w-full px-2 py-1 text-left text-xs ${
                  item.id === selected?.id
                    ? "bg-cyan-950 text-cyan-200"
                    : "text-slate-400 hover:bg-slate-800"
                }`}
              >
                {item.key} · {item.pos_x},{item.pos_y}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="col-span-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-400">
                {activeViewBounds.w}x{activeViewBounds.h} @ {activeViewBounds.x},{activeViewBounds.y}
              </div>
              <div className="flex rounded-md border border-slate-700 bg-slate-950 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setAutoView(true)}
                  className={`rounded px-2 py-1 ${
                    autoView ? "bg-cyan-800 text-cyan-100" : "text-slate-400"
                  }`}
                >
                  自動
                </button>
                <button
                  type="button"
                  onClick={() => setAutoView(false)}
                  className={`rounded px-2 py-1 ${
                    !autoView ? "bg-cyan-800 text-cyan-100" : "text-slate-400"
                  }`}
                >
                  全圖
                </button>
              </div>
            </div>
            <div
              ref={boardRef}
              onDragOver={(event) => {
                if (editing) event.preventDefault();
              }}
              onDrop={dropMaterial}
              onClick={placeSelectedMaterial}
              onPointerMove={handleBoardPointerMove}
              onPointerUp={endBoardInteraction}
              onPointerCancel={endBoardInteraction}
              className="relative touch-none overflow-hidden rounded-md border border-slate-700 bg-slate-950"
              style={{ aspectRatio: `${activeViewBounds.w} / ${activeViewBounds.h}` }}
            >
              <div
                className="absolute inset-0 opacity-40"
                style={{
                  backgroundImage:
                    "linear-gradient(to right, rgba(103,232,249,.22) 1px, transparent 1px), linear-gradient(to bottom, rgba(103,232,249,.22) 1px, transparent 1px)",
                  backgroundSize: `${100 / activeViewBounds.w}% ${100 / activeViewBounds.h}%`,
                }}
              />
              {rows.map((item) => {
                const fp = footprintOf(item);
                const selectedItem = item.id === selected?.id;
                return (
                  <button
                    key={item.id}
                    data-layout-item-id={item.id}
                    type="button"
                    onPointerDown={(event) => beginMove(item, event)}
                    onClick={() => setSelectedId(item.id)}
                    onDragOver={(event) => {
                      if (editing) event.preventDefault();
                    }}
                    onDrop={(event) => dropMaterialOnItem(item.id, event)}
                    aria-label={item.name}
                    className={`absolute overflow-visible rounded-sm border bg-slate-900/20 ${
                      selectedItem
                        ? "border-cyan-200 shadow-[0_0_0_2px_rgba(34,211,238,.28)]"
                        : "border-slate-500/80 hover:border-slate-300"
                    }`}
                    style={{
                      left: `${((fp.x - activeViewBounds.x) / activeViewBounds.w) * 100}%`,
                      top: `${((fp.y - activeViewBounds.y) / activeViewBounds.h) * 100}%`,
                      width: `${(fp.w / activeViewBounds.w) * 100}%`,
                      height: `${(fp.h / activeViewBounds.h) * 100}%`,
                    }}
                    title={`${item.name} (${item.key})`}
                  >
                    <FurnitureFace
                      item={item}
                      selected={selectedItem}
                      sprite={spriteForItem(item, furnitureSprites)}
                    />
                    {selectedItem && editing && (
                      <span
                        role="presentation"
                        onPointerDown={(event) => beginResize(item, event)}
                        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-sm border border-cyan-100 bg-cyan-500 shadow"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <Field label="X">
            <NumberInput
              disabled={!editing || !selected}
              value={selected?.pos_x ?? 0}
              onChange={(value) => updateSelected({ pos_x: value })}
            />
          </Field>
          <Field label="Y">
            <NumberInput
              disabled={!editing || !selected}
              value={selected?.pos_y ?? 0}
              onChange={(value) => updateSelected({ pos_y: value })}
            />
          </Field>
          <Field label="W">
            <NumberInput
              disabled={!editing || !selected}
              value={selected?.w ?? 1}
              onChange={(value) => updateSelected({ w: Math.max(1, value) })}
            />
          </Field>
          <Field label="H">
            <NumberInput
              disabled={!editing || !selected}
              value={selected?.h ?? 1}
              onChange={(value) => updateSelected({ h: Math.max(1, value) })}
            />
          </Field>
          <Field label="Zone">
            <input
              disabled={!editing || !selected}
              value={selected?.zone ?? ""}
              onChange={(event) => updateSelected({ zone: event.target.value })}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
            />
          </Field>
          <Field label="Walkable">
            <input
              type="checkbox"
              disabled={!editing || !selected}
              checked={selected?.walkable ?? false}
              onChange={(event) => updateSelected({ walkable: event.target.checked })}
              className="mt-2 h-4 w-4"
            />
          </Field>
          <button
            type="button"
            disabled={!editing || !selected}
            onClick={rotateSelected}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            旋轉 90
          </button>
          <button
            type="button"
            disabled={!editing || !selected}
            onClick={deleteSelected}
            className="rounded-md bg-rose-800 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            刪除
          </button>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-400">座位指派</div>
          <div className="max-h-64 space-y-1 overflow-auto">
            {agentsList.map((agent) => (
              <div key={agent.id} className="grid grid-cols-[5rem_1fr] items-center gap-2">
                <span className="truncate text-xs text-slate-300">{agent.name}</span>
                <select
                  disabled={!editing}
                  value={
                    assignments.find((row) => row.agent_id === agent.id)?.desk_id ??
                    agent.desk_id ??
                    ""
                  }
                  onChange={(event) =>
                    assignDesk(agent.id, event.target.value || null)
                  }
                  className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                >
                  <option value="">未指派</option>
                  {desks.map((desk) => (
                    <option key={desk.id} value={desk.id}>
                      {desk.key}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(message || validation) && (
        <div className="mt-3 rounded-md border border-slate-800 bg-slate-950 p-2 text-xs text-slate-300">
          {message && <div>{message}</div>}
          {validation?.errors.map((error) => (
            <div key={error} className="text-rose-300">{error}</div>
          ))}
          {validation?.warnings.map((warning) => (
            <div key={warning} className="text-amber-300">{warning}</div>
          ))}
        </div>
      )}
    </section>
  );
}

function NumberInput({
  value,
  disabled,
  onChange,
  min,
  max,
}: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      disabled={disabled}
      value={value}
      min={min}
      max={max}
      onChange={(event) => onChange(Number(event.target.value))}
      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-slate-400">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function MaterialPreview({
  kind,
  sprite,
}: {
  kind: LayoutKind;
  sprite?: FurnitureSpriteManifestEntry;
}) {
  if (sprite?.image) {
    return (
      // Pixel-art furniture thumbnail from a dynamic manifest URL;
      // next/image's optimizer/layout machinery isn't a fit for this small crop.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={sprite.image}
        alt=""
        draggable={false}
        className="h-full w-full"
        style={{
          imageRendering: "pixelated",
          objectFit: sprite.fit === "stretch" ? "fill" : sprite.fit ?? "contain",
        }}
      />
    );
  }

  return (
    <span
      className="relative block h-full w-full overflow-hidden rounded-[3px]"
      style={furnitureStyle(kind)}
    >
      {furnitureDetails(kind)}
    </span>
  );
}

function FurnitureFace({
  item,
  selected,
  sprite,
}: {
  item: LayoutItemRow;
  selected: boolean;
  sprite?: FurnitureSpriteManifestEntry;
}) {
  return (
    <span
      className="pointer-events-none absolute inset-[2px] overflow-hidden rounded-[3px] shadow-inner"
      style={sprite?.image ? undefined : furnitureStyle(item.kind)}
    >
      {sprite?.image ? (
        // Furniture sprite from a dynamic manifest URL; same rationale as
        // MaterialPreview above.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={sprite.image}
          alt=""
          draggable={false}
          className="h-full w-full"
          style={{
            imageRendering: "pixelated",
            objectFit: sprite.fit === "stretch" ? "fill" : sprite.fit ?? "contain",
          }}
        />
      ) : (
        furnitureDetails(item.kind)
      )}
      {selected && (
        <span className="absolute inset-0 rounded-[3px] ring-1 ring-inset ring-white/40" />
      )}
    </span>
  );
}

function kindForMaterial(material: FurnitureMaterial, fallback: LayoutKind): LayoutKind {
  return material.kind && isLayoutKind(material.kind) ? material.kind : fallback;
}

function spriteMetaForMaterial(material: FurnitureMaterial): FurnitureSpriteManifestEntry {
  return {
    id: material.id,
    label: material.label,
    file: material.file,
    image: material.image,
    fit: material.fit ?? "contain",
    scale: material.scale,
    offsetX: material.offsetX,
    offsetY: material.offsetY,
  };
}

function mergeSpriteMeta(meta: unknown, material: FurnitureMaterial) {
  return {
    ...(isPlainRecord(meta) ? meta : {}),
    sprite: spriteMetaForMaterial(material),
  };
}

function spriteForItem(
  item: LayoutItemRow,
  sprites: FurnitureSpriteCatalog | null
): FurnitureSpriteManifestEntry | undefined {
  return readSpriteMeta(item.meta) ?? sprites?.[item.kind];
}

function readSpriteMeta(meta: unknown): FurnitureSpriteManifestEntry | undefined {
  if (!isPlainRecord(meta)) return undefined;
  const sprite = meta.sprite;
  if (!isPlainRecord(sprite) || typeof sprite.image !== "string") return undefined;
  return {
    id: typeof sprite.id === "string" ? sprite.id : undefined,
    label: typeof sprite.label === "string" ? sprite.label : undefined,
    file: typeof sprite.file === "string" ? sprite.file : undefined,
    image: sprite.image,
    fit: isSpriteFit(sprite.fit) ? sprite.fit : "contain",
    scale: typeof sprite.scale === "number" ? sprite.scale : undefined,
    offsetX: typeof sprite.offsetX === "number" ? sprite.offsetX : undefined,
    offsetY: typeof sprite.offsetY === "number" ? sprite.offsetY : undefined,
  };
}

function isSpriteFit(value: unknown): value is FurnitureSpriteManifestEntry["fit"] {
  return value === "contain" || value === "cover" || value === "stretch";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneLayout(rows: LayoutItemRow[]): LayoutItemRow[] {
  return rows.map((item) => ({ ...item, affords: [...item.affords] }));
}

function cloneAgents(rows: Record<string, AgentRow>): Record<string, AgentRow> {
  return Object.fromEntries(
    Object.entries(rows).map(([id, agent]) => [id, { ...agent }])
  );
}

function furnitureStyle(kind: LayoutKind): CSSProperties {
  switch (kind) {
    case "exec_desk":
      return {
        background:
          "linear-gradient(135deg, #4f3425 0%, #7a5538 54%, #3b271d 100%)",
      };
    case "desk":
      return {
        background:
          "linear-gradient(135deg, #76583e 0%, #a77a4e 54%, #5f442f 100%)",
      };
    case "chair":
      return {
        borderRadius: "42% 42% 28% 28%",
        background:
          "linear-gradient(180deg, #d0d6df 0%, #8892a0 52%, #5c6672 100%)",
      };
    case "partition":
      return {
        background:
          "linear-gradient(90deg, #515b6a 0%, #808a99 48%, #3f4652 100%)",
      };
    case "meeting_table":
      return {
        borderRadius: "999px",
        background:
          "linear-gradient(135deg, #6c5138 0%, #a4754b 52%, #513a29 100%)",
      };
    case "cabinet":
      return {
        background:
          "linear-gradient(180deg, #9aa7b6 0%, #657384 48%, #465261 100%)",
      };
    case "printer":
      return {
        background:
          "linear-gradient(180deg, #eef2f5 0%, #9aa4b0 46%, #48515d 100%)",
      };
    case "plant":
      return {
        borderRadius: "999px",
        background:
          "radial-gradient(circle at 46% 38%, #8bd16a 0 22%, #4f9d55 23% 54%, #256a3c 55% 100%)",
      };
    case "pantry_counter":
      return {
        background:
          "linear-gradient(135deg, #836948 0%, #b08c5f 54%, #5f4931 100%)",
      };
    case "whiteboard":
      return {
        background:
          "linear-gradient(180deg, #f8fafc 0%, #d9e2ec 100%)",
      };
  }
}

function furnitureDetails(kind: LayoutKind): ReactNode {
  switch (kind) {
    case "desk":
    case "exec_desk":
      return (
        <>
          <span className="absolute left-[12%] right-[12%] top-[18%] h-[16%] rounded-sm bg-white/10" />
          <span className="absolute bottom-[18%] left-[16%] h-[12%] w-[24%] rounded-sm bg-black/20" />
          <span className="absolute bottom-[18%] right-[16%] h-[12%] w-[24%] rounded-sm bg-black/20" />
        </>
      );
    case "chair":
      return (
        <>
          <span className="absolute left-[20%] right-[20%] top-[16%] h-[18%] rounded-full bg-white/20" />
          <span className="absolute bottom-[16%] left-[24%] right-[24%] h-[16%] rounded-full bg-black/20" />
        </>
      );
    case "partition":
      return (
        <>
          <span className="absolute bottom-0 left-[18%] top-0 w-px bg-white/20" />
          <span className="absolute bottom-0 right-[18%] top-0 w-px bg-black/20" />
        </>
      );
    case "meeting_table":
      return (
        <>
          <span className="absolute left-[10%] right-[10%] top-1/2 h-px bg-white/20" />
          <span className="absolute bottom-[20%] left-[16%] right-[16%] h-[10%] rounded-full bg-black/20" />
        </>
      );
    case "cabinet":
      return (
        <>
          <span className="absolute left-[12%] right-[12%] top-[32%] h-px bg-white/25" />
          <span className="absolute left-[12%] right-[12%] top-[58%] h-px bg-black/25" />
        </>
      );
    case "printer":
      return (
        <>
          <span className="absolute left-[22%] right-[22%] top-[12%] h-[28%] rounded-sm bg-white/80" />
          <span className="absolute bottom-[22%] left-[18%] right-[18%] h-[16%] rounded-sm bg-black/30" />
        </>
      );
    case "plant":
      return (
        <span className="absolute bottom-[8%] left-[33%] h-[24%] w-[34%] rounded-b-md bg-[#7a4f32]" />
      );
    case "pantry_counter":
      return (
        <>
          <span className="absolute left-[12%] top-[18%] h-[42%] w-[30%] rounded-full border border-white/30 bg-black/20" />
          <span className="absolute bottom-[18%] left-[52%] right-[12%] h-[12%] rounded-sm bg-black/20" />
        </>
      );
    case "whiteboard":
      return (
        <>
          <span className="absolute inset-[12%] rounded-sm border border-slate-400/50" />
          <span className="absolute bottom-[12%] left-[16%] right-[16%] h-[8%] rounded-full bg-slate-500/60" />
        </>
      );
  }
}

// ADR-002 D6: every helper below takes the *current* map's width/height
// explicitly (instead of closing over a hardcoded 48x32) so a resized room
// (via the "世界設定" panel) immediately reflows placement/clamping.
function autoBoundsForRows(rows: LayoutItemRow[], mapW: number, mapH: number): ViewBounds {
  if (rows.length === 0) return { x: 0, y: 0, w: mapW, h: mapH };

  let minX = mapW;
  let minY = mapH;
  let maxX = 0;
  let maxY = 0;

  for (const item of rows) {
    const fp = footprintOf(item);
    minX = Math.min(minX, fp.x);
    minY = Math.min(minY, fp.y);
    maxX = Math.max(maxX, fp.x + fp.w);
    maxY = Math.max(maxY, fp.y + fp.h);
  }

  const x = clamp(minX - VIEW_PADDING, 0, mapW - 1);
  const y = clamp(minY - VIEW_PADDING, 0, mapH - 1);
  const right = clamp(maxX + VIEW_PADDING, x + 1, mapW);
  const bottom = clamp(maxY + VIEW_PADDING, y + 1, mapH);
  return expandBounds({ x, y, w: right - x, h: bottom - y }, mapW, mapH);
}

function expandBounds(bounds: ViewBounds, mapW: number, mapH: number): ViewBounds {
  const w = Math.min(mapW, Math.max(MIN_VIEW_W, bounds.w));
  const h = Math.min(mapH, Math.max(MIN_VIEW_H, bounds.h));
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return {
    x: clamp(Math.floor(cx - w / 2), 0, mapW - w),
    y: clamp(Math.floor(cy - h / 2), 0, mapH - h),
    w,
    h,
  };
}

function clampItemToMap(item: LayoutItemRow, mapW: number, mapH: number): LayoutItemRow {
  const rotated = isQuarterTurn(item.rotation);
  const w = clamp(safeGridInt(item.w, 1), 1, rotated ? mapH : mapW);
  const h = clamp(safeGridInt(item.h, 1), 1, rotated ? mapW : mapH);
  const normalized = { ...item, w, h };
  const fp = footprintOf(normalized);
  return {
    ...normalized,
    pos_x: clamp(safeGridInt(normalized.pos_x, 0), 0, mapW - fp.w),
    pos_y: clamp(safeGridInt(normalized.pos_y, 0), 0, mapH - fp.h),
  };
}

function safeGridInt(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function isQuarterTurn(rotation: number) {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 90 || normalized === 270;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isLayoutKind(value: string): value is LayoutKind {
  return (KINDS as readonly string[]).includes(value);
}

function defaultForKind(kind: LayoutKind): { w: number; h: number; affords: string[] } {
  switch (kind) {
    case "exec_desk":
      return { w: 2, h: 2, affords: ["work"] };
    case "meeting_table":
      return { w: 3, h: 2, affords: ["meeting", "discuss"] };
    case "pantry_counter":
      return { w: 2, h: 1, affords: ["coffee"] };
    case "printer":
      return { w: 1, h: 1, affords: ["print"] };
    case "cabinet":
      return { w: 1, h: 1, affords: ["work"] };
    case "chair":
      return { w: 1, h: 1, affords: [] };
    case "partition":
      return { w: 1, h: 2, affords: [] };
    default:
      return { w: 1, h: 1, affords: kind === "desk" ? ["work"] : [] };
  }
}

function labelForKind(kind: LayoutKind): string {
  return KIND_LABELS[kind];
}

function themeLabel(id: string, options: ThemeOption[]): string {
  return options.find((theme) => theme.id === id)?.label ?? FALLBACK_THEME_LABELS[id] ?? id;
}

/** Small color-swatch preview for the theme picker — a flat CSS gradient
 * per theme id rather than loading the actual tileset PNG, so the
 * selector works even before any texture has been fetched. */
function themeSwatchStyle(id: string): CSSProperties {
  switch (id) {
    case "warm":
      return { background: "linear-gradient(135deg, #c98a4b, #6b3f22)" };
    case "cool":
      return { background: "linear-gradient(135deg, #5f8fae, #294a63)" };
    case "dark":
      return { background: "linear-gradient(135deg, #4a4f5a, #1c1f26)" };
    default:
      return { background: "linear-gradient(135deg, #b7c4d1, #6c7a89)" };
  }
}

/** Reads {width, height} off the store's cached TMJ (ADR-002 D6), falling
 * back to the legacy 48x32 shell when nothing has loaded yet. */
function mapDimsFromTmj(tmj: unknown): { w: number; h: number } {
  if (!isPlainRecord(tmj)) return { w: FALLBACK_MAP_W, h: FALLBACK_MAP_H };
  const w = tmj.width;
  const h = tmj.height;
  return {
    w: typeof w === "number" && Number.isFinite(w) ? w : FALLBACK_MAP_W,
    h: typeof h === "number" && Number.isFinite(h) ? h : FALLBACK_MAP_H,
  };
}

/** Reverse-lookup: which THEME_IDS entry produced the loaded TMJ's tileset
 * image filename (office_shell_core.tilesetImageForTheme is the forward
 * direction). Defaults to "default" for a not-yet-loaded / unrecognized
 * map so the theme selector always highlights something. */
function themeIdFromTmj(tmj: unknown): string {
  if (!isPlainRecord(tmj)) return "default";
  const tilesets = tmj.tilesets;
  if (!Array.isArray(tilesets) || !isPlainRecord(tilesets[0])) return "default";
  const image = tilesets[0].image;
  if (typeof image !== "string") return "default";
  const filename = image.split("/").pop() ?? "";
  for (const id of THEME_IDS) {
    if (tilesetImageForTheme(id) === filename) return id;
  }
  return "default";
}

/** Blocked-tile lookup built straight from the loaded TMJ's "walls" layer
 * (nonzero gid = wall/window, same rule engine/crates/sim-core's
 * `TileMap::is_blocked` and office_shell_core's wall ring use) — this is
 * what lets `validateLocalLayout` catch a wall-overlap 422 *before* the
 * round trip, for any map shape, not just the generated ring. Returns
 * `null` when the TMJ hasn't loaded yet (bounds-only validation still
 * applies in that case). */
function blockedTileLookup(
  tmj: unknown
): { width: number; height: number; blocked: (x: number, y: number) => boolean } | null {
  if (!isPlainRecord(tmj)) return null;
  const width = tmj.width;
  const height = tmj.height;
  const layers = tmj.layers;
  if (typeof width !== "number" || typeof height !== "number" || !Array.isArray(layers)) {
    return null;
  }
  const wallLayer = layers.find(
    (layer) => isPlainRecord(layer) && layer.name === "walls" && Array.isArray(layer.data)
  );
  const data =
    wallLayer && isPlainRecord(wallLayer) && Array.isArray(wallLayer.data)
      ? (wallLayer.data as unknown[])
      : null;
  return {
    width,
    height,
    blocked: (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return true;
      if (!data) return false;
      const v = data[y * width + x];
      return typeof v === "number" && v !== 0;
    },
  };
}

/** Front-end local validation (ADR-002 D6: "layoutValidation 由前端本地校驗
 * 產生"), mirroring the engine's real rejection rules closely enough to
 * catch the common mistakes before the round trip:
 *  - errors: footprint outside the map, or overlapping a wall/window tile
 *    (both are hard `PUT /world/layout` 422 causes — see
 *    engine/crates/sim-core/src/grid.rs::validate_layout_within_map).
 *  - warnings: two non-walkable items overlapping each other, or a desk
 *    with no matching "<key>-chair" (mirrors world.rs::build_agent_sims'
 *    desk->chair resolution — not fatal here since it only breaks seating
 *    for whichever agent is assigned to that desk, not the save itself).
 * The engine remains the source of truth: a 422 it returns anyway is
 * surfaced verbatim (see `save()`), this is purely a fail-fast UX layer. */
function validateLocalLayout(
  items: LayoutItemRow[],
  mapTmj: unknown,
  mapW: number,
  mapH: number
): LayoutValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tiles = blockedTileLookup(mapTmj);

  for (const item of items) {
    const fp = footprintOf(item);
    if (fp.x < 0 || fp.y < 0 || fp.x + fp.w > mapW || fp.y + fp.h > mapH) {
      errors.push(`「${item.name}」(${item.key}) 超出地圖範圍 ${mapW}x${mapH}`);
      continue;
    }
    if (!tiles) continue;
    let hitWall = false;
    for (let y = fp.y; y < fp.y + fp.h && !hitWall; y++) {
      for (let x = fp.x; x < fp.x + fp.w; x++) {
        if (tiles.blocked(x, y)) {
          errors.push(`「${item.name}」(${item.key}) 疊到牆／窗格 (${x},${y})`);
          hitWall = true;
          break;
        }
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.walkable || b.walkable) continue;
      const fa = footprintOf(a);
      const fb = footprintOf(b);
      const overlap =
        fa.x < fb.x + fb.w && fa.x + fa.w > fb.x && fa.y < fb.y + fb.h && fa.y + fa.h > fb.y;
      if (overlap) warnings.push(`「${a.name}」與「${b.name}」位置重疊`);
    }
  }

  const chairKeys = new Set(items.filter((item) => item.kind === "chair").map((item) => item.key));
  for (const desk of items.filter((item) => item.kind === "desk" || item.kind === "exec_desk")) {
    if (!chairKeys.has(`${desk.key}-chair`)) {
      warnings.push(
        `「${desk.name}」(${desk.key}) 沒有對應椅子 '${desk.key}-chair'，指派到此桌的角色可能無法入座`
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

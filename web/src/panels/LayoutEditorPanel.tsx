"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { apiJson } from "@/api/client";
import { useGameStore } from "@/game/store";
import {
  footprintOf,
  type AgentRow,
  type LayoutItemRow,
  type LayoutValidation,
  type WorldMeta,
} from "@/game/types";

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

const MAP_W = 48;
const MAP_H = 32;
const VIEW_PADDING = 2;
const MIN_VIEW_W = 12;
const MIN_VIEW_H = 8;
const LAYOUT_MATERIAL_MIME = "application/x-annex-b-layout-material";
const FURNITURE_MANIFEST_URL = "/tilesets/limezu-modern-office/manifest.json";

const FULL_BOUNDS = { x: 0, y: 0, w: MAP_W, h: MAP_H };

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

interface LayoutResponse {
  layout: LayoutItemRow[];
  agents: AgentRow[];
  validation: LayoutValidation;
}

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

  const [localLayout, setLocalLayout] = useState<LayoutItemRow[] | null>(null);
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
  const boardRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<BoardInteraction | null>(null);
  const draftBaseLayoutRef = useRef<LayoutItemRow[] | null>(null);
  const draftBaseAgentsRef = useRef<Record<string, AgentRow> | null>(null);
  const draftBaseWorldStatusRef = useRef<WorldMeta["status"] | null>(null);
  const draftBaseRunningRef = useRef<boolean | null>(null);

  const editing = world?.status === "editing" || localEditing;
  const localOnly = localEditing || send === null;
  const rows = localLayout ?? layout;
  const agentsList = useMemo(
    () => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    [agents]
  );
  const desks = rows.filter((item) => item.kind === "desk" || item.kind === "exec_desk");
  const selected = rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;
  const viewBounds = useMemo(
    () => (autoView ? autoBoundsForRows(rows) : FULL_BOUNDS),
    [autoView, rows]
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
      .then((response) => (response.ok ? response.json() : null))
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
      })
      .catch(() => {
        if (!cancelled) {
          setFurnitureSprites(null);
          setFurnitureMaterials([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        item.id === selected.id ? clampItemToMap({ ...item, ...patch }) : item
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
    const item = clampItemToMap({
      id,
      world_id: world.id,
      kind: nextKind,
      key: `custom.${nextKind}.${material?.id ?? Date.now()}`,
      name: material ? `${labelForKind(nextKind)} ${material.label}` : labelForKind(nextKind),
      pos_x: pos.x,
      pos_y: pos.y,
      w: spec.w,
      h: spec.h,
      rotation: 0,
      zone: "common",
      walkable: nextKind === "chair",
      affords: spec.affords,
      meta: material ? { sprite: spriteMetaForMaterial(material) } : {},
    });
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
      x: clamp(tile.x - Math.floor(spec.w / 2), 0, MAP_W - spec.w),
      y: clamp(tile.y - Math.floor(spec.h / 2), 0, MAP_H - spec.h),
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
        return clampItemToMap({
          ...item,
          kind: nextKind,
          name: `${labelForKind(nextKind)} ${material.label}`,
          w: kindChanged ? spec.w : item.w,
          h: kindChanged ? spec.h : item.h,
          walkable: kindChanged ? nextKind === "chair" : item.walkable,
          affords: kindChanged ? spec.affords : item.affords,
          meta: mergeSpriteMeta(item.meta, material),
        });
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
      x: clamp(tile.x - Math.floor(spec.w / 2), 0, MAP_W - spec.w),
      y: clamp(tile.y - Math.floor(spec.h / 2), 0, MAP_H - spec.h),
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
        MAP_W - 1
      ),
      y: clamp(
        Math.floor(
          ((clientY - rect.top) / rect.height) * activeViewBounds.h +
            activeViewBounds.y
        ),
        0,
        MAP_H - 1
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
            pos_x: clamp(tile.x - interaction.offsetX, 0, MAP_W - fp.w),
            pos_y: clamp(tile.y - interaction.offsetY, 0, MAP_H - fp.h),
          };
        }

        const nextFootW = clamp(tile.x - fp.x + 1, 1, MAP_W - fp.x);
        const nextFootH = clamp(tile.y - fp.y + 1, 1, MAP_H - fp.y);
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
    if (localOnly) {
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
        validation: { ok: true, errors: [], warnings: [] },
      });
      commitDraftBase(localLayout, nextAgents);
      setMessage("本地預覽已套用");
      return;
    }

    setMessage("儲存中…");
    try {
      const response = await apiJson<LayoutResponse>(
        `/api/v1/worlds/${world.id}/layout`,
        {
          method: "PUT",
          body: JSON.stringify({ layout: localLayout, assignments }),
        }
      );
      useGameStore.getState().applyServerMsg({
        type: "layout_updated",
        layout: response.layout,
        agents: response.agents,
        validation: response.validation,
      });
      commitDraftBase(response.layout, response.agents);
      setMessage("佈局已儲存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "佈局儲存失敗");
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

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.2fr_1fr]">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>素材庫</span>
            <span>{materialOptions.length} 張</span>
          </div>
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
}: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      disabled={disabled}
      value={value}
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

function autoBoundsForRows(rows: LayoutItemRow[]): ViewBounds {
  if (rows.length === 0) return FULL_BOUNDS;

  let minX = MAP_W;
  let minY = MAP_H;
  let maxX = 0;
  let maxY = 0;

  for (const item of rows) {
    const fp = footprintOf(item);
    minX = Math.min(minX, fp.x);
    minY = Math.min(minY, fp.y);
    maxX = Math.max(maxX, fp.x + fp.w);
    maxY = Math.max(maxY, fp.y + fp.h);
  }

  const x = clamp(minX - VIEW_PADDING, 0, MAP_W - 1);
  const y = clamp(minY - VIEW_PADDING, 0, MAP_H - 1);
  const right = clamp(maxX + VIEW_PADDING, x + 1, MAP_W);
  const bottom = clamp(maxY + VIEW_PADDING, y + 1, MAP_H);
  return expandBounds({ x, y, w: right - x, h: bottom - y });
}

function expandBounds(bounds: ViewBounds): ViewBounds {
  const w = Math.min(MAP_W, Math.max(MIN_VIEW_W, bounds.w));
  const h = Math.min(MAP_H, Math.max(MIN_VIEW_H, bounds.h));
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return {
    x: clamp(Math.floor(cx - w / 2), 0, MAP_W - w),
    y: clamp(Math.floor(cy - h / 2), 0, MAP_H - h),
    w,
    h,
  };
}

function clampItemToMap(item: LayoutItemRow): LayoutItemRow {
  const rotated = isQuarterTurn(item.rotation);
  const w = clamp(safeGridInt(item.w, 1), 1, rotated ? MAP_H : MAP_W);
  const h = clamp(safeGridInt(item.h, 1), 1, rotated ? MAP_W : MAP_H);
  const normalized = { ...item, w, h };
  const fp = footprintOf(normalized);
  return {
    ...normalized,
    pos_x: clamp(safeGridInt(normalized.pos_x, 0), 0, MAP_W - fp.w),
    pos_y: clamp(safeGridInt(normalized.pos_y, 0), 0, MAP_H - fp.h),
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
